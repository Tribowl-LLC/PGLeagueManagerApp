# Phase B1 Completed-Summer comparator

Phase B1 is a deterministic, read-only historical comparison. It selects an
explicit tenant and Summer cohort, runs the Phase A2 pure canonical generator
in memory, compares its candidates with legacy schedule/game/score/payment
evidence, and emits a versioned JSON report for human review before B2. It
does not materialize or modify any canonical or legacy row.

## Operator

```text
DATABASE_URL=<verified local/read-only target> \
  npx tsx scripts/compare-completed-summer-occurrences.ts \
  --organizationId=<positive integer> \
  --seasonYear=<four-digit year> \
  --asOfDate=<YYYY-MM-DD> \
  [--leagueId=<positive integer>] \
  --sourceScheduleRevision=<positive integer> \
  --ambiguousFold=reject|earlier|later \
  --currency=ABC \
  --regularSessionBillingPolicy=none|eligible_bowlers \
  --billingOrdinalPolicy=planned_slot|dense_billable
```

`organizationId`, `seasonYear`, `asOfDate`, source revision, currency, and
billing policies are required. `ambiguousFold` safely defaults to `reject` but
is always recorded. Currency and billing behavior are never inferred.
`leagueId` narrows the cohort only after its tenant is proven in the same
snapshot. A missing, org-less, cross-tenant, or ineligible explicit league
produces a deterministic fatal result; another league is never substituted.

The operator owns one dedicated `pg.Client` and one
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction.
All evidence is loaded from that snapshot. The transaction is always rolled
back and the client is closed on success and failure. Semantic canonical JSON
goes to stdout; diagnostics go to stderr. There is no apply mode and no output
file is written unless the operator redirects stdout.

## Selection contract

The contract is `completed-summer-selection/1`.

A selected league must have `leagues.organization_id` equal to the explicit
organization and a non-null location whose organization is equal to both the
league and operator organization. The stored season timestamps are converted
to date-only values by validating and taking their leading `YYYY-MM-DD`
calendar fields; neither the host timezone nor an instant conversion can move
the boundary.

Summer follows the current `getSeasonLabel` product semantics exactly:

- the start and end date are in the same calendar year;
- the start month is June, July, or August;
- the start year equals the explicit `seasonYear`; and
- cross-year seasons are not Summer.

Completed means `seasonEnd` is strictly earlier than `asOfDate`. Equality is
not completed. `active` is reported as archive evidence and is not a filter;
both active and archived qualifying leagues are included. A selected league
must also have every authoritative field required by the shared A2
league-to-generator input loader.

## Report and fingerprint

The report contract is `canonical-occurrence-comparison-report/1`; the
implementation version is `completed-summer-comparator/1`. The report records
normalized operator inputs, A2 generator/result/resolver versions, selection
counts, ordered league reports, aggregate classifications, and ordered fatal
errors. Per-league output includes selection proof, raw and normalized legacy
schedule evidence, the complete safe A2 generation result and DST tuple,
grouped games/scores, sanitized payments and operations, existing A1 counts,
matches, discrepancies, and summary counts.

The lowercase report fingerprint is SHA-256 over UTF-8 canonical JSON after
removing `reportFingerprint`. Object keys are recursively lexicographically
sorted. Every semantic array is explicitly sorted by its stable domain key
before canonicalization. Semantic output contains no run time, random ID,
process ID, database address, or execution metadata. The CLI writes that same
canonical JSON representation, so identical inputs and an unchanged snapshot
produce byte-for-byte identical stdout and the same fingerprint.

## Legacy matching

The pure comparator uses these rules in order:

1. Games are first grouped by `(league_id, week_number, game_number)`. Every
   duplicate key retains all game and score IDs and is reported before match
   classification. Sessions are grouped by league and legacy week number;
   multiple dates within one session are a conflict and cannot be selected by
   row ID or array order.
2. A canonical candidate uses a legacy session only when exactly one session
   has the same mechanically extracted date. A legacy timestamp can carry a
   separately proven UTC start in the pure contract, but database game rows do
   not currently have that reviewed proof and are marked
   `mechanical_date_only`.
3. The legacy week number is compared with the canonical competition number
   only after the unique date match. A unique week-number similarity on a
   different date is only a `local_date_mismatch` hint; it is not a match.
4. Multiple plausible sessions remain unmatched. No lowest-ID, first-row, or
   nearest-date winner is chosen.
5. A cancelled occurrence preserves its planned ordinal and expects no game
   or score activity. A skip candidate creates no occurrence. Activity on
   either date is reported with the appropriate conflict code.
6. Unmatched scheduled canonical candidates are missing; unmatched legacy
   sessions are unexpected. Game numbers 1 through 3 are inspected, and
   missing numbers are reported without manufacturing rows.
7. Payment evidence never participates in occurrence matching. A game or date
   match cannot imply a payment allocation.

Implemented classifications are `exact_match`, `missing_expected_session`,
`unexpected_legacy_session`, `local_date_mismatch`,
`start_instant_mismatch`, `legacy_start_time_unproven`,
`competition_number_mismatch`, `duplicate_historical_game_key`,
`legacy_game_number_missing`, `legacy_session_date_conflict`,
`skip_exception_conflict`, `cancelled_session_activity`,
`same_day_collision`, `exact_start_collision`, `generator_fatal_error`,
`generator_discrepancy`, `ambiguous_historical_payment`,
`proven_payment_operation_evidence`, and
`invalid_or_cross_tenant_evidence`. A2 discrepancy codes and details remain
visible inside `generator_discrepancy` evidence.

## Evidence and privacy boundary

Schedule evidence includes IDs, archive state, season lineage, raw/date-only
season bounds, weekday, weeks, local start time, timezone, skips,
cancellations, weekly fee, and payment mode. Legacy double-pay dates live only
under `legacyCollectionEvidence` and are explicitly excluded from generator
input, physical matching, fingerprints, and billing-term amounts.

Game evidence includes game IDs, logical keys, week/game numbers, raw stored
timestamp text, mechanical dates, score IDs/counts, and activity flags. It
excludes bowler/team names, score values, frames, notes, and full score
payloads.

Payment evidence includes payment IDs, safe status/type/amount/week fields,
operation IDs, allocation indexes and safe amounts, immutable snapshot kind
and version, operation cycle/status/currency, and sanitized refund/dispute
state. A direct legacy `payments.week_of` remains ambiguous. An immutable
scheduled or interactive snapshot plus a same-tenant operation and allocation
is proven path-specific operation evidence, not proof of an occurrence
obligation. Refund snapshots and disputes retain operational state without
creating a link.

The report excludes encrypted fields, source/card/customer IDs, provider
object/order/location/application/merchant/payment/dispute IDs, idempotency
keys, fingerprints from payment execution, emails, receipts, check numbers,
authorization data, provider payloads, notes, and payment/bowler identities
that are unnecessary for this comparison. It never imports decryption or a
provider adapter.

Games and scores are reached only through selected leagues. Payments are
reached through selected leagues. Payment operations are accepted only through
a selected-league snapshot, a matching operation organization, and a
tenant-proven location; scheduled paths additionally prove the schedule's
league, refund paths prove the payment's league, and linked payment allocations
must exist in the accepted operation evidence. Contradictions fail closed and
foreign details are suppressed.

Existing A1 commands, generation runs, exceptions, occurrences, billing
terms, relationships, and discrepancies are reported as counts only. B1 does
not call the mutation-oriented canonical transaction services and does not
write commands, runs, candidates, evidence, allocations, or discrepancies.
