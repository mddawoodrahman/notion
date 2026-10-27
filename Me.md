# Me.md — Developer & Project Context

**Developer / Owner:** Dawood Rahman ([@mddawoodrahman](https://github.com/mddawoodrahman))  
**Application:** TaskBridge — Notion to PostgreSQL Sync Engine  
**Tagline:** Bridge your tasks. Synchronize with confidence.  
**Package:** `taskbridge`  
**Repository:** [github.com/mddawoodrahman/notion](https://github.com/mddawoodrahman/notion)  
**Primary Stack:** Python 3.12+, FastAPI, Uvicorn, PostgreSQL (Neon), Psycopg 3 (Async & Pool), Pydantic v2, Typer, pytest, Ruff, Mypy, uv  

---

## 1. Project Purpose & Philosophy

TaskBridge is a high-reliability, one-way synchronization engine that bridges my Microsoft To Do–inspired Notion task database to a dedicated PostgreSQL database on Neon. 

- **Single System of Record:** Notion is the only interface where I create, edit, complete, categorize, and archive tasks. PostgreSQL is a queryable, current-state replica for future backend systems and automations.
- **Pragmatic & Invariant-Driven:** I value simple, robust architectures with clear operational boundaries over unnecessary layers of abstraction, bloated ORMs, or premature feature creep.
- **Verification First:** No code is complete without type safety (Mypy), transaction boundaries, and verifiable test coverage. Evidence precedes assertions.

---

## 2. Core Architectural Invariants (Non-Negotiable)

Any tool, agent, or developer working on this codebase must preserve these rules:

1. **INV-1 (Stable Identity):** Exactly one PostgreSQL row per Notion page UUID (`notion_page_id`). No repeat sync, retry, or backfill creates duplicates.
2. **INV-2 (Authoritative State):** Webhook payloads are lightweight change signals, never the complete record. The worker must fetch the fresh Notion page object before synchronizing.
3. **INV-3 (Durable Ingestion):** Webhook requests are acknowledged (`200 OK`) only after being committed to `notion_sync.sync_inbox`. If PostgreSQL is unreachable, return `503` so Notion retries.
4. **INV-4 (No Regression):** Upserts guard against out-of-order webhook deliveries using `notion_last_edited_time`. An older snapshot will never overwrite a newer record.
5. **INV-5 (Safe Scans):** Absence from a reconciliation scan never implies deletion. Tombstoning (`notion_in_trash = true` or `is_in_source = false`) requires positive evidence or a 100% complete scan with zero page failures.
6. **INV-6 (Transactional Integrity):** Task row upsert and inbox status transition (`processed`) must occur within the same PostgreSQL transaction.
7. **INV-7 (Absolute Secret Redaction):** No Notion API tokens, database connection passwords, or webhook verification tokens may appear in logs, error traces, or source control.

---

## 3. Strict Project Boundaries (V1 Scope Exclusions)

Do not add the following to V1:
- **No Productivity Analytics / Dashboards:** No charts, KPI calculators, summary views, or SQL reports.
- **No ML / AI Insights:** No ML models or background AI summarizers.
- **No Event History Tables:** Do not create `task_events` or `daily_task_snapshots`.
- **No Bidirectional Editing:** Never write task changes from PostgreSQL back into Notion.
- **No Binary Storage:** Do not download or store Notion attachment binaries.

---

## 4. How I Work & Agent Instructions

When interacting with this codebase:
- **Be direct and concise:** Skip fluff and conversational overhead. Deliver concrete code, clear explanations, and verified test results.
- **Audit before touching:** Inspect existing files, configuration, and migrations before modifying anything.
- **Test with evidence:** Always run `uv run ruff check app tests`, `uv run mypy app tests`, and `uv run pytest` before presenting work as complete.
- **Fail safely:** If credentials or environment variables are missing, write mocked unit tests and clearly report the blocker without inventing credentials.
- **Keep `.env` clean:** Placeholders belong in `.env.example`. Real secrets belong only in environment variables or host secret managers.

---

## 5. Daily Commands & Workflow Reference

```powershell
# Quality & Verification
uv run ruff check app tests          # Fast linting
uv run ruff format --check app tests # Code formatting verification
uv run mypy app tests                # Static type checking
uv run pytest                        # All tests (Unit, Integration, E2E)

# Services
uv run uvicorn app.main:app --port 3000   # FastAPI HTTP Webhook & Health API
uv run taskbridge worker                  # Background async sync worker loop

# Operations & Database
uv run taskbridge migrate                # Apply schema migrations (direct connection)
uv run taskbridge migrate status         # Inspect applied vs pending migrations
uv run taskbridge backfill               # Run paginated initial backfill
uv run taskbridge backfill --dry-run     # Backfill dry-run (fetch + normalize only)
uv run taskbridge reconcile              # Run scheduled full reconciliation scan
uv run taskbridge retry-failed           # Requeue failed webhook events back to pending
uv run taskbridge recover-stuck          # Reset expired worker processing leases
```

---

## 6. Project Documentation Index

- [`docs/PRD.md`](./docs/PRD.md): Official product requirements and data model.
- [`docs/Notion_to_PostgreSQL_Sync_SPEC.md`](./docs/Notion_to_PostgreSQL_Sync_SPEC.md): Complete engineering contracts and algorithms.
- [`docs/implementation-workflow.md`](./docs/implementation-workflow.md): Phased implementation protocol and quality gates.
- [`docs/IMPLEMENTATION_STATUS.md`](./docs/IMPLEMENTATION_STATUS.md): Current implementation progress and verification evidence.
- [`docs/DEPLOYMENT_GUIDE.md`](./docs/DEPLOYMENT_GUIDE.md): Production deployment, secret configuration, and operational playbooks.
