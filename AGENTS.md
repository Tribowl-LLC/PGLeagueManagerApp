# LeagueVault

LeagueVault is a multi-tenant bowling league management application for adult
leagues. It manages leagues, teams, bowlers, schedules, payments, refunds,
registration, and organization administration.

This file contains durable instructions for Codex and contributors. Detailed
architecture explanations and operational runbooks belong in `docs/`.

## Technology

The primary application stack is:

- TypeScript
- React
- Vite
- Express
- PostgreSQL
- Drizzle ORM
- TanStack Query
- Tailwind CSS
- shadcn/ui
- Vitest
- Render
- Neon PostgreSQL
- Capacitor for native iOS and Android targets

Use the package manager indicated by the committed lockfile. This repository
uses npm. Do not introduce Yarn, pnpm, or an additional lockfile.

## Production And Source Of Truth

- Render hosts the production web application.
- Neon PostgreSQL is the production database.
- `leaguevault.app` is the production domain. Organization subdomains use the
  same base domain.
- GitHub `main` is the source of truth and is protected.
- Normal work starts from the latest `origin/main` on one short-lived branch
  and reaches `main` through one pull request.
- Use descriptive branch names such as:
  - `codex/fix-payment-timezone`
  - `codex/feat-partner-dashboard`
  - `codex/chore-schema-deployment-check`
  - `codex/docs-production-runbook`
- Do not reuse a merged branch for new work.
- Do not combine unrelated changes in one branch or pull request.
- Do not push normal work directly to `main`.
- Do not merge pull requests unless explicitly instructed.
- After a pull request is merged, its remote branch should be deleted.
- Never force-push `main` or rewrite published history unless explicitly
  instructed.
- Deploy the exact `main` commit that passed the required checks. Do not deploy
  a different local commit or an unverified branch.
- Keep production secrets in the appropriate provider: Render, Neon, Square,
  SendGrid, Sentry, or GitHub Actions secrets.
- Never put production credentials in Codex prompts, source files, commits,
  logs, screenshots, test fixtures, or test output.

See `docs/ci.md` and `docs/production-runbook.md` for operational details.

## Task Startup

Before editing:

1. Inspect `git status`, the current branch, and the active worktree.
2. Preserve uncommitted user work. Do not reset, clean, stash, overwrite, or
   discard it without explicit approval.
3. Fetch the latest `origin/main` before starting a new feature or bug-fix
   branch.
4. Read `.local/known-failures.md` when it exists. It is an advisory snapshot
   of the most recent manually captured checks, not a reason to ignore new
   failures.
5. Inspect the relevant implementation, tests, schemas, and documentation.
6. Identify the smallest safe change that satisfies the requested outcome.
7. State the expected files, validation plan, and material risks before making
   a broad or high-risk change.
8. Keep adjacent cleanup outside the task unless it is required for
   correctness.

For a dirty worktree or an existing pull-request branch, inspect and work with
the existing state instead of switching branches blindly.

Do not create a branch merely to investigate a question. Exploratory analysis
may remain in a detached or disposable worktree until there is a validated
change worth preserving.

## Scope Discipline

Prefer the smallest behavior-preserving change that solves the task.

Do not:

- replace working architecture merely because another approach is preferred
- perform speculative refactors
- upgrade major dependencies without explicit approval
- reformat unrelated files
- rename unrelated symbols
- create duplicate routes, services, schemas, components, hooks, utilities, or
  date helpers
- modify unrelated tests solely to make the requested change easier
- silently expand the task to fix pre-existing issues
- introduce a new abstraction unless it removes verified duplication or is
  necessary for correctness

When a broader change is genuinely required, explain why the narrower approach
is unsafe or insufficient.

## Verification

Use Node.js 22.22 or newer within the 22.x line, as specified by
`.node-version` and the package engine. Docker Desktop must be running for the
database-backed suite.

The normal local validation sequence is:

```bash
npm ci
npm run db:check
npm run test:local
npm run check
npm run lint
npm run build
npm run security:audit:prod
npm run security:audit:all
```

Run every applicable command before reporting a task complete. If a command is
unavailable, inappropriate for the task, or blocked by the environment, report
that explicitly. Do not silently skip validation.

`npm run test:local` starts or reuses the local
`leaguevault-test-postgres` PostgreSQL 17 Docker container, applies the schema,
configures UTC and deterministic local-only secrets, prepares the test
template, and runs the complete Vitest suite with isolated worker databases.
No manually exported `DATABASE_URL` or development server is required.

Set `TEST_LOCAL_START_DEV_SERVER=1` only when the full test run also needs a
development server on port 5000.

Run focused Vitest files locally for fast iteration, then run
`npm run test:local` before handing off a database-backed change.

`npm test` remains the underlying raw Vitest command, but it does not provide
the Docker, schema, timezone, or deterministic environment setup supplied by
`npm run test:local`.

GitHub CI runs the complete test suite, database-backed tests, race suite, and
security workflows.

The main CI checks are:

- `Type check & lint`
- `Tests`

`Race suite`, Semgrep, Gitleaks, HoundDog, and the post-deploy trust-proxy
probe are separate quality or operational checks. Confirm the current
branch-protection settings in GitHub before treating a check as merge-blocking.

When a check fails:

1. Read the actual failure log.
2. Determine whether it is:
   - a new code failure
   - a pre-existing failure
   - an infrastructure or environment failure
3. Fix new failures caused by the task.
4. Record pre-existing failures clearly.
5. Do not fix unrelated old failures without approval to expand the task.
6. Never weaken production safeguards merely to make a check pass.

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
- `FIELD_ENCRYPTION_KEY` containing exactly 64 hexadecimal characters

Optional application integrations include:

- `SENDGRID_API_KEY`
- `SENTRY_DSN`
- `SETUP_SECRET`

Payment-provider credentials may be location-specific and are not
interchangeable between environments.

Operational variables and secrets used by specific workflows include:

- `TRUST_PROXY_PROBE_TOKEN` on the deployed application for token-based
  trust-proxy verification
- `DEPLOY_BASE_URL` and `DEPLOY_PROBE_TOKEN` as GitHub repository secrets for
  the post-deploy probe
- `DEPLOY_ADMIN_COOKIE` as a legacy probe fallback; it must not be a human
  operator's long-lived credential

Render expects literal environment-variable values. The application does not
expect Render secret files.

Environment files containing real credentials must not be committed. Maintain
placeholder-only documentation in `.env.example` where applicable.

Never expose server-only secrets through Vite client environment variables or
browser-delivered code.

## Database And Schema Safety

- PostgreSQL is the production database.
- Drizzle and the definitions under `shared/schema/` are the schema authority.
- Modify database definitions in `shared/schema/`.
- Create deliberate schema changes with `npm run db:generate -- --name
  <description>`, review the SQL and metadata under `migrations/`, and apply
  checked-in migrations with `npm run db:migrate`.
- `migrations/` is the only active forward-only history.
  `migrations-legacy-do-not-replay/` is evidence only and must never be
  replayed or generated into.
- Do not manually alter an already-applied production migration.
- Do not edit migration history to disguise a later schema change.
- Do not run destructive production database commands.
- Do not drop or rename production tables, columns, constraints, or indexes
  without explicit approval and a reviewed migration plan.
- Application startup must not silently mutate the production schema unless
  that behavior is explicitly documented and approved.
- Before a production schema release, back up the intended Neon database.
- Existing databases must never infer baseline adoption from an absent or
  empty journal. Use the explicit fingerprint-, backup-, target-, commit-, and
  confirmation-gated adoption workflow documented in `docs/DATABASE.md`.
- `db:push` is retained only as `db:push:disposable`; never use it for a
  durable shared environment.
- Review every generated migration statement before commit and deployment.
- Abort unexpected table, column, constraint, or data-loss changes.
- Identify migration order, deployment order, compatibility concerns, and
  rollback implications in the pull request.
- Deploy the matching CI-verified commit only after the schema change is
  applied successfully.
- Verify `/api/health`, `/api/org-context` (`appEnv: "prod"` plus the matching
  short commit), authentication, tenant isolation, and the affected workflow
  after deployment.
- Keep a tested restore plan for the backup.

See `docs/production-runbook.md` and `docs/TEST_INFRA.md`.

## Multi-Tenancy And Authorization

Tenant isolation is a security boundary, not merely a filtering convention.

- Organization and resource access must remain tenant-scoped.
- Every tenant-owned query must be scoped using server-authorized organization
  context.
- Never trust a client-provided organization, league, location, team, bowler,
  payment, or resource identifier without server-side authorization.
- Org-less rows are data-integrity failures and must not be treated as globally
  accessible.
- Do not weaken authorization checks to simplify UI behavior or make a test
  pass.
- Add or update tenant-isolation tests for changes that read, create, update,
  refund, transfer, or delete tenant-owned resources.
- System-administrator privileges must remain explicit and narrowly scoped.
- Authorization failures should fail closed.

## Architecture Invariants

- The product supports adult leagues only.
- Youth, minor, and guardian league functionality is retired.
- Permanent organization deletion is system-admin-only and runs as one atomic
  database transaction.
- Platform system-administrator accounts are preserved and detached from the
  deleted organization.
- Organization teardown deletes app-owned tenant data and organization audit
  data.
- Organization teardown does not delete remote Square customer objects.
- Square payment behavior is business-critical.
- Do not change provider SDK usage, credentials, payment amounts, refund
  behavior, idempotency behavior, or webhook behavior without focused tests
  and review of the provider contract.
- Capacitor and the `ios/` and `android/` projects are intentional native
  application targets, not dead web code.

## Dates And Time Zones

- Store database timestamps as UTC.
- Perform league-day, payment-day, report, and business-day calculations using
  the configured business or organization time zone.
- Do not implement time-zone behavior using fixed UTC offsets.
- Account for daylight saving time.
- Do not assume that `America/Detroit` always has the same UTC offset.
- Reuse established project date and time utilities.
- Do not create competing date helpers when an existing utility can be safely
  extended.
- Clearly distinguish timestamps, calendar dates, and business-local dates.
- Add boundary tests for midnight, daylight-saving transitions, and date-range
  filters when relevant.

## API Behavior

- Preserve existing API compatibility unless the task explicitly changes the
  contract.
- Validate request parameters, query strings, headers, and payloads at trust
  boundaries.
- Use shared schemas and types where established.
- Return deliberate HTTP status codes.
- Preserve authentication, authorization, tenant scoping, CSRF protection,
  rate limiting, and idempotency safeguards.
- Do not expose stack traces, SQL details, internal provider responses,
  credentials, or sensitive operational details to clients.
- Maintain consistent error-response conventions.
- Update relevant route, service, storage, and integration tests when API
  behavior changes.
- Avoid duplicate API routes or alternate implementations of existing
  behavior.

## Frontend Behavior

- Reuse existing components, hooks, query keys, layouts, and design patterns.
- Use TanStack Query consistently for server state.
- Do not introduce unnecessary global state.
- Preserve loading, empty, success, validation, and error states.
- Preserve accessibility behavior, keyboard interaction, labels, focus
  management, and semantic HTML.
- Do not suppress actionable errors merely to make the interface appear
  successful.
- Keep client-side authorization assumptions subordinate to server-side
  authorization.
- Avoid duplicating server-derived business rules in the client when the
  server can remain authoritative.
- Verify responsive behavior for affected screens.
- Treat payment and refund confirmation flows as high-risk user interactions.

## Security And Privacy

- Keep security and payment error handling fail-closed.
- Do not weaken CSRF protection, tenant isolation, rate limits,
  authentication, authorization, field encryption, webhook verification, or
  trust-proxy validation to make a test pass.
- Never log passwords, tokens, API keys, payment credentials, session
  identifiers, raw authorization headers, full webhook secrets, raw provider
  response bodies, or unnecessary personal information.
- Use redaction for identifiers or payloads that must appear in operational
  logs.
- Never commit secrets, production URLs containing credentials, private keys,
  copied database records, or real customer data.
- Use deterministic fake data in tests.
- Flag authentication, authorization, payment, encryption, webhook, and
  production-configuration changes as security-sensitive in the completion
  report.

## Repository Map

- `client/src/`: React frontend, pages, components, hooks, and query clients
- `server/`: Express application, routes, services, authentication, and storage
- `shared/schema/`: Drizzle schema, shared validation, and API types
- `scripts/`: database, verification, security, and maintenance scripts
- `docs/ci.md`: CI workflow layout and required repository secrets
- `docs/production-runbook.md`: Render and Neon release procedure
- `docs/engineering-context.md`: longer architecture notes and durable
  decisions

## Code And Review Practices

- Prefer readable, explicit code over clever compression.
- Follow existing naming, module, error-handling, and testing conventions.
- Preserve strict TypeScript behavior.
- Do not introduce `any`, unsafe casts, non-null assertions, or ignored
  promises without a documented reason.
- Do not chase React Doctor scores mechanically.
- Treat React Doctor warnings as review prompts, especially around payment SDK
  effects, state synchronization, and shadcn compound components.
- Do not add ESLint suppressions or increase a baseline ceiling silently.
- Follow `eslint-suppressions.json`,
  `scripts/check-eslint-baseline.ts`, and `BASELINE_BUMP_REASON.md`.
- Add comments only where they explain a non-obvious constraint, invariant, or
  external-system requirement.
- Remove obsolete code only when its lack of use is verified.
- Update tests when behavior changes.
- Do not rewrite stable code solely for stylistic preference.

## Completion Report

Before handing off a task, report:

1. A concise summary of what changed
2. The root cause or architectural reason for the change, when applicable
3. Files changed
4. Tests and validation commands run
5. Results of each validation command
6. Any checks that failed, were skipped, or were unavailable
7. Database and migration implications
8. Deployment and environment-variable implications
9. Security, tenant-isolation, payment, or provider implications
10. Manual verification steps
11. Remaining risks, assumptions, or follow-up work
12. The branch and pull-request status

Do not report a task complete while known task-related failures remain
unresolved. Do not claim that tests passed unless the commands were actually
run successfully.
