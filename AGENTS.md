# AGENTS.md — Notion Tasks → PostgreSQL Sync

V1 is a high-reliability, one-way synchronization engine from a Notion Tasks data source into PostgreSQL (schema `notion_sync`). Notion is the editing source of truth; PostgreSQL is a read-optimized replica. Built exclusively with Python 3.12+, FastAPI, Uvicorn, Psycopg 3, Pydantic v2, Typer, and uv.

## Read first

- `docs/implementation-workflow.md` — phased protocol and acceptance gates; follow it.
- `docs/PRD.md`, `docs/Notion_to_PostgreSQL_Sync_SPEC.md` — requirements and engineering contracts.
- `docs/IMPLEMENTATION_STATUS.md` — current evidence and verification status; update it after every phase.
- `docs/DEPLOYMENT_GUIDE.md` — deployment, environment configuration, and operation guide.

## Commands (run from repo root)

Requires Python >=3.12 and [uv](https://github.com/astral-sh/uv) (`pyproject.toml` and `uv.lock` are the lockfile and manifest).

```powershell
# Dependencies & Quality Gates
uv sync --all-extras --dev
uv run ruff check app tests
uv run ruff format --check app tests
uv run mypy app tests
uv run pytest                        # all suites (140 tests)
uv run pytest tests/unit             # unit suite
uv run pytest tests/integration      # integration suite against real PostgreSQL
uv run pytest tests/e2e              # end-to-end acceptance suite

# Services
uv run uvicorn app.main:app --port 3000   # HTTP webhook receiver and health API
uv run notion-sync worker                 # background async worker (separate process)

# Migrations & CLI Operations
uv run notion-sync migrate                # apply database migrations
uv run notion-sync migrate status         # inspect applied vs pending migrations
uv run notion-sync backfill --dry-run     # backfill preview (fetch + normalize only)
uv run notion-sync backfill               # initial paginated database backfill
uv run notion-sync reconcile --dry-run    # scheduled reconciliation dry-run
uv run notion-sync reconcile              # scheduled full reconciliation scan
uv run notion-sync retry-failed           # requeue failed webhook events to pending
uv run notion-sync recover-stuck          # recover expired worker processing leases
```

Before claiming completion: `uv run ruff check app tests && uv run ruff format --check app tests && uv run mypy app tests && uv run pytest`.

## Runtime and layout

- `app/main.py` — FastAPI application factory, routing (`/health`, `/ready`, `/webhooks/notion`), and Uvicorn entrypoint.
- `app/lifespan.py` — connection pool lifecycle context manager.
- `app/config.py` — Pydantic Settings environment configuration with validation and secret sanitization.
- `app/logging_config.py` — structured JSON logging with automatic secret token redaction.
- `app/errors.py` — custom application error classes and message sanitizer.
- `app/api/` — API route handlers (`health.py`, `webhooks.py`).
- `app/db/` — Psycopg 3 connection pooling (`pool.py`), transactional migration runner (`migrate.py`), and repositories (`inbox_repo.py`, `tasks_repo.py`, `runs_repo.py`).
- `app/sync/` — Notion API client (`notion_client.py`), task normalization (`normalize.py`, `property_map.py`), async worker (`worker.py`), backfill (`backfill.py`), reconciliation (`reconcile.py`), and exponential backoff retry policy (`retry_policy.py`).
- `app/cli/` — Typer CLI entrypoints (`main.py`, `worker.py`, `backfill.py`, `reconcile.py`, `retry_failed.py`, `recover_stuck.py`).
- `migrations/` — numbered transactional SQL migration files (`0001_init.sql`).
- `tests/` — Pytest test suites (`unit/`, `integration/`, `e2e/`, `conftest.py`).
- HTTP receiver and worker are separate processes: starting the API does **not** start the worker. Run `uv run notion-sync worker` concurrently.
- No in-process scheduler: `notion-sync reconcile` must be scheduled externally (cron, systemd timer, Windows Task Scheduler, Kubernetes CronJob).

## Config and environment

- Environment variables are loaded automatically from `.env` via `python-dotenv` (outside `APP_ENV=test`).
- `APP_ENV` (or `NODE_ENV` fallback): `development`, `test`, or `production`.
- Outside `APP_ENV=test`, config requires `DATABASE_URL`, `NOTION_API_KEY`, and `NOTION_DATABASE_ID`; production also requires `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
- `NOTION_VERSION` is pinned to `2026-03-11`.
- Runtime uses pooled Neon `DATABASE_URL`; `notion-sync migrate` uses `DIRECT_DATABASE_URL` when set because session advisory locks require direct connections.
- `ALLOW_UNSIGNED_WEBHOOKS` and `DB_SSL_INSECURE` are development-only escape hatches; production rejects unsigned webhooks and enforces verified TLS.
- `TEST_DATABASE_URL` is accepted for integration testing against an external database, but defaults to ephemeral local PostgreSQL instances.

## Invariants that must not regress

- **INV-1 (Stable Identity):** Exactly one row per Notion page UUID in `notion_sync.notion_tasks`. No physical deletes (`DELETE FROM notion_tasks` is prohibited). Trash is `notion_in_trash = true`; vanished page is `is_in_source = false`.
- **INV-2 (Authoritative Source):** Webhook payloads are lightweight change signals. The worker re-fetches authoritative page and block state from Notion before upserting.
- **INV-3 (Durable Ingestion):** Webhook events are committed to `sync_inbox` before returning `200 OK`. If database is unreachable, return `503`.
- **INV-4 (Protection against Out-of-Order Events):** Stale writes are rejected by checking `WHERE notion_tasks.notion_last_edited_time IS NULL OR EXCLUDED.notion_last_edited_time >= notion_tasks.notion_last_edited_time`. An older or NULL timestamp must never overwrite a newer row.
- **INV-5 (Safe Reconciliation):** Reconciliation marks tasks `is_in_source = false` only after a provably complete, uncapped scan with zero page failures. Partial or failed scans never imply deletion.
- **INV-6 (Atomic Updates):** Task row upsert and inbox event settlement occur in the same database transaction.
- **INV-7 (Absolute Secret Redaction):** Secrets and tokens are never logged, formatted into exception strings, or committed.

## Testing

- `tests/unit/`: fast unit tests with mocks.
- `tests/integration/`: real PostgreSQL tests with transactional migrations, concurrency, and advisory locks.
- `tests/e2e/`: full lifecycle acceptance flow with an in-memory harness.
- Verification gates: `uv run ruff check app tests && uv run ruff format --check app tests && uv run mypy app tests && uv run pytest`.

## V1 scope guardrails

No two-way sync, analytics/dashboards/reports, `task_events`, daily snapshots, ML/AI categorization models, or attachment binaries.
