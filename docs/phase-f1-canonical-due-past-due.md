# Phase F1: canonical due and past-due

F1 is the read contract for roster-driven payment obligations. There is no
standalone activation step: once a league has a complete canonical roster,
the roster save transaction materializes responsibility and obligation rows
for every published canonical occurrence. Incomplete or contradictory
evidence remains unavailable rather than producing a guessed balance.

## Contract and lifecycle

The source is the published or locked canonical occurrence set, its current
billing terms, and the league's configured lineup size. League setup is the
single source of truth for three or four paying positions. A complete team
roster uses stable slots `0..size-1`; an explicit substitute or split
responsibility is an occurrence-level override. A VACANT slot produces no
obligation. No date, week number, score, roster membership, payment amount,
or provider fact is used to infer a payer.

The roster transaction takes the tenant/league advisory lock, re-reads the
canonical schedule and current team facts, and writes responsibility,
obligation, revision, and financial-command evidence atomically. Repeating the
same command returns the original result; changed semantics are rejected by
the command fingerprint and effective payment-evidence locks. Open
responsibilities may be corrected by a new explicit occurrence command, while
settled, reserved, or partially allocated evidence fails closed.

Every write remains tenant-scoped and provider-free. Responsibility and
obligation revisions are retained as audit evidence; the current source is
always revalidated before due or payment consumers use it.

## Read rules

Reads use one PostgreSQL `REPEATABLE READ READ ONLY` snapshot and return database-selected `asOf`, deterministic ordering, a stable semantic fingerprint, and an explicit source label. Canonical outstanding is immutable obligation amount minus active allocation amounts. Voided obligations contribute zero. Allocation state contradictions, missing obligations/payments, missing or changed D2 evidence, source drift, and timing/state mismatches produce bounded review/unavailable behavior (HTTP 409 at API boundaries). Refunded, disputed, or dispute-ledger-linked payments remain allocated and visible as `review_required`, including when outstanding is zero.

Every league uses its canonical obligation rows. Missing, duplicate,
superseded, contradictory, or invalid evidence fails closed; there is no
legacy date/week fallback. `/api/payments` remains payment history and is not
due truth.

Weekly due/past-due is derived from the canonical occurrence start plus the
versioned three-hour grace. Upfront obligations share the setup transaction's
authoritative due instant. Payment timing does not change whether real
occurrences have obligations; it changes when they become due.

The organization-wide report envelope is ordered by league ID and carries each league's own snapshot, `asOf`, source, and fingerprint. It is a deterministic aggregation of per-league snapshots, not one cross-league database snapshot.

## Migration and production gate

Migrations `0024_canonical_due_past_due_activation.sql` and
`0031_league_paying_lineup_size.sql` are forward-only and establish the
tenant constraints, timing fields, revision evidence, and three-or-four
lineup-size invariant. Their reviewed checksums and journal entries must be
verified before release. No new migration is required for the canonical-only
payment consumer cleanup; never edit an applied migration or manufacture a
backfill from legacy dates or payment rows.

The selected lineup size participates in the roster evidence and is not
silently changed once stable payment slots exist. Mid-season schedule edits
retain occurrence identity; open responsibility evidence is regenerated only
by an explicit roster or occurrence command, and settled/reserved evidence is
never rewritten.

## Smoke matrix

| Check | Expected result |
| --- | --- |
| privileged read in the own tenant | version-2 canonical obligation report |
| ordinary member read | only that payer's authorized obligations |
| system-admin read | explicit organization and league scope required |
| incomplete roster or evidence | bounded unavailable/error; no guessed debt |
| VACANT slot | no payment obligation for that slot |
| explicit substitute/split override | exact responsibility and component obligations |
| partial allocation | remaining balance is conserved and deterministic |
| refund/dispute evidence | retained and review-required |
| malformed scope | generic invalid/not-found response |

The due read never calls Square, creates a provider operation, schedules a
charge, links historical payments, or sends a receipt. Provider behavior is
owned by the explicit interactive or standing-autopay operation contracts.

## Rollout and rollback

Verify the existing migration bytes, checksums, and journal before release.
Rollback is application-only: pause the affected consumer and forward-fix the
implementation. Do not reverse migrations, delete canonical obligations,
relink historical payments, or fall back to calendar arithmetic.
