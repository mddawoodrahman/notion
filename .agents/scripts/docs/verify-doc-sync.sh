#!/usr/bin/env bash

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

STATE_FILE=".agents/.state/documentation-required"

echo "=========================================="
echo " OSBORNE DOCUMENTATION VERIFICATION"
echo "=========================================="

if [[ ! -f "$STATE_FILE" ]]; then
  echo "No documentation-required state detected."
  exit 0
fi

README_ROOT="README.md"
README_FRONTEND="apps/frontend/README.md"
README_BACKEND="apps/backend/README.md"
DOCS_DIR="docs"

FAILED=0

for file in \
  "$README_ROOT" \
  "$README_FRONTEND" \
  "$README_BACKEND"
do
  if [[ ! -f "$file" ]]; then
    echo "FAIL: Missing $file"
    FAILED=1
  else
    echo "FOUND: $file"
  fi
done

if [[ ! -d "$DOCS_DIR" ]]; then
  echo "FAIL: docs/ directory missing"
  FAILED=1
else
  echo "FOUND: docs/"
fi

CHANGED_FILES="$(
  {
    git diff --name-only
    git diff --name-only --cached
    git ls-files --others --exclude-standard
  } | sort -u
)"

echo
echo "Changed files:"
echo "$CHANGED_FILES"

echo
echo "Documentation changes:"
echo "$CHANGED_FILES" | grep -E \
  '^(README\.md|apps/frontend/README\.md|apps/backend/README\.md|docs/)' \
  || true

ROOT_DOC_CHANGED=false
FRONTEND_DOC_CHANGED=false
BACKEND_DOC_CHANGED=false
DOCS_CHANGED=false

if echo "$CHANGED_FILES" | grep -qx 'README.md'; then
  ROOT_DOC_CHANGED=true
fi

if echo "$CHANGED_FILES" | grep -qx 'apps/frontend/README.md'; then
  FRONTEND_DOC_CHANGED=true
fi

if echo "$CHANGED_FILES" | grep -qx 'apps/backend/README.md'; then
  BACKEND_DOC_CHANGED=true
fi

if echo "$CHANGED_FILES" | grep -q '^docs/'; then
  DOCS_CHANGED=true
fi

if [[ "$ROOT_DOC_CHANGED" != true ]]; then
  echo "FAIL: Root README.md was not updated."
  FAILED=1
fi

if [[ "$FRONTEND_DOC_CHANGED" != true ]]; then
  echo "FAIL: apps/frontend/README.md was not updated."
  FAILED=1
fi

if [[ "$BACKEND_DOC_CHANGED" != true ]]; then
  echo "FAIL: apps/backend/README.md was not updated."
  FAILED=1
fi

if [[ "$DOCS_CHANGED" != true ]]; then
  echo "FAIL: docs/ was not updated."
  FAILED=1
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo
  echo "DOCUMENTATION GATE: FAILED"
  exit 1
fi

echo
echo "DOCUMENTATION GATE: PASSED"

rm -f "$STATE_FILE"

exit 0