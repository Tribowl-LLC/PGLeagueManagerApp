# LeagueVault

## Overview

LeagueVault is a multi-tenant bowling league management application for adult
leagues. It helps organizations manage locations, leagues and seasons, teams,
bowlers, schedules, registrations, payments, refunds, and administration.

The application supports organization subdomains, organization-scoped access
control, transactional email, and a Square payment integration.

## Architecture

- `client/src/` contains the React and Vite web client. TanStack Query manages
  server state and Wouter manages client-side routes.
- `server/` contains the Express API, authentication, storage layer, scheduled
  services, payment integrations, and production static-file serving.
- `shared/schema/` contains the Drizzle PostgreSQL schema, shared validation,
  and API types.
- PostgreSQL stores application data. Production uses Neon PostgreSQL.
- Capacitor targets in `ios/` and `android/` package the application for
  native mobile builds.

## Prerequisites

- Node.js `22.22.x` (the repository requires `>=22.22.0 <23`; see
  `.node-version`).
- npm, installed with Node.js.
- PostgreSQL 17 for local development, either installed locally or run with
  Docker Desktop.
- Git.

Docker Desktop is required by the recommended full local test command,
`npm run test:local`.

## Quick Start

For returning contributors who already have the repository, local database
container, and environment variables configured:

```bash
git fetch --prune
git switch main
git pull --ff-only origin main
npm ci
```

Start the database container if it is not already running:

```bash
docker start leaguevault-postgres
```

Then apply the schema and start the development server:

```bash
npm run db:migrate
npm run dev
```

If the repository or `leaguevault-postgres` container has not been created yet, follow the complete
[`Local Setup`](#local-setup) instructions below.

## Local Setup

Clone the repository, install the locked dependencies, configure the required
environment variables, and apply the database schema:

```bash
git clone https://github.com/Tribowl-LLC/PGLeagueManagerApp.git
cd PGLeagueManagerApp
npm ci
```

To create the local PostgreSQL database with Docker:

```bash
docker run --detach --name leaguevault-postgres \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=leaguevault \
  --publish 127.0.0.1:5433:5432 \
  --volume leaguevault-postgres-data:/var/lib/postgresql/data \
  postgres:17
```

Wait for PostgreSQL to report that it is ready:

```bash
docker exec leaguevault-postgres pg_isready -U postgres -d leaguevault
```

Wait for `accepting connections` before running `npm run db:migrate`.

This example publishes PostgreSQL only on loopback port `5433`, leaving port
`5432` available for the `npm run test:local` container. The `postgres` /
`postgres` credentials are intentionally weak and are suitable only for this
local database. Do not reuse them for shared, internet-accessible, staging, or
production databases.

The named Docker volume preserves the local database if the container is
removed. If the container already exists, start it with `docker start
leaguevault-postgres`.

Recreating the container with the same named volume reconnects it to the
existing local database contents.

To stop the local database:

```bash
docker stop leaguevault-postgres
```

To remove the container but preserve its named-volume data:

```bash
docker rm -f leaguevault-postgres
```

To remove the container and permanently delete the local database contents:

```bash
docker rm -f leaguevault-postgres
docker volume rm leaguevault-postgres-data
```

Set the required server variables in the shell where you will run the app. For
PowerShell:

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5433/leaguevault"
$env:SESSION_SECRET = node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(48).toString('base64url'))"
$env:FIELD_ENCRYPTION_KEY = node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'))"
$env:APP_ENV = "dev"
$env:NODE_ENV = "development"
$env:PORT = "5000"
```

For macOS or Linux:

```bash
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/leaguevault"
export SESSION_SECRET="$(node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(48).toString('base64url'))")"
export FIELD_ENCRYPTION_KEY="$(node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'))")"
export APP_ENV=dev
export NODE_ENV=development
export PORT=5000
```

These commands generate new secrets for the current shell session. Preserve the
same `FIELD_ENCRYPTION_KEY` while using an existing local database. Changing it
may make previously encrypted local fields unreadable. Changing
`SESSION_SECRET` invalidates existing local sessions.

Store stable local values in a secure local secret manager or shell
configuration that is excluded from source control.

Apply the schema and start the development server:

```bash
npm run db:migrate
npm run dev
```

Open [http://localhost:5000](http://localhost:5000). The development server
serves both the API and the Vite-powered frontend from one process. Client
changes hot reload through Vite; server changes require restarting `npm run dev`.

Verify the application and database connection with:

```bash
curl http://localhost:5000/api/health
```

On PowerShell, use:

```powershell
Invoke-RestMethod http://localhost:5000/api/health
```

A successful response indicates that the application is running and can reach
the configured database. The exact response body may change as health checks
evolve.

## Environment Variables

The server reads environment variables from the process environment. Start
with [`.env.example`](.env.example), which labels required, optional,
server-only, and browser-visible settings. This repository does not include a
Node dotenv loader, so a root `.env` file is not automatically loaded by
`npm run dev`; configure variables in your shell, local secret manager, or
deployment provider. Keep secrets out of source control.

For a development checkout, remove or unset any ambient
`NODE_ENV=production` setting before running `npm ci`; npm otherwise omits the
build, type-check, lint, and test tools. If the setting cannot be corrected
immediately, `npm ci --include=dev` is a one-time recovery command, not a
replacement for fixing the development environment.

Required for the server and database commands:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string, for example `postgres://postgres:postgres@127.0.0.1:5433/leaguevault`. |
| `SESSION_SECRET` | Secret used to sign server-side sessions. |
| `FIELD_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters (32 bytes) used to encrypt sensitive fields. |

Common local settings:

| Variable | Description |
| --- | --- |
| `APP_ENV` | Environment selector: `dev` or `prod`. Use `dev` locally and `prod` on Render. |
| `NODE_ENV` | Node runtime mode. Use `development` locally and `production` for a built deployment. |
| `APP_DOMAIN` | Base application hostname; defaults to `leaguevault.app`. |
| `PORT` | HTTP port; defaults to `5000`. |
| `LOG_LEVEL` | Optional log level: `debug`, `info`, `warn`, or `error`. |

Optional integrations and operational settings include `SENDGRID_API_KEY`
(email), `SENTRY_DSN` (server error tracking), `VITE_SENTRY_DSN` (browser
error tracking at build time), `SENTRY_AUTH_TOKEN` (build-only browser source-map
upload), and `SETUP_SECRET` (admin bootstrap endpoints).
If `SETUP_SECRET` is set, it must
be at least 32 characters long and must not be a single repeated character.
All variables prefixed with `VITE_` are bundled into browser code and therefore
must never contain credentials. Production-only provider aliases, deployment
probes, database-adoption gates, and test-runner controls are intentionally
documented in their owning runbooks rather than enabled in the local example.

Generate a suitable local field-encryption key with:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'))"
```

## Database Setup

Set `DATABASE_URL` to a development or test PostgreSQL database before using
Drizzle commands. `shared/schema/` is the declaration authority and
`migrations/` is the only active, forward-only history. Initialize an empty
database with:

```bash
npm run db:migrate
```

`db:migrate` verifies the exact journal format and checked-in hash/timestamp
prefix, serializes migration executors with an advisory lock, and refuses to
run the baseline when a database already contains application-owned public
objects but has no baseline journal record. Such an existing database must be
recreated if disposable or use the guarded adoption workflow in
[`docs/DATABASE.md`](docs/DATABASE.md). An empty journal is never adoption
evidence.

Active migration SQL is hashed from its exact committed bytes. The
`.gitattributes` rules force LF endings for active and test-fixture migration
SQL, and `npm run db:migration-bytes:check` rejects carriage returns, invalid
UTF-8, missing attributes, or a checksum/metadata mismatch. This keeps the
baseline identity identical across Windows and Linux checkouts.

Generate a reviewed future migration without connecting to a database with
`npm run db:generate -- --name <lowercase_description>` (letters, digits, and
underscores only). `db:push` remains available only
as `npm run db:push:disposable` for a tool-created local Docker database whose
exact container, loopback port, ownership labels, approved database name, role,
and database marker are verified immediately before execution. There is no
host allowlist or development override for remote or durable targets, and the
same verified URL is passed to Drizzle. It is not a deployment workflow.

`db:adopt-baseline` is likewise limited to a strictly verified tool-owned local
Docker database. Remote, Neon, ordinary CI, and production execution are
disabled. Adoption never runs baseline application DDL; after target, backup,
commit, capability, fingerprint, and journal gates pass, it can create the
exact Drizzle journal infrastructure and register only the reviewed baseline
row in one guarded transaction. Exact adopted state is a no-op and conflicting
journal state is refused.

The `npm run seed` command idempotently creates local development users and
organizations described in [`tests/README.md`](tests/README.md). These accounts
support manual browser testing. Automated tests seed their own isolated
databases.

## Development Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server on port 5000. |
| `npm run build` | Build the Vite frontend and bundle the Express server into `dist/`. |
| `npm start` | Start the production server from the existing `dist/` build. |
| `npm run check` | Run TypeScript type checking. This does not run ESLint. |
| `npm run lint` | Run ESLint. |
| `npm run db:generate -- --name <lowercase_description>` | Generate reviewed future SQL and metadata without touching a database. |
| `npm run db:migrate` | Apply the checked-in active migration history with guarded journal validation. |
| `npm run db:migration-bytes:check` | Verify exact LF migration bytes, metadata, and the checksum manifest. |
| `npm run db:fingerprint` | Produce the versioned exact application-schema fingerprint from read-only catalog inventory. |
| `npm run db:adopt-baseline` | Register a matching tool-owned local disposable database after all target and safety gates pass; remote and production adoption are disabled. |
| `npm run db:check` | Replay, fingerprint, adopt, prove ordering, and exercise refusal cases on disposable PostgreSQL 17. |
| `npm run db:inventory` | Collect normalized PostgreSQL catalog state plus the approved Drizzle journal in a read-only transaction. |
| `npm run db:inventory:compare` | Compare two normalized schema inventory files. |
| `npm run db:inventory:validate-local` | Reproduce the preserved legacy-history mismatch in an ephemeral local container. |
| `npm run db:push:disposable` | Reconcile declarations only on an exactly proven tool-owned local Docker database. |
| `npm run seed` | Seed local development users and organizations. |
| `npm run check:csrf` | Check CSRF coverage. |
| `npm run check:org-isolation` | Check organization-isolation coverage in strict mode. |
| `npm run security:audit:prod` | Audit production dependencies for high-severity issues. |
| `npm run security:audit:all` | Audit all dependencies for moderate-or-higher issues. |

The CI job named `Type check & lint` runs both `npm run check` and
`npm run lint`, along with the repository's other static and security checks.

## Testing

For the complete local suite, use the repository wrapper:

```bash
npm run db:check
npm run test:local
```

This command checks the Node.js version, starts or reuses the
`leaguevault-test-postgres` PostgreSQL 17 Docker container, applies the schema,
builds the canonical test template from an empty database with `db:migrate`,
requires the second migration run to be a no-op and the journal to be exact,
then runs the Vitest suite with isolated worker clones. Every physical worker
clone rechecks the journal and emits migration provenance consumed by CI.
Remote Neon template construction is disabled because a branch inherits its
parent schema and cannot prove a from-zero replay. Start Docker Desktop before
running the wrapper. Most test runs do not require a development server. Set
`TEST_LOCAL_START_DEV_SERVER=1` only for suites explicitly documented as
requiring live HTTP access on port 5000.

Other test commands are:

```bash
npm test                              # one-shot Vitest run
npm run test:watch                    # watch mode
npm run test:race                     # opt-in race suite
npm test -- tests/unit/app-domain-config.test.ts # focused test file
```

The race suite is a separate, serial suite for tests that mutate shared state.
It requires `SETUP_SECRET` and should not run against a production database.
See [`tests/README.md`](tests/README.md) and [`docs/TEST_INFRA.md`](docs/TEST_INFRA.md)
for authoritative details about test isolation, seeding, and CI. This README
provides the normal developer workflow.

Before handing off a database-backed change, run:

```bash
npm run test:local
npm run check
npm run lint
npm run build
npm run security:audit:prod
npm run security:audit:all
```

## Troubleshooting

### Port 5000 is already in use

Set `PORT` to another port before starting the server, or stop the process
currently using port 5000.

### PostgreSQL port 5433 is already in use

Inspect existing containers:

```bash
docker ps --all
```

Reuse the existing LeagueVault container, or publish the development database
on another loopback port and update `DATABASE_URL` to match.

### Docker Desktop is not running

Start Docker Desktop before running `npm run test:local` or the Docker
database setup command.

### Node version is rejected

Install a supported Node.js 22 release matching `.node-version`, then
reinstall dependencies with `npm ci`.

### Database connection fails

Confirm that the development container is running:

```bash
docker ps --filter name=leaguevault-postgres
```

Confirm that `DATABASE_URL` uses port `5433` for the development database.

## Deployment

Production is hosted on [Render](https://render.com) and uses
[Neon PostgreSQL](https://neon.tech). The production domain is
[`leaguevault.app`](https://leaguevault.app), with organization subdomains on
the same base domain.

GitHub `main` is the release source of truth. Normal changes are merged through
a pull request after the required checks pass, and Render deploys the exact
verified `main` commit. Production should explicitly set `APP_ENV=prod`,
`NODE_ENV=production`, and `APP_DOMAIN=leaguevault.app`. Configure production
secrets in Render, Neon, the payment providers, SendGrid, Sentry, or GitHub
Actions as appropriate; do not commit them.

After deployment, verify `/api/health`, authentication, the affected workflow,
and the relevant provider or webhook behavior. Also request
`/api/org-context` and confirm `appEnv: "prod"` plus the short commit matching
the exact certified Render SHA. The complete release procedure is in
[`docs/production-runbook.md`](docs/production-runbook.md).

## Additional Documentation

- [`AGENTS.md`](AGENTS.md) — durable architecture, security, database, and
  contribution rules.
- [`docs/engineering-context.md`](docs/engineering-context.md) — product
  boundaries and architecture decisions.
- [`docs/ci.md`](docs/ci.md) — GitHub Actions workflows, checks, and CI secrets.
- [`docs/TEST_INFRA.md`](docs/TEST_INFRA.md) — local and CI test database
  infrastructure.
- [`tests/README.md`](tests/README.md) — test layout, fixtures, and opt-in
  suites.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution and lint-baseline rules.
- [`NATIVE_BUILD.md`](NATIVE_BUILD.md) — iOS and Android build instructions.
- [`square-production-guide.md`](square-production-guide.md) — Square payment
  integration guidance.
- [`system-admin-guide.md`](system-admin-guide.md) — system administrator
  operations.
