# Production Runbook

## Current PR3 release boundary

PR3 is the current payment steady state. The only active provider-operation
types are `interactive_charge`, `standing_autopay_charge`, and `refund`.
Interactive and standing execution use roster snapshots/items; payment
schedules, setup requests, generic interactive snapshots, scheduled snapshots,
and canonical-autopay operations are retired and are not deployment or
rollback targets. Follow [phase-pr3-canonical-steady-state](phase-pr3-canonical-steady-state.md)
for migration 0034's backup, maintenance pause, journal/checksum, migration-
before-application, and destructive data-reset gates.

The older phase-specific instructions below are historical release notes where
they mention those retired authorities. Do not use their old migration,
operation-type, scheduler, or activation instructions for the current app.

Current payment-operation releases use the PR3 ledger contract. Production must
set `SCHEDULED_PAYMENT_EXECUTION_MODE` explicitly; a missing value fails
startup. The only accepted values are `ledger_paused` and `ledger_execute`.
Keep `ledger_paused` during release and verification; use `ledger_execute` only
after the separately approved automatic-payment gate. Render Auto-Deploy must
remain Off for this release.

F1 canonical due/past-due is a separate dormant gate. Keep
`LEAGUEVAULT_F1_ACTIVATION_ENABLED` unset or false in every production
environment. Do not enable it until the product owner has approved activation
of individual leagues. Migration 0024 may be installed while activation
remains dormant; production D2 activation rows must remain zero until that
approval.

F3 canonical auto-pay plans are a separately gated, setup-only release. Keep
`LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED` unset or false by default. Migration
0026 is additive and must be applied before any reviewed gate enablement; do
not backfill v1 schedules or create production policy/authorization rows during
deployment. Policy candidate/create/approve, preauthorization quote,
persisted-plan read, and D2 persistence are provider-free. Payer authorization
performs exactly one read-only payer-owned card/customer/location ownership
lookup outside the database transaction. F3 performs no provider mutation,
charge, setup, refund, or scheduled execution; F4 scheduled execution is not
part of this release. Ready plans reserve exact
obligation balances, so verify F2 manual quotes reject reserved capacity.
After v2 evidence exists, rollback is a forward fix or traffic pause only;
retain migration 0026 and its evidence.

The former F4 scheduled-execution design is superseded by PR3 and is not an
active release target. Keep
`LEAGUEVAULT_F4_CANONICAL_AUTOPAY_EXECUTION_ENABLED` unset or false. The
current PR3 application has no scheduled-charge or canonical-autopay
operation; any future unattended execution requires a separately reviewed
contract built on the retained roster snapshot/items and ledger controls.

F5 canonical receipts and payment reporting are read-only and migration-free
on top of the existing F1/F2/F3/F4 evidence and migration `0029`. Deploy only
the tested application commit; do not enable an execution gate or change
webhook mode. The F5 smoke uses an isolated database and fake provider,
verifies zero `processPayment` calls and zero report writes, and checks
explicit tenant scope. A post-evidence rollback is a traffic pause and
forward fix; never down-migrate or relink ambiguous historical payments.

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

The production Render Web Service should use `/healthz` as its Health Check
Path. This is a database-free liveness endpoint, so Render's normal monitoring
does not keep Neon compute awake. `/api/health` remains the database-backed
readiness probe for operators and deployment verification. Operators must
still probe it explicitly during rollout and complete the commit,
authentication, workflow, provider, worker, and log checks below; Render's
health signal is one deployment gate, not proof that the release is complete.

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
Keep Square credentials in their intended environment and location; never copy
production credentials into a local or test environment.

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

The preferred executor is the manual **Production database migration** GitHub
Actions workflow. Dispatch it from `main` only after Exact main certification
succeeds. Enter the full certified SHA, the exact ordered pending migration
tags (or `none`), and the displayed confirmation phrase. Its `production`
environment requires operator approval, and the job uses the repository's
`NEON_API_KEY` secret to verify the pinned production target, create a protected
branch without a compute, acquire a direct connection string without printing
it, and run the checked migration with an exact-pending guard under the database
advisory lock. Before executing SQL, the runner compares the live `public`
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
deploy.

Every schema-release PR must add the checked-in fingerprint for its resulting
migration under `migrations/schema-fingerprints/`; retain the prior release
fingerprint because it is the pre-migration approval boundary. Do not hand-edit
fingerprint digests or accept an unexpected production mismatch.

If the workflow is unavailable, the manual operator procedure below remains
the fail-closed fallback. Never run both executors concurrently.

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
6. Set `DB_MIGRATION_EXPECTED_PENDING` to the exact ordered, comma-separated
   migration tags approved for this release, then run `npm run db:migrate`
   with exactly one executor for the environment. Never omit this variable on
   a production fallback. Abort on any fingerprint, journal, pending-list, or
   migration failure. After it succeeds, set
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

### Migration 0028: retire legacy invitation columns

`0028_remove_legacy_invite_tokens` is the contract step after the account
identity hardening release. It removes `users.invite_token` and
`users.invite_token_expiry`; `account_action_requests` remains the sole
invitation and password-reset authority. The migration aborts if either legacy
column contains a non-null marker.

The previous application no longer accepts or writes legacy tokens, but its
Drizzle user shape still declares both columns. Dropping them before deploying
the 0028-compatible build could therefore break ordinary user reads. Use this
specific release order:

1. Confirm production is running the completed identity-hardening release and
   that no legacy markers remain.
2. Deploy the exact CI-certified 0028-compatible commit while both columns
   still exist.
3. Verify `/healthz`, `/api/health`, login, organization-only account creation,
   invitation resend/acceptance, and payment-manager boundaries.
4. Create and verify a fresh Neon backup from that healthy state.
5. Reconfirm the exact migration journal prefix and zero legacy markers, then
   run `npm run db:migrate` with one executor. It must report only
   `0028_remove_legacy_invite_tokens` pending and applied.
6. Verify the 0028 journal checksum, confirm both legacy columns are absent,
   rerun the migrator as a no-op, and repeat health/authentication checks.

After the contract migration commits, do not redeploy an application build
whose schema still declares the removed columns. A rollback to such a build
requires restoring the verified pre-0028 Neon backup first.

### Migration 0010: dormant auto-pay setup foundation

`0010_autopay_setup_foundation` is an additive, migration-first foundation.
It adds an empty setup-workflow table, dormant interactive-operation identity
support, and no reachable provider execution. The release does not activate
weekly auto-pay setup changes; do not deploy any route or client cutover until
this migration is merged, applied, and independently verified.

The partial `payment_schedules_active_bowler_league_unique` index is the one
database-enforcement change visible to legacy code. Concurrent legacy attempts
to insert a second active schedule for the same bowler and league will fail
after this migration. Before applying 0010, its SQL preflight requires no rows
from:

```sql
SELECT bowler_id, league_id, count(*)
FROM payment_schedules
WHERE active = true
GROUP BY bowler_id, league_id
HAVING count(*) > 1;
```

Use this release sequence:

1. Keep Render Auto-Deploy Off and record the exact CI-certified `main` SHA.
2. Verify the Neon target and create the reviewed backup or restorable branch.
3. Suspend and drain every application instance. This prevents a legacy
   schedule insert from crossing the unique-index installation boundary.
4. Run the read-only duplicate query above. Stop for any returned row; do not
   delete, deactivate, or choose between schedules without an explicit data
   remediation decision.
5. Apply the checked-in migration once with `npm run db:migrate` and verify the
   journal/checksum, `autopay_setup_requests`, its constraints/indexes, the
   interactive-target unique index, and the active-schedule unique index.
6. Deploy the exact certified foundation commit and resume one instance.
7. Verify health, authentication, tenant isolation, legacy interactive and
   scheduled payments, refunds, and receipts. Confirm that no
   `autopay_setup_requests` or `interactive_charge` operation rows were created
   and that no new operation wake or Square call occurred.
8. Restore normal Auto-Deploy only after the dormant verification succeeds.

The previous 2B-2 application is schema-compatible with the additive table and
indexes, subject to the new active-schedule uniqueness enforcement. If the
foundation application fails before any later behavior cutover, keep migration
0010 in place and deploy a forward fix or the previous guarded application.
Do not reverse the migration, delete setup/operation evidence, or enable the
future client/server setup flow as a rollback technique.

### Weekly auto-pay setup behavior activation

The behavior release after migration 0010 requires no additional migration or
secret. It activates the quote/setup routes, weekly auto-pay client cutover,
interactive-operation dispatch, exact occurrence allocations, and the
three-hour past-due boundary. Production must already be running the verified
0010 schema and `SCHEDULED_PAYMENT_EXECUTION_MODE=ledger_execute`; the latter
is required for durable recovery wakes after transient or unknown provider
outcomes.

Deploy the exact CI-certified behavior commit with Auto-Deploy still Off. Verify
all of the following before allowing normal traffic:

1. A setup just before the first league start quotes and charges $0, then
   schedules that first occurrence.
2. A setup after the league start but before the three-hour deadline charges
   exactly the current week and labels it `due_today`.
3. A setup at or after the deadline classifies that occurrence as
   `past_due`, requires every older occurrence to be settled, and schedules
   the first unpaid future occurrence.
4. The operation, provider payment, local payment allocation, setup request,
   and future schedule share the expected tenant and stable identity.
5. Combined auto-pay stores the per-bowler weekly base and does not multiply
   the payer-plus-partner total twice.
6. Duplicate submission and process-restart recovery reuse one Square effect;
   no compensation refund is issued for a local finalization failure.
7. One-time/upfront payments, scheduled ledger execution, refunds, receipts,
   authentication, and tenant isolation remain healthy.

Before the first setup request is created, application rollback to the dormant
foundation commit is schema-compatible. After any activated setup request or
interactive operation exists, do not resume the old client-orchestrated weekly
setup path: drain the service and deploy a forward fix while preserving all
setup, operation, payment, and provider evidence.

### Migration 0023: dormant occurrence financial foundation

Migration `0023_phase_d2_occurrence_financial_foundation` is additive and
creates empty eligibility, occurrence-team, obligation, collection-plan,
settlement-allocation, revision, and supplemental operation-snapshot tables.
It performs no backfill and activates no payment behavior. Follow the schema
release auto-deploy hold and normal target/backup/journal/fingerprint gates.

Apply 0023 before deploying its matching application. Verify that the new
tables are empty, current scheduled and interactive writers still emit only
their existing snapshot versions, existing provider/request/idempotency
identity is unchanged, legacy weekly and upfront flows remain healthy, and no
provider request is caused by D2. The previous application is compatible with
0023; rollback leaves the forward migration and any durable evidence in place.
See [Phase D2 occurrence financial foundation](phase-d2-occurrence-financial-foundation.md)
for the full smoke-test and later-phase boundary.

### Phase E2 canonical games and scores

Phase E2 is a code-only cutover that reuses the E1 authoritative schedule
selection and the existing nullable `games.occurrence_id` from migration 0022.

Migration 0023 remains the latest required migration; do not run a migration or
backfill as part of the E2 release. Deploy the exact CI-certified application
commit, then verify canonical and explicit fallback game/score reads, one
atomic score batch, tenant boundaries, bowler-history grouping by occurrence
UUID, and unchanged canonical effective locks. Confirm no D2 financial row or
payment/provider operation was created. Application rollback is schema-safe
and leaves exact occurrence links in place. See
[Phase E2 canonical games and scores](phase-e2-canonical-games-scores.md) for
the full contract, incompatibility behavior, smoke matrix, and E3 boundary.

### Phase E3 canonical standings evidence

Phase E3 is a code-only, read-only evidence release. It adds
`GET /api/leagues/:leagueId/standings` with the versioned
`league-standings/2` contract, reusing the complete E1/E2 snapshot in one
repeatable-read/read-only transaction. The response explicitly reports
`ranking.state = policy_required` and returns no ranked rows because matchup
and ranking policy is not yet approved. Migration 0023 remains latest; do not
run a migration or backfill for E3.

Keep Render Auto-Deploy Off and deploy only the exact CI-certified application
commit. Smoke-test active-member, organization-administrator, and explicitly
scoped system-administrator access; canonical UUID grouping and eligibility;
canonical-only schedule/game/standings evidence; stable full-evidence
fingerprints; bounded discrepancies; the generic incompatibility 409; and
before/after zero-write evidence across canonical, game/score, D2, payment, and
payment-operation tables. Confirm the Bowler Scores average, financial reports,
receipts, refunds, webhooks, and provider behavior are unchanged. Application
rollback to E2 is schema-compatible and must leave migration 0023 and all
durable evidence intact. See
[Phase E3 canonical standings evidence](phase-e3-canonical-standings-reports.md)
for the complete contract and smoke matrix.

### Phase E4 rollover and future-season generation

E4 is an application-only release; migration 0023 remains latest. Keep Render
Auto-Deploy off, verify the exact CI-certified main SHA and the production 0023
journal/checksum, then deploy that exact SHA without running a new migration.
No environment variable or provider configuration changes.

Authenticated smoke coverage must create only reviewed disposable test data:
confirm that the source-confirmation response excludes provider/payment/PII
fields, stale source configuration is rejected, and a wholly future rollover
creates one target with copied teams/complete roster, null Square catalog IDs,
new canonical UUIDs, and a published canonical schedule. Verify an exact retry
performs zero writes and returns the same IDs. Confirm E1 remains
canonical-authoritative and verify cross-tenant access fails closed. Confirm no D2, payment, operation,
refund, dispute, webhook, or unexpected provider evidence was created and no
provider call occurred in the smoke window.

Application rollback keeps the generic versioned evidence. Do not delete it,
run a Fall recovery route against it, or resume request-v1 setup writes. See
[Phase E4 rollover and future-season generation](phase-e4-rollover-future-season-generation.md).

## Post-Deployment Checks

- Confirm the Render deploy is running the exact certified commit.
- Request `/api/org-context` and confirm it reports `appEnv: "prod"` plus the
  short commit matching that Render deployment. A missing, unknown, or
  mismatched commit is a failed verification.
- Check `/api/health` and the Render boot logs.
- Confirm authentication and one representative affected workflow.
- Review Sentry and Render logs for new errors.
- For the dormant Phase 4A-1 Square inbox, follow the migration-first and
  separate `disabled` -> `ingest_only` sequence in
  [`square-webhook-inbox.md`](./square-webhook-inbox.md). Do not configure a
  subscription, copy a signature key, send a test event, or activate processing
  as part of the implementation PR.
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
## F1 canonical due/past-due rollout

Before release, apply the single forward migration `0024_canonical_due_past_due_activation` and verify `npm run db:migration-bytes:check` plus `npm run db:check`. Confirm financial activation count is zero and provider mocks/call counters remain zero. F1 activation is dormant unless an authorized organization administrator explicitly reviews and confirms every three-or-four-slot responsibility group.

Post-release smoke checks are read-only: an org-admin report returns the versioned canonical source label; a system-admin report requires an explicit organization scope; an ordinary member receives only an active self-bowler league read; cross-tenant and inactive membership requests are nondisclosing. Verify missing or incompatible canonical state fails closed. Roll back the application release only; never reverse migration 0024 or delete activation evidence.

Permanent organization deletion is not available for a tenant with F1 activation
evidence. The API returns a generic `409 FINANCIAL_ACTIVATION_RETENTION_REQUIRED`;
archive or retain that tenant and preserve the immutable audit rows. A separately
approved retention/deletion workflow is required before any irreversible removal.
# F2 interactive occurrence allocation (migration-first, dormant)

F2 is not activated by this change. Before any separately authorized rollout,
apply and verify migration `0025_f2_interactive_occurrence_actor` on the target
database, deploy the exact CI-verified commit, and confirm
`LEAGUEVAULT_F1_ACTIVATION_ENABLED` remains off unless the operational gate is
explicitly approved. No historical payment or operation may be backfilled or
linked to an obligation.

The first smoke check must use a disposable canonical-active test league and
explicit obligation UUID selection. Verify quote fingerprint replay, partial
allocation, duplicate-key replay, and that two distinct keys cannot reserve the
same outstanding obligation. Confirm provider location, Square amount/order
and payment keys, actor-restricted status/recovery, atomic settlement evidence,
duplicate webhook behavior, and unchanged receipt/refund/dispute/reporting
surfaces. Do not use a real customer, card, webhook payload, or production
payment as a test target.

Once an F2 supplement exists, rollback is traffic pause plus roll-forward to an
F2-aware application. A pre-F2 application is not an approved rollback target.
