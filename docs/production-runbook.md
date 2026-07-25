# Production Runbook

Production is hosted on Render and uses Neon PostgreSQL. GitHub `main` is the
release source. This document covers the safe release path; it does not store
credentials.

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
6. If the release contains a schema migration, follow the
   [schema-release auto-deploy hold](#schema-release-auto-deploy-hold) to switch
   the Render service from `After CI Checks Pass` to `Off` **before** merging.
   This holds the application rollout until the reviewed production migration
   has run. Code-only releases keep the normal auto-deploy setting.
7. Merge the pull request into `main`.
8. Wait for `Exact main certification` on the merged `main` SHA. Confirm its
   log identifies the merged PR, identical tree SHA, and successful PR CI and
   Race suite runs.
9. If the commit contains schema changes, follow [Schema Release](#schema-release)
   through the reviewed migration step before deploying the application. If it
   contains no schema changes, do not run a migration merely as a deployment
   ritual.
10. For a code-only release, confirm Render automatically selects that exact
    commit after GitHub checks pass. For a schema release, manually deploy that
    exact commit after migration succeeds, then complete the runbook's verified
    restoration procedure. Never allow Render to deploy a schema-dependent
    revision before its migration.
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
Auto-deploy: After CI Checks Pass
```

The repository does not contain a Render Blueprint or deployment workflow, so
the dashboard remains an external control. Before every release, verify that
the service inventory, branch, commands, instance count, and auto-deploy mode
still match this section. `After CI Checks Pass` must include successful Exact
main certification for the selected SHA. If that cannot be proved, switch to a
manual deploy of the certified commit.

The production Render Web Service is configured with `/api/health` as its
Health Check Path. Render uses this endpoint during deployment rollouts and
normal service monitoring. Operators must still probe it explicitly during
rollout and complete the commit, authentication, workflow, provider, worker,
and log checks below; Render's health signal is one deployment gate, not proof
that the release is complete.

### Schema-release auto-deploy hold

Schema releases require an explicit Render hold so application code cannot
deploy before its reviewed migration:

1. Before merging the schema pull request, open the production `LeagueVault`
   Web Service in Render and go to **Settings → Deploy → Auto-Deploy**.
2. Change Auto-Deploy from `After CI Checks Pass` to `Off`. Return to the
   service settings and verify that `Off` is displayed; opening the edit control
   is not evidence that the change persisted.
3. Record the Render service, release pull request, intended commit, operator,
   and time in the release record. Assign one operator responsibility for both
   the hold and its eventual restoration.
4. Merge, wait for Exact main certification, execute the reviewed migration,
   and manually deploy the exact certified commit using the procedures below.
5. Complete health, commit, authentication, workflow, provider, worker, and log
   verification while Auto-Deploy remains `Off`.
6. Only after every applicable check passes, restore Auto-Deploy to
   `After CI Checks Pass`. Re-open the setting and verify the displayed value,
   then record restoration in the release record.

If the release is stopped, fails, rolls back, or is handed to another operator,
leave Auto-Deploy `Off`. Record the hold as active and require the receiving
operator to reassess schema/application compatibility before restoring it.
Never restore Auto-Deploy merely because the migration command exited or the
new process started.

Manual toggling is the current control because the repository has no Render
Blueprint or API-driven release workflow. A future automation change should
encode the same hold, exact-commit, migration, verification, and restoration
state machine and must fail closed without silently restoring Auto-Deploy.

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
Keep Square credentials in their
intended environment and location; never copy production credentials into a
beta or local environment.

### Retired payment-provider schema cleanup

Migration `0003_remove_clover_integration.sql` removes the unused provider
selector and Clover-only credential, customer, and charge-reference columns.
Before applying it:

1. Create and verify a Neon backup for the target database.
2. Run the normal migration preflight against the exact target and reviewed
   commit.
3. Confirm the migration's fail-closed checks find no Clover payments, charge
   references, customer references, non-Square locations, or active schedules
   attached to a Clover-selected location. Any exception aborts the migration;
   investigate rather than deleting or rewriting the unexpected data.
4. Deploy the Square-only application while the legacy columns still exist,
   verify health/authentication/tenant isolation and a Square charge/refund,
   then apply the migration from the same CI-verified release. The new code is
   compatible with the extra legacy columns; the old code is not compatible
   after they are dropped.
5. Remove `CLOVER_WEBHOOK_SIGNING_SECRET` from Render and any CI secret stores
   only after the Square-only release is healthy. No Clover remote cleanup or
   historical-data conversion is expected because the integration was never
   rolled out to customers.

Rollback before the migration is an application rollback. After the migration,
restore the verified Neon backup before rolling back to code that still expects
the removed columns.

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

1. Create a current Neon backup or branch suitable for restoration.
2. Confirm the target Neon project, branch, host, database name, and user.
3. Set `DATABASE_URL` only in the shell or deployment environment where the
   intended target has been independently verified.
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
6. Run `npm run db:migrate` with exactly one executor for the environment.
   Abort on any journal mismatch or migration failure.
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

- Confirm the Render deploy is running the expected commit.
- Check `/api/health` and the Render boot logs.
- Confirm authentication and one representative affected workflow.
- Review Sentry and Render logs for new errors.
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
