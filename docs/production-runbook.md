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

## Schema Release

Schema changes require a deliberate release step:

1. Create a current Neon backup or branch suitable for restoration.
2. Confirm the target Neon project, branch, host, database name, and user.
3. Set `DATABASE_URL` only in the shell or deployment environment where the
   intended target has been independently verified.
4. Run `npm run db:push`.
5. Read every proposed statement. Abort if Drizzle proposes an unexpected
   table, column, constraint, or data-loss operation.
6. Apply the schema change to the intended database and record the result.
7. Deploy the matching CI-verified application commit.
8. Verify `/api/health`, login, the changed workflow, and relevant provider or
   webhook behavior.

`db:push` is not a substitute for a backup. A destructive schema change may
require restoring the database or manually reconstructing data; plan that
before confirming a destructive prompt.

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
prepared Neon backup or restore plan. Do not guess at a reverse `db:push`; schema
changes and data restoration require an explicit review of the current database
state.
