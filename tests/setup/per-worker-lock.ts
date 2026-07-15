/**
 * Side-effect-free shared module for the test-DB clone advisory-lock
 * key (Task #722).
 *
 * `scripts/cleanup-test-dbs.ts` and `tests/setup/per-worker-setup.ts`
 * must serialise on the SAME Postgres advisory lock so that:
 *   - global setup's cleanup pass cannot drop a worker DB while
 *     another worker is mid-clone, and
 *   - two workers never CREATE DATABASE … TEMPLATE concurrently
 *     (Postgres forbids any other connection on the source DB during
 *     a clone, so unsynchronised attempts fail with
 *     "source database … is being accessed by other users").
 *
 * The lock key is derived deterministically from the template-DB name
 * so both modules compute the same int32 without sharing runtime state.
 *
 * IMPORTANT: this file MUST remain free of imports with side effects
 * (no spawning, no DB connections, no top-level `await`). It is
 * imported by the cleanup script which runs in contexts that must NOT
 * provision per-worker infra.
 */

export function validateTestTemplateDatabaseName(value: string): string {
  if (
    !/^leaguevault_test_[a-z0-9_]+$/.test(value) ||
    Buffer.byteLength(value, 'utf8') > 63
  ) {
    throw new Error(
      'TEST_TEMPLATE_DB_NAME must be a PostgreSQL-safe identifier beginning with leaguevault_test_ and no longer than 63 bytes.',
    );
  }
  return value;
}

export const TEMPLATE_DB_NAME = validateTestTemplateDatabaseName(
  process.env.TEST_TEMPLATE_DB_NAME ?? 'leaguevault_test_template',
);

export const CLONE_ADVISORY_LOCK_KEY = (() => {
  let h = 0;
  for (const c of TEMPLATE_DB_NAME) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return h;
})();
