#!/usr/bin/env bash

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

FAILED=0

run_check() {
  local name="$1"
  shift

  echo
  echo "=========================================="
  echo "$name"
  echo "=========================================="

  if "$@"; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    FAILED=1
  fi
}

echo "=========================================="
echo " OSBORNE CI/CD VERIFICATION"
echo "=========================================="

# -----------------------------
# FRONTEND
# -----------------------------

if [[ -f "apps/frontend/package.json" ]]; then
  pushd apps/frontend >/dev/null

  run_check "Frontend TypeScript" npm run typecheck
  run_check "Frontend Lint" npm run lint
  run_check "Frontend Tests" npm test
  run_check "Frontend Production Build" npm run build

  popd >/dev/null
fi

# -----------------------------
# BACKEND
# -----------------------------

if [[ -f "apps/backend/manage.py" ]]; then
  pushd apps/backend >/dev/null

  run_check "Django System Check" \
    python manage.py check

  run_check "Migration Consistency" \
    python manage.py makemigrations --check --dry-run

  run_check "Backend Tests" \
    pytest

  popd >/dev/null
fi

# -----------------------------
# SECURITY
# -----------------------------

# Add the exact repository security commands here
# after inspecting .github/workflows/security.yml.

echo
echo "=========================================="

if [[ "$FAILED" -ne 0 ]]; then
  echo "OSBORNE CI GATE: FAILED"
  exit 1
fi

echo "OSBORNE CI GATE: PASSED"
exit 0
