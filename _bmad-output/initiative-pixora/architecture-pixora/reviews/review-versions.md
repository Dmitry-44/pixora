# Review — technology and version claims (architecture-pixora)

Checked 2026-11-16 against npm registry (`npm view`), package tarballs (`npm pack` + source inspection), and live docs. The spine was not edited.

## Verdict

The stack is current and mutually compatible, and every pg-boss, PostgreSQL, Polza, and Telegram capability the spine relies on exists. Two Polza assumptions need correcting (403 is not always moderation; the status enum has a fifth value `cancelled`, and `data` may carry `b64_json` instead of `url`). One grammY detail weakens AD-9/shutdown: `bot.stop()` confirms the in-flight update without waiting for its handler.

## 1. Stack table

| Spine | Live value (2026-11-16) | Status | Source |
| --- | --- | --- | --- |
| Node.js 26 LTS (26.13.x) | v26.13.1 (2026-11-10, security release), LTS "Lithium" since 2026-10-28, EOL 2029-04-30. v27 is alpha only | OK | https://nodejs.org/dist/index.json, https://github.com/nodejs/Release/blob/main/schedule.json |
| TypeScript 6.0 (not 7.x) | npm `latest` = 7.0.2; 6.0 line = 6.0.3. `@nestjs/cli@12.0.13` depends on `typescript ~6.0.2`; starter pins `^6.0.2` | OK (pin `~6.0.3`) | `npm view typescript`, `npm view @nestjs/cli dependencies` |
| NestJS 12.5 | `@nestjs/core`/`common` 12.5.0 (published 2026-11-12); CLI/schematics 12.0.13 | OK | `npm view @nestjs/core` |
| grammY 1.46 | 1.46.0 (2026-08-26), latest | OK | `npm view grammy` |
| PostgreSQL 18.7 | 18.7 current (2026-11-12); 17.12, 16.16 supported | OK | https://www.postgresql.org/versions.json |
| pg-boss 12.38 | 12.38.2 (2026-11-10); engines `node >=22.12.0`; Postgres ≥13 | OK (use 12.38.2) | `npm view pg-boss` |
| Drizzle ORM 0.45 | 0.45.4 latest stable; 1.0 only in beta tags. drizzle-kit 0.31.11 | OK | `npm view drizzle-orm`, `npm view drizzle-kit` |
| nestjs-pino 5.3 | 5.3.1; peers `@nestjs/* ^11.0.8 \|\| ^12.0.2`, `pino ^10`, `pino-http ^11`; engines `node >=22.12.0` | OK | `npm view nestjs-pino peerDependencies` |
| Docker Compose v2 | Latest release v5.7.1 (2026-11-11). "v2" is only correct as "Compose V2 plugin (`docker compose`)", not as a version number | Wording | https://github.com/docker/compose/releases |

### Compatibility notes

- **TypeScript 6 vs 7 / decorators.** Nest 12 still requires legacy `experimentalDecorators` + `emitDecoratorMetadata` (starter tsconfig has both). TS 7.0 emits them, but ships no programmatic compiler API, so `nest build` (tsc/swc/rspack builders), schematics and CLI plugins fail on TS 7. Keep TS 6.0 — the spine's choice is correct. Sources: https://raw.githubusercontent.com/nestjs/typescript-starter/master/tsconfig.json, https://fabwaseem.com/blog/nestjs-12, https://github.com/microsoft/typescript-go/pull/2343.
- **ESM by default.** The current Nest 12 starter is `"type": "module"`, `module/moduleResolution: nodenext`, Vitest, oxlint. Relative imports need `.js` extensions. Not in the spine — worth stating in Consistency Conventions so builders don't mix CJS/ESM. Source: https://raw.githubusercontent.com/nestjs/typescript-starter/master/package.json.
- **Node floor.** pg-boss and nestjs-pino need Node ≥22.12, Nest ≥20 — all satisfied by Node 26.
- **Drizzle + pg-boss.** pg-boss's Drizzle adapter supports drizzle on `node-postgres`, `postgres-js`, `bun-sql`. Use `drizzle-orm/node-postgres` with `pg` (pg-boss bundles `pg` too).

## 2. pg-boss 12 (12.38.2) — API names

All verified in `dist/types.d.ts` / `dist/index.d.ts` of the tarball and in https://github.com/timgit/pg-boss/tree/master/docs/api.

| Need | Supported | Exact API |
| --- | --- | --- |
| (a) send inside external transaction, Drizzle | Yes | `import { fromDrizzle } from 'pg-boss'`; `import { sql } from 'drizzle-orm'`; `await db.transaction(async (tx) => { …; await boss.send('q', data, { db: fromDrizzle(tx, sql) }) })`. Also `fromKnex`, `fromKysely`, `fromPrisma`, `fromPglite`, `fromBunSql`. The `db` option (`ConnectionOptions`) is accepted by `send`, `insert`, `fetch`, `complete`, `fail`. Docs: `docs/api/adapters.md` ("ORM Transaction Adapters") |
| (a′) worker writes + completion atomic | Yes | `boss.work(name, { transactional: true, transactionTimeoutSeconds? }, async (jobs, tx) => …)`; `tx` is a pg-boss `Db` (`tx.executeSql(text, values)`), **not** a Drizzle tx. Pass `{ db: tx }` to `boss.send` to enqueue the next job atomically. ORM adapters do not apply here (pg-boss opens the transaction). Holds a pool connection per handler — suits short handlers only, not a 600 s Polza POST |
| (b) dead letter queues | Yes | Queue option `deadLetter: '<queue>'` (`createQueue`/`updateQueue`), also per-job `deadLetter` in `SendOptions`. DLQ must exist first (`Dead letter queue <name> does not exist`). Copied job carries `sourceName`, `sourceId`, `sourceRetryCount`, `sourceOutput`, `sourceRootId`; `redrive()` exists. Only reached when a job **fails after all retries** of *that job* |
| (c) delayed start | Yes | `startAfter: number (seconds) \| string (ISO or relative like '1 hour') \| Date` in send options; `boss.sendAfter(name, data, options, after)` convenience |
| (d) retries | Yes | `retryLimit` (default 2), `retryDelay` (seconds, default 0), `retryBackoff: boolean` (exponential with jitter), `retryDelayMax` (cap). Settable per queue or per job. `expireInSeconds` default 900, `heartbeatSeconds` optional |
| (e) graceful stop | Yes | `boss.stop({ graceful = true, timeout = 30000, close = true })` — workers stop fetching, active handlers may finish up to `timeout` ms, then are failed (consumes an attempt). Also `offWork(name, { wait })` |

Other relevant facts:

- `createQueue(name, options)` is required before `send` in v12 (`Queue <name> does not exist` otherwise).
- Self-re-enqueue (`send` with `startAfter` from a handler) creates a **new job with retryCount 0**, so `retryLimit`/DLQ never trigger for those loops. The spine's AD-6 (retry via `startAfter`, exhaustion via DLQ) combines two mechanisms that don't interact — already raised in review-rubric/review-adversary; confirmed by the API.
- `expireInSeconds` (default 900 s) must exceed the Polza POST client timeout (>600 s), otherwise pg-boss expires and re-dispatches a still-running submit (double charge path).
- `stop()` default timeout is 30 s, Docker default stop grace is 10 s — set `stop_grace_period` accordingly.

## 3. PostgreSQL 18 `uuidv7()`

Confirmed. Built-in `uuidv7([shift interval]) → uuid` in PostgreSQL 18 (no extension). Source: https://www.postgresql.org/docs/18/functions-uuid.html. Drizzle: `uuid('id').primaryKey().default(sql\`uuidv7()\`)`.

## 4. Polza.ai Media API

Sources: https://polza.ai/docs/api-reference/media/create.md, https://polza.ai/docs/api-reference/media/status.md, https://polza.ai/docs/api-reference/introduction.md.

- **Create:** `POST https://polza.ai/api/v1/media`, body `{ model, input, async?, user?, provider? }`. Response 200 `MediaStatusPresenter`: `{ "id": "aig_abc123", "object": "media.generation", "status": "pending", "created": 1703001244, "model": "…" }`. The intro also lists `201 — task created (async operations)`; accept both 200 and 201. The `async` flag (default false) is described as "forced async mode"; docs state create returns `pending`, but the schema doesn't forbid an immediate `completed` — handle `completed` in the submit response defensively.
- **Status:** `GET https://polza.ai/api/v1/media/{id}`. Status enum: `pending`, `processing`, `completed`, `failed`, **`cancelled`** (in OpenAPI enum; the prose table lists only four). Spine AD-5/AD-6 does not handle `cancelled` → map to `fail(provider_failed)`.
- **Result field:** `data.url` (e.g. `"data": { "url": "https://s3.polza.ai/f/…/aig_abc123.jpg" }`). `MediaImageDataPresenter` also defines `data.b64_json` and `data.revised_prompt`; `data` is a single object (not an array). Some models may return `b64_json` instead of `url` — treat missing `url` as either "decode base64" or `provider_failed`. Also `content` (text answer instead of image) and `warnings[]` may appear. `usage.cost_rub`/`cost`.
- **Failure detail:** `error: { code, message, metadata: { raw, provider_name } }` (`MediaErrorPresenter`; code examples `FORBIDDEN`, `BAD_GATEWAY`, `REQUEST_TIMEOUT`). Use `error.code`/`metadata.raw` to detect async moderation.
- **HTTP errors:** 400, 401, 402, 403, 404, 408, 409, 413, 429, 500, 502, 503. Body `ApiErrorPresenter`: `{ error: { code, message, trace_id?, details?, metadata?: { reason, raw, provider_name } }, trace_id }`. Codes: `BAD_REQUEST`, `UNAUTHORIZED`, `api_key_revoked`, `INSUFFICIENT_BALANCE`, `FORBIDDEN`, `guard_no_route`, `guard_blocked`, `unofficial_providers_disabled`, `NOT_FOUND`, `REQUEST_TIMEOUT`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `TOO_MANY_REQUESTS`, `BAD_GATEWAY`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`.
- **Retry guidance (intro page):** retry 408/502 with pause; 503 honoring `Retry-After`; 429 two kinds — Polza per-model limit (has `Retry-After`, seconds to next minute **or until midnight Moscow time**, no `metadata`) vs provider limit (no `Retry-After`, `metadata.provider_name`, backoff 1/2/4/8 s); 402 only under parallel-reserve contention; 400/401/403/404/413 not retried. Failed requests are not billed, except client-side aborts. No idempotency key. Request timeout 600 s; max file 50 MB. 500 and 409 are not in the retry table (spine retries 500 — reasonable but undocumented; 409 unhandled by spine).
- **Spine corrections:**
  - 403 = "access denied, **including** moderation rejection" — also key-permission/guard errors (`FORBIDDEN`, `guard_blocked`, `unofficial_providers_disabled`). Mapping all 403 → `moderation` is approximate; branch on `error.code`/`metadata.reason`.
  - Daily 429 `Retry-After` can be hours → needs a cap/deadline (already flagged in other reviews).
  - Add `cancelled` and missing-`url` handling.
- **`user` field:** exists — `user: string`, max 256 chars, "unique end-user identifier for tracking and abuse prevention". Can carry the Telegram user id (or a hash). Not a request tag/idempotency key; no documented way to query by it.
- **Retention:** results kept 7 days on CDN (confirmed).

## 5. Telegram Bot API (current: Bot API 10.4)

Source: https://core.telegram.org/bots/api (sections "Sending files", `sendPhoto`, `sendDocument`, "Getting updates", `getUpdates`).

- `sendPhoto` multipart upload: **max 10 MB**; width + height **≤ 10000 total**; aspect ratio **≤ 20**. By URL: 5 MB for photos.
- `sendDocument` multipart: **max 50 MB** (URL: 20 MB). Download via `getFile`: 20 MB.
- AD-11 is sound: >10 MB or dimension/ratio violation → `sendDocument`. Telegram recompresses photos; a lossless PNG original is only preserved via `sendDocument`.
- **Update retention:** pending updates are kept on the server until received, but **no longer than 24 hours**. An update is confirmed as soon as `getUpdates` is called with `offset` higher than its `update_id`.

## 6. grammY `bot.start()` ack behaviour (1.46.0, `out/bot.js`)

- `loop()`: `getUpdates({ offset: lastTriedUpdateId + 1, timeout: 30 })` → `handleUpdates(batch)` processes updates **sequentially**, awaiting each middleware chain → only then the next `getUpdates` with the new offset. So in normal running an update is confirmed **after** its handler (and the rest of its batch) finishes.
- **Crash mid-handler (no `stop()`):** the current batch was never confirmed → on restart Telegram redelivers it (within 24 h), **including already-handled updates earlier in the same batch**. At-least-once → AD-9's `(chat_id, message_id)` unique key is required and sufficient.
- **`bot.stop()` (SIGTERM path):** aborts the pending `getUpdates`, then immediately calls `getUpdates({ offset: lastTriedUpdateId + 1, limit: 1 })`, which **confirms the update currently being handled even though its middleware hasn't finished** (`stop()` does not wait for middleware; await the `bot.start()` promise for that). If the process exits before that handler commits, the update is **lost**. Mitigation for the spine: on SIGTERM call `bot.stop()` and then await the `bot.start()` promise before exiting (and keep the handler short: insert + enqueue + reply).
- Errors: with `bot.catch(handler)` set, a throwing middleware is reported and the loop continues (update counts as handled → confirmed). Without `bot.catch`, the default handler stops the bot. Polling 401/409 are rethrown (409 = another `getUpdates` consumer / webhook — AD-8).
- `bot.start()` calls `deleteWebhook` first; `drop_pending_updates` option must stay false.

## 7. NestJS 12 monorepo mode

Supported. Docs (v12, https://docs.nestjs.com/cli/monorepo): `nest generate app <name>` converts to monorepo; `nest generate library <name>` creates `libs/<name>`; `nest-cli.json` has `"monorepo": true`, `"root"`, `"projects": { … type: application|library … }`. CLI 12.0.13 types still include `monorepo`, `projects`, plus new `includeLibraryAssets`. Note: monorepo mode's default builder in Nest 12 is **Rspack** (single bundled file); set `"builder": "tsc"` or `"swc"` if per-file output is wanted. `webpack`/`webpackConfigPath` flags are deprecated.

## Unconfirmed / follow-ups

- Exact shape of a moderation failure during polling (`status: failed`) — docs only give `error.code` examples (`FORBIDDEN`, …); verify empirically with a rejected prompt.
- Whether any image model on Polza returns `b64_json` without `url` for Media API — not documented per model; verify for the chosen `POLZA_MODEL`.
- Whether `POST /v1/media` ever returns `completed` synchronously when `async` is false — docs say `pending`; handle both.
