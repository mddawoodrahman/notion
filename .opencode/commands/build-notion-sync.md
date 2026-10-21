---
description: Implement or resume the Notion-to-PostgreSQL sync service in tested phases
---

You are implementing the Notion Tasks PostgreSQL synchronization service in this repository.

1. Read `AGENTS.md`, `docs/PRD.md`, `docs/implementation-workflow.md`, and `docs/IMPLEMENTATION_STATUS.md` if present.
2. Audit the actual repository and Git status before changing files. Do not overwrite existing work.
3. Implement the next phase in the workflow. If no status file exists, start at Phase 0. If `$ARGUMENTS` names a phase (for example `Phase 3`), work on that phase; otherwise resume the first incomplete phase.
4. Execute the phase's acceptance checks, fix defects, and do not mark the phase passed until evidence supports it. Update `docs/IMPLEMENTATION_STATUS.md` with files changed, commands, real results, blockers and next phase.
5. Continue through subsequent phases in the same session while acceptance gates pass and no external owner action is required. Do not stop after producing a plan only.
6. If Notion/Neon credentials or a deployed HTTPS URL are unavailable, do not invent them. Complete safe local work, write tests with mocks, and state exactly which live tests are blocked.
7. Keep analytics, historical business event tables, daily snapshots, reports and AI insights out of V1.
8. Finish with a concise summary of implemented work, tests actually run, remaining blockers and the next command/action.
