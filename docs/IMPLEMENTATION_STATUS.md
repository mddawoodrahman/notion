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

Automated verification is green: **96 tests in 14 files pass**, including **38 tests that run against a
real PostgreSQL 18 server** (embedded, no Docker) rather than mocks. TypeScript typecheck and the
production build both pass.

The service is **not deployed** and has **not** been run against the live Notion API or a Neon database.

## Phase status

| Phase | Implementation | What was actually verified |
|---|---|---|
| 0. Repository audit and plan | complete | Repository inspected; Notion SDK `@notionhq/client@5.27.1` exports and API version `2026-03-11` checked. |
| 1. Config and HTTP scaffold | complete | `validateConfig` rules (production requirements, token/URL shape, timezone) and `/health`, `/ready` covered by unit tests. |
| 2. Schema and migrations | complete | Migration applied to real PostgreSQL; tables, indexes, CHECK constraints, JSONB types, idempotent re-run and checksum-drift detection asserted in `tests/integration/migrations.test.ts`. |
| 3. Notion client and normalization | complete | Normalization and retry/redaction covered with mocked SDK responses. **No live Notion call.** |
| 4. Repositories | complete | Upsert idempotency, INV-4 `last_edited_time` guard, tombstones, out-of-scope flags, inbox dedup, `SKIP LOCKED` claims, lease recovery, run ledger and INV-6 transaction rollback/commit asserted against real PostgreSQL. |
| 5. Initial backfill | complete | Cursor pagination, re-run without duplicates, dry run, partial/failed run recording and secret redaction asserted against real PostgreSQL with a fake Notion client. |
| 6. Webhook receiver and inbox | complete | Handshake, signature verification, envelope validation and durable-enqueue/duplicate paths covered with mocks and Fastify injection. |
| 7. Worker and event processing | complete | Event matrix, INV-2 re-fetch, retry classification and settlement covered with mocks; SQL primitives verified against real PostgreSQL. |
| 8. Reconciliation and operations | complete | Complete-vs-partial scan safety logic and operator scripts covered with mocks. |
| 9. Deployment assets | complete (not deployed) | `docs/DEPLOYMENT_GUIDE.md`, `.env.example`, npm scripts, and a working `dist/src/server.js` build. No hosting was configured. |
| 10. Acceptance | partially verified | 9 mocked end-to-end scenarios in `tests/e2e/acceptance.test.ts` plus the 38 real-database integration tests. Live acceptance (AT-01…AT-14 against Notion/Neon) remains outstanding. |

## Evidence from actual runs (2026-10-21)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, no errors |
| `npx vitest run tests/integration` | 3 files, **38 tests passed** (real PostgreSQL 18 via `embedded-postgres`) |
| `npm test` | 14 files, **96 tests passed**, 0 failed |
| `npm run build` | exit 0; `dist/src/server.js` produced |

## Verified vs. not verified

Verified against a real database:

- Schema, constraints, indexes, JSONB round-tripping, `DATE` vs `TIMESTAMPTZ` semantics.
- Idempotent upserts, stale-write rejection, tombstoning without deletion, out-of-scope retention,
  empty-scan safety, no `DELETE FROM notion_sync.notion_tasks` in `db/` or `sync/`.
- Inbox duplicate handling, concurrent claims, lease recovery, operator requeue.
- Atomic task-write + inbox-settlement commit and rollback.
- Backfill pagination, repeatability, dry run, failure recording, error sanitization.

Not verified (requires owner credentials or infrastructure):

- Calls to the live Notion API: data-source resolution for the real database, page/block fetches,
  rate-limit behaviour, webhook subscription handshake.
- Connection to Neon, applying migrations there, pooled vs direct URL behaviour.
- A publicly reachable HTTPS webhook endpoint and real Notion event delivery.
- Real end-to-end latency and long-running worker/reconciliation behaviour.

## Reconciliation note

Two implementations were developed in parallel in this repository. The class/repository-based
implementation (`db/*-repo.ts`, `sync/notion-client.ts`, `sync/backfill.ts`, `src/server.ts`) is the
surviving source of truth. Orphaned entrypoints and helpers from the other implementation
(`src/app.ts`, `scripts/backfill.ts`, function-style repositories) were removed, and the integration
suites were rebuilt against the surviving APIs instead of being kept as dead code. All tests listed
above target the current APIs.

## Blockers / owner actions

`.env` is empty and no required variables are present in the environment. To activate live sync:

1. Set `DATABASE_URL`, `DIRECT_DATABASE_URL`, `NOTION_API_KEY`, `NOTION_DATABASE_ID` (and
   `NOTION_DATA_SOURCE_ID` if the database has multiple data sources) in `.env` or the host.
2. Run `npm run db:migrate`, then `npm run db:migrate status` to confirm `0001_init.sql` is applied.
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
