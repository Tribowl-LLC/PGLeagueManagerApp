/**
 * Vitest globalSetup (Task #700 / Phase 2 of #697).
 *
 * Runs once before any worker spawns:
 *   1. `cleanupTestDbs()`   — drops any leftover `test_worker_*`
 *      databases from previous crashed runs.
 *   2. `ensureTestTemplate()` — rebuilds the `leaguevault_test_template`
 *      database if the schema-input hash drifted (or the hash file is
 *      missing). Idempotent fast-path when up-to-date.
 *
 * Per-worker DB clone + Express spawn is performed lazily by
 * `tests/setup/per-worker-setup.ts` (wired as a project setupFile in
 * `vitest.config.ts`) so each worker can build its own isolated DB
 * the first time it loads a test file.
 *
 * Teardown:
 *   - `cleanupTestDbs()` again — drops the per-worker DBs that were
 *     created during this run. (Per-worker child processes are killed
 *     synchronously by their own `process.on('exit')` hook.)
 *   - `closeDbPool()` to end the singleton pool so the event loop can
 *     exit cleanly.
 *
 * Skipped automatically when `SKIP_TEST_SEED=1`.
 */
import { randomBytes } from 'node:crypto';
import { cleanupTestDbs } from '../../scripts/cleanup-test-dbs';
import { ensureTestTemplate } from '../../scripts/ensure-test-template';
import { cleanup as closeDbPool } from '../../server/db';
import { precloneAllWorkerDbs } from './clone-template';

// Maximum VITEST_POOL_ID across every forks-pool project in vitest.config.ts.
// `parallel`, `parallel-isolated` and `parallel-isolated-with-app` all top
// out at 4 forks; `serial-fk-bypass` uses 1 fork (still pool_1). Keep this
// in sync if any project's `maxWorkers` is raised.
const MAX_POOL_ID = 4;

// Vitest invokes `globalSetup` once per DB-backed project (we have four
// projects). Without memoisation the second project's `cleanupTestDbs()`
// would drop the worker databases the FIRST project's workers had just
// finished cloning — the visible symptom is `database "test_worker_…"
// does not exist` errors when the spawned per-worker app boots. We
// guard via process.env so the marker survives across this file's
// re-imports under each project.
const SETUP_DONE_MARKER = '__LV_GLOBAL_SETUP_DONE__';
const RUN_ID_ENV = 'LV_TEST_RUN_ID';

export default async function setup() {
  let didSetupHere = false;
  if (process.env.SKIP_TEST_SEED !== '1' && !process.env[SETUP_DONE_MARKER]) {
    process.env[SETUP_DONE_MARKER] = '1';
    didSetupHere = true;
    // Stable per-run identifier inherited by every spawned vitest fork
    // (including forks recycled by `isolate: true` mid-run). Per-worker
    // setup uses this to build a deterministic per-pool DB name so that
    // a recycled fork in the same pool reuses its sibling's clone
    // instead of cloning a fresh DB every file. See per-worker-setup.ts
    // (Task #722).
    if (!process.env[RUN_ID_ENV]) {
      process.env[RUN_ID_ENV] = randomBytes(4).toString('hex');
    }
    const t0 = Date.now();
    // Cross-run sweep at startup. `connectionAware` (Task #742) makes
    // this probe each `test_worker_*` branch's compute for live client
    // connections rather than guessing from age: a branch with no
    // active compute, or a warm compute with zero connections, is a
    // crashed-run orphan and is reaped immediately — so your own
    // killed-run branches get cleaned within seconds during rapid
    // debug retries instead of lingering for 10 minutes. A branch with
    // live connections is a concurrently-running sibling vitest process
    // (different LV_TEST_RUN_ID, same Neon project) and is always kept.
    // `minAgeMs` is retained only as a fallback for branches whose
    // compute can't be probed. End-of-run cleanup (in
    // `summary-reporter.ts`) passes a RUN_ID prefix and deletes its own
    // still-warm branches unconditionally. Legacy
    // CREATE-DATABASE-TEMPLATE mode ignores both options and uses its
    // existing active-connection skip safeguard.
    await cleanupTestDbs({ minAgeMs: 10 * 60 * 1000, connectionAware: true });
    const t1 = Date.now();
    await ensureTestTemplate();
    const t2 = Date.now();
    // Pre-clone all per-pool worker DBs serially under the same advisory
    // lock cloneTemplate uses, so the per-fork hot path hits the
    // `existed=true` short-circuit instead of N forks racing CREATE
    // DATABASE TEMPLATE concurrently. On managed Postgres (Neon) the
    // race is unrecoverable in practice — even with the in-process
    // advisory lock, sibling forks' admin pools open their own pg
    // sessions and the 55006 "source database is being accessed by
    // other users" error has been observed to exhaust the 12-attempt
    // retry budget (~100s of wasted clone time). Pre-cloning serially
    // converts that into a bounded ~N×CREATE_DATABASE one-time cost
    // here in globalSetup. (Task #722 follow-up.)
    await precloneAllWorkerDbs(MAX_POOL_ID);
    const t3 = Date.now();
    console.log(
      `[lv-perf] global-setup cleanup=${t1 - t0}ms ensureTemplate=${t2 - t1}ms` +
        ` preclone=${t3 - t2}ms total=${t3 - t0}ms`,
    );
  }

  // Suppress the unused-var lint when teardown body doesn't reference it.
  void didSetupHere;

  return async function teardown() {
    // NO branch/DB cleanup here — even with the `didSetupHere` and
    // `LV_TEST_RUN_ID` prefix gates, vitest fires the per-project
    // globalSetup teardown when *that* project finishes its files,
    // not when the whole run ends. With our multi-project config
    // (`parallel`, `parallel-isolated`, `parallel-isolated-with-app`,
    // `serial-fk-bypass`) the first project to finish would yank the
    // shared per-pool branches out from under sibling projects'
    // workers (same RUN_ID prefix), causing mid-run DB-disappearance
    // failures.
    //
    // Cleanup is split into two reliable hooks instead:
    //   1. **End-of-run reporter hook** in
    //      `tests/setup/summary-reporter.ts` `onTestRunEnd` — runs
    //      once in the main vitest process after every project +
    //      every fork has finished, RUN_ID-scoped so concurrent
    //      sibling vitest processes are never touched. This is the
    //      "true run-once-at-process-end" hook the architect review
    //      asked for.
    //   2. **Startup cross-run sweep** (`cleanupTestDbs({ minAgeMs })`
    //      at the top of this function) — sweeps `test_worker_*`
    //      branches older than 10 min while leaving an active
    //      sibling run's freshly-created branches alone.
    //
    // A per-fork `process.on('beforeExit')` hook was tried and
    // reverted: vitest projects with `isolate: true` recycle fork
    // processes between files, so the hook fires after every file
    // and deletes the branch the next file's fresh fork is about
    // to use.
    try {
      await closeDbPool();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
}
