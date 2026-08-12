# Phase E2 canonical games and scores

Phase E2 cuts game and score identity to canonical physical occurrences when
an operational canonical schedule exists. Scores continue to inherit physical
identity only through `scores.game_id`; there is no `scores.occurrence_id`.
Standings, reports, payment behavior, and the dormant D2 financial model are
outside this phase.

## Authoritative source selection

Games and scores reuse the E1 `league-occurrence-schedule/1` snapshot builder
inside repeatable-read read transactions and locked mutation transactions.
There is no second definition of operational canonical state:

- one published or locked operational set selects `canonical`;
- draft-only, rejected, revoked, discarded, and superseded evidence selects
  explicit `legacy_fallback`;
- published/locked rows, generation-run counts, exceptions, relationships,
  billing summaries, or linked activity that do not form one safe E1 set fail
  closed; and
- canonical and legacy rows are never blended.

E2 responses use `canonical-games-scores/1` and
`canonical-games-scores-order/1`. They state `authoritativeSource` and retain
the complete bounded E1 occurrence projection on every canonical nested game.
Legacy games have `identitySource: legacy_projection`, a deterministic
`legacyProjectionKey`, and no fabricated UUID or canonical time evidence.
Reads do not generate, backfill, repair, lock, or otherwise mutate schedule,
game, score, payment, or D2 rows.

## Canonical game and inherited score identity

For a canonical league, every game must have one non-null
`games.occurrence_id` that identifies an occurrence in the authorized league's
operational E1 set. The retained `week_number` and `date` are compatibility
projections and must exactly agree with that occurrence's competition number,
stored authoritative local date, and meaningful canonical start. Planned
ordinal is never used as competition number.

Canonical uniqueness is `(occurrence_id, game_number)`. Multiple game numbers
may share one occurrence. Creation and update acquire the existing
organization/league schedule advisory lock, validate the complete operational
set, lock duplicate candidates, and persist the exact link in the same
transaction. The lock serializes supported concurrent creates, so E2 needs no
new unique index or migration. A non-null link cannot move to another
occurrence, league, or tenant. Because deletion would erase effective-lock
evidence and there is no audited game-deletion command, linked-game deletion is
rejected.

New games require a scheduled operational occurrence. Cancelled, completed,
draft, discarded, and rejected occurrences do not accept a new game.
Completed operational occurrences and their existing games remain readable.
Cancelled occurrences retain UUID and planned ordinal. Audited makeup and
special sessions use their own UUID and may carry their own distinct
competition number; they never impersonate the cancelled/source occurrence.

Scores contain no competing occurrence column. Canonical nested score rows
carry the linked game projection, so the occurrence UUID survives every score
read. Score storage is not filtered by `countsInStandings`; `competitive` and
`countsInStandings` remain distinct schedule attributes for E3 to interpret.

## Access contracts and compatibility adapters

`GET /api/games` accepts an authorized `leagueId` plus at most one of
`weekNumber` or `occurrenceId`. `GET /api/scores` has the same selection shape,
and the existing `GET /api/scores/league/:leagueId/week/:weekNumber` path is a
compatibility adapter. On a canonical league, a week adapter resolves only
when exactly one operational occurrence has that competition number. Missing
or ambiguous mappings return 409; no row-order, date-proximity, kind, planned
ordinal, or roster heuristic is used.

Canonical ordering is the E1 physical occurrence order, followed by game
number and stable game ID, then team number, position, and stable score ID.
Legacy game ordering retains the prior week-specific game-number order and the
prior all-games reverse-date order with stable IDs as final ties.

`GET /api/scores/history?bowlerId=...` returns authorized league history. The
client groups canonical sessions by occurrence UUID. Fallback rows use the
server-provided deterministic legacy projection key. It does not independently
derive canonical identity from week/date.

## Score writes, authorization, and atomicity

`POST /api/scores/batch` validates a bounded non-empty array through the
existing shared score schema before any write. The route derives organization
scope from the authenticated session; a system administrator must explicitly
select one organization. It then verifies all game IDs in that tenant and the
caller's visibility for every referenced league.

One transaction acquires league advisory locks in numeric order, locks games,
teams, bowlers, and active roster relationships deterministically, revalidates
the E1 source and every canonical game link, and inserts the whole batch only
after all entries pass. A normal score requires an active bowler/league/team
relationship. A substitute may use a different scoring team only when the
bowler has an active membership in the same league. Cross-tenant, cross-league,
foreign game, team, or bowler IDs fail without exposing foreign names or
organization details. Any invalid entry rolls back the entire batch.

Authentication, password-rotation gating, ordinary-member league visibility,
organization-administrator scope, and explicit system-administrator scope are
preserved. Client-provided identifiers only select candidates and never grant
authority. Unauthorized cross-tenant league reads use the same not-found
boundary.

## Incompatibility and duplicate evidence

Canonical evidence failures return
`409 CANONICAL_GAMES_SCORES_INCOMPATIBLE`. Stable internal classifications are
defined by `CANONICAL_GAMES_SCORES_INCOMPATIBILITY_CLASSIFICATIONS`, including
unlinked games, out-of-scope/non-operational links, legacy projection mismatch,
unsupported linked-game deletion, duplicate occurrence/game identity,
duplicate legacy keys, and absent or ambiguous competition mappings. Logs contain only safe organization/league
scope, bounded game/score counts, classification, contract/fingerprint
versions, and a deterministic SHA-256 fingerprint. They exclude raw rows,
bowler details, credentials, tokens, provider payloads, and payment evidence.

An operational canonical league with an unlinked or duplicate historical game
fails closed. E2 never chooses one duplicate and never writes a guessed link.
Existing duplicate `(league_id, week_number, game_number)` groups on fallback
leagues remain untouched legacy evidence and remain readable through the
explicit fallback path. Cutting such a league to canonical requires an
explicit reviewed resolution before E2 can serve it safely.

## Migration, rollout, rollback, and phase boundary

E2 is code-only. Migration `0023_phase_d2_occurrence_financial_foundation`
remains the latest migration. The nullable `games.occurrence_id`, restrictive
same-league foreign key, index, and schedule advisory lock from 0022 are
sufficient. There is no schema change, data statement, repair script,
production backfill, startup scan, environment variable, worker, timer, or
provider call. Production aggregate evidence indicates the operational
canonical league has no games, so rollout needs no game backfill; the six
legacy duplicate groups remain unresolved and unmodified.

Deploy the exact CI-certified application commit only after confirming the
already-required 0023 schema. This code-only release does not authorize a Neon
migration or a Render Auto-Deploy change. Smoke-test:

1. `/api/health`, login, and password-rotation gating;
2. ordinary member, organization administrator, and explicitly scoped system
   administrator reads for a fallback league and an operational canonical
   league;
3. canonical games by occurrence UUID and by exact competition adapter;
4. canonical nested scores and bowler history UUID grouping;
5. one valid atomic score batch plus invalid game/team/bowler and mixed-tenant
   batches with zero partial inserts;
6. a bounded 409 for deliberately incompatible non-production fixture
   evidence; and
7. unchanged schedule mutation effective locks, payment schedules/operations,
   refunds, receipts, webhooks, and empty/dormant D2 writers.

Application rollback to E1 is schema-compatible because E2 adds no migration.
It restores legacy game/score consumers while retaining any exact
`games.occurrence_id` values written by E2; D1-era code accepts those links.
Do not delete links, reverse 0022/0023, or rewrite canonical evidence as a
rollback technique.

E3 owns standings inclusion and reporting. E2 does not define standings
policy, infer historical identity, activate obligations or allocations, infer
payer responsibility, alter payment/provider behavior, or repair production
duplicates.
