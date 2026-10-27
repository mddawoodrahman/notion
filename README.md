# Notion Tasks → PostgreSQL Synchronization Service (`notion-tasks-pg-sync`)

[![Python](https://img.shields.io/badge/Python-3.12%2B-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688.svg)](https://fastapi.tiangolo.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18%20(Neon)-blue.svg)](https://neon.tech/)
[![Psycopg 3](https://img.shields.io/badge/Psycopg-3.2%20(Async)-336791.svg)](https://www.psycopg.org/psycopg3/)
[![Pydantic v2](https://img.shields.io/badge/Pydantic-v2.9-e92063.svg)](https://docs.pydantic.dev/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2026--03--11-lightgrey.svg)](https://developers.notion.com/)
[![Pytest](https://img.shields.io/badge/Tests-140%20passed%20(16%20suites)-brightgreen.svg)](tests/)
[![Ruff](https://img.shields.io/badge/Code%20Style-Ruff-black.svg)](https://github.com/astral-sh/ruff)
[![Mypy](https://img.shields.io/badge/Type%20Check-Mypy%20Strict-blue.svg)](https://mypy-lang.org/)

A robust, production-grade, one-way synchronization engine that replicates a Microsoft To Do–inspired Notion task database to a dedicated PostgreSQL database on Neon. Built with Python 3.12+, FastAPI, Uvicorn, Psycopg 3, Pydantic v2, and Typer.

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
- [10. Operational Commands & CLI](#10-operational-commands--cli)
- [11. Database & Data Architecture](#11-database--data-architecture)
  - [11.1 Schema Overview](#111-schema-overview)
  - [11.2 Tables & Responsibilities](#112-tables--responsibilities)
  - [11.3 Property Normalization Mapping](#113-property-normalization-mapping)
  - [11.4 Soft Deletion & Out-of-Scope Flags](#114-soft-deletion--out-of-scope-flags)
  - [11.5 Least-Privilege Database Role Setup](#115-least-privilege-database-role-setup)
- [12. API & Integration Documentation](#12-api--integration-documentation)
- [13. Testing & Verification](#13-testing--verification)
- [14. Production Deployment Topology](#14-production-deployment-topology)
- [15. Docker & Compose Operations](#15-docker--compose-operations)
- [16. Troubleshooting & Operational Runbook](#16-troubleshooting--operational-runbook)
- [17. Security & Operational Notes](#17-security--operational-notes)
- [18. Known Limitations & Roadmap](#18-known-limitations--roadmap)
- [19. Project Documentation Index & License](#19-project-documentation-index--license)

---

## 1. Project Overview & Philosophy

The **Notion Tasks → PostgreSQL Synchronization Service** (`notion-tasks-pg-sync`) is designed to solve a specific, high-stakes operational problem: **Notion is an exceptional user interface for personal task planning, but a poor backend for high-frequency queries, multi-system automations, and relational integrations.**

This service provides an automated, resilient, and verifiable bridge between a personal Notion task database (structured with Microsoft To Do semantics like Lists, Importance, "My Day", and Priority) and a serverless PostgreSQL instance on Neon.

### Core Tenets

- **Single System of Record:** Notion is the **only** place where tasks are created, modified, completed, categorized, or deleted. PostgreSQL is an authoritative, normalized, read-optimized replica of the current state.
- **Asynchronous, Durable Ingestion:** Webhook events are captured into a durable PostgreSQL inbox within milliseconds and acknowledged immediately. Processing occurs asynchronously via worker loops, isolating Notion from downstream delays.
- **Verification First:** The codebase enforces strict type safety via Mypy, transaction boundaries, idempotent writes, and zero-mock database testing against real embedded PostgreSQL 18 clusters.
- **Zero Destructive Deletions:** Vanished or trashed tasks are never physically deleted (`DELETE FROM notion_tasks` does not exist anywhere in the application). Changes are tracked via boolean status flags (`notion_in_trash`, `is_in_source`).

---

## 2. Features & Capabilities

### Implemented V1 Features

- **High-Performance FastAPI Webhook Receiver:** FastAPI HTTP server receiving Notion webhook notifications at `/webhooks/notion`. Validates HMAC-SHA256 signatures over exact raw request bytes before any JSON parsing.
- **Automated Verification Handshake:** Supports Notion's initial subscription verification handshake by logging the incoming `verification_token` (redacted to last 4 chars) and returning `200 {"ok":true}`.
- **Durable Inbox (`sync_inbox`):** Persists raw incoming events before acknowledging delivery. Deduplicates multiple deliveries idempotently using `ON CONFLICT (event_id) DO NOTHING`.
- **Concurrency-Safe Background Worker:** Dequeues pending inbox events using `FOR UPDATE SKIP LOCKED`, preventing race conditions across multiple worker instances.
- **Authoritative Notion State Re-Fetch (INV-2):** Treats webhook payloads as lightweight change notifications; fetches fresh page objects and block contents directly from Notion before performing updates.
- **Atomic Transaction Commit (INV-6):** Synchronizes task row updates and inbox status transitions (`processed`) within the same PostgreSQL transaction.
- **Out-of-Order Delivery Protection (INV-4):** SQL upsert guard comparing `notion_last_edited_time` ensures older webhook deliveries never overwrite newer records.
- **Rich Task Normalization:** Maps Notion properties (Title, Status, List, Important, In My Day, Priority, Due Date/At, Reminder, custom user Archived checkbox) into native PostgreSQL datatypes (`DATE`, `TIMESTAMPTZ`, `BOOLEAN`, `TEXT`).
- **IANA Timezone Awareness:** Computes localized task deadlines using configurable timezone settings (default: `Asia/Kolkata`).
- **Recursive Body Content Serialization:** Extracts and nests up to 3 levels of Notion page body blocks, stored as structured JSONB (`page_content_json`). Callers that did not fetch blocks pass SQL `NULL`, preserving stored blocks.
- **Initial Paginated Backfill:** Cursor-paginated ingestion CLI (`uv run notion-sync backfill`) capable of syncing thousands of existing tasks with built-in infinite cycle detection and dry-run mode (`--dry-run`).
- **Full Reconciliation Engine:** Full-scan sweep CLI (`uv run notion-sync reconcile`) that repairs missed webhook events and marks vanished tasks as `is_in_source = false` only if the scan completes with 100% success, 0 page failures **and an uncapped result set** (INV-5). It is designed to be invoked by an **external scheduler** (cron / systemd timer / platform scheduler) — the service does not self-schedule.
- **Self-Healing Operations:** CLI tools to recover stuck worker leases (`uv run notion-sync recover-stuck`) and requeue failed events back to pending status (`uv run notion-sync retry-failed`).
- **Idempotent Migration Runner:** Transactional database migration runner (`uv run notion-sync migrate`) with PostgreSQL advisory locks (`pg_advisory_lock`) and SHA-256 checksum-drift detection.
- **Zero-Docker Real Database Tests:** 41 integration tests executed against real local PostgreSQL 18 instances via embedded PostgreSQL binaries (zero database mocks), plus 9 acceptance tests that drive the full flow against an in-memory harness (140 total pytest tests).

### Strict V1 Scope Exclusions (Non-Goals)

To prevent architectural bloat and maintain operational reliability, the following features are explicitly excluded from V1:
- ❌ **No Two-Way Synchronization:** No task mutations from PostgreSQL back to Notion.
- ❌ **No Productivity Dashboards / Charts:** No SQL reporting views, KPI counters, or BI widgets.
- ❌ **No Historical Audit Tables:** No `task_events` or `daily_task_snapshots`.
- ❌ **No AI / ML Processing:** No ML categorization models or LLM summarization.
- ❌ **No Binary Asset Storage:** No local caching or binary blob downloading of Notion file attachments.

---

## 3. Architectural Invariants

Any modification to this codebase must preserve these 7 foundational invariants:

| Invariant | Code | Enforcement Mechanism |
|---|---|---|
| **INV-1 (Stable Identity)** | Exactly one PostgreSQL row per Notion page UUID (`notion_page_id`). | `PRIMARY KEY (notion_page_id)` in `notion_sync.notion_tasks`. |
| **INV-2 (Authoritative State)** | Webhooks are change signals, never the complete record. Worker must re-fetch fresh Notion state. | `client.fetch_page(page_id)` in `app/sync/worker.py` prior to normalization. |
| **INV-3 (Durable Ingestion)** | Webhook requests are acknowledged (`200 OK`) only after being committed to `sync_inbox`. | Returns `503` if PostgreSQL insert fails; acknowledges duplicate events with `{"ok": true, "duplicate": true}`. |
| **INV-4 (No Regression)** | Out-of-order webhook deliveries must never overwrite newer data. | `WHERE notion_tasks.notion_last_edited_time IS NULL OR EXCLUDED.notion_last_edited_time >= notion_tasks.notion_last_edited_time` (no `EXCLUDED... IS NULL` bypass). |
| **INV-5 (Safe Scans)** | Absence from a partial scan never implies deletion. Vanished tasks are flagged out-of-scope ONLY on 100% complete, uncapped scans. | Out-of-source remediation in `app/sync/reconcile.py` executes only when pagination finished, `page_failures == 0`, and Notion did **not** report `request_status.type == "incomplete"` (10 000-result cap). |
| **INV-6 (Transactional Integrity)** | Task row upsert and inbox status transition (`processed`) must occur within the same PostgreSQL transaction. | `with_transaction()` helper (`app/db/pool.py`) used by every branch of `app/sync/worker.py` (BEGIN … COMMIT, ROLLBACK on failure, connection release). |
| **INV-7 (Absolute Secret Redaction)** | API tokens, DB credentials, and signatures must never appear in logs or error traces. | Regex pattern scrubbers in `app/logging_config.py` and `sanitize_error_message()` in `app/errors.py`. |

---

## 4. Technology Stack

All technologies and versions are pinned and verified:

| Category | Technology | Role in System | Verified Version |
|---|---|---|---|
| **Runtime & Tooling** | [Python](https://www.python.org/) & [uv](https://github.com/astral-sh/uv) | Modern Python runtime & ultra-fast package manager | Python `>=3.12`, uv `>=0.5` |
| **Web Framework** | [FastAPI](https://fastapi.tiangolo.com/) | High-performance ASGI Webhook & Health API | `>=0.115.0` |
| **ASGI Server** | [Uvicorn](https://www.uvicorn.org/) | Production lightning-fast ASGI server | `>=0.32.0` |
| **Database Driver** | [Psycopg 3](https://www.psycopg.org/psycopg3/) | Native async PostgreSQL driver with connection pooling | `psycopg[binary] >=3.2.0`, `psycopg-pool >=3.2.0` |
| **Database** | [PostgreSQL (Neon)](https://neon.tech/) | Serverless relational storage for normalized tasks & durable inbox | PostgreSQL 18 |
| **HTTP Client** | [HTTPX](https://www.python-httpx.org/) | Asynchronous HTTP client with connection pooling & retries | `>=0.27.0` (API: `2026-03-11`) |
| **Validation & Config** | [Pydantic v2](https://docs.pydantic.dev/) | Strict runtime settings & envelope validation | `pydantic >=2.9.0`, `pydantic-settings >=2.6.0` |
| **CLI Framework** | [Typer](https://typer.tiangolo.com/) | Production CLI for worker, backfill, reconcile, recovery | `>=0.12.0` |
| **Linting & Formatting** | [Ruff](https://github.com/astral-sh/ruff) | Extremely fast Python linter and code formatter | `>=0.7.0` |
| **Type Checking** | [Mypy](https://mypy-lang.org/) | Strict static typing across application and tests | `>=1.12.0` |
| **Testing** | [Pytest](https://pytest.org/) | Async test runner with ASGI client and embedded PostgreSQL | `pytest >=8.3.0`, `pytest-asyncio >=0.24.0` |
| **TypeScript Reference** | Node.js + Vitest | Surviving parallel implementation & verification reference | Node 22+, Vitest 3.2.7 (128 passed) |

---

## 5. System Architecture

### 5.1 Ingestion Flow (Webhooks)
1. Notion emits an event (e.g., `page.properties_updated`) to `POST /webhooks/notion`.
2. FastAPI captures the exact raw payload bytes before deserialization.
3. If an initial subscription handshake is detected (`verification_token`), the token is logged (last 4 characters only) and a `200 {"ok":true}` response is returned.
4. For event payloads, HMAC-SHA256 signature verification is performed against `X-Notion-Signature` using `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
5. The validated payload is inserted into `notion_sync.sync_inbox` with status `pending`.
6. FastAPI responds `200 {"ok":true}` (or `503` if PostgreSQL is unreachable).

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
- **Backfill (`notion-sync backfill`):** Traverses the Notion Data Source using cursor pagination (`start_cursor`), normalizes each task, and upserts into `notion_tasks`. Records progress and cycle checks in `notion_sync.sync_runs`. If Notion reports an incomplete result set (`request_status.type == "incomplete"`, the 10 000-result query cap) or any page fails, the run is recorded as `partial` instead of `succeeded`.
- **Reconciliation (`notion-sync reconcile`):** Performs a full sweep across Notion. Only if the scan terminates normally, has 0 page errors, and was **not** capped by Notion does it identify tasks present in PostgreSQL that are missing from Notion and flag them with `is_in_source = false` (INV-5). On any partial or capped scan, remediation is skipped and the run is recorded as `partial`. This command is a **CLI job with no in-process scheduler** — schedule it externally (e.g. cron, systemd timer, Windows Task Scheduler, or Kubernetes CronJob) at the cadence matching `SYNC_RECONCILIATION_INTERVAL_MINUTES`.

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

    subgraph Service["Notion Tasks Sync Service (Python 3.12 + FastAPI)"]
        subgraph HTTP["FastAPI HTTP Server (:3000)"]
            H_HEALTH["GET /health & /ready"]
            H_WH["POST /webhooks/notion"]
            H_SIG{"Verify HMAC-SHA256\n(Raw Request Bytes)"}
            H_WH --> H_SIG
        end

        subgraph Worker["Background Sync Worker"]
            W_CLAIM["Claim Event (SKIP LOCKED)"]
            W_FETCH["Re-fetch Page & Blocks (INV-2)"]
            W_NORM["Normalize Task Record"]
            W_TX["Atomic Transaction (INV-6)"]
            W_CLAIM --> W_FETCH --> W_NORM --> W_TX
        end

        subgraph Ops["Operational Typer CLI Jobs"]
            CLI_MIG["uv run notion-sync migrate"]
            CLI_BACK["uv run notion-sync backfill"]
            CLI_REC["uv run notion-sync reconcile"]
            CLI_OP["notion-sync retry-failed\nnotion-sync recover-stuck"]
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
├── pyproject.toml               # Python project configuration, dependencies, and tool settings
├── uv.lock                      # Deterministic uv dependency lockfile
├── .python-version              # Pinned Python version (3.12)
├── Dockerfile                   # Multi-stage production container build (Python 3.12-slim)
├── compose.yaml                 # Docker Compose services (api, worker, reconcile, postgres)
├── .dockerignore                # Container build exclusions
├── .gitignore                   # Ignores .venv, node_modules, .env, and test caches
├── .github/workflows/ci.yml     # GitHub Actions CI workflow (lint, typecheck, pytest)
├── AGENTS.md                    # Core project boundaries & instructions for AI agents
├── Me.md                        # Developer context, invariants, and operational summary
├── README.md                    # Comprehensive repository documentation (this file)
├── package.json                 # Node.js manifest & cross-ecosystem CLI wrapper scripts
│
├── app/                         # Primary Python Application Package
│   ├── main.py                  # FastAPI application factory and route registration
│   ├── config.py                # Pydantic v2 settings & environment validation
│   ├── logging_config.py        # Structured logging with secret redaction
│   ├── errors.py                # Error taxonomy (Notion, DB, Config) & secret sanitization
│   ├── lifespan.py              # FastAPI lifespan managing connection pool lifecycle
│   ├── api/                     # HTTP API endpoints
│   │   ├── health.py            # GET /health (liveness) and GET /ready (readiness)
│   │   └── webhooks.py          # POST /webhooks/notion (raw bytes signature & durable inbox)
│   ├── db/                      # Database connection pool & data access layer
│   │   ├── pool.py              # Psycopg 3 connection pool with async transaction context
│   │   ├── inbox_repo.py        # sync_inbox repository (enqueue, claim, settle, recover)
│   │   ├── tasks_repo.py        # notion_tasks repository (INV-4 upsert, tombstone, scope)
│   │   ├── runs_repo.py         # sync_runs ledger (audit tracking for backfill & reconcile)
│   │   └── migrate.py           # Migration runner (advisory locks, checksum validation)
│   ├── sync/                    # Synchronization domain logic
│   │   ├── notion_client.py     # HTTPX Notion API client wrapper with retry & backoff
│   │   ├── normalize.py         # Pure mapping from Notion Page object to PostgreSQL task
│   │   ├── property_map.py      # Default property mappings & flexible name resolution
│   │   ├── retry_policy.py      # Exponential backoff with full jitter and Retry-After parsing
│   │   ├── worker.py            # Background inbox worker loop & event dispatch matrix
│   │   ├── backfill.py          # Initial cursor-paginated data source backfill
│   │   └── reconcile.py         # Periodic full-scan reconciliation engine (INV-5)
│   └── cli/                     # Typer CLI commands
│       ├── main.py              # Root Typer CLI application (`notion-sync`)
│       ├── worker.py            # `notion-sync worker` command
│       ├── backfill.py          # `notion-sync backfill` command
│       ├── reconcile.py         # `notion-sync reconcile` command
│       ├── recover_stuck.py     # `notion-sync recover-stuck` command
│       ├── retry_failed.py      # `notion-sync retry-failed` command
│       └── migrate.py           # `notion-sync migrate` command
│
├── migrations/                  # Schema migration definitions
│   └── 0001_init.sql            # Schema DDL (notion_tasks, sync_inbox, sync_runs, indexes)
│
├── tests/                       # Automated test suites (140 pytest tests across 16 files)
│   ├── unit/                    # 12 unit test files (mocks, schemas, normalization, TLS, CLI routing)
│   ├── integration/             # 3 integration test files (real PostgreSQL 18 via embedded instance)
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

1. **Python:** Version `3.12` or higher (verified with Python 3.12 LTS).
2. **uv Package Manager:** Recommended for fast, reproducible dependency resolution (`pip install uv` or `curl -LsSf https://astral.sh/uv/install.sh`).
3. **PostgreSQL Database:**
   - A [Neon Lakebase](https://neon.tech/) PostgreSQL instance (recommended for production).
   - Alternatively, any standard PostgreSQL instance (version 16, 17, or 18).
4. **Notion Internal Integration:**
   - Create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations).
   - Grant **Read content** permissions.
   - Connect the integration to your Notion Tasks Database (**Database settings → Connect to → Your Integration**).
5. **Notion Webhook Subscription:**
   - A configured webhook subscription pointing to your public HTTPS endpoint (`https://<domain>/webhooks/notion`).

---

## 8. Installation & Setup

### Step 1: Clone Repository
```bash
git clone https://github.com/mddawoodrahman/notion.git
cd notion
```

### Step 2: Install Dependencies with uv
```bash
# Install all dependencies including dev tools (ruff, mypy, pytest)
uv sync --all-extras --dev
```

### Step 3: Configure Environment Variables
Copy the example environment configuration:
```bash
# Unix / macOS:
cp .env.example .env

# Windows PowerShell:
Copy-Item .env.example .env
```
Edit `.env` and configure your credentials (see [Section 9](#9-environment-variables)).

### Step 4: Run Database Migrations
Apply the initial schema (`notion_sync`) and create tables:
```bash
uv run notion-sync migrate
```
Verify the migration status:
```bash
uv run notion-sync migrate status
# Output: [✓] 0001_init.sql (applied at ...)
```

### Step 5: Test Initial Backfill (Dry Run)
Validate connectivity and data source resolution without writing to the database:
```bash
uv run notion-sync backfill --dry-run
```

### Step 6: Execute Live Initial Backfill
Import all existing Notion tasks into PostgreSQL:
```bash
uv run notion-sync backfill
```

### Step 7: Launch the Webhook Server & Worker
```bash
# Terminal 1 — FastAPI HTTP Webhook API:
uv run uvicorn app.main:app --host 0.0.0.0 --port 3000

# Terminal 2 — Asynchronous Background Sync Worker:
uv run notion-sync worker
```

---

## 9. Environment Variables

The application strictly validates configuration on boot using Pydantic v2 Settings (`app/config.py`). Missing or malformed required variables immediately prevent startup with descriptive, sanitized error messages.

| Variable | Purpose | Required? | Default | Example Value |
|---|---|---|---|---|
| `NODE_ENV` / `ENVIRONMENT` | Runtime environment mode | No | `development` | `development`, `test`, `production` |
| `PORT` | HTTP port for FastAPI server | No | `3000` | `3000` |
| `NOTION_API_KEY` | Notion Internal Integration Token | **Yes (Prod)** | None | `secret_abcdef123456...` or `ntn_...` |
| `NOTION_DATABASE_ID` | Master Tasks Database UUID | **Yes (Prod)** | None | `32-character hex UUID` |
| `NOTION_DATA_SOURCE_ID` | Target Data Source UUID (if DB has >1) | Optional | None | `data-source-uuid` |
| `NOTION_VERSION` | Pinned Notion API version | No | `2026-03-11` | `2026-03-11` |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | Secret for HMAC-SHA256 signature verification | **Yes (Prod)** | None | `vft_secret_token_min_32_chars` |
| `ALLOW_UNSIGNED_WEBHOOKS` | Explicit opt-out of webhook signature verification. **Development only**; forbidden in production (rejected at startup). | No | `false` | `true` |
| `DATABASE_URL` | Neon pooled PostgreSQL connection string | **Yes (Prod)** | None | `postgresql://user:pass@ep-pool.neon.tech/neondb?sslmode=require` |
| `DIRECT_DATABASE_URL` | Direct connection string for migrations | Optional | None | `postgresql://user:pass@ep-direct.neon.tech/neondb?sslmode=require` |
| `DB_SSL_INSECURE` | Development-only opt-out of TLS certificate verification for self-signed local databases | No | `false` | `true` |
| `TEST_DATABASE_URL` | Optional custom database URL for tests | No | None | `postgresql://user:pass@localhost:5432/testdb` |
| `SYNC_TIMEZONE` | IANA timezone used to derive `due_date` for timed due dates | No | `Asia/Kolkata` | `Asia/Kolkata`, `America/New_York` |
| `SYNC_RECONCILIATION_INTERVAL_MINUTES` | Recommended cadence for the **external** reconciliation scheduler | No | `30` | `30` (1 to 1440) |
| `SYNC_MAX_ATTEMPTS` | Maximum retry attempts before marking event failed | No | `8` | `8` (1 to 20) |
| `SYNC_PAGE_SIZE` | Query page size for Notion pagination | No | `100` | `100` (max 100) |
| `SYNC_SYNC_BODY_CONTENT` | Enables serialization of task body blocks | No | `true` | `true`, `false` |
| `SYNC_LEASE_SECONDS` | Concurrency lock duration for claimed inbox events | No | `300` | `300` (30 to 3600) |
| `LOG_LEVEL` | Logging verbosity (automatically redacts secrets) | No | `info` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

---

## 10. Operational Commands & CLI

All operational operations are unified under the `notion-sync` Typer CLI:

```bash
# --- Primary Python Operational CLI ---
uv run notion-sync --help              # Display CLI commands and options
uv run notion-sync worker              # Start continuous background inbox processing worker
uv run notion-sync backfill            # Execute full cursor-paginated initial backfill
uv run notion-sync backfill --dry-run  # Dry-run backfill (fetches/normalizes, skips DB writes)
uv run notion-sync reconcile           # Run full reconciliation sweep (INV-5 safe scan)
uv run notion-sync reconcile --dry-run # Dry-run reconciliation sweep
uv run notion-sync retry-failed        # Requeue failed inbox events back to pending
uv run notion-sync recover-stuck       # Release worker processing leases older than SYNC_LEASE_SECONDS
uv run notion-sync migrate             # Apply pending migrations with advisory locks
uv run notion-sync migrate status      # Inspect applied vs pending migrations and checksums

# --- Running HTTP Webhook Server ---
uv run uvicorn app.main:app --port 3000 --reload  # Development with hot reload
uv run uvicorn app.main:app --port 3000           # Production execution

# --- Quality Gates & Testing ---
uv run ruff check app tests            # Lint check across codebase
uv run ruff format --check app tests   # Check formatting compliance
uv run mypy app tests                  # Static type checking (53 source files)
uv run pytest                          # Run all 140 automated tests
uv run pytest tests/unit               # Run 90 unit tests
uv run pytest tests/integration        # Run 41 real PostgreSQL integration tests
uv run pytest tests/e2e                # Run 9 acceptance tests

# --- npm Cross-Ecosystem Aliases ---
npm run py:worker                      # Alias for uv run notion-sync worker
npm run py:db:migrate                  # Alias for uv run notion-sync migrate
npm run py:sync:backfill               # Alias for uv run notion-sync backfill
npm run py:sync:reconcile              # Alias for uv run notion-sync reconcile
npm run py:sync:retry-failed           # Alias for uv run notion-sync retry-failed
npm run py:sync:recover-stuck          # Alias for uv run notion-sync recover-stuck
npm run py:test                        # Alias for uv run pytest
npm run py:lint                        # Alias for uv run ruff check app tests
npm run py:typecheck                   # Alias for uv run mypy app tests
```

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

The normalization layer ([`app/sync/normalize.py`](file:///d:/Notion/app/sync/normalize.py) and [`app/sync/property_map.py`](file:///d:/Notion/app/sync/property_map.py)) performs case-insensitive candidate matching:

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

The FastAPI service exposes three HTTP endpoints:

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
    "timestamp": "2026-10-27T01:30:00.000Z"
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
      "timestamp": "2026-10-27T01:30:00.000Z"
    }
    ```
  - Response: `200 OK` `{"ok": true}`
  - Duplicate delivery: `200 OK` `{"ok": true, "duplicate": true}`
  - Invalid signature: `401 Unauthorized` `{"ok": false}`
  - Missing `X-Notion-Signature` header: `401 Unauthorized` `{"ok": false}`
  - Verification token not configured in production: `503 Service Unavailable` `{"ok": false}` — fails closed
  - Malformed envelope: `400 Bad Request` `{"ok": false}`
  - Database unavailable: `503 Service Unavailable` `{"ok": false}` (Prompts Notion to retry)

---

## 13. Testing & Verification

The project enforces rigorous automated test coverage with **two deliberately different harnesses**:

- **Integration tests run against real, isolated PostgreSQL 18 instances** (ephemeral embedded clusters, zero mocks) — **zero database mocks**. SQL semantics, constraints, `ON CONFLICT` guards, `SKIP LOCKED` concurrency, and transaction rollback are verified by actually executing them.
- **The acceptance (e2e) suite runs the full flow against an in-memory harness** through FastAPI `TestClient` and the real worker/backfill/reconcile code paths.

### Test Summary

```
============================ 140 passed in 22.07s =============================
```

| Test Suite | File Count | Tests | Target / Description |
|---|---|---|---|
| **Unit Tests** | 12 | 90 | Config parsing and fail-fast validation, error classification (transient network/timeout detection), secret sanitization, normalization (timezone-aware due dates, content-preservation semantics), health routes, mock Notion client (retry policy, `request_status` propagation), worker event branches (resolve-once data source, rollback), backfill/reconcile incomplete-scan safety, repository SQL contracts, pool TLS resolution, migration CLI routing. |
| **Integration Tests** | 3 | 41 | Applied against real local PostgreSQL 18: schema DDL, constraints, advisory locks, checksum drift, `ON CONFLICT` INV-4 guards (including null-timestamp rejection), `page_content_json` preservation, `SKIP LOCKED` claims, lease expiry, transaction rollback/commit. |
| **Acceptance / E2E** | 1 | 9 | Full webhook ingestion, signature validation, handshake, and worker settlement through FastAPI route injection against the in-memory harness. |

### Running Tests

```bash
# Run full suite (16 files, 140 tests):
uv run pytest

# Run only unit tests (90 tests):
uv run pytest tests/unit

# Run only integration tests against real PostgreSQL 18 (41 tests):
uv run pytest tests/integration

# Run only acceptance tests (9 tests):
uv run pytest tests/e2e

# Run Mypy static type checking:
uv run mypy app tests

# Run Ruff linter and formatter checks:
uv run ruff check app tests
uv run ruff format --check app tests
```

---

## 14. Production Deployment Topology

For high availability and fault isolation, three distinct processes should run in production:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Production Deployment                        │
├───────────────────────────────┬─────────────────────────────────┤
│ 1. HTTP API Webhook Process   │ uv run uvicorn app.main:app     │
│    (FastAPI Webhook Receiver) │ Listens on :3000                │
├───────────────────────────────┼─────────────────────────────────┤
│ 2. Background Sync Worker     │ uv run notion-sync worker       │
│    (Queue Consumer)           │ Long-running polling loop       │
├───────────────────────────────┼─────────────────────────────────┤
│ 3. Reconciliation Job         │ uv run notion-sync reconcile    │
│    (Audit & Repair, CLI)      │ Invoked by an EXTERNAL          │
│                               │ scheduler (cron / systemd timer │
│                               │ / Task Scheduler), e.g. 30 min  │
└───────────────────────────────┴─────────────────────────────────┘
```

> [!IMPORTANT]
> The service itself contains **no cron or in-process scheduler**. Reconciliation must be triggered by an external scheduler (host cron, systemd timer, Windows Task Scheduler, Kubernetes CronJob, or a container platform scheduler). `SYNC_RECONCILIATION_INTERVAL_MINUTES` documents the recommended cadence but is not consumed by the service.

### Connection String Strategy (Neon)
- **Runtime Application (`DATABASE_URL`):** Point to the **Neon Pooled endpoint** (e.g., `ep-pool-name-pooler.region.neon.tech`). This handles serverless connection scaling efficiently.
- **Migrations (`DIRECT_DATABASE_URL`):** Point to the **Neon Direct endpoint** (e.g., `ep-pool-name.region.neon.tech`). PostgreSQL session advisory locks (`pg_advisory_lock`) are required by `notion-sync migrate` and do not work across transaction poolers like PgBouncer.

---

## 15. Docker & Compose Operations

The repository includes a multi-stage production `Dockerfile` (using `uv` for ultra-fast, deterministic builds and running as unprivileged `appuser`) and `compose.yaml`:

```bash
# Build production Docker image
docker build -t notion-tasks-pg-sync .

# Run Webhook API container
docker run -d \
  --name notion-sync-api \
  -p 3000:3000 \
  --env-file .env \
  notion-tasks-pg-sync

# Run Background Worker container
docker run -d \
  --name notion-sync-worker \
  --env-file .env \
  notion-tasks-pg-sync notion-sync worker

# Run Reconciliation one-off task
docker run --rm \
  --env-file .env \
  notion-tasks-pg-sync notion-sync reconcile

# Alternatively, manage with Docker Compose:
docker compose up -d api worker
docker compose run --rm reconcile
```

---

## 16. Troubleshooting & Operational Runbook

### Issue 1: Webhooks Returning 401 Unauthorized
**Symptom:** FastAPI logs `Rejected webhook delivery: signature verification failed`.  
**Causes & Checks:**
1. `NOTION_WEBHOOK_VERIFICATION_TOKEN` is incorrect in `.env`.
2. Reverse proxy modified the body before FastAPI received it. FastAPI reads raw request bytes before parsing to ensure exact cryptographic byte matching.
3. Check handshake logs: when Notion sends the initial handshake, retrieve the logged token suffix and ensure it matches your environment secret.

If the token is **not configured at all in production**, the receiver fails closed and answers `503` (nothing is stored) — set `NOTION_WEBHOOK_VERIFICATION_TOKEN`, or, in development only, opt in with `ALLOW_UNSIGNED_WEBHOOKS=true`.

---

### Issue 2: Migration Fails with Advisory Lock Error
**Symptom:** `pg_advisory_lock` error when running `notion-sync migrate`.  
**Cause:** Attempting to run migrations through a transaction pooler (such as PgBouncer or Neon Pooled URL).  
**Solution:** Set `DIRECT_DATABASE_URL` to point to the direct PostgreSQL host (unpooled) and re-run `uv run notion-sync migrate`.

---

### Issue 3: Worker Leases Stuck in "Processing"
**Symptom:** An event remains in `processing` status indefinitely after a worker container crash.  
**Solution:**
The worker automatically runs lease recovery periodically. To manually reset expired leases immediately:
```bash
uv run notion-sync recover-stuck
```

---

### Issue 4: Webhook Events Marked as "Failed"
**Symptom:** Events exceed `SYNC_MAX_ATTEMPTS` due to temporary downstream downtime and are moved to `status = 'failed'`.  
**Solution:**
Inspect error messages in `notion_sync.sync_inbox` and run the operator requeue script:
```bash
uv run notion-sync retry-failed
```

---

## 17. Security & Operational Notes

- **Secret Redaction:** `logging_config.py` and `errors.py` scrub sensitive credentials (`NOTION_API_KEY`, `NOTION_WEBHOOK_VERIFICATION_TOKEN`, `DATABASE_URL`, passwords, authorization headers) from exception messages and logs before they reach the console or database columns.
- **HMAC Signature Validation (Fail-Closed):** Webhook payloads are verified against Notion's cryptographic signature over exact raw bytes before any ingestion logic is triggered. Without a configured token in production, the receiver answers `503` and stores nothing.
- **Verified TLS by Default:** PostgreSQL connections use certificate-verified TLS (`sslmode=require`) for every non-local host. `DB_SSL_INSECURE=true` is an explicit, development-only escape hatch for self-signed databases.
- **SQL Injection Prevention:** Every query in the codebase utilizes parameterized queries (`%s` in Psycopg 3). Zero SQL strings are constructed via string concatenation.
- **No Plaintext Secrets in Source Control:** `.env` is ignored by `.gitignore`. Real credentials belong only in environment variables or secure cloud secrets managers.
- **Quality Gates:** `uv run ruff check`, `uv run ruff format --check`, and `uv run mypy app tests` all exit 0 cleanly on the repository.

---

## 18. Known Limitations & Roadmap

### Known Limitations

- **Live Integration Pending Owner Credentials:** Local automated verification is green across all **140** unit, integration, and e2e tests (plus 128 tests in the TypeScript reference suite). Live API calls against Notion and Neon have not been exercised because production credentials have not yet been provided.
- **Reconciliation Requires an External Scheduler:** No in-process cron exists; forgetting to schedule `notion-sync reconcile` means drift accumulates silently (see Section 14).
- **One-Way Sync Only:** This service is intentionally a one-way mirror. Updating a record in PostgreSQL does not sync changes back to Notion.
- **Block Content Depth:** Page body block recursion is capped at 3 levels deep to prevent unbound execution times on deeply nested Notion page trees.
- **Single Master Data Source:** If a Notion database contains multiple data sources, `NOTION_DATA_SOURCE_ID` must be explicitly defined in `.env`.

### Roadmap

- [ ] Add Prometheus/OpenTelemetry metrics exporter for queue lag and sync run durations.
- [ ] Support custom field mapping overrides via external JSON configuration.
- [ ] Outbound webhooks emitting events to downstream microservices when tasks change.

---

## 19. Project Documentation Index & License

### Documentation Index

- [`docs/PRD.md`](file:///d:/Notion/docs/PRD.md): Product Requirements Document and data dictionary.
- [`docs/Notion_to_PostgreSQL_Sync_SPEC.md`](file:///d:/Notion/docs/Notion_to_PostgreSQL_Sync_SPEC.md): Technical specification, state machine diagrams, and failure matrix.
- [`docs/DEPLOYMENT_GUIDE.md`](file:///d:/Notion/docs/DEPLOYMENT_GUIDE.md): Detailed production hosting, role permissions, and secrets setup.
- [`docs/IMPLEMENTATION_STATUS.md`](file:///d:/Notion/docs/IMPLEMENTATION_STATUS.md): Truthful verification log and phase-by-phase completion report.
- [`docs/implementation-workflow.md`](file:///d:/Notion/docs/implementation-workflow.md): Phased implementation and acceptance testing protocol.

### License

Proprietary — Developed by **Dawood Rahman** ([@mddawoodrahman](https://github.com/mddawoodrahman)). All rights reserved.
