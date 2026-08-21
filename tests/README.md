# Test Suite

Vitest-based API/integration and unit tests live here.

## Running the tests

```bash
npm run test:local    # complete local wrapper: active migrations + isolated DBs
npm run test          # one-shot run
npm run test:watch    # watch mode
npm run test:race     # opt-in race suite (see "Opt-in suites" below)
```

The recommended `test:local` wrapper provisions PostgreSQL and builds the
canonical test template from an empty local database by applying the complete
active history with `db:migrate`. It verifies the exact journal, requires a
second migration run to be a no-op, installs the startup invariants and test
seed, then uses isolated per-worker application instances. Every physical
worker clone rechecks the journal and emits migration provenance. Remote Neon
template construction and any schema-push fallback are disabled. A separate
dev server is only needed for raw `npm test` workflows that use the shared HTTP
base URL. Start it in another shell first when using that path:

```bash
npm run dev
```

The wrapper runs Vitest in a directly managed child process, prints a
30-second heartbeat, and writes the complete child output to
`.local/test-local.log` while keeping terminal output small. On Windows,
interrupting the command also terminates the Vitest child process tree so
worker and test-app processes do not remain behind.

## Automatic seeding

`vitest.config.ts` registers `tests/setup/global-setup.ts` as a global
setup hook. Before any test file runs, it ensures the following accounts
and organizations exist in the database:

| Account               | Default email              | Default password         | Role          |
|-----------------------|----------------------------|--------------------------|---------------|
| System admin          | `admin@example.com`        | `admin-local-dev`        | `system_admin`|
| Org A admin           | `testadmin@example.com`    | `org-local-dev`          | `org_admin`   |
| Org B admin           | `testadmin2@example.com`   | `org-local-dev`          | `org_admin`   |

Two organizations are also ensured: `vitest-org-a` and `vitest-org-b`
(created if missing, reused if already present). Existing users with the
same email are updated in place — their password is rehashed and their
role and organization are reset to the values above.

The hook is idempotent, so re-running the suite does not pollute the
database with duplicate rows. As an additional safety measure the
seeder refuses to run when `NODE_ENV=production` or `REPLIT_DEPLOYMENT`
is set, unless `ALLOW_TEST_SEED=1` is also set.

### Base URL behavior

`tests/helpers.ts` picks a sensible default for the API base URL:

- On Replit (when `REPLIT_DEV_DOMAIN` or `REPLIT_DOMAINS` is set) it
  uses the `https://<replit-domain>` of the running dev server. This is
  required because session cookies are flagged `Secure` and would be
  dropped over plain `http://localhost`.
- Otherwise it falls back to `http://localhost:5000`.

Set `TEST_BASE_URL` explicitly to override either default.

### Auth rate limiter in dev

`server/routes/auth.ts` skips the login/register rate limiters whenever
`isDev` is true, so repeated test runs do not trip the per-IP cap.
Production traffic is still rate limited.

If you need to seed manually (for example to log in as one of the test
users in your browser), run:

```bash
tsx tests/setup/seed-test-users.ts
# or via the existing wrapper:
npm run seed
```

To skip the automatic seed (e.g. on a CI pipeline that seeds out of
band), set `SKIP_TEST_SEED=1` before invoking `npm run test`.

## Configurable env vars

The seeder and `tests/helpers.ts` honor the same env vars so you can
override credentials without editing source:

| Env var                          | Default                       |
|----------------------------------|-------------------------------|
| `TEST_BASE_URL`                  | `https://$REPLIT_DEV_DOMAIN` when running on Replit, otherwise `http://localhost:5000` |
| `TEST_ADMIN_EMAIL`               | `admin@example.com`           |
| `TEST_ADMIN_PASSWORD`            | `admin-local-dev`             |
| `TEST_ORG_A_EMAIL`               | `testadmin@example.com`       |
| `TEST_ORG_B_EMAIL`               | `testadmin2@example.com`      |
| `TEST_ORG_PASSWORD`              | `org-local-dev`               |
| `TEST_NEW_ORG_ADMIN_PASSWORD`    | `new-org-admin-local-dev`     |
| `TEST_ORG_A_SLUG`                | `vitest-org-a`                |
| `TEST_ORG_B_SLUG`                | `vitest-org-b`                |
| `SKIP_TEST_SEED`                 | unset (seed runs)             |

### Opt-in suites

Some test files mutate shared state (e.g. delete and re-seed the system
admin row) and would race with other test files under the default
`vitest run`. They are gated behind their own env vars and must be
invoked in a dedicated, serial step.

The convenience wrapper `scripts/test-race.sh` runs the full opt-in
race suite with the right env var pre-set. It's exposed as an npm
script so CI templates that expect npm-script names can drop in
unchanged:

```bash
npm run test:race
# equivalent to:
bash scripts/test-race.sh
```

…both of which are equivalent to:

```bash
RUN_BOOTSTRAP_RACE_TESTS=1 npx vitest run --no-file-parallelism \
  tests/api/setup-admin-bootstrap-race.test.ts \
  tests/api/payment-sync-retry-race.test.ts
```

The wrapper currently runs two race files:

- `tests/api/setup-admin-bootstrap-race.test.ts` (#319, #360) — proves
  the first-admin bootstrap critical section by racing two
  `POST /api/setup/create-first-admin` requests against each other and
  asserting exactly one wins.
- `tests/api/payment-sync-retry-race.test.ts` (#362) — seeds a flagged
  bowler row with `payment_sync_pending_at` set, fires two
  `runPaymentSyncRetrySweep()` calls in parallel against the real
  database, and asserts that the `FOR UPDATE OF bowlers SKIP LOCKED`
  guard (introduced in #321 and centralised in the `lockedSweep`
  helper in #361) lets exactly one sweep claim the row while the
  other reports `skippedByLock >= 1`. This catches a regression where
  the sweep would no longer take the row lock and two ticks could
  double-call the payment provider for the same bowler.

#### CI wiring

CI pipelines should invoke `npm run test:race` (or, equivalently,
`bash scripts/test-race.sh`) as a **separate, serial step that runs
AFTER the main `npm test` job has finished** — never in parallel with
it on the same database. The race suite deletes
and re-seeds the `system_admin` row, so concurrent workers (whether
other vitest files or another instance of CI sharing the same DB) will
fight over that row and produce flaky failures.

This project's GitHub Actions setup realises that contract across two
workflow files (see [`docs/ci.md`](../docs/ci.md) for the full layout):

| Workflow file | Job | What it runs |
|---|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | `Tests` | `npm test` against an ephemeral `postgres:17` + backgrounded dev server |
| [`.github/workflows/race-suite.yml`](../.github/workflows/race-suite.yml) | `Race suite` | `npm run test:race` against its own ephemeral `postgres:17` + backgrounded dev server, gated on touched files |

The race suite lives in its own workflow (rather than as a serial step
appended to the `Tests` job) so it can run in parallel with `npm test`
*safely* — each workflow points `DATABASE_URL` at a distinct ephemeral
Postgres database (`leaguevault_test` vs `leaguevault_race`), so the
two never share the `system_admin` row that the "never in parallel"
rule above is protecting. Within the race-suite workflow itself,
`scripts/test-race.sh` still runs the two race files serially via
`vitest --no-file-parallelism` (see the comment block in the script).

If you wire this project into a different CI provider (or fold both
suites into a single job on a single database), you must put
`npm run test:race` (or `bash scripts/test-race.sh`) *after* `npm test`
as a serial step and ensure `RUN_BOOTSTRAP_RACE_TESTS=1` is not exported
during the `npm test` step. The minimal job ordering looks like:

```yaml
- run: npm test           # main suite
- run: npm run test:race  # opt-in race suite, serial
```

| Env var                          | File(s)                                              | Wrapper                                            |
|----------------------------------|------------------------------------------------------|----------------------------------------------------|
| `RUN_BOOTSTRAP_RACE_TESTS=1`     | `tests/api/setup-admin-bootstrap-race.test.ts`, `tests/api/payment-sync-retry-race.test.ts` | `npm run test:race` (alias for `bash scripts/test-race.sh`) |

**Required CI secrets for the race suite (task #360):**

| Secret           | Why it's required                                                                                                                                                                                                       |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `SETUP_SECRET`   | The `/api/setup/*` endpoints check this header on every request. Without it, every POST in the race suite returns `401` and no race coverage runs. Both `scripts/test-race.sh` AND the test file hard-fail when it's missing — a CI job that forgets to wire it through will exit non-zero with a clear remediation message instead of silently reporting `6 skipped`. |

**Required CI secrets for the default `npm test` run (task #431):**

| Secret           | Why it's required                                                                                                                                                                                                       |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `SETUP_SECRET`   | `tests/api/setup-admin-header.test.ts` runs in the default `npm test` job and exercises both the `checkSetupSecret` header-normalisation matrix and the per-endpoint secret-gate coverage. Without `SETUP_SECRET` exported, the suite hard-fails with a remediation pointer rather than silently skipping — a CI job that forgets to wire it through will exit non-zero instead of reporting a misleading green build. |

## Database schema inventory validation

Run `npm run db:check` for the authoritative normalized migration gate. It
uses an owned disposable PostgreSQL 17 container to replay the active
baseline, verify exact LF SQL bytes and the checked-in format-version-2
fingerprint (including 26 owned sequences), exercise guarded local adoption,
concurrent/atomic registration and every refusal class, and prove later
ordering with the isolated `tests/fixtures/migrations/ordering-proof.sql`
fixture. The fixture is combined
with active migrations only under ignored run artifacts; it is not deployable
SQL and creates no production object.

The migration validation also proves that empty databases execute the baseline,
matching existing databases register only the baseline journal record, adopted
databases skip baseline application DDL, exact adopted journals are no-ops,
conflicting journals are refused, and all migration/adoption reruns are safe.
Production-mode fixtures use only disposable local databases and mocked Neon
GET responses. They prove the dedicated preflight leaves both application
structure and the empty journal unchanged, refuses nonempty journals, and that
the separately gated execution path inserts exactly one baseline row. No test
connects to or mutates a live Neon target.

### Legacy history reproduction

Run `npm run db:inventory:validate-local` to build and compare the current
declared schema and the journal-tracked SQL chain under
`migrations-legacy-do-not-replay/` in a separate ephemeral
PostgreSQL 17 container. The expected result is a categorized mismatch: 29
tables from `db:push`, 17 from journal replay, and 12 tables missing from the
journal result. Generated JSON lives under ignored
`.artifacts/db-inventory/<run-id>/`, so concurrent invocations do not share
output paths.

This command is intentionally separate from `npm run test:local`; it owns its
own temporary container and does not use the test template or worker databases.
Its `db:push:disposable` half verifies the full container ID, per-run labels,
approved database name, exact `127.0.0.1` port, role, and database comment
marker immediately before passing the same URL to Drizzle. Remote hosts and
generic development bypasses are refused.

The pure comparison, redaction, legacy-journal preflight, definition normalization,
container ownership, and cleanup behavior is covered by
`tests/unit/db-schema-inventory-tools.test.ts` in the default Vitest run.

## Layout

- `tests/api/*.test.ts` — black-box API/integration tests that go over
  HTTP against the running dev server.
- `tests/unit/*.test.ts` — pure Node unit tests (no server required).
- `tests/helpers.ts` — shared `login` / `apiGet` / `apiPost` helpers.
- `tests/setup/` — globalSetup hook and the idempotent seeder it calls.
- `server/**/__tests__/*.test.ts` — co-located server unit tests.

## Cleanup contract for new tests (#608, #615, #630)

Tests share a single dev database. Every row a test inserts must be
deleted by the time the suite ends, OR the test must explain in a
per-call-site comment why a leak is acceptable. The pattern below is
enforced across `tests/api/`, `tests/unit/`, `tests/e2e/`, and the
shared helpers in `tests/helpers.ts` / `tests/helpers/`:

1. **No silent swallows in cleanup.** A bare `try { await
   db.delete(...) } catch { /* best effort */ }` in `afterAll` /
   `afterEach` (or in a helper called from one) is forbidden. The
   reference loud-failure pattern lives in
   `tests/api/orphaned-data-audits.test.ts` — collect each delete
   failure into an array, log it with table+id context, attempt every
   remaining delete, and throw a summary error at the end so the
   suite fails on the next run instead of leaking rows forever.

2. **Helpers re-throw.** `releaseFixtureOrg` in `tests/helpers.ts`
   has no `catch` — any FK or trigger failure surfaces directly to
   the calling test's `afterAll`. Don't wrap it.

3. **Per-call-site justification when a swallow is unavoidable.**
   The only sanctioned exception today is
   `validateLeagueFk` in `tests/helpers/orphan-staging.ts`, which
   re-validates a temporarily-relaxed FK constraint (no row delete
   involved) and documents inline why a swallow is safe.

4. **Tripwire.** `tests/setup/global-setup.ts` runs an
   orphan-audit leak check on teardown (#629) and fails the workflow
   if rows from any prior `afterAll` survived. New tests that touch
   audit / orphan tables should add their own targeted tripwire if
   the existing one doesn't cover them.
