/**
 * Per-worker setup file (Task #700 / Phase 2 of #697).
 *
 * Vitest invokes setupFiles once per *test file*, but we only need to
 * provision the worker DB + spawn the test app once per *worker
 * process*. We memoize the heavy work via a module-level promise that
 * survives across files within the same worker (vitest's "forks" pool
 * gives each worker its own process, and modules are cached by
 * identity within a single Node process).
 *
 * Steps performed once per worker:
 *   1. Read `VITEST_POOL_ID` (provided by vitest workers; non-empty
 *      string like "1", "2", …). Falls back to a random suffix if
 *      missing so the script is still safe to invoke standalone.
 *   2. Build the per-worker DB name `test_worker_<pid>_<id>` and clone
 *      the `leaguevault_test_template` template into it.
 *   3. Set `process.env.DATABASE_URL` AND `process.env.TEST_DATABASE_URL`
 *      to the new DB's connection string. Setting both is critical:
 *      `server/db.ts`'s singleton reads `DATABASE_URL` on first import,
 *      and `tests/setup/test-db.ts` reads `TEST_DATABASE_URL`.
 *   4. Spawn the per-worker test Express via `server/test-entry.ts`
 *      and capture its loopback port.
 *   5. Set `process.env.TEST_BASE_URL=http://127.0.0.1:<port>` so
 *      `tests/helpers.ts` issues HTTP requests at the spawned app.
 *   6. Register a `process.on('exit')` hook that synchronously kills
 *      the spawned child. Async DB drop is handled by globalSetup
 *      teardown via `cleanupTestDbs()`.
 *
 * IMPORTANT: this file MUST NOT import anything from `server/db.ts`
 * (directly or transitively) above the `setEnv()` call, or the
 * singleton pool would bind to the dev DB instead of the worker DB.
 */
// Side-effect import: installs the in-process [ERROR] log guard
// (Task #746). This module has no `server/db` dependency, so it respects the
// "no db import above setEnv" rule documented in this file's header.
import './error-log-guard';
import { spawnTestApp, type SpawnedTestApp } from './spawn-test-app';
import { CLONE_ADVISORY_LOCK_KEY } from './per-worker-lock';
import {
  cloneTemplateForWorker,
  ENV_DB_NAME,
  ENV_DB_URL,
} from './clone-template';

export { CLONE_ADVISORY_LOCK_KEY, cloneTemplateForWorker };

// `cloneTemplate`, `workerDbName`, `workerDbNameForPool`,
// `cloneTemplateForWorker`, `precloneAllWorkerDbs` and the
// ENV_DB_NAME/ENV_DB_URL stash keys all live in `./clone-template.ts`
// (side-effect-free). That module is imported directly from
// `per-worker-db-only.ts` and `tests/setup/global-setup.ts` so neither
// of those code paths drag in the top-level `await ensurePerWorkerApp()`
// at the bottom of this file (which would spawn an Express in DB-only
// or globalSetup contexts).

// App-port stash key is owned by this module since only the
// app-spawning hot path needs it.
const ENV_APP_PORT = '__LV_WORKER_APP_PORT__';

let appPromise: Promise<{ app: SpawnedTestApp; dbName: string }> | null = null;

async function initAppOnce(): Promise<{ app: SpawnedTestApp; dbName: string }> {
  const tStart = Date.now();
  const { dbName, url } = await cloneTemplateForWorker();
  const tDb = Date.now();
  const app = await spawnTestApp({ databaseUrl: url });
  const tApp = Date.now();
  process.env.TEST_BASE_URL = `http://127.0.0.1:${app.port}`;
  process.env[ENV_APP_PORT] = String(app.port);
  console.log(
    `[lv-perf] initAppOnce pool=${process.env.VITEST_POOL_ID ?? '?'}` +
      ` pid=${process.pid} db=${dbName} port=${app.port}` +
      ` cloneOrHot=${tDb - tStart}ms spawn=${tApp - tDb}ms total=${tApp - tStart}ms`,
  );
  if (process.env.LV_DEBUG_PERWORKER === '1') {
    const cold = Number(process.env.__LV_APP_COLD_HITS__ ?? '0') + 1;
    process.env.__LV_APP_COLD_HITS__ = String(cold);
    console.log(`[perworker] app COLD pid=${process.pid} pool=${process.env.VITEST_POOL_ID} appPort=${app.port} cold=${cold}`);
  }

  // Hard backstop: kill the child when the worker exits, even on
  // uncaught exceptions / signal-driven termination. Sync-only API.
  // Only registered on the cold path so we don't pile up N copies per
  // fork as files reload.
  const killer = (): void => {
    try { app.kill(); } catch { /* noop */ }
  };
  process.once('exit', killer);
  process.once('SIGINT', () => { killer(); process.exit(130); });
  process.once('SIGTERM', () => { killer(); process.exit(143); });

  // Per-fork summary at exit so we can sum the across-fork setup cost
  // (the cross-fork "643s setup bucket" is the sum of these values).
  // Cold-path-only registration: fast-path forks never reach this code,
  // so a fork's first cold-init is the only one that owns the summary.
  const tWorkerStart = Date.now();
  process.once('exit', () => {
    const wallMs = Date.now() - tWorkerStart;
    const provisionMs = tApp - tStart;
    console.log(
      `[lv-perf] worker-summary pool=${process.env.VITEST_POOL_ID ?? '?'}` +
        ` pid=${process.pid} provisionMs=${provisionMs} wallMs=${wallMs}`,
    );
  });

  return { app, dbName };
}

export function ensurePerWorkerApp(): Promise<{ app: SpawnedTestApp; dbName: string }> {
  // Fast path: this fork already spawned an app on a previous file
  // load. We return a stub whose `kill` is a no-op — the real killer
  // was registered via `process.once('exit', ...)` on the cold path
  // and survives module-registry resets (it's owned by the OS
  // process, not the module loader).
  const stashedPort = process.env[ENV_APP_PORT];
  const stashedDbName = process.env[ENV_DB_NAME];
  const stashedUrl = process.env[ENV_DB_URL];
  const expectedBaseUrl = stashedPort ? `http://127.0.0.1:${stashedPort}` : '';
  if (
    stashedPort &&
    stashedDbName &&
    stashedUrl &&
    process.env.TEST_DATABASE_URL === stashedUrl &&
    process.env.TEST_BASE_URL === expectedBaseUrl
  ) {
    const port = Number(stashedPort);
    const stub: SpawnedTestApp = {
      pid: -1,
      port,
      kill: () => { /* noop — real killer registered on cold path */ },
    };
    process.env.DATABASE_URL = stashedUrl;
    if (process.env.LV_DEBUG_PERWORKER === '1') {
      const hot = Number(process.env.__LV_APP_HOT_HITS__ ?? '0') + 1;
      process.env.__LV_APP_HOT_HITS__ = String(hot);
      console.log(`[perworker] app HOT  pid=${process.pid} pool=${process.env.VITEST_POOL_ID} appPort=${stashedPort} hot=${hot}`);
    }
    return Promise.resolve({ app: stub, dbName: stashedDbName });
  }
  if (appPromise === null) {
    appPromise = initAppOnce();
  }
  return appPromise;
}

// Top-level await: vitest blocks the test file load until this resolves.
await ensurePerWorkerApp();
