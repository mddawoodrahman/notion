# Deployment and Secret Setup Guide

**Project:** Notion Tasks → PostgreSQL Synchronization Service  
**Release:** V1

---

## 1. Environment and Secrets Setup

All sensitive credentials must be set in your host's environment or secrets manager (e.g. Render, Railway, Fly.io, Vercel, or systemd). **Never commit credentials to source control.**

### Required Variables

| Name | Example / Format | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Enforces strict validation and security modes |
| `PORT` | `3000` | HTTP server listening port |
| `NOTION_API_KEY` | `secret_...` or `ntn_...` | Notion Internal Integration Token with read permissions |
| `NOTION_DATABASE_ID` | `32-char hex UUID` | Master Tasks Database ID in Notion |
| `NOTION_DATA_SOURCE_ID` | `UUID` (optional if DB has 1 source) | Master Tasks Data Source ID |
| `NOTION_VERSION` | `2026-03-11` | Pinned Notion API version |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | `min 32-char string` | Notion Webhook Subscription verification secret (required in production; without it the receiver fails closed with `503`) |
| `ALLOW_UNSIGNED_WEBHOOKS` | `false` | Development-only opt-out of webhook signature verification. Rejected when `NODE_ENV=production`. |
| `DATABASE_URL` | `postgresql://...sslmode=require` | Pooled Neon PostgreSQL connection URL for app runtime |
| `DIRECT_DATABASE_URL` | `postgresql://...sslmode=require` | Direct Neon PostgreSQL connection URL for migrations |
| `DB_SSL_INSECURE` | `false` | Development-only opt-out of TLS certificate verification for self-signed local databases. Leave `false` for Neon. |
| `SYNC_TIMEZONE` | `Asia/Kolkata` | IANA timezone used to derive `due_date` for timed due dates |
| `SYNC_RECONCILIATION_INTERVAL_MINUTES`| `30` | Recommended cadence for the **external** reconciliation scheduler (informational; the service has no in-process scheduler) |
| `SYNC_MAX_ATTEMPTS` | `8` | Maximum retry attempts before marking an event failed |
| `SYNC_PAGE_SIZE` | `100` | Pagination page size for Notion queries (max 100) |
| `SYNC_SYNC_BODY_CONTENT` | `true` | Enables serialization of task body blocks |
| `SYNC_LEASE_SECONDS` | `300` | Concurrency lock lease duration for claimed inbox events |
| `LOG_LEVEL` | `info` | Logging verbosity (Pino automatically redacts secrets) |

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
npm run db:migrate
```
To check status:
```bash
npm run db:migrate -- status
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

For production deployments, three roles should run:

1. **HTTP Webhook & Health API:**
   ```bash
   npm start
   # or node dist/src/server.js
   ```
2. **Background Sync Worker:**
   ```bash
   npm run worker
   # or node dist/scripts/sync-worker.js
   ```
3. **Scheduled Reconciliation Job:**
   Run via crontab, cloud cron, or Kubernetes CronJob every 30 minutes. The service ships **no in-process scheduler**; if this external trigger is not configured, reconciliation never runs:
   ```bash
   npm run sync:reconcile
   # or node dist/scripts/sync-reconcile.js
   ```

### Initial Data Import:
Before enabling live traffic or worker, run the initial backfill:
```bash
npm run sync:backfill
```
Dry run is also available:
```bash
npm run sync:backfill -- --dry-run
```

---

## 6. Operator Troubleshooting Commands

- **Check Health:** `curl https://<domain>/health`
- **Check Readiness:** `curl https://<domain>/ready`
- **Requeue Failed Events:** `npm run sync:retry-failed`
- **Recover Stuck Leases:** `npm run sync:recover-stuck`
- **Manual Reconciliation:** `npm run sync:reconcile`
