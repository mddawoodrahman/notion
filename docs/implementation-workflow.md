# Implementation Workflow — TaskBridge (Notion Tasks → PostgreSQL Sync Engine)

> **Bridge your tasks. Synchronize with confidence.**

**Purpose:** Build TaskBridge V1 as described in `docs/PRD.md` safely and incrementally.
**Scope:** Notion → PostgreSQL synchronization only. Productivity analytics, reports, Python/Pandas, AI insights, daily snapshots, and task-history analytics are deferred.
**Default stack:** Python 3.12+ (FastAPI, Uvicorn, Psycopg 3, uv), official Notion API, PostgreSQL on Neon, a durable PostgreSQL inbox, background worker, and scheduled reconciliation.

## Operating contract for the AI agent

You are the implementation agent. Do not stop after proposing a plan. Inspect the actual workspace, implement the next valid phase, execute tests, fix failures, update `docs/IMPLEMENTATION_STATUS.md`, and continue to the next phase while gates pass. Keep the work incremental and reversible. If multiple phases can be completed safely in the current session, proceed through them in order rather than asking for confirmation after every phase.

Stop only when a genuine external blocker requires owner action, a destructive action needs approval, a credential is missing and cannot be safely supplied, a security concern is found, or a phase cannot pass its acceptance gate after reasonable investigation. Before stopping, complete all safe work and provide exact commands and the precise missing action.

### Non-negotiable rules

1. Read `docs/PRD.md` and this file before coding. Inspect the current repository and any existing implementation before modifying files.
2. Preserve existing work. Do not overwrite or recreate an existing app, database, migration history, `.env`, or task data without inspecting it first.
3. Never invent credentials, IDs, hosting configuration, or successful test results. Never commit secrets. Use `.env.example` with placeholders and keep `.env` ignored by Git.
4. Notion is the source of truth. V1 is one-way: Notion → PostgreSQL. Do not write task changes back to Notion.
5. Use the Notion page ID as the stable task key. A task must have one row no matter how many Notion views display it.
6. Webhook events are change notifications, not the authoritative full task record. Fetch the latest record from the Notion API before synchronizing its state.
7. Store a valid webhook event durably before acknowledging it. If durable storage fails, return a retryable error rather than a false success.
8. Use cursor pagination for every list/query operation. Handle nested block pagination if task body content is included.
9. Make imports and event processing idempotent. Use parameterized SQL and transactions for related database changes.
10. Handle retries, rate limits, duplicate/out-of-order events, process restarts, archive/trash/restore/move, and partial reconciliation scans explicitly.
11. Keep task-history analytics, permanent business event history (`task_events`), daily snapshots, reporting, charts, and AI analysis out of V1.
12. Do not claim a live Notion/Neon integration is tested until it has been tested with authorized credentials and a real temporary test task. If credentials are absent, write mocked/unit tests and list live tests as blocked.
13. Before adding dependencies or changing the stack, explain why existing project code cannot satisfy the requirement. Prefer small, maintained dependencies and lock versions.
14. Use official, current Notion API documentation to verify the API version, data-source query endpoint, event types, webhook verification and SDK method names before implementation. The PRD's `2026-03-11` version is a starting assumption to verify, not permission to rely on stale SDK signatures.
15. Keep changes scoped to this project. No analytics feature may be added just because the database makes it possible.

## Required implementation status file

Maintain `docs/IMPLEMENTATION_STATUS.md`. At minimum record:

- Current phase and status (`not_started`, `in_progress`, `blocked`, `passed`).
- Files changed and decisions made.
- Commands executed and actual results.
- Test counts and failures.
- Required owner actions, without including secret values.
- Next phase and its entry criteria.

Update the status file after each phase. Do not mark a phase passed unless its acceptance gate is verified.

## Phase 0 — Repository audit and safe plan

**Goal:** Understand the current workspace before changing it.

Actions:
- Inspect the repository root, Git status/branch, existing package manager and lockfile, application files, migrations, tests, deployment configuration and existing environment templates.
- Check whether a Notion sync service already exists; extend it rather than scaffold a duplicate.
- Read `docs/PRD.md`, identify scope conflicts, and document decisions in `docs/IMPLEMENTATION_STATUS.md`.
- Identify which live credentials/IDs are missing. Never print discovered secrets.
- Verify current official Notion API docs and installed SDK support for configured API version, data-source queries, page retrieval, block retrieval, webhooks and webhook signature verification.

Acceptance gate:
- A concrete plan with repo-specific commands and file layout is recorded.
- Existing work and destructive risks are understood.
- No application implementation files were overwritten during the audit.

## Phase 1 — Configuration and backend scaffold

**Goal:** Establish a small maintainable Python / FastAPI service.

Actions:
- Create or update the project using existing conventions. Use Python 3.12+, FastAPI, Uvicorn, Psycopg 3, Pydantic v2, Typer, and environment validation.
- Add scripts for development, build, start, lint/typecheck, tests, database migration, backfill, and reconciliation.
- Add `/health` liveness and `/ready` readiness endpoints; readiness should check essential configuration and database connectivity without leaking internal data.
- Add `.env.example`; ensure `.env`, build artifacts and local secrets are ignored.
- Parse environment variables through one validated configuration module. Required names should include `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `NOTION_DATA_SOURCE_ID`, `NOTION_VERSION`, and `DATABASE_URL`; add webhook variables only when webhook handling is implemented.
- Do not expose secrets to browser/client bundles or logs.

Acceptance gate:
- Service compiles and starts without real secrets only in an explicit non-integrated/test mode; production mode must fail safely when mandatory settings are absent.
- `/health` and configuration tests pass.

## Phase 2 — PostgreSQL schema and migrations

**Goal:** Create only the operational tables needed for V1.

Required tables:

1. `notion_sync.notion_tasks`: one row per Notion page, primary key `notion_page_id`; mapped fields for title, status, list, importance, My Day, priority, date values, custom archive state, Notion archive/trash state, URL, Notion timestamps, `raw_properties JSONB`, and `synced_at`.
2. `notion_sync.sync_inbox`: unique webhook event ID, type, entity ID, timestamp, payload JSONB, state, attempts, received/processed timestamps, retry time/claim information if used, and a sanitized last error.
3. `notion_sync.sync_runs`: backfill/reconciliation run type, status, times, record count, and sanitized error details.

Actions:
- Inspect for an existing schema first; do not recreate tables blindly.
- Add versioned forward migrations and documented rollback guidance. Avoid automatic destructive down migrations in production.
- Add practical indexes for task status, list, due date and queue selection if those fields exist.
- Keep date-only due dates as SQL `DATE`; use `TIMESTAMPTZ` only for actual instants.
- Preserve full source properties in JSONB. If PRD-approved page body sync is implemented, add a dedicated JSONB column for serialized blocks and paginate all block children. Do not download binaries in V1.
- Create least-privilege database access guidance; do not use the database owner role as the application runtime role in production.

Acceptance gate:
- Migrations apply to a fresh test database and to the intended development database without data loss.
- Schema constraints enforce event and task identity.
- Tests verify migration shape and JSON/date handling.

## Phase 3 — Notion client and normalization

**Goal:** Safely read tasks from the intended data source and convert API response shapes to the DB model.

Actions:
- Implement a single Notion client module with pinned/verified API version and centralized error/rate-limit handling.
- Confirm that the configured database contains/points to the configured data source. Never guess IDs or query the whole workspace.
- Query the current documented data-source endpoint using cursor pagination (`has_more`/`next_cursor` or the current SDK's equivalent).
- Retrieve a task page by page ID. If body block sync is enabled, recursively paginate children and preserve block IDs/types; respect access permissions and API limits.
- Normalize title, status, select/multi-select, checkbox, date range/time-zone values, page URL, created time, last edited time, archive/trash/move metadata, and raw properties.
- Handle missing, null, empty, unknown and newly added property types without crashing the entire run. Preserve the untouched source response in JSONB when appropriate.
- Add retries for transient errors and rate limits; honor `Retry-After` when supplied. Avoid unbounded retries on permission or schema errors.

Acceptance gate:
- Unit tests cover representative Notion property types, date-only vs timed dates, empty/missing fields, unknown properties, pagination and API errors.
- No secrets or full task content appear in error logs.

## Phase 4 — Idempotent task repository

**Goal:** Implement safe insert/update behavior before importing data.

Actions:
- Implement parameterized SQL and an upsert keyed by `notion_page_id`.
- A repeat sync must update the existing row, not duplicate it.
- Define deterministic semantics for page archive, page trash, restoration and moving outside the configured data source. Prefer tombstones/flags over physical deletes so synchronization remains recoverable.
- Avoid treating a user-defined `Archived` checkbox as the same thing as Notion page archival or trash.
- Use transactions for a task write plus the related inbox processing state so a crash does not leave an event marked processed before the task write commits.
- Ensure out-of-order webhook deliveries cannot regress state. Prefer fetching the latest source page before each upsert; use `last_edited_time` guards where safe and understood.

Acceptance gate:
- Integration tests prove repeated upsert produces one row, updates the right fields, preserves unknown JSON properties and applies archive/restore semantics.

## Phase 5 — Initial backfill command

**Goal:** Import all accessible tasks before enabling live events.

Actions:
- Add a CLI command for initial backfill.
- Validate credentials and source access; record a `sync_runs` entry.
- Fetch pages until pagination is complete; do not stop after the first API response.
- Normalize and upsert in bounded batches with controlled concurrency.
- Make the command resumable/re-runnable; record successful and failed counts. Do not silently declare a partial run successful.
- Keep task-page body sync within the explicit permission and scope in the PRD.
- Provide a dry-run/summary mode if feasible.

Acceptance gate:
- Mocked tests verify cursor pagination and continuation after page boundaries.
- A second backfill creates no duplicates.
- With authorized credentials, compare source count and target unique page IDs. If the credentials are missing, report live verification as blocked rather than fabricated.

## Phase 6 — Secure webhook receiver and durable inbox

**Goal:** Persist valid notifications reliably before returning success.

Actions:
- Implement the HTTPS `/webhooks/notion` route using raw request bytes for signature verification.
- Implement the official initial subscription-verification handshake and securely store the verification token.
- Verify subsequent signatures using the official SDK helper or a correct HMAC-SHA256 implementation against the exact raw body. Reject invalid signatures without database task mutations.
- Validate event schema and required IDs. Store the event by unique event ID in `sync_inbox`.
- Return success only after the database transaction storing a valid event commits. On DB failure, return retryable non-2xx.
- Detect duplicate deliveries idempotently. Respond appropriately to unsupported but valid event types and avoid infinite retries for permanent errors.
- Never trust webhook payload properties as the full latest task state.

Acceptance gate:
- Tests cover the subscription handshake, valid/invalid signatures, raw-body handling, duplicate event IDs, malformed payloads, database write failure and response codes.

## Phase 7 — Background worker and event processing

**Goal:** Convert stored events into synchronized task state.

Actions:
- Add a worker that safely claims pending inbox rows; use transactionally safe claiming such as `FOR UPDATE SKIP LOCKED` if multiple workers may run.
- Fetch current page/source state from the Notion API, then normalize and upsert it.
- Handle page created/updated/content updated/deleted/undeleted/moved and data-source schema/content events according to official event semantics. If an event affects the data source but does not identify a specific task, trigger a safe scoped reconciliation rather than guessing.
- Commit task state and processed event status consistently. If external fetch happens before the database transaction, ensure a failed upsert leaves the event retryable.
- Retry transient network, rate-limit, and database failures with exponential backoff and jitter; honor retry headers; cap retries and expose dead/failed events.
- Support graceful shutdown and worker restart; do not drop in-flight events.
- Prevent infinite event loops if an event type is not relevant to the configured task source.

Acceptance gate:
- Tests prove event replay does not duplicate tasks; temporary failure is retried; worker restart recovers pending work; permanent permission/not-found errors are surfaced; a task edit updates PostgreSQL state.

## Phase 8 — Reconciliation and operations

**Goal:** Recover missed event deliveries and expose service health.

Actions:
- Add an idempotent scheduled reconciliation command that fully paginates the configured source and upserts current state.
- Only compare/remediate deletions or out-of-scope pages after a complete successful scan. Never mark pages deleted based on an interrupted or partial scan.
- Add `sync_runs` start/success/failure and counts; sanitize error text.
- Add liveness/readiness endpoints, structured logs, useful counters, retry visibility and a simple operator guide.
- Document a safe manual replay/reconciliation command.
- Keep reconciliation frequency configurable; do not hardcode a provider limit or schedule that cannot be changed.

Acceptance gate:
- Re-running reconciliation causes no duplicates or destructive changes.
- A missed/failed event is corrected by reconciliation.
- A partial scan cannot trigger mass tombstoning.
- Health/readiness states are accurate.

## Phase 9 — Deployment and secret setup

**Goal:** Run the backend securely in a real environment.

Actions:
- Deploy the API/worker to a suitable host with a public HTTPS endpoint. Use separate processes/services if the platform requires it for background work.
- Configure runtime secrets in the host's secret manager/dashboard, never in source control.
- Use Neon SSL/TLS and the appropriate pooled runtime connection string where suitable. Use a controlled direct connection for migrations if needed.
- Run migrations once with an appropriate migration role. Configure application runtime role with only necessary table/sequence privileges.
- Create/verify Notion webhook subscription against the deployed URL only after the receiver is available and verified.
- Configure a durable worker and scheduled reconciliation using platform-supported services. Confirm how restarts, sleeping services, timeouts and job limits behave.
- Configure minimal alerts/logging for repeated failures and stale last-sync time without leaking task content/secrets.
- Document rollback/redeploy procedure.

Acceptance gate:
- HTTPS webhook is reachable; signature check works; actual environment variables are present without being printed; database TLS works; the app does not expose secrets in logs.

## Phase 10 — End-to-end acceptance and handover

**Goal:** Prove V1 works with a real, temporary authorized task.

Execute and record actual results for:
1. Initial import imports all intended records.
2. A second import does not duplicate records.
3. Creating a Notion task creates one PostgreSQL row.
4. Editing title/status/priority/date updates that row.
5. Toggling Important and My Day updates the correct booleans and does not mutate List.
6. Completing and reopening updates the current status.
7. User-archiving a task remains distinct from Notion page archive/trash.
8. Trash/delete and restore are represented according to the tombstone policy.
9. Duplicate and out-of-order events do not duplicate or regress current task state.
10. A simulated PostgreSQL outage does not cause a false webhook success.
11. Worker restart recovers pending events.
12. Reconciliation repairs a deliberately missed event and a partial scan is safe.
13. Runtime logs and repository contain no secrets.
14. Typecheck, lint, unit tests and integration tests pass.

Clean up the temporary test task in Notion and verify the expected PostgreSQL tombstone/state. Do not hard-delete historical task rows unless the documented policy explicitly calls for it.

Deliver a concise handover containing:
- Implemented architecture and repository tree.
- Environment variables needed (names only; never values).
- Setup and migration commands.
- Backfill, worker, webhook and reconciliation commands.
- Test commands/results.
- Deployment and rollback instructions.
- Any owner actions still needed to authorize Notion or configure Neon/hosting.
- A list of deferred analytics work, clearly marked out of scope.

## Definition of done

V1 is done only when all P0 requirements in `docs/PRD.md` are implemented, all automated tests pass, live Notion-to-PostgreSQL tests are verified (or explicitly marked blocked by missing external access), a reconciliation run succeeds, and `docs/IMPLEMENTATION_STATUS.md` reflects the real result. No analytics/reporting feature is required or permitted as a V1 acceptance item.
