# Phase C2: audited Fall draft review, editing, approval, and rejection

Phase C2 is the tenant-scoped administrative transition from one persisted C1
Fall generation run to either a published canonical schedule or a terminal
rejected draft set. It also supports narrow audited future-occurrence edits
before approval and future edits to published occurrences from that same run.
It does not reinterpret B2 history or activate canonical consumers.

## Contracts and versions

- review: `fall-draft-review/2`
- semantic review fingerprint: `fall-draft-review-fingerprint/2`
- mutation result: `fall-draft-mutation-result/2`
- reschedule request: `fall-draft-reschedule-request/2`
- cancellation request: `fall-draft-cancel-request/1`
- restoration request: `fall-draft-restore-request/1`
- approval/publication request: `fall-draft-approve-request/1`
- rejection request: `fall-draft-reject-request/1`
- discrepancy revision snapshot: schema version 1,
  `fall-draft-discrepancy-revision/1`
- occurrence, billing-term, and exception revision snapshots continue to use
  the C1 schema-version-1 contracts
- command fingerprint envelope remains `canonical-occurrence-command/1`, stored
  as `lvcanoncmd:v1:<lowercase-sha256>`

All request schemas are strict. Every mutation requires a server-authorized
tenant and league, authenticated actor, trimmed nonempty reason, idempotency
key, and confirmed current review fingerprint. An entity edit also requires
the occurrence's exact current revision. The caller cannot select actor,
tenant, authoritative `now`, command attribution, durable state, or ambiguous
fold handling. Fall rescheduling always uses `ambiguousFold = "reject"`.

## Persisted review and fingerprint

`GET /api/leagues/:id/canonical-fall-drafts/review` reloads and verifies the
single versioned C1 input snapshot and regenerates it through the merged A2
implementation. The read fails closed for another generation run, extra or
partial occurrences, terms or exceptions, relationships, generation-key
mismatch, unsupported command attribution, missing revisions, a non-contiguous
revision chain, a before/after discontinuity, or a latest revision that does
not equal the current row.

Semantically compatible C1 input snapshot version 1 remains reviewable through
the zero-write compatibility reader. It must already record the system-wide
reject-fold, USD, and eligible-bowler policies; C2 supplies the league's current
authoritative `payment_mode` only in memory and does not alter the stored legacy
snapshot. Any version-1 snapshot with different generator semantics remains an
explicit incompatible-state failure.

The response contains:

- the current generation run, authoritative league payment mode, and C1/A2 input, physical, candidate, preview,
  generator, result, and DST versions/fingerprints;
- current occurrences with UUID, immutable generation key, physical and DST
  tuple, lifecycle/status, planned/competition numbering, effective-lock
  eligibility, current revision, lifecycle attribution, and every revision;
- separate current billing terms, billing numbering, state, publication
  attribution, and every revision;
- separate skip exceptions, lifecycle attribution, and every revision;
- discrepancies, current evidence, resolution eligibility/state, and every
  resolution revision;
- commands and actor attribution required to verify the current state; and
- current legacy-input fingerprint and match/staleness evidence.

The review fingerprint is lowercase SHA-256 over canonical sorted-key JSON for
the complete persisted review plus `fall-draft-review-fingerprint/2`. Durable
entity IDs, generation keys, numbering, DST tuples, snapshots, evidence,
commands, reasons, request fingerprints, and lifecycle attribution are bound.
The response's runtime-derived `effectivelyLocked` booleans are deliberately
excluded: eligibility is always recomputed from PostgreSQL transaction time.
Raw actor/user identifiers are also excluded from the semantic projection;
audited attribution remains present in the review and command records, while
the fingerprint contains no personal identity field.
No clock value used only for eligibility, newly generated request key, secret,
provider data, payment identity, bowler identity, or payment allocation enters
the semantic fingerprint.

## Locking, time, authorization, and idempotency

Every mutation runs in one read-write transaction under the shared league
schedule advisory lock. It reauthorizes the actor, locks and reloads the full
C1 set and revision chains, reads `transaction_timestamp()` inside that
transaction, rebuilds the review fingerprint, and compares the caller's
confirmation. The start boundary is inclusive: `start_at <= transaction time`
is effectively locked.

Only a same-tenant `org_admin` and a platform `system_admin` with an explicit
`?organizationId=<id>` scope are allowed. `filterByOrganization`, the normal
authenticated route family, and CSRF middleware remain in force. Normal users,
cross-tenant administrators, org-less resources, missing leagues, foreign
runs/entities, and client identity claims fail closed.

Operation fingerprints cover the versioned request, actor, tenant, reason,
review fingerprint, expected revision where applicable, and complete semantic
payload. Approval creates distinct `approve_generation` and `publish`
commands; the publication idempotency key is deterministically derived from
the operator key. Exact retries verify the complete committed lifecycle result
and return its original command/entity IDs with zero writes. A changed payload
under the same key conflicts. League locking serializes edit/edit,
edit/approval, approval/approval, and rejection/approval races so at most one
competing transition applies.

## Supported future edits

### Reschedule

Reschedule supports only a scheduled C1 draft or future published C1
occurrence. It preserves UUID, generation key, run, kind, location, planned
ordinal, competition number, competitive/standings flags, and billing terms.
The shared canonical DST resolver derives local date/time, canonical IANA
timezone, selected offset, fold result, UTC instant, and resolver version.
Gaps and ambiguous folds are rejected under the fixed Fall policy. Optional caller assertions must equal
the resolver exactly. Active same-day, league-wide exact-start, and exception
collisions are rejected. One complete occurrence revision is appended.

### Cancel

Cancellation supports only a scheduled C1 draft or future published C1
occurrence. Locked, started, completed, cancelled, discarded, and otherwise
terminal rows fail. UUID, generation key, run, kind, location, and planned
ordinal are preserved. Competition numbering is cleared and the row becomes
noncompetitive/non-standings. Its current term becomes `none`, zero amount,
and null billing ordinal. Draft `dense_billable` terms are renumbered densely
in planned order with a complete revision for each changed term;
`planned_slot` leaves unaffected ordinals unchanged. Published numbering is
never renumbered. Cancellation metadata uses the database action time and the
truthful `cancel` command.

### Restore

Restoration is draft-only and is unavailable after publication. A cancelled
C1 occurrence is proven by run membership, generation key, regenerated C1/A2
semantics, and its verified revision chain. The regular-session competitive
flags and competition number are restored from its planned-slot semantics.
Policy, amount, currency, and planned/dense billing ordinal are rebuilt from
the versioned C1 normalized input, whose Fall currency policy is fixed to USD;
affected dense draft terms are revised.
Current cancellation metadata is cleared while its prior value remains in the
append-only occurrence revision. Collision and future checks are repeated.
The operation uses the truthful `restore_cancelled_draft` command.

Arbitrary occurrence creation, makeups, skip editing, draft deletion, billing
policy redesign, and published restoration are not C2 operations.

## Discrepancy disposition

Approval requires one disposition for every current open discrepancy, with no
duplicates, omissions, unknown IDs, or extras. The exact sorted IDs, selected
states, current evidence, and review fingerprint are bound by the approval
command. `waived` knowingly accepts remaining evidence. `resolved` is allowed
only when current durable state proves the code's condition is corrected:

- `outside_season_occurrence`: no non-discarded occurrence remains after the
  stored C1 season end;
- `total_week_mismatch`: the current final non-discarded occurrence date equals
  the stored C1 season end.

Each change records the approval command and database action time and appends a
complete version-1 discrepancy before/after revision.

## Atomic approval and publication

Approval requires the run to remain `generated`, the complete confirmed review
to match, and current authoritative legacy input to equal the C1 generation
input. Every occurrence and skipped planned slot must resolve to a strictly
future instant under the shared DST resolver. Occurrence, exact-start,
same-day, and exception collisions are rechecked.

In one commit C2:

1. creates operation-specific `approve_generation` and `publish` commands;
2. applies every explicit discrepancy disposition under the approval command;
3. publishes active and cancelled draft occurrences in place under the
   publication command and appends occurrence revisions;
4. publishes current draft billing terms and appends term revisions;
5. publishes active draft skip exceptions and appends exception revisions;
6. moves the run directly to final `applied` state with coherent approval
   actor/time/command metadata.

UUIDs, generation keys, planned numbering, reviewed competition numbering,
and reviewed billing numbering do not change. C1 cancellations remain
cancelled and retain their original cancellation time, actor, and `cancel`
command; publication is separately attributed. No approval command is used as
a publication placeholder and no publication command is used as cancellation
attribution.

## Atomic rejection

Rejection supports only a current `generated` C1 set and uses the truthful
`reject_generation` command. It never deletes or publishes. In one commit it:

- marks every scheduled or cancelled draft occurrence `discarded`, clears its
  provisional ordinals and current cancellation tuple where applicable,
  records truthful discard metadata, and appends a complete revision;
- supersedes every draft billing term with a complete revision;
- revokes every never-published draft exception with a complete revision; and
- moves the run to `rejected` with reason, actor, action time, and command.

Historical cancellation metadata remains in prior revisions. All UUIDs,
generation keys, commands, and revisions remain durable. Rejected rows cannot
match the active draft or publication branches, and a rejected run cannot be
approved, restored, or adopted by another key.

## Migration and phase boundary

Migration `0020_phase_c2_fall_draft_review.sql` is forward-only and must run
after `0019_phase_c1_cancelled_draft_occurrences.sql`. It adds the discrepancy
revision audit table and tenant composite identity index, adds only the
`reject_generation` and `restore_cancelled_draft` command types, extends the
reason check for those audited operations, and extends exception lifecycle
validation to permit truthful revocation of a never-published draft. Every
pre-existing command and exception constraint branch is preserved.

The migration must be applied by the normal reviewed deployment workflow; C2
does not apply it to Neon or production. Rollback is restore-based. C2 adds no
environment variable, worker, scheduler, provider integration, or backfill.

C2 writes only canonical schedule commands, the current C1 run and entities,
and canonical revision/discrepancy rows. It does not write legacy league
arrays, games, scores, standings, relationships, obligations, allocations,
payments, refunds, receipts, provider identities, collection plans, or B2
Summer history. D1/D2 dual-write and E1 consumer cutover remain later phases.
