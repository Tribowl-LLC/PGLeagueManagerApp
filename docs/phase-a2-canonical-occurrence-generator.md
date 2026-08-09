# Phase A2 canonical occurrence generator and dormant invariants

Phase A2 adds reusable, dormant generation semantics around the additive A1
tables. It does not compare history, materialize canonical rows, alter legacy
payment/game/schedule flows, or add a route, worker, scheduler, provider call,
or migration.

## Pure contracts

The versioned contracts are `canonical-occurrence-input/1` and
`canonical-occurrence-generation-result/1`. The implementation versions are
`canonical-occurrence-generator/1` and
`canonical-dst-resolver/1;icu=<runtime>;tzdata=<runtime>`. The generator accepts
positive tenant/location IDs, an explicit positive source schedule revision,
calendar season bounds, weekday, local start time, IANA timezone, planned slot
count, structured skip exceptions, cancelled dates, an explicit fold policy,
positive weekly minor amount, uppercase currency, regular billing policy,
billing ordinal policy, and the explicit `regular_only/1` special-session
behavior.

Input normalization trims and validates scalar values, canonicalizes recognized
timezone aliases through ICU, canonicalizes calendar dates and local times,
sorts exception/cancellation arrays, and preserves duplicate multiplicity.
The fingerprint is lowercase SHA-256 over canonical UTF-8 JSON with recursively
sorted object keys. Duplicate or otherwise fatal input is never deduplicated and
returns zero candidates, while its normalized duplicate evidence receives a
different fingerprint from valid deduplicated input.

Generation stops only after the planned-slot count is consumed. A skip emits a
separate exception candidate, consumes no slot, and extends the examined weekly
calendar. A cancellation consumes a slot, retains its planned ordinal, clears
its current competition number, and is noncompetitive/non-standings. The
competition sequence advances across that slot. Billing terms are separate
candidates: `planned_slot` ordinals retain cancellation gaps, while
`dense_billable` is explicit and versioned. Cancellation terms are `none`, zero,
and null ordinal. Legacy double-pay data is not a generator input and cannot
affect a fingerprint, physical candidate, numbering, term, or amount.

Generation keys are deterministic, league-scoped candidate attributes that
include the generator/fingerprint context, kind, date, and planned ordinal;
they are not occurrence identity and no UUID is assigned. Skip candidate keys
are in-memory contract metadata only: A1 has no exception `generation_key`
column, so a later materializer must associate them through the generation run
and candidate metadata.

## DST proof

`resolveCanonicalLocalDateTime` parses date and wall-clock fields independently
of host `TZ` and locale, canonicalizes IANA aliases, enumerates all A1-supported
minute offsets, and formats each candidate back through the canonical zone.
Zero round-trips are fatal gaps; one is unambiguous; two require explicit
`earlier` or `later`. The result contains the exact UTC instant, A1-signed
offset minutes, fold result, canonical zone, and an algorithm/ICU/tzdata
resolver version no longer than 128 characters.

## Dormant transaction services

`server/services/canonical-occurrence-transactions.ts` acquires
`lockLeagueSchedule` before tenant-scoped reads/writes. It validates same-day
and exact-start collisions, audited distinct-time overrides, exception overlap,
makeup source/target/cancelled-target rules, command idempotency/fingerprint
coherence, serialized source revisions, rescheduling, cancellation, and atomic
draft discard. Idempotent retries return the committed command/entity; a key
with another fingerprint fails closed. Discard retains the UUID and generation
key, clears ordinals, supersedes current draft terms, advances and records
entity revisions, and commits all work in one transaction. Activity evidence is
an explicit caller-supplied audited input; no payment linkage is inferred from
date proximity.

## Read-only operator

The standalone entry point is:

```text
DATABASE_URL=<verified disposable/read-only target> \
  npx tsx scripts/generate-canonical-occurrences.ts \
  --organizationId=<id> --leagueId=<id> --sourceScheduleRevision=<id> \
  --ambiguousFold=reject|earlier|later \
  --currency=ABC \
  --regularSessionBillingPolicy=none|eligible_bowlers \
  --billingOrdinalPolicy=planned_slot|dense_billable
```

The fold flag defaults to `reject`. Billing flags are explicit because the A1
league table does not contain authoritative currency or canonical billing-policy
columns; omission fails closed rather than inferring USD or a collection plan.
The operator uses one dedicated PostgreSQL `REPEATABLE READ, READ ONLY`
transaction, selects the league/location with organization, league, and
location tenant scope together, invokes only the pure generator, emits stable
semantic JSON to stdout, and rolls back/closes without writes. Legacy
`doublePayDates` appear only in `legacyCollectionEvidence` with an explicit
exclusion marker.

A2 ends before B1 comparison and B2 materialization. Migration 0018 remains
unchanged and is the only schema foundation used by these dormant services.
