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

/**
 * Errors that are safe to retry when a request is only acquiring a database
 * connection.  SQLSTATE class 08 is the PostgreSQL connection-exception
 * class; the remaining codes cover the transient pool/server conditions we
 * can observe during a rolling restart.  The message fallback is deliberately
 * narrow because Drizzle may omit the driver's error code from some pool
 * acquisition failures.
 */
export function isTransientDatabaseError(err: unknown): boolean {
  const code = getPgErrorCode(err);
  if (code?.startsWith('08')) return true;
  if (code && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN)$/i.test(code)) return true;
  if (code && new Set([
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '55P03', // lock_not_available
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '53300', // too_many_connections
  ]).has(code)) return true;

  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error
      ? current.message
      : typeof (current as { message?: unknown }).message === 'string'
        ? (current as { message: string }).message
        : '';
    if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN)\b/i.test(message)) return true;
    if (/connection (?:acquisition|attempt|terminated|reset|closed|refused|timed out)|(?:database|db)\s+(?:connection|unavailable|timeout)|pool\s+(?:is\s+)?exhausted|timeout exceeded when trying to connect/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isNormalizedUserEmailConflict(err: unknown): boolean {
  if (getPgErrorCode(err) !== '23505') return false;
  const constraint = getPgErrorConstraint(err);
  // Application writes normalize before insertion, so an exact concurrent
  // duplicate may be reported by the legacy column UNIQUE constraint before
  // PostgreSQL reaches the normalized expression index.
  return constraint === 'users_email_normalized_unique'
    || constraint === 'users_email_unique';
}
