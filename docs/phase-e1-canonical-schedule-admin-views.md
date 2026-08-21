# Phase E1 canonical schedule and administrator views

Phase E1 cuts the physical league schedule shown on the league page over to
canonical occurrence identity when an operational canonical set exists. It
does not change games, scores, standings, reports, rollover setup, payment
schedules, provider execution, or the dormant D2 financial model.

## Read contract

`GET /api/leagues/:leagueId/occurrence-schedule` returns
`league-occurrence-schedule/2`. Its deterministic ordering contract is
`league-occurrence-schedule-order/1`:

1. authoritative local date;
2. authoritative local start time;
3. planned ordinal, with null last;
4. competition number, with null last;
5. the stable occurrence-kind order (`regular`, `makeup`, `position_round`,
   `rolloff`, `playoff`, `extension`); and
6. canonical UUID, or the explicitly noncanonical legacy projection key.

Canonical rows expose only schedule-safe evidence: UUID, kind, status,
lifecycle, local date/time, IANA timezone, UTC start, selected offset, fold
resolution, resolver version, the distinct planned/competition/billing
numbers, competitive/standings flags, current revision, effective-lock state,
published billing-policy summary, and active published typed relationships.
Published skip exceptions are separate rows and never fabricate an occurrence.

The contract excludes command snapshots, revision snapshots, actor IDs,
amounts, currency, provider data, payment data, encrypted values, and raw
database rows. Administrator diagnostics are bounded state/count evidence for
draft, rejected, superseded, revoked, discarded, recovery, and C2 review
availability. Ordinary users receive `administrator: null`.

## Authoritative-source selection

The server owns one source-selection policy:

- Any published or locked occurrence makes the physical schedule canonical.
  Only published/locked occurrences, published skip exceptions, current
  published billing summaries, and published relationships enter the
  operational projection. Published cancellations keep their UUID and planned
  number. Reschedules keep the UUID and expose the current canonical start.
- Canonical selection requires exactly one current approved/applied generation
  run. Its durable occurrence and exception associations must match its
  declared generated/skipped counts, and its candidate count must equal their
  sum. Later operational rows are accepted only as separately audited special
  sessions or published exceptions; makeup sessions also require their active
  typed relationship.
- Legacy league arrays are never merged into an operational canonical result.
  Legacy skips, cancellations, numbering, and dates cannot replace or augment
  canonical rows.
- Draft, discarded, rejected, revoked, and superseded evidence is excluded
  from operational rows. Authorized administrators may see bounded evidence
  that it exists. A draft-only or rejected set therefore does not become the
  normal schedule.
- An operational marker without an operational occurrence set, a live draft
  occurrence mixed with the published set, a published relationship or term
  referencing a non-operational occurrence, an overlapping published skip,
  duplicate current published billing summaries, cross-scope evidence, or
  contradictory linked activity returns
  `409 CANONICAL_SCHEDULE_INCOMPATIBLE`. E1 does not hide unsafe canonical
  evidence behind legacy derivation.
- With no operational canonical state, the response is explicitly
  `legacy_fallback`. It reuses `getAllBowlingDates`; it does not run A2, assign
  UUIDs, resolve a synthetic UTC start, read games or payments to guess
  identity, or use double-pay data as a physical schedule input.

The legacy projection preserves existing Winter, Spring, Summer, Fall, and
pre-integration leagues. Its local date, configured local start, timezone,
planned slot, legacy competition number, cancellations, and skip arrays remain
visible, while UUID, canonical UTC/DST evidence, revision, relationship, and
billing ordinal remain absent.

## Authorization and isolation

The route is mounted behind session authentication. It resolves the tenant
before loading schedule evidence:

- an organization administrator is scoped only to the organization on the
  authenticated user;
- an ordinary user must have an active bowler-to-league membership and is
  still scoped to the authenticated user's organization; and
- a platform system administrator must use the existing explicit
  `?organizationId=<id>` convention.

Every league and canonical query includes both the authorized organization and
league. Missing, org-less, unauthorized, and cross-tenant league IDs return the
same not-found boundary without another tenant's organization or row details.
Client-provided IDs select a candidate resource; they never confer authority.

## League and administrator UI

The league page now leads with a general `Season schedule` card for every
authorized viewer instead of an administrator-only top-level Fall generator
card. It presents a responsive chronological list with explicit scheduled,
cancelled, completed, skipped, makeup, and special-session labels. Planned,
competition, and billing numbers have separate labels. The source badge and
legacy warning make fallback status unambiguous. Loading, empty, incompatible
or transport error, and retry states are explicit and accessible.

Administrator rows add lifecycle, revision, effective-lock, offset, fold, and
resolver evidence. The administration section retains the existing C2 audited
review and mutation panel when a C1 set exists. For an active pre-integration
Fall league with zero canonical evidence, it contextually embeds the existing
zero-write preview and confirmed draft-creation recovery path. Opening the
schedule never generates, mutates, approves, publishes, repairs, or locks a
canonical row. The C1/C2 request contracts and endpoints are unchanged.

## Date, time, and lock behavior

Canonical UTC timestamps are normalized to UTC ISO strings by the server, but
the product date/time is rendered from the stored canonical local date, local
time, and IANA timezone fields. The client does not re-resolve DST, use a fixed
offset, or parse a date-only value in the host timezone. Calendar labels use an
explicit UTC-noon formatting anchor solely to format the already authoritative
date components. Selected offset, fold choice, and resolver version remain
visible to administrators.

Effective lock state is a read projection of canonical lock metadata, an
elapsed canonical UTC start, or existing D1/D2 linked activity evidence. The
read does not stamp `locked_at`, acquire an advisory lock, or write an audit
command. A payment-schedule cursor alone is not activity evidence.

## Zero-write and phase boundary

The endpoint performs tenant-scoped `SELECT` statements in one repeatable-read,
read-only transaction and reads `transaction_timestamp()`. It does not open a mutation transaction, request
a transaction ID, lock schedule rows, invoke the generator, create an
observation, or call a provider. Tests compare complete legacy league evidence
and canonical, D2, payment, and revision/audit counts before and after the
read.

E1 does not activate D2 eligibility, assignment, obligation, collection-plan,
allocation, or occurrence-snapshot writers. It does not alter games, scores,
standings, reports, rollover, weekly-payment date derivation, past-due logic,
payment schedules, scheduled operations, provider behavior, refunds, disputes,
receipts, reconciliation, webhooks, or historical links. E2 through F retain
those cutovers.

## Migration, deployment, compatibility, and rollback

E1 has no database migration, backfill, materialization, new environment
variable, worker, timer, or startup scan. Migration 0023 remains the latest
required schema and the D2 tables may remain empty. Deploy the CI-verified E1
application only after the already-required 0018–0023 schema is present.

The additive route and UI are compatible with operational B2 Summer sets,
published C2 Fall sets, draft/rejected C1/C2 evidence, and leagues with no
canonical rows. Application rollback removes the E1 reader/UI and restores the
previous league-page presentation while retaining all canonical and D2 schema
and evidence. Do not reverse migrations or delete canonical rows as rollback.
