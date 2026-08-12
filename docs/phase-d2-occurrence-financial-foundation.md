# Phase D2 occurrence financial foundation

Phase D2 adds a dormant, additive foundation for occurrence participation and
money evidence. It does not create production rows, infer responsibility,
change a payment workflow, call Square, or cut any legacy consumer over.

## Entity boundaries

The model keeps six facts separate:

- `bowler_occurrence_eligibilities` records an explicit eligible/ineligible
  decision for one bowler and one exact occurrence. It assigns no team and
  creates no debt.
- `bowler_occurrence_team_assignments` records the explicit team snapshot for
  that bowler at that occurrence. It is not sourced from `bowler_leagues` and
  says nothing about eligibility or payment responsibility.
- `bowler_occurrence_obligations` records the authoritative positive amount,
  currency, purpose, bowler, and exact occurrence that are actually owed.
  A nullable composite reference can bind the evidence to the exact canonical
  billing-term identity and version. There is one logical obligation for an
  organization, league, occurrence, bowler, and purpose.
- `occurrence_collection_plans` and
  `occurrence_collection_plan_items` describe when explicit obligations are
  intended to be collected. A plan uses either one trigger occurrence or one
  explicit `collect_at` instant. It contains no provider identity.
- `payment_occurrence_allocations` records durable settlement from an existing
  payment row to one explicit obligation. The payment itself does not receive
  an occurrence column.
- `payment_operation_occurrence_snapshots` and its allocation table are a
  dormant, versioned supplement to existing scheduled and interactive
  execution snapshots. They snapshot obligation allocation semantics without
  changing the provider request snapshot.

Eligibility, assignment, obligation, collection, operation intent, and final
settlement are therefore independently absent or present. No row in one of
the first two tables implies a row in any other table.

## Versioning and historical evidence

Eligibility, team assignment, obligation, collection-plan, and settlement
allocation current rows carry `current_revision`. Their typed revision tables
store a positive revision number, a snapshot schema version, the prior
snapshot after revision 1, the resulting snapshot, the recording actor, and
the recording time. Collection-plan revisions cover the plan and its ordered
item set; a changed collection arrangement must be a reviewed revision or a
new plan version rather than an implicit item rewrite.

An obligation's organization, league, occurrence, bowler, purpose, amount,
currency, and billing-term evidence are database-immutable after insert.
Lifecycle may later advance through reviewed revisions, but voiding does not
zero or erase the authoritative amount. Existing obligation and revision
foreign keys use `ON DELETE RESTRICT`; only the explicit atomic organization
teardown is allowed to remove them.

Team-assignment revisions retain the before/after team IDs, so later roster or
team changes do not reinterpret an occurrence. D2 deliberately performs no
roster-derived insert and exposes no writer route.

## Tenant and relationship integrity

Every D2 row carries organization and league scope. Composite foreign keys
prove the following relationships:

- the occurrence belongs to the organization and league;
- the bowler belongs to the organization;
- an assigned team belongs to the league;
- a referenced billing term belongs to the same occurrence, tenant, league,
  purpose, currency, and version;
- every plan item belongs to the plan's tenant, league, and currency and to
  the identified obligation, occurrence, and bowler;
- every settlement payment belongs to the identified league and bowler; and
- every operation supplement belongs to the operation tenant/currency and
  every snapshot allocation belongs to its same-tenant obligation.

Restrictive parents prevent orphaned current or revision evidence. Lookup
indexes cover tenant/league, occurrence, bowler, state, plan, obligation,
payment, and operation traversal. Organization teardown deletes D2 revisions
and children before current rows and before payment, operation, occurrence,
bowler, league, and organization parents in the existing atomic transaction.

## Collection timing and payer responsibility

`leagues.payment_mode` still determines timing:

- `weekly` collection plans may use the occurrence that triggers collection;
- `upfront` plans may use an explicit instant before one or more future
  occurrences.

Both modes retain per-occurrence obligations. Prepayment changes collection
timing, not the physical identity of a session and not whether a bowler owes
an occurrence obligation.

Future obligation generation must receive explicit league/team inputs for the
required three-person or four-person paying lineup and the actual responsible
bowlers for each occurrence. Roster membership cannot supply those inputs.
Substitute-payer responsibility varies by league and team, so D2 neither
chooses a substitute nor treats a substitute's eligibility, team assignment,
or score as payer evidence.

A double-pay instruction is one collection plan containing two items: one for
the current real occurrence obligation and one for another real occurrence
obligation. The occurrences, billing terms, and obligations are not doubled or
synthesized. The same representation permits an upfront plan to group several
future obligations without changing their physical identities.

## Allocation conservation and concurrency

Settlement allocations are positive, explicitly currency-stamped, and unique
for a payment/obligation pair. One payment can therefore allocate to multiple
obligations and occurrences, while one obligation can receive allocations from
multiple payments. Partial allocation is allowed.

The obligation composite foreign key enforces settlement currency. When a
payment has operation lineage, the conservation trigger also requires the
operation currency to match. Legacy/manual payments have no stored currency;
their D2 allocation is new explicit evidence and is never created by inference.

The allocation trigger acquires the established organization/league advisory
transaction lock, locks the referenced payment and obligation, and validates
the committed active sums. Active allocations may not exceed either the
payment amount or obligation amount. This is intentionally not a race-prone
check-then-insert service. Unique indexes reject duplicate logical allocations,
and competing allocations against the same payment or obligation serialize.

Draft plans may hold alternative or partial arrangements without reserving an
obligation. Once a plan is `ready` or `fulfilled`, its items count toward the
obligation's collectable total. Item writes and plan-state transitions acquire
the league advisory lock and lock the obligation; the aggregate across all
collectable plans cannot exceed the authoritative obligation amount. This
prevents two concurrent plans from presenting the same debt for collection.

The versioned operation supplement uses deferred commit-time triggers to prove
its ordered allocation count and amount exactly equal both its snapshot and
existing operation amount. The trigger also requires the matching scheduled or
interactive execution snapshot and requires its league to equal the supplement
league, so occurrence evidence cannot drift from the snapshotted provider
intent.

## Snapshot compatibility

The existing production contracts remain unchanged:

- scheduled execution snapshots continue to emit/read version 1 and retain
  their exact `lvpayexec:v1` serialization and hash;
- interactive snapshots continue to emit version 2, read versions 1 and 2,
  and retain their exact `lvpayexecic:v1`/`v2` semantics;
- their target keys, request fingerprints, provider idempotency keys, encrypted
  fields, lease/retry behavior, and bowler-level allocation uniqueness are
  unchanged.

The new supplemental contract is
`payment-operation-occurrence-snapshot/1` with `lvpayocc:v1` fingerprints. Its
explicit version dispatcher validates tenant/league/currency equality,
contiguous indexes, exact totals, and obligation uniqueness. It permits the
same bowler across different obligations/occurrences without weakening the
interactive one-bowler-per-operation invariant. At persistence, the supplement
must match the operation type's existing execution snapshot and league. No
production reader or writer imports or activates the supplement in D2.

## Effective locks and dormancy

Canonical reschedule, cancellation, restoration, and discard paths already use
the league advisory lock. Their effective-lock evidence now includes D2
eligibility, assignment, obligation, collection-plan/item, settlement, and
operation-snapshot references. C2 review computes the same evidence. With the
D2 tables empty, existing production results are unchanged; once evidence
exists, a structural mutation fails closed.

D2 adds no API, UI, backfill, obligation/plan generator, allocation or
reconciliation cutover, worker, timer, scheduler, provider call, historical
payment linker, game/score/report consumer, or production operator. Scores
continue to inherit occurrence identity only through games.

## Migration, rollback, and later release procedure

Migration `0023_phase_d2_occurrence_financial_foundation.sql` follows 0022. It
creates only empty tables, constraints, indexes, and conservation/audit
triggers plus supporting unique indexes on existing stable identities. It has
no data statement, inferred row, dropped object, renamed object, or weakened
production snapshot constraint. PostgreSQL 16 and 17 full-history replay and
migration rerun must pass before release.

The migration is safe to apply before the D2 application because no existing
writer must populate the new tables. The previous application remains
compatible after migration. Application rollback therefore leaves 0023 and
any durable D2 evidence in place; do not reverse the migration or delete
evidence. A schema regression uses the prepared Neon restore plan.

For a later operator release:

1. Keep Render Auto-Deploy Off.
2. certify the exact merged `main` commit and create/verify a current Neon
   backup or restorable branch;
3. verify target identity, canonical fingerprint, journal prefix, migration
   checksum, and the absence of drift;
4. apply 0023 once through `npm run db:migrate`;
5. verify the journal and empty D2 tables, then manually deploy the same
   certified commit; and
6. smoke-test `/api/health`, authentication, tenant isolation, legacy games,
   schedules, weekly/upfront payments, scheduled and interactive snapshot
   recovery, refunds, disputes, receipts, canonical C2 review, and confirm zero
   unexpected D2 rows/provider requests. Leave Auto-Deploy Off until the
   complete reviewed release procedure authorizes restoration.

Later E and F phases still own explicit obligation generation inputs,
eligibility/assignment administration, collection-plan generation, weekly and
upfront consumer cutovers, operation-snapshot activation, settlement
allocation/reconciliation, refund/dispute allocation semantics, reporting,
rollover, production materialization, and any reviewed backfill.
