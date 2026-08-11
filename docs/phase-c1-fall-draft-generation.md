# Phase C1: Fall draft generation and admin preview

Phase C1 is the first forward-season canonical workflow. It lets an authorized
administrator inspect one explicit, tenant-scoped future Fall league, generate
a deterministic zero-write preview from the authoritative legacy league and
location rows, and explicitly create a complete canonical **draft** set. New
active Fall league setup now invokes that same persistence algorithm atomically;
the standalone preview/apply path remains available for eligible leagues created
before setup integration. Draft creation does not
approve, reject, publish, lock, edit, discard, or consume the drafts.

## Contracts and versions

- preview request: `fall-draft-preview-request/3`
- semantic preview: `fall-draft-generation-preview/3`
- apply request: `fall-draft-apply-request/3`
- apply/persisted result: `fall-draft-generation-result/3`
- implementation: `fall-draft-generation/3`
- draft mapping: `fall-draft-mapping/1`
- input snapshot: `fall-draft-generation-input-snapshot/3`
- initial occurrence, billing-term, and exception snapshot schema: version 1
- command fingerprint envelope: `lvcanoncmd:v1:<lowercase-sha256>`
- setup intent: `league-setup-integration-request/1`
- setup result: `league-setup-integration-result/1`

C1 exposes, but does not change, the merged A2 generator, input, result, and DST
resolver versions. Request bodies are strict. Preview callers supply only the
request contract version. Apply callers additionally supply the confirmed
preview fingerprint, reason, and idempotency key. Occurrence candidates, tenant
identity, schedule fields, request fingerprints, and generator policy are never
accepted as authoritative input. Fall draft generation always uses
`ambiguousFold = "reject"`, `currency = "USD"`, and
`billingOrdinalPolicy = "dense_billable"`; callers cannot override those system
policies or regular-session billing policy. The retired caller field is rejected
by strict v3 request validation rather than ignored.

The setup contract is a separate entry-point contract and does not change any
C1 preview, apply, result, input-snapshot, generator, mapping, or command
fingerprint version. A setup caller supplies only the versioned intent and a
secure UUID idempotency key alongside the ordinary league form. Actor and tenant
scope, generator input, preview confirmation, policies, revisions, timestamps,
and command attribution remain server-owned. Setup uses the fixed audit reason
`Generate canonical Fall drafts during authoritative league setup`.

## Atomic setup integration

`POST /api/leagues` and `POST /api/leagues/:id/new-season` classify Fall solely
from the validated stored start month. For a newly inserted active August,
September, or October league, one read-write transaction inserts and reloads the
legacy row, takes the shared tenant/league schedule lock, reauthorizes the actor
and location, builds the C1 preview from the uncommitted authoritative row,
uses that internally generated fingerprint as confirmation, and invokes the
same transaction-supplied C1 apply implementation used by the standalone
endpoint. Commit therefore contains both the league and the complete generated
draft set, or neither. Non-Fall creation inserts only the legacy row.

New-season setup first takes the setup-key lock, then the source-league schedule
lock, re-reads the authorized active source, and rejects an existing successor.
It creates the successor, copies teams in display order, copies every active and
inactive roster membership with its team mapping, membership order, and join
time, generates Fall drafts when applicable, and archives the source last. The
source remains active if any copy, generation, or archival step fails. Cache
invalidation and bowler synchronization occur only after commit and are skipped
for a zero-write exact retry.

Fall setup keys are namespaced and hashed into the existing organization-scoped
canonical command idempotency boundary. A transaction advisory lock on that
derived key serializes the pre-league-insert window. An exact retry locates the
originating generation command, verifies actor, organization, source-season and
the complete normalized persisted league semantics, then runs C1's existing
durable-set verifier and returns the original league and canonical UUIDs with no
writes. A changed semantic request conflicts. Different new-season keys still
serialize on the source league, so only one successor can be created.

Normal league editing takes the shared schedule lock whenever a canonical input
is present. After any retained canonical evidence exists, material changes to
organization, location, season bounds, weekday, competition time, timezone,
planned weeks, skips, cancellations, weekly fee, or payment mode are rejected.
Equivalent no-op values and noncanonical metadata remain editable. Double-pay
dates remain excluded collection evidence and can change without regenerating
or renumbering canonical rows.

## Eligibility and authoritative input

C1 classifies a season solely from its validated stored start date. August,
September, and October starts are Fall, including cross-year leagues. July and
November starts are not Fall. The league must be active (the current schema's
non-archived state), belong to the authorized organization, and point to a
location in that organization. Every A2-required field must be present.

The service loads season boundaries, weekday, local competition time, timezone,
location, planned slot count, weekly amount, payment mode, skips, and cancellations
from the tenant-proven league row. Date-only strings are validated and classified without
host-local `Date` parsing. A2 resolves each local start through the shared DST
resolver. The future-only gate also resolves every skipped planned slot at the
authoritative local competition time with the same timezone and fixed reject
fold policy.
Every occurrence and skipped-slot UTC start must be strictly later than
PostgreSQL `transaction_timestamp()`; one started slot rejects the whole request.
Apply repeats all checks while holding the league lock because preview is not a
reservation.

The shared server-authoritative Fall policy is `dense_billable` for every newly
generated league, whether its payment mode is weekly or upfront. Billing ordinals
therefore sequence actual billable bowling sessions: a cancelled session has no
billing ordinal and later billable sessions do not retain a gap.

League setup is authoritative for payment timing: `weekly` means bowlers pay
week by week, while `upfront` means the full-season amount is collected in
advance. Payment timing does not remove the underlying weekly session
obligations, so both supported modes derive
`regularSessionBillingPolicy = "eligible_bowlers"`. A prepaid league must never
be represented as nonbillable merely because collection happened earlier.
Ambiguous-fold policy, currency, and regular-session billing policy are not C1
UI controls: C1 rejects repeated local times, records USD, and retains eligible
weekly obligations. Billing terms are version-1 draft policy snapshots, not
bowler debt or collection instructions.

League creation and new-season setup require an explicit payment-mode choice.
The database limits persisted values to `weekly` or `upfront`. A payment-mode
change takes the shared canonical league lock and is rejected after any
canonical schedule evidence exists, so preview/apply and league setup cannot
race into an untruthful snapshot. Historical correction after that boundary
requires a separate audited workflow; it is not a normal league edit.

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
preview against identical authoritative state and the fixed Fall semantics
therefore produces the same fingerprint.

Legacy `double_pay_dates` are displayed only as excluded collection evidence.
They do not enter A2 input, physical or candidate fingerprints, occurrence or
billing candidates, ordinals, amounts, obligations, or allocations. Because the
C1 preview fingerprint covers the complete displayed semantic preview, a change
to that evidence still requires the administrator to review a fresh preview; it
does not alter physical generation or billing policy rows.

## Atomic apply, staleness, and draft mapping

`POST /api/leagues/:id/canonical-fall-drafts/apply` requires the confirmed
preview fingerprint and trimmed nonempty reason and idempotency key. The server
derives `dense_billable` again; it does not trust the confirmed client request to
carry generator policy. In one uninterrupted transaction it acquires the shared A2 league advisory
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

## Schema constraints, cancelled drafts, and migration order

Migration `0021_authoritative_league_payment_mode.sql` adds the database check
that accepts only `weekly` and `upfront`. It does not rewrite existing rows and
retains the legacy database default for internal compatibility; the public
create and new-season contracts still require an explicit value. Before applying
the migration to a durable database, audit `leagues.payment_mode` and stop if
any null or non-contract value exists. Correct such a row explicitly rather
than inferring payment timing from historical payment records. It follows
`0020_phase_c2_fall_draft_review.sql` and must be applied before deploying the
matching application contract.

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
fingerprint, authoritative payment mode, the fixed reject fold policy, fixed USD
currency, derived billing policy, fixed dense-billable ordinal policy, and C1
mapping/version semantics. Related cancellation and exception command keys are deterministic
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

The persisted reader provides a zero-write transition for input snapshot versions
1 and 2. A version-1 snapshot is accepted only when its recorded fold, currency,
regular-session billing, and ordinal semantics are supported; the current
authoritative league payment mode is then added to the in-memory view. Version 2
uses its recorded payment mode and ordinal policy. In both cases the stored
snapshot, rows, revisions, and fingerprints are never rewritten. A historical
`planned_slot` draft remains `planned_slot` for C2 review, cancellation, and
restoration; it is never silently reinterpreted as dense billable. Compatible
legacy drafts transition directly to C2 instead of attempting a v3 C1 idempotency
retry. Unsupported semantics, including a v3 snapshot that claims a non-dense
ordinal policy, fail closed as incompatible canonical state.

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

The league administration card exposes authoritative payment timing and derived
obligation evidence, explicit
preview and confirmation actions, accessible labels and focus movement, loading,
empty, validation, stale, retry, failure, and success states, a responsive
candidate table, skip/cancellation/DST/numbering/billing/discrepancy evidence,
fingerprints and proposed revision, and a persisted-draft staleness view. There
is no generator-settings or billing-ordinal selector. Preview remains available
immediately because the server owns all generation policy.

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
draft-only. This v3 contract and policy change requires no database migration or
production data rewrite. D1/D2 remain
responsible for legacy dual-write/comparison and downstream transition. E1
remains the calendar/schedule/admin consumer cutover. C1 does not update legacy
games, schedules, scores, or payments and does not introduce workers, rollover,
or provider behavior.

The C1 service deliberately imports no provider, payment, encryption, receipt,
or email module. It makes no external call and emits no credentials, provider
identifiers, encrypted values, or bowler/payment identities in contracts or
snapshots.
