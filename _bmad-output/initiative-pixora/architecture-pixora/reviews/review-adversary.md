# Adversarial Review — Architecture Spine Pixora

- **Target:** `architecture-pixora.md` (status: draft, 2026-11-16)
- **Lens:** build two units one level down that each obey every AD to the letter, yet still produce incompatible behavior: clashing data shapes, two owners, conflicting mutation paths, races, lost or duplicated work, ambiguous retry semantics, stuck generations.
- **Reviewer stance:** adversary. I did not edit the spine.

## Verdict

The paradigm is sound: Postgres as the single source of truth, one job per transition, guarded conditional UPDATEs. But the spine leaves the **retry and exhaustion model** and **pg-boss job lifecycle** unspecified. As written, compliant implementations can retry forever, run duplicate concurrent handlers that double-charge outside the accepted AD-4 window, fork the poll loop, and leave generations stuck in `accepted`, `submitted`, or `completed` with nothing ever reaching the user. Close findings F1–F5 before implementation starts.

## Severity summary

| # | Finding | Severity |
| --- | --- | --- |
| F1 | "Retry via startAfter re-enqueue" never reaches pg-boss dead letter, so generations retry forever and there is no attempt budget | critical |
| F2 | Concurrent duplicate submit jobs (pg-boss expiry vs 600 s HTTP timeout, SIGTERM kill, duplicate enqueue) cause a double charge that AD-4's read-check does not prevent | critical |
| F3 | The poll self-loop is not a transition, so AD-2's guard does not dedupe it and poll chains fork and multiply | high |
| F4 | Dead-letter handler is unowned and ambiguous: unknown `from` state, no deliver-exhaustion path, nothing enqueues deliver | high |
| F5 | Non-Polza errors (Telegram, CDN download, DB, bugs) are unclassified; the state machine has no `completed → failed` edge, so generations get stuck | high |
| F6 | No single transition+enqueue primitive, so AD-1/AD-3's "same transaction" is unenforceable and the ingress can enqueue on conflict | medium |
| F7 | Queue creation and options (retryLimit, backoff, expireIn, deadLetter, policy) have no owner, so bot and worker can create the same queue differently | medium |
| F8 | Schema is under-specified: ER diagram lacks timestamps, constraints and status/reason enums | medium |
| F9 | Poll deadline vs retry budget vs late Polza completion is ambiguous, and so is the meaning of 404 on GET | medium |
| F10 | AD-8 "exactly one instance" and the "accepted after commit" ordering are not enforced | low |

---

## F1 — Re-enqueue retries are invisible to pg-boss retry and DLQ, so there is no attempt budget (critical)

**Units in conflict:** the `generation.submit` handler (author A) and the dead-letter handler (author B), both obeying AD-6.

- AD-6: "`retry(after)` реализуется постановкой задачи с `startAfter`, а не брошенным исключением." The table says *every* retry (`retry` with exponential pause, and `retry(after)`) is a retry, and the text forbids throwing only for `retry(after)`. Author A reads this as "all retries are re-enqueues" (uniform, the pause is computed by us). Author C reads it as "only Retry-After retries are re-enqueued; exponential retries throw and use pg-boss `retryBackoff`".
- A re-enqueued job is a **new job** with `retryCount = 0`. pg-boss never exhausts it, so it never reaches the dead letter queue. Author B's DLQ handler (`→ failed / provider_unavailable`) never fires for the re-enqueue path.
- Result under author A: Polza down for hours, or a 429 provider limit with `Retry-After`, means submit retries **forever**. The generation sits in `accepted` indefinitely. The user gets "принято" and then silence. That violates the intent of AD-7 ("no silent failures").
- `accepted` has **no deadline at all**. `POLL_DEADLINE` applies only from submit onward.
- The logging convention requires `attempt` on every line, but nothing defines it. pg-boss `retryCount` resets on every re-enqueue. Two authors log incomparable numbers.
- Exponential backoff needs a counter to grow. Under the re-enqueue model the payload is restricted to `{ generationId }` (AD-3), so the counter can only live in the DB. There is no column for it, so author A either keeps a constant pause or violates AD-3.

**Fix (new AD-12 "Retry budget"):**
> All retries of a step are counted in `generations.attempts` (per current step; reset on transition), incremented in the same conditional UPDATE that re-enqueues the job with `startAfter`. Handlers never throw for classified errors; thrown exceptions are reserved for unclassified bugs and go through pg-boss retry (retryLimit N) → DLQ. A step is exhausted when `attempts >= MAX_ATTEMPTS[step]` **or** `now() - step_started_at > STEP_DEADLINE[step]` (submit: `SUBMIT_DEADLINE`, poll: `POLL_DEADLINE`, deliver: `DELIVER_DEADLINE`). Exhaustion = transition to `failed` (`provider_unavailable` for submit/poll, see F5 for deliver), checked by the handler itself, not only by DLQ. Backoff = `min(base * 2^attempts, cap)`, or `Retry-After` if given (capped). Log field `attempt` = `generations.attempts`.

Alternatively: make *all* classified retries throw and rely on pg-boss `retryLimit/retryDelay/retryBackoff`. pg-boss cannot honor a per-attempt `Retry-After`, though, so the spine must pick one model explicitly. Today it implicitly mixes both.

## F2 — Duplicate concurrent submit means a double charge that AD-4 does not prevent (critical)

AD-4 guards with a **read** ("проверяет, что `accepted` и `polza_generation_id` пуст") before a call that can block up to more than 600 s (AD-6: HTTP timeout > 600 s server limit). The accepted risk window is described as "process crashed between Polza accepting and saving the id". In fact, compliant units open far wider windows:

1. **pg-boss expiration.** The spine does not set `expireInSeconds` for the queue. If the author leaves the default (15 min in pg-boss), or sets it lower than the HTTP timeout, a slow submit expires. pg-boss then retries it **while the first handler is still running**. Both pass the read-check, both POST, and the generation is charged twice. The second handler's `UPDATE … WHERE status='accepted'` affects 0 rows. Per AD-2 that means "переход уже выполнен — завершить успешно, ничего не делая". So the second Polza id is **silently discarded**: charged and untraceable.
2. **Deploy/SIGTERM.** The convention says "worker дожидается активных". Docker's default stop grace period is 10 s, and the spine sets no `stop_grace_period`. A submit blocked on Polza is SIGKILLed on **every deploy**. The job then returns after expiry or a restart and resubmits. The "rare crash" window becomes a routine deploy window.
3. **Duplicate enqueue at ingress.** AD-9 says a conflict on `(chat_id, message_id)` "не ошибка". Author X implements `INSERT … ON CONFLICT DO NOTHING` and then calls `boss.send(submit)` unconditionally (AD-1 says creation and enqueue share a transaction, which is still true). That gives two submit jobs and two concurrent handlers, so the read-check race from item 1 applies.
4. **Worker concurrency.** `teamSize`/`batchSize` > 1 with any duplicate job puts two handlers in the same process.

**Fix (tighten AD-4, add to AD-3):**
> Submit and poll queues are created with policy `singleton` (or equivalent) and every job is sent with `singletonKey = generationId`, so at most one active job per generation per queue. `expireInSeconds(submit) > POLZA_HTTP_TIMEOUT + 60 s`; `stop_grace_period(worker) ≥ expireInSeconds(submit)` (or: submit HTTP timeout is reduced to a value the deploy grace period covers). If the conditional UPDATE after a successful Polza POST affects 0 rows, the handler logs `orphan_polza_id` at `error` with the id (never silent). Ingress enqueues submit **only if the INSERT inserted a row** (`RETURNING id` non-empty).

Optionally record `submit_started_at` before the POST, so orphan windows are detectable in logs and History API reconciliation (Deferred) has a key.

## F3 — The poll self-loop is not a transition, so the AD-2 guard does not dedupe it (high)

- AD-2's dedupe relies on `WHERE status = $expected` affecting 0 rows on replay. Poll's "pending" outcome is `submitted → submitted`. A conditional `UPDATE … SET status='submitted' WHERE status='submitted'` **always** affects 1 row, and many authors will issue no UPDATE at all since nothing changes.
- pg-boss marks a job completed **after** the handler returns, in its own statement, **not** in the handler's transaction. Suppose poll commits "enqueue next poll" and the process dies before pg-boss completes the job. The job is retried, or expires and is retried. It enqueues *another* next poll. Now two poll chains run, and each can fork again. Polza GET load grows, and so does the 429 risk (which feeds F1).
- AD-3 says "ставит следующую задачу в той же транзакции, что и переход". With no transition there is nothing to share a transaction with. Author P enqueues via plain `boss.send()` outside any transaction. That is still compliant.
- Both chains eventually race to `submitted → completed`. Only one wins, and the guard makes deliver single. So the outcome is safe but wasteful. Combined with F1 (no budget) it is unbounded.

**Fix (tighten AD-5/AD-3):**
> Poll jobs use `singletonKey = generationId` on a singleton-policy queue (as in F2). Every poll re-enqueue increments `generations.poll_count` (or `attempts`) via `UPDATE … WHERE id=$1 AND status='submitted' AND poll_count=$seen` in the same transaction as the send; 0 rows ⇒ another chain advanced ⇒ exit without enqueueing.

## F4 — The dead-letter handler has no owner and no `from` state, and deliver exhaustion has no path (high)

Two authors implement "исчерпание повторов → failed/provider_unavailable" (AD-6):

- **Which DLQ?** pg-boss (v10+) needs `deadLetter` configured per queue at `createQueue`. Is it one shared DLQ for all three queues or one per queue? The payload is `{ generationId }` only (AD-3), so a shared DLQ cannot tell which step died.
- **Which expected status?** AD-2 mandates `WHERE status = $expected`. Author B writes `WHERE status = 'accepted'` (thinking of submit). Author B' writes `WHERE status IN ('accepted','submitted')`. Neither can be "the" rule, since AD-2 says one expected status.
- **Deliver exhaustion.** A deliver job dies in DLQ while the generation is in `completed` or `failed`. "→ failed/provider_unavailable" is invalid from `completed` (no such edge), and from `failed` it is a no-op. Result: the user **never receives anything** and the generation stays `completed`/`failed` with `delivered_at IS NULL` forever.
- **Who enqueues deliver after DLQ→failed?** AD-7: "каждая генерация в failed обязательно получает задачу deliver". Nothing says the DLQ handler must do it in the same transaction. Author B transitions without enqueueing, and the user gets silence.
- `internal` is in the reason list but no rule assigns it to anything.

**Fix (new AD-13 "Exhaustion handling"):**
> Each queue has its own DLQ `generation.<step>.dead`, handled by `apps/worker` via a single domain call `failGeneration(id, fromStep, reason)` which transitions from the step's expected status (`submit→accepted`, `poll→submitted`) to `failed` and enqueues deliver in the same transaction. Reason: `provider_unavailable` if the last error was a classified Polza retry, else `internal`. `generation.deliver.dead` does not transition; it logs `delivery_lost` at `error` and sets `delivery_failed_at` (terminal, visible). The handler also re-checks status so DLQ arrival after a later successful transition is a no-op.

## F5 — Non-Polza errors are unclassified, and there is no `completed → failed` edge (high)

AD-6's classifier covers **only Polza responses**. Compliant units still hit these unclassified failures:

- **CDN download in deliver** (AD-11): 404/403 or expired URL, connection reset. Not covered by the classifier. Author D throws, so the job goes to pg-boss retry and then DLQ (F4: no path). Author D' sends the user an error message. That needs `failure_reason`, but the generation is `completed`, the state machine has no `completed → failed` edge, and AD-2 forbids ad hoc writes.
- **Telegram errors**: 403 "bot was blocked by the user" and 400 "chat not found" are permanent. 429 carries `retry_after`. AD-11 says "Ошибки Telegram повторяются только в рамках deliver". That could mean a loop inside one job, pg-boss retries, or re-enqueue. Three authors, three behaviors. Permanent 403s get retried until DLQ.
- **Polza GET returns `completed` with no or empty URL** (schema drift): unclassified.
- **Polza 404 on GET** for an id we saved: the table maps 404 to `invalid_request`. That tells the user their request was invalid when the provider lost the job (should be `provider_failed`).
- **DB errors / bugs**: thrown, then DLQ, then `provider_unavailable` (F4). The user sees "provider unavailable" for our own bug.

**Fix (extend AD-6, adjust state machine):**
> `libs/telegram` exposes a classifier analogous to Polza's: `retry(after?)` for 429/5xx/network, `drop(reason)` for 403-blocked/400-chat-not-found (terminal, set `delivered_at = NULL, delivery_failed_at = now()`, no further attempts). CDN download errors classify as `retry` up to deliver's budget, then the generation is marked delivery-failed and, if the user is reachable, the user gets the `provider_failed` text — implemented as a state `completed → failed (provider_failed)` edge added to the diagram, or as a deliver sub-outcome that sends the dictionary text without a transition (pick one explicitly). 404 on GET maps to `provider_failed`. Unclassified exceptions map to `internal`.

## F6 — No single transition+enqueue primitive, so the transaction rule is unenforceable (medium)

AD-1 and AD-3 require "transition and next job in the same transaction". AD-2 requires all `generations` writes in `libs/generation`. But pg-boss `send` lives in `libs/platform`, and nobody owns the composition. Diverging compliant implementations:

- Author 1 calls `generationRepo.transition()` (its own Drizzle transaction), then `boss.send()` on pg-boss's own pool. That is not atomic, and a crash in between loses the next step, so the generation is stuck in `submitted` with no poll.
- Author 2 passes the Drizzle `tx` into `boss.send(..., { db: adapter(tx) })`.
- Author 3 puts `boss.send` inside `libs/generation`. Then `libs/generation` depends on pg-boss, which the dependency graph allows only via platform. Fine, but nobody decided it.
- AD-2's "0 rows ⇒ complete successfully, do nothing" collides with AD-3 when the transition succeeded but the enqueue failed in a non-atomic implementation. The retry sees 0 rows and does nothing, and the step is **lost**.

**Fix (tighten AD-2):**
> `libs/generation` exposes the only write API: `transition(id, from, to, patch, next?: { queue, startAfter?, singletonKey })`, which runs the conditional UPDATE and `boss.send` (via the pg-boss `db` adapter bound to the same Drizzle tx) atomically and returns `applied: boolean`. Handlers never call `boss.send` directly. Lint rule: `pg-boss` import is allowed only in `libs/platform` and `libs/generation`.

## F7 — Queue creation and options have no owner (medium)

pg-boss ≥ v10 requires `createQueue(name, options)` with `retryLimit`, `retryDelay`, `retryBackoff`, `expireInSeconds`, `deadLetter`, `policy`. The spine says only "схему pg-boss создаёт сам pg-boss" (the tables, not queues). Bot needs `generation.submit` to exist to send to it (AD-1 transaction), and worker needs all queues. Bot and worker each call `createQueue` with their own literal options. The first caller wins, and the other process silently runs with options it didn't expect. Neither reads them back.

**Fix (Conventions → Queues):**
> One `QUEUES` definition (name + full options) in `libs/platform`; queues are created/updated (`createQueue` + `updateQueue`) by the `migrate` one-shot step after drizzle migrations. Bot and worker never create queues; they fail fast at start if a queue is missing.

## F8 — Schema is under-specified for independent migration authors (medium)

The ER diagram omits columns that ADs depend on: `created_at`, `submitted_at` (needed by the AD-5 deadline), `completed_at`, `delivered_at` (AD-11), the unique `(chat_id, message_id)` (AD-9), plus whatever F1–F5 add (`attempts`, `step_started_at`, `delivery_failed_at`). `status` and `failure_reason` are `text` with no constraint, so a typo like `'complete'` in one handler and `'completed'` in another is undetected. Two authors of the first migration will differ (enum vs text+CHECK, nullable vs default).

**Fix:**
> ER diagram is authoritative and lists every column with nullability. `status` and `failure_reason` are Postgres enums (or text + CHECK) generated from the single TS union in `libs/generation`; `UNIQUE (chat_id, message_id)`; `CHECK ((status='submitted') <= (polza_generation_id IS NOT NULL))`, `CHECK ((status='completed') <= (result_url IS NOT NULL))`, `CHECK ((status='failed') <= (failure_reason IS NOT NULL))`.

## F9 — Poll deadline vs retries vs late completion (medium)

- If GET fails with 5xx near the deadline: does the deadline check run before or after classification? Is the outcome `timeout` or `provider_unavailable`? Two authors give two reasons for the same situation.
- Does deadline use DB `now()` or worker clock? The stored `submitted_at` comes from DB `now()` (or worker `new Date()`, unspecified). Clock skew between containers is small, but the rule should be fixed.
- After `failed/timeout`, Polza may still complete and charge. The spine accepts the double-charge risk only for AD-4. The "charged but user told timeout" case is not acknowledged. Since `POLZA_DEADLINE` (10 min) ≈ Polza server limit (600 s), this will happen.
- Ordering of exhaustion: if pg-boss retryLimit is reached before the deadline, should DLQ win (`provider_unavailable`) or should it wait for the deadline?

**Fix (tighten AD-5):**
> Deadline is checked first, using DB `now() - submitted_at`; if exceeded ⇒ `failed/timeout` regardless of the current error. Classified retries never outlive the deadline (the startAfter delay is capped to the remaining time). `POLL_DEADLINE` must exceed the Polza server limit (e.g. 12 min) so a timeout is truly a provider-side abandon. Late completion after timeout is an accepted, logged risk.

## F10 — Low-severity holes

- **AD-8 "ровно в одном экземпляре"** has no enforcement. `docker compose up --scale bot=2`, or an overlapping old/new container during a deploy, causes 409 Conflict loops. Suggested rule: the bot takes a Postgres advisory lock at start and exits if it can't get it. Compose sets `deploy.replicas: 1`.
- **Result before "accepted".** AD-9 sends "принято" after commit. The worker may finish faster than bot's `sendMessage` under Telegram latency or a 429 retry, so the user sees the photo before "принято". If the bot crashes after commit, the redelivered update hits a conflict and no "принято" is sent at all (acceptable, but state it).
- **Prompt validation** (empty, non-text, caption-only, edited message, length cap vs Polza 413) has no owner. Bot and submit may validate differently, and 413 at submit then shows up as `invalid_request` long after "принято". Rule: bot validates text-only, non-empty, length ≤ `MAX_PROMPT_LEN` before insert. Edited messages are ignored.
- **`model` captured at creation (AD-10) vs `model_prompt` computed at submit.** If templates later depend on the model, the generation is consistent. If `POLZA_MODEL` changes between deploys, in-flight `accepted` rows keep the old model. That is fine, but state it as intended.
- **Logs** require `trace_id` "for Polza errors". The client must surface it in the classifier result, otherwise handlers can't log it. Add it to the classifier's return type.

## ADs whose Rule does not enforce its own Prevents

| AD | Problem |
| --- | --- |
| AD-2 | Guard dedupes only real transitions. Self-loop (poll) and "0 rows ⇒ success" combined with a non-atomic enqueue loses steps (F3, F6). |
| AD-3 | "Same transaction" has no mechanism or owner (F6). "One external side effect" is unverifiable without the transition primitive. |
| AD-4 | The read-check is not mutual exclusion. Expiry, SIGTERM and duplicate enqueue widen the risk far beyond the stated window (F2). |
| AD-6 | The re-enqueue retry path bypasses the DLQ, so "exhaustion ⇒ provider_unavailable" never triggers (F1). Covers Polza only (F5). |
| AD-7 | "Every failed gets deliver" is not tied to any code path. The DLQ path and deliver exhaustion break it (F4). |
| AD-8 | "Exactly one instance" is a statement, not a mechanism (F10). |
| AD-11 | "Retried only within deliver" is ambiguous, and there is no terminal outcome for permanent Telegram/CDN errors (F5). |
