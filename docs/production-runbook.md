# Production Runbook

## Current runtime

Canonical occurrences are the operational schedule authority. Roster responsibilities,
payment obligations and allocations are the financial authority. Interactive and
standing automatic payments share the provider ledger and roster snapshots.
See [roster-driven payments](roster-driven-payments.md) and
[standing automatic payments](roster-standing-autopay.md).

Keep the existing production payment execution settings unchanged during ordinary
code releases. Do not activate, pause, or reconfigure payment consumers incidentally.
Historical phase rollout instructions are retained in Git history and phase documents;
they are not current release procedures.

## Normal Code Release

1. Fetch the latest `origin/main` and create a `codex/<task>` branch.
2. Make the smallest scoped change.
3. Run the relevant focused tests locally, plus `npm run check`, `npm run
   lint`, and `npm run build` when practical.
4. Push the branch and open a pull request.
5. Wait for `Type check & lint` and `Tests`, which the active GitHub `main`
   ruleset requires. Also verify `Database migrations (PostgreSQL 17)` and
   `Race suite` manually; repository policy treats those two as
   release-blocking even though the current ruleset does not enforce them.
   Review Semgrep, Semgrep Cloud, Gitleaks, HoundDog, and dependency-audit
   results as well. Confirm the live ruleset before every release instead of
   assuming repository settings have remained unchanged.
6. Keep Render Auto-Deploy Off. A schema release must remain held until the
   reviewed production migration has succeeded.
7. Merge the pull request into `main`.
8. Wait for `Exact main certification` on the merged `main` SHA. Confirm its
   log identifies the merged PR, identical tree SHA, and successful PR CI and
   Race suite runs.
9. If the commit contains schema changes, follow [Schema Release](#schema-release)
   through the reviewed migration step before deploying the application. If it
   contains no schema changes, do not run a migration merely as a deployment
   ritual.
10. Manually deploy that exact certified commit. For schema releases, apply
    the reviewed migration first. Leave Auto-Deploy Off.
11. Run the post-deploy trust-proxy probe manually when a release changes
   proxy, cookie, auth, or rate-limit behavior. The scheduled workflow also
   probes the live deployment daily.

## Render Configuration

The production Render project, last verified in the live dashboard on
2026-07-21, contains one `LeagueVault` Node Web Service in the Ohio region,
using one Starter instance. It tracks GitHub
`Tribowl-LLC/PGLeagueManagerApp` branch `main`. The exact dashboard commands are:

```text
Build: npm install --include=dev && npm run build
Pre-deploy: unset
Start: npm run start
Auto-deploy: Off (manual)
```

The repository does not contain a Render Blueprint or deployment workflow, so
the dashboard remains an external control. Before every release, verify that
the service inventory, branch, commands, instance count, and auto-deploy mode
still match the intended release configuration. Keep Auto-Deploy Off and manually
select the certified commit.

The production Render Web Service should use `/healthz` as its Health Check
Path. This is a database-free liveness endpoint, so Render's normal monitoring
does not keep Neon compute awake. `/api/health` remains the database-backed
readiness probe for operators and deployment verification. Operators must
still probe it explicitly during rollout and complete the commit,
authentication, workflow, provider, worker, and log checks below; Render's
health signal is one deployment gate, not proof that the release is complete.

### Schema-release hold

Keep Auto-Deploy Off throughout migration and verification. Record the exact
service, source SHA, migration result, and deployed SHA. Do not enable automatic
deployments or alter production payment execution settings as part of a release.

Production should explicitly set:

```text
APP_ENV=prod
NODE_ENV=production
APP_DOMAIN=leaguevault.app
```

Required application variables are `DATABASE_URL`, `SESSION_SECRET`, and
`FIELD_ENCRYPTION_KEY`. Configure them as literal environment-variable values
in Render. Do not create secret files unless the application is specifically
changed to read them.

Optional integrations include SendGrid, Sentry, and setup bootstrap.
Keep Square credentials in their intended environment and location; never copy
production credentials into a local or test environment.

For symbolicated browser errors, configure `SENTRY_AUTH_TOKEN` as a secret
available during the Render build. The Vite build uploads hidden source maps to
the `perfect-game/javascript-react` project and removes them before publishing
the deployment artifact. `SENTRY_ORG` and `SENTRY_PROJECT` may override those
slugs. Never name the upload token with a `VITE_` prefix. Both browser and
server events use `RENDER_GIT_COMMIT` as their release identifier.

## Read-only Schema Inventory

`npm run db:inventory` uses PostgreSQL catalog queries plus a narrowly scoped
read of the approved Drizzle migration-journal relation inside an explicit
repeatable-read, read-only transaction. It verifies both transaction settings
and does not apply schema changes. The approved transitional use is a
disposable Neon branch cloned from production, not the production endpoint
itself.

For a disposable branch:

1. Independently record and verify the Neon project, branch, endpoint host,
   database, and role. Keep this operator record separate from the inventory.
2. Use a pre-provisioned read-only or least-privilege role where practical.
   Do not use or copy the production application's credentials.
3. Supply the branch URL through `DATABASE_URL` in a secure operator shell.
   Never echo it or pass it as a command-line argument. Set the five
   independently verified `DB_INVENTORY_EXPECTED_*` values documented in
   [`DATABASE.md`](./DATABASE.md#disposable-neon-branch-inventory-procedure)
   in the same environment.
4. Run only the strict inventory command:

   ```bash
   npm run db:inventory -- --require-expected-target \
     --output .artifacts/db-inventory/neon/<review-id>.json
   ```

   The approved default journal is `drizzle.__drizzle_migrations`. If the
   separately verified branch uses another relation, pass it explicitly as
   `--journal-relation <schema.relation>`. Never select a relation merely to
   bypass the command's multiple-journal refusal.

5. The command refuses before connection if the URL-derived database, role, or
   endpoint fingerprint differs from the independent expectation or if the URL
   uses query parameters or PostgreSQL startup options to override its
   connection target or role. Percent-encoded hostnames are refused. When
   ambient `PGPORT` is set, the URL must name its port explicitly, and
   `PGOPTIONS` must be unset. The command refuses before catalog inventory if
   the server-reported database or role differs. Store the normalized JSON in
   the approved review-artifact system; do not commit it.
6. Do not run the application, a schema push, migrations, invariant installation,
   seeds, or backfills as part of inventory collection. Unset `DATABASE_URL`
   afterward.

See [`DATABASE.md`](./DATABASE.md#disposable-neon-branch-inventory-procedure)
for the complete comparison procedure. Direct production inventory remains a
separately approved future operation.

## Baseline adoption status

Production has completed the one-time guarded adoption of
`0000_normalized_baseline`. The adoption registered the already-verified
production schema in the Drizzle journal; it did not execute the baseline DDL
or change application data.

Do not run `db:adopt-baseline:preflight` or `db:adopt-baseline` against the
adopted production database. Do not replay `0000_normalized_baseline`. An
absent, empty, or mismatched production journal is now a target-identity or
schema-drift incident: stop and investigate rather than attempting adoption or
manual journal repair.

See [`DATABASE.md`](./DATABASE.md#baseline-adoption-history) for the retained
adoption evidence, exact status, and prohibited practices. Normal
production schema releases now use only the forward-only migration procedure
below.

## Schema Release

Schema changes require a deliberate release step:

The preferred executor is the manual **Production database migration** GitHub
Actions workflow. Dispatch it from `main` only after Exact main certification
succeeds. Enter the full certified SHA, the exact ordered pending migration
tags (or `none`), and the displayed confirmation phrase. Its `production`
environment requires operator approval, and the job uses the repository's
`NEON_API_KEY` secret to verify the pinned protected production target, create
an unprotected recovery branch without a compute or returned credentials,
acquire a direct connection string without printing it, and run the checked
migration with an exact-pending guard under the database advisory lock. Branch
protection prevents destructive branch operations but is not required for the
recovery branch to preserve the pre-migration database state. Before executing
SQL, the runner compares the live `public`
catalog—including tables, views, materialized views, and foreign tables—with
the checked-in fingerprint for the last applied migration. Fingerprinting,
migration SQL, journal registration, and post-journal verification share one
serializable transaction, so a failed migration cannot commit a partial
release. The approved legacy inert-RLS/function normalization remains narrowly
supported. After execution, the immediate `pending=none` rerun verifies the
fingerprint for the new state. CI reproduces both release-boundary fingerprints
from clean PostgreSQL 17 replays and proves table and non-table drift refusal. A
mismatch fails before migration SQL runs. Immediately before that transaction,
the workflow fetches and remotely rechecks `main` against the certified SHA.
The Neon API
key is exposed only to the three control-plane steps that require it, not to
checkout, dependency installation, or repository validation scripts. Preserve
the workflow summary's backup ID and migration evidence in the release record;
the recovery summary runs even after failure and instructs operators not to
deploy. Retain that unprotected recovery branch through release verification,
then delete it so temporary backups do not accumulate.

Every schema-release PR must add the checked-in fingerprint for its resulting
migration under `migrations/schema-fingerprints/`; retain the prior release
fingerprint because it is the pre-migration approval boundary. Do not hand-edit
fingerprint digests or accept an unexpected production mismatch.

If the workflow is unavailable, the manual operator procedure below remains
the fail-closed fallback. Never run both executors concurrently.

1. Create a current Neon backup or branch suitable for restoration.
2. Confirm the target Neon project, branch, host, database name, and user.
3. Set `DATABASE_URL` only in the shell or deployment environment where the
   intended target has been independently verified. Separately record the
   verified endpoint as `DB_MIGRATION_EXPECTED_HOST_FINGERPRINT` (the lowercase
   SHA-256 of `hostname:port`, prefixed with `sha256:`), database as
   `DB_MIGRATION_EXPECTED_DATABASE`, and role as
   `DB_MIGRATION_EXPECTED_ROLE`. Do not calculate these expected values from
   the `DATABASE_URL` that they are intended to check.
4. For the organization-hostname namespace migration, run
   `npm run db:audit:organization-hostnames` against the independently verified
   target. The command is read-only and returns a non-zero status for
   mixed-case identifiers or any slug/subdomain value owned by multiple
   organizations. Stop and obtain an explicit tenant rename/remediation
   decision for every reported row; never let migration precedence silently
   choose a hostname owner.
5. Confirm the exact checked-in migration SQL was reviewed and the adopted
   target has the exact active journal prefix. If the baseline row is absent or
   differs, stop: baseline adoption must never be repeated.
6. Set `DB_MIGRATION_EXPECTED_PENDING` to the exact ordered, comma-separated
   migration tags approved for this release, then run `npm run db:migrate`
   with exactly one executor for the environment. Keep all three independently
   recorded `DB_MIGRATION_EXPECTED_*` target values set. Never omit these
   guards on a production fallback. The runner verifies the URL endpoint before
   connecting and the server-reported database and role inside its locked
   inventory transaction. Abort on any target, fingerprint, journal,
   pending-list, or migration failure. After it succeeds, set
   `DB_MIGRATION_EXPECTED_PENDING=none` and rerun `npm run db:migrate`; it must
   verify the resulting fingerprint and report no pending migrations.
7. Apply the schema change to the intended database and record the result.
8. Deploy the matching CI-verified application commit.
9. Verify `/api/health`, login, the changed workflow, and relevant provider or
   webhook behavior.

`db:migrate` is not a substitute for a backup. Use expand–migrate–contract
releases and plan restoration before a destructive contract migration.
`db:push:disposable` accepts only the exact marked database in a running,
repository-tool-owned local Docker container after full-ID, label, loopback
port, auto-remove/anonymous-volume, database, role, and database-comment
verification. It pins the reviewed Drizzle config and gives the child only the
exact verified URL plus a minimal environment, with no inherited target/config
override. It has no remote-host allowlist or development bypass and is
prohibited for production, Neon, and every durable database.

## Post-Deployment Checks

- Confirm the Render deploy is running the exact certified commit.
- Request `/api/org-context` and confirm it reports `appEnv: "prod"` plus the
  short commit matching that Render deployment. A missing, unknown, or
  mismatched commit is a failed verification.
- Check `/api/health` and the Render boot logs.
- Confirm authentication and one representative affected workflow.
- Review Sentry and Render logs for new errors.
- Leave Square webhook subscriptions and execution modes unchanged unless
  separately authorized. Do not send live provider events as release smoke data.
- For signed webhook rejection diagnostics, review only aggregate counts by
  the fixed `stage`, `reason`, and allowlisted `eventType` fields documented in
  [`square-webhook-inbox.md`](./square-webhook-inbox.md). Do not export or
  search for raw bodies, payload hashes, provider identifiers,
  merchant/location values, amounts, signatures, or schema issue paths. A
  diagnostic-only deployment may be rolled back application-only while
  retaining all existing inbox, dispute, and operation evidence.
- Run the post-deploy trust-proxy workflow with its configured repository
  secrets: `DEPLOY_BASE_URL` and token-based `DEPLOY_PROBE_TOKEN` are preferred;
  `DEPLOY_ADMIN_COOKIE` is a legacy fallback. `DEPLOY_EXPECTED_RESOLVED_IP` is
  optional for environments with a known static egress IP.

An HTTP 401 from the trust-proxy probe normally means the probe token or legacy
admin cookie is expired or mismatched. A private or loopback resolved IP means
the proxy is not forwarding client IP information correctly, which can collapse
IP-based rate limits.

## Rollback

For an application-only regression, redeploy the previous known-good commit
from GitHub and verify the health endpoint and affected workflow.

For a schema regression, stop further deploys, preserve logs, and use the
prepared Neon backup or restore plan. Do not guess at a reverse migration; schema
changes and data restoration require an explicit review of the current database
state.
