#!/usr/bin/env bash

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

STATE_DIR=".agents/.state"
LOG_FILE="$STATE_DIR/Stop.log"
mkdir -p "$STATE_DIR"

INPUT="$(cat 2>/dev/null || true)"

{
  printf '\n==========================================\n'
  printf ' OSBORNE FINAL ENGINEERING GATE\n'
  printf '==========================================\n'
  printf 'timestamp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'cwd=%s\n' "$PWD"
  printf 'stdin=%s\n' "$INPUT"
} >> "$LOG_FILE"

DOC_CHECK=".agents/scripts/docs/verify-doc-sync.sh"
CI_CHECK=".agents/scripts/ci/verify-all-ci.sh"

FAILED=0

{
  echo "[1/3] Documentation verification"
  if bash "$DOC_CHECK" 2>&1; then
    echo "PASS: Documentation"
  else
    echo "FAIL: Documentation"
    FAILED=1
  fi

  echo
  echo "[2/3] CI verification"
  if bash "$CI_CHECK" 2>&1; then
    echo "PASS: CI"
  else
    echo "FAIL: CI"
    FAILED=1
  fi

  echo
  echo "[3/3] Git safety verification"
  if git diff --check 2>&1; then
    echo "PASS: Git diff check"
  else
    echo "FAIL: Git diff check"
    FAILED=1
  fi
  echo "=========================================="
} >> "$LOG_FILE" 2>&1

if [[ "$FAILED" -ne 0 ]]; then
  echo "FINAL ENGINEERING GATE: FAILED" >> "$LOG_FILE"
  cat <<'JSON'
{
  "decision": "continue",
  "reason": "OSBORNE final engineering gate failed. Fix documentation, tests, CI, lint, build, or git validation failures before completing the task."
}
JSON
  exit 0
fi

echo "FINAL ENGINEERING GATE: PASSED" >> "$LOG_FILE"
cat <<'JSON'
{
  "decision": "allow",
  "reason": "Engineering gate passed."
}
JSON
exit 0
