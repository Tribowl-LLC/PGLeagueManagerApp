# Per-league owned payment ledger adoption

This runbook is for one explicit, reviewed league at a time. It uses the
already deployed owned payment ledger and its atomic adoption service; it does
not authorize a schema change, a new workflow run, or production work by
itself. Follow the [production release lifecycle](production-runbook.md#default-release-lifecycle)
and the [Manage Payments implementation plan](manage-payments-implementation.md)
first. The frozen migrations `0052` through `0055` must already have completed
through the protected migration workflow, and the exact certified SHA must be
deployed and verified before adoption.

New league and new-season creation follows a separate pristine setup path: once
the canonical schedule is published, the empty-source owned ledger is
initialized inside that same creation transaction. That path does not adopt an
existing league. An older empty league and an older populated league both use
this guarded per-league CLI process. Adoption never runs on GET or application
startup.

The protected release gates remain prerequisites: Auto-Deploy is Off for the
schema release; the protected migration workflow approval, target checks,
backup, ordered migration, and successful immediate no-pending rerun have
passed; and the exact certified application SHA is deployed and healthy. The
adoption command must run in that deployed service's protected runtime so its
ambient `DATABASE_URL`, `FIELD_ENCRYPTION_KEY`, and `RENDER_GIT_COMMIT` are the
actual values. Do not copy, print, or paste those secrets. Stop if the deployed
SHA is not the currently certified 40-character SHA.

The CLI is the built Node artifact at
`dist/owned-payment-ledger-adoption.js`. The regular application build creates
it. Use Node 22 and invoke the artifact directly; there is no `tsx`, `npx`,
development server, GET route, or startup adoption path. `--help` is safe and
does not load the database module.

## Read-only preflight

Select the configured organization and the exact existing league through the
approved operator process. `ACTOR_USER_ID` must identify an authorized
`org_admin` for this organization or a `system_admin` who is performing the
operation. The expected database host and name are explicit guards. Set them
from the independently reviewed protected Render runtime configuration and
the verified Neon production branch endpoint. Confirm the Render host is the
direct endpoint or its exact pooled alias and confirm the database name
against both runtime configuration and the workflow's pinned production
target. Do not derive them from the ambient `DATABASE_URL` in this command and
compare the value back to itself:

```bash
EXPECTED_DB_HOST='<independently verified direct or pooled production endpoint hostname>'
EXPECTED_DB_NAME='<independently verified production database name>'
CERTIFIED_SHA='<exact certified 40-character main SHA>'
ORGANIZATION_ID='<configured organization ID>'
LEAGUE_ID='<selected existing league ID>'
ACTOR_USER_ID='<authorized org_admin for this organization or system_admin user ID>'
EVIDENCE_FILE=".local/owned-payment-adoption-${ORGANIZATION_ID}-${LEAGUE_ID}-$(date -u +%Y%m%dT%H%M%SZ)-${BASHPID}.json"
mkdir -p .local
node dist/owned-payment-ledger-adoption.js preflight \
  --expected-db-host "$EXPECTED_DB_HOST" \
  --expected-db-name "$EXPECTED_DB_NAME" \
  --expected-render-git-commit "$CERTIFIED_SHA" \
  --organization-id "$ORGANIZATION_ID" \
  --league-id "$LEAGUE_ID" \
  --actor-user-id "$ACTOR_USER_ID" \
  --evidence-file "$EVIDENCE_FILE"
```

The evidence path must be new; the CLI creates it exclusively with mode `0600`
and refuses to overwrite an earlier review. Keep it out of source control and
in restricted operator storage. It contains the sanitized preflight result,
including internal blocker entity IDs, counts, and fingerprints. Standard
output contains only the target, scope, fingerprints, counts, and blocker
codes/counts. A ready preflight exits `0`; a preflight with blockers exits `2`
after saving its review artifact. Any other refusal exits `1` with a generic
message.

Review the complete artifact in the approved restricted operator context.
Confirm the organization, league, actor, target, adoption cutoff, counts,
source fingerprint, result fingerprint, and every blocker. Stop on any
blocker. Do not infer missing payment ownership, waive a blocker, or use a
force option. If a payment, refund, allocation, dispute, roster assignment,
occurrence, or lineup changes after review, discard that review for decision
purposes, rerun preflight, and review the new fingerprints and counts.

The runtime accepts only the exact expected Neon database host and database.
It recognizes the optional `c-<digits>` proxy label before the AWS region and
preserves that label in the direct endpoint fingerprint. For a pooled Render
connection it removes only the literal `-pooler` suffix from the endpoint
label. Confirm the displayed fingerprint maps to the independently verified
protected production branch endpoint. Any other hostname shape or mapping is
a stop condition.

## Transcribe the protected backup and migration evidence

The protected `Production database migration` workflow for this release takes
the exact ordered input
`0052_weekly_admin_payments_ledger,0053_owned_payment_refund_support,0054_weekly_standing_account_funding,0055_owned_account_refunds_v3`.
That same successful run performs the immediate `DB_MIGRATION_EXPECTED_PENDING=none`
verification. Its existing summary records the backup step outcome, recovery
branch name and ID, migration step outcome, and the statement that the
immediate rerun reported no pending migrations. The separately transcribed
`verification` value below is that exact summary statement. A run dispatched
with `expected_pending_migrations: none` is acceptable only when its own
successful logs and summary prove the no-pending result. Do not dispatch a
second workflow run or create another backup just to produce `none` evidence.

Before creating the local JSON, inspect the actual completed protected run
and independently verify its repository/workflow identity, successful run
and attempt, exact certified SHA, exact ordered migration input, successful
backup and migration steps, and post-migration no-pending evidence. In Neon,
verify the actual backup branch belongs to project `dark-firefly-25282046`,
has ID and name matching the run summary, has parent
`br-late-glitter-aqm4u4fc` (`production`), is unprotected and current, and is
restorable. Verify the protected production branch and runtime host fingerprint
match the same target. Stop if any value or outcome is missing or differs.

With `umask 077`, create a mode-`0600` local JSON transcription using the exact
shape below. Replace every descriptive value with the value verified in the
real run or Neon record. The run URL must be the exact GitHub URL for
`Tribowl-LLC/PGLeagueManagerApp` and that run ID; if it contains an
`/attempts/<n>` suffix, `<n>` must equal `run_attempt`. Do not put credentials,
tokens, database URLs, query strings, or fragments in it.

```json
{
  "workflow_path": ".github/workflows/production-database-migration.yml",
  "workflow_run_url": "<exact GitHub Actions run URL>",
  "run_id": 123456789,
  "run_attempt": 1,
  "run_conclusion": "success",
  "expected_sha": "<exact certified 40-character SHA>",
  "expected_pending_migrations": "0052_weekly_admin_payments_ledger,0053_owned_payment_refund_support,0054_weekly_standing_account_funding,0055_owned_account_refunds_v3",
  "backup_outcome": "success",
  "migration_outcome": "success",
  "verification": "checked migration completed and immediate rerun reported no pending migrations",
  "neon_project_id": "dark-firefly-25282046",
  "neon_production_branch_id": "br-late-glitter-aqm4u4fc",
  "neon_production_branch_name": "production",
  "neon_database_name": "neondb",
  "neon_role_name": "neondb_owner",
  "host_fingerprint": "sha256:<64 lowercase hex characters>",
  "backup_id": "<actual unprotected recovery branch ID>",
  "backup_name": "backup-pre-migration-<certified SHA first 12 characters>-<run ID>-<attempt>",
  "backup_parent_id": "br-late-glitter-aqm4u4fc",
  "backup_protected": false
}
```

The JSON is a local transcription for exact target binding, not independent
cryptographic proof of GitHub or Neon state. The operator's review of the real
run and branch is authoritative. Preserve the exact run ID and attempt and the
verified backup identifiers with the adoption record. Do not fabricate,
backfill, or infer missing evidence.

## Apply one reviewed preflight

Run apply only after the preflight is ready and reviewed, the proof file has
been transcribed and checked, the certified runtime still matches, and no
source or schedule change has occurred since preflight. Copy the two
fingerprints exactly from the reviewed artifact:

```bash
BACKUP_PROOF_FILE='<restricted local path to the reviewed JSON transcription>'
EXPECTED_SOURCE_FINGERPRINT='<sourceFingerprint from the reviewed preflight>'
EXPECTED_RESULT_FINGERPRINT='<resultFingerprint from the reviewed preflight>'
node dist/owned-payment-ledger-adoption.js apply \
  --expected-db-host "$EXPECTED_DB_HOST" \
  --expected-db-name "$EXPECTED_DB_NAME" \
  --expected-render-git-commit "$CERTIFIED_SHA" \
  --organization-id "$ORGANIZATION_ID" \
  --league-id "$LEAGUE_ID" \
  --actor-user-id "$ACTOR_USER_ID" \
  --expected-source-fingerprint "$EXPECTED_SOURCE_FINGERPRINT" \
  --expected-result-fingerprint "$EXPECTED_RESULT_FINGERPRINT" \
  --backup-proof-file "$BACKUP_PROOF_FILE"
```

Before it imports the database module, the CLI validates all arguments, the
runtime target and SHA, and the complete local backup transcription. It then
calls the existing league-scoped service, which rechecks the actor, exact
scope, current source state, and both fingerprints while holding the league
lock. The write is atomic, and an exact retry is handled by the service.
Staleness, ambiguity, mismatched evidence, or any refusal stops the operation;
rerun and review preflight when state changed. Do not work around a refusal.

## Verify and recover

Retain the safe apply summary, reviewed preflight artifact, proof file, and
protected run/backup references in the restricted adoption record. Verify the
same organization and league, the adoption marker and cutoff, and the reported
counts and fingerprints. Then verify the deployed SHA and health, sign-in,
tenant isolation, the weekly worksheet and balances, receipt/history
redaction, refunds, provider receipts, and financial reports. Confirm the
league follows the owned ledger path while an unadopted comparison league
continues to follow its legacy path. Use approved records and the established
payment-operation checks; do not create a real tender as a smoke test.

Rollback after adoption requires reconciliation or a verified restore that
preserves intervening payments, refunds, waivers, allocation releases, receipt
revisions, confirmed weeks, ownership proofs, and the adoption marker. It is
never a code-only revert, marker deletion, or removal of post-adoption
outcomes. Keep Auto-Deploy Off through the schema release and its exact-SHA
verification; follow the production runbook before restoring its prior mode.
