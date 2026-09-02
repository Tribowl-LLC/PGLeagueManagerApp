# CI

This project's GitHub Actions setup separates pull-request merge-result
validation, exact-main certification, security scanning, and live-deployment
probing. The complete database-backed suite runs once before merge. A short
push workflow then certifies the exact `main` tree without repeating that suite.

## Workflow layout

| Workflow file | Job name | Triggers | What it runs |
|---|---|---|---|
| `ci.yml` | `Type check & lint` | Every PR to `main` | Dependency audits, `tsc`, `eslint .`, policy guards, and `npm run build` |
| `ci.yml` | `Database migrations (PostgreSQL 17)` | Every PR to `main` | Exact migration-byte checks (including a clean `core.autocrlf=true` clone), active-history replay, checked-in pre/post-release schema-state fingerprint reproduction and drift refusal, guarded local adoption, refusal/concurrency matrix, and isolated post-baseline ordering proof on PostgreSQL 17 |
| `ci.yml` | `Tests` | Every PR to `main` | `npm test` against a canonical template initialized by `db:migrate`, with exact template/worker journal-provenance assertions and application behavior on migrated worker databases |
| `race-suite.yml` | `Race suite` | Every PR to `main` | `npm run test:race` — alias for `bash scripts/test-race.sh` (the two `RUN_BOOTSTRAP_RACE_TESTS=1` race files, serially) |
| `exact-main-certification.yml` | `Exact main certification` | Every push to `main`, and `workflow_dispatch` | Exact checkout proof, successful PR-run provenance and tree-identity proof, migration bytes/metadata, and production build |
| `production-database-migration.yml` | `Migrate production database` | Manual `workflow_dispatch` on `main` only | Requires and revalidates the exact certified `main` SHA, verifies the protected Neon production target, creates a protected restorable branch, atomically verifies the complete public catalog against the checked-in pre-release fingerprint and applies only the explicitly expected migrations, verifies the post-release fingerprint plus an immediate no-op rerun, and records recovery evidence even on failure |
| `gitleaks.yml`, `hounddog.yml`, `semgrep.yml` | Security scan names | Every PR to `main`, weekly schedule, and `workflow_dispatch` | Diff-aware PR scans and recurring/manual full-history or full-tree scans |
| `post-deploy-trust-proxy.yml` | `Probe trust-proxy on live deploy` | Daily (cron) and on `workflow_dispatch` | `scripts/verify-trust-proxy-deploy.ts` against the live deploy (task #379) — see [Post-deploy trust-proxy probe](#post-deploy-trust-proxy-probe) below |

The jobs in `ci.yml` (`Type check & lint`, the PostgreSQL 17 database
migration check, and `Tests`) run in parallel, so total wall-clock for a PR is
roughly the slowest job — not the sum. The race suite is its own parallel
workflow because it needs a backgrounded dev server and serial execution.

> Job names (`Type check & lint`, `Tests`, the database-migration job,
> `Race suite`, and `Exact main certification`) are the
> values branch-protection rules will match against. **Don't rename
> them** without updating branch protection — append a step to an
> existing job instead.

## Dependency security

The repository uses GitHub Dependabot at no additional service cost:

- `.github/dependabot.yml` checks npm dependencies and GitHub Actions
  weekly. Dependabot security updates are enabled in the repository's
  **Settings → Advanced Security** page; the configuration file controls
  version-update pull requests.
- CI installs from the lockfile with `npm ci` and runs both audit scopes
  in the `Type check & lint` job:
  - `npm run security:audit:prod` runs
    `npm audit --omit=dev --audit-level=high`.
  - `npm run security:audit:all` runs
    `npm audit --audit-level=moderate`.
- Run those same scripts locally before opening a dependency pull request.
  Review the lockfile diff and the package's actual runtime/build role;
  do not use `npm audit fix --force` without reviewing its breaking-change
  impact.

## What runs in `Tests`

`npm test` invokes `vitest run`, which executes the six projects
declared in `vitest.config.ts`:

- **`parallel`** — the default project. Most files under
  `tests/api/`, `tests/unit/`, and `server/**/__tests__/` run here in
  parallel.
- **`serial-fk-bypass`** — files that briefly hold ACCESS EXCLUSIVE
  locks on shared tables (the orphan-data fixtures temporarily
  DROP/ADD foreign-key constraints to stage legacy parent-missing
  rows). Listed explicitly in `vitest.config.ts` and run in a single
  fork so they don't race each other or the parallel project.
- **`client-components`** — the React component tests under
  `tests/components/`. Run in jsdom; kept in their own project so the
  node-environment suites above don't pay the jsdom setup cost.
- **`parallel-isolated`** — tests whose module mocks require an isolated
  fork and a migrated worker database, without a spawned application.
- **`parallel-isolated-with-app`** — the small set that requires a fresh
  migrated worker database and Express process for each file.
- **`unit-no-db`** — pure unit tests that must not import database setup or
  require database/application secrets.

The two opt-in race files
(`tests/api/setup-admin-bootstrap-race.test.ts` and
`tests/api/payment-sync-retry-race.test.ts`) are gated behind
`RUN_BOOTSTRAP_RACE_TESTS=1`. They are NOT run by `npm test` and
therefore not by the `Tests` job — they are owned by the `Race suite`
workflow.

### Production build pinned by the `Type check & lint` job

The last step in `check-and-lint` is `npm run build` (task #468),
which runs the full Vite production bundle of the client and the
esbuild bundle of `server/index.ts` — i.e. exactly what `npm start`
will execute in production. Wiring this into CI catches two classes
of regression that the type checker, lint, and dev server all let
through:

- **Broken Vite production builds** — a missing static asset, a
  broken `@/`-aliased import that only resolves through Vite's
  dev-mode resolver, or any other Vite build-time failure. The dev
  server happily papers over these. Vite's "chunk > 500 kB" message
  is only a warning and does not fail this step; if hard chunk-size
  enforcement is ever wanted, it needs its own assertion on top of
  the build.
- **Broken server bundle** — `npm run dev` runs `tsx server/index.ts`
  via tsx's loader, which resolves TS-only imports and path aliases
  the production `node dist/index.js` cannot. A regression that
  works in dev but crashes at production boot fails this step
  instead of slipping through to deploy time.

The `dist/` output is intentionally not uploaded as an artifact —
the goal is a clean exit code as a gate, not to publish a build
downstream.

### Self-tests pinned by the `Tests` job

A handful of safety nets enforce themselves through vitest because
`package.json` (and therefore the `scripts:` section) is intentionally
locked in this environment. Wiring `npm test` into CI is what gives
those self-tests teeth on PRs:

- `tests/unit/check-eslint-baseline.test.ts` (#404) — runs the real
  `scripts/check-eslint-baseline.ts` script in `--strict` mode against
  the live codebase. Adding a new `@typescript-eslint/no-explicit-any`
  suppression and regenerating the baseline pushes the live count
  above the ceiling, the script exits 1, and this test fails.
- `tests/unit/check-csrf-coverage.test.ts` — pins the behavior of
  `scripts/check-csrf-coverage.ts` with synthetic fixtures so a
  regression to the CSRF coverage guard itself fails CI.
- `tests/unit/check-org-isolation-coverage.test.ts` — pins the
  behavior of `scripts/check-org-isolation-coverage.ts` the same way.
- `tests/unit/check-not-found-code.test.ts` — pins the behavior of
  `scripts/check-not-found-code.ts` so a regression in the 404
  error-code allow-list guard fails CI.
- `tests/unit/check-retired-payment-providers.test.ts` pins the
  source guard that prevents retired payment-provider references from
  returning under `client/src/`, `server/`, or `shared/`.
- `tests/unit/db-schema-inventory-tools.test.ts` — verifies deterministic
  comparison, missing/extra/changed categorization, journal selection and SQL
  preflight, quote-aware definition normalization, container ownership and
  cleanup behavior, inventory format validation, and connection-detail
  redaction. The disposable 29-versus-17 database reproduction remains the
  explicit local `npm run db:inventory:validate-local` command rather than a
  separate CI service job.
- `tests/unit/db-baseline-migration-tools.test.ts` — pins the active baseline
  hash/timestamp, versioned fingerprint counts/digest, physical-order/provider
  exclusions, owned-sequence count, isolated proof fixture, and adoption
  target/backup/confirmation/environment-class/identity/commit/baseline gates.
- `tests/unit/db-baseline-rls-compatibility.test.ts` proves the explicit
  baseline-verification-only equivalence for the exact all-table legacy inert
  RLS state and refusal of mixed RLS, FORCE RLS, policies/dependencies,
  ownership/BYPASSRLS failures, extra tables, and non-RLS drift.
- `tests/unit/db-migration-bytes.test.ts` verifies exact LF/UTF-8 SQL hashing,
  checkout attributes, checksum validation, and CRLF/invalid-UTF-8 refusal in
  copied temporary migration trees.
- `tests/unit/db-disposable-target.test.ts` proves `db:push:disposable` and
  local adoption require the exact owned Docker container, port, labels,
  auto-remove/anonymous-volume state, database marker, role, and unchanged
  execution URL; target/config overrides, remote targets, and generic
  development bypasses remain refused.
- `tests/unit/test-template-migration-source.test.ts` pins the canonical
  template hash inputs, excludes legacy history, and prevents a schema-push
  fallback from re-entering template construction.

## What runs in `Race suite`

The `race-suite.yml` workflow runs for every PR. It is intentionally
unconditional because exact-main certification requires a successful `Race
suite` result for the same PR head tree. The suite covers the shared
`lockedSweep` helper, payment-sync retry sweep, and admin-bootstrap critical
section. It does not run again on the resulting push to `main`.

## Exact-main certification

`exact-main-certification.yml` checks out `github.sha`, proves `HEAD` and the
clean worktree correspond to that SHA, and finds the pull request recorded by
GitHub as producing the main commit. `scripts/verify-exact-main-provenance.ts`
then requires the main commit tree to equal the merged PR head tree and requires
successful PR runs containing `Type check & lint`, `Tests`, the PostgreSQL 17
migration job, and `Race suite` for that head SHA. It prints the PR number,
tree SHA, and Actions run URLs as auditable evidence.

After provenance succeeds, the job re-checks exact LF/UTF-8 migration bytes and
metadata in the normal checkout and a clean `core.autocrlf=true` clone, then
builds the production application. It does not use application, database,
payment-provider, or deployment secrets.

See [`ci-duplication-audit.md`](./ci-duplication-audit.md) for the event matrix,
timing baseline, required ruleset transition, deployment gate, and rollback.

## Database

Both the `Tests` job and the `Race suite` job spin up an ephemeral
`postgres:17` service container, apply the active history with
`npm run db:migrate`, and then point `DATABASE_URL` at
`postgres://postgres:postgres@localhost:5432/<db>`. The container is
fresh on every run, so there is no shared state between PRs and the
deterministic CI-only `FIELD_ENCRYPTION_KEY` is never used to
decrypt real data.

For behavioral tests, `tests/setup/global-setup.ts` creates the canonical
template as an empty local database, applies the complete active history with
the checked migration runner, requires a second run to be a no-op, and verifies
the exact journal and approved fingerprint before installing the temporarily
retained invariants and test seed. Every physical worker clone verifies that exact journal again before
an application process can use it. CI captures the run and requires both
`[test-template-provenance] source=db:migrate` and
`[test-worker-provenance] source=migrated-template journal=exact`; a missing
provenance marker fails the job. There is no schema-push fallback. Remote Neon
template construction is disabled because a branch cannot prove an empty
from-zero replay. A failed rebuild cannot retain a valid cache token, and a
cache hit revalidates the journal and fingerprint. The canonical template supplies the fixtures the `Tests` job
needs, so CI has no separate `npm run seed` step.

The sibling `Database migrations (PostgreSQL 17)` job does not use service
credentials or Neon. `npm run db:check -- --postgres-version 17` owns and cleans an
ephemeral local Docker container, validates active Drizzle metadata and
exact SQL bytes, declared-schema drift and all 26 owned sequences, replays from
zero, adopts a matching populated fixture in one guarded transaction, tests
journal/concurrency/refusal paths, verifies a real-catalog legacy inert-RLS
fixture without adopting it, and proves post-baseline ordering.

## Required CI secrets

| Secret | Used by | Why |
|---|---|---|
| `SETUP_SECRET` | `Tests` (via `tests/api/setup-admin-header.test.ts`), `Race suite` (via `scripts/test-race.sh`) | The `/api/setup/*` endpoints check this header on every request. Without it, the affected suites either hard-fail (race suite, by design) or skip the relevant assertions (main suite). The race wrapper AND its test file BOTH hard-fail when it's missing — see `tests/README.md` → "CI wiring". |

Other env vars (`DATABASE_URL`, `SESSION_SECRET`,
`FIELD_ENCRYPTION_KEY`, `NODE_ENV`, `PORT`) are wired inline in the
workflow files and don't need to be configured as repository secrets.

The `Post-deploy trust-proxy probe` workflow uses its own dedicated
secrets (`DEPLOY_BASE_URL`, `DEPLOY_ADMIN_COOKIE`, optional
`DEPLOY_EXPECTED_RESOLVED_IP`) — see the section below.

## Post-deploy trust-proxy probe

`.github/workflows/post-deploy-trust-proxy.yml` runs
`scripts/verify-trust-proxy-deploy.ts` against the live deployed
app. Together with the boot guard in
`server/lib/trust-proxy-check.ts` (#326) and the CI lint in
`scripts/check-trust-proxy-coverage.ts` (#378), this is the third
leg of the trust-proxy verification story (#379) — the only one
that catches a config change at the reverse-proxy layer (managed hosting edge,
custom domain, future CDN) that silently re-introduces the bug
**without any code change**. When that happens, every per-IP rate
limiter — most importantly the 5 req / 15 min `setupAdminLimiter` —
collapses into a global ceiling for the entire internet, because
the proxy's loopback / private address becomes the keying address
for every request.

The script calls `GET /api/system-admin/trust-proxy-status` (a
system_admin-only debug endpoint) and asserts:

1. The synthetic boot probe still reports OK (no Express config
   drift since last boot).
2. The live `req.ip` is NOT a loopback / private address.
3. (Optional) The live `req.ip` exactly matches
   `DEPLOY_EXPECTED_RESOLVED_IP` if the runner has a known egress.

### Triggers

- **Schedule (`17 9 * * *`)** — daily at 09:17 UTC.
- **`workflow_dispatch`** — release operators trigger this manually
  immediately after a deploy.

### Required repository secrets

| Secret | What | How to refresh |
|---|---|---|
| `DEPLOY_BASE_URL` | Public origin of the deployed app, e.g. `https://app.example.com` (no trailing slash). | Update only when the production hostname changes. |
| `DEPLOY_ADMIN_COOKIE` | Full Cookie header value for a system_admin session, e.g. `connect.sid=s%3A…`. | Sessions expire after `cookie.maxAge` in `server/auth.ts` (default 24h). Use a long-lived service-account session, **not** a real human's cookie. Re-log in and update the secret when the workflow starts failing with HTTP 401. |
| `DEPLOY_EXPECTED_RESOLVED_IP` (optional) | Pin the exact public IP the runner is expected to appear as. | Skip on GitHub-hosted runners (rotating IP pool). Set when running on a self-hosted runner with a static egress IP. |

### What a failure means

- **`synthetic.ok=false`** — the deployed Express config has drifted
  from what the boot guard would accept. Something replaced the
  running process without rebooting through the entrypoint, or the
  trust-proxy setting was changed at runtime. Investigate the
  deploy timeline.
- **`live.resolvedIp` is loopback / private** — the proxy in front
  of the app is not honoring `X-Forwarded-For`. Per-IP rate limits
  are collapsing into a global cap. Check the proxy/CDN config.
- **`HTTP 401`** — the `DEPLOY_ADMIN_COOKIE` secret has expired.
  Refresh per the table above.

## Adding a new check

- A new **static check** (no DB, fast): append a step to the
  `check-and-lint` job in `ci.yml`. Don't rename the job.
- A new **vitest file** (parallel-safe, hits HTTP or DB through the
  shared globalSetup): no workflow change needed — `npm test` will
  pick it up automatically.
- A new **vitest file that mutates shared global state** (e.g.
  deletes the system_admin row): gate it behind a new
  `RUN_<NAME>_TESTS=1` env var and add it to `scripts/test-race.sh`.
- A new **integration test that needs a different service** (e.g. a
  Redis container): consider a third sibling job in `ci.yml` rather
  than expanding the existing service block, so failures stay
  localized and unrelated PRs don't pay the bring-up cost.

## Pinning third-party actions

Every third-party `uses:` reference in any workflow file under
`.github/workflows/` must be pinned to a full 40-character commit
SHA, with a trailing `# vX.Y.Z` comment for human readability:

```yaml
# Good:
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1

# Bad (floating tag — a compromised release in the v4 line is picked
# up automatically with no in-repo audit trail):
- uses: actions/checkout@v4
```

This is the well-known GitHub-published guidance for hardening
GitHub Actions against supply-chain attacks. A floating `@v4` tag
means whoever owns the upstream repo (or compromises a maintainer
account) can ship a new `v4.x.y` and have it silently execute
inside our build environment on the next CI run. A SHA pin makes
that impossible without a visible diff in our repo.

`.github/dependabot.yml` watches every workflow file under
`.github/workflows/` and opens a weekly grouped PR that bumps the
SHAs (and the trailing `# vX.Y.Z` comments) as new releases ship.
Reviewing that PR is the supply-chain audit step — read the upstream
release notes, then merge.

When adding a new workflow file:

1. Find the latest stable release SHA for each action you want to
   use. The simplest source is `git ls-remote --tags --refs
   https://github.com/<owner>/<repo>.git`, which prints `<sha>
   refs/tags/<tag>` lines you can grep.
2. Pin it as `uses: <owner>/<repo>@<sha> # <tag>`.
3. Confirm the new workflow's directory is already covered by the
   `github-actions` block in `.github/dependabot.yml` (the existing
   `directory: "/"` entry covers everything under
   `.github/workflows/`, so a new file there is covered
   automatically).

All action references in the merge-result and exact-main workflows are pinned
to full commit SHAs. Keep the same rule when touching the remaining workflows.

## See also

- `docs/lint.md` — the lint contract enforced by `check-and-lint`.
- `docs/security/csrf-coverage.md` — the CSRF coverage guard's
  contract and limitations.
- `docs/security/org-isolation-coverage.md` — the cross-org isolation
  guard's contract and limitations.
- `tests/README.md` — local test invocation, opt-in suites, and
  configurable env vars.
