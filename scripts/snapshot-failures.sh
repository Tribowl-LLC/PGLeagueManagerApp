#!/bin/bash
# Snapshot current typecheck, lint, and test results to
# .local/known-failures.md for local development diagnostics.
#
# Usage:
#   bash scripts/snapshot-failures.sh
#   npm run snapshot:failures
#
# The output file is gitignored local state. Atomic writes ensure a reader
# never sees a partially rendered report.

set -u

OUT=".local/known-failures.md"
SNAPSHOT_TMPDIR="$(mktemp -d)"
trap 'rm -rf "$SNAPSHOT_TMPDIR"' EXIT
mkdir -p .local

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Per-check caps and a global wall-clock cap keep this diagnostic bounded.
TOTAL_CAP=240
TYPECHECK_CAP=60
LINT_CAP=60
TEST_CAP=240
SCRIPT_STARTED_AT="$(date +%s)"

remaining_budget() {
  local now elapsed remaining
  now="$(date +%s)"
  elapsed=$((now - SCRIPT_STARTED_AT))
  remaining=$((TOTAL_CAP - elapsed))
  if [ "$remaining" -lt 1 ]; then
    echo 1
  else
    echo "$remaining"
  fi
}

run_check() {
  local name="$1"
  local per_check_cap="$2"
  local cmd="$3"
  local log="$SNAPSHOT_TMPDIR/${name}.log"
  local remaining cap rc

  remaining="$(remaining_budget)"
  cap="$per_check_cap"
  if [ "$remaining" -lt "$cap" ]; then
    cap="$remaining"
  fi

  echo "[snapshot-failures] running ${name} (cap ${cap}s)..." >&2
  if timeout --kill-after=10s "${cap}s" bash -c "$cmd" >"$log" 2>&1; then
    echo "PASS" > "$SNAPSHOT_TMPDIR/${name}.status"
  else
    rc=$?
    if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then
      echo "FAIL (TIMED OUT after ${cap}s)" > "$SNAPSHOT_TMPDIR/${name}.status"
    else
      echo "FAIL" > "$SNAPSHOT_TMPDIR/${name}.status"
    fi
  fi
  wc -l < "$log" | tr -d ' ' > "$SNAPSHOT_TMPDIR/${name}.lines"
}

emit_section() {
  local name="$1"
  local label="$2"
  local status lines
  status="$(cat "$SNAPSHOT_TMPDIR/${name}.status")"
  lines="$(cat "$SNAPSHOT_TMPDIR/${name}.lines")"
  echo "### ${label}: ${status} (${lines} lines of output)"
  echo
  if [[ "$status" == FAIL* ]]; then
    echo '```'
    tail -n 50 "$SNAPSHOT_TMPDIR/${name}.log"
    echo '```'
    echo
  fi
}

write_report_atomic() {
  local tmp_out
  tmp_out="$(mktemp .local/.known-failures.XXXXXX.md)"
  {
    echo "# Known failures (manual snapshot)"
    echo
    echo "_Generated: ${TIMESTAMP}_"
    echo
    echo "This report captures the typecheck, lint, and test state for local"
    echo "diagnostics. Run \`npm run snapshot:failures\` to refresh it."
    echo
    echo "## Status"
    echo
    emit_section "typecheck" "Typecheck (\`npm run check\`)"
    emit_section "lint" "Lint (\`npm run lint\`)"
    emit_section "test" "Tests (\`npm test -- --run --reporter=${TEST_REPORTER} --bail=20\`)"
  } > "$tmp_out"
  mv "$tmp_out" "$OUT"
}

# Vitest 4 removed the old basic reporter; retain the preferred reporter for
# compatibility and retry with the modern equivalent when necessary.
TEST_REPORTER="basic"
run_tests() {
  run_check "test" "$TEST_CAP" "npm test -- --run --reporter=${TEST_REPORTER} --bail=20"
  if grep -q "Failed to load custom Reporter from basic" "$SNAPSHOT_TMPDIR/test.log" 2>/dev/null; then
    echo "[snapshot-failures] vitest rejected --reporter=basic; retrying with --reporter=dot..." >&2
    TEST_REPORTER="dot"
    run_check "test" "$TEST_CAP" "npm test -- --run --reporter=${TEST_REPORTER} --bail=20"
  fi
}

run_check "typecheck" "$TYPECHECK_CAP" "npm run check"
run_check "lint" "$LINT_CAP" "npm run lint"
run_tests
write_report_atomic
echo "[snapshot-failures] wrote $OUT" >&2
