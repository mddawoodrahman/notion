# Spec: Notion Tasks → PostgreSQL Synchronization Service

**Document type:** Engineering specification
**Version:** 1.0 (draft for approval)
**Date:** 21 October 2026
**Status:** DRAFT — awaiting owner approval. No implementation work starts until this is approved.
**Derived from:** [`Notion_to_PostgreSQL_Sync_PRD.md`](./Notion_to_PostgreSQL_Sync_PRD.md) v1.0
**Scope:** One-way synchronization, Notion → PostgreSQL. V1 only.

> This document converts the PRD's product requirements into implementable engineering contracts:
> exact module boundaries, SQL, algorithms, error taxonomy, and test mapping. Where it makes a
> decision the PRD left open, the decision is marked **DECISION** with a rationale. Where it cannot
> decide without the owner, it is listed in [§19 Open Questions](#19-open-questions--decisions-required).

---

## 0. Assumptions I am making

Stated before any spec content, per process. Correct any of these now — they propagate into the SQL,
the module layout, and the tests.

| # | Assumption | Why I assumed it | Impact if wrong |
|---|---|---|---|
| A1 | The task's `List` property is a **`select`** (single value) → `list_name TEXT` | PRD types `list_name` as `TEXT` and separately says multi-select must not be flattened | If it is `multi_select`, `list_name` becomes NULL and the array survives only in `raw_properties`; schema needs a join table or array column |
| A2 | `Priority` is a **`select`**, not a Notion native `status` | PRD has both `status` and `priority` as separate `TEXT` columns | Mapping changes; `priority` may need the same `status.name` extraction path |
| A3 | `Status` is a **`status`** property type (not `select`) | PRD calls it "displayed status label"; Notion `status` type exposes `.name` | If `select`, extraction path differs but column is unchanged |
| A4 | `Important`, `In My Day`, `Archived` (custom) are **`checkbox`** properties | PRD types them `BOOLEAN` | Non-boolean source needs a coercion rule |
| A5 | `Due Date` and `Reminder` are **`date`** properties | PRD splits `due_date DATE` / `due_at TIMESTAMPTZ` / `reminder_at TIMESTAMPTZ` | Mapping changes |
| A6 | `SYNC_TIMEZONE=Asia/Kolkata` is the interpretation zone for datetimes that arrive **without** an offset | Value in PRD §15.1 | Naive datetimes shift |
| A7 | Task page body sync (**FR-005**) is **enabled in V1** | PRD §19.2 "recommends yes"; FR-005 is P1 | If disabled, `page_content_json` stays `[]` and the block-fetch code path is skipped |
| A8 | Runtime is **Node.js 22 LTS**, TypeScript **strict**, ESM | Modern LTS; PRD says Node.js + TypeScript | ESM/CJS interop details change |
| A9 | HTTP framework is **Fastify 5** | Built-in schema validation, structured logging, precise raw-body control for signatures | Express equivalent exists; raw-body handling differs |
| A10 | Migrations are **hand-rolled numbered `.sql` files** run by a small `pg`-based runner, not a library | `migrations/` folder already exists and is empty; keeps dependencies minimal and SQL reviewable | A migration library would need its own conventions |
| A11 | Integration/E2E tests run against a **real PostgreSQL** (dedicated Neon branch), never a mock | Idempotency, `ON CONFLICT`, `FOR UPDATE SKIP LOCKED` are the behaviours under test — a mock cannot prove them | Tests need a `TEST_DATABASE_URL`; suites skip loudly without it |
| A12 | The existing `src/`, `db/`, `routes/`, `sync/`, `migrations/` folders are the intended skeleton and should be **kept and assigned roles**, not restructured | They exist in the repo already, empty | A consolidated `src/**` layout would replace §4 |
| A13 | Backfill runs as a **CLI command**, not an HTTP endpoint; HTTP surface is webhook + health only | PRD §11.3 lists backfill/reconcile as `npm run` commands | Extra endpoint + auth needed |
| A14 | Postgres 16+ on Neon; no Neon-proprietary features in schema or queries | PRD §14 "Portability" | — |

---

## 1. Objective

Maintain a durable, queryable PostgreSQL replica of an existing Notion task database, keeping it
correct under duplicate webhooks, reordered events, API outages, worker crashes, and partial scans —
without ever writing back to Notion.

**Primary user:** the task owner, who keeps working in Notion and never touches PostgreSQL.
**Secondary user:** the database operator, who needs to see *why* the replica is stale or broken.

**What success means:** if you read a Notion task in the UI and read its row in
`notion_sync.notion_tasks` a few minutes later, they agree — and if they disagree, the system can
tell you which event failed and why.

**Explicit non-goals** (from PRD §4, restated so no one re-adds them): analytics, dashboards, task
history, `task_events`, `daily_task_snapshots`, bidirectional sync, custom UI, workspace-wide
replication, comment/user sync, binary attachment storage.

---

## 2. Architecture and module boundaries

### 2.1 Data flow

```
                       ┌──────────────────────────┐
   Notion dashboard ──▶│  Notion master Tasks DB  │
   (only editor)       │  (system of record)      │
                       └───────────┬──────────────┘
                                   │  REST (read-only)
                                   ▼
        ┌──────────────────────────────────────────────┐
        │           Sync service (Node/TS)             │
        │                                              │
        │  backfill ──┐                                │
        │  reconcile ─┼──▶ normalize ──▶ repository ───┼──▶ PostgreSQL
        │  worker ────┘        ▲                       │    notion_sync.*
        │                      │                       │
        │  webhook ──▶ sync_inbox (durable) ──▶ worker │
        └──────────────────────────────────────────────┘
                 ▲
                 │ HTTPS POST + X-Notion-Signature
              Notion webhooks
```

### 2.2 Invariants

These hold at all times and every test should be traceable to one of them.

| ID | Invariant |
|---|---|
| INV-1 | Exactly one `notion_tasks` row per `notion_page_id`. No view, retry, or backfill can create a second. |
| INV-2 | No task row is written from a webhook payload alone. Every write is derived from a **freshly fetched** page. |
| INV-3 | A webhook is acknowledged only after its `sync_inbox` row is committed. |
| INV-4 | An older snapshot never overwrites a newer one (`notion_last_edited_time` guard). |
| INV-5 | Absence from a scan never implies deletion. Tombstones require positive evidence. |
| INV-6 | Every `notion_tasks` write happens in the same transaction that marks its inbox row `processed`. |
| INV-7 | No secret, token, connection string, or full page body appears in any log line or HTTP response. |

### 2.3 Module dependency direction

One-way only. `db/` never imports `routes/`; `sync/` never imports `routes/`.

| Module | Responsibility | May import |
|---|---|---|
| `src/` | Process bootstrap, config, logging, error types | — |
| `db/` | Connection pool, migrations, repositories, raw SQL | `src/` |
| `sync/` | Notion client, normalization, backfill, worker, reconcile, retry policy | `src/`, `db/` |
| `routes/` | HTTP surface, request validation, response codes | `src/`, `db/`, `sync/` |
| `migrations/` | Numbered SQL, executed by `db/migrate.ts` | — |

---

## 3. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS | ESM (`"type": "module"`) |
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true` | `tsc` for build, `tsx` for dev |
| HTTP | `fastify@^5` | Raw-body capture for signature verification |
| Notion | `@notionhq/client@^5.23.0` **minimum** | `verifyWebhookSignature()` landed in 5.23.0 — pin `>=5.23.0` |
| Postgres | `pg@^8` | Pooled URL for runtime, direct URL for migrations |
| Validation | `zod@^3` | Env schema + webhook envelope schema |
| Logging | `pino` (bundled with Fastify) | Structured, with `redact` paths |
| Tests | `vitest@^2` | Unit fast; integration against real Postgres |
| Env | `@neon/env` + `@neon/config` **already installed** | **DECISION:** keep for Neon linkage, but do **not** let it be a second source of truth — `src/config.ts` (zod) is authoritative and is the only module other code may import |

**Deliberately not added:** an ORM (raw parameterized SQL is required by PRD §11.2 and makes the
`ON CONFLICT` / `SKIP LOCKED` contracts explicit), a job queue library (`sync_inbox` *is* the queue),
a migration framework (see A10).

---

## 4. Project structure

Existing folders keep their roles; nothing is renamed.

```
D:\Notion\
├── migrations/
│   ├── 0001_init.sql                 # schema, tables, indexes, constraints
│   └── 0002_...                      # additive only; never destructive
├── src/
│   ├── config.ts                     # zod-validated, frozen config object (single export)
│   ├── logger.ts                     # pino instance + redaction config
│   ├── errors.ts                     # SyncError taxonomy + classify()
│   └── server.ts                     # Fastify app factory + listen()
├── routes/
│   ├── health.ts                     # GET /health, GET /ready
│   └── webhooks.ts                   # POST /webhooks/notion
├── sync/
│   ├── notion-client.ts              # SDK wrapper: retRy, pagination, rate-limit handling
│   ├── property-map.ts               # property-name → column mapping (configurable)
│   ├── normalize.ts                  # page → NotionTaskRecord (pure, no I/O)
│   ├── task-sync.ts                  # fetch-page → normalize → upsert (the shared core)
│   ├── backfill.ts                   # paginated full import
│   ├── worker.ts                     # claim → process → settle loop
│   ├── reconcile.ts                  # scheduled scan + repair
│   └── retry-policy.ts               # backoff math + error classification
├── db/
│   ├── pool.ts                       # pg.Pool singleton, TLS, timeouts
│   ├── migrate.ts                    # numbered SQL runner + advisory lock
│   ├── tasks-repo.ts                 # upsert, read, list-in-scope
│   ├── inbox-repo.ts                 # enqueue, claim, settle, requeue, recover-stuck
│   └── runs-repo.ts                  # start/finish run records
├── tests/
│   ├── unit/                         # pure functions, no I/O
│   ├── integration/                  # real Postgres, gated on TEST_DATABASE_URL
│   └── e2e/                          # AT-01 … AT-17
├── scripts/                          # thin CLI entrypoints for npm run sync:*
├── .env.example
├── package.json
└── tsconfig.json
```

**Rules:** `routes/` handlers contain no SQL. `sync/normalize.ts` performs no I/O (so it is trivially
unit-testable). Only `db/**` imports `pg`.

---

## 5. Commands

```bash
# Development
npm run dev                  # tsx watch src/server.ts

# Quality
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint . --max-warnings=0
npm run build                # tsc -p tsconfig.json      → dist/
npm start                    # node dist/src/server.js

# Tests
npm test                     # vitest run (unit + integration if TEST_DATABASE_URL set)
npm run test:unit            # vitest run tests/unit
npm run test:integration     # vitest run tests/integration   (requires TEST_DATABASE_URL)
npm run test:e2e             # vitest run tests/e2e          (requires real Notion + DB)

# Database
npm run db:migrate           # node dist/db/migrate.js up     (uses DIRECT_DATABASE_URL)
npm run db:migrate -- status # list applied / pending migrations

# Synchronization
npm run sync:backfill        # full paginated import, writes a sync_runs row
npm run sync:backfill -- --dry-run    # fetch + normalize, write nothing
npm run sync:reconcile       # scheduled scan + repair
npm run sync:retry-failed    # operator requeue: failed → pending
npm run sync:recover-stuck   # reset expired 'processing' leases
```

Every `sync:*` command must: validate config, open a `sync_runs` row, print a one-line summary
(`processed=… failed=… run_id=…`), and exit non-zero on `failed` or `partial`.

---

## 6. Configuration and environment

`src/config.ts` validates at startup and **fails fast** with a message naming the variable but never
its value. `.env.example` carries placeholders only.

| Variable | Required | Validation | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `development\|test\|production` | |
| `PORT` | yes | integer 1–65535 | |
| `NOTION_API_KEY` | yes | prefix `secret_` or `ntn_` | never logged |
| `NOTION_DATABASE_ID` | yes | 32-hex UUID, dashes optional | container; used to resolve data source |
| `NOTION_DATA_SOURCE_ID` | **conditional** | UUID | required when `GET /v1/databases/{id}` returns ≠1 `data_sources` |
| `NOTION_VERSION` | yes | literal `2026-03-11` | reject anything else; see §7.1 |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | yes in `production` | min length 32 | required for signature checks |
| `DATABASE_URL` | yes | `postgres://` / `postgresql://` | pooled; runtime |
| `DIRECT_DATABASE_URL` | no | URL | migrations only; not loaded by the server |
| `SYNC_TIMEZONE` | yes | valid IANA zone | interpretation of offset-less datetimes |
| `SYNC_RECONCILIATION_INTERVAL_MINUTES` | yes | 1–1440, default `30` | |
| `SYNC_MAX_ATTEMPTS` | yes | 1–20, default `8` | |
| `SYNC_PAGE_SIZE` | yes | 1–100, default `100` | Notion caps at 100 |
| `SYNC_SYNC_BODY_CONTENT` | yes | boolean, default `true` | A7 toggle for FR-005 |
| `SYNC_LEASE_SECONDS` | yes | 30–3600, default `300` | processing lease |
| `LOG_LEVEL` | no | pino level, default `info` | |

**Startup checks (in order):** env schema → Notion reachability (`GET /v1/users/me`) → data source
resolution + identity assertion → `SELECT 1` on the pool. Any failure exits `1` before binding a port.

**Data source resolution (DECISION, resolves PRD §19.1):**

```
GET /v1/databases/{NOTION_DATABASE_ID}   →  body.data_sources: [{id, name}]
  • exactly 1 entry  → use it
  • 0 entries        → fail: "database has no data sources / wrong ID"
  • >1 entries       → require NOTION_DATA_SOURCE_ID, else fail listing names only
Then assert resolved id === NOTION_DATA_SOURCE_ID (when provided). Mismatch = fail.
```

This runs at startup, on every backfill/reconcile, and on `data_source.schema_updated`.

---

## 7. Notion API contract

### 7.1 Versioning

`Notion-Version: 2026-03-11` is the **only** accepted value; the API's `notionVersion` parameter is
an enum with that single member. Verified against the live reference on 2026-10-21. `NOTION_VERSION`
is therefore not a free-form knob — a different value is a config error, not a runtime fallback.

### 7.2 Endpoints used

| Purpose | Call | Pagination |
|---|---|---|
| Resolve data source | `GET /v1/databases/{database_id}` | no (`data_sources` ≤ 100) |
| Query tasks | `POST /v1/data_sources/{data_source_id}/query` | `has_more` / `next_cursor` |
| Fetch one page | `GET /v1/pages/{page_id}` | no |
| Fetch page body | `GET /v1/blocks/{block_id}/children` | `has_more` / `next_cursor`, recursive |
| Read schema | `GET /v1/data_sources/{data_source_id}` | no |
| Config smoke test | `GET /v1/users/me` | no |

### 7.3 Pagination rules (non-negotiable)

1. Loop while `has_more === true`; pass the previous `next_cursor` as `start_cursor`.
2. Treat `next_cursor` as opaque — never parse, never synthesize, never compare.
3. Never stop because `results.length < page_size`. Notion explicitly may return fewer.
4. Guard against a pathological server: if the same `next_cursor` is returned twice, abort the run
   as `failed` rather than looping.
5. `page_size` is clamped to 1–100 and defaults to 100.
6. A run records the cursor at which it stopped, so an interrupted run is diagnosable.

### 7.4 Rate limits and retry interaction

Honour `Retry-After` on `429`. Retry `429`, `500`, `502`, `503`, `504`, `529` per §11. Do **not**
retry `400`, `401`, `403`, `404`, `406`, `409` — these are configuration or data problems and must
surface as `failed` with an actionable message (see §11.2).

---

## 8. Webhook contract

### 8.1 One-time subscription verification

Notion POSTs `{"verification_token": "secret_…"}` once. Then the owner pastes that token into the
Notion UI.

| Requirement | Rule |
|---|---|
| Detect | body is an object containing `verification_token` and no `type` |
| Respond | `200` immediately; **do not** enqueue it as an event |
| Persist | write the token to the log at `warn` level **redacted to last 4 chars**, and to `sync_runs`-style state so an operator can retrieve it; never echo it in the HTTP response |
| Onboarding | the operator copies it from logs into the Notion UI, then sets `NOTION_WEBHOOK_VERIFICATION_TOKEN` |

If `NOTION_WEBHOOK_VERIFICATION_TOKEN` is unset in production, the endpoint returns `503` for event
requests rather than accepting unverified data (fail closed).

### 8.2 Signature verification (exact algorithm)

Verified against the live Notion webhook reference, 2026-10-21.

1. Register a Fastify content-type parser for `application/json` scoped to the webhook route that
   yields the **raw `Buffer`**, unmodified.
2. Header: `X-Notion-Signature`, formatted `sha256=<64 lowercase hex>`.
3. Expected: `sha256=` + HMAC-SHA256(rawBodyBytes, key = `verification_token`).hex().
4. Compare with **constant-time** equality.
5. Prefer the SDK helper: `verifyWebhookSignature({ body: rawBody, signature, verificationToken })`
   (`@notionhq/client` ≥ 5.23.0), which does steps 3–4 correctly.
6. **Never** `JSON.parse` then `JSON.stringify` before verifying — re-serialization changes bytes and
   verification fails (this is the single most common implementation bug).
7. Tests sign fixtures with the SDK's `signWebhookPayload()` rather than hand-rolling HMAC.

### 8.3 Response codes — exact contract

| Situation | Status | Body | Enqueued? |
|---|---|---|---|
| Valid event, newly stored | `200` | `{"ok":true}` | yes |
| Valid event, `event_id` already present | `200` | `{"ok":true,"duplicate":true}` | no (idempotent success) |
| Verification handshake | `200` | `{"ok":true}` | no |
| Missing/unparseable `X-Notion-Signature` | `401` | `{"ok":false}` | no |
| Signature mismatch | `401` | `{"ok":false}` | no — log a security event with source IP only |
| Body not valid JSON | `400` | `{"ok":false}` | no |
| Envelope fails schema (missing `id`/`type`/`entity`) | `400` | `{"ok":false}` | no |
| Body exceeds 256 KiB | `413` | `{"ok":false}` | no |
| PostgreSQL unavailable / insert failed | `503` | `{"ok":false}` | no — **this is the whole point of INV-3** |
| Verification token unset (production) | `503` | `{"ok":false}` | no |

**Rule:** a `2xx` is a promise that the event is durable. Any other status tells Notion to retry.
Never return `200` from a `catch` block.

### 8.4 Envelope extraction

Required fields, all validated with zod before insert:

| Column | Source | Rule |
|---|---|---|
| `event_id` | `id` | non-empty string; primary key |
| `event_type` | `type` | non-empty string |
| `entity_type` | `entity.type` | optional |
| `entity_id` | `entity.id` | optional but required for page events |
| `event_timestamp` | `timestamp` | ISO-8601 → `TIMESTAMPTZ`; unparseable → `NULL` |
| `payload` | whole body | stored verbatim as `JSONB` |

Any additional envelope fields are preserved inside `payload` and ignored by V1.

---

## 9. Data model

### 9.1 Migration `0001_init.sql`

Refinements over PRD §9.4, each called out below the DDL.

```sql
CREATE SCHEMA IF NOT EXISTS notion_sync;

-- ---------------------------------------------------------------- tasks
CREATE TABLE notion_sync.notion_tasks (
    notion_page_id         TEXT PRIMARY KEY,
    title                  TEXT        NOT NULL DEFAULT '',
    status                 TEXT,
    list_name              TEXT,
    important              BOOLEAN     NOT NULL DEFAULT FALSE,
    in_my_day              BOOLEAN     NOT NULL DEFAULT FALSE,
    priority               TEXT,
    due_date               DATE,
    due_at                 TIMESTAMPTZ,
    reminder_at            TIMESTAMPTZ,
    user_archived          BOOLEAN     NOT NULL DEFAULT FALSE,   -- custom "Archived" property
    notion_is_archived     BOOLEAN     NOT NULL DEFAULT FALSE,   -- Notion page archived
    notion_in_trash        BOOLEAN     NOT NULL DEFAULT FALSE,   -- Notion trash / event tombstone
    is_in_source           BOOLEAN     NOT NULL DEFAULT TRUE,    -- belongs to configured data source
    page_url               TEXT,
    notion_created_time    TIMESTAMPTZ,
    notion_last_edited_time TIMESTAMPTZ,
    raw_properties         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    page_content_json      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT notion_page_id_not_blank CHECK (length(notion_page_id) > 0)
);

COMMENT ON COLUMN notion_sync.notion_tasks.user_archived IS
    'Custom task "Archived" checkbox. Independent of Notion page archival.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_is_archived IS
    'Notion page-level archived flag.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_in_trash IS
    'Notion trash state, or an event-derived tombstone. Never a hard delete.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_last_edited_time IS
    'Source last-edit time. NOT a completion timestamp.';

-- Active-task queries and stale-record sweeps
CREATE INDEX notion_tasks_in_scope_idx
    ON notion_sync.notion_tasks (is_in_source, notion_in_trash);
CREATE INDEX notion_tasks_synced_at_idx
    ON notion_sync.notion_tasks (synced_at);
CREATE INDEX notion_tasks_due_date_idx
    ON notion_sync.notion_tasks (due_date)
    WHERE due_date IS NOT NULL;

-- ---------------------------------------------------------------- inbox
CREATE TABLE notion_sync.sync_inbox (
    event_id        TEXT PRIMARY KEY,
    event_type      TEXT        NOT NULL,
    entity_type     TEXT,
    entity_id       TEXT,
    event_timestamp TIMESTAMPTZ,
    payload         JSONB       NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','processed','failed')),
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    processed_at    TIMESTAMPTZ,
    last_error      TEXT
);

-- Worker claim path: pending, due, ordered
CREATE INDEX sync_inbox_claim_idx
    ON notion_sync.sync_inbox (available_at, received_at)
    WHERE status = 'pending';
-- Lease-expiry recovery path
CREATE INDEX sync_inbox_lease_idx
    ON notion_sync.sync_inbox (locked_at)
    WHERE status = 'processing';
-- Operator triage of failures
CREATE INDEX sync_inbox_failed_idx
    ON notion_sync.sync_inbox (received_at DESC)
    WHERE status = 'failed';
-- "Is this page already queued?" checks
CREATE INDEX sync_inbox_entity_idx
    ON notion_sync.sync_inbox (entity_id)
    WHERE entity_id IS NOT NULL;

-- ---------------------------------------------------------------- runs
CREATE TABLE notion_sync.sync_runs (
    run_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_type          TEXT        NOT NULL
                      CHECK (run_type IN ('initial_backfill','reconciliation','manual_retry')),
    status            TEXT        NOT NULL
                      CHECK (status IN ('running','succeeded','partial','failed')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    records_processed INTEGER     NOT NULL DEFAULT 0 CHECK (records_processed >= 0),
    error_message     TEXT,
    cursor_reached    TEXT,
    CONSTRAINT sync_runs_finished_after_start
        CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX sync_runs_type_started_idx
    ON notion_sync.sync_runs (run_type, started_at DESC);

-- ---------------------------------------------------------------- migration ledger
CREATE TABLE notion_sync.schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT NOT NULL
);
```

**Deviations from PRD §9.4, and why**

| Change | Rationale |
|---|---|
| Added `CHECK` constraints on `status`, `run_type`, `attempts`, `title`-blank, finished-after-start | Makes illegal states unrepresentable at the DB layer, not just in TS |
| Split the single partial index into `claim` / `lease` / `failed` / `entity` indexes | The PRD's index covering `('pending','failed')` would make the claim query scan terminal rows. `failed` is operator-driven in this spec (§11.3), so it must not sit in the hot claim path |
| Added `cursor_reached` to `sync_runs` | PRD requires partial failures to be diagnosable; the stopped cursor is the only way to resume an interrupted import |
| Added `schema_migrations` | Required by the runner in A10 |
| Added three task indexes | `is_in_source + notion_in_trash` is the "show me live tasks" predicate; `synced_at` drives staleness reporting; `due_date` is the foreseeable first query |
| Added column `COMMENT`s | The trash-vs-custom-archived distinction is the most likely thing a future engineer gets wrong |

### 9.2 Upsert — the canonical write

```sql
INSERT INTO notion_sync.notion_tasks (
    notion_page_id, title, status, list_name, important, in_my_day, priority,
    due_date, due_at, reminder_at, user_archived, notion_is_archived,
    notion_in_trash, is_in_source, page_url, notion_created_time,
    notion_last_edited_time, raw_properties, page_content_json, synced_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    $8, $9, $10, $11, $12,
    $13, $14, $15, $16,
    $17, $18::jsonb, $19::jsonb, NOW()
)
ON CONFLICT (notion_page_id) DO UPDATE SET
    title                   = EXCLUDED.title,
    status                  = EXCLUDED.status,
    list_name               = EXCLUDED.list_name,
    important               = EXCLUDED.important,
    in_my_day               = EXCLUDED.in_my_day,
    priority                = EXCLUDED.priority,
    due_date                = EXCLUDED.due_date,
    due_at                  = EXCLUDED.due_at,
    reminder_at             = EXCLUDED.reminder_at,
    user_archived           = EXCLUDED.user_archived,
    notion_is_archived      = EXCLUDED.notion_is_archived,
    notion_in_trash         = EXCLUDED.notion_in_trash,
    is_in_source            = EXCLUDED.is_in_source,
    page_url                = EXCLUDED.page_url,
    notion_created_time     = EXCLUDED.notion_created_time,
    notion_last_edited_time = EXCLUDED.notion_last_edited_time,
    raw_properties          = EXCLUDED.raw_properties,
    page_content_json       = EXCLUDED.page_content_json,
    synced_at               = NOW()
WHERE notion_sync.notion_tasks.notion_last_edited_time IS NULL
   OR EXCLUDED.notion_last_edited_time IS NULL
   OR EXCLUDED.notion_last_edited_time >= notion_sync.notion_tasks.notion_last_edited_time;
```

The `WHERE` clause is **INV-4**. `>=` (not `>`) so a genuine re-apply of the same version is still
idempotent and refreshes `synced_at`. A skipped write is not an error — the worker still marks the
inbox row `processed`, because the newer state is already present.

### 9.3 Transaction boundary

Per inbox event, exactly one transaction:

```sql
BEGIN;
  -- 1. upsert task (statement in §9.2)
  -- 2. presence/position bookkeeping for content blocks (if enabled)
  UPDATE notion_sync.sync_inbox
     SET status = 'processed', processed_at = NOW(), locked_at = NULL, last_error = NULL
   WHERE event_id = $1 AND status = 'processing';
COMMIT;
```

If either statement throws, `ROLLBACK` and the inbox row keeps `status='processing'` until lease
recovery (§11.3) — never a half-applied task.

---

## 10. Property normalization

### 10.1 Mapping layer

Property **names** are configuration, not constants (`sync/property-map.ts`), because PRD §19.3
leaves them unconfirmed. Resolution order: env override → file default. At startup, the resolved map
is validated against the live schema: every mapped name must exist and have the expected property
type. A missing/renamed property **fails startup with the actual vs expected names** — it does not
silently produce NULLs forever.

### 10.2 Rules

| Notion value | Normalized to | Rule |
|---|---|---|
| `title` / `rich_text` | `TEXT` | `props.map(p => p.plain_text).join('')`, trimmed of trailing whitespace only. Empty array → `''` for title, `NULL` for optional text |
| `status` | `status.name` | Displayed label; never enumerated/validated against a fixed list |
| `select` | `name` or `NULL` | |
| `multi_select` | **`raw_properties` only** | Never flattened into a `TEXT` column. If mapped to a TEXT column, log a mapping warning and write `NULL` |
| `checkbox` | `BOOLEAN` | `true`/`false`; property absent → documented default (`FALSE`) |
| `date` | see §10.3 | |
| `number` | `raw_properties` only in V1 | No typed column |
| `relation`, `people`, `formula`, `rollup`, `url`, `files`, `unique_id`, `verification`, unknown | `raw_properties` only | Preserve; do not fail the page |
| Unknown property type | `raw_properties` + one sanitized `warn` per `(page, property, type)` per run | Never throws at page level |

### 10.3 Date normalization (the part that silently corrupts data)

Notion `date` = `{ start, end, time_zone }`; all three are always present, `time_zone` may be `null`.

```
if value is null or start is null            → due_date = NULL, due_at = NULL
else if start matches /^\d{4}-\d{2}-\d{2}$/  → date-only:
        due_date = start (as DATE), due_at = NULL
else                                          → time-bearing:
        due_date = NULL
        due_at   = start interpreted in (value.time_zone ?? SYNC_TIMEZONE) → TIMESTAMPTZ
```

- `end` is ignored for the typed columns; it survives in `raw_properties`.
- Never call `new Date('2026-10-21')` for a date-only value — it parses as UTC midnight and shifts
  the day for negative-offset zones. Parse `YYYY-MM-DD` as three integers.
- `reminder_at` uses the same rule but is expected to be time-bearing; a date-only reminder becomes
  `NULL` + a `warn`.
- Acceptance test AT-06 asserts no unintended day shift across at least one positive and one
  negative offset.

### 10.4 Missing vs null vs empty

Three states, kept distinct:

| Source state | Typed column | `raw_properties` |
|---|---|---|
| Property key absent | `NULL` (or `FALSE` for boolean) | key absent |
| Property present, value empty (`select: null`, `rich_text: []`) | `NULL` (or `''` for title) | key present with empty value |
| Property present with `checkbox: false` | `FALSE` | `false` |

A boolean column must never be `NULL`. This is why `important`/`in_my_day`/`user_archived` are
`NOT NULL DEFAULT FALSE`.

### 10.5 Source membership (`is_in_source`)

`is_in_source = true` only when the page's parent is one of the resolved data sources. Determined
from the **fetched page object**, never from a webhook payload. When a page moves out of scope,
set `is_in_source = false` and keep every other value — the row is not deleted (INV-5).

---

## 11. Synchronization semantics

### 11.1 State machine

```
      ┌──────────┐  claim   ┌────────────┐  success   ┌───────────┐
      │ pending  │ ───────▶ │ processing │ ─────────▶ │ processed │
      └──────────┘          └────────────┘            └───────────┘
           ▲                      │
           │  retryable           │ terminal, or attempts >= max
           │  (available_at set)  ▼
           └────────────────── ┌────────┐
                                │ failed │──(operator: sync:retry-failed)──▶ pending
                                └────────┘

  lease expired (locked_at < now() - SYNC_LEASE_SECONDS): processing → pending
```

`processed` and `failed` are terminal until an operator acts. Nothing auto-retries a `failed` row.

### 11.2 Event → behaviour matrix

Expands PRD §7.3 with the concrete action this service takes.

| `event_type` | Action |
|---|---|
| `page.created` | Fetch page. If in source → upsert. Else record `is_in_source=false` (or ignore if never seen) |
| `page.properties_updated` | Fetch page → upsert full normalized state |
| `page.content_updated` | Fetch page + blocks (if A7) → upsert properties **and** `page_content_json` |
| `page.moved` | Fetch page → re-evaluate `is_in_source`, update |
| `page.deleted` | Mark `notion_in_trash = true`; keep the row; do **not** re-fetch (404 expected) |
| `page.undeleted` | Fetch page → clear `notion_in_trash`, restore normalized state |
| `page.locked` / `page.unlocked` | No V1 column. Store event, mark `processed`, write nothing else |
| `data_source.content_updated` | Scoped reconciliation if the page is identifiable; else enqueue one `manual_retry`-style reconcile run |
| `data_source.schema_updated` | Re-read schema, diff property names/types, log a report, update the in-memory map. **Never** drop columns or values |
| `database.*` (legacy) | Accept, log as deprecated, treat as no-op |
| Unknown `event_type` | Store, mark `processed`, log `info` once — do not let a new Notion event type poison the queue |
| `comment.*`, `user.*` | Out of scope → store, mark `processed`, no task write |

**Aggregation/ordering note:** `page.content_updated` is batched by Notion and delivered after a
short delay, and deliveries are not ordered. This is exactly why INV-2 exists — the payload carries
only metadata, so its staleness cannot matter.

### 11.3 Worker loop

```sql
-- Claim exactly one due event, atomically, safe under N concurrent workers
WITH claimed AS (
    SELECT event_id
      FROM notion_sync.sync_inbox
     WHERE status = 'pending'
       AND available_at <= NOW()
     ORDER BY available_at, received_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE notion_sync.sync_inbox i
   SET status     = 'processing',
       locked_at  = NOW(),
       attempts   = i.attempts + 1
  FROM claimed c
 WHERE i.event_id = c.event_id
RETURNING i.*;
```

- `attempts` increments **on claim**, not on failure, so a worker that crashes mid-flight still
  consumes an attempt (prevents an infinite crash loop on one poisoned event).
- Loop: claim → process → settle → sleep if the claim returned nothing (exponential idle backoff
  1s → 30s).
- Graceful shutdown: stop claiming, let the in-flight event finish (bounded by a 30s timeout), exit.
- One event failing must never stop the loop. Errors are classified (§11.4) and settled.

**Lease recovery** (`sync:recover-stuck`, also run at the top of each worker cycle):

```sql
UPDATE notion_sync.sync_inbox
   SET status = 'pending', locked_at = NULL, available_at = NOW()
 WHERE status = 'processing'
   AND locked_at < NOW() - ($1 || ' seconds')::interval;
```

**Operator requeue** (`sync:retry-failed`): `failed → pending`, `attempts = 0`, `available_at = NOW()`,
`last_error` preserved until the next attempt overwrites it. Refuses to run without an explicit
`--yes` when `failed` count exceeds 100.

### 11.4 Error classification and classification table

| Class | Examples | Settle as |
|---|---|---|
| `RETRYABLE` | `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, Notion `429/500/502/503/504/529`, pg `08006/08003/08001/57P01/40001/40P01`, pg statement timeout | `pending`, `available_at = now() + backoff` |
| `PERMANENT` | Notion `400`, `401`, `403`, `404`, `406`, `409`; payload fails zod; page genuinely gone | `failed` + sanitized `last_error` |
| `EXHAUSTED` | any `RETRYABLE` with `attempts >= SYNC_MAX_ATTEMPTS` | `failed` + `last_error = "exhausted after N attempts: …"` |

`404` on `page.deleted` is **expected**, not an error — that path tombstones instead of failing.

### 11.5 Backoff (exact formula)

```ts
// sync/retry-policy.ts
const BASE_MS = 2_000;
const MAX_MS  = 15 * 60_000;              // 15 minutes

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const capped = Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS);
  const jittered = Math.random() * capped;        // full jitter
  return Math.max(jittered, retryAfterMs ?? 0);   // honour Retry-After
}
```

- Full jitter (`random(0, capped)`) rather than ±10%, because the failure mode here is a thundering
  herd after a Notion outage, not steady-state pacing.
- `Retry-After` is parsed as both delta-seconds and HTTP-date; if both are present, take the larger.
- With `SYNC_MAX_ATTEMPTS=8`, worst-case total delay ≈ 64 minutes before `failed`.

### 11.6 Reconciliation algorithm

Runs every `SYNC_RECONCILIATION_INTERVAL_MINUTES`, writes a `reconciliation` `sync_runs` row.

```
1. Resolve + assert data source.
2. seen = empty Set<page_id>; cursor = undefined; complete = false
3. loop:
     page = POST /data_sources/{id}/query {start_cursor: cursor, page_size: SYNC_PAGE_SIZE}
     for each result:
         seen.add(id)
         try  → fetch full page → normalize → upsert        (records_processed++)
         catch→ record per-page failure                     (page_failures++)
     cursor = page.next_cursor
     if !page.has_more → complete = true; break
4. If !complete OR page_failures > 0:
       status = 'partial'           # escalate to 'failed' if nothing succeeded
       DO NOT tombstone anything. STOP.
   else:
       rows = SELECT notion_page_id FROM notion_tasks
              WHERE is_in_source AND notion_page_id <> ALL($seen)
       # Live API absence + a complete scan is the only evidence allowed.
       UPDATE notion_tasks SET is_in_source = FALSE, synced_at = NOW()
        WHERE notion_page_id = ANY($rows)
       → record count as 'flagged_out_of_scope'; status = 'succeeded'
5. NEVER physically DELETE. NEVER set notion_in_trash from absence.
```

The asymmetry in step 4 is the whole safety story: **a partial scan proves nothing, so it mutates
nothing.** PRD risk "Partial scan interpreted as deletion" is closed here, and AT-16/§16 test it
explicitly.

---

## 12. Interfaces

| Route / command | Auth | Success | Failure |
|---|---|---|---|
| `GET /health` | none | `200 {"status":"ok","uptime_s":n}` — process only, no DB | — |
| `GET /ready` | none | `200 {"ready":true}` | `503 {"ready":false,"reason":"db"\|"config"}` — reason is a fixed enum, never a message |
| `POST /webhooks/notion` | signature | see §8.3 | see §8.3 |
| `npm run db:migrate` | operator/CI | exit `0` | exit `1`, prints pending version |
| `npm run sync:backfill` | operator/CI | exit `0` (`succeeded`) | exit `1` (`partial`/`failed`) |
| `npm run sync:reconcile` | operator/scheduler | exit `0` | exit `1` |
| `npm run sync:retry-failed` | operator | exit `0`, prints count | exit `1` |
| `npm run sync:recover-stuck` | operator/scheduler | exit `0`, prints count | exit `1` |

`/health` and `/ready` never expose versions of dependencies, connection strings, hostnames, table
counts, or error messages.

---

## 13. Observability

### 13.1 Structured log events (pino, JSON)

Every line carries `service`, `env`, `event`, `event_id?`, `page_id?`, `run_id?`, `attempt?`,
`duration_ms?`.

| `event` | Level | Extra fields |
|---|---|---|
| `webhook.received` | `info` | `event_type` |
| `webhook.duplicate` | `info` | `event_id` |
| `webhook.rejected` | `warn` | `reason` (`signature`\|`schema`\|`size`), `remote_ip` |
| `inbox.enqueued` | `info` | `event_id` |
| `event.claimed` | `debug` | `attempt` |
| `event.processed` | `info` | `duration_ms`, `upsert_changed` (bool) |
| `event.skipped_stale` | `debug` | `page_id`, both timestamps |
| `event.retry_scheduled` | `warn` | `attempt`, `delay_ms`, `error_class` |
| `event.failed` | `error` | `error_class`, `last_error` (sanitized) |
| `run.started` / `run.finished` | `info` | `run_type`, `status`, `records_processed` |
| `schema.changed` | `warn` | `added[]`, `removed[]`, `retyped[]` (names only) |
| `security.signature_invalid` | `error` | `remote_ip` only |

### 13.2 Redaction

`pino` `redact` paths must cover at minimum: `*.authorization`, `*.Authorization`,
`req.headers.authorization`, `*.verification_token`, `*.cookie`, `*.NOTION_API_KEY`,
`*.DATABASE_URL`, `*.password`. Plus an explicit `sanitizeError()` that strips anything matching
`/postgres(ql)?:\/\/[^\s]+/` and `/secret_[A-Za-z0-9]+/` from any message before it reaches
`last_error` or a log line. AT-17 tests this by asserting the redaction patterns exist *and* by
scanning a captured log fixture for known-planted fake secrets.

### 13.3 Operator queries (document these in the runbook)

```sql
-- backlog and health
SELECT status, count(*), min(received_at), max(received_at)
  FROM notion_sync.sync_inbox GROUP BY status ORDER BY status;

-- what is failing and why
SELECT event_id, event_type, entity_id, attempts, last_error, received_at
  FROM notion_sync.sync_inbox
 WHERE status = 'failed' ORDER BY received_at DESC LIMIT 50;

-- replica freshness
SELECT count(*) FILTER (WHERE synced_at < NOW() - INTERVAL '30 minutes') AS stale,
       count(*) FILTER (WHERE is_in_source AND NOT notion_in_trash)     AS live
  FROM notion_sync.notion_tasks;

-- recent runs
SELECT run_id, run_type, status, started_at, finished_at, records_processed, error_message
  FROM notion_sync.sync_runs ORDER BY started_at DESC LIMIT 20;
```

---

## 14. Security requirements

1. Secrets live in env/secrets manager only. `.env` is git-ignored (already true). `.env.example`
   contains empty placeholders and no real values.
2. Signature verification is mandatory in production (§8.2). Fail closed when the token is missing.
3. The DB role for runtime traffic is **not** a superuser, is scoped to `notion_sync`, and cannot
   `DROP` the schema. Migrations may use a separate role via `DIRECT_DATABASE_URL`.
4. All runtime DB connections use TLS (`ssl: { rejectUnauthorized: true }`) where the provider
   requires it; the Neon pooled URL for the app, the direct URL for migrations.
5. All SQL is parameterized. There is no code path that builds SQL by string interpolation —
   including dynamic `IN (...)` lists (use `= ANY($1::text[])`).
6. Webhook body is size-capped (256 KiB) before parsing.
7. No task body content, no tokens, no connection strings in logs or HTTP bodies (§13.2).
8. Backfill/reconcile CLIs are operator-only: they run with ambient credentials and expose no
   network listener. If they are later wrapped in HTTP, they need auth first.
9. Credential rotation: recreating the Notion webhook subscription issues a new verification token;
   the runbook must state that the deployed secret is updated **before** the old subscription is
   deleted.
10. PostgreSQL now holds a copy of personal task data — backups, retention, and access reviews are
    in scope of "done", not "later" (see §19.4).

---

## 15. Code style

Real snippet; this is the shape every module should look like.

```ts
// sync/task-sync.ts
import type { Pool } from 'pg';
import { normalizePage, type NotionTaskRecord } from './normalize.js';
import { upsertTask } from '../db/tasks-repo.js';
import { fetchPage, fetchPageBlocks } from './notion-client.js';

export interface SyncOutcome {
  readonly pageId: string;
  readonly changed: boolean;
}

/**
 * The single core write path. Backfill, worker and reconciliation all call this,
 * which is how INV-2 is enforced structurally rather than by convention.
 */
export async function syncPage(
  pool: Pool,
  pageId: string,
  options: { readonly includeBody: boolean },
): Promise<SyncOutcome> {
  const page = await fetchPage(pageId);
  const blocks = options.includeBody ? await fetchPageBlocks(pageId) : [];

  const record: NotionTaskRecord = normalizePage(page, blocks);
  const changed = await upsertTask(pool, record);

  return { pageId: record.pageId, changed };
}
```

**Conventions**

- `interface` for object shapes, `type` for unions and aliases. No `any`; `unknown` at boundaries +
  zod to narrow.
- Exported functions have explicit return types. No default exports.
- Relative imports use the `.js` extension (ESM).
- All dates crossing a boundary are `Date` in TS and `TIMESTAMPTZ`/`DATE` in SQL — never strings.
- Errors: throw a `SyncError` carrying `{ class: 'RETRYABLE' | 'PERMANENT', cause }`; never throw raw
  strings, never swallow a `catch` without classifying.
- Naming: DB columns `snake_case`, TS properties `camelCase`, files `kebab-case`, types `PascalCase`.
- No `console.*` anywhere except `scripts/` CLI output.

---

## 16. Testing strategy

Framework: **vitest**. Levels: unit (no I/O, ms), integration (real Postgres, seconds), e2e (real
Notion + DB, minutes, manually invoked).

### 16.1 Unit — `tests/unit/`

| ID | Covers |
|---|---|
| U-01…U-10 | `normalize`: title concatenation, status label, select, checkbox true/false/absent, multi-select passthrough, date-only, datetime with zone, datetime without zone (uses `SYNC_TIMEZONE`), unknown type does not throw |
| U-11…U-13 | Date edge cases: `2026-10-21` never shifts day; `+14:00` and `-11:00` inputs; date-only reminder → `NULL` + warn |
| U-14 | Missing vs `null` vs empty distinction (§10.4) |
| U-15…U-18 | Signature: valid, tampered body, wrong token, malformed header (`sha256=` prefix, uppercase hex rejected) |
| U-19…U-21 | Envelope zod schema: missing `id`, missing `type`, `timestamp` unparseable |
| U-22…U-24 | `backoffMs`: monotonic cap, full jitter in `[0, capped]`, `Retry-After` floor wins |
| U-25…U-27 | `classify()`: 429→retryable, 403→permanent, pg `57P01`→retryable |
| U-28 | `is_in_source` derivation for parent = data source vs other page |
| U-29 | Schema diff report: added / removed / retyped |

### 16.2 Integration — `tests/integration/` (real Postgres, `TEST_DATABASE_URL`)

Each test runs in a transaction or against a freshly truncated `notion_sync` schema.

| ID | Asserts | Invariant |
|---|---|---|
| I-01 | Migrations apply from empty DB; `status` reports all applied; re-running is a no-op | — |
| I-02 | Upserting the same page twice yields 1 row | INV-1 |
| I-03 | Upserting an **older** `notion_last_edited_time` does not overwrite | INV-4 |
| I-04 | Upserting an equal timestamp refreshes `synced_at` | INV-4 |
| I-05 | Inserting a duplicate `event_id` affects 0 rows (not an error) | INV-1 |
| I-06 | Upsert + inbox settle in one transaction: forced failure leaves inbox `processing` and task unchanged | INV-6 |
| I-07 | `FOR UPDATE SKIP LOCKED` claim: two concurrent claims return two **different** events | INV-1 |
| I-08 | Lease expiry: `locked_at` older than lease → `recover-stuck` returns it to `pending` | — |
| I-09 | `attempts` increments on claim; `processed` clears `locked_at` | — |
| I-10 | Pagination: 3-page fixture (sizes 100/40/7, short final page) is fully traversed | — |
| I-11 | Pagination guard: repeated `next_cursor` aborts as `failed` | — |
| I-12 | Nested block children paginate to full depth | — |
| I-13 | `CHECK` constraints reject illegal `status`/`run_type`/negative `attempts` | — |
| I-14 | Reconcile with a complete scan flags an out-of-scope page `is_in_source=false` | INV-5 |
| I-15 | Reconcile with a **failed** scan flags **nothing** | INV-5 |
| I-16 | No code path issues `DELETE FROM notion_tasks` (static check: repo has no such statement) | INV-5 |

### 16.3 End-to-end — `tests/e2e/` (PRD AT-01…AT-17)

| AT | Scenario | Passing assertion |
|---|---|---|
| AT-01 | Backfill existing tasks | `count(notion_tasks) == count(Notion pages)`, and every page ID present |
| AT-02 | Backfill rerun | Row count unchanged; `max(synced_at)` advanced |
| AT-03 | Create task in Notion | Row appears; `title` matches; `is_in_source = true` |
| AT-04 | Edit title/status/priority | Row updated; `list_name`, `due_date`, `important` unchanged |
| AT-05 | Toggle `In My Day` | `in_my_day` flipped; `list_name` unchanged |
| AT-06 | Change due date | `due_date` matches UI date exactly, no day shift |
| AT-07 | Complete then reopen | `status` follows Notion; no completion-timestamp column invented |
| AT-08 | Toggle custom `Archived` | `user_archived` flips; `notion_is_archived` untouched |
| AT-09 | Delete then restore page | `notion_in_trash` true→false; row never deleted |
| AT-10 | Replay identical webhook | `sync_inbox` count +0; `notion_tasks` count +0; both responses `200` |
| AT-11 | Invalid signature | `401`; `sync_inbox` count +0; `security.signature_invalid` logged |
| AT-12 | Stop Postgres, send webhook | Response is `503`, **not** `2xx`; after restart, retry/reconcile repairs |
| AT-13 | Force 429 with `Retry-After: 2` | Next attempt ≥ 2 s later; event eventually `processed` |
| AT-14 | Kill worker mid-event | Restarted worker recovers the event and completes it exactly once |
| AT-15 | Add a new Notion property | Sync continues; new property only in `raw_properties`; no column changed |
| AT-16 | Delete a task's row from DB, wait for reconcile | Row restored by reconcile (missed-event repair) |
| AT-17 | Secret scan | No secret in git, source, fixtures, or captured log output |

### 16.4 Test hygiene

- Fixtures must never target the production Notion database. `NODE_ENV=test` + an explicit
  `E2E_CONFIRM=yes` gate, and the suite refuses to run if `NOTION_DATA_SOURCE_ID` equals the
  production ID recorded in the runbook.
- Any task created by a test is deleted at the end **and** its final DB state asserted (PRD §16.3).
- Integration/e2e suites **skip with a visible warning** when their env vars are absent — never a
  silent green.
- Coverage target: `sync/normalize.ts`, `sync/retry-policy.ts`, and `db/inbox-repo.ts` ≥ 90 %
  line + branch. These three hold most of the correctness risk.

---

## 17. Boundaries

### Always do
- Verify the webhook signature before parsing or acting on a payload.
- Commit the inbox row before returning `2xx`.
- Fetch the current page from Notion before writing a task row.
- Use parameterized SQL and a single transaction per event.
- Classify every error before settling an inbox row.
- Write a `sync_runs` row for every backfill and reconciliation, including failures.
- Run `npm run typecheck && npm test` before every commit.
- Redact secrets in logs and `last_error`.

### Ask first
- Adding any runtime dependency.
- Adding, renaming, retyping, or dropping a column (new numbered migration + review).
- Changing the property map.
- Enabling hard deletion of any kind.
- Changing retention for `sync_inbox` payloads.
- Exposing any new HTTP route.
- Adding analytics/derived columns to `notion_tasks`.

### Never do
- Write to Notion (no `POST`/`PATCH`/`DELETE` on Notion resources in V1).
- Delete rows from `notion_tasks` automatically.
- Tombstone a task because it was absent from a failed or partial scan.
- `JSON.parse`/`stringify` the webhook body before signature verification.
- Return `2xx` from a webhook path that did not durably store the event.
- Log a request body, a token, a connection string, or full page content.
- Retry a `401`/`403`/`404`/malformed-payload error indefinitely.
- Commit a real credential, workspace ID, or database URL.

---

## 18. Success criteria

Testable, not aspirational. V1 is accepted when **all** of these pass.

| ID | Criterion | How it is proven |
|---|---|---|
| SC-1 | Backfill imports every accessible page | AT-01: DB count == Notion count |
| SC-2 | Backfill is re-runnable without duplicates | AT-02 + I-02 |
| SC-3 | A Notion change reaches PostgreSQL within 5 min under normal conditions | AT-03/04/05/06 timed |
| SC-4 | Duplicate deliveries create no duplicate inbox or task rows | AT-10 + I-05 |
| SC-5 | Postgres outage produces `503`, never a false `200` | AT-12 |
| SC-6 | Workers resume pending work after a restart | AT-14 + I-08 |
| SC-7 | Reconciliation repairs missed updates; a partial scan deletes nothing | AT-16 + I-14/I-15 |
| SC-8 | Zero secrets in repo or logs | AT-17 |
| SC-9 | All acceptance tests AT-01…AT-17 pass | suite green |
| SC-10 | Every module in §2.3 respects its import direction | lint rule (`eslint-plugin-import` zones) |
| SC-11 | No `DELETE FROM notion_tasks` exists in the codebase | I-16 / grep gate in CI |
| SC-12 | `/ready` returns `503` within 1 s when Postgres is down, without leaking details | manual + test |
| SC-13 | A failing event is diagnosable from one SQL query (§13.3) | runbook walkthrough |
| SC-14 | A second developer can deploy and recover using the runbook only | PRD Milestone 5 exit criteria |

---

## 19. Open questions / decisions required

Blocking items first. Each maps to a PRD §19 decision.

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| Q1 | Actual `NOTION_DATABASE_ID`, and does it expose exactly one data source? | Startup, all runs | **blocks implementation** — no safe default |
| Q2 | Exact Notion property names for Status, List, Important, In My Day, Priority, Due Date, Reminder, custom Archived | Property map (§10.1) | **blocks startup validation** |
| Q3 | Confirm A1–A5 property *types* (is List really `select`?) | `list_name`, `priority` mapping | assume as written; may need `multi_select` handling |
| Q4 | Body/block sync in V1 — yes or no? | A7, `SYNC_SYNC_BODY_CONTENT` | `true` |
| Q5 | Hosting platform for the HTTPS webhook endpoint + worker | §8, deployment | **blocks deployment** |
| Q6 | Inbox payload retention window (days) | FR-016, §14.10 | keep indefinitely until decided; document that it is unbounded |
| Q7 | Postgres backup/restore expectation (frequency, RPO/RTO) | SC-14 | document "no backup configured" as a known gap |
| Q8 | Maximum acceptable sync lag (is 5 min right?) and reconcile interval (30 min?) | SC-3, §11.6 | 5 min / 30 min |
| Q9 | Is a dedicated staging Notion task database available? | §16.4 e2e safety | e2e tests blocked; unit+integration still possible |
| Q10 | Should `priority` be a typed `status` extraction instead of `select`? | A2 | `select` |
| Q11 | Worker topology: one process doing HTTP+worker, or separate deployables? | §11.3, §4 | separate processes from the same image, different entrypoints |

**Rule:** an unanswered item blocks only the feature that depends on it. Nothing here may be
fabricated — no invented token, ID, permission, host URL, or test result.

---

## 20. Definition of done

Traceable to PRD §20, with the engineering additions this spec introduces.

- [ ] Approved: this document, with Q1–Q11 resolved or explicitly deferred
- [ ] `0001_init.sql` applies cleanly to an empty DB and re-applies as a no-op (I-01)
- [ ] Property map validated against the live schema at startup; mismatch fails loudly
- [ ] Backfill paginates to completion and records `cursor_reached` on interruption
- [ ] INV-1…INV-7 each have at least one passing test
- [ ] Webhook: signature verified on raw bytes, `2xx` only after commit (AT-11, AT-12)
- [ ] Worker: `SKIP LOCKED` claim, lease recovery, bounded retry with jitter (I-07/I-08/AT-13/AT-14)
- [ ] Reconciliation: partial scans mutate nothing (I-15, AT-16)
- [ ] Archive / trash / restore / move all distinguished; no hard deletes (AT-08/AT-09)
- [ ] `/health` and `/ready` implemented and leak-free (SC-12)
- [ ] Structured logs with redaction; AT-17 green
- [ ] Operator queries from §13.3 documented in the runbook
- [ ] Runbook covers: deploy, migrate, re-run backfill, recreate webhook, rotate token, requeue
      failures, recover stuck leases, restore from backup
- [ ] `npm run typecheck && npm run lint && npm test` green in CI
- [ ] No analytics, reporting, history, or snapshot code in V1

---

## 21. References

Verified against live documentation on **2026-10-21**. Re-verify before release — Notion evolves.

1. API introduction, conventions, pagination — <https://developers.notion.com/reference/intro>
2. Retrieve a database (returns `data_sources[]`) — <https://developers.notion.com/reference/retrieve-a-database>
3. Query a data source — <https://developers.notion.com/reference/query-a-data-source>
4. Webhooks, subscription verification, `X-Notion-Signature` — <https://developers.notion.com/reference/webhooks>
5. Event types, aggregation, ordering, retries — <https://developers.notion.com/reference/webhooks-events-delivery>
6. Request limits / `Retry-After` — <https://developers.notion.com/reference/request-limits>
7. Status codes and error codes — <https://developers.notion.com/reference/status-codes>
8. `@notionhq/client` SDK (`verifyWebhookSignature`, ≥ 5.23.0) — <https://github.com/makenotion/notion-sdk-js>
9. Neon: connecting — <https://neon.com/docs/get-started/connect-neon>
10. Neon: connection pooling — <https://neon.com/docs/connect/connection-pooling>

**Facts pinned from those sources:**

- `Notion-Version` accepts only `2026-03-11` today (enum with one member).
- `page_size` default and maximum are both `100`; responses may return fewer than requested.
- Signature header format is `sha256=<64 lowercase hex>`, HMAC-SHA256 over the **raw** body, keyed by
  the `verification_token`.
- `page.content_updated` is aggregated and delayed — not a per-keystroke signal.
- `data_source.schema_updated` supersedes `database.schema_updated` (deprecated after `2022-06-28`).
- Error codes to classify: `400 invalid_json|missing_version|validation_error|invalid_request`,
  `401 unauthorized`, `403 restricted_resource`, `404 object_not_found`, `406 row_limit_exceeded`,
  `409 conflict_error`, `429 rate_limited`, `500`, `503`, `504`, `529 service_overload`.
