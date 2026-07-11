import { defineConfig } from 'vitest/config';

/**
 * Test files that perform FK-bypass DDL on shared tables — i.e. they
 * call into `tests/helpers/orphan-staging.ts` to briefly DROP/ADD the
 * `<table>_league_id_leagues_id_fk` constraint (or DISABLE/ENABLE the
 * `users_role_org_required` trigger) so they can stage "legacy"
 * parent-missing rows that the live schema would otherwise reject.
 *
 * The DDL window itself is transaction-scoped (~tens of ms of
 * ACCESS EXCLUSIVE per insert) and the constraint is re-added as
 * `NOT VALID` so existing orphans don't block — but two orphan suites
 * running in parallel can still trip on each other's locks. We keep
 * those (and ONLY those) in a single-fork project. Every other file
 * that merely writes the same tables runs in the parallel project;
 * any rare overlap with an active DDL window manifests as a brief
 * lock wait, not a correctness issue.
 */
const SHARED_TABLE_WRITERS = [
  'tests/api/orphaned-data.test.ts',
];

/**
 * Test files that depend on per-file module isolation because they
 * register `vi.mock(...)` factories whose return value closes over
 * file-scope mock variables (e.g. `const mockFoo = vi.fn(); vi.mock('…',
 * () => ({ foo: (...a) => mockFoo(...a) }))`). Under `isolate: false`
 * the mocked-module instance is cached across files in the same worker
 * and the closures from a previously-loaded file leak into the next
 * file's import graph, producing systematic test failures.
 *
 * Rather than refactor every offender to use `vi.hoisted()`, we keep
 * them in a small `parallel-isolated` project that retains the default
 * `isolate: true`. The bulk of the suite — primarily the slower
 * DB-backed `tests/api/**` files that don't use `vi.mock` — runs in
 * the `parallel` project with `isolate: false` for the perf win.
 *
 * Membership is empirical: every file listed below was observed to
 * fail or hang when included in the `isolate: false` project. See
 * `.local/tasks/isolate-false-audit-notes.md` (task #689) for context.
 */
/**
 * Test files that need a fully isolated worker (its own DB + its own
 * spawned Express) per test file. They make HTTP calls (so they need
 * the spawned app from the full per-worker setup) but break under
 * `isolate: false` because they accumulate in-process state on the
 * spawned server side that bleeds into sibling files in the same
 * worker — e.g. login/account rate-limit counters keyed by IP rather
 * than userId, or in-memory caches that hold rows the next file
 * deletes. We scope them out into their own project so each file gets
 * a fresh DB clone + a fresh spawned Express, at the cost of an extra
 * ~3-5s of provisioning per file.
 *
 * Membership is empirical: every file listed below was observed to
 * fail under `isolate: false` in the parallel project but passes when
 * isolated. See `.local/tasks/per-worker-isolation-notes.md` (#700).
 */
const PARALLEL_ISOLATED_WITH_APP = [
  'tests/api/change-password.test.ts',
  'tests/unit/account-deletion.test.ts',
  'tests/e2e/integrations-deep-link.test.ts',
];

/**
 * Pure in-process unit tests that need NO real database or spawned app.
 * Some `vi.mock('pg')` (and `fetch`) to verify the Neon test-infra
 * helpers (`tests/setup/neon-branches.ts` reveal-password probing and the
 * connection-aware cleanup sweep) by mocking the `pg` driver outright.
 *
 * They CANNOT run in the `parallel` / `parallel-isolated*` projects:
 * those projects' setup files import `tests/setup/clone-template.ts`,
 * which imports the real `pg` (and `./neon-branches`) at module-eval time
 * — i.e. BEFORE the test file's `vi.mock('pg')` factory can intercept it.
 * The real driver then makes live connections to the tests' fake Neon
 * hosts (which resolve via Neon's wildcard DNS) and fails with a real
 * `28P01`. Moving them to `isolate: true` did not help (the setup file
 * still pre-imports `pg` within the file's fresh registry first).
 *
 * The fix is a dedicated project whose only setup file is the pg-free
 * error-log guard, so nothing preloads `pg` ahead of the mock.
 */
const UNIT_NO_DB = [
  'tests/unit/neon-branches-reveal-password.test.ts',
  'tests/unit/cleanup-connection-aware-sweep.test.ts',
  'tests/unit/zod-v4-migration-contracts.test.ts',
];

const PARALLEL_ISOLATED = [
  'server/routes/__tests__/leagues-square-missing-alerts.test.ts',
  'server/services/__tests__/apple-pay-worker.test.ts',
  'server/services/__tests__/square.test.ts',
  'server/services/__tests__/square-version-header.test.ts',
  'server/services/__tests__/square-version-runtime-guard.test.ts',
  'server/services/__tests__/third-party-pins.test.ts',
  'server/services/__tests__/third-party-pin-verifier.test.ts',
  // 'tests/api/admin-unclaimed-users.test.ts' — moved to parallel
  // project (#700): it needs HTTP against the spawned per-worker app
  // and does not actually use vi.mock factory closures, so it is safe
  // to share its worker DB with sibling files in `parallel`.
  'tests/api/create-square-customers-cross-org.test.ts',
  'tests/api/payment-sync-retry-race.test.ts',
  'tests/api/payment-sync-state-transitions.test.ts',
  'tests/unit/admin-reset-password-notification.test.ts',
  'tests/unit/admin-role-change-audit.test.ts',
  'tests/unit/app-domain-mixed-case-pins.test.ts',
  'tests/unit/app-domain-runtime.test.ts',
  'tests/unit/auth-no-token-leak.test.ts',
  'tests/unit/auth-register-phone-sync.test.ts',
  'tests/unit/auth-security-boundaries.test.ts',
  'tests/unit/auth-user-payment-sync-status.test.ts',
  'tests/unit/bowler-attributes-arrays.test.ts',
  'tests/unit/bowler-payment-authz.test.ts',
  'tests/unit/bowler-phone-sync.test.ts',
  'tests/unit/bowler-sync-flag-on-failure.test.ts',
  'tests/unit/bowlnow-sync-custom-fields.test.ts', // Task #720 hoist insufficient — fetch mock pollution under isolate:false breaks sibling tests (#722). Reverted.
  'tests/unit/bowlnow-sync-retry.test.ts',
  'tests/unit/cards-disable-ownership-mismatch.test.ts',
  'tests/unit/change-password-notification.test.ts',
  'tests/unit/charges-buyer-email-enforcement.test.ts',
  'tests/unit/charges-receipt-persistence.test.ts',
  'tests/unit/clover-charge.test.ts',
  'tests/unit/clover-disable-card-ownership-mismatch.test.ts',
  'tests/unit/clover-refund.test.ts',
  'tests/unit/clover-saved-card.test.ts',
  'tests/unit/clover-webhooks.test.ts',
  'tests/unit/confirm-email-change-no-token-leak.test.ts',
  'tests/unit/csrf-no-token-leak.test.ts', // Task #720 hoist preserved as precaution after sibling regressions (#722). Reverted.
  'tests/unit/customers-route-pnce-422.test.ts',
  // This test mocks email-core exports; without module isolation a sibling's
  // cached email-core instance can bypass its mocked SendGrid configuration.
  'tests/unit/email-auth-fallback-escaping.test.ts',
  'tests/unit/email-block-domains.test.ts',
  'tests/unit/has-access-to-bowler.test.ts', // Task #720 hoist insufficient — vi.mock(server/storage) pollutes shared registry under isolate:false (#722). Reverted.
  'tests/unit/has-access-to-bowlers.test.ts', // Task #720 hoist insufficient — same storage-mock pollution as has-access-to-bowler (#722). Reverted.
  'tests/unit/integrations-bowlnow-fields-roundtrip.test.ts', // Task #720 hoist preserved as precaution after sibling regressions (#722). Reverted.
  'tests/unit/league-mutation-resync.test.ts',
  'tests/unit/list-routes-filter-validation.test.ts',
  'tests/unit/locked-sweep.test.ts', // Task #720 moved to parallel as factory-safe; reverted defensively after sibling regressions (#722).
  'tests/unit/password-changed-i18n.test.ts',
  'tests/unit/payment-customer-sync.test.ts',
  'tests/unit/payment-execution-double-pay.test.ts',
  'tests/unit/payment-execution-error-mapping.test.ts',
  'tests/unit/payment-execution-receipt-warn.test.ts',
  'tests/unit/payment-lifecycle-receipt-persistence.test.ts',
  'tests/unit/payment-provider-error-mapping.test.ts',
  'tests/unit/payment-refunds-receipt-dependency.test.ts',
  'tests/unit/payment-scheduler.test.ts',
  'tests/unit/payment-sync-retry.test.ts',
  'tests/unit/payments-by-org.test.ts', // Task #720 moved this to `parallel` but its vi.mock of server/storage poisons the shared module registry under isolate:false, breaking sibling api tests (#722). Reverted to parallel-isolated.
  'tests/unit/payments-receipt-endpoints.test.ts',
  'tests/unit/payments-reports-routes.test.ts',
  'tests/unit/payments-routes.test.ts',
  'tests/unit/preferred-language.test.ts',
  'tests/unit/retry-payment-sync-routes.test.ts',
  'tests/unit/retry-payment-sync-throttle.test.ts',
  'tests/unit/session-no-token-leak.test.ts',
  'tests/unit/set-password-notification.test.ts',
  'tests/unit/setup-secret-no-token-leak.test.ts',
  'tests/unit/square-error-contract.test.ts',
  'tests/unit/square-provider-not-configured-422.test.ts',
  'tests/unit/square-webhook-stub.test.ts', // Task #720 hoist preserved as precaution after sibling regressions (#722). Reverted.
  'tests/unit/use-bowler-payment-submit.test.ts',
];

const sharedAlias = {
  '@shared': new URL('./shared', import.meta.url).pathname,
  '@server': new URL('./server', import.meta.url).pathname,
  '@': new URL('./client/src', import.meta.url).pathname,
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    globalSetup: ['./tests/setup/global-setup.ts'],
    alias: sharedAlias,
    // Defence against the workflow-log truncation problem (~73s of
    // vitest's tail output was being lost when the per-worker app
    // spammed [INFO] lines past Replit's log buffer cap):
    //   1. `default` keeps the live progress / failure output.
    //   2. Custom `summary-reporter.ts` prints a single
    //      `[lv-test-summary] …` line at the very end of the run.
    //      That line is the last thing written, so it survives any
    //      buffer cap and gives downstream scripts a stable record
    //      of pass/fail/skip counts + wall-clock.
    // The vitest built-in `json` reporter was tried alongside these
    // two but consistently produced 30s spawnTestApp timeouts on 4
    // files in the `parallel` project (empty stdout/stderr), almost
    // certainly because it accumulates per-task buffers in memory
    // and starves the parent's I/O loop during the parallel
    // per-worker-app boot. Dropped — the summary line is sufficient.
    reporters: [
      'default',
      './tests/setup/summary-reporter.ts',
    ],

    projects: [
      {
        test: {
          name: 'serial-fk-bypass',
          globals: true,
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
          alias: sharedAlias,
          include: SHARED_TABLE_WRITERS,
          setupFiles: ['./tests/setup/per-worker-setup.ts'],
          fileParallelism: false,
          // Vitest 4 requires unique sequence.groupOrder when sibling
          // projects use different `maxWorkers`; assign monotonic ranks
          // so the runner can schedule each project's specs separately.
          sequence: { groupOrder: 0 },
          // Run inside a forked process so per-worker env injection (DATABASE_URL,
          // TEST_BASE_URL) is isolated from the main vitest process and other
          // projects. See parallel-isolated comment for the threads vs forks
          // rationale (Task #700).
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'parallel',
          globals: true,
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
          alias: sharedAlias,
          include: ['tests/**/*.test.ts', 'server/**/__tests__/**/*.test.ts'],
          exclude: [
            ...SHARED_TABLE_WRITERS,
            ...PARALLEL_ISOLATED,
            ...PARALLEL_ISOLATED_WITH_APP,
            ...UNIT_NO_DB,
          ],
          setupFiles: ['./tests/setup/per-worker-setup.ts'],
          // Skip per-file module re-evaluation; reuse module contexts across
          // files within the same worker. The files that depended on
          // per-file module isolation are split out into the
          // `parallel-isolated` project below. See
          // `.local/tasks/isolate-false-audit-notes.md` (task #689) for
          // context.
          isolate: false,
          // Pin worker count to the container CPU count (4 on Replit). Default
          // is `os.availableParallelism()` which is dynamic and can over-fork
          // on CI runners with reported-but-unusable cores, amplifying the
          // shared dev-DB contention root-caused in #685/#687. minForks ===
          // maxForks so all workers spawn eagerly and we don't pay the
          // mid-run warm-up cost. See docs in
          // .local/tasks/pool-options-tuning-results.md (task #691).
          pool: 'forks',
          // Vitest 4 deprecated `poolOptions`; per-pool options are now
          // top-level. (#700)
          maxWorkers: 4,
          minWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'parallel-isolated',
          sequence: { groupOrder: 2 },
          globals: true,
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
          alias: sharedAlias,
          include: PARALLEL_ISOLATED,
          setupFiles: ['./tests/setup/per-worker-db-only.ts'],
          // Default `isolate: true` — these files have vi.mock factories
          // whose closures leak across files when the module registry is
          // shared. Keep them isolated until they're refactored to use
          // `vi.hoisted()` or factory-internal state.
          //
          // Task #700: switched off `pool: 'threads'` to `pool: 'forks'`
          // because threads share `process.env` across workers in the
          // same process, which breaks the per-worker `DATABASE_URL` /
          // `TEST_BASE_URL` injection that gives each worker its own
          // isolated DB and Express instance. Module-isolation is still
          // achieved by `isolate: true` above, even though we are now on
          // forks (each fork still owns its own module registry).
          pool: 'forks',
          // Task #719: cap fork count to match the `parallel` project.
          // After the process-env-backed clone memo in
          // `per-worker-setup.ts`, the per-fork DB clone cost is paid
          // exactly once per fork (instead of once per file), so worker
          // count directly determines clone count. Pinning to 4 bounds
          // worst-case provisioning at ~20s and matches the pg
          // connection budget set by Task #691.
          maxWorkers: 4,
          minWorkers: 4,
        },
      },
      {
        test: {
          name: 'parallel-isolated-with-app',
          sequence: { groupOrder: 4 },
          globals: true,
          environment: 'node',
          testTimeout: 60000,
          hookTimeout: 60000,
          alias: sharedAlias,
          include: PARALLEL_ISOLATED_WITH_APP,
          // Full per-worker setup: clones DB AND spawns Express. With
          // `isolate: true` the module registry resets per file, which
          // resets the memoized `dbPromise`/`appPromise` in
          // `per-worker-setup.ts` and provisions a fresh DB + spawned
          // Express per file. Slow but necessary for files that
          // accumulate cross-file in-process state on the spawned
          // server side.
          setupFiles: ['./tests/setup/per-worker-setup.ts'],
          pool: 'forks',
          // Serialize the files in this project: each file provisions a
          // fresh DB clone + spawned Express, and parallel clones of
          // the template race for the "source database is being
          // accessed by other users" Postgres rail despite the advisory
          // lock (each worker holds its own pg session). With only 3
          // files in this project the serial cost is ~15s, well under
          // the budget.
          fileParallelism: false,
        },
      },
      {
        // Client-side React component tests run in jsdom so they
        // can render shadcn / Radix widgets, fire user-event
        // interactions, and assert against the resulting DOM.
        // Kept in a separate project (not just a separate env)
        // so the node-environment suites above don't pay the
        // jsdom setup cost.
        // Vite's React plugin isn't loaded for vitest, so opt in to
        // esbuild's automatic JSX runtime here so .tsx test files
        // don't need to import React explicitly.
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'client-components',
          sequence: { groupOrder: 3 },
          globals: true,
          environment: 'jsdom',
          testTimeout: 60000,
          hookTimeout: 60000,
          alias: sharedAlias,
          include: ['tests/components/**/*.test.tsx'],
          setupFiles: ['./tests/setup/component-test-setup.ts'],
        },
      },
      {
        test: {
          // Pure unit tests that `vi.mock('pg')` and must NOT have the
          // real `pg` preloaded by a DB-provisioning setup file (see the
          // `UNIT_NO_DB` comment above). The only setup file here is the
          // pg-free error-log guard, so the test's module mock wins.
          name: 'unit-no-db',
          sequence: { groupOrder: 5 },
          globals: true,
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
          alias: sharedAlias,
          include: UNIT_NO_DB,
          setupFiles: ['./tests/setup/error-log-guard.ts'],
          pool: 'forks',
        },
      },
    ],
  },
});
