# Phase A1 canonical league-occurrence foundation

Phase A1 adds a dormant, additive PostgreSQL foundation for canonical physical
league occurrences. It introduces schedule commands, generation runs,
durable schedule exceptions, occurrences, separate billing terms, makeup
relationships, four typed revision tables, and generation discrepancies. No
route, scheduler, generator, backfill, payment, scoring, standings, or
reporting behavior reads or writes these tables in A1.

## Contract boundaries

- Every A1 row is tenant-owned and carries `organization_id` and `league_id`.
  Composite foreign keys prove that linked leagues, locations, commands, runs,
  exceptions, occurrences, relationships, terms, revisions, and discrepancies
  belong to the same tenant and league. Durable parent and actor links use
  `ON DELETE RESTRICT`.
- A skipped local date is represented by a durable `skip` exception; A1 does
  not create an occurrence for that date. Exception-versus-occurrence overlap,
  makeup source/target kind checks, cancelled-target checks, and schedule
  revision allocation remain transactional A2 service validation.
- A draft discard must be one PostgreSQL transaction: discard the occurrence
  and clear its provisional ordinals, supersede every current draft term,
  advance and record the occurrence revision, and record one revision for each
  superseded term. Indexed current-term lookup, one-current-term uniqueness,
  coherent supersession metadata, typed revision FKs, and revision uniqueness
  are the A1 structural support. A cross-table CHECK is not an atomicity
  mechanism; A2 owns the transaction service.
- Discarded drafts retain their UUID and globally unique generation key while
  their current ordinals are cleared; their former values remain in revisions.
  A2 mutation enforcement must treat that state as terminal and reject revival.
- Occurrence rows contain physical-session identity and structural local/UTC
  time fields only. They contain no amount, currency, billing ordinal,
  collection multiplier, payment identity, provider identity, or bowler
  obligation. Billing terms are separate and do not contain an occurrence
  multiplier.

## DST boundary

A1 checks only structural values: date/time/timestamptz types, a nonempty
IANA-shaped timezone string, an offset in the supported numeric range, a valid
fold enumeration, and nonempty resolver-version text. PostgreSQL CHECKs do not
prove that local date/time, timezone, selected offset, fold, and UTC instant
correspond. A2 must provide IANA lookup, gap rejection, fold selection,
local-to-UTC derivation, selected-offset verification, round-trip validation,
and resolver-version behavior.

## Teardown and deployment

Organization deletion explicitly removes A1 data in child-before-parent order:
discrepancies, all four revision tables, relationships, billing terms,
exceptions, occurrences, generation runs, and schedule commands, followed by
existing league/location/user/organization teardown. It remains one atomic
transaction, preserves and detaches platform `system_admin` accounts, and
deletes commands before their restrictive actor FKs can block tenant teardown.

Migration 0018 is forward-only and additive. It must be reviewed and applied
only after the matching application/schema release is available. Do not use
`db:push` or apply the migration to a durable/shared database during A1 review.
Rollback is restore-based: do not edit or reverse an applied migration; back up
the target database and use the documented restore plan if a release must be
backed out.
