---
name: documentation-sync
description: Automatically detect codebase feature additions, modifications, or deletions across frontend and backend, evaluate documentation impact, synchronize README.md, technical docs, API registries, database models, environment variables, changelog, and draw.io architecture diagrams. Triggers include /documentation-sync, 'sync documentation', 'update documentation for recent changes', 'audit documentation drift', or 'synchronize README and architecture'.
---

# Automatic Documentation Synchronization System (`/documentation-sync`)

This skill orchestrates the end-to-end audit, classification, and synchronization of project documentation with executable code in the repository.

---

## 1. Synchronization Architecture

```
                       ┌────────────────────────┐
                       │    CODEBASE CHANGE     │
                       └───────────┬────────────┘
                                   │
                                   ▼
                       ┌────────────────────────┐
                       │  Feature & Diff Audit  │
                       └───────────┬────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
            Frontend            Backend          Database/Infra
                │                  │                  │
                └──────────────────┼──────────────────┘
                                   ▼
                      Documentation Classification
                     (16 Types, Impact: NONE→CRIT)
                                   │
             ┌─────────────────────┼─────────────────────┐
             ▼                     ▼                     ▼
         README.md          docs/ & features/       Architecture
             │                     │                     │
             │                     │                     ▼
             │                     │            architecture-impact
             │                     │                     │
             │                     │                     ▼
             │                     │                draw.io MCP
             │                     │                     │
             └─────────────────────┼─────────────────────┘
                                   ▼
                             CHANGELOG.md
                                   │
                                   ▼
                              .env.example
                                   │
                                   ▼
                       DOCUMENTATION_IMPACT.md
                                   │
                                   ▼
                           Consistency Check
```

---

## 2. Truth Hierarchy & Invariants

When sources conflict, the following truth hierarchy **must** be enforced:

1. **Source Code** (`apps/frontend/`, `apps/backend/`, `apps/shared/`)
2. **Configuration** (`render.yaml`, `vercel.json`, `settings/*.py`)
3. **Database Schema & Migrations** (`apps/shared/database/migrations/`)
4. **Automated Tests** (`tests/`)
5. **Technical Specifications** (`docs/`)
6. **Public README** (`README.md`)
7. **Architecture Diagrams** (`docs/architecture/*.drawio`)
8. **Historical Reports** (`docs/archive/`)

### Mandatory Rules
- **Zero Hallucination**: Never document features, endpoints, models, or environment variables that cannot be verified from source or configuration.
- **Scope Control**: Do not rewrite README or diagrams for internal refactors, comments, test adjustments, or minor CSS tweaks (`Impact: NONE`).
- **Secret Sanitization**: Never write real API keys, passwords, or tokens into documentation or `.env.example`.
- **Infinite Loop Prevention**: If the Git diff contains only documentation files (`DOCUMENTATION_ONLY`), stop the synchronization cycle immediately.

---

## 3. Change Classification Matrix

Every code modification must be tagged with one or more of these 16 categories:

| Category | Typical Source Path | Documentation Targets |
| :--- | :--- | :--- |
| **`FEATURE`** | `apps/frontend/src/app/`, `apps/backend/apps/domains/` | `README.md`, `docs/features/`, `CHANGELOG.md` |
| **`BUG_FIX`** | Any bug remediation in services or controllers | `CHANGELOG.md`, relevant `docs/` |
| **`API_CHANGE`** | `apps/api/`, Ninja routers, schemas, serializers | `docs/api/`, `docs/features/`, `README.md` |
| **`DATABASE_CHANGE`** | `apps/shared/database/`, `migrations/`, models | `docs/database/`, `docs/architecture/` |
| **`AUTH_CHANGE`** | `apps/domains/users/`, `proxy.ts`, Clerk handlers | `docs/features/customer-identity.md`, `AUTH_FLOW.drawio` |
| **`UI_CHANGE`** | `apps/frontend/src/components/`, pages, stores | `docs/frontend/`, `README.md` (if major) |
| **`CONFIG_CHANGE`** | `config/settings/*`, `next.config.ts`, `.env.example` | `docs/deployment/`, `README.md`, `.env.example` |
| **`DEPLOYMENT_CHANGE`** | `render.yaml`, `vercel.json`, `Dockerfile` | `docs/deployment/`, `DEPLOYMENT.drawio` |
| **`SECURITY_CHANGE`** | Row locks, CSRF, CSP, IDOR guards, HMAC | `docs/security/`, `docs/architecture/` |
| **`PERFORMANCE_CHANGE`** | Caching, query optimizations, index additions | `docs/database/`, `docs/backend/` |
| **`AI_CHANGE`** | `apps/domains/ai/`, prompts, RAG retriever, LLMs | `docs/features/ai-concierge.md`, `AI_RAG_FLOW.drawio` |
| **`INTEGRATION_CHANGE`** | Stripe, Shiprocket, Resend, Cloudflare R2 | `docs/integrations/`, `docs/features/` |
| **`ARCHITECTURE_CHANGE`** | Topology, tiers, brokers, boundaries | `docs/architecture/`, `SYSTEM_ARCHITECTURE.drawio` |
| **`DEPENDENCY_CHANGE`** | `package.json`, `pyproject.toml`, `requirements.txt` | `README.md`, `docs/deployment/` |
| **`DOCUMENTATION_ONLY`** | Changes limited to `*.md`, `*.drawio`, `docs/` | **NO-OP (Loop Prevention)** |
| **`INTERNAL_REFACTOR`** | Helper extractions, renames without behavioral shift | **NO-OP** |

---

## 4. Documentation Impact Levels

- **`NONE`**: Variable renames, formatting, internal refactors. $\to$ *No documentation touched.*
- **`LOW`**: Internal utility module addition. $\to$ *Update internal comments or subsystem README.*
- **`MEDIUM`**: New API endpoint, model, or environment variable. $\to$ *Update `docs/api/`, `docs/database/`, or `docs/deployment/`.*
- **`HIGH`**: New major feature (e.g. Wishlist, AI Concierge), auth change, or payment gateway. $\to$ *Update `README.md`, create `docs/features/<feature>.md`, update `CHANGELOG.md`, trigger `architecture-impact`.*
- **`CRITICAL`**: Fundamental framework swap, database engine change, or deployment restructuring. $\to$ *Full repository documentation and architecture refresh.*

---

## 5. Execution Workflow (`/documentation-sync`)

When triggered:

1. **Inspect Git State**:
   ```bash
   git status --short
   git diff --stat
   git diff
   git log --oneline -10
   ```
2. **Loop Check**: If all changed files are in `docs/`, `README.md`, `CHANGELOG.md`, or `*.drawio`, exit immediately.
3. **Audit Features & Components**: Map modified files to concrete features, domain models, APIs, and configuration boundaries.
4. **Synchronize Documentation**:
   - **`README.md`**: Update feature list, tech stack badges, environment variables, or architecture summary if High/Critical impact.
   - **`docs/features/<feature>.md`**: Create or update deep-dive specifications for user-visible features.
   - **`docs/api/` & `docs/database/`**: Keep route and schema registries synchronized.
   - **`.env.example`**: Ensure all newly introduced `os.getenv()` / `process.env` keys are documented without secrets.
   - **`CHANGELOG.md`**: Record clean, standard Keep-A-Changelog entries (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
5. **Coordinate Architecture Sync**: If architectural boundaries or flows are affected, invoke `architecture-impact` to selectively update `.drawio` files via `@drawio/mcp`.
6. **Generate Report**: Publish [`docs/DOCUMENTATION_IMPACT.md`](file:///d:/Obsorne/docs/DOCUMENTATION_IMPACT.md).
7. **Consistency Validation**: Run markdown link checks and MCP diagram verification.
