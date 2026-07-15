/**
 * Side-effect-free home for the worker-DB cloning logic.
 *
 * Two cloning backends are supported and selected automatically:
 *
 *   1. **Neon Branches API** (Task #723) — preferred when
 *      `NEON_API_KEY` and `NEON_PROJECT_ID` are set. Each per-pool
 *      worker is a Neon branch off the persistent template branch.
 *      Branch creation is ~1-2s per branch, parallelisable, and
 *      avoids the `CREATE DATABASE … TEMPLATE` source-DB lock that
 *      caused 358s+ preclone-all buckets on bad-Neon-control-plane
 *      days under #722's serial-CREATE flow.
 *
 *   2. **Legacy CREATE DATABASE TEMPLATE** — used as a fallback when
 *      the Neon API creds are absent (e.g. CI without secrets, or
 *      an opt-out via `LV_TEST_USE_NEON_BRANCHES=0`). This path is
 *      preserved unchanged from #722 — serial preclone with the
 *      24-attempt 55006 retry loop and per-iteration adminPool
 *      tear-down (which empirically beats the shared-client variant
 *      43s → 180s on Neon).
 *
 * The module exposes:
 *   - `workerDbNameForPool(poolId)`  — deterministic per-pool name
 *     (used as both DB name in legacy mode AND branch name in API mode)
 *   - `cloneTemplate(targetName)`    — single clone with internal
 *     dispatch; returns the URL the caller should use as DATABASE_URL
 *   - `precloneAllWorkerDbs(maxPoolId)` — preclone for globalSetup
 *     (parallel in API mode, serial in legacy mode)
 *   - `cloneTemplateForWorker()`     — per-fork hot path (env-stash
 *     fast path for both modes)
 *
 * Importing this module must NOT have side effects beyond pulling in
 * `pg` and `./neon-branches`. Specifically: do NOT add a top-level
 * `await` here.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { assertSafeDatabaseHost } from '../../server/utils/db-safety';
import { assertCheckedMigrationsCurrent } from '../../scripts/lib/db-migration-runner';
import { CLONE_ADVISORY_LOCK_KEY, TEMPLATE_DB_NAME } from './per-worker-lock';
import {
  buildBranchUrl,
  createBranchWithEndpoint,
  findBranchByName,
  getNeonConfig,
  getTemplateBranchId,
  resolveBranchUrl,
} from './neon-branches';

// Memoize the safety check across the process. The check parses
// DATABASE_URL and compares against DEV_DB_HOST_ALLOWLIST; running
// it once per fork is plenty.
let safetyChecked = false;
function ensureCloneHostSafe(): void {
  if (safetyChecked) return;
  assertSafeDatabaseHost('clone-template');
  safetyChecked = true;
}

function originalDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('clone-template: DATABASE_URL must be set.');
  }
  return url;
}

function adminUrl(): string {
  const u = new URL(originalDatabaseUrl());
  u.pathname = '/postgres';
  return u.toString();
}

/** Legacy-mode worker URL (DB-name-only swap on shared host). */
export function workerDbUrl(dbName: string): string {
  const u = new URL(originalDatabaseUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Compute the per-fork DB/branch name. Deterministic per pool when
 * LV_TEST_RUN_ID is set by globalSetup (Task #722); falls back to a
 * random suffix for standalone paths that bypass globalSetup.
 */
export function workerDbName(): string {
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  const runId = process.env.LV_TEST_RUN_ID;
  if (runId && /^[0-9a-f]+$/.test(runId)) {
    return `test_worker_${runId}_pool_${poolId}`;
  }
  const rand = randomBytes(4).toString('hex');
  return `test_worker_${poolId}_${process.pid}_${rand}`;
}

// Reserved env keys that survive vitest's per-file module-registry reset
// (which `isolate: true` performs) but are still scoped to this fork
// process under `pool: 'forks'`. See Task #719.
export const ENV_DB_NAME = '__LV_WORKER_DB_NAME__';
export const ENV_DB_URL = '__LV_WORKER_DB_URL__';
export const ENV_BRANCH_ID = '__LV_WORKER_BRANCH_ID__';

/** Per-pool stash keys set by globalSetup's parallel preclone in
 * Neon-branches mode. Per-fork hot path reads its pool's slot rather
 * than re-calling the API. The stash is inherited from the main
 * process via `process.env` at fork spawn time. */
function envBranchUrlKey(poolId: number | string): string {
  return `__LV_WORKER_DB_URL_pool_${poolId}__`;
}
function envBranchIdKey(poolId: number | string): string {
  return `__LV_WORKER_BRANCH_ID_pool_${poolId}__`;
}

async function databaseExists(client: pg.PoolClient, dbName: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
    [dbName],
  );
  return rows[0]?.exists ?? false;
}

export function workerDbNameForPool(poolId: number | string): string {
  const runId = process.env.LV_TEST_RUN_ID;
  if (!runId || !/^[0-9a-f]+$/.test(runId)) {
    throw new Error(
      'workerDbNameForPool: LV_TEST_RUN_ID must be set by globalSetup',
    );
  }
  return `test_worker_${runId}_pool_${poolId}`;
}

export interface CloneResult {
  /** Connection URL the caller should use as DATABASE_URL. */
  url: string;
  /** Present only in Neon-branches mode. */
  branchId?: string;
}

// ============================================================
// Neon-branches mode
// ============================================================

async function cloneViaBranch(targetName: string): Promise<CloneResult> {
  const cfg = getNeonConfig();
  if (!cfg) throw new Error('cloneViaBranch called without Neon config');
  const t0 = Date.now();
  const templateBranchId = await getTemplateBranchId(cfg);
  // Idempotency: if a branch by this name already exists (e.g. from
  // a previous interrupted run that crashed before cleanup, or from
  // the same run's globalSetup preclone), reuse it. Branch names are
  // unique within a project so this is unambiguous.
  const existing = await findBranchByName(cfg, targetName);
  if (existing) {
    const url = await resolveBranchUrl(cfg, existing.id);
    console.log(
      `[lv-perf] cloneTemplate mode=neon-branches name=${targetName}` +
        ` existed=true branchId=${existing.id} total=${Date.now() - t0}ms`,
    );
    return { url, branchId: existing.id };
  }
  const created = await createBranchWithEndpoint(cfg, templateBranchId, targetName);
  console.log(
    `[lv-perf] cloneTemplate mode=neon-branches name=${targetName}` +
      ` existed=false branchId=${created.branchId} total=${Date.now() - t0}ms`,
  );
  return { url: created.url, branchId: created.branchId };
}

// ============================================================
// Legacy CREATE DATABASE TEMPLATE mode
// ============================================================

/**
 * Inner clone routine that operates on a caller-supplied admin client
 * with the advisory lock already held. Extracted from `cloneTemplate`
 * so it can be reused by both per-fork (`cloneTemplate`) and serial
 * preclone (`precloneAllWorkerDbs`) callers without duplicating the
 * existence-probe + retry-loop logic. Each caller is responsible for
 * the connect/lock/release ceremony around this function — an earlier
 * "shared client across all N iterations" experiment regressed
 * preclone wall-clock 43s → 180s and was reverted (see Task #722
 * follow-up notes).
 */
async function cloneTemplateOnClient(
  client: pg.PoolClient,
  targetDb: string,
  perfPrefix: { tStart: number; tConnect: number; tLock: number },
): Promise<void> {
  let tProbe = 0;
  let existed = false;
  let attempts = 0;
  try {
    if (await databaseExists(client, targetDb)) {
      existed = true;
      tProbe = Date.now();
      return;
    }
    tProbe = Date.now();
    // Bumped from 12 → 24 after a Neon flake on pool_3 exhausted the
    // smaller budget at ~100s with code 55006 ("source database is
    // being accessed by other users"). Each retry's CREATE costs ~5s,
    // so 24 attempts is a ~2-minute safety net for Neon control-plane
    // hiccups; on the happy path attempts=1 and this loop is a no-op.
    const maxAttempts = 24;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        if (attempt > 1) {
          try {
            await client.query(
              `SELECT pg_terminate_backend(pid)
                 FROM pg_stat_activity
                WHERE datname = $1
                  AND pid <> pg_backend_pid()`,
              [TEMPLATE_DB_NAME],
            );
          } catch {
            /* role lacks privilege; rely on backoff */
          }
        }
        await client.query(
          `CREATE DATABASE "${targetDb}" TEMPLATE "${TEMPLATE_DB_NAME}"`,
        );
        return;
      } catch (err) {
        lastErr = err;
        await sleep(500 * Math.min(attempt, 12));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    const tEnd = Date.now();
    console.log(
      `[lv-perf] cloneTemplate mode=legacy pool=${process.env.VITEST_POOL_ID ?? 'gs'}` +
        ` pid=${process.pid} db=${targetDb}` +
        ` existed=${existed} attempts=${attempts}` +
        ` connect=${perfPrefix.tConnect - perfPrefix.tStart}ms` +
        ` lock=${perfPrefix.tLock ? perfPrefix.tLock - perfPrefix.tConnect : 0}ms` +
        ` probe=${tProbe ? tProbe - (perfPrefix.tLock || perfPrefix.tConnect) : 0}ms` +
        ` create=${existed || !tProbe ? 0 : tEnd - tProbe}ms` +
        ` total=${tEnd - perfPrefix.tStart}ms`,
    );
  }
}

async function cloneViaCreateDatabase(targetDb: string): Promise<CloneResult> {
  const tStart = Date.now();
  const adminPool = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  const client = await adminPool.connect();
  const tConnect = Date.now();
  let tLock = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [CLONE_ADVISORY_LOCK_KEY]);
    tLock = Date.now();
    try {
      await cloneTemplateOnClient(client, targetDb, { tStart, tConnect, tLock });
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [CLONE_ADVISORY_LOCK_KEY]);
      } catch { /* noop */ }
    }
  } finally {
    client.release();
    await adminPool.end();
  }
  return { url: workerDbUrl(targetDb) };
}

// ============================================================
// Public dispatch
// ============================================================

export async function cloneTemplate(targetName: string): Promise<CloneResult> {
  ensureCloneHostSafe();
  const result = getNeonConfig()
    ? await cloneViaBranch(targetName)
    : await cloneViaCreateDatabase(targetName);
  // Physical cloning must preserve the exact active journal. Never apply a
  // missing migration here: an invalid clone must fail before its URL is
  // stashed or an application process can bind to it.
  await assertCheckedMigrationsCurrent(result.url);
  console.log('[test-worker-provenance] source=migrated-template journal=exact');
  return result;
}

// Module-level memo of the cold-path DB clone. Wiped by vitest's
// per-file module-registry reset under `isolate: true`; the env-stash
// fast path in `cloneTemplateForWorker` survives that reset.
let dbPromise: Promise<{ dbName: string; url: string }> | null = null;

async function initDbOnce(): Promise<{ dbName: string; url: string }> {
  const dbName = workerDbName();
  const result = await cloneTemplate(dbName);
  process.env.DATABASE_URL = result.url;
  process.env.TEST_DATABASE_URL = result.url;
  process.env[ENV_DB_NAME] = dbName;
  process.env[ENV_DB_URL] = result.url;
  if (result.branchId) process.env[ENV_BRANCH_ID] = result.branchId;
  if (process.env.LV_DEBUG_PERWORKER === '1') {
    const cold = Number(process.env.__LV_DB_COLD_HITS__ ?? '0') + 1;
    process.env.__LV_DB_COLD_HITS__ = String(cold);
    console.log(`[perworker] db COLD pid=${process.pid} pool=${process.env.VITEST_POOL_ID} db=${dbName} cold=${cold}`);
  }
  return { dbName, url: result.url };
}

/**
 * Per-fork hot path. Returns the worker DB info, hitting one of three
 * fast paths in order before falling back to a cold clone:
 *
 *   1. Per-fork env-stash (`__LV_WORKER_DB_URL__`) — the same fork
 *      already provisioned its DB on a previous file load. This
 *      survives `isolate:true`'s module-registry reset because
 *      `process.env` is owned by the OS process, not the loader.
 *
 *   2. Per-pool stash (`__LV_WORKER_DB_URL_pool_<id>__`) — globalSetup
 *      pre-cloned this fork's DB; the env was inherited at spawn.
 *      Promotes the per-pool slot into the per-fork stash so future
 *      file loads in this fork hit path #1.
 *
 *   3. Cold clone via `cloneTemplate()` — DB was not pre-cloned (e.g.
 *      `SKIP_TEST_SEED=1`, standalone vitest invocation, or the test
 *      script is being driven outside `npm test`).
 */
export function cloneTemplateForWorker(): Promise<{ dbName: string; url: string }> {
  // Fast path #1: per-fork env-stash (survives isolate:true reset).
  const stashedUrl = process.env[ENV_DB_URL];
  const stashedName = process.env[ENV_DB_NAME];
  if (
    stashedUrl &&
    stashedName &&
    process.env.TEST_DATABASE_URL === stashedUrl
  ) {
    process.env.DATABASE_URL = stashedUrl;
    if (process.env.LV_DEBUG_PERWORKER === '1') {
      const hot = Number(process.env.__LV_DB_HOT_HITS__ ?? '0') + 1;
      process.env.__LV_DB_HOT_HITS__ = String(hot);
      console.log(`[perworker] db HOT  pid=${process.pid} pool=${process.env.VITEST_POOL_ID} db=${stashedName} hot=${hot}`);
    }
    return Promise.resolve({ dbName: stashedName, url: stashedUrl });
  }

  // Fast path #2: per-pool stash from globalSetup's preclone (Neon-
  // branches mode pre-stashes the URL since it isn't deterministic
  // from the branch name; legacy mode also pre-stashes since #722).
  const poolId = process.env.VITEST_POOL_ID;
  if (poolId) {
    const poolUrl = process.env[envBranchUrlKey(poolId)];
    if (poolUrl) {
      const dbName = workerDbName();
      const branchId = process.env[envBranchIdKey(poolId)];
      process.env.DATABASE_URL = poolUrl;
      process.env.TEST_DATABASE_URL = poolUrl;
      process.env[ENV_DB_NAME] = dbName;
      process.env[ENV_DB_URL] = poolUrl;
      if (branchId) process.env[ENV_BRANCH_ID] = branchId;
      if (process.env.LV_DEBUG_PERWORKER === '1') {
        const warm = Number(process.env.__LV_DB_WARM_HITS__ ?? '0') + 1;
        process.env.__LV_DB_WARM_HITS__ = String(warm);
        console.log(`[perworker] db WARM pid=${process.pid} pool=${poolId} db=${dbName} warm=${warm}`);
      }
      return Promise.resolve({ dbName, url: poolUrl });
    }
  }

  // Fast path #3: cold clone.
  if (dbPromise === null) {
    dbPromise = initDbOnce();
  }
  return dbPromise;
}

export async function precloneAllWorkerDbs(maxPoolId: number): Promise<void> {
  const tStart = Date.now();
  const cfg = getNeonConfig();

  if (cfg) {
    // Neon-branches mode: parallel preclone via API. Branches don't
    // share the source-DB lock that CREATE DATABASE TEMPLATE
    // requires, so concurrent creates are safe and ~maxPoolId× faster.
    const results = await Promise.all(
      Array.from({ length: maxPoolId }, async (_, i) => {
        const poolId = i + 1;
        const name = workerDbNameForPool(poolId);
        const r = await cloneTemplate(name);
        return { poolId, ...r };
      }),
    );
    for (const r of results) {
      process.env[envBranchUrlKey(r.poolId)] = r.url;
      if (r.branchId) process.env[envBranchIdKey(r.poolId)] = r.branchId;
    }
    console.log(
      `[lv-perf] preclone-all mode=neon-branches maxPoolId=${maxPoolId} total=${Date.now() - tStart}ms`,
    );
    return;
  }

  // Legacy mode: serial preclone. See #722 follow-up notes — parallel
  // CREATE DATABASE TEMPLATE on managed Postgres regressed 43s → 180s.
  for (let poolId = 1; poolId <= maxPoolId; poolId++) {
    if (poolId > 1) {
      // Brief pause to let Neon's control plane release the source
      // template before the next CREATE DATABASE … TEMPLATE …
      // attempt. Without this, pool_N+1 occasionally trips
      // 55006 "source database … is being accessed by other users"
      // because CREATE DATABASE itself opens a transient session
      // against the template that Neon takes a beat to tear down.
      await sleep(1500);
    }
    const name = workerDbNameForPool(poolId);
    const r = await cloneTemplate(name);
    process.env[envBranchUrlKey(poolId)] = r.url;
  }
  console.log(
    `[lv-perf] preclone-all mode=legacy maxPoolId=${maxPoolId} total=${Date.now() - tStart}ms`,
  );
}

// Re-export for convenience so callers can construct a branch URL
// without importing from ./neon-branches directly.
export { buildBranchUrl };
