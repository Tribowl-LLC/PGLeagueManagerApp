# Phase C1: Fall draft generation and admin preview

Phase C1 is the first forward-season canonical workflow. It lets an authorized
administrator inspect one explicit, tenant-scoped future Fall league, generate
a deterministic zero-write preview from the authoritative legacy league and
location rows, and explicitly create a complete canonical **draft** set. Draft
creation is not attached to league creation or season rollover and does not
approve, reject, publish, lock, edit, discard, or consume the drafts.

## Contracts and versions

- preview request: `fall-draft-preview-request/1`
- semantic preview: `fall-draft-generation-preview/1`
- apply request: `fall-draft-apply-request/1`
- apply/persisted result: `fall-draft-generation-result/1`
- implementation: `fall-draft-generation/1`
- draft mapping: `fall-draft-mapping/1`
- input snapshot: `fall-draft-generation-input-snapshot/1`
- initial occurrence, billing-term, and exception snapshot schema: version 1
- command fingerprint envelope: `lvcanoncmd:v1:<lowercase-sha256>`

C1 exposes, but does not change, the merged A2 generator, input, result, and DST
resolver versions. Request bodies are strict. The caller supplies only the
contract version and four non-authoritative semantics; occurrence candidates,
tenant identity, schedule fields, and request fingerprints are never accepted
as authoritative input.

## Eligibility and authoritative input

C1 classifies a season solely from its validated stored start date. August,
September, and October starts are Fall, including cross-year leagues. July and
November starts are not Fall. The league must be active (the current schema's
non-archived state), belong to the authorized organization, and point to a
location in that organization. Every A2-required field must be present.

The service loads season boundaries, weekday, local competition time, timezone,
location, planned slot count, weekly amount, skips, and cancellations from the
tenant-proven league row. Date-only strings are validated and classified without
host-local `Date` parsing. A2 resolves each local start through the shared DST
resolver. The future-only gate also resolves every skipped planned slot at the
authoritative local competition time with the same timezone and fold policy.
Every occurrence and skipped-slot UTC start must be strictly later than
PostgreSQL `transaction_timestamp()`; one started slot rejects the whole request.
Apply repeats all checks while holding the league lock because preview is not a
reservation.

The administrator must explicitly choose:

- ambiguous-fold policy: `reject`, `earlier`, or `later` (`reject` is visible as
  the safe UI default);
- an uppercase three-letter currency;
- regular-session billing policy: `none` or `eligible_bowlers`; and
- billing ordinal policy: `planned_slot` or `dense_billable`.

None is inferred from payment mode, weekly fee, organization, season, or another
league. The UI leaves currency and both billing-policy controls unselected until
the administrator makes an explicit choice; only the visible safe fold policy
defaults to `reject`. Billing terms are version-1 draft policy snapshots, not
bowler debt or collection instructions.

## Zero-write preview

`POST /api/leagues/:id/canonical-fall-drafts/preview` runs in a tenant-scoped,
repeatable-read, read-only PostgreSQL transaction. It creates no canonical or
legacy row. The response contains normalized scope and semantics; every A2 and
C1 version; A2 input, physical-schedule, and candidate-set fingerprints; the
proposed next source revision marked `reserved: false`; sorted occurrence,
billing-term, skip-exception, fatal-error, and discrepancy candidates; and the
existing league-scoped canonical state.

Occurrence rows display date, local time, timezone, UTC start, offset, fold
resolution, generator status, draft lifecycle intent, planned/competition/
billing numbering, billing policy and amount, and generation key. Skip dates
produce draft exception candidates and no occurrence. Cancellation dates retain
an occurrence candidate, generation key, and planned ordinal while remaining
noncompetitive with null competition and billing numbering.

The preview fingerprint is SHA-256 over canonical JSON for the complete semantic
preview, excluding only the fingerprint field itself. Arrays are sorted before
construction. Runtime time, random UUIDs, credentials, provider/encrypted data,
and personal/payment identities are excluded. PostgreSQL transaction time is
used only as an eligibility check and does not enter the preview. Repeating a
preview against identical authoritative state and semantics therefore produces
the same fingerprint.

Legacy `double_pay_dates` are displayed only as excluded collection evidence.
They do not enter A2 input, physical or candidate fingerprints, occurrence or
billing candidates, ordinals, amounts, obligations, or allocations. Because the
C1 preview fingerprint covers the complete displayed semantic preview, a change
to that evidence still requires the administrator to review a fresh preview; it
does not alter physical generation or billing policy rows.

## Atomic apply, staleness, and draft mapping

`POST /api/leagues/:id/canonical-fall-drafts/apply` requires the four semantics,
the confirmed preview fingerprint, and trimmed nonempty reason and idempotency
key. In one uninterrupted transaction it acquires the shared A2 league advisory
lock, proves tenant and actor, reloads authoritative input, allocates the next
source revision, regenerates through A2, rebuilds and verifies the preview,
rechecks future eligibility, validates same-day/exact-start/exception collisions,
checks existing state, inserts the complete set, and commits once. A stale
preview, changed schedule, collision, unsupported discrepancy, foreign or
partial state, or fatal generator result rolls back everything, including
commands. Same-day overrides are not available.

The resulting generation run is `generated` with no approval or rejection
metadata. Occurrences are `draft`; billing terms are separate `draft` version-1
snapshots; skip exceptions are `draft` and linked to the run. Every row receives
revision 1 with a null before-snapshot and a complete, sanitized, explicitly
versioned after-snapshot. C1 creates no occurrence relationship and no approval,
publication, lock, payment, obligation, allocation, or collection row.

The originating `generate` command owns the run and generated rows. A generated
cancellation uses a `cancel` command for its cancellation metadata and revision;
a generated skip uses `create_exception`. C1 never uses approval or publication
commands as foreign-key placeholders. Supported nonfatal A2
`outside_season_occurrence` and `total_week_mismatch` findings persist as open
draft-review discrepancies; unsupported mappings fail closed.

## Cancelled drafts and migration order

Migration `0019_phase_c1_cancelled_draft_occurrences.sql` must run after the
already-applied A1 migration chain. It narrowly extends the occurrence lifecycle
check to admit `draft/cancelled` and adds a corresponding metadata branch. A
valid cancelled draft must have the complete cancellation triple, retain a
planned ordinal, have null competition numbering, be noncompetitive and excluded
from standings, and have no publication, lock, completion, or discard metadata.
The existing draft-scheduled, draft-discarded, published, and locked branches are
preserved verbatim. No table or enum redesign is introduced.

This forward migration must be applied through the normal deployment migration
step before C1 is used. It was designed and tested only against disposable local
PostgreSQL databases here; this phase does not apply it to Neon, production, or
another durable shared database. C1 adds no environment variables.

## Idempotency and concurrency

The operation fingerprint covers tenant, league, actor, trimmed reason and key,
confirmed preview, normalized A2 input, allocated source revision, candidate-set
fingerprint, the explicit fold/billing semantics, and C1 mapping/version
semantics. Related cancellation and exception command keys are deterministic
derivations of the operator key and command role.

Under the league lock, an exact same-key/same-payload retry verifies the complete
command set, run, rows, attribution, revisions/snapshots, discrepancies, and
absence of relationships before returning the original durable UUIDs with zero
writes. The same key with changed semantics, reason, actor, preview, or schedule
is an idempotency conflict. A different key cannot adopt or duplicate an existing
generation, and partial/foreign state fails closed. Identical concurrent requests
converge; competing requests serialize and at most one can apply.

`GET /api/leagues/:id/canonical-fall-drafts` returns the verified durable result
and independently reports whether the current legacy schedule still matches its
recorded normalized input. The reader is authorized independently, while durable
command attribution is verified against the actor who created the generation.
If the current location or another required live input is missing, the persisted
draft remains readable and reports `currentInputMatches: false`. Later legacy
edits do not rewrite or regenerate the drafts. An administrator may preview again
for read-only review, but cannot create a second generation.

After a C2 mutation advances an entity revision or terminalizes the generation
run, this C1 status endpoint reports `found: true`, `transitionedToC2: true`, and
the durable generation-run ID without pretending the original C1 apply result is
still the exact current state. The versioned C2 review endpoint then owns complete
current-state and revision-chain verification.

## Authorization, UI, and errors

All three endpoints require the normal authenticated session and API/CSRF
middleware. A same-tenant `org_admin` is allowed. A `system_admin` must select an
explicit `organizationId` query scope. Normal users, cross-tenant admins,
org-less/missing leagues, and cross-tenant locations fail without exposing the
target row. Actor and normal tenant scope always come from the session.

The league administration card exposes the four policy controls, explicit
preview and confirmation actions, accessible labels and focus movement, loading,
empty, validation, stale, retry, failure, and success states, a responsive
candidate table, skip/cancellation/DST/numbering/billing/discrepancy evidence,
fingerprints and proposed revision, and a persisted-draft staleness view.

Operationally, authorization/not-found failures should be treated as scope
errors; eligibility and generator failures require correcting authoritative
league input; stale-preview and collision errors require a new preview and
review; idempotency conflicts require retrying the original exact request or
using a newly reviewed operation; incompatible state requires investigation,
not adoption or manual partial continuation.

## Phase boundary and security

C2 now consumes only the versioned C1 input snapshot and implements audited
future reschedule/cancel/restore, exact persisted review, discrepancy
disposition, atomic approval/publication, and terminal rejection as documented
in `docs/phase-c2-fall-draft-review-approval.md`. C1 generation itself remains
draft-only and unchanged. D1/D2 remain
responsible for legacy dual-write/comparison and downstream transition. E1
remains the calendar/schedule/admin consumer cutover. C1 does not update legacy
games, schedules, scores, or payments and does not introduce workers, rollover,
or provider behavior.

The C1 service deliberately imports no provider, payment, encryption, receipt,
or email module. It makes no external call and emits no credentials, provider
identifiers, encrypted values, or bowler/payment identities in contracts or
snapshots.
