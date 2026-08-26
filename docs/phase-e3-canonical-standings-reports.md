# Phase E3 canonical standings evidence contract

Phase E3 adds a versioned, read-only eligibility and result-evidence contract.
It deliberately does not calculate ranked standings. The application has no
durable matchup result model and no approved win, loss, tie, points, tiebreak,
or ranking policy. Returning a plausible table from score totals would invent
product policy and obscure that missing evidence.

The endpoint is `GET /api/leagues/:leagueId/standings`, with the optional
`organizationId` query parameter used for explicit tenant selection. Its
contract version is `league-standings/2`; ordering and fingerprint semantics
are independently versioned as `league-standings-order/1` and
`league-standings-fingerprint/2`.

Every successful response therefore returns:

- `ranking.state: policy_required`, a null policy version, the stable reason
  `MATCHUP_AND_RANKING_POLICY_REQUIRED`, and no ranking rows;
- the complete E1 physical schedule projection and its source decision;
- E2 games and reduced score evidence grouped by safe physical-session
  identity;
- explicit eligibility for every schedule row and result session;
- bounded, typed discrepancies plus an explicit truncation indicator; and
- a deterministic SHA-256 fingerprint over the full semantic evidence set.

There is no ranked UI in E3. The existing Bowler Scores average and all
financial, payment, receipt, and report behavior are unchanged. F1, not E3,
owns due and past-due reporting.

## One authoritative snapshot

The service reuses the E1 schedule snapshot builder and E2 game/score
projections with one passed database executor. The public endpoint owns exactly
one `REPEATABLE READ`, `READ ONLY` transaction for the complete E1/E2/E3
snapshot; the reused builders do not open nested transactions. It performs no
generation, backfill, repair, lock, update, insert, delete, payment action, or
provider call.

E1 remains the only source-selection authority:

- one complete published operational set selects `canonical`; and
- missing, partial, contradictory, or mixed operational evidence fails closed.

E3 never blends or derives a fallback schedule. Result sessions group only by
exact `games.occurrence_id` UUID and must resolve to exactly one occurrence in
the operational E1 set. A league without that evidence returns the generic
canonical incompatibility response.

Score evidence is reduced to stable IDs, score/handicap/average/position,
team number, vacant/absent/substitute flags, and lane. Bowler and team names,
frames, splits, notes, credentials, provider evidence, and payment details are
not exposed or fingerprinted.

## Eligibility semantics

Eligibility is evidence for a later approved standings policy, not a ranking.
For canonical occurrences, precedence is:

1. contradictory lifecycle/status/flag evidence fails closed;
2. `cancelled` is `excluded_cancelled`;
3. `competitive = false` is `excluded_noncompetitive`;
4. `countsInStandings = false` is `excluded_by_standings_flag`;
5. `scheduled` is `pending_not_completed`; and
6. only `completed`, competitive, standings-counting evidence is
   `eligible_result_input`.

A completed occurrence must be locked. A standings-counting occurrence must
be competitive. A cancelled occurrence must not be competitive, count in
standings, or retain a competition number. Violations are incompatible rather
than silently reclassified.

Occurrence kind is neutral: `regular`, `makeup`, `position_round`, `rolloff`,
`playoff`, and `extension` all follow the same explicit status and flag rules.
A makeup is its own physical UUID; the response includes safe
`makeup_for` relationship direction and related occurrence UUID, but never
substitutes the source occurrence's identity. Cancelled occurrences remain in
the evidence with their stable UUID and planned ordinal.

Stored schedule dates, week numbers, or score presence cannot substitute for
canonical occurrence evidence, so E3 does not promote incomplete evidence to
eligible result input.

## Discrepancies and incompatibility

Successful responses include deterministic information or warning evidence
for:

- missing ranking and matchup policy;
- completed eligible occurrences without games;
- completed eligible games without scores;
- scheduled occurrences with score evidence;
- excluded occurrences with score evidence; and
- duplicate `(team_id, position)` score slots within one game.

Duplicate score slots are warnings, not fatal. Equivalent discrepancy keys are
combined and their `evidenceCount` is summed. Scheduled-with-scores is
informational. Missing games and scores are warnings. None of these conditions
creates ranking rows or repairs source data.

The wire response includes at most 200 discrepancies. `summary.discrepancyCount`
counts the full combined set and `summary.discrepanciesTruncated` says whether
the response is bounded. The fingerprint includes the full, untruncated
semantic set, so two responses cannot appear equivalent merely because later
discrepancies were omitted from the wire representation. Generated time and
PII are excluded.

Unsafe E1, E2, or E3 evidence returns the single generic
`409 CANONICAL_STANDINGS_INCOMPATIBLE` response. Stable internal
classifications distinguish canonical schedule incompatibility, canonical
game/score incompatibility, occurrence flag contradictions, and missing or
ambiguous result occurrence identity. Logs contain only tenant/resource IDs,
bounded aggregate counts, classification, version evidence, and a
deterministic fingerprint. The endpoint does not disclose raw conflicting rows
or internal classifications to callers.

## Authorization and deterministic ordering

Authentication and password-rotation gating are inherited from the API. An
organization administrator can read a league in their organization. An
ordinary member must have an active `bowler_leagues` relationship to the exact
league. A system administrator must explicitly select one organization with
`?organizationId=<id>`; there is no implicit cross-tenant scan. Resource scope
mismatches use the nondisclosing not-found boundary. The global organization
session guard may reject a non-system caller's explicitly conflicting
organization query with 403 before the route; the route itself never uses that
query to grant authority.

Ordering is stable and declared in the response:

1. occurrences retain E1 physical ordering;
2. canonical result sessions use their occurrence order, while fallback
   sessions retain E2 first-game order;
3. games use game number then game ID;
4. scores use team number, team ID, position, then score ID; and
5. discrepancies use classification, stable identity, then game ID.

The fingerprint covers the contract, ordering, and fingerprint versions;
tenant/resource scope; source decision; ranking state; ordered occurrences,
sessions, games and reduced scores; the full discrepancy set; and summary.

## Validation, rollout, and rollback

E3 is code-only. Migration `0023_phase_d2_occurrence_financial_foundation`
remains the latest migration. E3 adds no schema, backfill, environment
variable, UI, worker, timer, payment, D2 writer, or provider integration.

Keep Render Auto-Deploy Off. Deploy only the exact CI-certified application
commit after confirming migration 0023 is present. The minimum authenticated
smoke matrix is:

1. `/api/health`, login, and password-rotation gating;
2. ordinary active member and organization-administrator reads for one
   canonical league and one fallback league;
3. explicit organization selection by a system administrator, plus inactive
   member and cross-tenant denials;
4. canonical UUID grouping, canonical eligibility, independent fallback
   identity domains, `ranking.state = policy_required`, and no ranking rows;
5. stable fingerprints across repeated reads and explicit bounded discrepancy
   evidence;
6. a generic 409 against deliberately incompatible non-production fixture
   evidence;
7. before/after proof that schedule, game, score, D2 financial, payment, and
   payment-operation evidence is unchanged; and
8. unchanged Bowler Scores average, financial reports, receipts, refunds,
   webhooks, and provider behavior.

Application rollback to E2 is schema-compatible. Leave migration 0023 and all
canonical/game/score evidence intact; do not remove occurrence links, rewrite
legacy rows, or manufacture result certainty. E3 has no data mutation to undo.
A later ranked-standings phase must first approve and version the missing
matchup and ranking policy, then cut consumers over without changing the
meaning of `league-standings/2`.
