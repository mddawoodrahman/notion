#!/usr/bin/env bash

set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

STATE_DIR=".agents/.state"
LOG_FILE="$STATE_DIR/PostInvocation.log"
STATE_FILE="$STATE_DIR/documentation-required"

mkdir -p "$STATE_DIR"

INPUT="$(cat 2>/dev/null || true)"

{
  printf '\n===== PostInvocation =====\n'
  printf 'timestamp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'cwd=%s\n' "$PWD"
  printf '%s\n' "$INPUT"
} >> "$LOG_FILE"

if [[ ! -f "$STATE_FILE" ]]; then
  cat <<'JSON'
{
  "injectSteps": [],
  "terminationBehavior": ""
}
JSON
  exit 0
fi

cat <<'JSON'
{
  "injectSteps": [
    {
      "ephemeralMessage": "OSBORNE ENGINEERING GATE: You have made repository changes. Before considering the task complete, synchronize documentation. Review and update README.md, apps/frontend/README.md, apps/backend/README.md, and the appropriate files under docs/. Documentation must describe the actual implementation, architecture, configuration, testing, and deployment state. After documentation is synchronized, run the repository verification/CI gate. Do not declare the task complete until the final verification passes."
    }
  ],
  "terminationBehavior": "force_continue"
}
JSON