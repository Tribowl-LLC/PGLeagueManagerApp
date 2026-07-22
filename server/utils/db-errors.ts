/**
 * Helpers for inspecting database errors.
 *
 * Drizzle wraps the underlying `pg` driver error: a failed query throws
 * an `Error('Failed query: <sql>')` whose original Postgres error — the
 * one carrying the SQLSTATE `code` (e.g. `'23505'` unique_violation) —
 * is attached on `error.cause` rather than spread onto the top-level
 * error. Callers that used to read `error.code` directly therefore see
 * `undefined` and miss the constraint violation.
 *
 * `getPgErrorCode` walks the `cause` chain (checking the top-level error
 * first, so directly-thrown pg errors and hand-built test errors still
 * work) and returns the first SQLSTATE code it finds.
 */
export function getPgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function getPgErrorConstraint(err: unknown): string | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && constraint.length > 0) {
      return constraint;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
