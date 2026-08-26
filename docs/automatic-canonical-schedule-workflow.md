# Automatic canonical schedule workflow

## Contract

Setup integration request/result v3 is the authoritative path for ordinary league creation and rollover. The transaction creates the future-season generation rows, invokes the guarded publication primitive in-process, writes published occurrence/term/skip evidence, derives dedicated double-pay collection groups, and marks the run applied before one commit. There is no externally visible draft or administrator approval step, and no v1/v2 setup compatibility parser. No D2/F3 activation or payment obligation is created by setup.

Double-pay is collection timing evidence. Selected trigger dates are sorted in league-local calendar order and paired one-for-one with the final N other billable occurrences. Each group stores the two durable occurrence UUIDs, term UUIDs, ordinals, dates, and exact amounts. Amounts and physical rows are never multiplied or copied. Canonical consumers use the group evidence once.

Collection groups are schedule evidence only. PR3 has no durable payment
schedule cursor or scheduled-charge operation: the roster payment runtime uses
the group's exact occurrence members when it derives a reviewed collection
amount. A revoked or broken group is therefore surfaced as a configuration
failure; the system never substitutes a date, occurrence, or amount.

## Mutation and cancellation

The schedule read contract exposes group ID, role, paired occurrence ID/date, group state, and revision. The builder remains the editing surface. An authoritative canonical double-pay/cancellation edit supplies `scheduleRevision` and `Idempotency-Key`; the schedule lock, editor command/fingerprint, group revocations, and new groups are one transaction. The editor contract is `canonical-schedule-edit/2`: ordinary builder metadata (name, description, activation visibility, practice time, and catalog fee labels) is persisted in that same transaction and its normal post-commit resync/cache effects still run. `skipDates` and physical scalar changes fail closed with 409 until a reviewed physical regeneration exists; locked location/payment/weekly-fee changes are rejected explicitly. Stale revisions return 409. Published occurrences retain their UUIDs through reschedule, cancellation, and restoration where the existing safety checks permit it; no approval or rejection action is required.

Cancelling a future canonical occurrence retains its UUID and planned ordinal, marks it cancelled/noncompetitive/no-standings, and revises the term to none/zero/no due date. Open obligations are voided with a revision; partial or settled allocations remain immutable and produce bounded cancellation/reconciliation evidence. For an already active F1 league, the same transaction writes versioned activation-cancellation suppression evidence containing the original responsibility fingerprint, command, occurrence/term revisions, and review marker. The live F1 validator preserves the immutable activation fingerprint, requires every canceled responsibility to be voided and cancellation-audited, and accepts no non-cancelled source drift. Ready collection plans and pre-dispatch pending/retry/leased operations are cancelled under the same lock. The current PR3 ledger has no `scheduled_charge` or canonical-autopay runtime; any future occurrence-aware payment operation must be linked to exact tenant/league evidence before cancellation. Provider-unknown or dispatch-claimed work is preserved for reconciliation; no provider call is made by cancellation. Interactive F2 finalization takes the same league lock and, if cancellation won after the provider claim, retains successful payment/provider evidence as `reconciliation_required` without active allocations, obligation reactivation, or refund. A trigger or paired occurrence revokes exactly its group and never selects a replacement. Restoration is allowed only for a future occurrence with no game, score, allocation, obligation, plan, operation, dispatch, or grouping evidence; it retains the UUID and does not rewind a payment cursor.

## Release and rollback

This canonical-only cutover is application-only and introduces no migration or backfill. The existing canonical collection-group tables and financial evidence remain unchanged. Setup and edit transactions either commit all canonical evidence or roll back without a visible draft. The PR3 ledger, leases, provider idempotency, and reconciliation behavior remain unchanged; unsupported active-financial drift fails closed. Rollback is an application forward-fix or traffic pause; there is no schema rollback to perform.

## Explicit historical repair

The 19073 repair is not a migration and is not a broad backfill. After deployment, an orchestrator may run `server/scripts/repair-canonical-collection-groups.ts` with explicit tenant, league, actor, generation-run UUID, schedule revision, idempotency key, reason, and JSON pairs containing both occurrence UUIDs and both dates. The service locks the tenant/league, verifies the exact current operational run and configured trigger count/order, establishes `leagues.canonical_schedule_revision` with a CAS when it is still zero, validates dates, lifecycle/status, published terms, and complete group/member/revision evidence on retry, then inserts only proven group/member rows and audit revisions. It never rewrites occurrences, terms, ordinals, obligations, allocations, plans, or provider rows. Do not run it automatically or during deployment.

Example (placeholders only):

```sh
REPAIR_ORGANIZATION_ID=<org-id> \
REPAIR_LEAGUE_ID=19073 \
REPAIR_ACTOR_USER_ID=<system-admin-id> \
REPAIR_GENERATION_RUN_ID=<run-uuid> \
REPAIR_SOURCE_SCHEDULE_REVISION=<revision> \
REPAIR_IDEMPOTENCY_KEY=<unique-repair-key> \
REPAIR_REASON='Audited 19073 canonical pair repair' \
REPAIR_PAIRS_JSON='[{"triggerOccurrenceId":"<trigger-uuid>","pairedOccurrenceId":"<paired-uuid>","triggerLocalDate":"2026-10-12","pairedLocalDate":"2027-04-26"},{"triggerOccurrenceId":"<trigger-uuid>","pairedOccurrenceId":"<paired-uuid>","triggerLocalDate":"2026-10-19","pairedLocalDate":"2027-05-03"}]' \
npx tsx server/scripts/repair-canonical-collection-groups.ts
```

## Release and smoke matrix

1. Run `npm run db:check`, `npm run db:migration-bytes:check`, and confirm the deployed database journal is unchanged.
2. Deploy the exact reviewed application commit; no migration or backfill is required.
3. Smoke one v3 create and one v3 rollover: result is `published`, no review action is returned, physical IDs and terms are present, groups map deterministically, and D2/F3 tables remain empty.
4. Retry the same request and concurrently retry it: IDs and fingerprints are identical with zero additional rows. Retry a changed payload and stale edit revision: both return 409.
5. Exercise a full builder-shaped mixed PATCH (metadata plus schedule), unsupported skip/scalar fields, zero/one/two double-pay triggers, the 19073 explicit pair fixture, a cancellation of each group role, trigger→paired→following cursor advancement, claim-before-cancel and cancel-before-claim races, and UPDATE/DELETE rejection for cancellation suppressions. Verify canonical schedule reads show the exact group badges.
