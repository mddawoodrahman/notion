# Notion Tasks → PostgreSQL Agent Kit

This kit gives OpenCode and Google Antigravity the same implementation requirements while using each tool's supported project convention.

## Recommended destination

Extract/copy these files into the **root of your Notion-to-PostgreSQL app repository**, for example:

`D:\Notion\notion-tasks-sync\`

Do not put the kit inside a random nested folder unless that folder is the actual Git repository root. Keep an existing application intact and compare files before replacing any existing `AGENTS.md` or config.

## Contents

- `docs/PRD.md` — project requirements.
- `docs/implementation-workflow.md` — canonical phased implementation workflow and acceptance gates.
- `AGENTS.md` — project rules read by OpenCode and many other coding agents.
- `.opencode/commands/build-notion-sync.md` — OpenCode slash command.
- `.agents/skills/notion-postgres-sync/SKILL.md` — workspace Agent Skill for Antigravity.
- `docs/notion_postgres_sync_architecture.png` — architecture image referenced by the PRD.

## Use in OpenCode

1. Open the repository root in OpenCode.
2. Ensure `AGENTS.md`, `docs/PRD.md`, and `docs/implementation-workflow.md` are in place.
3. The project command lives at `.opencode/commands/build-notion-sync.md`.
4. Start OpenCode in that repository and run:

   `/build-notion-sync`

   To focus a particular phase, pass it after the command, for example `/build-notion-sync Phase 3`.

5. Let the agent inspect first. Review every migration and `.env.example` before running commands against Neon.

OpenCode docs: https://docs.opencode.ai/docs/rules/ and https://dev.opencode.ai/docs/commands

## Use in Google Antigravity

1. Open the repository root as the workspace.
2. Copy `.agents/skills/notion-postgres-sync/SKILL.md` into the workspace skill folder exactly as provided.
3. Antigravity discovers workspace skills from `.agents/skills/`. The skill folder name is `notion-postgres-sync`.
4. Start the agent and invoke `/notion-postgres-sync`, or ask the agent to use the `notion-postgres-sync` skill.
5. The skill reads `docs/PRD.md` and `docs/implementation-workflow.md`, then resumes from `docs/IMPLEMENTATION_STATUS.md`.

Workspace path:

`.agents/skills/notion-postgres-sync/SKILL.md`

Optional global path if you want the skill in all workspaces (Windows):

`%USERPROFILE%\.gemini\config\skills\notion-postgres-sync\SKILL.md`

For this project, workspace-specific installation is preferable so the skill and PRD are versioned together. Current Antigravity docs prefer Agent Skills over the previous standalone workflows format.

Docs: https://www.antigravity.google/docs/skills?tab=ide and https://antigravity.google/docs/migration/workflows-to-skills

## First run instruction

The first run should audit the repo, verify the installed Notion SDK and official API contract, check Git status, and create `docs/IMPLEMENTATION_STATUS.md`. It should not assume credentials exist or overwrite them. If credentials are not ready, it must implement and test safe local phases and report exact remaining setup steps.

## Security reminder

Never commit `.env`, Notion integration tokens, webhook verification tokens, or the full Neon connection string. Use `.env.example` with placeholders and configure real secrets only in your local environment or hosting provider's secret settings.
