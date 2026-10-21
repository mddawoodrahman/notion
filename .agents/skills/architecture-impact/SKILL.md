---
name: architecture-impact
description: Analyze Git changes and code modifications to determine their impact on system architecture diagrams, detect architecture drift, selectively update affected draw.io diagrams via drawio MCP, and generate the architecture impact report. Triggers include /architecture-impact, 'analyze architecture impact', 'which diagrams are affected', or 'update affected architecture diagrams'.
---

# Architecture Impact Analysis (draw.io MCP)

This skill provides automated architecture impact analysis, drift detection, and selective synchronization of **draw.io** architecture diagrams (`docs/architecture/*.drawio`) when code changes occur in the repository.

---

## 1. Core Workflow (`/architecture-impact`)

```
Developer / Agent modifies code
        ↓
Trigger /architecture-impact
        ↓
1. Git Change Inspection (git status, git diff --stat, git diff)
        ↓
2. Architectural Component Categorization (20 Domains)
        ↓
3. Dependency Mapping & Impact Classification (DIRECT / INDIRECT / NO IMPACT / UNKNOWN)
        ↓
4. Impact Scoring (0 to 5)
        ↓
5. Architecture Drift Detection (STALE, MISSING, INCORRECT, POTENTIALLY_STALE)
        ↓
6. Selective draw.io Updates (Preserve layout, update only affected nodes/edges via MCP)
        ↓
7. MCP Diagram Validation (list_pages & get_page)
        ↓
8. Documentation Synchronization (SYSTEM_ARCHITECTURE.md & ARCHITECTURE_IMPACT.md)
```

---

## 2. Architectural Component Categories

Every modified file must be categorized into one or more of these 20 architectural domains based on implementation inspection:

1. **Frontend**: UI components, pages, client islands, state stores (`apps/frontend/src/`)
2. **Backend API**: Ninja REST routers, request schemas, error handlers (`apps/backend/apps/api/`)
3. **Domain Logic**: Business rules, services, state machines (`apps/backend/apps/domains/*`)
4. **Database**: PostgreSQL models, migrations, ORM schemas (`apps/shared/database/`, `migrations/`)
5. **Authentication**: Clerk JWT validation, session guards, user sync (`apps/domains/users/`, `proxy.ts`)
6. **Caching**: Redis keys, anti-stampede HerdClient, invalidation logic (`config/settings/`, `cache/`)
7. **Async Processing**: Celery tasks, worker queues, task signatures (`apps/backend/apps/*/tasks.py`)
8. **Celery Beat**: Periodic cron schedules, background intervals (`apps/backend/apps/core/celery.py`)
9. **Messaging & Outbox**: `OutboxEvent` persistence, `publish_outbox` relay, Kafka topics (`monitoring/`)
10. **Storage**: Cloudflare R2 bucket, `django-storages` + `boto3`, media pipelines (`settings/base.py`)
11. **Payments**: Stripe Checkout sessions, Payment Intents, HMAC webhooks (`domains/checkout/`, `payments/`)
12. **Shipping**: Shiprocket API client, AWB dispatch, tracking webhooks (`domains/shipping/`)
13. **Email**: Resend API service, HTML email templates (`domains/notifications/services/resend.py`)
14. **AI & LLM**: MultiProviderClient (OpenAI, Anthropic, Gemini), intent router (`domains/ai/`)
15. **Vector Search / RAG**: `pgvector` HNSW cosine distance search, 1536-dim embeddings (`domains/products/`)
16. **Infrastructure**: Gunicorn WSGI, WhiteNoise, connection pooling (`render.yaml`, `Procfile`)
17. **Deployment**: Vercel Serverless Edge, Render Web/Worker services, Neon Postgres (`vercel.json`)
18. **Configuration**: Environment boundaries, Django settings (`config/settings/*`)
19. **Observability**: Health probes, Sentry telemetry, Vercel Analytics (`monitoring/`, `layout.tsx`)
20. **Security**: Row locking (`select_for_update`), IDOR defenses, CSRF/HMAC verification

---

## 3. Architecture Dependency Map

Baseline mapping from source areas to affected diagrams:

| Source Area / Subsystem | Primary Diagram Target | Secondary Diagram Target |
| :--- | :--- | :--- |
| `apps/frontend/` | `C4_CONTEXT.drawio`, `C4_CONTAINER.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `DATA_FLOW.drawio` |
| `apps/api/` | `C4_CONTAINER.drawio`, `SYSTEM_ARCHITECTURE.drawio` | `DATA_FLOW.drawio` |
| `apps/domains/users/`, `proxy.ts` | `AUTH_FLOW.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `C4_CONTAINER.drawio` |
| `apps/domains/checkout/`, `payments/` | `PAYMENT_FLOW.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `DATA_FLOW.drawio` |
| `apps/domains/orders/`, `inventory/` | `PAYMENT_FLOW.drawio`, `DATA_FLOW.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `C4_CONTAINER.drawio` |
| `apps/domains/ai/`, `rag/` | `AI_RAG_FLOW.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `DATA_FLOW.drawio` |
| `apps/domains/shipping/` | `DATA_FLOW.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `C4_CONTAINER.drawio` |
| `apps/domains/monitoring/`, Outbox | `DATA_FLOW.drawio` | `SYSTEM_ARCHITECTURE.drawio`, `DEPLOYMENT.drawio` |
| Celery tasks / workers | `DATA_FLOW.drawio`, `DEPLOYMENT.drawio` | `SYSTEM_ARCHITECTURE.drawio` |
| Redis configuration & caching | `DEPLOYMENT.drawio`, `C4_CONTAINER.drawio` | `SYSTEM_ARCHITECTURE.drawio` |
| PostgreSQL models & migrations | `C4_CONTAINER.drawio`, `SYSTEM_ARCHITECTURE.drawio` | `DATA_FLOW.drawio` |
| Cloudflare R2 storage | `DEPLOYMENT.drawio`, `C4_CONTAINER.drawio` | `SYSTEM_ARCHITECTURE.drawio` |
| Deployment configs (`render.yaml`, `vercel.json`) | `DEPLOYMENT.drawio` | `SYSTEM_ARCHITECTURE.drawio` |

---

## 4. Impact Classification & Scoring

### Classifications
- **`DIRECT`**: Changed code modifies the diagram's explicit components, data flow lines, protocols, or state invariants.
- **`INDIRECT`**: Change touches surrounding domain logic or model fields that may influence context.
- **`NO IMPACT`**: Change is an internal style, test refactor, or documentation update with zero topology impact.
- **`UNKNOWN`**: Impact cannot be determined without deeper inquiry.

### Scoring Scale (0 to 5)
- **`0`**: No architectural impact (comments, formatting).
- **`1`**: Documentation-only / test assertion adjustments.
- **`2`**: Internal implementation detail (helper refactor, variable rename).
- **`3`**: Component behavior or invariant changed (e.g., locking strategy, query optimization).
- **`4`**: Component relationship, sequence, or data-flow changed.
- **`5`**: Architectural topology, external SaaS provider, or wire protocol changed.

---

## 5. Selective Modification Rules via draw.io MCP

1. **Selective Updating**: Only update diagrams marked **`DIRECT`** or where drift is confirmed.
2. **Preserve Diagram Integrity**:
   - Inspect existing XML with `get_page`.
   - Mutate only affected `<mxCell>` elements, labels, or connections.
   - Reapply via `set_page` or update the file directly.
3. **Shape Search**: If a new cloud service or database is introduced, search using `search_shapes` before constructing custom nodes.
4. **Mandatory MCP Validation**: Run `list_pages` and `get_page` to ensure valid `mxGraphModel` XML and verify decompression.

---

## 6. Required Output Document: `docs/architecture/ARCHITECTURE_IMPACT.md`

Every run must update or generate `docs/architecture/ARCHITECTURE_IMPACT.md` adhering strictly to this format:

```markdown
# Architecture Impact Report

## Change Summary
[High-level summary of the code change and rationale]

## Changed Files
- `path/to/file1.py`: [Summary of change]
- `path/to/file2.ts`: [Summary of change]

## Architectural Components Affected
[List of affected domains and subsystems]

## Diagram Impact Matrix

| Diagram | Impact | Score | Reason |
| :--- | :---: | :---: | :--- |
| `SYSTEM_ARCHITECTURE.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `C4_CONTEXT.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `C4_CONTAINER.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `DATA_FLOW.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `DEPLOYMENT.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `AUTH_FLOW.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `PAYMENT_FLOW.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |
| `AI_RAG_FLOW.drawio` | DIRECT / INDIRECT / NO IMPACT | 0-5 | [Detailed technical justification] |

## Confirmed Architecture Drift
[List of drift items detected: STALE, MISSING, INCORRECT, POTENTIALLY_STALE]

## Updated Diagrams
[List of diagrams updated and verified via MCP]

## Unchanged Diagrams
[List of diagrams verified to require no modifications]

## Unknown / Requires Review
[Any items requiring architectural confirmation]

## Architecture Risks
[Identified architectural risks, bottlenecks, or trade-offs]

## Verification
- MCP `list_pages` verification: PASS
- MCP `get_page` verification: PASS
```
