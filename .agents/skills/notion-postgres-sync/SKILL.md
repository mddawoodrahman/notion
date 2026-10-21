---
name: notion-postgres-sync
description: Implements and verifies a one-way Notion Tasks to PostgreSQL synchronization service in safe, tested phases. Use when creating, continuing, debugging, testing, or deploying the Notion-to-Neon sync project.
---

# Notion Tasks → PostgreSQL Implementation Skill

When this skill is invoked, read the repository's `AGENTS.md`, `docs/PRD.md`, `docs/implementation-workflow.md`, and `docs/IMPLEMENTATION_STATUS.md` (if present). Follow the phase order and acceptance gates in `docs/implementation-workflow.md` as the canonical implementation protocol.

## Execution rules

- Audit the existing repo before changing code; preserve existing files, data and migrations.
- Build real implementation code, not only a plan. Work phase by phase, run checks, fix failures, update `docs/IMPLEMENTATION_STATUS.md`, and continue when gates pass.
- Notion is the source of truth. V1 is one-way to PostgreSQL; no bidirectional updates.
- Use Notion page ID as the stable task key; use complete pagination, JSONB raw-property preservation, parameterized SQL and idempotent upserts.
- Verify the currently supported official Notion API version/endpoints/SDK methods. Do not guess API contracts.
- Verify webhook signatures using the exact raw body. Persist events durably before acknowledging them. Worker must fetch current page state before upserting.
- Implement retry/rate-limit handling, archive/trash/restore/move semantics, safe partial-scan behavior, worker restart recovery, and periodic reconciliation.
- Never invent secrets, IDs, deployment URLs or successful tests. If credentials are absent, use mocks, finish safe work, and document the live-test blocker.
- Do not commit `.env`. Do not print secrets. Never perform destructive production changes without owner approval.
- V1 excludes analytics, task-history reporting, `task_events`, daily snapshots, Python/Pandas, dashboards and AI insights.

## How to proceed

1. Find the first incomplete phase in `docs/IMPLEMENTATION_STATUS.md`, or start at Phase 0.
2. Implement only the current phase and its dependencies.
3. Run that phase's acceptance gate from `docs/implementation-workflow.md`.
4. Fix failures before continuing. Do not label unverified behavior as complete.
5. Update the status file with evidence, changed files, commands, test results, unresolved blockers, and the next phase.
6. Continue to the next phase if the gate passes and there is no external blocker.
7. At handover, list commands that actually work in this repository and state any remaining owner setup actions.
