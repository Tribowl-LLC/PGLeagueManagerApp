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
5. Wait for the required branch-protection checks to pass. At minimum, verify
   `Type check & lint` and `Tests`; also review Race suite, Semgrep, Gitleaks,
   HoundDog, and dependency-audit results.
6. Merge the pull request into `main`.
7. Deploy the exact merged commit through Render according to the service's
   configured deployment mode.
8. Run the post-deploy trust-proxy probe manually when a release changes
   proxy, cookie, auth, or rate-limit behavior. The scheduled workflow also
   probes the live deployment every 30 minutes.

## Render Configuration

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

Optional integrations include SendGrid, Sentry, BowlNow, and setup bootstrap.
Clover webhook verification requires `CLOVER_WEBHOOK_SIGNING_SECRET` when
Clover webhooks are enabled. Keep payment-provider credentials in their
intended environment and location; never copy production credentials into a
beta or local environment.

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

## Disposable baseline-adoption rehearsal

Production adoption has not been performed and is disabled in this pull
request. Before any future production-enablement change, rehearse on an
independently verified disposable Neon branch cloned from production:

1. Record the project, source branch, disposable branch, endpoint fingerprint,
   database, and role outside the repository.
2. Create a current restorable branch/backup and prove the restore procedure.
3. Use a clean checkout of the exact CI-verified commit. Supply every
   `DB_ADOPTION_*` expectation documented in [`DATABASE.md`](./DATABASE.md),
   with environment class `neon-rehearsal`. Set the runtime target identity
   from trusted Neon/operator context, independently supply the matching
   expected target identity, and name the distinct source branch identity; do
   not expose values in arguments or logs.
4. Capture a before fingerprint, run `npm run db:adopt-baseline`, capture an
   after fingerprint, and confirm only the exact baseline journal record was
   inserted. Baseline DDL must not execute.
5. Rerun adoption and require a safe no-op. Run `npm run db:migrate` and require
   a no-op until a reviewed post-baseline migration exists.
6. Retain target, backup/restore, before/after inventory, exact commit, baseline
   hash/timestamp, command output, and reviewer approval as the production
   enablement evidence.

The current command rejects production-shaped process/environment identity,
target/expectation mismatch, and a rehearsal target equal to its source.
Do not weaken or bypass that gate during rehearsal.

## Schema Release

Schema changes require a deliberate release step:

1. Create a current Neon backup or branch suitable for restoration.
2. Confirm the target Neon project, branch, host, database name, and user.
3. Set `DATABASE_URL` only in the shell or deployment environment where the
   intended target has been independently verified.
4. Confirm the exact checked-in migration SQL was reviewed and the target has
   the exact active journal prefix. Existing production is not yet adopted;
   stop until a separate operator-only production-enablement change is
   approved.
5. Run `npm run db:migrate` with exactly one executor for the environment.
   Abort on any journal mismatch or migration failure.
6. Apply the schema change to the intended database and record the result.
7. Deploy the matching CI-verified application commit.
8. Verify `/api/health`, login, the changed workflow, and relevant provider or
   webhook behavior.

`db:migrate` is not a substitute for a backup. Use expand–migrate–contract
releases and plan restoration before a destructive contract migration.
`db:push:disposable` is prohibited for production and durable Neon branches.

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
