# Project Instructions — Notion Tasks PostgreSQL Sync

## Source documents

- Read `docs/PRD.md` for the product requirements.
- Read `docs/implementation-workflow.md` for the mandatory step-by-step build protocol.
- Maintain `docs/IMPLEMENTATION_STATUS.md` as truthful implementation progress.

## Project boundaries

- V1 is a one-way sync: Notion Tasks data source → PostgreSQL on Neon.
- Notion is the task-editing source of truth; PostgreSQL stores the synchronized current state.
- Use Node.js + TypeScript and the official Notion API/SDK, unless the existing repo gives a compelling reason not to.
- No productivity analytics, `task_events`, daily snapshots, reports, Python/Pandas, AI insights or new task UI in V1.

## Required behavior

- Audit before editing; preserve existing code, data, migrations and credentials.
- Implement one phase at a time; run focused checks after each phase and continue only when its acceptance gate passes.
- Update `docs/IMPLEMENTATION_STATUS.md` after each phase.
- Use the Notion page ID as task identity; use cursor pagination and idempotent PostgreSQL upserts.
- Webhook handler verifies signatures over the exact raw body and durably stores event IDs before acknowledging.
- Worker fetches the current Notion page rather than treating an event payload as a full record.
- Include retries, rate-limit handling, tombstones for deletion, scheduled reconciliation and safe recovery from partial scans.
- Keep source properties in JSONB; use parameterized SQL and transactions.
- Never invent credentials, identifiers or test outcomes. Never commit `.env` or secrets.
- If credentials are absent, implement everything safe and test with mocks, then report the precise live-integration blocker.
- Do not delete, overwrite, reset, or migrate existing data destructively without authorization.
- Verify current official Notion API documentation and SDK signatures before relying on endpoint/version behavior.

## Expected commands

Adapt to the actual repository and package manager; do not assume commands exist until checking package scripts. Expected lifecycle: install, migrate, dev, typecheck, lint, unit test, integration test, backfill, worker, reconciliation, build, production start.
