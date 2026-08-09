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
an explicit billing amount (zero for `none`, positive PostgreSQL-safe for
`eligible_bowlers`), uppercase currency, regular billing policy,
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

Generation keys use the separate `canonical-occurrence-physical-key/1` seed,
which covers tenant/league/location, season start, weekday, local time,
canonical timezone, planned slots, skip dates, cancelled dates, and explicit
special-session behavior. It excludes amount, currency, billing policy and
ordinal policy, expected `seasonEnd`, fold policy, and
`sourceScheduleRevision`; the last two are resolver/provenance attributes and
must not duplicate a physical B2 row when those attributes change. The full
input fingerprint still covers every normalized semantic input. Keys are
deterministic, league-scoped candidate attributes; they are not occurrence
identity and no UUID is assigned. Skip candidate keys use the same physical
seed plus their stable in-memory candidate reference. A1 has no exception
`generation_key` column, so a later materializer must associate them through
the generation run and candidate metadata.

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
`lockLeagueSchedule` before tenant-scoped reads/writes. Operation-specific
versioned command fingerprints cover the complete semantic payload rather than
trusting a caller hash. Same-key/same-payload retries converge; a same-key
payload change fails closed. The placement, exception, and makeup APIs also
provide a transaction-scoped callback that holds the advisory lock through
validation and the caller's eventual B2 mutation. Their standalone validators
are explicitly preflight-only. A same-key retry always revalidates current
state; only rows already attributed to that same command are excluded as its
own atomic result, so a preflight command cannot hide later competing state.
Occurrence placement accepts only generation and publication commands;
rescheduling uses its dedicated complete local-date/time/timezone/fold
contract. Validation covers same-day and league-wide
exact-start collisions, audited distinct-time overrides, exception overlap,
makeup source/target/cancelled-target rules, serialized source revisions,
rescheduling, cancellation, and atomic draft discard. Rescheduling derives and
verifies every DST tuple through the shared resolver. Only same-tenant
`org_admin` and the explicit platform `system_admin` path may mutate. Discard
retains the UUID and generation key, clears ordinals, supersedes current draft
terms, advances and records entity revisions, and commits all work in one
transaction. Activity evidence is an explicit caller-supplied audited input;
no payment linkage is inferred from date proximity.

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
With `regularSessionBillingPolicy=none`, the operator accepts a zero legacy
weekly fee (and the pure generator emits zero/null nonbillable terms); a
positive legacy fee remains an explicit semantic conflict and fails closed.
The operator uses one dedicated PostgreSQL `REPEATABLE READ, READ ONLY`
transaction, selects the league/location with organization, league, and
location tenant scope together, invokes only the pure generator, emits stable
semantic JSON to stdout, and rolls back/closes without writes. Legacy
`doublePayDates` appear only in `legacyCollectionEvidence` with an explicit
exclusion marker.

A2 ends before B1 comparison and B2 materialization. Migration 0018 remains
unchanged and is the only schema foundation used by these dormant services.
