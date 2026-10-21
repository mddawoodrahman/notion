#!/usr/bin/env bash

set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

STATE_DIR=".agents/.state"
LOG_FILE="$STATE_DIR/PostToolUse.log"
STATE_FILE="$STATE_DIR/documentation-required"

mkdir -p "$STATE_DIR"

# Consume the Antigravity hook payload from stdin.
INPUT="$(cat 2>/dev/null || true)"

{
  printf '\n===== PostToolUse =====\n'
  printf 'timestamp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'cwd=%s\n' "$PWD"
  printf '%s\n' "$INPUT"
} >> "$LOG_FILE"

# Detect tracked/staged/untracked changes.
CHANGED_FILES="$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  } | sort -u
)"

if [[ -z "${CHANGED_FILES// }" ]]; then
  rm -f "$STATE_FILE"
  printf '{}\n'
  exit 0
fi

REQUIRES_DOCS=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  case "$file" in
    README.md)
      ;;
    apps/frontend/README.md)
      ;;
    apps/backend/README.md)
      ;;
    docs/*)
      ;;
    .agents/.state/*)
      ;;
    .agents/hooks/*)
      ;;
    .agent-hook-test.txt)
      ;;
    *)
      REQUIRES_DOCS=true
      ;;
  esac
done <<< "$CHANGED_FILES"

if [[ "$REQUIRES_DOCS" == "true" ]]; then
  printf '%s\n' "$CHANGED_FILES" > "$STATE_FILE"
else
  rm -f "$STATE_FILE"
fi

# PostToolUse MUST return valid JSON on stdout.
printf '{}\n'

exit 0