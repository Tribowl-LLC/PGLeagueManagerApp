# Phase D1 canonical occurrence compatibility

Phase D1 adds event-driven compatibility evidence between the authoritative
legacy game/payment schedule/payment-operation representations and published
canonical physical occurrences. It does not cut a consumer over to canonical
state. Legacy game dates and week numbers, schedule cursors, operation billing
cycles, payment `week_of` values, scheduler behavior, and provider execution
remain authoritative.

## Nullable references

Migration `0022_phase_d1_occurrence_compatibility` adds three nullable columns
without defaults or data updates:

- `games.occurrence_id` identifies the exact physical occurrence for a game.
  Scores inherit this identity through `scores.game_id`; scores do not receive
  another occurrence column.
- `payment_schedules.next_occurrence_id` shadows the authoritative
  `next_payment_date` cursor. Immediate/upfront schedules remain valid with a
  null reference.
- `payment_operations.trigger_occurrence_id` identifies the occurrence start
  that triggered a `scheduled_charge`. It is a trigger, not an allocation or
  statement that the charge settled only that occurrence. Interactive charges
  and refunds remain null.

Game and schedule references use restrictive `(occurrence_id, league_id)`
foreign keys. Operation references use a restrictive
`(trigger_occurrence_id, organization_id)` foreign key; scheduled preparation
re-proves the schedule league, trigger league, tenant, and billing-cycle start
under the existing transaction locks. Supporting occurrence identity indexes
are the minimum composites required by PostgreSQL. Reverse-reference indexes
support compatibility lookup and effective-lock checks.

## Exact comparison contract

The shared contract is `canonical-occurrence-compatibility/1`; semantic
fingerprints use `canonical-occurrence-compatibility-fingerprint/1`. The
fingerprint is lowercase SHA-256 over canonical sorted-key JSON. It contains no
random identifier, observation time, host locale, or wall-clock value.
Diagnostics are bounded to a classification, safe scope, candidate counts,
reason code, and fingerprint. They contain no provider payload, credential,
encrypted value, session data, payment/bowler identity, or unnecessary PII.

The classifications are:

- `exact_match`
- `canonical_state_absent`
- `canonical_not_published`
- `no_match`
- `ambiguous_match`
- `legacy_number_mismatch`
- `legacy_date_or_start_mismatch`
- `ineligible_occurrence_state`
- `cross_tenant_or_cross_league_reference`

Game comparison is tenant/league scoped. It requires one eligible published or
locked scheduled/completed occurrence, exact competition-number agreement, and
mechanically extracted local-date agreement. A meaningful stored session time
must resolve through the canonical IANA/DST resolver to the exact canonical UTC
start. Midnight/date-only legacy values carry no session-time claim. Duplicate
legacy `(league, week, game)` evidence and multiple candidates are ambiguous;
no row order, closest date, fixed UTC offset, amount, or roster membership is
used. Cancelled, discarded, rejected/draft, and otherwise ineligible rows do
not link.

Schedule comparison requires exact normalized UTC equality between
`next_payment_date` and `start_at`, plus one eligible published scheduled
occurrence strictly in the future at comparison time. Draft-only state is
reported as not published. No local-date proximity fallback exists. Immediate
upfront schedules deliberately remain unlinked.

Scheduled-operation comparison requires exact billing-cycle/start equality,
the same organization, and the schedule's underlying league. A new operation
uses the exact comparison result; for a recurring pre-D1 schedule whose shadow
cursor is still null, preparation first reconciles that cursor under the same
locks and transaction. A non-null cursor that does not agree fails closed. A
same-key retry of a pre-D1 null operation remains null. A retry of a post-D1
operation verifies and returns its original trigger.
Trigger identity never enters payment amount, allocation, request fingerprint,
target key, Square/provider idempotency key, snapshot version, lease, fencing,
or retry semantics.

## Event-driven dual write and mismatches

Comparison runs only inside existing write events: game create/supported
update, schedule create, schedule cursor change/advancement, auto-pay setup
schedule finalization, and scheduled-operation preparation. Exact matches write
the legacy value and nullable reference in the same database transaction. The
league schedule advisory lock and row locks serialize the proof and write.

Absent or unpublished canonical state preserves the legacy write and leaves
the reference null. Any unprovable mismatch also preserves D1 legacy behavior,
leaves the reference null, and emits the bounded diagnostic. A stored non-null
reference outside its tenant/league or contradicting immutable game/operation
semantics fails closed. D1 performs no scan, startup backfill, timer, worker,
polling loop, or durable compatibility-observation write; approved generation
evidence and its counts/fingerprints remain unchanged.

## Effective locks

An occurrence is effectively locked when its start has arrived, its lifecycle
is locked, a linked game exists, or a linked scheduled/provider operation
exists. Scores inherit game activity. Canonical reschedule, cancellation,
restoration, and the shared repair/mutation infrastructure check linked D1
activity under the league lock and fail closed. A schedule cursor by itself is
not settlement/activity evidence and does not lock an occurrence.

## Deployment, compatibility, and rollback

0022 is additive and forward-only after 0021. Migration-first deployment is
compatible with the pre-D1 application because all columns are nullable, have
no defaults, and old writes remain valid. There is no historical backfill.
Review the SQL, snapshot, journal entry, and checksum; back up the intended
Neon database; apply the migration; verify journal/schema; then deploy the exact
CI-certified application commit and run the normal authentication, tenant,
games, schedule, canonical-review, and scheduler smoke checks.

Rollback is application roll-forward or reverting D1 application behavior
while retaining the nullable schema and references already written. Do not
reverse 0022 or delete payment/canonical evidence. The added event queries occur
only with real writes, so idle Neon compute receives no new query or timer and
autosuspension behavior is unchanged.

## Phase boundary

D1 does not add D2 eligibility, team snapshots, bowler obligations, collection
plans, occurrence allocations, direct payment/score occurrence columns,
historical linking, snapshot-version changes, consumer cutovers, reporting,
scheduler/provider behavior changes, production repair, migration execution,
or deployment. Those remain D2, E, F, or explicit production operations.
