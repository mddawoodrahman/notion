# Implementation Status

**Project:** Notion Tasks → PostgreSQL Synchronization Service (V1, one-way)
**Repository:** `D:\Notion` (branch `main`)
**Last updated:** 2026-10-21

> Status rule: a phase is only "verified" for the environment in which it was actually exercised.
> Live Notion and Neon calls have **not** been exercised because no credentials were supplied.

## Current state

The V1 service is implemented end to end: schema + migration runner, Notion client with retry/backoff,
normalization, idempotent repositories, webhook receiver with durable inbox, background worker,
initial backfill, reconciliation, and operator scripts.

Automated verification is green: **128 tests in 16 files pass** — 78 unit tests, **41 tests that run
against a real PostgreSQL 18 server** (embedded, no Docker) rather than mocks, and 9 acceptance tests
that drive the full pipeline against an in-memory harness (wiring/control flow, not SQL semantics).
TypeScript typecheck, ESLint, and the production build all pass, and the full suite has been run
**12 times consecutively** without a failure (evidence below).

The service is **not deployed** and has **not** been run against the live Notion API or a Neon database.

## Phase status

| Phase | Implementation | What was actually verified |
|---|---|---|
| 0. Repository audit and plan | complete | Repository inspected; Notion SDK `@notionhq/client@5.27.1` exports and API version `2026-03-11` checked. |
| 1. Config and HTTP scaffold | complete | `validateConfig` rules (production requirements, token/URL shape, timezone) and `/health`, `/ready` covered by unit tests. |
| 2. Schema and migrations | complete | Migration applied to real PostgreSQL; tables, indexes, CHECK constraints, JSONB types, idempotent re-run and checksum-drift detection asserted in `tests/integration/migrations.test.ts`. |
| 3. Notion client and normalization | complete | Normalization and retry/redaction covered with mocked SDK responses. **No live Notion call.** |
| 4. Repositories | complete | Upsert idempotency, INV-4 `last_edited_time` guard (including rejection of a stale `NULL` timestamp), content-preserving `page_content_json` COALESCE semantics, tombstones, out-of-scope flags, inbox dedup, `SKIP LOCKED` claims, lease recovery, run ledger and INV-6 transaction rollback/commit asserted against real PostgreSQL. |
| 5. Initial backfill | complete | Cursor pagination, re-run without duplicates, dry run, partial/failed run recording and secret redaction asserted against real PostgreSQL with a fake Notion client. |
| 6. Webhook receiver and inbox | complete | Handshake, signature verification, envelope validation and durable-enqueue/duplicate paths covered with mocks and Fastify injection. |
| 7. Worker and event processing | complete | Event matrix, INV-2 re-fetch, retry classification and settlement covered with mocks; SQL primitives verified against real PostgreSQL. |
| 8. Reconciliation and operations | complete | Complete-vs-partial scan safety logic (including Notion `request_status = incomplete` / the 10 000-result cap → run recorded `partial`, remediation skipped) and operator scripts covered with mocks. Reconciliation is an external-scheduler CLI job; the service has no in-process cron. |
| 9. Deployment assets | complete (not deployed) | `docs/DEPLOYMENT_GUIDE.md`, `.env.example`, npm scripts, and a working `dist/src/server.js` build. No hosting was configured. |
| 10. Acceptance | partially verified | 9 end-to-end scenarios in `tests/e2e/acceptance.test.ts` (in-memory harness) plus the 41 real-database integration tests. Live acceptance (AT-01…AT-14 against Notion/Neon) remains outstanding. |

## Evidence from actual runs (2026-10-21)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, no errors |
| `npm run lint` | exit 0, 0 errors (ESLint flat config) |
| `npx vitest run tests/unit` | 12 files, **78 tests passed** |
| `npx vitest run tests/integration` | 3 files, **41 tests passed** (real PostgreSQL 18 via `embedded-postgres`, zero DB mocks) |
| `npx vitest run tests/e2e` | 1 file, **9 tests passed** (in-memory harness) |
| `npm test` | 16 files, **128 tests passed**, 0 failed |
| `npm test` × 10 consecutive runs | all exit 0; each run reported **128/128 tests passed**, 0 failures |
| `npm test` (final verification runs) | exit 0; `Test Files 16 passed (16)`, `Tests 128 passed (128)` — 12th consecutive clean full-suite run |
| `npm run build` | exit 0; `dist/src/server.js` produced |

## Technical audit remediation (2026-10-21)

All findings in `docs/TECHNICAL_AUDIT_REPORT.md` were fixed and locked in with regression tests,
except SEC-003 (dev-only dependency advisories; requires a `vitest@5` major upgrade):

| Finding | Fix | Regression coverage |
|---|---|---|
| BUG-001 | Worker resolves the data source ID once (`client.resolveDataSource`) before normalizing webhook pages, and caches it | `tests/unit/worker.test.ts` (resolve-once + cache) |
| BUG-002 | `request_status` surfaced from the client; reconcile/backfill record `partial` and skip remediation on capped scans | `tests/unit/{notion-client,reconcile,backfill}.test.ts` |
| BUG-003 | Status-less timeouts and network resets classified transient and retried | `tests/unit/{notion-client,worker}.test.ts` |
| BUG-004 | `page_content_json` upsert uses `COALESCE($19::jsonb, ...)`; SQL `NULL` means "content not fetched" and preserves stored blocks | `tests/unit/repository.test.ts`, `tests/integration/repositories.test.ts` |
| BUG-005 | `db:migrate` forwards operator arguments (`up` / `status`) via `resolveMigrationOperation()` instead of hardcoding `up` | `tests/unit/migrate-cli.test.ts` |
| BUG-006 | `SKIP LOCKED` integration test asserts on the claim set, not positional row order | `tests/integration/repositories.test.ts` |
| BUG-007 | `withTransaction()` used in every worker branch (rollback + release on failure) | `tests/unit/worker.test.ts` |
| BUG-008 | Removed the `OR EXCLUDED.notion_last_edited_time IS NULL` INV-4 bypass | `tests/integration/repositories.test.ts` |
| SEC-001 | Webhook signature verification fails closed; `ALLOW_UNSIGNED_WEBHOOKS=true` is development-only and rejected in production | `tests/unit/{webhooks,config}.test.ts` |
| SEC-002 | Verified TLS by default (`ssl: true`); `DB_SSL_INSECURE=true` development-only opt-out | `tests/unit/pool.test.ts` |
| IMP-001 | Scripts load `.env` via `--env-file-if-exists=.env`; required variables enforced whenever `NODE_ENV !== "test"` | `tests/unit/config.test.ts` |
| IMP-002 | Real completeness signal: pagination termination + `request_status` + page failures (no dead `scanComplete` variable) | `tests/unit/{reconcile,backfill}.test.ts` |
| IMP-003 | All transactional worker flows routed through `withTransaction()` | `tests/unit/worker.test.ts` |
| IMP-004 | Neon tooling packages documented as tooling-only (not runtime-imported), citing the SPEC decision | README §4 |
| IMP-005 | ESLint flat config plus `"lint": "eslint ."`; exits 0 on the current tree | gate command |
| IMP-006 | Deleted dead `sync/task-sync.ts` (zero references) | `npm run typecheck` / `lint` |
| DOC-001 | Timezone-aware `due_date` derivation (`Intl.DateTimeFormat("en-CA")`, default `Asia/Kolkata`) | `tests/unit/normalize.test.ts` |
| DOC-002 | Green-suite claims restated with date/run count; 12-run stability evidence recorded above | this document, README §13 |
| DOC-003 | Docs state reconciliation is an external-scheduler CLI job (no in-process cron); `SYNC_RECONCILIATION_INTERVAL_MINUTES` kept as a documented informational cadence | README §5.3/§9/§14, this document |
| DOC-004 | Mock claim reworded: integration = real embedded PostgreSQL 18; acceptance = in-memory fake | README §13 |
| SEC-003 | **Deferred (out of scope):** 2 critical + 1 moderate dev-only advisories (`vitest`/`tinypool`/`@vitest/mocker`); fix is a `vitest@5` semver-major upgrade | README §17 |

## Verified vs. not verified

Verified against a real database:

- Schema, constraints, indexes, JSONB round-tripping, `DATE` vs `TIMESTAMPTZ` semantics.
- Idempotent upserts, stale-write rejection, tombstoning without deletion, out-of-scope retention,
  empty-scan safety, no `DELETE FROM notion_sync.notion_tasks` in `db/` or `sync/`.
- Inbox duplicate handling, concurrent claims, lease recovery, operator requeue.
- Atomic task-write + inbox-settlement commit and rollback.
- Content-preserving upserts: `page_content_json` keeps stored content when the incoming value is SQL `NULL`, while an empty fetched page (`[]`) still overwrites it.
- Stale-write rejection when the incoming `last_edited_time` is `NULL` (INV-4 guard without the `EXCLUDED... IS NULL` bypass).
- Backfill pagination, repeatability, dry run, failure recording, error sanitization.

Not verified (requires owner credentials or infrastructure):

- Calls to the live Notion API: data-source resolution for the real database, page/block fetches,
  rate-limit behaviour, webhook subscription handshake.
- Connection to Neon, applying migrations there, pooled vs direct URL behaviour.
- A publicly reachable HTTPS webhook endpoint and real Notion event delivery.
- Real end-to-end latency and long-running worker/reconciliation behaviour.

## Duplicate implementation cleanup note

Two implementations were developed in parallel in this repository. The class/repository-based
implementation (`db/*-repo.ts`, `sync/notion-client.ts`, `sync/backfill.ts`, `src/server.ts`) is the
surviving source of truth. Orphaned entrypoints and helpers from the other implementation
(`src/app.ts`, `scripts/backfill.ts`, function-style repositories) were removed, and the integration
suites were rebuilt against the surviving APIs instead of being kept as dead code. All tests listed
above target the current APIs.

## Scheduling note

`npm run sync:reconcile` is a **CLI job with no in-process scheduler**. Operators must invoke it from
an external scheduler (cron, systemd timer, Windows Task Scheduler, or a platform scheduler).
`SYNC_RECONCILIATION_INTERVAL_MINUTES` is documented as the recommended cadence only and is not read
by any scheduler in this codebase.

## Blockers / owner actions

`.env` is empty and no required variables are present in the environment. To activate live sync:

1. Set `DATABASE_URL`, `DIRECT_DATABASE_URL`, `NOTION_API_KEY`, `NOTION_DATABASE_ID` (and
   `NOTION_DATA_SOURCE_ID` if the database has multiple data sources) in `.env` or the host.
2. Run `npm run db:migrate`, then `npm run db:migrate -- status` to confirm `0001_init.sql` is applied.
3. Run `npm run sync:backfill -- --dry-run`, review the counts, then run `npm run sync:backfill`.
4. Start the HTTP service (`npm start` or `npm run dev`) on a public HTTPS host.
5. Create the Notion webhook subscription pointing at `https://<host>/webhooks/notion`; read the
   verification token from the handshake log and set `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
6. Run `npm run worker` continuously.
7. Schedule `npm run sync:reconcile` (for example every 30 minutes); use `npm run sync:retry-failed`
   and `npm run sync:recover-stuck` for operator recovery.

## Next action

Supply the credentials above and run `npm run db:migrate` followed by the dry-run backfill. Until that
happens, the live integration must be reported as unverified, regardless of the green local suite.
