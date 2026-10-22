# AGENTS.md — Notion Tasks → PostgreSQL Sync

V1 is a one-way sync from a Notion Tasks data source into PostgreSQL (schema `notion_sync`). Notion is the editing source of truth; PostgreSQL is a read-optimized replica. `docs/IMPLEMENTATION_STATUS.md` records what has actually been verified; live Notion/Neon behavior is still unverified, so never infer live success from a green local suite.

## Read first

- `docs/implementation-workflow.md` — phased protocol and acceptance gates; follow it.
- `docs/PRD.md`, `docs/Notion_to_PostgreSQL_Sync_SPEC.md` — requirements and engineering contracts.
- `docs/IMPLEMENTATION_STATUS.md` — current evidence and blockers; update it after every phase.
- `.opencode/commands/build-notion-sync.md`, `.agents/skills/notion-postgres-sync/SKILL.md` — existing resume/phase workflows.

## Commands (run from repo root)

Requires Node >=22 and npm (`package-lock.json` is the lockfile).

```bash
npm install
npm run typecheck
npm run lint
npm test                 # all suites
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run dev              # HTTP receiver only
npm start                # requires npm run build first
npm run worker           # separate process from the HTTP receiver
npm run db:migrate
npm run db:migrate -- status
npm run sync:backfill -- --dry-run
npm run sync:backfill
npm run sync:reconcile -- --dry-run
npm run sync:reconcile
npm run sync:retry-failed
npm run sync:recover-stuck
```

Before claiming completion: `npm run typecheck && npm run lint && npm test`. For a focused loop, use `npx vitest run tests/unit/worker.test.ts` (add `-t "test name"` to filter). `npm test` boots three throwaway PostgreSQL clusters and runs files serially, so it is not a fast unit-only loop. On Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked.

## Runtime and layout

- `src/server.ts` — Fastify HTTP app (`/health`, `/ready`, `/webhooks/notion`); `routes/` handlers; `src/config.ts` Zod env validation; `src/logger.ts` and `src/errors.ts` redaction.
- `db/` — `pg` pool, `withTransaction`, repositories, migration runner. `sync/` — Notion client, normalization, worker, backfill, reconcile. `scripts/` — CLI entrypoints; `migrations/` — numbered SQL.
- HTTP receiver and worker are separate: `npm run dev` / `npm start` do **not** start the worker. Run `npm run worker` too.
- No in-process scheduler. `sync:reconcile` must be scheduled externally (cron, systemd, Task Scheduler).
- `npm run build` emits to `dist/`; `rootDir` is `.`, so the production entry is `dist/src/server.js` and `npm start` needs a build first. `dist/` is generated and gitignored — edit source, not build output.
- ESM + `module: NodeNext`: relative imports in TS must keep the `.js` suffix. `package.json` is `"type": "module"`.
- `@neon/config` and `@neon/env` are installed but not runtime-imported; database access uses `pg` directly.

## Config and environment

- All `package.json` scripts load `.env` via `--env-file-if-exists=.env`; ad-hoc `tsx`, `node`, or `npx vitest` invocations do not. The `db:migrate`, `sync:*`, `worker`, `dev`, and `start` commands therefore need a configured `.env` for live work.
- Outside `NODE_ENV=test`, config requires `DATABASE_URL`, `NOTION_API_KEY`, and `NOTION_DATABASE_ID`; production also requires `NOTION_WEBHOOK_VERIFICATION_TOKEN`. `NODE_ENV=test` supplies placeholders only.
- `NOTION_VERSION` is pinned by a Zod literal to `2026-03-11`; changing it requires a config change and verification against official Notion docs.
- Runtime should use the pooled Neon `DATABASE_URL`; `db:migrate` uses `DIRECT_DATABASE_URL` when set because session advisory locks fail through a transaction pooler.
- `ALLOW_UNSIGNED_WEBHOOKS` and `DB_SSL_INSECURE` are development-only escape hatches; production rejects unsigned webhooks and verifies TLS by default.
- `TEST_DATABASE_URL` is accepted by config but not used by the integration suites — they always boot embedded PostgreSQL.

## Invariants that must not regress

- No physical deletes from `notion_sync.notion_tasks`. Trash/deletion is `notion_in_trash = true`; a vanished page is `is_in_source = false`.
- Webhooks are change signals only. The worker re-fetches the page from Notion and upserts the task plus settles the inbox row in one `withTransaction`.
- Preserve the INV-4 stale-write guard exactly: an older or `NULL` `notion_last_edited_time` must not overwrite a newer row. Do not reintroduce an `EXCLUDED... IS NULL` bypass.
- Reconciliation may set `is_in_source = false` only after a complete, uncapped scan (`request_status.type !== "incomplete"`) with zero page failures. Partial scans never imply deletion.
- Webhook signatures verify over the exact raw body; keep the `parseAs: "buffer"` parser in `src/server.ts`. Missing token fails closed with `503`.
- Keep every query parameterized, the Notion page ID as the primary key, raw properties in JSONB, block recursion at 3 levels, and page size at 100 max.
- Never log or commit secrets; never invent credentials, identifiers, or test results.

## Migrations and data

- Add a new numbered file (`migrations/000N_description.sql`); never edit an applied migration — SHA-256 checksum drift aborts `db:migrate`.
- Migrations run in a transaction under a PostgreSQL advisory lock; the schema is `notion_sync`.
- In the task upsert, `page_content_json = COALESCE($19::jsonb, stored)`: SQL `NULL` preserves existing content, while `[]` overwrites it. Pass null when blocks were not fetched.
- Active-task queries exclude `is_in_source = false`, `notion_in_trash = true`, and `user_archived = true` unless deliberately inspecting inactive rows.

## Testing

- `tests/unit` uses mocks; `tests/e2e` uses an in-memory harness (wiring/control flow only, not SQL); `tests/integration` runs against real embedded PostgreSQL 18 with no Docker and no external database.
- Vitest runs files serially (`fileParallelism: false`) because each integration suite starts its own cluster.
- `tests/` is included in `tsconfig`, so `npm run typecheck` also checks tests.
- No CI workflow is checked in; the local commands above are the verification gates.
- Exact suite counts and dates belong in `docs/IMPLEMENTATION_STATUS.md`; re-run commands and record real output instead of copying stale numbers from README or status.

## V1 scope guardrails

No two-way sync, analytics/dashboards/reports, `task_events`, daily snapshots, Python/Pandas/AI insights, new task UI, or attachment binaries.

## Work protocol

- Audit before editing; preserve existing code, data, migrations, and credentials.
- Implement one phase at a time, run its acceptance gate, then update `docs/IMPLEMENTATION_STATUS.md` with files, commands, actual results, and blockers.
- If live credentials are unavailable, implement safe local work with mocks and state the precise blocker. Do not perform destructive database changes without authorization.
