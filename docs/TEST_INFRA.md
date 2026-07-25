# Test Infrastructure

Detailed architecture notes for the Vitest per-worker test-DB / Neon-branch infrastructure. Split out of `AGENTS.md` to keep the project overview lean. See also the verification guidance in `AGENTS.md` for the day-to-day test recipe.

## Schema inventory validation

`npm run db:check` is the authoritative migration-infrastructure gate. By
default it owns separate ephemeral `postgres:16` and `postgres:17` containers;
CI runs the same command as a two-version matrix. For each version it:

- replays the active baseline from zero and verifies the exact approved
  fingerprint and journal row;
- reruns migration and requires a no-op;
- builds the current declared schema plus invariant definitions without a
  baseline journal record, adopts it explicitly, and proves adoption changed no
  application DDL;
- appends the isolated `tests/fixtures/migrations/ordering-proof.sql` fixture
  only in the disposable artifact directory, proving fresh databases run
  baseline then proof while adopted databases run only proof;
- compares the fresh/adopted final application fingerprints; and
- exercises missing/extra/changed objects, RLS, retired state, target mismatch,
  application/journal sequence drift, exact journal-shape differences,
  concurrent registration/DDL attempts, ambiguous/unexpected journals,
  baseline hash/timestamp, backup, and confirmation/environment-identity
  refusals.

The proof marker is never part of `migrations/` and therefore cannot create a
meaningless production object. Containers and artifacts use per-run ownership
identities and checked cleanup. No Neon or production credentials are used.
The matrix also verifies exact LF migration bytes in the checked-out tree and a
clean `core.autocrlf=true` clone. PostgreSQL 16 and 17 must produce the same
format-version-2 fingerprint, including all 26 application-owned sequences.

`npm run test:local` builds the canonical behavioral-test template as an empty
local database, applies the complete active checked-in history with the guarded
`db:migrate` runner, verifies the exact journal, and requires a second migration
run to be a no-op before invariants and test seed are installed. The template
hash covers active SQL, metadata, checksums, fingerprint, migration
loader/runner/journal code, declarations, invariants, and seed inputs; it does
not include `migrations-legacy-do-not-replay/`. A rebuild removes the prior
cache token before dropping the template, and a cache hit still requires both
the exact journal and approved structural fingerprint. Every physical worker clone
rechecks the exact journal before its URL is exposed and emits
`[test-worker-provenance] source=migrated-template journal=exact`. CI requires
both template and worker provenance, so application behavior is exercised only
on migration-built databases.

Canonical template construction on remote Neon is disabled. A Neon branch
inherits its parent schema and cannot prove an empty from-zero replay, so hash
drift cannot be repaired by building a branch or by falling back to
`db:push`. A pre-existing Neon template can be resolved only on a matching
cache hint and must already have the exact checked-in journal and approved
fingerprint; otherwise the
run fails closed. Normal CI and `test:local` force the local migrated-template
path.

Before cleanup, template recreation, or worker cloning opens a connection, the
shared destructive-database guard requires an explicit role and database in
`DATABASE_URL` and rejects target-changing query parameters, URL fragments,
and ambient `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`/`PGOPTIONS`/service
overrides. These ambiguity checks cannot be bypassed with `DEV_DB_OK`; local
template construction separately requires a loopback authority host.

A pre-baseline local test container with application tables and an empty or
absent journal is deliberately refused; because that database is disposable,
remove/recreate the named `leaguevault-test-postgres` container rather than
bypassing adoption gates.

## Legacy inventory reproduction

`npm run db:inventory:validate-local` owns a separate, uniquely named,
ephemeral `postgres:17` Docker container. It does not reuse or mutate the
long-lived `leaguevault-test-postgres` container, a Neon test branch, or any
configured `DATABASE_URL`.

Inside that disposable container, the validation creates one database through
current declarations through `db:push:disposable` and one by transactionally
replaying only the SQL files named by
`migrations-legacy-do-not-replay/meta/_journal.json`. Every listed file is parsed and checked
against the current six-category statement allowlist before Docker starts or
the replay database is created. It does not create or write a
`__drizzle_migrations` table.

The schema-push database is accepted only after the command proves the exact
full Docker container ID, per-run ownership/purpose and approved-database
labels, `127.0.0.1` published port, auto-remove setting, Docker-created
anonymous data volume, database, role, and per-database comment marker. The
verified URL is the URL passed to Drizzle; target/config overrides are refused
and no remote-host allowlist or `DEV_DB_OK`-style bypass exists.

Each invocation has a random run id, an ownership-labeled container, and an
ignored `.artifacts/db-inventory/<run-id>/` directory. Docker returns the exact
container ID; later actions use that ID after label verification. Graceful
cleanup is checked, force removal is attempted only after ownership is
reverified, and unresolved cleanup makes the command fail. Parallel runs
therefore cannot overwrite artifacts or clean up one another's containers.
The same `db:push` database is inventoried twice and the validator requires
byte-for-byte identical JSON.

The validator asserts the known transitional mismatch: 29 tables from
`db:push`, 17 from journal replay, and 12 tables missing from the journal
result. Detecting and correctly categorizing that difference is success. It is
not a migration-equivalence gate and is not currently run as a separate CI
database job. The pure comparison behavior is covered by
`tests/unit/db-schema-inventory-tools.test.ts` in the ordinary Vitest CI suite.
Those tests also cover unsafe SQL rejection, quote-aware definition
normalization, run-specific artifact paths, cleanup failure, and ownership
mismatch refusal.

- **Per-Pool Test DB Clone via Deterministic Name**: For vitest projects that combine `pool: 'forks'` with `isolate: true` (`parallel-isolated`, `serial-fk-bypass`, `parallel-isolated-with-app`), the per-worker template-DB clone uses a deterministic name `test_worker_<LV_TEST_RUN_ID>_pool_<VITEST_POOL_ID>` (Task #722). `LV_TEST_RUN_ID` is generated once by `globalSetup` and inherited by every spawned fork (including those vitest recycles between files under `isolate: true`). `cloneTemplate()` short-circuits when the target DB already exists. Combined with the in-process `process.env` memo (`__LV_WORKER_DB_NAME__`/`__LV_WORKER_DB_URL__`/`__LV_WORKER_APP_PORT__`), this bounds per-pool clone count at exactly 1, so the project's total clone count is exactly `maxForks` regardless of file count or fork-recycle frequency.
- **End-of-run-only cleanup model for Neon test branches** (Task #723 review): Branch deletion happens in exactly two places and nowhere else. (1) **End-of-run hook** in `tests/setup/summary-reporter.ts` `onTestRunEnd` — runs once in the main vitest process after every project + every fork has finished, scoped to `test_worker_<RUN_ID>_*` so a concurrently-running sibling vitest process is never touched. (2) **Startup cross-run sweep** in `tests/setup/global-setup.ts` via `cleanupTestDbs({ minAgeMs: 10*60*1000, connectionAware: true })` — **connection-aware** (Task #742): instead of guessing from age, it probes each `test_worker_*` branch's compute for live client connections. A branch with **no active compute** (idle/suspended) or a warm compute with **zero client connections** is a crashed-run orphan and is reaped immediately regardless of age; a branch with **live connections** is an actively-running sibling vitest process and is always kept. `minAgeMs` is retained only as a fallback when the compute probe can't reach a branch. The idle branches are reaped without opening a connection (so a suspended compute is never needlessly woken). This replaces the old blunt 10-minute age gate so your own killed-run orphans are cleaned within seconds during rapid debug retries. Implementation: `classifyBranchForSweep` in `scripts/cleanup-test-dbs.ts` uses `getBranchEndpoints` (compute state) + a short-lived `pg.Client` probe of `pg_stat_activity` (`backend_type = 'client backend'`). Covered by `tests/unit/cleanup-connection-aware-sweep.test.ts`. **Per-fork `process.on('beforeExit')` deletion was tried and reverted** because vitest projects with `isolate: true` (`parallel-isolated-with-app`, `serial-fk-bypass`) recycle fork processes between files: a per-fork hook fires after every file and deletes the branch the next file's fresh fork is about to use, breaking the run with `endpoint not found` errors. **`globalSetup` per-project teardown is also unsafe** because vitest fires it when each project finishes its files, not when the whole run ends — a fast project would yank shared per-pool branches out from under sibling projects. Reporter-based end-of-run cleanup is the only hook that fires exactly once after all projects + all forks are guaranteed done. Opt-out: `LV_TEST_SKIP_BRANCH_CLEANUP=1`. Both call sites go through `cleanupTestDbs()` which calls `assertSafeDatabaseHost()` first; `ensure-test-template.ts` also calls `assertSafeDatabaseHost()` before its hash-match Neon-API fast path. The `cleanupViaNeonBranches` helper accepts an optional `minAgeMs` (filters by `branch.created_at`) and an optional `branchNamePrefix` (RUN_ID-scoping for end-of-run); legacy mode keeps its existing `pg_advisory_lock` + active-connection skip safeguard unchanged.
- **Neon Branches API password reveal** (Task #727): worker-branch URLs are composed using the password returned by `GET /projects/{p}/branches/{b}/roles/{role}/reveal_password` rather than the password baked into `DATABASE_URL`. The dev compute and the production-parented template/worker computes can carry different SCRAM verifiers when a project-wide role-password rotation hasn't propagated to a long-suspended compute, and the stale verifier rejects `DATABASE_URL`'s current password with 28P01. `revealBranchRolePassword()` in `tests/setup/neon-branches.ts` is memoised per `(branchId, roleName)` for the calling process; `createBranchWithEndpoint` and `resolveBranchUrl` both call it before composing the URL. The reveal response is treated as a secret (never logged, never echoed in error messages). Worker forks generally never call the API themselves — they read the per-pool URL (already containing the revealed password) from `__LV_WORKER_DB_URL_pool_<N>__`.
- **Cold-branch boot hardening against 28P01** (Task #752): The Task #727 reveal happens exactly once at branch create/resolve time, but nothing retried the actual Postgres connection. A branch created off a long-suspended parent compute can land inside a cold-start *warm-up window* during which the just-spun-up compute still rejects even the verifier-correct password with `28P01`. The first connection on a cold branch then failed and took the worker (and its spawned app) down before a single test ran — the only workaround was a lucky manual re-run against a now-warm branch. `verifyBranchUrl()` in `tests/setup/neon-branches.ts` now opens a short-lived `pg.Client` (`SELECT 1`) against the freshly-composed branch URL before handing it out. On `28P01` it sleeps with linear backoff (`baseDelayMs * attempt`, default 750ms), re-reveals the role password with `revealBranchRolePassword(..., { forceRefresh: true })` (bypassing the per-process reveal cache so a verifier that propagated mid-retry is picked up), recomposes the URL, and retries up to a bounded budget (default 6 attempts). Only `28P01` is retried; any other connect failure surfaces immediately. On budget exhaustion it throws a generic, secret-free error (`branch <id> connectivity probe failed after N attempt(s) (...)`) — the password/URL/raw driver error are never logged or echoed. Both provisioning entrypoints (`createBranchWithEndpoint`, `resolveBranchUrl`) call `verifyBranchUrl` so every URL returned from `cloneViaBranch` / `precloneAllWorkerDbs` is verifier-confirmed before the per-pool env stash or the spawned per-worker app inherits it. The legacy `CREATE DATABASE … TEMPLATE` path is untouched (it does not exhibit the verifier race) and the happy path pays only one cheap `SELECT 1`. Covered by `tests/unit/neon-branches-reveal-password.test.ts`.
- **Neon Branches API for Test-DB Cloning** (Task #723): Worker cloning can still use the Neon control plane when `NEON_API_KEY` and `NEON_PROJECT_ID` are set, but template construction cannot. `ensure-test-template.ts` may resolve a pre-existing persistent `LeagueVault_Test_Template` branch only when the local schema-input hash already matches, and it requires that branch to contain the exact active journal. Missing, stale, or hash-drifted remote templates fail closed; `build-test-template.ts` never creates, wipes, migrates, or schema-pushes a Neon branch. With an already verified template, each per-pool worker is a Neon branch named `test_worker_<RUN_ID>_pool_<N>`, created in parallel and checked for the exact journal before its URL is exposed. Worker URLs use direct endpoints because tests require session-scoped advisory locks. `LV_TEST_USE_NEON_BRANCHES=0` forces local `CREATE DATABASE … TEMPLATE` cloning. Per-pool URLs/branch IDs are stashed in `__LV_WORKER_DB_URL_pool_<N>__` / `__LV_WORKER_BRANCH_ID_pool_<N>__`; cleanup deletes only run-scoped `test_worker_*` branches. The API wrapper does not log credential-bearing connection URIs.
- **Serial Pre-Clone of All Per-Pool DBs in globalSetup** (legacy fallback path only): Even with the in-process advisory lock from #722, sibling forks' admin pools open separate pg sessions, and on managed Postgres (Neon) the concurrent `CREATE DATABASE … TEMPLATE …` storm has been observed to exhaust the 12-attempt 55006 retry budget (~100s of wasted clone time per failed fork). When the Neon-branches API is unavailable (no `NEON_API_KEY`/`NEON_PROJECT_ID` or `LV_TEST_USE_NEON_BRANCHES=0`), `globalSetup` calls `precloneAllWorkerDbs(MAX_POOL_ID)` from `tests/setup/clone-template.ts` immediately after `ensureTestTemplate()`, serially creating `test_worker_<RUN_ID>_pool_1..N` (N=4) under the same advisory lock. Per-fork `cloneTemplate()` calls then hit the `existed=true` short-circuit in <500ms instead of racing CREATE. This converted setup-bucket from 995s to ~70s and total wall-clock from 504s to ~290s on the legacy path. **All cloning + per-worker-DB init logic** (`cloneTemplate`, `workerDbName`, `workerDbNameForPool`, `cloneTemplateForWorker`, `precloneAllWorkerDbs`, env-stash keys `__LV_WORKER_DB_NAME__`/`__LV_WORKER_DB_URL__`/`__LV_WORKER_BRANCH_ID__`) lives in `tests/setup/clone-template.ts` (side-effect-free). `tests/setup/global-setup.ts` AND `tests/setup/per-worker-db-only.ts` import from there directly so neither code path drags in `per-worker-setup.ts`'s top-level `await ensurePerWorkerApp()` (which would spawn an Express in DB-only / globalSetup contexts). `per-worker-setup.ts` re-exports `cloneTemplateForWorker` for backwards compat with any direct importers.
- **Concurrent-boot safety on shared test DBs**: With deterministic per-pool naming (Task #722), recycled forks and sibling test-app spawns can boot against a DB another boot is mid-install on. `installDbInvariants()` in `server/db-invariants.ts` therefore wraps its DROP TRIGGER / CREATE TRIGGER pair in a session-scoped `pg_advisory_lock(7220001)` so the install is atomic per-DB and the `trigger "users_role_org_required" ... already exists` race is impossible.
- **Lock-key shared between test-DB cleanup and clone**: `tests/setup/per-worker-lock.ts` is a side-effect-free home for `TEMPLATE_DB_NAME` and `CLONE_ADVISORY_LOCK_KEY` (Task #722). Both `tests/setup/per-worker-setup.ts` (cloneTemplate) and `scripts/cleanup-test-dbs.ts` import the constants from there so the cleanup advisory lock and the clone advisory lock genuinely match. Importing `per-worker-setup.ts` from cleanup paths is forbidden — it has top-level `await ensurePerWorkerApp()` and would spawn a worker app from cleanup contexts.
