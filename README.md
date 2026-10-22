# Notion Tasks → PostgreSQL Synchronization Service (`notion-tasks-pg-sync`)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18%20(Neon)-blue.svg)](https://neon.tech/)
[![Fastify](https://img.shields.io/badge/Fastify-5.12-black.svg)](https://fastify.dev/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2026--03--11-lightgrey.svg)](https://developers.notion.com/)
[![Tests](https://img.shields.io/badge/Tests-128%20passed%20(16%20suites)-brightgreen.svg)](tests/)

A robust, production-grade, one-way synchronization engine that replicates a Microsoft To Do–inspired Notion task database to a dedicated PostgreSQL database on Neon.

**Developer & Project Lead:** Dawood Rahman ([@mddawoodrahman](https://github.com/mddawoodrahman))  
**Repository:** [github.com/mddawoodrahman/notion](https://github.com/mddawoodrahman/notion)

---

## Table of Contents

- [1. Project Overview & Philosophy](#1-project-overview--philosophy)
- [2. Features & Capabilities](#2-features--capabilities)
- [3. Architectural Invariants](#3-architectural-invariants)
- [4. Technology Stack](#4-technology-stack)
- [5. System Architecture](#5-system-architecture)
  - [5.1 Ingestion Flow (Webhooks)](#51-ingestion-flow-webhooks)
  - [5.2 Asynchronous Worker Flow](#52-asynchronous-worker-flow)
  - [5.3 Backfill & Reconciliation Flow](#53-backfill--reconciliation-flow)
  - [5.4 Architectural Diagram](#54-architectural-diagram)
- [6. Project Directory Structure](#6-project-directory-structure)
- [7. Prerequisites](#7-prerequisites)
- [8. Installation & Setup](#8-installation--setup)
- [9. Environment Variables](#9-environment-variables)
- [10. Operational Commands & Scripts](#10-operational-commands--scripts)
- [11. Database & Data Architecture](#11-database--data-architecture)
  - [11.1 Schema Overview](#111-schema-overview)
  - [11.2 Tables & Responsibilities](#112-tables--responsibilities)
  - [11.3 Property Normalization Mapping](#113-property-normalization-mapping)
  - [11.4 Soft Deletion & Out-of-Scope Flags](#114-soft-deletion--out-of-scope-flags)
  - [11.5 Least-Privilege Database Role Setup](#115-least-privilege-database-role-setup)
- [12. API & Integration Documentation](#12-api--integration-documentation)
- [13. Testing & Verification](#13-testing--verification)
- [14. Production Deployment Topology](#14-production-deployment-topology)
- [15. Troubleshooting & Operational Runbook](#15-troubleshooting--operational-runbook)
- [16. Security & Operational Notes](#16-security--operational-notes)
- [17. Known Limitations & Roadmap](#17-known-limitations--roadmap)
- [18. Project Documentation Index & License](#18-project-documentation-index--license)

---

## 1. Project Overview & Philosophy

The **Notion Tasks → PostgreSQL Synchronization Service** (`notion-tasks-pg-sync`) is designed to solve a specific, high-stakes operational problem: **Notion is an exceptional user interface for personal task planning, but a poor backend for high-frequency queries, multi-system automations, and relational integrations.**

This service provides an automated, resilient, and verifiable bridge between a personal Notion task database (structured with Microsoft To Do semantics like Lists, Importance, "My Day", and Priority) and a serverless PostgreSQL instance on Neon.

### Core Tenets

- **Single System of Record:** Notion is the **only** place where tasks are created, modified, completed, categorized, or deleted. PostgreSQL is an authoritative, normalized, read-optimized replica of the current state.
- **Asynchronous, Durable Ingestion:** Webhook events are captured into a durable PostgreSQL inbox within milliseconds and acknowledged immediately. Processing occurs asynchronously via worker loops, isolating Notion from downstream delays.
- **Verification First:** The codebase enforces strict type safety, transaction boundaries, idempotent writes, and zero-mock database testing against a real embedded PostgreSQL 18 cluster.
- **Zero Destructive Deletions:** Vanished or trashed tasks are never physically deleted (`DELETE FROM notion_tasks` does not exist anywhere in the application). Changes are tracked via boolean status flags (`notion_in_trash`, `is_in_source`).

---

## 2. Features & Capabilities

### Implemented V1 Features

- **Real-Time Webhook Receiver:** Fastify 5 HTTP server receiving Notion webhook notifications at `/webhooks/notion`. Validates HMAC-SHA256 signatures over raw buffer payloads using `@notionhq/client`'s `verifyWebhookSignature`.
- **Automated Verification Handshake:** Supports Notion's initial subscription verification handshake by logging the incoming `verification_token` and returning `200 {"ok":true}`.
- **Durable Inbox (`sync_inbox`):** Persists raw incoming events before acknowledging delivery. Deduplicates multiple deliveries idempotently using `ON CONFLICT (event_id) DO NOTHING`.
- **Concurrency-Safe Background Worker:** Dequeues pending inbox events using `FOR UPDATE SKIP LOCKED`, preventing race conditions across multiple worker instances.
- **Authoritative Notion State Re-Fetch (INV-2):** Treats webhook payloads as lightweight change notifications; fetches fresh page objects and block contents directly from Notion before performing updates.
- **Atomic Transaction Commit (INV-6):** Synchronizes task row updates and inbox status transitions (`processed`) within the same PostgreSQL transaction.
- **Out-of-Order Delivery Protection (INV-4):** SQL upsert guard comparing `notion_last_edited_time` ensures older webhook deliveries never overwrite newer records.
- **Rich Task Normalization:** Maps Notion properties (Title, Status, List, Important, In My Day, Priority, Due Date/At, Reminder, custom user Archived checkbox) into native PostgreSQL datatypes (`DATE`, `TIMESTAMPTZ`, `BOOLEAN`, `TEXT`).
- **IANA Timezone Awareness:** Computes localized task deadlines using configurable timezone settings (default: `Asia/Kolkata`).
- **Recursive Body Content Serialization:** Extracts and nests up to 3 levels of Notion page body blocks, stored as structured JSONB (`page_content_json`).
- **Initial Paginated Backfill:** Cursor-paginated ingestion CLI (`sync:backfill`) capable of syncing thousands of existing tasks with built-in infinite cycle detection and dry-run mode (`--dry-run`).
- **Full Reconciliation Engine:** Full-scan sweep CLI (`sync:reconcile`) that repairs missed webhook events and marks vanished tasks as `is_in_source = false` only if the scan completes with 100% success, 0 page failures **and an uncapped result set** (INV-5). It is designed to be invoked by an **external scheduler** (cron / systemd timer / platform scheduler) — the service does not self-schedule.
- **Self-Healing Operations:** CLI tools to recover stuck worker leases (`sync:recover-stuck`) and requeue failed events back to pending status (`sync:retry-failed`).
- **Idempotent Migration Runner:** Transactional database migration runner (`db:migrate`) with PostgreSQL advisory locks (`pg_advisory_lock`) and SHA-256 checksum-drift detection.
- **Zero-Docker Real Database Tests:** 41 integration tests executed against real local PostgreSQL 18 instances via `embedded-postgres` (zero database mocks), plus 9 acceptance tests that drive the full flow against an in-memory harness (see [Section 13](#13-testing--verification)).

### Strict V1 Scope Exclusions (Non-Goals)

To prevent architectural bloat and maintain operational reliability, the following features are explicitly excluded from V1:
- ❌ **No Two-Way Synchronization:** No task mutations from PostgreSQL back to Notion.
- ❌ **No Productivity Dashboards / Charts:** No SQL reporting views, KPI counters, or BI widgets.
- ❌ **No Historical Audit Tables:** No `task_events` or `daily_task_snapshots`.
- ❌ **No Python / Pandas / AI Pipelines:** No ML categorization models or LLM summarization.
- ❌ **No Binary Asset Storage:** No local caching or binary blob downloading of Notion file attachments.

---

## 3. Architectural Invariants

Any modification to this codebase must preserve these 7 foundational invariants:

| Invariant | Code | Enforcement Mechanism |
|---|---|---|
| **INV-1 (Stable Identity)** | Exactly one PostgreSQL row per Notion page UUID (`notion_page_id`). | `PRIMARY KEY (notion_page_id)` in `notion_sync.notion_tasks`. |
| **INV-2 (Authoritative State)** | Webhooks are change signals, never the complete record. Worker must re-fetch fresh Notion state. | `client.fetchPage(pageId)` in `sync/worker.ts` prior to normalization. |
| **INV-3 (Durable Ingestion)** | Webhook requests are acknowledged (`200 OK`) only after being committed to `sync_inbox`. | Returns `503` if PostgreSQL insert fails; acknowledges duplicate events with `{ ok: true, duplicate: true }`. |
| **INV-4 (No Regression)** | Out-of-order webhook deliveries must never overwrite newer data. | `WHERE notion_tasks.notion_last_edited_time IS NULL OR EXCLUDED.notion_last_edited_time >= notion_tasks.notion_last_edited_time` (no `EXCLUDED... IS NULL` bypass). |
| **INV-5 (Safe Scans)** | Absence from a partial scan never implies deletion. Vanished tasks are flagged out-of-scope ONLY on 100% complete, uncapped scans. | Out-of-source remediation in `sync/reconcile.ts` executes only when the pagination loop finished, `pageFailures === 0`, and Notion did **not** report `request_status.type === "incomplete"` (10 000-result cap). |
| **INV-6 (Transactional Integrity)** | Task row upsert and inbox status transition (`processed`) must occur within the same PostgreSQL transaction. | `withTransaction()` helper (`db/pool.ts`) used by every branch of `sync/worker.ts` (BEGIN … COMMIT, ROLLBACK on failure, release after settlement). |
| **INV-7 (Absolute Secret Redaction)** | API tokens, DB credentials, and signatures must never appear in logs or error traces. | Pino logger path redaction in `src/logger.ts` and `sanitizeErrorMessage()` in `src/errors.ts`. |

---

## 4. Technology Stack

All technologies and versions are verified from [`package.json`](file:///d:/Notion/package.json), lockfiles, and runtime configurations:

| Category | Technology | Role in System | Verified Version |
|---|---|---|---|
| **Runtime** | [Node.js](https://nodejs.org/) | Strict ESM execution environment | `>=22.0.0` (LTS) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | Type-safe development (`NodeNext` module resolution) | `^5.9.3` |
| **Web Server** | [Fastify](https://fastify.dev/) | High-throughput HTTP API for webhooks & health checks | `^5.12.7` |
| **Database** | [PostgreSQL (Neon)](https://neon.tech/) | Serverless relational storage for normalized tasks & queue | PostgreSQL 18 (`pg ^8.23.1`) |
| **Neon Tooling** | `@neon/config`, `@neon/env` | Neon project-linkage tooling only. **Not imported by application code** — database access uses `pg` directly; SPEC §125 decides these must not become a second source of truth. | `^1.9.3`, `^1.6.4` (installed, unused at runtime) |
| **Notion SDK** | [`@notionhq/client`](https://developers.notion.com/) | Official Notion API SDK & signature verification | `^5.27.1` (API: `2026-03-11`) |
| **Validation** | [Zod](https://zod.dev/) | Strict runtime parsing for environment config & envelopes | `^3.25.76` |
| **Logging** | [Pino](https://getpino.io/) | High-speed structured JSON logger with secret redaction | `^9.14.0` |
| **Testing** | [Vitest](https://vitest.dev/) | Test framework for unit, integration, and e2e suites | `^3.2.7` |
| **Embedded DB** | [`embedded-postgres`](https://github.com/embedded-postgres) | Local PostgreSQL 18 instance for zero-Docker integration tests | `18.4.0-beta.17` |
| **CLI Runner** | [tsx](https://github.com/privatenumber/tsx) | Fast TypeScript execution for operational scripts and migrations | `^4.23.15` |

---

## 5. System Architecture

### 5.1 Ingestion Flow (Webhooks)
1. Notion emits an event (e.g., `page.properties_updated`) to `POST /webhooks/notion`.
2. Fastify captures the raw payload into a memory buffer (`req.rawBody`).
3. If an initial subscription handshake is detected (`verification_token`), the token is logged (last 4 characters only) and a `200 {"ok":true}` response is returned.
4. For event payloads, HMAC-SHA256 signature verification is performed against `X-Notion-Signature` using `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
5. The validated payload is inserted into `notion_sync.sync_inbox` with status `pending`.
6. Fastify responds `200 {"ok":true}` (or `503` if PostgreSQL is unreachable).

### 5.2 Asynchronous Worker Flow
1. The background worker queries `notion_sync.sync_inbox` using `FOR UPDATE SKIP LOCKED` for the oldest pending event where `available_at <= NOW()`.
2. The event status is marked as `processing`, and `locked_at` is stamped.
3. For `page.deleted`, the worker tombstones the task (`notion_in_trash = true`) without calling Notion.
4. For all other page events, the worker calls the Notion API to retrieve the current page object and block contents (INV-2).
5. The page is normalized into a structured record.
6. A single database transaction atomically upserts `notion_sync.notion_tasks` and marks the inbox event as `processed` (INV-6).
7. If an error occurs:
   - **Retryable errors** (429 rate limit, 5xx, network drops) trigger exponential backoff with full jitter and reschedule `available_at`.
   - **Permanent errors** or exhausted attempts (>= `SYNC_MAX_ATTEMPTS`) mark the event as `failed`.

### 5.3 Backfill & Reconciliation Flow
- **Backfill (`sync:backfill`):** Traverses the Notion Data Source using cursor pagination (`start_cursor`), normalizes each task, and upserts into `notion_tasks`. Records progress and cycle checks in `notion_sync.sync_runs`. If Notion reports an incomplete result set (`request_status.type === "incomplete"`, the 10 000-result query cap) or any page fails, the run is recorded as `partial` instead of `succeeded`.
- **Reconciliation (`sync:reconcile`):** Performs a full sweep across Notion. Only if the scan terminates normally, has 0 page errors, and was **not** capped by Notion does it identify tasks present in PostgreSQL that are missing from Notion and flag them with `is_in_source = false` (INV-5). On any partial or capped scan, remediation is skipped and the run is recorded as `partial`. This command is a **CLI job with no in-process scheduler** — schedule it externally (e.g. cron, systemd timer, Windows Task Scheduler, or a platform scheduler) at the cadence that matches `SYNC_RECONCILIATION_INTERVAL_MINUTES`.

### 5.4 Architectural Diagram

```mermaid
flowchart TD
    subgraph NotionCloud["Notion Cloud Workspace"]
        NDB[("Master Tasks Database")]
        NWH["Notion Webhook Emitter"]
        NAPI["Notion REST API (v2026-03-11)"]
        NDB -->|Entity changes| NWH
        NDB -.->|Data source queries| NAPI
    end

    subgraph Service["Notion Tasks Sync Service (Node.js 22 + TypeScript)"]
        subgraph HTTP["Fastify HTTP Server (:3000)"]
            H_HEALTH["GET /health & /ready"]
            H_WH["POST /webhooks/notion"]
            H_SIG{"Verify HMAC-SHA256\n(Raw Buffer)"}
            H_WH --> H_SIG
        end

        subgraph Worker["Background Sync Worker"]
            W_CLAIM["Claim Event (SKIP LOCKED)"]
            W_FETCH["Re-fetch Page & Blocks (INV-2)"]
            W_NORM["Normalize Task Record"]
            W_TX["Atomic Transaction (INV-6)"]
            W_CLAIM --> W_FETCH --> W_NORM --> W_TX
        end

        subgraph Ops["Operational CLI Jobs"]
            CLI_MIG["npm run db:migrate"]
            CLI_BACK["npm run sync:backfill"]
            CLI_REC["npm run sync:reconcile"]
            CLI_OP["sync:retry-failed\nsync:recover-stuck"]
        end
    end

    subgraph PostgreSQL["PostgreSQL 18 (Neon Lakebase)"]
        direction TB
        T_INBOX[("notion_sync.sync_inbox\n(Durable Queue)")]
        T_TASKS[("notion_sync.notion_tasks\n(Normalized Replica)")]
        T_RUNS[("notion_sync.sync_runs\n(Audit Ledger)")]
        T_MIG[("notion_sync.schema_migrations\n(Checksum Ledger)")]
    end

    %% Ingestion Links
    NWH -->|"POST /webhooks/notion\n(X-Notion-Signature)"| H_WH
    H_SIG -->|"Valid Envelope\n(INV-3)"| T_INBOX
    H_SIG -->|"200 OK / 503 Retry"| NWH

    %% Worker Links
    T_INBOX -.->|Poll pending| W_CLAIM
    W_FETCH <===>|"Fetch Page State\n& Body Blocks"| NAPI
    W_TX ==>|"Upsert Task (INV-4)\n+ Settle Inbox"| T_TASKS
    W_TX -.->|Mark processed| T_INBOX

    %% Operations Links
    CLI_MIG -->|Advisory Lock & DDL| T_MIG
    CLI_BACK <===>|Paginated Query| NAPI
    CLI_BACK ==>|Bulk Upsert| T_TASKS
    CLI_BACK -->|Record Run| T_RUNS
    CLI_REC <===>|Full Scan| NAPI
    CLI_REC ==>|Out-of-source Flag (INV-5)| T_TASKS
    CLI_REC -->|Record Run| T_RUNS
    CLI_OP -->|Requeue / Recover| T_INBOX

    classDef primary fill:#2563eb,stroke:#1d4ed8,stroke-width:2px,color:#fff;
    classDef secondary fill:#059669,stroke:#047857,stroke-width:2px,color:#fff;
    classDef storage fill:#475569,stroke:#334155,stroke-width:2px,color:#fff;
    class H_WH,W_CLAIM,CLI_BACK primary;
    class W_FETCH,W_NORM,W_TX secondary;
    class T_INBOX,T_TASKS,T_RUNS,T_MIG storage;
```

---

## 6. Project Directory Structure

```
d:/Notion/
├── .env.example                 # Template for required environment variables
├── .gitignore                   # Ignores node_modules, dist, .env, and logs
├── AGENTS.md                    # Core project boundaries & instructions for AI agents
├── Me.md                        # Developer context, invariants, and operational summary
├── README-SETUP.md              # Setup guide for OpenCode and Antigravity IDE
├── README.md                    # Comprehensive repository documentation (this file)
├── package.json                 # Project manifest, dependencies, and lifecycle scripts
├── package-lock.json            # Deterministic dependency lockfile
├── eslint.config.js             # ESLint flat config (npm run lint)
├── tsconfig.json                # TypeScript compiler configuration (NodeNext, Strict)
├── vitest.config.ts             # Vitest configuration (sequential integration suites)
│
├── src/                         # Core application bootstrap & shared utilities
│   ├── config.ts                # Zod environment schema & runtime config validation
│   ├── errors.ts                # Error taxonomy (Notion, DB, Config) & secret redaction
│   ├── logger.ts                # Pino structured logging with path-based redaction
│   └── server.ts                # Fastify HTTP server instantiation & raw body parser
│
├── routes/                      # Fastify route controllers
│   ├── health.ts                # GET /health (liveness) and GET /ready (readiness)
│   └── webhooks.ts              # POST /webhooks/notion (signature verification & durable inbox)
│
├── db/                          # Database connection pool & data access layer
│   ├── inbox-repo.ts            # sync_inbox repository (enqueue, claim, settle, recover)
│   ├── migrate.ts               # Migration runner (advisory locks, checksum validation)
│   ├── pool.ts                  # PostgreSQL connection pool with transaction helper
│   ├── runs-repo.ts             # sync_runs ledger (audit tracking for backfill & reconcile)
│   └── tasks-repo.ts            # notion_tasks repository (INV-4 upsert, tombstone, scope)
│
├── migrations/                  # Schema migration definitions
│   └── 0001_init.sql            # Schema DDL (notion_tasks, sync_inbox, sync_runs, indexes)
│
├── sync/                        # Synchronization domain logic
│   ├── backfill.ts              # Initial cursor-paginated data source backfill
│   ├── normalize.ts             # Pure mapping from Notion Page object to PostgreSQL task
│   ├── notion-client.ts         # Notion SDK client wrapper with rate-limit retry & backoff
│   ├── property-map.ts          # Default property mappings & flexible name resolution
│   ├── reconcile.ts             # Periodic full-scan reconciliation engine (INV-5)
│   ├── retry-policy.ts          # Exponential backoff with full jitter and Retry-After parsing
│   └── worker.ts                # Background inbox worker loop & event dispatch matrix
│
├── scripts/                     # Operational CLI entry points
│   ├── sync-backfill.ts         # npm run sync:backfill CLI runner
│   ├── sync-reconcile.ts        # npm run sync:reconcile CLI runner
│   ├── sync-recover-stuck.ts    # npm run sync:recover-stuck CLI runner
│   ├── sync-retry-failed.ts     # npm run sync:retry-failed CLI runner
│   └── sync-worker.ts           # npm run worker CLI runner
│
├── tests/                       # Automated test suites (128 tests across 16 files)
│   ├── unit/                    # 12 unit test files (mocks, schemas, normalization, TLS, CLI routing)
│   ├── integration/             # 3 integration test files (real PostgreSQL 18 via embedded-postgres, zero DB mocks)
│   │   └── helpers/             # Test database setup (random port, temp directory)
│   └── e2e/                     # 1 acceptance test file (full pipeline against an in-memory harness)
│
└── docs/                        # Architectural specifications & requirements
    ├── DEPLOYMENT_GUIDE.md      # Production runbook, least-privilege roles, and hosting
    ├── IMPLEMENTATION_STATUS.md # Truthful verification log and phase-by-phase completion report
    ├── Notion_to_PostgreSQL_Sync_SPEC.md # Full technical specification
    ├── PRD.md                   # Product requirements document
    └── implementation-workflow.md # Phased implementation protocol
```

---

## 7. Prerequisites

Before installing and running the service, ensure the following are available:

1. **Node.js:** Version `22.0.0` or higher (verified with Node 22+ LTS).
2. **PostgreSQL Database:**
   - A [Neon Lakebase](https://neon.tech/) PostgreSQL instance (recommended for production).
   - Alternatively, any standard PostgreSQL instance (version 16 or 18).
3. **Notion Internal Integration:**
   - Create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations).
   - Grant **Read content** permissions.
   - Connect the integration to your Notion Tasks Database (**Database settings → Connect to → Your Integration**).
4. **Notion Webhook Subscription:**
   - A configured webhook subscription pointing to your public HTTPS endpoint (`https://<domain>/webhooks/notion`).

---

## 8. Installation & Setup

### Step 1: Clone or Open Repository
```bash
git clone https://github.com/mddawoodrahman/notion.git
cd notion
```

### Step 2: Install Dependencies
```bash
# On Unix / macOS:
npm install

# On Windows PowerShell (if execution policy blocks npm.ps1):
npm.cmd install
```

### Step 3: Configure Environment Variables
Copy the example environment configuration:
```bash
# Unix:
cp .env.example .env

# Windows PowerShell:
Copy-Item .env.example .env
```
Edit `.env` and configure your credentials (see [Section 9](#9-environment-variables)).

> [!NOTE]
> Every runtime and CLI script (`dev`, `start`, `worker`, `db:migrate`, `sync:*`) loads `.env` automatically via Node's `--env-file-if-exists=.env`, so no `dotenv` import or shell export is required. Outside `NODE_ENV=test`, a missing `DATABASE_URL`, `NOTION_API_KEY` or `NOTION_DATABASE_ID` now aborts startup with an explicit `ConfigurationError` instead of failing later at runtime.

### Step 4: Run Database Migrations
Apply the initial schema (`notion_sync`) and create tables:
```bash
# Unix:
npm run db:migrate

# Windows PowerShell:
npm.cmd run db:migrate
```
Verify the migration status:
```bash
npm.cmd run db:migrate -- status
# Output: [✓] 0001_init.sql (applied at ...)
```

### Step 5: Test Initial Backfill (Dry Run)
Validate connectivity and data source resolution without writing to the database:
```bash
npm.cmd run sync:backfill -- --dry-run
```

### Step 6: Execute Live Initial Backfill
Import all existing Notion tasks into PostgreSQL:
```bash
npm.cmd run sync:backfill
```

### Step 7: Launch the Webhook Server & Worker
```bash
# Terminal 1 — HTTP Webhook API:
npm.cmd run dev

# Terminal 2 — Background Sync Worker:
npm.cmd run worker
```

---

## 9. Environment Variables

The application strictly validates configuration on boot using Zod (`src/config.ts`). Missing or malformed required variables immediately prevent startup with descriptive, sanitized error messages — only `NODE_ENV=test` falls back to offline placeholders.

| Variable | Purpose | Required? | Default | Example Value |
|---|---|---|---|---|
| `NODE_ENV` | Runtime environment mode | No | `development` | `development`, `test`, `production` |
| `PORT` | HTTP port for Fastify server | No | `3000` | `3000` |
| `NOTION_API_KEY` | Notion Internal Integration Token | **Yes (Prod)** | None | `secret_abcdef123456...` or `ntn_...` |
| `NOTION_DATABASE_ID` | Master Tasks Database UUID | **Yes (Prod)** | None | `32-character hex UUID` |
| `NOTION_DATA_SOURCE_ID` | Target Data Source UUID (if DB has >1) | Optional | None | `data-source-uuid` |
| `NOTION_VERSION` | Pinned Notion API version | No | `2026-03-11` | `2026-03-11` |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | Secret for HMAC-SHA256 signature verification | **Yes (Prod)** | None | `vft_secret_token_min_32_chars` |
| `ALLOW_UNSIGNED_WEBHOOKS` | Explicit opt-out of webhook signature verification. **Development only**; forbidden in production (config rejects it). | No | `false` | `true` |
| `DATABASE_URL` | Neon pooled PostgreSQL connection string | **Yes (Prod)** | None | `postgresql://user:pass@ep-pool.neon.tech/neondb?sslmode=require` |
| `DIRECT_DATABASE_URL` | Direct connection string for migrations | Optional | None | `postgresql://user:pass@ep-direct.neon.tech/neondb?sslmode=require` |
| `DB_SSL_INSECURE` | Development-only opt-out of TLS certificate verification (`rejectUnauthorized: false`) for self-signed local databases | No | `false` | `true` |
| `TEST_DATABASE_URL` | Optional custom database URL for tests | No | None | `postgresql://user:pass@localhost:5432/testdb` |
| `SYNC_TIMEZONE` | IANA timezone used to derive `due_date` for timed due dates (timezone-aware conversion; date-only values are preserved verbatim) | No | `Asia/Kolkata` | `Asia/Kolkata`, `America/New_York` |
| `SYNC_RECONCILIATION_INTERVAL_MINUTES` | Recommended cadence for the **external** reconciliation scheduler (informational — the service has no in-process scheduler) | No | `30` | `30` (1 to 1440) |
| `SYNC_MAX_ATTEMPTS` | Maximum retry attempts before marking event failed | No | `8` | `8` (1 to 20) |
| `SYNC_PAGE_SIZE` | Query page size for Notion pagination | No | `100` | `100` (max 100) |
| `SYNC_SYNC_BODY_CONTENT` | Enables serialization of task body blocks | No | `true` | `true`, `false` |
| `SYNC_LEASE_SECONDS` | Concurrency lock duration for claimed inbox events | No | `300` | `300` (30 to 3600) |
| `LOG_LEVEL` | Logging verbosity (Pino automatically redacts secrets) | No | `info` | `trace`, `debug`, `info`, `warn`, `error` |

> [!IMPORTANT]
> - Outside `NODE_ENV=test`, `NOTION_API_KEY`, `NOTION_DATABASE_ID` and `DATABASE_URL` are strictly mandatory and abort startup when missing. In `production`, `NOTION_WEBHOOK_VERIFICATION_TOKEN` is mandatory as well.
> - `NOTION_API_KEY` must begin with `secret_` or `ntn_`.
> - `DATABASE_URL` must use a valid `postgresql://` or `postgres://` protocol.
> - Webhook signature verification **fails closed**: without a verification token the receiver answers `503` and stores nothing, unless `ALLOW_UNSIGNED_WEBHOOKS=true` is explicitly set (development only — rejected at config validation in production).
> - TLS certificate verification is enabled by default for all non-local connections; `DB_SSL_INSECURE=true` is a development-only escape hatch for self-signed local databases.

---

## 10. Operational Commands & Scripts

All scripts are configured in [`package.json`](file:///d:/Notion/package.json):

```bash
# --- Build, Type Checking & Lint ---
npm run typecheck            # Run TypeScript type check without emitting files (tsc --noEmit)
npm run lint                 # Run ESLint across the repository (flat config, 0 errors expected)
npm run build                # Compile TypeScript into JavaScript in dist/
npm start                    # Start compiled production server (node dist/src/server.js)
npm run dev                  # Start local development server with tsx watch

# --- Database & Migrations ---
npm run db:migrate           # Apply pending migrations with advisory locks
npm run db:migrate -- status # Inspect applied vs pending migrations and checksums

# --- Testing Suites ---
npm test                     # Run all 16 test suites (unit, integration, and e2e)
npm run test:unit            # Run only the 12 unit test suites
npm run test:integration     # Run 3 integration suites against real embedded PostgreSQL 18 (zero DB mocks)
npm run test:e2e             # Run the acceptance suite (full flow against an in-memory harness)

# --- Core Synchronization Roles ---
npm run worker               # Start continuous background inbox processing worker
npm run sync:backfill        # Execute full cursor-paginated initial backfill
npm run sync:backfill -- --dry-run # Backfill dry-run (fetches & normalizes, skips database writes)
npm run sync:reconcile       # Run a full reconciliation sweep (INV-5 safe scan; schedule externally — no in-process scheduler)

# --- Operator Recovery Tools ---
npm run sync:retry-failed    # Requeue up to 100 failed inbox events back to pending
npm run sync:recover-stuck   # Release worker processing leases older than SYNC_LEASE_SECONDS
```

*(On Windows PowerShell, use `npm.cmd <command>` if PowerShell script execution policies restrict `npm.ps1`)*

---

## 11. Database & Data Architecture

### 11.1 Schema Overview

All database objects reside inside a dedicated PostgreSQL schema: `notion_sync`.

```
notion_sync
├── notion_tasks         (Normalized tasks, current state replica)
├── sync_inbox           (Durable inbound webhook event queue)
├── sync_runs            (Audit ledger for backfill & reconciliation jobs)
└── schema_migrations    (Checksummed migration history ledger)
```

### 11.2 Tables & Responsibilities

#### 1. `notion_sync.notion_tasks`
Stores the normalized current state of each Notion task page.
- `notion_page_id` (`TEXT PRIMARY KEY`): Canonical Notion page UUID (INV-1).
- `title` (`TEXT NOT NULL DEFAULT ''`): Plain-text task title.
- `status` (`TEXT`): Current task status (e.g., "Not started", "In progress", "Done").
- `list_name` (`TEXT`): Task list or category (e.g., "Personal", "Work", "Grocery").
- `important` (`BOOLEAN NOT NULL DEFAULT FALSE`): Starred / High importance flag.
- `in_my_day` (`BOOLEAN NOT NULL DEFAULT FALSE`): Microsoft To Do–style daily focus flag.
- `priority` (`TEXT`): Urgency or priority tag (e.g., "High", "Medium", "Low").
- `due_date` (`DATE`): Date-only deadline (`YYYY-MM-DD`).
- `due_at` (`TIMESTAMPTZ`): Specific timed deadline with timezone offset, if specified.
- `reminder_at` (`TIMESTAMPTZ`): Configured reminder timestamp.
- `user_archived` (`BOOLEAN NOT NULL DEFAULT FALSE`): Custom checkbox property set by user.
- `notion_is_archived` (`BOOLEAN NOT NULL DEFAULT FALSE`): Notion native page archival status.
- `notion_in_trash` (`BOOLEAN NOT NULL DEFAULT FALSE`): Notion trash state or deletion tombstone.
- `is_in_source` (`BOOLEAN NOT NULL DEFAULT TRUE`): False if page moved outside data source.
- `page_url` (`TEXT`): Direct HTTPS link to the Notion page.
- `notion_created_time` (`TIMESTAMPTZ`): Notion page creation timestamp.
- `notion_last_edited_time` (`TIMESTAMPTZ`): Source last-edit timestamp used for INV-4 guards.
- `raw_properties` (`JSONB NOT NULL DEFAULT '{}'`): Complete, untruncated property JSON from Notion.
- `page_content_json` (`JSONB NOT NULL DEFAULT '[]'`): Nested block content (up to 3 levels deep). The upsert writes `COALESCE($19::jsonb, ...)`: callers that did not fetch blocks pass SQL `NULL` so stored content is preserved, while a genuinely empty fetched page (`[]`) still overwrites it.
- `synced_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Last synchronization timestamp.

#### 2. `notion_sync.sync_inbox`
Durable event queue for reliable webhook ingestion.
- `event_id` (`TEXT PRIMARY KEY`): Unique webhook event ID emitted by Notion.
- `event_type` (`TEXT NOT NULL`): Event type (e.g., `page.properties_updated`, `page.deleted`).
- `entity_type` (`TEXT`): Target entity type (`page`, `database`, `data_source`).
- `entity_id` (`TEXT`): UUID of the targeted entity.
- `event_timestamp` (`TIMESTAMPTZ`): Event emission timestamp from Notion.
- `payload` (`JSONB NOT NULL`): Raw webhook delivery envelope.
- `status` (`TEXT NOT NULL DEFAULT 'pending'`): State check: `pending`, `processing`, `processed`, `failed`.
- `attempts` (`INTEGER NOT NULL DEFAULT 0`): Number of processing attempts.
- `received_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Timestamp ingested by HTTP server.
- `available_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Timestamp when next attempt can be claimed.
- `locked_at` (`TIMESTAMPTZ`): Timestamp when claimed by worker for lease tracking.
- `processed_at` (`TIMESTAMPTZ`): Timestamp when successfully settled.
- `last_error` (`TEXT`): Redacted error message if processing failed.

#### 3. `notion_sync.sync_runs`
Audit and operational ledger tracking batch operations.
- `run_id` (`BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`): Monotonic run identifier.
- `run_type` (`TEXT NOT NULL`): `initial_backfill`, `reconciliation`, or `manual_retry`.
- `status` (`TEXT NOT NULL`): `running`, `succeeded`, `partial`, `failed`.
- `started_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
- `finished_at` (`TIMESTAMPTZ`)
- `records_processed` (`INTEGER NOT NULL DEFAULT 0`)
- `error_message` (`TEXT`): Sanitized error message on failure.
- `cursor_reached` (`TEXT`): Last pagination cursor reached.

#### 4. `notion_sync.schema_migrations`
Ledger of applied DDL migrations with SHA-256 integrity checksums.
- `version` (`TEXT PRIMARY KEY`): Filename (e.g., `0001_init.sql`).
- `applied_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`).
- `checksum` (`TEXT NOT NULL`): SHA-256 hash of migration file content.

---

### 11.3 Property Normalization Mapping

The normalization layer ([`sync/normalize.ts`](file:///d:/Notion/sync/normalize.ts) and [`sync/property-map.ts`](file:///d:/Notion/sync/property-map.ts)) performs case-insensitive candidate matching:

| Task Field | Preferred Notion Property | Accepted Fallback Names | Target Type |
|---|---|---|---|
| Title | `Task` | `Title`, `Name`, `Task Name` | `TEXT` |
| Status | `Status` | `State` | `TEXT` |
| List Name | `List` | `Category`, `Lists` | `TEXT` |
| Important | `Important` | `Star`, `Starred`, `Importance` | `BOOLEAN` |
| In My Day | `In My Day` | `My Day`, `MyDay` | `BOOLEAN` |
| Priority | `Priority` | `Urgency`, `Level` | `TEXT` |
| Due Date | `Due Date` | `Due`, `Deadline`, `Date` | `DATE` / `TIMESTAMPTZ` |
| Reminder | `Reminder` | `Remind`, `Reminder Date` | `TIMESTAMPTZ` |
| User Archived | `Archived` | `User Archived`, `Archived Task` | `BOOLEAN` |

---

### 11.4 Soft Deletion & Out-of-Scope Flags

Tasks are **never physically deleted** from PostgreSQL:
- **Trashed Tasks:** When a `page.deleted` webhook arrives, or a page is returned with `in_trash = true`, `notion_sync.notion_tasks.notion_in_trash` is set to `true`.
- **Vanished Tasks:** If a task exists in PostgreSQL with `is_in_source = true` but is omitted from a 100% successful full reconciliation scan, `is_in_source` is set to `false`.
- **Querying Active Tasks:**
  ```sql
  SELECT * FROM notion_sync.notion_tasks
  WHERE is_in_source = TRUE 
    AND notion_in_trash = FALSE 
    AND user_archived = FALSE;
  ```

---

### 11.5 Least-Privilege Database Role Setup

To run the application with least privilege in production instead of using superuser/admin credentials, run the following SQL script:

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

## 12. API & Integration Documentation

The service exposes three HTTP endpoints:

### 1. `GET /health`
Liveness probe for load balancers and orchestrators.
- **Request:** `GET /health`
- **Response (200 OK):**
  ```json
  {
    "status": "ok"
  }
  ```

### 2. `GET /ready`
Readiness probe verifying active PostgreSQL database connectivity (`SELECT 1`).
- **Request:** `GET /ready`
- **Response (200 OK — Ready):**
  ```json
  {
    "status": "ready",
    "timestamp": "2026-10-21T16:45:00.000Z"
  }
  ```
- **Response (503 Service Unavailable — Database Unreachable):**
  ```json
  {
    "status": "not_ready",
    "reason": "database_unavailable"
  }
  ```

### 3. `POST /webhooks/notion`
Notion webhook delivery endpoint.
- **Request Headers:**
  - `Content-Type: application/json`
  - `X-Notion-Signature: <hex-encoded HMAC-SHA256 signature>`
- **Handshake Verification Delivery:**
  - Payload: `{"verification_token": "secret_vft_..."}`
  - Response: `200 OK` `{"ok": true}`
  - *Action:* The verification token suffix is logged (`***last4`). Configure this token in `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
- **Standard Event Delivery:**
  - Payload Envelope:
    ```json
    {
      "id": "evt_01JABC...",
      "type": "page.properties_updated",
      "entity": {
        "type": "page",
        "id": "123e4567-e89b-12d3-a456-426614174000"
      },
      "timestamp": "2026-10-21T16:45:00.000Z"
    }
    ```
  - Response: `200 OK` `{"ok": true}`
  - Duplicate delivery: `200 OK` `{"ok": true, "duplicate": true}`
  - Invalid signature: `401 Unauthorized` `{"ok": false}`
  - Missing `X-Notion-Signature` header: `401 Unauthorized` `{"ok": false}`
  - Verification token not configured: `503 Service Unavailable` `{"ok": false}` — fails closed; set `NOTION_WEBHOOK_VERIFICATION_TOKEN`, or opt in with `ALLOW_UNSIGNED_WEBHOOKS=true` in development only
  - Malformed envelope: `400 Bad Request` `{"ok": false}`
  - Database unavailable: `503 Service Unavailable` `{"ok": false}` (Prompts Notion to retry)

---

## 13. Testing & Verification

The project enforces rigorous automated test coverage with **two deliberately different harnesses**:

- **Integration tests run against a real, isolated PostgreSQL 18 instance** (`embedded-postgres`, no Docker) — **zero database mocks**. SQL semantics, constraints, `ON CONFLICT` guards, `SKIP LOCKED` concurrency, and transaction rollback are verified by actually executing them.
- **The acceptance (e2e) suite runs the full flow against an in-memory harness** (typed `Map` stores plus a `vi.fn()` SQL dispatcher) through Fastify injection and the real worker/backfill/reconcile code paths. It exercises wiring and control flow, **not** PostgreSQL semantics — those are covered by the integration suites above.

### Test Summary

```
Test Files  16 passed (16)
     Tests  128 passed (128)
```

| Test Suite | File Count | Tests | Target / Description |
|---|---|---|---|
| **Unit Tests** | 12 | 78 | Config parsing and fail-fast validation, error classification (transient network/timeout detection), secret sanitization, normalization (timezone-aware due dates, content-preservation semantics), health routes, mock Notion client (retry policy, `request_status` propagation), worker event branches (resolve-once data source, rollback), backfill/reconcile incomplete-scan safety, repository SQL contracts, pool TLS resolution (verified by default, explicit dev-only opt-out), migration CLI routing. |
| **Integration Tests** | 3 | 41 | Applied against real local PostgreSQL 18: schema DDL, constraints, advisory locks, checksum drift, `ON CONFLICT` INV-4 guards (including null-timestamp rejection), `page_content_json` preservation, `SKIP LOCKED` claims, lease expiry, transaction rollback/commit. |
| **Acceptance / E2E** | 1 | 9 | Full webhook ingestion, signature validation, handshake, and worker settlement through Fastify route injection against the in-memory harness. |

### Stability Policy

The full suite is re-run at least **5 times consecutively** before any release-style claim; the latest recorded run count, date, and failure count are maintained in [`docs/IMPLEMENTATION_STATUS.md`](file:///d:/Notion/docs/IMPLEMENTATION_STATUS.md). The formerly flaky `SKIP LOCKED` integration test is now order-independent (it asserts on the *set* of concurrent claims rather than positional results).

### Running Tests

```bash
# Run full suite (16 files, 128 tests):
npm.cmd test

# Run only unit tests:
npm.cmd run test:unit

# Run only integration tests:
npm.cmd run test:integration

# Run only acceptance tests:
npm.cmd run test:e2e

# Run TypeScript type check:
npm.cmd run typecheck

# Run the lint gate:
npm.cmd run lint
```

---

## 14. Production Deployment Topology

For high availability and fault isolation, three distinct processes should run in production:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Production Deployment                        │
├───────────────────────────────┬─────────────────────────────────┤
│ 1. HTTP API Webhook Process   │ npm start                       │
│    (Fastify Webhook Receiver) │ Listens on :3000                │
├───────────────────────────────┼─────────────────────────────────┤
│ 2. Background Sync Worker     │ npm run worker                  │
│    (Queue Consumer)           │ Long-running polling loop       │
├───────────────────────────────┼─────────────────────────────────┤
│ 3. Reconciliation Job         │ npm run sync:reconcile          │
│    (Audit & Repair, CLI)      │ Invoked by an EXTERNAL          │
│                               │ scheduler (cron / systemd timer │
│                               │ / Task Scheduler), e.g. 30 min  │
└───────────────────────────────┴─────────────────────────────────┘
```

> [!IMPORTANT]
> The service itself contains **no cron or in-process scheduler**. Reconciliation must be triggered by an external scheduler (host cron, systemd timer, Windows Task Scheduler, or a platform scheduler such as a container-scheduled job). `SYNC_RECONCILIATION_INTERVAL_MINUTES` documents the recommended cadence but is not consumed by the service.

### Connection String Strategy (Neon)
- **Runtime Application (`DATABASE_URL`):** Point to the **Neon Pooled endpoint** (e.g., `ep-pool-name-pooler.region.neon.tech`). This handles serverless connection scaling efficiently.
- **Migrations (`DIRECT_DATABASE_URL`):** Point to the **Neon Direct endpoint** (e.g., `ep-pool-name.region.neon.tech`). PostgreSQL session advisory locks (`pg_advisory_lock`) are required by `db:migrate` and do not work across transaction poolers like PgBouncer.

---

## 15. Troubleshooting & Operational Runbook

### Issue 1: Windows PowerShell ExecutionPolicy Error
**Symptom:**
```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled on this system.
```
**Solution:**
Use `npm.cmd` instead of `npm`, or set the execution policy for your session:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

### Issue 2: Webhooks Returning 401 Unauthorized
**Symptom:** Fastify logs `Rejected webhook delivery: signature verification failed`.  
**Causes & Checks:**
1. `NOTION_WEBHOOK_VERIFICATION_TOKEN` is incorrect in `.env`.
2. Reverse proxy modified the body before Fastify received it. Fastify uses a custom parser (`parseAs: "buffer"`) to retain exact raw bytes.
3. Check handshake logs: when Notion sends the initial handshake, retrieve the logged token suffix and ensure it matches your environment secret.

If the token is **not configured at all**, the receiver fails closed and answers `503` (nothing is stored) — set `NOTION_WEBHOOK_VERIFICATION_TOKEN`, or, in development only, opt in with `ALLOW_UNSIGNED_WEBHOOKS=true` (rejected in production).

---

### Issue 3: Migration Fails with Advisory Lock Error
**Symptom:** `pg_advisory_lock` error when running `npm run db:migrate`.  
**Cause:** Attempting to run migrations through a transaction pooler (such as PgBouncer or Neon Pooled URL).  
**Solution:** Set `DIRECT_DATABASE_URL` to point to the direct PostgreSQL host (unpooled) and re-run `npm run db:migrate`.

---

### Issue 4: Worker Leases Stuck in "Processing"
**Symptom:** An event remains in `processing` status indefinitely after a worker container crash.  
**Solution:**
The worker automatically runs lease recovery every 60 seconds. To manually reset expired leases immediately:
```bash
npm.cmd run sync:recover-stuck
```

---

### Issue 5: Webhook Events Marked as "Failed"
**Symptom:** Events exceed `SYNC_MAX_ATTEMPTS` due to temporary downstream downtime and are moved to `status = 'failed'`.  
**Solution:**
Inspect error messages in `notion_sync.sync_inbox` and run the operator requeue script:
```bash
npm.cmd run sync:retry-failed
```

---

## 16. Security & Operational Notes

- **Secret Redaction:** Pino is configured with explicit redaction paths (`NOTION_API_KEY`, `NOTION_WEBHOOK_VERIFICATION_TOKEN`, `DATABASE_URL`, passwords, and auth headers). In addition, `sanitizeErrorMessage()` scrubs connection strings and Notion tokens from exception messages before they reach logs or database columns.
- **HMAC Signature Validation (Fail-Closed):** Webhook payloads are verified against Notion's cryptographic signature over the exact raw body before any parsing or ingestion logic is triggered. Signature verification is never inferred from `NODE_ENV`: without a configured token the receiver answers `503` and stores nothing, unless the explicit development-only `ALLOW_UNSIGNED_WEBHOOKS=true` opt-in is present (forbidden in production).
- **Verified TLS by Default:** PostgreSQL connections use certificate-verified TLS (`ssl: true`) for every non-local host. `DB_SSL_INSECURE=true` is an explicit, development-only escape hatch for self-signed databases (`rejectUnauthorized: false`).
- **SQL Injection Prevention:** Every query in the codebase utilizes parameterized queries (`$1, $2, ...`). Zero SQL strings are constructed via string concatenation.
- **No Plaintext Secrets in Source Control:** `.env` is ignored by `.gitignore`. Real credentials belong only in environment variables or secure cloud secrets managers.
- **Lint & Type Gates:** `npm run typecheck` and `npm run lint` (ESLint flat config) both exit 0 on the current tree and are part of the documented verification lifecycle.

---

## 17. Known Limitations & Roadmap

### Known Limitations

- **Live Integration Pending Owner Credentials:** Local automated verification is green across all **128** unit, integration, and e2e tests, and the full suite has been re-run consecutively to validate stability (recorded date, run count, and results in [`docs/IMPLEMENTATION_STATUS.md`](file:///d:/Notion/docs/IMPLEMENTATION_STATUS.md)). Live API calls against Notion and Neon have not been exercised because production credentials have not yet been provided.
- **Dev-Dependency Advisories:** `npm audit` reports 2 critical + 1 moderate advisories confined to dev-only tooling (`vitest`/`tinypool`/`@vitest/mocker`). Remediation requires a major `vitest@5` upgrade and is tracked separately; dev tooling is excluded from production installs (`npm ci --omit=dev`).
- **Reconciliation Requires an External Scheduler:** No in-process cron exists; forgetting to schedule `npm run sync:reconcile` means drift accumulates silently (see Section 14).
- **One-Way Sync Only:** This service is intentionally a one-way mirror. Updating a record in PostgreSQL does not sync changes back to Notion.
- **Block Content Depth:** Page body block recursion is capped at 3 levels deep to prevent unbound execution times on deeply nested Notion page trees.
- **Single Master Data Source:** If a Notion database contains multiple data sources, `NOTION_DATA_SOURCE_ID` must be explicitly defined in `.env`.

### Roadmap

- [ ] Add Prometheus/OpenTelemetry metrics exporter for queue lag and sync run durations.
- [ ] Support custom field mapping overrides via external JSON configuration.
- [ ] Outbound webhooks emitting events to downstream microservices when tasks change.

---

## 18. Project Documentation Index & License

### Documentation Index

- [`docs/PRD.md`](file:///d:/Notion/docs/PRD.md): Product Requirements Document and data dictionary.
- [`docs/Notion_to_PostgreSQL_Sync_SPEC.md`](file:///d:/Notion/docs/Notion_to_PostgreSQL_Sync_SPEC.md): Technical specification, state machine diagrams, and failure matrix.
- [`docs/DEPLOYMENT_GUIDE.md`](file:///d:/Notion/docs/DEPLOYMENT_GUIDE.md): Detailed production hosting, role permissions, and secrets setup.
- [`docs/IMPLEMENTATION_STATUS.md`](file:///d:/Notion/docs/IMPLEMENTATION_STATUS.md): Truthful verification log and phase-by-phase completion report.
- [`docs/implementation-workflow.md`](file:///d:/Notion/docs/implementation-workflow.md): Phased implementation and acceptance testing protocol.

### License

Proprietary — Developed by **Dawood Rahman** ([@mddawoodrahman](https://github.com/mddawoodrahman)). All rights reserved.
