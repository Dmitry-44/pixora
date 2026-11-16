# Rubric Review — Architecture Spine: Pixora

- **Reviewed:** `architecture-pixora.md` (draft, 2026-11-16)
- **Context:** `brief-pixora/brief-pixora.md`, `brief-pixora/addendum.md`
- **Reviewer stance:** rubric check against the good-spine checklist. I did not edit the spine.

## Verdict

The spine is strong and mostly builder-ready. The paradigm is clear, AD-1 to AD-4 and AD-9 close the main data-integrity divergences, and the error classification table is concrete. It is **not yet consistent enough to hand to builders**, for four reasons: the retry and dead-letter mechanics leave room for divergence and even infinite loops; deliver has no terminal-failure path; the ERD is missing columns that the ADs depend on; and the operational envelope (restart, health, shutdown timing, job expiry) is mostly silent.

## Findings

### F1 — HIGH — Retry and dead-letter semantics are underspecified and self-contradictory (AD-6, AD-3)

- AD-6 mixes two retry mechanisms. `retry(after)` re-enqueues a fresh job with `startAfter`. "Exponential backoff" retry is not said to work the same way, so it implies pg-boss native retry (thrown error plus `retryBackoff`). With self-requeue, pg-boss's `retryCount` starts over on every new job, so the dead-letter queue is never reached. A permanently returned `429 Retry-After` or `503` would loop forever. Builders will choose differently for each queue.
- There is no fixed `retryLimit`, base delay, or cap, and no rule for whether those are the same across `submit`, `poll` and `deliver`.
- "Dead letter ... moves the generation to `failed`" does not say who consumes the dead-letter queue: a dedicated queue per step, or a shared one? It also does not say which transition happens for which source queue.
- **Fix:** Add one rule. All retries, including `Retry-After`, go through the pg-boss retry of the same job: throw a typed `RetryableError`, and for `after` use `retryDelay` or re-enqueue with an explicit attempt counter carried in the DB row (not the payload, because the payload must stay `{ generationId }`). Fix `retryLimit`, `retryBackoff` and the cap once in `libs/platform` and apply them to all `generation.*` queues. Name the dead-letter queue (for example `generation.dead`). Give it one handler that maps `accepted|submitted → failed(provider_unavailable)` and enqueues deliver.

### F2 — HIGH — The deliver step has no terminal-failure path; the state diagram and AD-6/AD-11 do not close (AD-7, AD-11)

- AD-11 says "Telegram errors are retried only within deliver". It does not classify Telegram errors: 403 bot blocked, 400 chat not found, and 429 with `retry_after` are all unhandled. It also does not cover a failed download of `result_url`.
- If deliver exhausts its retries, AD-6 dead-letter semantics would move the generation to `failed`. From `completed`, that is a transition not in the state diagram. From `failed`, it would enqueue deliver again (AD-7: "every failed gets deliver"), which loops.
- If downloading the image fails permanently, the user gets silence. That violates the brief's "окончательные ошибки доходят до пользователя... а не молчанием".
- **Fix:** Add a Telegram error classifier to `libs/telegram`, mirroring AD-6: `retry(after)` / `drop`. Decide what happens when deliver is exhausted. Options are (a) a terminal `delivery_failed` marker such as a `delivery_failed_at` column, logged and with no further jobs, or (b) on a download failure, a downgrade from `completed` to `failed(provider_failed)` plus an error message to the user. Add the chosen transition to the state diagram and exclude `generation.deliver` from the generic dead-letter-to-failed mapping.

### F3 — HIGH — The ERD is missing columns and constraints that the ADs and conventions rely on

The `GENERATIONS` ERD lacks the following:
- `created_at`, `submitted_at`, `completed_at`, `delivered_at`. The "Время" convention declares them, AD-5 computes `POLL_DEADLINE` from submit time, and AD-11 makes `delivered_at` the idempotency guard for deliver.
- The unique key `(chat_id, message_id)`, which AD-9's idempotent intake depends on.
- The type and domain of `status` and `failure_reason`. Is each a text plus CHECK, or a pg enum? The closed list in AD-7 should be enforced in the schema, otherwise builders will diverge.
- Any column for F1's attempt counter or F2's delivery-failure marker, if those fixes are adopted.

**Fix:** Add the four timestamps (`created_at` default `now()`, the rest nullable) and mark `UK (chat_id, message_id)`. State that `status` and `failure_reason` are text with a CHECK constraint over the closed lists from the state diagram and AD-7, or are pg enums.

### F4 — MEDIUM — Duplicate poll chains are possible; the AD-2 guard does not protect a self-transition

- `submitted → submitted` always matches `WHERE status = 'submitted'`, so AD-2's conditional update does not deduplicate. Suppose the worker crashes after committing "next poll + transition" but before pg-boss marks the current job complete. pg-boss retries the current job, and now two poll chains run in parallel. Each further crash can double them. This multiplies Polza GET calls and 429s.
- **Fix:** Enqueue poll with `singletonKey: generationId` (or a pg-boss `singleton` or `stately` queue policy for `generation.poll`), or guard with a `poll_seq` or `updated_at` version column in the conditional update. Apply the same singleton rule to `submit` and `deliver` for symmetry.

### F5 — MEDIUM — The operational envelope is mostly silent

The spine decides on Docker Compose on a VPS outside Russia, `local`/`prod` environments, and `.env` secrets. Backups, CI/CD and the provider are deferred, which is acceptable. The following are **neither decided nor deferred**:
- **Restart policy** for `bot`, `worker` and `postgres`, for example `restart: unless-stopped`. The brief's "перезапуск любого сервиса" criterion depends on it.
- **Health checks and readiness:** a Postgres `healthcheck`, `depends_on` with `service_completed_successfully` for `migrate` and `service_healthy` for `postgres`. Without these, the "migrations before bot and worker" convention is not enforceable.
- **Shutdown timing:** the Polza HTTP timeout is above 600 s (AD-6), but Docker's default stop grace period is 10 s. "Waits for active jobs" will be cut off by SIGKILL. pg-boss's job `expireInSeconds` must also exceed the client timeout, or pg-boss will re-dispatch a job that is still running. That is a direct path to double charging that bypasses AD-4.
- **Single bot instance:** AD-8 requires exactly one bot instance, but nothing enforces it (no `replicas: 1` or `deploy` note, and no rule to run `docker compose up` once).
- **Log retention** on the VPS (Docker log driver rotation), and how `.env` gets onto the VPS and is rotated.
- **Fix:** Add an "Operations" row group to the Consistency Conventions: restart policy, healthchecks and `depends_on` conditions, `stop_grace_period` ≥ the longest job, `expireInSeconds` > Polza client timeout, json-file log rotation, and one bot replica. Alternatively, list each one explicitly under Deferred or Open Questions.

### F6 — MEDIUM — The Polza timeout rule is too broad and clashes with the poll cadence (AD-5, AD-6)

- "Таймаут HTTP-клиента Polza больше её серверного лимита (600 с)" reads as applying to every Polza call. For `GET /v1/media/:id`, with a 5 s interval and a 10 min deadline, a 600 s+ timeout is meaningless: a single hung GET consumes the whole `POLL_DEADLINE`.
- **Fix:** Split the timeouts. `POST /v1/media` gets > 600 s (the addendum notes a client-side abort is billed). `GET /v1/media/:id` and the CDN download get a short explicit timeout (for example 15–30 s). The deadline check must happen before the HTTP call.

### F7 — MEDIUM — The `internal` failure reason has no producer

AD-7 lists `internal`, but no rule says when it is assigned. Non-Polza exceptions in handlers, such as DB errors or bugs, will go through pg-boss retry to the dead-letter queue and then to `provider_unavailable` (AD-6). That gives the user a misleading message, and `internal` is never used.
**Fix:** Have the dead-letter handler use `provider_unavailable` only when the last error was classified as Polza `retry`, and `internal` otherwise. Store the last classification on the row, or include it in the error thrown.

### F8 — LOW — Stack versions should be re-verified

Relative to Nov 2026 some minors look inflated. PostgreSQL 18.7: PG 18 GA was Sep 2025 with quarterly minors, so about 18.4–18.5 is expected. Node 26.13.x: Node 26 has only just entered LTS. pg-boss 12.38 and NestJS 12.5 are also questionable. Drizzle 0.45 may already have been overtaken by 1.x. The majors are plausible, and PG 18 native `uuidv7()` is correctly relied on.
**Fix:** Check each against npm or the release page and pin the actual current minor, or pin major only (`18.x`, `26 LTS`).

### F9 — LOW — Minor gaps against the brief and in input handling

- Non-text updates from allowed users (photos, stickers, voice) have no defined behaviour. Photo upload is out of scope, so a short "только текст" reply should be a rule in AD-9 so that the bot and the tests agree. Prompt length and empty-text validation are also unspecified (they currently fall through to Polza 400 → `invalid_request`, which is acceptable if stated).
- In AD-9, if the process crashes after commit but before sending «принято», the redelivered update hits the unique conflict and no ack is ever sent. The generation still arrives, so this is acceptable, but say so explicitly.
- AD-2 and AD-6 to AD-11 have no `[ADOPTED]` or other status marker, while AD-1, AD-3, AD-4 and AD-5 do. Mark them consistently.
- `[ASSUMPTION]` values (`POLL_INTERVAL`, `POLL_DEADLINE`, the whitelist mechanism) are fine as inline assumptions. The spine has no Open Questions section, so add one that lists them together with the F5 items not yet decided.

## Checklist Summary

| Criterion | Result |
| --- | --- |
| Fixes real divergence points, misses none | Partial: retry and dead-letter mechanics (F1), deliver failure (F2), poll dedup (F4) |
| Every AD Rule enforceable and prevents its divergence | Mostly. AD-2 does not cover the self-transition (F4); AD-6's dead letter is not wired up (F1); AD-8's single instance is not enforced (F5) |
| Deferred cannot cause divergence | Pass. All deferred items are value choices or future scope with a named extension point |
| Named tech plausibly current | Majors pass, some minors doubtful (F8) |
| Covers every brief requirement | Mostly. The "no silence" criterion is broken for delivery failures (F2); "сервисы подняты" and restarts need an ops envelope (F5); Russia/Telegram risk addressed (VPS outside Russia); limits, model and moderation explicitly deferred or handled |
| Every dimension decided, deferred, or open | Fail on operations: restart, health, shutdown grace, job expiry, log retention (F5) |
| Decisions not rationale | Pass. Prose is terse; Deferred has short justifications, which is acceptable |
| Valid mermaid conveying structure | Pass. All four diagrams parse and convey structure; the state diagram needs F2's transition |
| No leftover template comments/placeholders | Pass. Only intentional `[ASSUMPTION]` markers |
| No contradictions between ADs, conventions, diagrams, ERD | Fail: timestamps and unique key missing from the ERD (F3); dead letter vs state diagram for deliver (F2); the 600 s timeout vs poll cadence and stop grace (F5, F6) |
