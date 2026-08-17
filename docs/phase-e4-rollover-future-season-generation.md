# Phase E4 rollover and future-season generation

Phase E4 makes authoritative league creation and season rollover create a
complete canonical draft set for every wholly future Winter, Spring, Summer,
and Fall season. It reuses the C1/A2 generator, mapping, transaction locks, and
C2 mutation engine. It does not add a standalone non-Fall recovery generator,
rewrite historical Fall evidence, or activate any financial consumer.

## Versioned contracts

New setup writes use `league-setup-integration-request/2` and return
`league-setup-integration-result/2`. Their generated set is recorded with:

- result `future-season-draft-generation-result/1`;
- implementation `future-season-draft-generation/1`;
- mapping `canonical-draft-mapping/1`; and
- input snapshot `future-season-draft-generation-input-snapshot/1`.

The setup-only input snapshot records the v2 setup confirmation fingerprint,
product-season classification, explicit payment mode, candidate-set
fingerprint, and normalized A2 input. Non-Fall evidence is never stored under a
Fall generation snapshot. Existing Fall preview/apply v1-v3 contracts and
readers remain unchanged. Setup request v1 is accepted only when its derived
command already owns one exact historical Fall setup result; it cannot create
new state.

E4 sets are reviewed through `canonical-draft-review/1` and strict versioned
canonical mutation requests under `/api/leagues/:id/canonical-drafts/review`.
Those routes reuse the C2 mutation transaction and persistence algorithm with
generic command fingerprints and audit payloads. The old
`canonical-fall-drafts` routes remain limited to historical Fall snapshot
families. There is no generic preview/apply endpoint.

## Explicit target and confirmed carried configuration

The v2 rollover request strictly requires `seasonStart`, `totalBowlingWeeks`,
`weekDay`, all three schedule-date arrays, `allowPublicSignup`, and
`paymentMode`. The server derives `seasonEnd`; omitted, unknown, defaulted, and
retired fields fail validation. Weekly and upfront both retain the hardcoded
`eligible_bowlers` occurrence policy. Ambiguous folds are rejected, currency is
USD, and billing ordinals are `dense_billable`. Double-pay dates remain
collection grouping evidence and do not affect physical generation.

An authorized read of
`GET /api/leagues/:id/new-season/source-confirmation` returns a sanitized
`league-rollover-source/1` snapshot and fingerprint. It contains only source
organization/league identity and the stable configuration to be copied: name,
description, location, timezone, practice/competition times, and the three fee
fields. It excludes provider, payment, roster, bowler, command, and secret
data. Its fingerprint additionally binds the source season version and the
complete ordered team/roster copy semantics without disclosing that hidden
preimage. The UI displays the stable league configuration, warns that Square
catalog identity will reset, and requires explicit confirmation.

The write takes the setup-key lock, source schedule lock, reauthorizes, and
re-reads the source `FOR UPDATE`. It recomputes the source fingerprint and
fails stale when it differs. The source location and every copied bowler/team
relationship are re-proved in the authorized tenant.

## Atomic rollover and non-copy boundary

After proof, the transaction inserts the target, locks it, copies teams with
new IDs, copies every active/inactive roster membership with the same bowler,
mapped team, active/order values and original `joinedAt`, generates new
canonical UUIDs and revision-1 evidence, then archives the source last. Any
failure rolls back the target, copied structure, canonical set, and archive.
Identical v2 retries return the original target and canonical IDs with zero
writes. Changed semantics conflict; competing successor keys serialize and at
most one commits.

All seven league Square catalog/category identity fields are null on the
target. Rollover never copies occurrence IDs, commands, runs, revisions,
relationships, discrepancies, games, scores, payment schedules or operations,
provider ledger identity, D2 eligibility/assignment/obligation/plan/allocation
evidence, refunds, disputes, webhooks, or historical payment certainty. The
existing bowler external resync remains post-commit only and is skipped on a
zero-write retry. No provider is called in the database transaction.

## Compatibility and release

E1 administrator evidence identifies whether the one reviewable run uses the
historical Fall or E4 generic family. Drafts remain non-operational. After the
generic C2 route approves and publishes them, E1 selects the published UUID set
exclusively and legacy schedule arrays are not blended.

E4 has no migration, backfill, environment variable, startup scan, worker,
scheduler, or provider behavior change. Migration 0023 remains latest. Deploy
only the CI-certified main commit after the existing 0023 gate, with Render
Auto-Deploy off. Rollback is application-only and leaves all versioned evidence
intact; never delete an E4 set or reinterpret it as historical Fall evidence.
