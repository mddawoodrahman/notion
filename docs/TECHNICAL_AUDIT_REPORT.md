# Technical Audit Report — Notion → PostgreSQL Task Sync

| Field | Value |
|---|---|
| Report date | 2026-10-21 |
| Repository | `D:\Notion` (`notion-tasks-pg-sync@0.1.0`) |
| Commit audited | `7ab4010` (`main`, working tree clean at audit start) |
| Environment | Windows, Node `v24.21.0`, npm `11.19.0`, vitest `3.2.7`, `@notionhq/client@5.27.1`, `pg@8.23.1`, `fastify@5.12.7`, `embedded-postgres@18.4.0-beta.17` |
| Audit type | Read-only static review + executed safe checks (typecheck, build, full test suite ×5, `npm audit`, argv probe in temp dir) |
| Secrets available | None. `.env` exists but is 0 bytes; `DATABASE_URL`, `NOTION_TOKEN`, `NOTION_WEBHOOK_VERIFICATION_TOKEN`, `NOTION_DATA_SOURCE_ID`, `NOTION_DATABASE_ID` were all unset in the shell. Live integration is therefore **unverified**. |
| Files modified by this audit | None in application code/config. This report is the only new repository file. A throwaway probe file was created outside the repo (`%TEMP%\opencode\argv-probe.ts`). `npm run build` emitted gitignored `dist/`. |
| Verification tooling limit | Context7 (`resolve-library-id` / `query-docs`) returned `Invalid API key`; Notion behavior was verified against the official docs page fetched over HTTP instead. |

---

## 1. Executive Summary

The project is a genuinely well-built V1: clean layering (`src/` config+server, `routes/` HTTP, `sync/` Notion logic, `db/` persistence, `scripts/` operations), parameterized SQL everywhere, real-PostgreSQL integration tests via `embedded-postgres`, an inbox table with `FOR UPDATE SKIP LOCKED` claiming, tombstones instead of deletes, and an idempotent checksum-guarded migration runner. Typecheck and build pass, and the described architecture matches the code.

It is **not** yet safe to declare "verified": three P1 correctness defects silently corrupt derived state in configurations the project itself ships, and the badge claim of a green suite is not reproducible.

Highest-impact findings:

1. **`is_in_source` is computed against the wrong identifier in the webhook worker** (BUG-001). The `.env.example` ships `NOTION_DATA_SOURCE_ID=` empty and config treats it as optional, but the worker passes that raw value to `normalizePage`. Under the data-source API model (`NOTION_VERSION=2026-03-11`), a page's parent is a `data_source_id`, so every webhook-synced page is stored with `is_in_source = false` — while backfill/reconcile store the same page as `true`. Downstream consumers filtering on that flag see tasks flip in and out of scope.
2. **Silent truncation of large scans can mass-flag live tasks as deleted** (BUG-002). Notion caps data-source queries at 10,000 results and signals it with `request_status.incomplete_reason = query_result_limit_reached` while setting `has_more = false`. The client wrapper drops that field, and reconciliation treats loop exit as a complete scan before calling `markTasksOutOfSource`. On a >10k-row data source the INV-5 protection is bypassed and everything outside the first 10,000 rows is flagged out-of-scope. Backfill has the milder version of the same defect: it reports `succeeded` on an incomplete dataset.
3. **Transient network/timeout failures are classified PERMANENT and never retried** (BUG-003). `executeWithRetry` only retries errors carrying an HTTP status; the SDK's `RequestTimeoutError` (60 s default) and raw fetch errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`) have no `status`, so they are wrapped, judged non-retryable and thrown on the first attempt. The webhook event is then settled as `failed` permanently. The SDK itself will not cover this either: its internal `canRetry` returns `false` for anything that is not an `APIResponseError`, and no retry happens for timeouts.
4. **Stored page content is silently wiped** (BUG-004). `normalizePage` defaults `page_content_json` to `[]` and the upsert always overwrites the column, while backfill/reconcile never fetch blocks — and the worker writes `[]` whenever a block fetch fails.
5. **`npm run db:migrate -- status` actually applies migrations** (BUG-005). The npm script hardcodes `up`; tsx sets `argv[2]` to the first CLI arg, so the `status` branch is unreachable. README, `DEPLOYMENT_GUIDE.md` and `IMPLEMENTATION_STATUS.md` all document the broken form.

The test suite is also **flaky**: the SKIP-LOCKED claim test failed in 1 of 5 full-suite executions (`tests/integration/repositories.test.ts:243`) and passes in isolation, so `README`'s badge "96 passed (14 suites)" and `docs/IMPLEMENTATION_STATUS.md`'s "96 tests … 0 failed" are aspirational rather than reproducible. `npm audit` reports 2 critical + 1 moderate advisories, all in dev-only packages (`vitest`/`tinypool`/`@vitest/mocker`).

No SQL injection, no `DELETE FROM notion_tasks`, no committed secrets, and no unauthenticated task mutation were found in the code. The unsigned-webhook fallback (SEC-001) is the only security finding with realistic exposure, and it hinges on `NODE_ENV` defaulting to `development`.

---

## 2. Repository / Architecture Overview

Layers (verified by reading every application file):

- `src/` — `config.ts` (zod-validated env → `AppConfig`), `server.ts` (Fastify factory, raw-body JSON parser for HMAC, 256 KiB body limit, `/health` + `/ready` + `/webhooks/notion`), `errors.ts` (typed errors, `classifyError`, `sanitizeErrorMessage`), `logger.ts` (pino).
- `routes/` — `health.ts` (`SELECT 1` readiness probe), `webhooks.ts` (handshake → token check → signature check → envelope validation → durable enqueue).
- `sync/` — `notion-client.ts` (SDK wrapper: `resolveDataSource`, `queryDataSourcePages`, `fetchPage`, `fetchPageBlocks`, retry), `normalize.ts` (pure page→record mapping), `property-map.ts`, `retry-policy.ts` (backoff + `Retry-After` parsing), `worker.ts` (inbox consumer loop), `backfill.ts`, `reconcile.ts`, `task-sync.ts` (dead module — see IMP-006).
- `db/` — `pool.ts` (`getPool`/`createPool`/`withTransaction`), `migrate.ts` (advisory lock, SHA-256 checksum drift detection, transactional apply, CLI `up`/`status`), `inbox-repo.ts`, `tasks-repo.ts`, `runs-repo.ts`.
- `migrations/0001_init.sql` — `notion_sync` schema: `notion_tasks`, `sync_inbox` (status CHECK, claim/lease/failed indexes), `sync_runs` (run_type/status CHECK), `schema_migrations` ledger.
- `scripts/` — `sync-worker.ts`, `sync-backfill.ts`, `sync-reconcile.ts`, `sync-retry-failed.ts`, `sync-recover-stuck.ts`.
- `tests/` — 10 unit files, 3 integration files (real embedded PostgreSQL 18), 1 e2e acceptance file (in-memory fake DB).
- `docs/` — PRD, SPEC, implementation workflow, deployment guide, implementation status (plus `PRD.md` byte-identical to `Notion_to_PostgreSQL_Sync_PRD.md`).

Data flow: Notion webhook → Fastify (verify HMAC over raw body) → `sync_inbox` row (unique `event_id`) → worker claims one row with `FOR UPDATE SKIP LOCKED` → re-fetches the page from Notion (never trusts the payload) → `normalizePage` → `upsertTask` + `settleEventSuccess` in one transaction → `sync_runs` ledger records backfill/reconcile outcomes. Reconciliation re-scans the data source, upserts, and only then flags missing pages `is_in_source=false`.

---

## 3. README Accuracy Audit

`README.md` (796 lines) was checked claim-by-claim against the code.

| README claim | Location | Verdict | Evidence |
|---|---|---|---|
| Project tree, script list, lifecycle commands | §§3–5, 425–438 | Accurate | `package.json` scripts match; `build`/`typecheck`/`test` verified locally |
| `/health` and `/ready` status codes incl. 503 reason | §12 | Accurate | `routes/health.ts`, `tests/unit/health.test.ts` (3 tests pass) |
| HMAC verified over exact raw body before acknowledgement | §§8–12 | Accurate | `src/server.ts:31-44`, `routes/webhooks.ts:61-77` |
| Durable inbox + duplicate acknowledgement | §12 | Accurate | `db/inbox-repo.ts:33-63`, unique `event_id`; integration test I-05 |
| Tombstones, never physical deletes | §10 | Accurate | `TasksRepository` has no DELETE; repo-wide scan test I-16 passes |
| INV-4 "older snapshot never overwrites newer" | §10 | Mostly accurate | `db/tasks-repo.ts:45-47`; the `EXCLUDED… IS NULL` branch is a hole (BUG-008) |
| INV-5 "only flag out-of-scope if scan was 100% complete" | §11 | **Not achieved** | Completion signal is only "pagination loop ended"; the 10 000-result cap returns `has_more=false` (BUG-002), and `scanComplete` is a dead variable (IMP-002) |
| "Retryable errors (429, 5xx, **network drops**) trigger exponential backoff" | §9 line 149 | **False for network drops** | No-status errors are wrapped and treated as non-retryable (BUG-003) |
| "IANA Timezone Awareness … configurable timezone (default `Asia/Kolkata`)" | §6 line 76, §9 line 398 | **False** | `SYNC_TIMEZONE` is validated but never read; `normalize.ts` declares `timezone?` and ignores it (DOC-001) |
| `npm run db:migrate -- status` inspects migrations | §5 lines 351-355, 426 | **Broken** | Script hardcodes `up`; `argv[2]` is `"up"` (BUG-005) |
| "Reconciliation Cron Job … Scheduled every 30 minutes" | §14 lines 696-697 | **Not implemented** | No scheduler/cron in code; `SYNC_RECONCILIATION_INTERVAL_MINUTES` unused (DOC-003) |
| "**No mocks are used for database testing**" | §13 line 646 | **Partly false** | Integration tests use real PostgreSQL (true); the e2e suite uses an in-memory `Map` + `vi.fn()` fake (DOC-004) |
| Test summary `14 passed (14)` / `96 passed (96)` and badge | §13 lines 8, 651-652 | Counts correct, **stability false** | 96 tests in 14 files confirmed; 1 of 5 full-suite runs failed (BUG-006) |
| "Local automated verification is 100% green across all 96 … tests" | §16 line 771 | **Not reproducible** | Same as above (DOC-002) |
| `.env`-based quickstart (`cp .env.example .env`, "Edit `.env`") | §7 lines 337-342, §15 line 725 | **Does not work as documented** | Nothing loads `.env` (IMP-001) |
| Unit 10 files/49 tests, integration 3/38, e2e 1/9 | §13 lines 655-659 | Accurate (derived) | Per-file counts from the verbose full-suite run sum exactly to 49/38/9 |
| `@neon/config`, `@neon/env` as dependency table row "Cloud database client utilities" | §4 line 121 | Installed but unused | No imports outside lockfile/skill docs; SPEC §125 explicitly forbids importing them (IMP-004) |
| Secret redaction, no plaintext secrets in VCS | §17 | Accurate | `sanitizeErrorMessage` + tests; `.gitignore` covers `.env`, `.env.*`, `dist/`, logs |
| `page_content_json` content sync | §9/§10 | **Not achieved** | Content is wiped unless blocks were fetched in the same call (BUG-004) |
| `is_in_source` semantics | §§10–11 | **Broken for webhook path** | BUG-001 |

---

## 4. Bug & Risk Register

| ID | Severity | Classification | Finding | Evidence | Impact | Recommended Action | Validation |
|---|---|---|---|---|---|---|---|
| BUG-001 | P1 | CONFIRMED BUG | Worker passes the *unresolved* `NOTION_DATA_SOURCE_ID` (empty in `.env.example`) to `normalizePage`, so pages whose parent is a `data_source_id` are stored `is_in_source=false` | `sync/worker.ts:87-92`; `sync/normalize.ts:165-178`; `.env.example:6`; `src/config.ts:10,39` (optional); `tests/unit/normalize.test.ts:14-15` (parent is `data_source_id`); backfill/reconcile pass the *resolved* id (`sync/backfill.ts:34,74`, `sync/reconcile.ts:36,81`) | Contradictory derived state: webhook path writes `false`, backfill/reconcile write `true` for the same page; consumers filtering `is_in_source` lose tasks; INV-5 remediation operates on a wrong baseline | Resolve the data source once at worker start (`resolveDataSource`) and pass the resolved id, exactly as backfill/reconcile do; alternatively make `NOTION_DATA_SOURCE_ID` mandatory at config validation | Unit test: worker + empty `NOTION_DATA_SOURCE_ID` + parent `data_source_id` ⇒ `is_in_source=true`; integration test asserting worker and backfill agree |
| BUG-002 | P1 | CONFIRMED BUG | Notion's 10 000-result query cap returns `has_more=false` with `request_status.incomplete_reason`; the wrapper drops the field, so reconciliation treats a truncated scan as complete and mass-flags live tasks | `sync/notion-client.ts:106-143` (returns only `results`/`next_cursor`/`has_more`); SDK type `api-endpoints/data-sources.d.ts:375`; official docs "pagination stops at the 10 000th result: `has_more` becomes `false` … check `request_status.type === "incomplete"`"; `sync/reconcile.ts:97-121` | On data sources >10 000 rows: every in-scope task outside the returned page range is flagged `is_in_source=false` (apparent data loss); backfill silently completes with a partial dataset while reporting `succeeded` | Return and propagate `request_status`; treat `incomplete` as a partial scan — set run status `partial`, skip `markTasksOutOfSource`, log a warning | Unit test: mocked response with `has_more=false` + `request_status.incomplete` ⇒ `markTasksOutOfSource` not called and run recorded `partial` |
| BUG-003 | P1 | CONFIRMED BUG | Errors without an HTTP status (SDK request timeout, `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`) are wrapped as `NotionApiError` and classified `PERMANENT`; neither the app nor the SDK retries them | `sync/notion-client.ts:31-45`; `src/errors.ts:23-33` (`isRetryable` only for 429/5xx/529); `src/errors.ts:89-118` (network-code branch unreachable for wrapped errors); SDK `errors.d.ts:51-55` (no `status`), `Client.js canRetry()` returns `false` for non-`APIResponseError`; SDK default timeout 60 000 ms | A single network blip marks a webhook event `failed` permanently (manual `sync:retry-failed` needed) and aborts a whole reconciliation run; directly contradicts the README retry claim | Classify by error name/code before wrapping: retry `RequestTimeoutError`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`; keep 4xx permanent | Unit test injecting a status-less timeout error ⇒ assertions that the call is attempted `SYNC_MAX_ATTEMPTS` times with backoff |
| BUG-004 | P2 | CONFIRMED BUG | `page_content_json` is silently overwritten with `[]` whenever blocks were not fetched in the same operation | `sync/normalize.ts:199` (`options.bodyBlocks ?? []`); `sync/backfill.ts:73-77` and `sync/reconcile.ts:80-84` pass no `bodyBlocks`; `db/tasks-repo.ts:43` unconditional `page_content_json = EXCLUDED.page_content_json`; `sync/worker.ts:80-84` catch leaves `bodyBlocks=[]` | Stored page content regresses to an empty array on every backfill/reconcile and on any block-fetch failure (including rate-limited ones) — irreversible without a re-sync | Only overwrite content when blocks were actually fetched (`CASE WHEN $blocks_fetched THEN EXCLUDED…` or a separate statement), or fetch blocks in reconciliation; consider tracking content freshness | Integration test: upsert with blocks → upsert same page without blocks ⇒ content preserved and `synced_at` updated |
| BUG-005 | P2 | CONFIRMED BUG | `npm run db:migrate -- status` applies migrations instead of printing status | `package.json:15` (`"db:migrate": "tsx db/migrate.ts up"`); `db/migrate.ts:142` (`process.argv[2] ?? "up"`); executed probe in temp dir printed `ARGV_JSON=[node, argv-probe.ts, "up", "status"]`; documented at `README.md:355`, `docs/DEPLOYMENT_GUIDE.md:73`, `docs/IMPLEMENTATION_STATUS.md:81` | An operator asking for a read-only status report mutates the schema instead (SQL is transactional and idempotent, so no data loss, but the command's contract is wrong and the status branch is unreachable) | Change the script to `tsx db/migrate.ts` (default `up` still applies) so `-- status` reaches the CLI, and add a smoke test | CLI test: `npx tsx db/migrate.ts status` prints `Migration status:`; assert `runMigrations` not invoked |
| BUG-006 | P2 | CONFIRMED BUG | Flaky integration test: `claims due events atomically with SKIP LOCKED` fails intermittently in the full suite | Run 1: `AssertionError: expected undefined to be defined` at `tests/integration/repositories.test.ts:243`, `1 failed | 95 passed (96)`; runs 2–5: `14 passed (14) / 96 passed (96)`, exit code 0; isolated file run: `22 passed` | 1 failure in 5 observed full-suite executions; CI noise; invalidates the "100% green" documentation claim and can mask real regressions | Make the test deterministic: run the three claims sequentially inside explicit client transactions (or assert on the set of claimed ids rather than positional `first`/`second`) | Execute the suite ≥10 times consecutively with 0 failures |
| BUG-007 | P3 | CONFIRMED BUG | The informational-event branch of the worker can return a connection to the pool with an open transaction | `sync/worker.ts:107-117` (`BEGIN` … `COMMIT` inside `try/finally` with no `catch`/`ROLLBACK`) vs. the two other branches (`worker.ts:42-53`, `95-106`) which roll back | If `settleEventSuccess` or `COMMIT` throws, the connection is released mid-transaction (`idle in transaction`); later queries on that connection can fail with "current transaction is aborted" until a rollback occurs | Use the existing `withTransaction()` helper (`db/pool.ts:44-68`) for all three branches | Unit test with a mocked client that rejects on settle ⇒ assert `ROLLBACK` was issued |
| BUG-008 | P3 | DESIGN RISK | INV-4 guard is bypassed when the incoming snapshot has a null `notion_last_edited_time` | `db/tasks-repo.ts:45-47` (`OR EXCLUDED.notion_last_edited_time IS NULL`) | A malformed/partial payload could overwrite newer data with older or empty values; real API pages always carry `last_edited_time`, so exposure requires an upstream anomaly | Drop the `IS NULL` bypass or restrict it to the INSERT case | Integration test: null-timestamp upsert after a newer row ⇒ row unchanged |
| SEC-001 | P2 | SECURITY FINDING | Signature verification is skipped entirely when the verification token is unset in non-production, and `NODE_ENV` defaults to `development` | `routes/webhooks.ts:46-52` (503 only when `NODE_ENV==="production"`), `61-77` (`if (verificationToken)`), `routes/webhooks.ts:55-59` (missing header only); `src/config.ts:5` (`NODE_ENV` default `development`), `78-85` (token only mandatory when `NODE_ENV==="production"`) | Any reachable deployment that forgets `NODE_ENV=production` accepts forged webhook events with an arbitrary `X-Notion-Signature` header, poisoning the inbox and task state | Fail closed: require the token unless an explicit `ALLOW_UNSIGNED_WEBHOOKS=true` is set; never infer safety from `NODE_ENV` alone | Unit test: `NODE_ENV=development`, no token, bogus signature ⇒ 401/503 and no inbox row |
| SEC-002 | P3 | SECURITY FINDING | TLS certificate verification is disabled for every non-localhost connection | `db/pool.ts:23-28` (`ssl: { rejectUnauthorized: false }`, triggered by any host string that is not `localhost`/`127.0.0.1`) | Unnecessary MITM exposure: Neon presents CA-signed certificates, so `rejectUnauthorized: false` removes protection that could be kept; `sslmode=verify-full` in a URL is not honoured | Default to verified TLS (`ssl: true`) and allow an explicit opt-out env var only for self-signed dev databases | Unit test asserting the `ssl` value for representative URLs; TLS handshake check against Neon when credentials exist |
| SEC-003 | P3 | SECURITY FINDING | 2 critical + 1 moderate advisories in dev-only dependencies | `npm audit --json` → `{critical: 2, moderate: 1, total: 3}`: tinypool GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr (prototype-pollution → RCE), `@vitest/mocker` GHSA-82fw-gwwq-j7x9 (path traversal); fix requires `vitest@5.0.5` (semver-major) | Dev/CI only — not on the `npm start`/`worker` runtime path; a compromised or malicious test input could escalate in CI | Plan a vitest 5 upgrade; keep dev tooling out of production installs (`npm ci --omit=dev`) | `npm audit` reports 0 after upgrade; full suite still green |
| DOC-001 | P2 | DOCUMENTATION ISSUE | README advertises configurable IANA-timezone deadline computation; `SYNC_TIMEZONE` has no effect | `README.md:76,398`; `src/config.ts:18,65-70,109`; `sync/normalize.ts:26-32` declares `timezone?` but never reads it; `normalize.ts:127` derives `due_date` from the raw ISO string | Misleading feature claim; a user in a different timezone will not get the documented local-date behaviour | Implement timezone-aware derivation (`Intl.DateTimeFormat` with `timeZone: options.timezone`) or delete the option/env var and correct the README | Unit test with `2026-03-11T02:00:00+05:30` and `America/New_York` ⇒ documented expected `due_date` |
| DOC-002 | P2 | DOCUMENTATION ISSUE | Green-suite claims are not reproducible | `README.md:8` (badge "96 passed (14 suites)"), `651-652`, `771` ("100% green across all 96"); `docs/IMPLEMENTATION_STATUS.md:16,44` ("96 tests in 14 files pass", "0 failed"); observed 1 failure in 5 full-suite runs | False confidence in release readiness; the documented number is a snapshot, not a guarantee | Fix BUG-006 first, then restate the claim with date/run count; add a flakiness policy (e.g. repeat integration suite in CI) | 10 consecutive clean full-suite runs recorded in the status document |
| DOC-003 | P3 | DOCUMENTATION ISSUE | "Reconciliation Cron Job … Scheduled every 30 minutes" describes automation that does not exist | `README.md:79,696-697`; `README.md:399` documents `SYNC_RECONCILIATION_INTERVAL_MINUTES` as the scan frequency; the variable appears only in `src/config.ts:19,110` and its tests — no scheduler reads it | Operators believe reconciliation runs automatically; if no external cron is configured, drift accumulates silently (and INV-5 remediation never executes) | Document the external cron/systemd-timer requirement explicitly, and either consume the variable in a scheduler wrapper or remove it as a dead knob | Doc review + grep assertion that any claimed automatic schedule has a corresponding code path |
| DOC-004 | P3 | DOCUMENTATION ISSUE | "No mocks are used for database testing" is contradicted by the e2e suite | `README.md:646`; `tests/e2e/acceptance.test.ts:20-27` — in-memory `Map` stores plus `vi.fn()` SQL dispatcher, including hand-written `has_more`/`is_in_source` emulation | Readers overestimate acceptance-test fidelity; several e2e assertions encode assumptions about PostgreSQL semantics rather than verifying them (e.g. line `155-160` mutates the fake store) | Reword: "integration tests run against a real embedded PostgreSQL 18; the acceptance suite runs the full flow against an in-memory fake" | Doc review |
| IMP-001 | P2 | IMPROVEMENT | `.env` is never loaded, yet the quickstart depends on it; non-production also tolerates missing critical config silently | `package.json` scripts contain no `--env-file`, no `dotenv` import anywhere in `src/`, `db/`, `sync/`, `routes/`, `scripts/`; `README.md:337-342` instructs `cp .env.example .env` and "Edit `.env`"; `src/config.ts:74-106` only throws for missing vars when `NODE_ENV==="production"`, otherwise substitutes `""` (and `NOTION_VERSION` defaults make `NODE_ENV` itself default to `development`) | A user following the README gets a process whose `DATABASE_URL` is `""` and whose Notion credentials are empty — confusing runtime failures (e.g. `/ready` 503, webhook 503) instead of a clear startup error | Add `--env-file=.env` to `dev`/`worker`/`sync:*`/`db:migrate` invocations (Node ≥22 supports it) or bundle `dotenv`; make missing required vars a startup error outside tests | Manual: populate only `.env`, run `npm run worker` ⇒ starts successfully; empty config outside `NODE_ENV=test` ⇒ explicit `ConfigurationError` |
| IMP-002 | P3 | IMPROVEMENT | `scanComplete` in reconciliation is a dead variable, so the INV-5 guard reduces to `pageFailures > 0` | `sync/reconcile.ts:53` (`let scanComplete = false`), `101` (`scanComplete = true`), `104` (`if (!scanComplete || pageFailures > 0)`) | No real "scan was complete" concept exists even after fixing BUG-002; future refactors may believe the guard is stronger than it is | Replace with explicit completeness signals: pagination termination, `request_status`, `pageFailures`, plus a minimum-expected-records sanity check | Unit test: aborted/incomplete scan ⇒ remediation skipped and run marked `partial` |
| IMP-003 | P3 | IMPROVEMENT | Transaction handling is hand-rolled and inconsistent instead of using the existing helper | `db/pool.ts:44-68` (`withTransaction`) vs. `sync/worker.ts:42-53,95-106,107-117` | Duplication already produced BUG-007; future branches are likely to repeat it | Route all transactional flows through `withTransaction` | Unit tests asserting BEGIN/COMMIT/ROLLBACK call sequences per branch |
| IMP-004 | P3 | IMPROVEMENT | `@neon/config` and `@neon/env` are runtime dependencies listed in the README but never imported | `package.json:22-23`; `README.md:121`; no source import (only lockfile + `.agents/skills/…` docs); `docs/Notion_to_PostgreSQL_Sync_SPEC.md:125` explicitly decides "keep for Neon linkage, but do **not** let it be a second source of truth" | Unused install surface and a misleading dependency table; the SPEC decision is not reflected in the README | Either remove them from `dependencies` or document them as tooling-only in the table, citing the SPEC decision | `npm ls --omit=dev` review |
| IMP-005 | P3 | IMPROVEMENT | ESLint/TypeScript-ESLint dev dependencies exist but there is no config and no `lint` script | Directory listing shows only `tsconfig.json`, `vitest.config.ts`, `.env`, `.env.example`; `package.json:30-40` includes `eslint`, `@eslint/js`, `typescript-eslint`; the project instructions expect a lint lifecycle step | No automated style/quality gate despite the dependency footprint | Add `eslint.config.js` (flat config) and `"lint": "eslint ."` | `npm run lint` exits 0 on the current tree |
| IMP-006 | P3 | IMPROVEMENT | `sync/task-sync.ts` is dead code and embeds the BUG-001 pattern | `grep task-sync|syncTaskPage` across `*.ts` returns only its own definition (`sync/task-sync.ts:21`); line `43` uses `options.dataSourceId ?? config.NOTION_DATA_SOURCE_ID` | Untested, unreachable module that will confuse future work and would reproduce the `is_in_source` defect if wired in | Delete it, or wire it in with the resolved data source id and cover it with tests | Import analysis + removal compiles (`tsc --noEmit`) |

---

## 5. Detailed Findings

### 5.1 BUG-001 — `is_in_source` computed against the wrong identifier (P1)

`normalizePage` compares the page's parent id against whichever identifiers are supplied:

```ts
// sync/normalize.ts:165-178
let isInSource = true;
if (page.parent) {
  const parentId = page.parent.data_source_id || page.parent.database_id;
  ...
  if (cleanTargetSource || cleanTargetDb) {
    isInSource = (cleanTargetSource ? cleanParentId === cleanTargetSource : false) ||
      (cleanTargetDb ? cleanParentId === cleanTargetDb : false);
  }
}
```

The worker supplies the *configured* value, not the resolved one:

```ts
// sync/worker.ts:87-92
const normalized = normalizePage(page, {
  configuredDataSourceId: config.NOTION_DATA_SOURCE_ID,   // "" from .env.example
  configuredDatabaseId: config.NOTION_DATABASE_ID,
  ...
});
```

With `NOTION_DATA_SOURCE_ID` empty, no data-source comparison happens and only the database id is compared. For pages returned by the current API (`NOTION_VERSION=2026-03-11`), `page.parent` is a data source (`tests/unit/normalize.test.ts:14-15` encodes exactly this shape), so the comparison fails and `is_in_source` becomes `false` — for pages that are unambiguously in scope. Backfill and reconcile already resolve the id first (`sync/backfill.ts:34,74`; `sync/reconcile.ts:36,81`) and store `true`, so the same page oscillates depending on which code path touched it last.

Recommended action: resolve the data source id once when the worker starts (as backfill/reconcile do) and pass the resolved value; additionally, consider failing fast when neither identifier is configured.

### 5.2 BUG-002 — Incomplete scans are treated as complete (P1)

Official documentation for "Query a data source" states: *"This endpoint supports paginating through up to 10,000 results per query. If a data source contains more matching entries than this limit, pagination stops at the 10,000th result: `has_more` becomes `false`, and every response page served from the capped result includes a `request_status` marking the result as incomplete… Check `request_status.type === "incomplete"` on every response page to know whether a query was cut off."*

The wrapper discards it:

```ts
// sync/notion-client.ts:121-125
return {
  results: res.results ?? [],
  next_cursor: res.next_cursor ?? null,
  has_more: Boolean(res.has_more),   // request_status dropped
};
```

Reconciliation then sets `scanComplete = true` after the loop and calls `markTasksOutOfSource(pool, seenPageIds)`, which flips every currently in-scope row not present in the returned id set to `is_in_source=false`. With >10 000 matching rows the first 10 000 are "seen", so all remaining tasks are flagged as vanished. Backfill (which never remediates) instead reports `succeeded` on an incomplete dataset, silently under-syncing.

### 5.3 BUG-003 — No retry for status-less errors (P1)

`executeWithRetry` reads `err.status ?? err.statusCode`, constructs a `NotionApiError`, and consults `isRetryable`, which is computed solely from HTTP status codes. The SDK's timeout error has no `status`:

```js
// node_modules/@notionhq/client/build/src/errors.d.ts:51-55
export declare class RequestTimeoutError extends NotionClientErrorBase<ClientErrorCode.RequestTimeout> {
  readonly code: ClientErrorCode.RequestTimeout;   // no status property
  readonly name = "RequestTimeoutError";
```

The same applies to raw fetch failures (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`), which the SDK propagates unchanged because `executeWithRetry` in the SDK re-throws anything that is not an `APIResponseError`, and `canRetry` returns `false` for timeouts. Net effect: neither layer retries, the worker settles the event as `failed`, and reconciliations abort. `classifyError`'s network-code branch (`src/errors.ts:109-116`) is unreachable in this path because the wrapper has already converted the error into a `NotionApiError` (the `instanceof NotionApiError` check at line 89 short-circuits first).

### 5.4 BUG-004 — Stored page content wiped (P2)

`page_content_json: options.bodyBlocks ?? []` combined with an unconditional `page_content_json = EXCLUDED.page_content_json` means "not fetched" is indistinguishable from "empty page". Only the worker fetches blocks, and only for `page.content_updated` events or when `SYNC_SYNC_BODY_CONTENT` is on. Backfill (`backfill.ts:73-77`) and reconcile (`reconcile.ts:80-84`) always write `[]`. When a block fetch fails, the worker logs a warning and proceeds with `[]`, destroying previously captured content.

### 5.5 BUG-005 — Documented migrate command is wrong (P2)

`npm run db:migrate -- status` expands to `tsx db/migrate.ts up status`. A runtime probe (identical invocation shape, run in a temp directory) printed:

```
ARGV_JSON=["C:\\Program Files\\nodejs\\node.exe","…\\argv-probe.ts","up","status"]
ARGV2=up
LOOKS_LIKE_ENTRYPOINT_GUARD=true
```

So `process.argv[2]` is `"up"`; the `status` branch is dead code in practice, and the entrypoint guard does work (the CLI really does apply migrations). Three documents repeat the broken command.

### 5.6 BUG-006 — Flaky SKIP LOCKED test (P2)

The test fires three concurrent `claimNextEvent` calls through one pool and asserts positional results (`first`/`second` non-null and distinct, `third` null). `FOR UPDATE SKIP LOCKED` legitimately allows a concurrent statement to find no claimable row within its snapshot window, so a `null` can land in position 1 or 2. Observed: run 1 of 5 failed at line 243 (`expected undefined to be defined`); the file passes 22/22 in isolation; the other four full-suite runs were 96/96 with exit code 0. The assertion should treat the result set as unordered, or the claims should be serialized inside explicit transactions.

### 5.7 BUG-007 / BUG-008 — Transaction and guard edge cases (P3)

- `worker.ts:107-117`: `BEGIN` … `COMMIT` with `finally { release() }` but no `catch`/`ROLLBACK`. The sibling branches at lines 42-53 and 95-106 do roll back. On failure the connection returns to the pool idle-in-transaction.
- `tasks-repo.ts:45-47`: `OR EXCLUDED.notion_last_edited_time IS NULL` lets a null-timestamp record overwrite a newer row.

### 5.8 Documentation findings (DOC-001 … DOC-004)

- **Timezone** (DOC-001): `SYNC_TIMEZONE` passes zod validation (`Intl.DateTimeFormat` check), is exported on `AppConfig`, is forwarded to `normalizePage` by every caller, and is never read. `due_date` for timed values is the literal date portion of Notion's ISO string (`normalize.ts:127`), not a conversion.
- **Green suite** (DOC-002): the counts are right, the stability claim is not.
- **Cron** (DOC-003): no scheduler exists; `SYNC_RECONCILIATION_INTERVAL_MINUTES` is validated and exposed but never consumed.
- **Mocks** (DOC-004): true for integration tests, false for the acceptance suite.

### 5.9 Improvement findings (IMP-001 … IMP-006)

Covered in the register: `.env` loading, dead `scanComplete`, hand-rolled transactions, unused `@neon/*` dependencies, missing lint gate, dead `task-sync.ts` module.

---

## 6. Security Review

Controls verified present and correct:

- **SQL injection**: all statements are parameterized; the only dynamic SQL fragments are static strings (`FOR UPDATE SKIP LOCKED`, `($1 || ' seconds')::interval`, `LIMIT $1`). No user-controlled interpolation was found in `db/`, `sync/`, `routes/`.
- **Webhook authenticity (production path)**: `verifyWebhookSignature` runs over the exact raw buffer preserved by the custom JSON parser; failure ⇒ 401; malformed envelope ⇒ 400; duplicate delivery ⇒ idempotent 200.
- **Payload limits**: 256 KiB body limit; zod envelope validation; unknown event types are acknowledged without mutating tasks.
- **Durability before acknowledgement**: inbox insert precedes the 200 response; DB failure ⇒ 503 so Notion retries.
- **Secret hygiene**: no credentials in the repository; `.env` is 0 bytes and gitignored (`git check-ignore` confirms `.env`, `.env.*`); `sanitizeErrorMessage` redacts postgres URLs, `secret_`/`ntn_` keys and verification tokens, and is unit-tested.
- **Destructive SQL**: no `DELETE FROM notion_sync.notion_tasks` exists; deletions are tombstones; a repository test enforces this invariant.

Findings: SEC-001 (fail-open signature verification when the token is unset outside production — `NODE_ENV` defaults to `development`), SEC-002 (TLS verification disabled for every non-localhost host), SEC-003 (dev-dependency advisories: 2 critical, 1 moderate, fix requires a vitest major upgrade). No P0/P1 security defect was found.

---

## 7. Testing / Validation Results

Commands actually executed during this audit (Windows PowerShell, `npm.cmd` because `npm.ps1` is blocked by policy — the README documents this workaround):

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | **Pass** — exit 0, no diagnostics |
| `npm.cmd run build` | **Pass** — exit 0, `dist/` emitted (gitignored) |
| `npm.cmd test` (run 1) | **Fail** — `Test Files 1 failed | 13 passed (14)`, `Tests 1 failed | 95 passed (96)`; failure `tests/integration/repositories.test.ts:243` (`expected undefined to be defined`, SKIP LOCKED claim test) |
| `npm.cmd test` (runs 2–5) | **Pass** — `14 passed (14)`, `96 passed (96)`, exit code 0 captured via `cmd /c` + `%ERRORLEVEL%` |
| `npx.cmd vitest run tests/integration/repositories.test.ts` | **Pass** — 22/22 in isolation (flakiness evidence) |
| `npm.cmd audit --json` | 3 advisories: 2 critical (`tinypool`), 1 moderate (`@vitest/mocker`); all dev-only; fix = `vitest@5.0.5` (semver-major) |
| tsx argv probe (temp dir, outside repo) | `argv[1]` = script path, `argv[2]` = first CLI arg, entrypoint guard `true` — proves BUG-005's mechanism |
| Repo-wide greps (`dotenv`, `--env-file`, `@neon/*`, `SYNC_TIMEZONE`, `SYNC_RECONCILIATION_INTERVAL_MINUTES`, `20000`, `task-sync`, `DELETE FROM`) | Evidence for IMP-001/004, DOC-001/003, IMP-006, and the no-delete invariant |
| Official Notion docs fetch (`developers.notion.com/reference/query-a-data-source`) | Confirms the 10 000-result cap, `has_more=false`, and `request_status.incomplete_reason` semantics (BUG-002) |

Deliberately **not** run (safety): `db:migrate` (any form — it would mutate a database), `sync:backfill` / `sync:reconcile` / `sync:retry-failed` / `sync:recover-stuck` against real data, `worker`, `start`, any deploy, and any live Notion/Neon call. Per-suite script counts (`test:unit` = 49, `test:integration` = 38, `test:e2e` = 9) were derived from the per-file counts in the verbose full-suite output; the individual scripts were not executed separately.

---

## 8. Architecture / Maintainability Review

Strengths: clear module boundaries with no circular dependencies; pure normalization function; typed error taxonomy with central classification; retry policy isolated and unit-tested; operations exposed as small scripts sharing the same repositories as the HTTP/worker paths; migration runner with advisory lock, checksum drift detection and transactional application; integration tests against a genuine PostgreSQL 18 rather than a fake.

Weaknesses:

- **Configuration drift between paths.** Backfill/reconcile resolve the data source; the worker does not (BUG-001). The reconcile call sites pass the resolved id while the worker passes the raw config — a duplicated responsibility that one shared "sync context" object would eliminate.
- **Missing completeness/quality signals.** There is no representation of "the scan was complete" that survives contact with the API (BUG-002, IMP-002). `sync_runs` records counts and a status but nothing that distinguishes "capped at 10 000" from "finished".
- **Content-fetch strategy is implicit.** Whether `page_content_json` is authoritative depends on the caller, and the SQL upsert has no notion of partial updates (BUG-004).
- **Dead and duplicated code**: `sync/task-sync.ts` is unreferenced (IMP-006), and transactions are hand-rolled in three places despite a helper (IMP-003, BUG-007).
- **Tooling gaps**: no lint gate (IMP-005); unused runtime dependencies (IMP-004).
- **Documentation as a liability**: README's feature list, env tables and operations section describe behaviours (timezone awareness, cron, retry on network drops, migrate status, mock-free testing, green suite) that the code does not currently provide.

---

## 9. Recommended Fix Plan

**Immediate (before any live sync enablement)**

1. BUG-001 — resolve the data source id once for the worker and pass the resolved value; add the agreement test between worker and backfill.
2. BUG-002 — propagate `request_status`; treat `incomplete` as partial; never remediate out-of-source after an incomplete scan; record it on `sync_runs`.
3. BUG-003 — retry status-less timeout/network errors (name/code based) at the app layer.
4. BUG-006 — de-flake the SKIP LOCKED test, then re-run the suite ≥10 times and record the result.
5. DOC-002 — correct the green-suite claims once the suite is stable.

**Next (data-correctness and operator safety)**

6. BUG-004 — stop writing `[]` over stored content when blocks were not fetched (and consider content freshness tracking).
7. BUG-005 — fix the `db:migrate` script (drop the hardcoded `up`) and add a CLI smoke test; correct the three documents that repeat the command.
8. IMP-001 — load `.env` explicitly (`--env-file`) and fail fast on missing required config outside tests.
9. SEC-001 — fail closed on missing verification token unless explicitly opted out.
10. BUG-007 — adopt `withTransaction` in all worker branches; add rollback assertions.

**Later**

11. SEC-002 (verified TLS), SEC-003 (`vitest` 5 upgrade), BUG-008 (tighten the INV-4 guard), IMP-002 (real completeness signal), IMP-003 (transaction helper everywhere), IMP-006 (remove/rehabilitate `task-sync.ts`).
12. DOC-001 (implement or drop timezone awareness), DOC-003 (document the external cron, or implement a scheduler that consumes `SYNC_RECONCILIATION_INTERVAL_MINUTES`), DOC-004 (reword the mock claim).

**Optional**

13. IMP-004 (dependency cleanup), IMP-005 (lint gate), a `docs/README` index for the unlisted architecture PNG, and a CI workflow that repeats the integration suite to catch flakiness.

---

## 10. Regression Test Plan

Each fix needs a failing-first test; suggestions:

1. **BUG-001**: unit test — worker with `NOTION_DATA_SOURCE_ID=""` and a page whose parent is a `data_source_id` ⇒ `is_in_source=true`; plus an integration assertion that a worker write and a backfill write of the same page agree.
2. **BUG-002**: unit test — client returns `{has_more:false, request_status:{type:"incomplete", incomplete_reason:"query_result_limit_reached"}}` ⇒ reconciliation result status `partial`, `markTasksOutOfSource` never invoked, warning logged; and a backfill variant asserting the run is not reported `succeeded`.
3. **BUG-003**: unit test — operation rejects with an object carrying `name:"RequestTimeoutError"` and no `status` ⇒ the operation is retried `SYNC_MAX_ATTEMPTS` times; a second test with `code:"ECONNRESET"` behaves identically; a third asserts a 404 is still attempted once.
4. **BUG-004**: integration test (real PostgreSQL) — upsert with blocks, then upsert the same page without blocks ⇒ `page_content_json` unchanged; a worker-path test where the block fetch rejects ⇒ content preserved.
5. **BUG-005**: CLI test — spawn `tsx db/migrate.ts status` against the embedded test database ⇒ output contains `Migration status:` and `schema_migrations` is untouched.
6. **BUG-006**: run the integration suite 10× consecutively in CI; the released assertion must not depend on positional ordering.
7. **BUG-007**: unit test with a mocked client that throws on `settleEventSuccess` ⇒ query log contains `ROLLBACK` before release.
8. **BUG-008**: integration test — newer row, then upsert with `notion_last_edited_time = null` ⇒ row unchanged.
9. **SEC-001**: unit test — `NODE_ENV=development`, no token, bogus signature ⇒ 401/503 and zero inbox rows.
10. **IMP-001**: smoke test — only `.env` populated ⇒ `npm run worker` starts; empty config outside `test` ⇒ `ConfigurationError` naming the missing variables.
11. **DOC-001** (if implemented): unit tests for `due_date` under at least three timezone/offset combinations.

---

## 11. Unverified Areas

- **Live Notion API behaviour**: no credentials, so webhook delivery shapes, real `parent` payloads, rate-limit responses, `incomplete_reason` on a >10 k data source, and `verifyWebhookSignature` against a real token are unverified. The SDK surface was verified statically (types/exports).
- **Live Neon/PostgreSQL**: connectivity, pooled-vs-direct endpoints, advisory locks across poolers, and TLS behaviour against real Neon were not exercised. Integration tests ran against a local embedded PostgreSQL 18 only.
- **`npm run db:migrate` / backfill / reconcile / worker / start against any real database** — deliberately not executed (mutating commands).
- **Flakiness beyond five full-suite runs**: 1 failure in 5 runs is an observed rate, not a measured probability.
- **`.env` loading under the intended deployment mechanism** (systemd, PM2, container env): the code has no loader; whether the operator's platform injects variables could not be verified.
- **Context7 documentation queries** failed (invalid API key); Notion API semantics were instead taken from the official docs page (fetch above) plus the installed SDK's type definitions.
- **Intent behind missing tooling**: whether the ESLint dependencies are aspirational or leftover could not be determined from the repository.
- **`docs/implementation-workflow.md`, `docs/PRD.md` and the architecture PNG** were read at a summary level only; formal conformance of every PRD acceptance criterion (AT-01…AT-14) was not re-run.

---

## 12. Final Assessment

**Overall: promising V1 with a solid architectural foundation, but not yet "verified" — three P1 correctness defects, one of which (BUG-001) is triggered by the shipped default configuration, silently corrupt the derived state that consumers rely on.**

Positive: layering, invariants (no deletes, durable inbox, idempotent upsert, guarded remediation), parameterized SQL, secret redaction, and real-database integration tests are all present and, where executed, working. Typecheck, build, and the documented test counts check out.

Negative, in priority order: (1) `is_in_source` is wrong on the webhook path for the default config; (2) large scans are treated as complete, which can mass-flag live tasks as out-of-scope; (3) transient network/timeout errors are never retried and mark events permanently failed; (4) stored page content is destroyed by backfill/reconcile and on block-fetch failure; (5) the documented `db:migrate -- status` command applies migrations instead of reporting status; (6) the "100% green" claim is not reproducible (1 failure in 5 full-suite runs); (7) several README features (timezone awareness, 30-minute scheduled reconciliation, `.env` workflow, "no mocks") do not match the code.

Recommendation: fix items 1–5 of the Immediate plan (BUG-001, BUG-002, BUG-003, BUG-006, DOC-002), re-run the suite ≥10 times, and only then proceed to live credential enablement and end-to-end acceptance against Notion and Neon. Until then, the honest status of this project is: **locally credible, live-unverified, with known correctness defects in default configurations.**

*No application code, configuration, documentation (other than this report), migration, dependency or lockfile was modified during this audit.*
