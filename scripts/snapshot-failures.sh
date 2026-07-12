#!/bin/bash
# Snapshot pre-existing typecheck/lint/test failures to .local/known-failures.md.
#
# Modes:
#   (default / "full")     Run typecheck + lint + tests synchronously,
#                          block until the full banner is written. Used
#                          by `npm run snapshot:failures` and any manual
#                          `bash scripts/snapshot-failures.sh` invocation.
#   --fast                 Run typecheck + lint synchronously (well under
#                          the 60s post-merge cap), write a banner with
#                          the test section marked PENDING, then detach
#                          a background `--tests-async` worker that
#                          reruns tests and atomically rewrites the
#                          banner when done. Used by post-merge.sh.
#   --tests-async          Internal: rerun tests, then atomically
#                          rewrite `.local/known-failures.md` reusing
#                          the cached typecheck/lint output from the
#                          most recent `--fast` invocation. Not meant to
#                          be invoked directly.
#
# The output file (.local/known-failures.md) is gitignored — it's a
# local-state artifact whose purpose is to surface the post-merge
# red/green state into the next task's initial context.
#
# Atomic writes: the banner is always written to a sibling temp file
# and then `mv`d into place so a concurrent reader never sees a
# half-written file.

set -u

MODE="full"
case "${1:-}" in
  --fast)         MODE="fast" ;;
  --tests-async)  MODE="tests-async" ;;
  --full|"")      MODE="full" ;;
  *)
    echo "[snapshot-failures] unknown arg: $1 (expected --fast | --tests-async | --full)" >&2
    exit 2
    ;;
esac

OUT=".local/known-failures.md"
CACHE_DIR=".local/.snapshot-cache"
mkdir -p .local "$CACHE_DIR"

if [ "$MODE" = "fast" ]; then
  # Persist typecheck/lint logs + status into CACHE_DIR so the
  # detached --tests-async worker can re-read them when rewriting
  # the banner with a fresh test result. Wipe stale state from any
  # prior run first.
  rm -f "$CACHE_DIR"/*.log "$CACHE_DIR"/*.status "$CACHE_DIR"/*.lines 2>/dev/null || true
  TMPDIR="$CACHE_DIR"
elif [ "$MODE" = "tests-async" ]; then
  # Reuse cached typecheck/lint output written by the preceding
  # --fast call. Do NOT wipe — that would delete the very files we
  # need to re-render the banner.
  TMPDIR="$CACHE_DIR"
else
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT
fi

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
LAST_TASK="${TASK_ID:-${REPLIT_TASK_ID:-unknown}}"

# Per-check caps (seconds). The full mode also enforces a global wall
# clock; fast/tests-async use only the per-check caps because the
# post-merge hook itself is what bounds wall time for --fast.
TOTAL_CAP=240
TYPECHECK_CAP=60
LINT_CAP=60
TEST_CAP=240
SCRIPT_STARTED_AT="$(date +%s)"

remaining_budget() {
  local now; now="$(date +%s)"
  local elapsed=$((now - SCRIPT_STARTED_AT))
  local remaining=$((TOTAL_CAP - elapsed))
  if [ "$remaining" -lt 1 ]; then
    echo 1
  else
    echo "$remaining"
  fi
}

# Pick a vitest reporter. Task spec calls for `--reporter=basic` (which
# capped output in vitest <1.0). Vitest 4.x removed `basic`; the modern
# equivalent is `dot`. We prefer `basic` per spec, and the test runner
# below auto-falls-back to `dot` if vitest rejects `basic` at runtime,
# so the banner still captures real test output instead of a
# "Failed to load custom Reporter from basic" startup error.
TEST_REPORTER="basic"

run_check() {
  local name="$1"
  local per_check_cap="$2"
  local cmd="$3"
  local log="$TMPDIR/${name}.log"
  local cap="$per_check_cap"
  if [ "$MODE" = "full" ]; then
    local remaining; remaining="$(remaining_budget)"
    if [ "$remaining" -lt "$cap" ]; then
      cap="$remaining"
    fi
    echo "[snapshot-failures] running ${name} (cap ${cap}s, remaining global ${remaining}s, reporter=${TEST_REPORTER} where applicable)..." >&2
  else
    echo "[snapshot-failures] running ${name} (cap ${cap}s, mode=${MODE}, reporter=${TEST_REPORTER} where applicable)..." >&2
  fi
  if timeout --kill-after=10s "${cap}s" bash -c "$cmd" >"$log" 2>&1; then
    echo "PASS" > "$TMPDIR/${name}.status"
  else
    local rc=$?
    if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then
      echo "FAIL (TIMED OUT after ${cap}s)" > "$TMPDIR/${name}.status"
    else
      echo "FAIL" > "$TMPDIR/${name}.status"
    fi
  fi
  wc -l < "$log" | tr -d ' ' > "$TMPDIR/${name}.lines"
}

emit_section() {
  local name="$1"
  local label="$2"
  local status; status="$(cat "$TMPDIR/${name}.status")"
  local lines; lines="$(cat "$TMPDIR/${name}.lines")"
  echo "### ${label}: ${status} (${lines} lines of output)"
  echo
  if [[ "$status" == FAIL* ]]; then
    echo '```'
    tail -n 50 "$TMPDIR/${name}.log"
    echo '```'
    echo
  fi
}

emit_pending_test_section() {
  local label="$1"
  local started_at="$2"
  echo "### ${label}: PENDING (running asynchronously; started ${started_at})"
  echo
  echo "_The test suite runs in the background after the post-merge hook returns."
  echo "This banner will be rewritten in-place once tests finish (typically"
  echo "3-5 minutes). Re-read this file then to see the fresh result, or run"
  echo "\`npm run snapshot:failures\` to block on a fresh full snapshot._"
  echo
}

# Atomic write helper: render the banner to a temp file in .local/
# (same FS as $OUT so `mv` is atomic) then rename into place.
write_banner_atomic() {
  local test_state="$1"  # "fresh" | "pending" | "stale"
  local test_started_at="${2:-}"
  local tmp_out; tmp_out="$(mktemp .local/.known-failures.XXXXXX.md)"
  {
    echo "# Known failures (post-merge snapshot)"
    echo
    echo "_Generated: ${TIMESTAMP}_"
    echo "_Last task: ${LAST_TASK}_"
    echo "_Test section: ${test_state}_"
    echo
    echo "This file is regenerated automatically after every task merge by"
    echo "\`scripts/snapshot-failures.sh\` (invoked from \`scripts/post-merge.sh\`,"
    echo "rerunnable via \`npm run snapshot:failures\`)."
    echo "It captures the red/green state of typecheck, lint, and tests on the"
    echo "newly-merged main, so the **next** task can see at a glance which checks"
    echo "are pre-existing failures vs. which it broke itself."
    echo
    echo "Per \`AGENTS.md\` project guidance: pre-existing failures should be"
    echo "fixed as part of any in-flight task unless they are clearly out-of-scope."
    echo
    echo "**Note:** the post-merge hook runs typecheck + lint synchronously and"
    echo "detaches the test suite into the background to fit the platform's 60s"
    echo "post-merge cap. The Tests section may therefore be marked PENDING"
    echo "(running) or stale (last-known result) for a few minutes after a merge."
    echo "Run \`npm run snapshot:failures\` for a synchronous full refresh."
    echo
    echo "## Status"
    echo
    emit_section "typecheck" "Typecheck (\`npm run check\`)"
    emit_section "lint" "Lint (\`npm run lint\`)"
    if [ "$test_state" = "pending" ]; then
      emit_pending_test_section "Tests (\`npm test -- --run --reporter=${TEST_REPORTER} --bail=20\`)" "$test_started_at"
    else
      emit_section "test" "Tests (\`npm test -- --run --reporter=${TEST_REPORTER} --bail=20\`)"
    fi
  } > "$tmp_out"
  mv "$tmp_out" "$OUT"
}

run_tests_with_basic_fallback() {
  run_check "test" "$TEST_CAP" "npm test -- --run --reporter=${TEST_REPORTER} --bail=20"
  if grep -q "Failed to load custom Reporter from basic" "$TMPDIR/test.log" 2>/dev/null; then
    echo "[snapshot-failures] vitest rejected --reporter=basic; retrying with --reporter=dot..." >&2
    TEST_REPORTER="dot"
    run_check "test" "$TEST_CAP" "npm test -- --run --reporter=${TEST_REPORTER} --bail=20"
  fi
}

case "$MODE" in
  full)
    run_check "typecheck" "$TYPECHECK_CAP" "npm run check"
    run_check "lint" "$LINT_CAP" "npm run lint"
    run_tests_with_basic_fallback
    write_banner_atomic "fresh"
    echo "[snapshot-failures] wrote $OUT (full)" >&2
    ;;
  fast)
    # Run typecheck + lint in parallel — together they're ~50-65s
    # serially, which busts the 60s post-merge cap. Running them
    # concurrently keeps the slower of the two as the wall-clock
    # bound (~30-40s) and leaves headroom for the rest of the
    # post-merge hook (npm install, db push, etc).
    run_check "typecheck" "$TYPECHECK_CAP" "npm run check" &
    TC_PID=$!
    run_check "lint" "$LINT_CAP" "npm run lint" &
    LINT_PID=$!
    wait "$TC_PID" || true
    wait "$LINT_PID" || true
    # Stash the test reporter for the async worker to honor.
    echo "$TEST_REPORTER" > "$CACHE_DIR/test-reporter"
    write_banner_atomic "pending" "$TIMESTAMP"
    echo "[snapshot-failures] wrote $OUT (fast; tests deferred)" >&2
    # Detach the test runner. Use setsid + nohup so it survives the
    # post-merge hook process group exiting. Redirect output to a log
    # file in CACHE_DIR for postmortems. Disown so this shell doesn't
    # wait on it.
    nohup setsid bash "$0" --tests-async \
      >"$CACHE_DIR/tests-async.log" 2>&1 </dev/null &
    disown $! 2>/dev/null || true
    ;;
  tests-async)
    # Reuse cached typecheck/lint output from the preceding --fast run.
    if [ ! -f "$CACHE_DIR/typecheck.status" ] || [ ! -f "$CACHE_DIR/lint.status" ]; then
      echo "[snapshot-failures] tests-async: missing cached typecheck/lint output; aborting" >&2
      exit 1
    fi
    if [ -f "$CACHE_DIR/test-reporter" ]; then
      TEST_REPORTER="$(cat "$CACHE_DIR/test-reporter")"
    fi
    run_tests_with_basic_fallback
    write_banner_atomic "fresh"
    echo "[snapshot-failures] wrote $OUT (tests-async)" >&2
    ;;
esac
