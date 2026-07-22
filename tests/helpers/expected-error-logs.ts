/**
 * Expected-error-log test helper (Task #746).
 *
 * Several in-process unit/service tests intentionally exercise error
 * branches (SendGrid 503, payment-customer-sync
 * giving up, crypto/decrypt failures, provider-not-configured, …).
 * Production code logs those at `[ERROR]` via `server/logger`, so on a
 * fully *green* run the test output is polluted with real `[ERROR]`
 * lines that look like failures but aren't.
 *
 * This module provides:
 *
 *   1. `expectErrorLog(matcher)` — declare that the current test is
 *      *expected* to emit an in-process `[ERROR]` line matching
 *      `matcher`. Declared lines are suppressed from stdout (so green
 *      runs stay quiet) and are NOT treated as guard violations.
 *
 *   2. `getCapturedErrorLogs()` — read every in-process `[ERROR]` line
 *      emitted during the current test (expected or not) so a test can
 *      still assert on the message/context if it wants to.
 *
 *   3. `createMockLogger()` — build an in-memory fake `Logger` for the
 *      `vi.mock('../../server/logger', …)` pattern, with the captured
 *      calls exposed for assertions. Reduces the boilerplate duplicated
 *      across the suite's logger-mocking files.
 *
 * The runtime enforcement (intercepting `consoleBuffer`, failing a
 * passing test that emits an *undeclared* `[ERROR]` line) lives in
 * `tests/setup/error-log-guard.ts`, which drives the
 * `recordInProcessLogLine` / `takeUnexpectedErrorLines` /
 * `resetErrorLogState` functions exported here. Those three are
 * internal plumbing — test files should only need `expectErrorLog`,
 * `getCapturedErrorLogs`, and `createMockLogger`.
 *
 * Scope note: only `[ERROR]` lines are guarded. `[INFO]`/`[WARN]`/
 * `[DEBUG]` noise is intentionally out of scope. The child-process
 * (spawned Express) boundary is handled separately via the
 * `LV_TEST_QUIET_APP` knob in `tests/setup/spawn-test-app.ts`; this
 * helper only sees the *in-process* logger sink.
 */
import { vi } from 'vitest';

const ERROR_MARKER = '[ERROR]';

export type LogMatcher = RegExp | string;

export interface CapturedLogCall {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  args: unknown[];
}

interface ErrorExpectation {
  matcher: LogMatcher;
  matches: number;
}

// Per-test state. Reset in the guard's global `afterEach` (and read
// just before the reset so a failing test still surfaces its line).
let expectations: ErrorExpectation[] = [];
let capturedErrorLines: string[] = [];
let unexpectedErrorLines: string[] = [];

function lineMatches(line: string, matcher: LogMatcher): boolean {
  return typeof matcher === 'string' ? line.includes(matcher) : matcher.test(line);
}

/**
 * Declare that the current test is expected to emit an in-process
 * `[ERROR]` log line matching `matcher`. Call this BEFORE the code
 * under test runs. The matched line is suppressed from stdout and does
 * not trip the error-log guard.
 *
 * A single `expectErrorLog(...)` call allowlists every line matching
 * `matcher` for the duration of the test (error paths often log the
 * same line on retry), so you don't need one call per emission.
 */
export function expectErrorLog(matcher: LogMatcher): void {
  expectations.push({ matcher, matches: 0 });
}

/**
 * Every in-process `[ERROR]` line emitted during the current test, in
 * order, with the trailing newline stripped. Includes both declared
 * (expected) and undeclared lines so a test can assert on the content.
 */
export function getCapturedErrorLogs(): readonly string[] {
  return capturedErrorLines;
}

/**
 * Build an in-memory fake `Logger` suitable for
 * `vi.mock('../../server/logger', () => ({ logger, createLogger: () => logger }))`.
 *
 * Because `vi.mock` factories are hoisted above normal imports, wire
 * this through `vi.hoisted(...)` in the consuming test, e.g.:
 *
 *   const { logger, calls } = vi.hoisted(() =>
 *     // eslint-disable-next-line @typescript-eslint/no-require-imports
 *     require('../helpers/expected-error-logs').createMockLogger(),
 *   );
 *   vi.mock('../../server/logger', () => ({ logger, createLogger: () => logger }));
 *
 * `calls` accumulates every logged call; `errors()` / `warns()` are
 * convenience filters for assertions.
 */
export function createMockLogger() {
  const calls: CapturedLogCall[] = [];
  const make = (level: CapturedLogCall['level']) =>
    vi.fn((message: string, ...args: unknown[]) => {
      calls.push({ level, message, args });
    });
  const logger = {
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
  };
  return {
    logger,
    createLogger: () => logger,
    calls,
    errors: () => calls.filter((c) => c.level === 'error'),
    warns: () => calls.filter((c) => c.level === 'warn'),
    reset: () => {
      calls.length = 0;
      logger.info.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
      logger.debug.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal plumbing consumed by tests/setup/error-log-guard.ts only.
// ---------------------------------------------------------------------------

/**
 * Record a single chunk written to the in-process `consoleBuffer`.
 *
 * Returns `true` when the chunk is a declared-expected `[ERROR]` line
 * that the interceptor should SUPPRESS (not print). Returns `false`
 * for everything else: non-error lines pass through untouched, and
 * undeclared `[ERROR]` lines pass through (so they stay visible) but
 * are recorded as violations for the guard's `afterEach` to fail on.
 */
export function recordInProcessLogLine(chunk: string): boolean {
  if (!chunk.includes(ERROR_MARKER)) return false;
  const line = chunk.replace(/\n+$/, '');
  capturedErrorLines.push(line);
  for (const expectation of expectations) {
    if (lineMatches(line, expectation.matcher)) {
      expectation.matches += 1;
      return true;
    }
  }
  unexpectedErrorLines.push(line);
  return false;
}

/** Snapshot of undeclared `[ERROR]` lines seen during the current test. */
export function takeUnexpectedErrorLines(): string[] {
  return unexpectedErrorLines.slice();
}

/** Clear all per-test state. Called by the guard's `afterEach`. */
export function resetErrorLogState(): void {
  expectations = [];
  capturedErrorLines = [];
  unexpectedErrorLines = [];
}
