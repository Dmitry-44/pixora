---
title: 'Каркас монорепо и стек в compose'
type: 'feature'
ticket: '1'
created: '2026-11-17'
status: 'built'
baseline_revision: '2cd6b0f18407ce8088455835e120d7f1a45c7943'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-pixora/architecture-pixora/architecture-pixora.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Кода нет; историям 2–7 нужна платформа — монорепо NestJS, конфиг, логи, БД со схемой `generations` и стек, который поднимается одной командой `docker compose up`.

**Approach:** NestJS 12 монорепо (ESM, TS 6, strict) с `apps/bot`, `apps/worker`, `libs/platform` (config, db, logger); полная схема `generations` по spine в Drizzle и одна миграция drizzle-kit; один `Dockerfile` и один `docker-compose.yml` с сервисами migrate, postgres, bot, worker. Процессы пока только стартуют и пишут JSON-строку старта.

## Boundaries & Constraints

**Always:** версии из spine «Stack» (Node 26, TS 6.0.x, NestJS 12.5, Drizzle 0.45, nestjs-pino 5.3, PostgreSQL 18.7); конфиг только из env с валидацией схемой при старте — невалидный конфиг, процесс не стартует; секреты только в `.env` (в `.gitignore`), в репозитории — `.env.example`; файлы `kebab-case`, колонки `snake_case`, `id` — `uuidv7()`, время — `timestamptz`; один compose-файл для local и prod.

**Never:** grammY, pg-boss, Polza, `libs/generation`, `libs/telegram`, `libs/polza` — это истории 2–3; env-переменные, нужные только будущим историям; Redis и другие брокеры; второй compose-файл; логирование значения `DATABASE_URL`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Валидный env | `DATABASE_URL`, `LOG_LEVEL` заданы | bot и worker пишут одну JSON-строку старта (`msg`, `app`) | No error expected |
| Нет `DATABASE_URL` | переменная отсутствует | процесс не стартует, exit code ≠ 0 | в stderr — имя невалидной переменной, без значений |
| Невалидный `LOG_LEVEL` | значение вне уровней pino | процесс не стартует, exit code ≠ 0 | то же |
| Чистая БД | пустой volume postgres | migrate применяет миграцию и завершается с кодом 0 | ошибка миграции — exit ≠ 0, bot и worker не стартуют |
| Повторный `up` | миграция уже применена | migrate завершается с кодом 0, ничего не меняя | No error expected |

## Decisions

- 2026-11-17 — самоподъём worker проверяется падением процесса внутри контейнера (`docker compose exec worker pkill -9 node`, у сервиса `init: true`), а не `docker kill`: Docker считает `docker kill` ручной остановкой и `unless-stopped` его не перезапускает.
- 2026-11-17 — Node на хосте не используется (там 20.19): `npm install`, сборка, тесты и `drizzle-kit generate` запускаются в контейнере `node:26-alpine` с примонтированным репозиторием; compose-файл ради этого не меняется.
- 2026-11-17 — план длиннее 1600 токенов оставлен целым: цель одна, объём даёт русский текст.

</frozen-after-approval>

## Code Map

Репозиторий пустой, кроме `_bmad*` и `.gitignore`; переиспользовать нечего. Источник истины — spine `architecture-pixora.md`: «Structural Seed» (дерево каталогов, compose, ER-схема), «Consistency Conventions», AD-7 (перечень `failure_reason`).

- `.gitignore` -- уже есть; дописать `node_modules/`, `dist/`, `.env`, не трогая существующие строки.
- `_bmad*` -- не трогать.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json` -- монорепо NestJS (`"type": "module"`, projects `bot`, `worker`, `platform`, path alias `@pixora/platform`), npm-скрипты `build`, `test`, `db:generate`, `db:migrate` -- каркас по spine.
- [x] `libs/platform/src/config/` -- zod-схема env (`DATABASE_URL` — URL postgres, `LOG_LEVEL` — уровень pino, по умолчанию `info`) и `loadConfig(env)`, бросающая ошибку с именами полей без значений; NestJS-модуль, отдающий типизированный конфиг -- конфиг из env с валидацией.
- [x] `libs/platform/src/logger/` -- модуль nestjs-pino: JSON в stdout, уровень из конфига, `base` с `app` -- JSON-логи.
- [x] `libs/platform/src/db/schema.ts`, `libs/platform/src/db/db.module.ts` -- таблица `generations` со всеми колонками ER-схемы spine, `UNIQUE (chat_id, message_id)`, CHECK на `status` и `failure_reason` (nullable, перечень AD-7), `attempts`/`poll_count` default 0, `created_at` default `now()`; провайдер Drizzle на `node-postgres` пуле -- полная схема по spine.
- [x] `drizzle.config.ts`, `drizzle/` -- сгенерировать миграцию `drizzle-kit generate` и закоммитить SQL -- миграция.
- [x] `apps/bot/src/main.ts`, `apps/bot/src/app.module.ts`, `apps/worker/src/main.ts`, `apps/worker/src/app.module.ts` -- приложения на `createApplicationContext`, импортируют config/logger/db, логируют `bot started` / `worker started` и остаются живыми -- точка входа процессов.
- [x] `Dockerfile`, `.dockerignore` -- одна многоступенчатая сборка на `node:26-alpine`, один образ для migrate, bot и worker -- образ стека.
- [x] `docker-compose.yml` -- `postgres:18.7` с volume и healthcheck `pg_isready`; `migrate` (`drizzle-kit migrate`, без restart); `bot` и `worker` с `restart: unless-stopped`, `init: true`, `depends_on` (`postgres: service_healthy`, `migrate: service_completed_successfully`), `stop_grace_period: 90s`, logging `json-file` с ротацией; env из `.env` -- стек одной командой.
- [x] `.env.example` -- все переменные compose и приложения с плейсхолдерами -- шаг человека.
- [x] `libs/platform/src/config/config.spec.ts` -- vitest: валидный env, отсутствие `DATABASE_URL`, невалидный `LOG_LEVEL`, ошибка не содержит значений -- I/O-матрица конфига.

**Acceptance Criteria:**
- Given чистая машина с `.env` из `.env.example`, when `docker compose up -d`, then migrate завершается с кодом 0, а bot и worker в `docker compose logs` пишут JSON-строку старта.
- Given стек поднят, when в psql `\d generations`, then есть все колонки spine, `UNIQUE (chat_id, message_id)` и CHECK на `status` и `failure_reason`.
- Given стек поднят, when процесс node внутри контейнера worker убит (`pkill -9 node`), then контейнер worker поднимается сам и снова пишет строку старта.

## Implementation Notes

- Сборка — rspack-билдер Nest CLI 12 (как в `nest new` для монорепо): бандлит приложение, alias `@pixora/platform` разрешается при сборке, зависимости остаются внешними (`webpack-node-externals`). Поэтому добавлены `apps/*/tsconfig.app.json` (свой `outDir` на приложение); они наследуют `tsconfig.build.json`.
- `createApplicationContext` с `logger: false`: служебные строки Nest при старте не пишутся, остаётся одна строка `bot started` / `worker started`. Ошибка инициализации (невалидный конфиг) всплывает из top-level await в stderr, exit 1; `abortOnError: false` — чтобы не `process.abort()`.
- Процесс держит живым `setInterval`; `enableShutdownHooks()` закрывает контекст (пул pg) по SIGTERM, выход с кодом 143 за ~1 с.
- Ключи конфига — имена env (`config.DATABASE_URL`, `config.LOG_LEVEL`), без переименования.
- `migrate` вызывает `node_modules/.bin/drizzle-kit migrate` напрямую (без `npx` — без шума npm в логах).

## Plan Change Log

## Review Triage Log

Pass 1 (quick): high 0, medium 1, low 1, false 0, maybe-false 0.

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| `drizzle.config.ts` — migrate читает `DATABASE_URL` мимо zod-схемы, `?? ''` | low | rejected | Проверено: с пустым `DATABASE_URL` migrate завершается с exit 1 и пишет `url: ''`, bot и worker не стартуют; `loadConfig` в конфиге drizzle сломал бы `db:generate` без БД — фикс сложнее прямой правки. |
| `.env.example` — учётные данные Postgres дублируются в `POSTGRES_*` и `DATABASE_URL` | medium | patch | Смена только `POSTGRES_PASSWORD` на чистом volume даёт отказ аутентификации migrate; добавлен комментарий над `DATABASE_URL`, что значения должны совпадать. Verification перезапущена — зелёная. |

## Design Notes

- zod для схемы env: одна схема даёт и валидацию, и тип конфига; ошибку собираем из `issue.path`, без `input`.
- vitest вместо Jest: Jest плохо работает с ESM; vitest 5 требует Node ≥ 22.12.
- migrate запускает `drizzle-kit migrate` в том же образе (devDependencies остаются в образе): один образ проще двух, размер образа на этом этапе не важен.
- `init: true` (tini как PID 1): без него SIGKILL изнутри контейнера процессу node с PID 1 игнорируется.
- `node_modules` ставится в Linux-контейнере в примонтированный каталог — запускать его можно только из контейнера, не с хоста.
- Проверено на этой машине: `docker kill` не запускает `restart: unless-stopped` (Docker считает это ручной остановкой) — контейнер остаётся `exited`, 0 рестартов; `pkill -9` процесса внутри контейнера с `--init` даёт рестарт.

## Verification

Node-команды идут в контейнере (Git Bash на Windows): `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/app -w /app node:26-alpine <cmd>` — ниже `NODE <cmd>`.

**Commands:**
- `NODE npm install` -- expected: `package-lock.json` создан или актуален.
- `NODE npm run build` -- expected: bot и worker собираются без ошибок TS.
- `NODE npm test` -- expected: тесты конфига зелёные.
- `NODE npm run db:generate` -- expected: «No schema changes» после коммита миграции.
- `docker compose up -d --build && docker compose ps -a` -- expected: migrate `exited (0)`, postgres `healthy`, bot и worker `running`.
- `docker compose exec postgres psql -U pixora -d pixora -c '\d generations'` -- expected: колонки и ограничения из AC.
- `docker compose exec worker pkill -9 node; sleep 5; docker compose ps worker` -- expected: worker `running`, в логах вторая строка `worker started`.
- `docker compose run --rm --no-deps -e DATABASE_URL= worker` -- expected: exit ≠ 0, в выводе имя `DATABASE_URL`.
