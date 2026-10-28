# Ralph Autonomous Execution Loop

[Ralph](https://github.com/snarktank/ralph) is an autonomous AI agent loop that runs AI coding tools ([Amp](https://ampcode.com) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)) repeatedly until all user stories in a Product Requirements Document (`prd.json`) are completed.

## Structure

```text
scripts/ralph/
├── ralph.sh          # Bash runner for Linux/macOS/Git Bash
├── ralph.ps1         # Native PowerShell runner for Windows
├── prompt.md         # Prompt template for Amp
├── CLAUDE.md         # Prompt template for Claude Code
├── prd.json.example  # Reference schema for user stories
└── archive/          # Archived runs from past branches
```

## How to Use Ralph in this Project

### 1. Generate a PRD
Use the PRD skill (`.agents/skills/prd/SKILL.md`):
```text
Load the prd skill and create a PRD for [feature description]
```
This generates `tasks/prd-[feature-name].md`.

### 2. Convert PRD to Ralph Format
Use the Ralph skill (`.agents/skills/ralph/SKILL.md`):
```text
Load the ralph skill and convert tasks/prd-[feature-name].md to prd.json
```
Save or place `prd.json` in `scripts/ralph/prd.json` or the project root.

### 3. Run Ralph

#### On Windows (PowerShell):
```powershell
# Using Claude Code
.\scripts\ralph\ralph.ps1 -Tool claude -MaxIterations 10

# Using Amp
.\scripts\ralph\ralph.ps1 -Tool amp -MaxIterations 10
```

#### On Linux / macOS / Git Bash:
```bash
# Using Claude Code
./scripts/ralph/ralph.sh --tool claude 10

# Using Amp
./scripts/ralph/ralph.sh --tool amp 10
```

## Quality Feedback Loop for TaskBridge

When Ralph runs iterations in TaskBridge, ensure acceptance criteria specify the project quality gates:
- `uv run ruff check app tests`
- `uv run ruff format --check app tests`
- `uv run mypy app tests`
- `uv run pytest`
