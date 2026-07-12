# LeagueVault

LeagueVault is a multi-tenant bowling league management application for adult
leagues. It manages leagues, teams, bowlers, schedules, payments, refunds,
registration, and organization administration.

This file contains durable instructions for Codex and contributors. Detailed
runbooks belong in `docs/`.

## Production And Source Of Truth

- Render hosts the production web application.
- Neon PostgreSQL is the production database.
- `leaguevault.app` is the production domain. Organization subdomains use the
  same base domain.
- GitHub `main` is the source of truth and is protected.
- Normal work starts on a `codex/<short-description>` branch and reaches
  `main` through a pull request. Do not push normal work directly to `main`.
- Deploy the exact `main` commit that passed the required checks. Do not deploy
  a different local commit or an unverified branch.
- Keep production secrets in the appropriate provider: Render, Neon, Square,
  Clover, SendGrid, Sentry, or GitHub Actions secrets. Never put production
  credentials in Codex prompts, source files, commits, or test output.

See `docs/ci.md` and `docs/production-runbook.md` for operational details.

## Task Startup

1. Inspect `git status` and the current branch before editing.
2. Preserve uncommitted user work; do not reset, clean, or overwrite it.
3. Fetch the latest `origin/main` before starting a new feature or bug-fix
   branch.
4. Read `.local/known-failures.md` when it exists. It is an advisory snapshot
   of the most recent post-merge checks, not a reason to ignore new failures.
5. Confirm the requested scope before changing adjacent code.

For a dirty worktree or an existing PR branch, inspect and work with the
existing state instead of switching branches blindly.

## Verification

Use Node.js 22.22 or newer within the 22.x line, as specified by
`.node-version` and the package engine. Docker Desktop must be running for the
database-backed suite. The normal local sequence is:

```bash
npm ci
npm run test:local
npm run check
npm run lint
npm run build
npm run security:audit:prod
npm run security:audit:all
```

`npm run test:local` starts or reuses the local `leaguevault-test-postgres`
PostgreSQL 16 Docker container, applies the schema, configures UTC and
deterministic local-only secrets, prepares the test template, and runs the
complete Vitest suite with isolated worker databases. No manually exported
`DATABASE_URL` or dev server is required. Set `TEST_LOCAL_START_DEV_SERVER=1`
only when the full test run also needs a dev server on port 5000.

Run focused Vitest files locally for fast iteration, then run
`npm run test:local` before handing off a database-backed change. `npm test`
remains the underlying raw Vitest command, but it does not provide the Docker,
schema, timezone, or deterministic environment setup supplied by
`npm run test:local`. GitHub CI still runs the complete test suite, database
backed tests, race suite, and security workflows.

The main CI checks are `Type check & lint` and `Tests`. `Race suite`, Semgrep,
Gitleaks, HoundDog, and the post-deploy trust-proxy probe are separate quality
or operational checks. Confirm the current branch-protection settings in
GitHub before treating a check as merge-blocking.

When a check fails, read its actual log and classify it as a new code failure,
a pre-existing failure, or infrastructure/environment failure. Fix new
failures. Record pre-existing failures and only fix unrelated old failures
when the user approves expanding the task scope.

## Environment

Render production should explicitly use:

```text
APP_ENV=prod
NODE_ENV=production
APP_DOMAIN=leaguevault.app
```

Required application variables:

- `DATABASE_URL`
- `SESSION_SECRET`
- `FIELD_ENCRYPTION_KEY` (64 hexadecimal characters)

Optional application integrations include `SENDGRID_API_KEY`, `SENTRY_DSN`,
`BN_API_KEY`, and `SETUP_SECRET`. Payment-provider credentials may be
location-specific and are not interchangeable between environments.

Operational variables and secrets used by specific workflows include:

- `CLOVER_WEBHOOK_SIGNING_SECRET` for production Clover webhook verification.
- `TRUST_PROXY_PROBE_TOKEN` on the deployed app for token-based trust-proxy
  verification.
- `DEPLOY_BASE_URL` and `DEPLOY_PROBE_TOKEN` as GitHub repository secrets for
  the post-deploy probe.
- `DEPLOY_ADMIN_COOKIE` is a legacy probe fallback and should not be a human
  operator's long-lived credential.

Render expects literal environment-variable values. The application does not
expect Render secret files.

## Database And Schema Safety

- Modify database definitions in `shared/schema/`.
- Before a production schema release, back up the intended Neon database.
- Verify the Neon project, branch, host, database, and `DATABASE_URL` before
  running `npm run db:push`.
- Review every destructive statement shown by Drizzle. Abort unexpected table,
  column, or data-loss changes.
- Deploy the matching CI-verified commit only after the schema change is
  applied successfully.
- Verify `/api/health`, authentication, and the affected workflow after
  deployment. Keep a restore plan for the backup.

See `docs/production-runbook.md` and `docs/TEST_INFRA.md`.

## Architecture Invariants

- The product supports adult leagues only. Youth, minor, and guardian league
  functionality is retired.
- Organization and resource access must remain tenant-scoped. Org-less rows
  are data-integrity failures and must not be treated as globally accessible.
- Permanent organization deletion is system-admin-only and runs as one atomic
  database transaction. Platform system-admin accounts are preserved and
  detached from the deleted organization.
- Organization teardown deletes app-owned tenant data and organization audit
  data. It does not delete remote Square or Clover customer objects.
- Square and Clover payment behavior is business-critical. Do not change
  provider SDK usage, credentials, payment amounts, or webhook behavior
  without focused tests and a review of the provider contract.
- Capacitor and the `ios/` and `android/` projects are intentional native
  application targets, not dead web code.

## Repository Map

- `client/src/`: React frontend, pages, components, hooks, and query clients.
- `server/`: Express application, routes, services, authentication, and
  storage.
- `shared/schema/`: Drizzle schema, shared validation, and API types.
- `scripts/`: database, verification, security, and maintenance scripts.
- `docs/ci.md`: CI workflow layout and required repository secrets.
- `docs/production-runbook.md`: Render and Neon release procedure.
- `docs/engineering-context.md`: longer architecture notes and durable
  decisions.
- `docs/replit-handoff.md`: historical Replit beta and handoff information;
  it is not the production deployment process.

## Code And Review Practices

- Prefer the smallest behavior-preserving change that solves the task.
- Do not chase React Doctor scores mechanically. Treat warnings as review
  prompts, especially around payment SDK effects, state synchronization, and
  shadcn compound components.
- Do not add ESLint suppressions or increase a baseline ceiling silently.
  Follow `eslint-suppressions.json`, `scripts/check-eslint-baseline.ts`, and
  `BASELINE_BUMP_REASON.md`.
- Keep security and payment error handling fail-closed. Do not weaken CSRF,
  tenant isolation, rate limits, authentication, or webhook verification to
  make a test pass.
- Do not log passwords, tokens, payment credentials, session identifiers, raw
  response bodies, or unnecessary personal information.
