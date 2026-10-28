# Deployment and Secret Setup Guide

**Project:** TaskBridge — Notion to PostgreSQL Sync Engine  
**Tagline:** Bridge your tasks. Synchronize with confidence.  
**Runtime:** Python 3.12+ (FastAPI, Uvicorn, Psycopg 3, uv)  
**Release:** V1 (`taskbridge@0.1.0`)

---

## 1. Environment and Secrets Setup

All sensitive credentials must be set in your host's environment or secrets manager (e.g. Render, Railway, Fly.io, AWS ECS, or systemd). **Never commit credentials to source control.**

### Required Variables

| Name | Example / Format | Purpose |
|---|---|---|
| `APP_ENV` (or `NODE_ENV`) | `production` | Enforces strict validation and security modes |
| `PORT` | `3000` | HTTP server listening port |
| `NOTION_API_KEY` | `secret_...` or `ntn_...` | Notion Internal Integration Token with read permissions |
| `NOTION_DATABASE_ID` | `32-char hex UUID` | Master Tasks Database ID in Notion |
| `NOTION_DATA_SOURCE_ID` | `UUID` (optional if DB has 1 source) | Master Tasks Data Source ID |
| `NOTION_VERSION` | `2026-03-11` | Pinned Notion API version |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | `min 32-char string` | Notion Webhook Subscription verification secret (required in production; without it the receiver fails closed with `503`) |
| `ALLOW_UNSIGNED_WEBHOOKS` | `false` | Development-only opt-out of webhook signature verification. Rejected when `APP_ENV=production`. |
| `DATABASE_URL` | `postgresql://...sslmode=require` | Pooled Neon PostgreSQL connection URL for app runtime |
| `DIRECT_DATABASE_URL` | `postgresql://...sslmode=require` | Direct Neon PostgreSQL connection URL for migrations |
| `DB_SSL_INSECURE` | `false` | Development-only opt-out of TLS certificate verification for self-signed local databases. Leave `false` for Neon. |
| `SYNC_TIMEZONE` | `Asia/Kolkata` | IANA timezone used to derive `due_date` for timed due dates |
| `SYNC_RECONCILIATION_INTERVAL_MINUTES`| `30` | Recommended cadence for the **external** reconciliation scheduler (informational; the service has no in-process scheduler) |
| `SYNC_MAX_ATTEMPTS` | `8` | Maximum retry attempts before marking an event failed |
| `SYNC_PAGE_SIZE` | `100` | Pagination page size for Notion queries (max 100) |
| `SYNC_SYNC_BODY_CONTENT` | `true` | Enables serialization of task body blocks |
| `SYNC_LEASE_SECONDS` | `300` | Concurrency lock lease duration for claimed inbox events |
| `LOG_LEVEL` | `info` | Logging verbosity (automatically redacts secrets) |

---

## 2. PostgreSQL & Neon Configuration

### 2.1 Connection URLs
- **Runtime App Traffic:** Use the Neon Pooled connection string (`DATABASE_URL`). It handles pooled serverless connections efficiently.
- **Migrations:** Use the direct Neon connection string (`DIRECT_DATABASE_URL`). Migration advisory locks (`pg_advisory_lock`) require a direct connection.

### 2.2 Least-Privilege Database Role Setup
To run with least privilege in production rather than as superuser/owner:
```sql
-- 1. Create dedicated application role
CREATE ROLE notion_sync_app WITH LOGIN PASSWORD 'your_secure_password';

-- 2. Grant schema usage
GRANT USAGE ON SCHEMA notion_sync TO notion_sync_app;

-- 3. Grant table privileges
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA notion_sync TO notion_sync_app;

-- 4. Grant sequence privileges (for sync_runs identity)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA notion_sync TO notion_sync_app;

-- 5. Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA notion_sync
  GRANT SELECT, INSERT, UPDATE ON TABLES TO notion_sync_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA notion_sync
  GRANT USAGE, SELECT ON SEQUENCES TO notion_sync_app;
```

---

## 3. Database Migration

Run migrations before starting application traffic:
```bash
uv run taskbridge migrate
```
To check migration status:
```bash
uv run taskbridge migrate status
```

---

## 4. Notion Webhook Subscription Setup

1. Deploy the service with public HTTPS. Ensure `GET /health` returns `{"status":"ok"}`.
2. In Notion Developer Portal, create a webhook subscription pointing to:
   `https://<your-deployed-domain>/webhooks/notion`
3. Notion sends an initial verification handshake POST containing:
   `{"verification_token": "secret_..."}`
4. The service logs this token (redacted to last 4 chars) and responds `200 {"ok":true}`.
5. Retrieve the verification token, copy it into your production environment as `NOTION_WEBHOOK_VERIFICATION_TOKEN`, and restart the service.
6. All subsequent deliveries require valid `X-Notion-Signature` HMAC-SHA256 headers. If the token is missing in production the receiver answers `503` and stores nothing (fail-closed).

---

## 5. Process Execution Architecture

For production deployments, three distinct roles should run:

### 1. HTTP Webhook & Health API (FastAPI + Uvicorn)
```bash
# Direct via uv:
uv run uvicorn app.main:app --host 0.0.0.0 --port 3000

# Or via Docker:
docker compose up -d api
```

### 2. Background Sync Worker (Async Queue Consumer)
```bash
# Direct via uv:
uv run taskbridge worker

# Or via Docker:
docker compose up -d worker
```

### 3. Scheduled Reconciliation Job
Run via crontab, cloud cron, Kubernetes CronJob, or Task Scheduler every 30 minutes. The service ships **no in-process scheduler**; if this external trigger is not configured, reconciliation never runs:
```bash
# Direct via uv:
uv run taskbridge reconcile

# Or via Docker:
docker compose run --rm reconcile
```

### Initial Data Import:
Before enabling live webhook traffic or worker, run the initial backfill:
```bash
uv run taskbridge backfill
```
Dry run is also available:
```bash
uv run taskbridge backfill --dry-run
```

---

## 6. Docker & Compose Operations

The repository includes a multi-stage `Dockerfile` and `compose.yaml`:

```bash
# Build production Docker image
docker build -t taskbridge:latest .

# Run Webhook API container
docker run -d \
  --name taskbridge-api \
  -p 3000:3000 \
  --env-file .env \
  taskbridge:latest

# Run Background Worker container
docker run -d \
  --name taskbridge-worker \
  --env-file .env \
  taskbridge:latest taskbridge worker

# Run Reconciliation one-off task
docker run --rm \
  --env-file .env \
  taskbridge:latest taskbridge reconcile

# Alternatively, manage with Docker Compose:
docker compose up -d api worker
docker compose run --rm reconcile
```

---

## 7. Operator Troubleshooting Commands

| Task | CLI / HTTP Command | Description |
|---|---|---|
| **Check Liveness** | `curl http://localhost:3000/health` | HTTP probe (returns 200 without DB dependency) |
| **Check Readiness** | `curl http://localhost:3000/ready` | HTTP probe verifying database connectivity |
| **Check Health Monitor** | `curl http://localhost:3000/health/monitor` | Comprehensive telemetry (uptime, DB latency, pool stats, queue depths, stuck leases, last sync run) |
| **Apply Migrations** | `uv run taskbridge migrate` | Applies pending SQL migrations under advisory lock |
| **Migration Status** | `uv run taskbridge migrate status` | Shows applied vs pending migrations |
| **Backfill Tasks** | `uv run taskbridge backfill` | Executes paginated initial backfill |
| **Backfill Dry-Run** | `uv run taskbridge backfill --dry-run` | Backfill dry run (fetch & normalize, no DB writes) |
| **Manual Reconcile** | `uv run taskbridge reconcile` | Runs full reconciliation scan |
| **Reconcile Dry-Run** | `uv run taskbridge reconcile --dry-run` | Reconciliation dry run |
| **Requeue Failed Events** | `uv run taskbridge retry-failed` | Requeues failed inbox events back to pending |
| **Recover Stuck Leases** | `uv run taskbridge recover-stuck` | Recovers expired worker processing leases |

*(Note: All `taskbridge` CLI commands can also be invoked via the `notion-sync` alias for backwards compatibility).*
