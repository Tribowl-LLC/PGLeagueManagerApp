/**
 * Tests the org-scoping guard added to
 * `server/scripts/create-square-customers.ts` in task #437.
 *
 * Before #437 the script selected bowlers globally and would happily
 * create Square customers for bowlers in other orgs whenever the
 * operator pointed it at one location's access token. The fix added a
 * required `--organizationId=<id>` flag and a pre-flight check that
 * `--locationId`'s row belongs to that org. If either invariant is
 * violated the script must exit non-zero BEFORE making any Square API
 * call.
 *
 * These tests cover the early-exit guard surface only — the parts that
 * fail before the script touches Square. They drive the real script via
 * spawnSync (mirroring tests/unit/check-eslint-baseline.test.ts) and
 * assert the exit code + the operator-facing error message. Tests that
 * require live Square credentials or a populated bowlers table are
 * intentionally out of scope here; the script's tail (Square API loop)
 * is unchanged from the pre-#437 behaviour and would be exercised by
 * an end-to-end backfill rehearsal in staging.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'server/scripts/create-square-customers.ts');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

function runScript(env: Record<string, string | undefined>, args: string[] = []): RunResult {
  // The script imports server/db, which requires DATABASE_URL to be
  // present at import time. We pass through the harness's value so the
  // import succeeds; the early-exit guards we're testing fire before
  // any real query is issued.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete childEnv[k];
    } else {
      childEnv[k] = v;
    }
  }
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    env: childEnv,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: (r.stdout || '') + (r.stderr || ''),
  };
}

// Each case spawns `npx tsx server/scripts/create-square-customers.ts`,
// which cold-starts tsx and imports server/db before the early-exit
// guards fire — empirically ~6s per invocation. Bump the per-test
// timeout well above vitest's 5s default so the whole guard surface
// can be exercised without false flakes.
const TEST_TIMEOUT_MS = 30_000;

describe('create-square-customers.ts — argument-parsing guards (task #437)', () => {
  it('exits 1 when SQUARE_ACCESS_TOKEN is missing', () => {
    const r = runScript({ SQUARE_ACCESS_TOKEN: undefined }, ['--organizationId=1', '--locationId=1']);
    expect(r.status).toBe(1);
    expect(r.combined).toMatch(/SQUARE_ACCESS_TOKEN is required/);
  }, TEST_TIMEOUT_MS);

  it('exits 1 with the task-#437 message when --organizationId is missing', () => {
    const r = runScript({ SQUARE_ACCESS_TOKEN: 'sandbox-token' }, ['--locationId=1']);
    expect(r.status).toBe(1);
    expect(r.combined).toMatch(/--organizationId=<id> is required/);
    expect(r.combined).toMatch(/task #437/);
  }, TEST_TIMEOUT_MS);

  it('exits 1 when --organizationId is non-numeric', () => {
    const r = runScript({ SQUARE_ACCESS_TOKEN: 'sandbox-token' }, ['--organizationId=abc', '--locationId=1']);
    expect(r.status).toBe(1);
    expect(r.combined).toMatch(/--organizationId=<id> is required/);
  }, TEST_TIMEOUT_MS);

  it('exits 1 when --organizationId is zero or negative', () => {
    const zero = runScript({ SQUARE_ACCESS_TOKEN: 'sandbox-token' }, ['--organizationId=0', '--locationId=1']);
    expect(zero.status).toBe(1);
    expect(zero.combined).toMatch(/--organizationId=<id> is required/);

    const neg = runScript({ SQUARE_ACCESS_TOKEN: 'sandbox-token' }, ['--organizationId=-5', '--locationId=1']);
    expect(neg.status).toBe(1);
    expect(neg.combined).toMatch(/--organizationId=<id> is required/);
  }, TEST_TIMEOUT_MS);

  it('exits 1 with the task-#402 message when --locationId is missing (after --organizationId is supplied)', () => {
    const r = runScript({ SQUARE_ACCESS_TOKEN: 'sandbox-token' }, ['--organizationId=1']);
    expect(r.status).toBe(1);
    expect(r.combined).toMatch(/--locationId=<id> is required/);
    expect(r.combined).toMatch(/task #402/);
  }, TEST_TIMEOUT_MS);

  it('rejects --organizationId before --locationId so the operator sees the org guard first', () => {
    // Both flags missing — the org-scoping guard must surface before the
    // location-stamp guard, since the org is the broader access boundary.
    const r = runScript({ SQUARE_ACCESS_TOKEN: 'sandbox-token' }, []);
    expect(r.status).toBe(1);
    expect(r.combined).toMatch(/--organizationId=<id> is required/);
    expect(r.combined).not.toMatch(/--locationId=<id> is required/);
  }, TEST_TIMEOUT_MS);
});
