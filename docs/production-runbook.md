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
5. Wait for `Type check & lint`, `Tests`, `Database migrations (PostgreSQL
   16)`, `Database migrations (PostgreSQL 17)`, and `Race suite`. The optimized
   release path requires all five to be configured as ruleset-required checks;
   until that settings transition is complete, treat the latter three as
   manually blocking. Also review Semgrep, Semgrep Cloud, Gitleaks, HoundDog,
   and dependency-audit results.
6. Merge the pull request into `main`.
7. Wait for `Exact main certification` on the merged `main` SHA. Confirm its
   log identifies the merged PR, identical tree SHA, and successful PR CI and
   Race suite runs.
8. Deploy that exact certified commit through Render. Render must be configured
   not to deploy a new `main` commit before this check succeeds; if the current
   service cannot express that gate, use manual deploy for the certified commit
   until an approved deploy-hook workflow is installed.
9. Run the post-deploy trust-proxy probe manually when a release changes
   proxy, cookie, auth, or rate-limit behavior. The scheduled workflow also
   probes the live deployment daily.

## Render Configuration

The repository does not contain a Render deployment workflow and GitHub's
deployment API currently records no deployment for the inspected main SHA.
Treat Render's dashboard configuration as an external control: record whether
auto-deploy is disabled or waits for `Exact main certification` before relying
on it. A plain deploy-on-push setting is not an acceptable certification gate.

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

## Baseline adoption: one provider-verified Neon rehearsal only

Production adoption has not been performed and remains unconditionally
disabled. In addition to the existing repository-tool-owned local Docker mode,
`db:adopt-baseline` accepts exactly one class of remote target:
`DB_ADOPTION_ENVIRONMENT_CLASS=neon-rehearsal` for an independently identified,
disposable, unprotected, non-default/non-primary child of the expected
production source branch. All other remote targets and every production-shaped
process or target are refused.

The verifier uses only bounded, retry-limited Neon API GETs for project, both
branches, and endpoint details. It requires the provider's `parent_id`,
`default`, `protected`, state/init-source, endpoint `project_id`, `branch_id`,
and `host` metadata to agree with independently supplied identifiers and the
PostgreSQL hostname. URL-derived identifiers are not independent evidence.
Missing or unexpected metadata, API/authentication/timeout failure, protected
or recovering targets, and any production/default/primary/endpoint mismatch
fail closed. Host matching normalizes only case and one terminal DNS dot; it
does not accept suffixes, wildcards, ports, or alternate hosts. Provider proof
is repeated immediately before the registration transaction so a paused
approval workflow cannot reuse stale metadata. Use a project-scoped
organization API key where available; the
tool does not need or issue write-capable Neon API requests and never requests
database credentials from Neon. The key is not retained in the database
adoption request or inherited by source-control child processes and is passed
only to the control-plane verifier.

Required Neon-specific variables are `NEON_API_KEY`,
`DB_ADOPTION_NEON_EXPECTED_PROJECT_ID`,
`DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID`,
`DB_ADOPTION_NEON_EXPECTED_PRODUCTION_BRANCH_ID`, and
`DB_ADOPTION_NEON_EXPECTED_ENDPOINT_ID`, in addition to every common adoption
identity, baseline, backup, commit, and confirmation variable documented in
[`DATABASE.md`](./DATABASE.md#guarded-existing-database-adoption). Provider bodies are
not persisted or logged; operator-visible failures redact credentials, URLs,
hostnames, and provider identifiers.

Follow the exact post-merge rehearsal procedure in `DATABASE.md`. Stop before
setting the confirmation unless the read-only inventory evidence and all
independent identifiers have been reviewed. This implementation PR performed
no live Neon rehearsal, no production connection, and no adoption. It does not
authorize production use; production enablement requires a separate reviewed
change.

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
