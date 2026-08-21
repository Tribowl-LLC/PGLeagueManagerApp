# LeagueVault Local Development

This document is the authoritative starting point for developing LeagueVault
locally. It explains how to prepare a workstation, run the application, and
validate a change. Read [`README.md`](../README.md) for the product overview and
repository map, [`DATABASE.md`](DATABASE.md) for the database model
and migration safeguards, and [`DEPLOYMENT.md`](DEPLOYMENT.md) for the boundary
between local work and deployment. This guide does not describe production
configuration or releases.

## Quick start

For an existing checkout with PostgreSQL 17 already running locally:

```bash
npm ci
# Export DATABASE_URL, SESSION_SECRET, and FIELD_ENCRYPTION_KEY here.
npm run db:migrate
npm run dev
```

This is only the compact path. First-time contributors should follow System
requirements, Repository setup, Environment configuration, and Local database
requirements below before running it.

## 1. Development philosophy

LeagueVault's development environment is designed to make a local result a
useful predictor of CI and production behavior.

- **Reproducible builds:** use the committed runtime version, lockfile, schema
  history, and repository scripts rather than workstation-specific shortcuts.
- **Deterministic dependencies:** install exactly what `package-lock.json`
  records. Dependency changes must be explicit and reviewable.
- **Local-first development:** develop and test against local services and
  local-only credentials. Routine development must not depend on production
  systems.
- **CI parity where practical:** use the same Node.js line, migration history,
  build command, linter, type checker, and test runner used in CI.
- **Fail-fast validation:** investigate the first concrete error from startup,
  migrations, tests, or static checks instead of working around it.
- **Reviewed changes only:** keep work on a short-lived branch and merge it to
  protected `main` through a pull request.

Local behavior should mirror production behavior whenever that is reasonable,
especially for PostgreSQL, migration order, authentication, tenant isolation,
time-zone behavior, and the production build. Local databases, secrets, and
third-party credentials must nevertheless remain isolated from production.

## 2. System requirements

The repository package manager is npm. Use it for dependency installation and
package scripts; do not introduce Yarn, pnpm, or an additional lockfile.

Install the following tools before setting up the repository:

| Tool | Requirement | Why it is required |
| --- | --- | --- |
| Node.js | `22.22.x`; `package.json` accepts `>=22.22.0 <23` and `.node-version` pins `22.22.0` | CI and Render use the pinned Node.js version. Matching it avoids runtime and dependency differences. |
| npm | Use the npm version bundled with the repository-supported Node.js installation unless the repository explicitly pins a different version | The repository uses npm and a lockfile version 3. Do not upgrade npm independently as part of unrelated work, and do not add a Yarn or pnpm lockfile. |
| Git | A current version with support for worktrees and normal branch workflows | `main` is protected and changes are reviewed through pull requests. |
| PostgreSQL | PostgreSQL 17 for the normal persistent development database | This is the standard local runtime and the version used by the full local test wrapper and migration validation. |
| Docker | Docker Desktop on Windows or macOS, or a compatible Docker Engine on Linux | `npm run test:local` and `npm run db:check` create or reuse local PostgreSQL containers. |
| Bash | Required only for `npm run test:race` | The race-suite wrapper is a Bash script. On Windows, run it from Git Bash or WSL with Docker access. |

Windows, macOS, and Linux are suitable for day-to-day development. CI and
Render run in Linux environments, so contributors on other operating systems
should rely on the repository validation commands to catch platform-specific
differences. Docker is the recommended way to keep PostgreSQL behavior
consistent across workstations.

Confirm the two most important versions before installing dependencies:

```bash
node --version
npm --version
```

If Node.js does not report `v22.22.x`, switch versions before continuing.

## 3. Repository setup

For a first-time checkout:

1. Clone the repository and enter it.

   ```bash
   git clone https://github.com/Tribowl-LLC/PGLeagueManagerApp.git
   cd PGLeagueManagerApp
   ```

2. Confirm that Node.js matches `.node-version`.

   ```bash
   node --version
   ```

3. Install the exact dependency tree recorded by the lockfile.

   ```bash
   npm ci
   ```

Use `npm ci`, not an unlocked install, for normal setup and rebuilds. It starts
from the committed `package-lock.json`, rejects disagreement between the
manifest and lockfile, and produces the same dependency selection as CI. Never
delete or regenerate the lockfile merely to get past an installation error.
If the parent shell has `NODE_ENV=production`, npm omits the development tools
needed by `npm run check`, `npm run lint`, and `npm run build`. The durable fix
is to remove `NODE_ENV` from the workstation's persistent development
environment and unset it in the current shell before running `npm ci`. As an
immediate recovery option, `npm ci --include=dev` installs the omitted tools
for that installation. Do not treat that flag as a replacement for correcting
the environment, and do not commit `include=dev` as a project-wide npm setting
because that would also change production installation behavior.

The complete Docker database example and quick-start commands are in
[`README.md`](../README.md#local-setup).

## 4. Environment configuration

The application reads the process environment directly. A root `.env` file is
not automatically loaded by `npm run dev`. Use
[`.env.example`](../.env.example) as the placeholder-only inventory for normal
local application settings, then export the values you need from the active
shell or a secure local secret manager. The variable table in
[`README.md`](../README.md#environment-variables) provides additional context.

The server requires:

| Variable | Local purpose |
| --- | --- |
| `DATABASE_URL` | Connection string for the local development database. |
| `SESSION_SECRET` | Local-only session-signing secret. Changing it invalidates local sessions. |
| `FIELD_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters. Keep it stable for a persistent local database so encrypted local fields remain readable. |

Common local values are `APP_ENV=dev`, `NODE_ENV=development`, and `PORT=5000`.
`LOG_LEVEL` may be set to `debug`, `info`, `warn`, or `error` while diagnosing
an issue.

Provider configuration is optional for ordinary development. Examples include
SendGrid (`SENDGRID_API_KEY`), Sentry (`SENTRY_DSN` and build-time
`VITE_SENTRY_DSN`), setup endpoints (`SETUP_SECRET`),
Square sandbox credentials. Configure an integration only when the
feature under test needs it, and use sandbox or deterministic local values.
Variables prefixed with `VITE_` are delivered to browser code and must never
contain secrets.

Never copy production secrets, customer data, database URLs, or payment
credentials into a development shell, `.env` file, fixture, log, or prompt.
Never commit a local environment file. The committed `.env.example` contains
names and safe placeholders only; keep it that way.

## 5. Local database requirements

PostgreSQL stores all application state. Use PostgreSQL 17 for the normal
persistent development database. The recommended setup in
[`README.md`](../README.md#local-setup) creates `leaguevault-postgres` on loopback
port `5433`, which leaves port `5432` available to the isolated test container.
An equivalent local PostgreSQL installation is acceptable if `DATABASE_URL`
points to the intended local database.

First-time database setup is:

1. Create and start an empty local PostgreSQL 17 database.
2. Export a `DATABASE_URL` that names that database.
3. Apply the checked-in migration history.

   ```bash
   npm run db:migrate
   ```

4. Start the application and verify `/api/health` before adding local data.

Use the database commands for distinct purposes:

| Command | When to use it |
| --- | --- |
| `npm run db:generate -- --name <lowercase_description>` | After changing declarations under `shared/schema/`; generates SQL and metadata for review without connecting to PostgreSQL. |
| `npm run db:migrate` | After pulling new migrations or creating a fresh local database; applies the checked-in history in journal order. Re-running an exact history is a no-op. |
| `npm run db:check` | Before a pull request that changes schema declarations, migrations, database invariants, or migration infrastructure; replays and validates the migration system on a disposable PostgreSQL 17 database. |
| `npm run db:migration-bytes:check` | When diagnosing migration checksum, line-ending, UTF-8, or metadata failures. It is also covered by `db:check`. |
| `npm run seed` | When manual browser testing needs the deterministic local development users and organizations described in `tests/README.md`. |

A **persistent development database** keeps developer-created state between
server or container restarts. Migrate it forward; keep its local encryption key
stable; reset it only when its data can be discarded. A **disposable database**
is created for a test, migration replay, or schema experiment and may be
deleted afterward. `npm run test:local`, `npm run db:check`, and the narrowly
guarded `db:push:disposable` workflow own their disposable targets. Do not aim
`db:push:disposable` at an ordinary persistent database.

The schema authority, migration rules, reset constraints, and advanced
diagnostics are documented in [`DATABASE.md`](DATABASE.md). The
production backup, adoption, and deployment sequence in that document and in
[`DEPLOYMENT.md`](DEPLOYMENT.md) is not part of routine local development.

## 6. Running the application

After PostgreSQL is ready, the required environment variables are exported,
and migrations are current, run:

```bash
npm run dev
```

This starts the Express backend and mounts the Vite frontend middleware in the
same process. The default address is
[http://localhost:5000](http://localhost:5000). Vite provides frontend hot
module replacement, so most client changes appear without a full reload.
Server changes require restarting `npm run dev`; there is no server watch
wrapper in the current script.

During startup, the application validates environment variables, connects to
PostgreSQL, installs required database invariants, registers routes and
background services, initializes Vite, and begins listening. A healthy startup
logs that Vite middleware is ready and that the server is running. Check both
the process and its database connection with:

```bash
curl http://localhost:5000/api/health
```

In PowerShell, use `Invoke-RestMethod
http://localhost:5000/api/health` instead.

Common startup failures are a missing or malformed required variable, an
unreachable database, unapplied migrations, port `5000` already being used,
or a Vite dependency/build error. Read the first error and validate that
specific dependency before changing code.

## 7. Testing

LeagueVault uses Vitest for unit, component, API, and integration tests, with
repository wrappers for isolated PostgreSQL and race coverage.

| Command | Coverage and intended use |
| --- | --- |
| `npm run test:unit-no-db` | Pure unit tests that must not import database setup. Use for fast feedback on isolated logic. |
| `npm test -- <path-to-test>` | A focused one-shot Vitest file during implementation; for example, `npm test -- tests/unit/zod-v4-migration-contracts.test.ts`. npm forwards the path after `--` to the repository's `vitest run` script. |
| `npm run test:watch` | Interactive Vitest watch mode while developing. It is not a substitute for the complete suite. |
| `npm test` | Raw one-shot Vitest run across the configured default projects. It expects its database, environment, and any required app server to have been prepared. Prefer `test:local` for normal full validation. |
| `npm run test:local` | Recommended complete local suite. It verifies Node.js, starts or reuses the local PostgreSQL 17 test container, applies migrations, builds an exact test template, and runs isolated worker databases. Docker must be available. |
| `npm run test:race` | Separate serial coverage for shared-state concurrency behavior. It requires Bash, a prepared test database/application environment, and `SETUP_SECRET`; run it when changing the covered bootstrap, locking, payment retry, or shared-state behavior. Never point it at production. |
| `npm run db:check` | Migration suite. It validates replay, fingerprints, ordering, adoption/refusal safeguards, and PostgreSQL 17 compatibility on a disposable container. |
| `npm run test:template:build` | Test-infrastructure diagnostic that rebuilds the canonical test template. Routine contributors should normally let `test:local` manage it. |
| `npm run db:inventory:validate-local` | Specialized legacy-schema reproduction. Run only when working on the schema inventory/legacy evidence tooling; it is intentionally separate from the normal suite. |

API and integration tests live primarily under `tests/api/`, browser-oriented
component tests under `tests/components/`, pure tests under `tests/unit/`, and
co-located server tests under `server/**/__tests__/`. The exact Vitest project
layout, test seeding, opt-in variables, cleanup contract, and server
requirements are authoritative in [`tests/README.md`](../tests/README.md) and
[`TEST_INFRA.md`](TEST_INFRA.md).

Before opening a pull request, run the applicable focused tests during
iteration, then run the normal local validation sequence:

```bash
npm run test:local
npm run check
npm run lint
npm run build
npm run security:audit:prod
npm run security:audit:all
```

The repository's full validation sequence also includes `npm run db:check`.
Run it before the pull request when the change touches `shared/schema/`, active
migrations, database invariants, migration/adoption/fingerprint/inventory
tooling, or test-template schema construction. For an unrelated documentation,
frontend-only, or isolated code change that demonstrably cannot affect those
surfaces, a local `db:check` run may be recorded as inapplicable; CI still runs
the PostgreSQL 17 migration check for the pull request. When uncertain,
run it.

Run `npm run test:race` as well when the changed behavior is race-sensitive.
CI runs its own main test, migration, static-analysis, build, security, and
race checks; see [`ci.md`](ci.md) for the current job layout. If a
command is unavailable or fails for an unrelated environmental reason, record
the exact command and result in the pull request instead of claiming it passed.

## 8. Linting and formatting

Run the static quality commands after tests and before committing:

1. Type-check the TypeScript program.

   ```bash
   npm run check
   ```

2. Run ESLint over the repository.

   ```bash
   npm run lint
   ```

3. Prove that both frontend and backend produce the deployable build shape.

   ```bash
   npm run build
   ```

The repository does not currently define a standalone formatting command or a
Prettier configuration. Follow the style of the files being edited, keep diffs
focused, and use ESLint as the automated source-quality gate. Do not run an
uncommitted formatter across the repository or introduce formatting-only
churn in a functional change.

CI must pass without new ESLint suppressions or a silent baseline increase.
Suppressions are ratcheted and require an explicit, reviewer-visible reason;
see [`CONTRIBUTING.md`](../CONTRIBUTING.md) and
[`lint.md`](lint.md).

## 9. Development workflow

Use this sequence for normal work:

1. Fetch the remote and update local `main` with a fast-forward only.

   ```bash
   git fetch --prune origin
   git switch main
   git pull --ff-only origin main
   ```

2. Create one short-lived, descriptive branch, such as
   `codex/fix-payment-timezone` or `codex/docs-local-setup`.
3. Run `npm ci` when the lockfile changed or the installation is not known to
   match it.
4. Make the smallest change that satisfies the task. Preserve tenant
   isolation, authorization, payment safeguards, time-zone behavior, and API
   compatibility.
5. Add or update focused tests for changed behavior and run them while
   iterating.
6. If schema declarations changed, generate one named migration and review
   every generated SQL, metadata, and checksum change.
7. Run the complete applicable validation sequence from the Testing section,
   followed by any task-specific checks.
8. Review `git diff` for unrelated edits, generated artifacts, local data, and
   secrets.
9. Commit only the reviewed scope, push the branch, and open one pull request
   against `main`. Do not push normal work directly to `main` or merge without
   explicit authorization.

Repository-wide contribution, security, and database invariants are in
[`AGENTS.md`](../AGENTS.md); lint-baseline expectations are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## 10. Common development tasks

### Add a migration

1. Edit the Drizzle declarations under `shared/schema/`.
2. Run `npm run db:generate -- --name <lowercase_description>` exactly once for
   the logical change.
3. Review the SQL, metadata, checksum, compatibility, and possible data-loss
   implications.
4. Run `npm run db:check`, apply it locally with `npm run db:migrate`, and run
   the affected tests.

Do not hand-edit an already-applied migration. Follow the complete forward-only
workflow in [`DATABASE.md`](DATABASE.md#forward-only-migration-workflow).

### Update dependencies

Change dependencies intentionally with npm, inspect both `package.json` and
`package-lock.json`, and review transitive and security effects. Do not switch
package managers, delete the lockfile, or use a forced audit fix without
reviewing breaking changes. Re-run the complete validation sequence.

### Debug startup failures

Work from the first startup error. Confirm Node.js, the three required server
variables, PostgreSQL readiness, the exact `DATABASE_URL`, migration state, and
port availability in that order. Use `/api/health` to distinguish a running
HTTP process from a healthy database connection.

### Reset a local database

First prove that the target is the disposable or developer-owned local
database and that none of its contents are needed. For the recommended Docker
setup, follow the exact container and named-volume procedure in
[`README.md`](../README.md#local-setup). Removing the container alone can preserve
the named volume; removing the named volume permanently deletes the local
database. Recreate the empty database and run `npm run db:migrate`. Never use a
broad cleanup command or a production/shared URL.

### Rebuild dependencies

Confirm the supported Node.js version, remove only the repository's local
`node_modules` directory if a clean rebuild is necessary, and run `npm ci`.
Do not remove `package-lock.json`.

### Clear generated or cached artifacts

The build output is `dist/`; schema inventory diagnostics use
`.artifacts/db-inventory/`; and local test-template metadata may appear under
`.local/`. Stop related processes first, identify the exact repository-local
artifact, and remove only reproducible output. Do not use `git clean`, delete
unknown files, or remove local database volumes as a cache-clearing shortcut.
The owning command will recreate its artifacts on the next run.

## 11. Troubleshooting

### Wrong Node.js version

Compare `node --version` with `.node-version` and the `engines.node` range in
`package.json`. Switch to Node.js 22.22.x, then run `npm ci` so native or
runtime-sensitive packages match the supported environment.

### Dependency installation fails

Read npm's first actionable error. Verify Node.js and npm versions, confirm
that `package.json` and `package-lock.json` are not locally mismatched, and
check registry/network access. Use `npm ci` again after fixing the cause; do
not regenerate the lockfile as a diagnostic shortcut.

### PostgreSQL connection fails

Confirm the intended database process or Docker container is running, wait for
`pg_isready`, and inspect the host, port, database, role, and password in the
local `DATABASE_URL`. The recommended persistent database uses loopback port
`5433`; the test wrapper owns a separate container. Avoid printing a complete
credential-bearing URL in shared logs.

### Migration conflict or refusal

Stop and read the migration command's refusal message. Compare the checked-in
migration journal, checksum files, and local schema state. Do not edit migration
history or bypass safeguards. Recreate only a proven-disposable database; for a
persistent database, use the diagnosis in
[`DATABASE.md`](DATABASE.md).

### Environment-variable error

Compare the named variable with the table in
[`README.md`](../README.md#environment-variables). Confirm it is exported in the
same shell that starts Node.js. Remember that `.env` is not automatically
loaded and `FIELD_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters.

### Port conflict

Identify the process or container already using port `5000`, `5432`, or `5433`.
Stop the correct local process or choose a different local port and update
`PORT` or `DATABASE_URL`. Do not terminate an unknown process without first
identifying it.

### Build fails

Run `npm run check` and then `npm run build`; preserve the first error from
TypeScript, Vite, or esbuild. Check for missing assets, incorrect path aliases,
case-sensitive import mismatches, and stale dependencies. A working dev server
does not prove the production-shaped bundle can build.

### Tests fail

Read the first failing test and its setup output. Determine whether the failure
is code, test data cleanup, migration state, Docker availability, a missing
test variable, or a port collision. Re-run the focused file after fixing the
cause, then re-run `npm run test:local`. Do not weaken assertions, isolation,
authorization, or cleanup to obtain a passing result.

## 12. Best practices

- Keep branches and pull requests small so reviewers can understand behavior,
  security boundaries, and migration effects.
- Commit only code and documentation that you have reviewed in the final diff.
- Prefer pinned, deterministic repository tooling over global or ad hoc tools.
- Never bypass linting, type checking, tests, migration checks, or security
  guards; they protect behavior that is difficult to verify manually.
- Treat generated migrations and lockfiles as reviewable outputs. Generate
  them with repository commands and do not edit them casually.
- Never commit secrets, real customer data, local database contents, or
  credential-bearing logs.
- Preserve CI reproducibility by matching Node.js, respecting
  `package-lock.json`, and running the same scripts locally.
- Diagnose failures from evidence and report any skipped or unavailable check
  explicitly.

These practices reduce workstation-specific failures, keep changes auditable,
and make LeagueVault safer to maintain across database, payment, security, and
multi-tenant workflows.
