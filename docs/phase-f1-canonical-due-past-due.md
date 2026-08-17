# Phase F1: canonical due and past-due

F1 adds the dormant, tenant-scoped `canonical-due-past-due/1` read contract and an explicit organization-admin responsibility activation. Activation is one atomic, serializable command under the league advisory lock. It accepts only occurrence/team/slot/bowler/role selections; the server creates the D2 eligibility, assignment, obligation, revisions, and responsibility evidence.

## Contract and lifecycle

The source contract is selected by E1 in one transaction and includes every published/locked operational occurrence, including cancelled and explicitly nonbillable rows, the exact current published billing term, active team IDs, payment mode, occurrence kind/status/lifecycle/start/revision, and an inclusion disposition. Only a stored `eligible_bowlers` term creates expected groups; a stored `none` term is an explicit exclusion. Missing, duplicate, superseded, contradictory, or invalid terms fail closed. Regular, makeup, position-round, rolloff, playoff, and extension kinds are treated identically by their stored term and status; no kind heuristic creates an obligation.

The administrator chooses one league-level lineup size (3 or 4), then every occurrence/team group receives contiguous slots `0..size-1`. Bowler, role (`regular` or `substitute`), and fixed provenance `explicit_admin_selection` are all required. A substitute is an explicitly selected payer; no replacement bowler, roster default, team membership, assignment, score, date, amount, payment, or provider fact is inferred. A selected bowler must be active, belong to the tenant, and have active membership in the exact league. Membership's team does not preselect or constrain the explicitly selected responsibility team, slot, or role; substitutes may be selected for another team.

The writer reauthorizes the actor after acquiring the league advisory lock, re-reads E1/source/team/billing/bowler facts, computes canonical fingerprints, captures the database transaction timestamp for upfront due timing, and writes activation, revision 1, eligibility, assignment, obligation, responsibility, and their revisions atomically. The deferred database guard proves counts, one lineup size, exact groups and slots, and exactly one activation revision-1 row. Activation evidence is immutable. Exact command retries return the original IDs only when actor, tenant, league, versions, fingerprints, lineup size, revision evidence, counts, and normalized selections all match; changed semantics return a generic conflict.

## Read and compatibility rules

Reads use one PostgreSQL `REPEATABLE READ READ ONLY` snapshot and return database-selected `asOf`, deterministic ordering, a stable semantic fingerprint, and an explicit source label. Canonical outstanding is immutable obligation amount minus active allocation amounts. Voided obligations contribute zero. Allocation state contradictions, missing obligations/payments, missing or changed D2 evidence, source drift, and timing/state mismatches produce bounded review/unavailable behavior (HTTP 409 at API boundaries). Refunded, disputed, or dispute-ledger-linked payments remain allocated and visible as `review_required`, including when outstanding is zero.

Before activation, fallback uses the existing server-side legacy helper population: active tenant bowlers with active league membership, including zero-payment bowlers, then legacy paid rows. It is labeled `legacy_fallback`, never fabricates occurrence UUIDs or allocation certainty, and never includes inactive/nonmember payments. Any league-scoped D2 eligibility, assignment, obligation, collection-plan, plan-item, or allocation evidence without a complete activation blocks fallback. Canonical and fallback values are never blended. `/api/payments` remains payment history and is not due truth.

F1 due timing is deliberately separate from F3 collection-plan timing: weekly due/past-due is derived from the canonical occurrence start plus the versioned three-hour grace, while upfront due is the activation transaction timestamp. F1 does not create or execute collection plans, schedule provider charges, or reinterpret payment-history/status/setup amounts; those surfaces remain legacy execution compatibility until F2/F3.

The organization-wide report envelope is ordered by league ID and carries each league's own snapshot, `asOf`, source, and fingerprint. It is a deterministic aggregation of per-league snapshots, not one cross-league database snapshot.

## Migration and production gate

Migration `0024_canonical_due_past_due_activation.sql` is forward-only and generated from the final schema against `0023`; its reviewed checksum, snapshot, journal entry, prerequisite composite indexes, exact tenant FKs, timing columns, deferred completeness guard, revision guard, and immutability triggers must be checked before release. Run migration before the application release, verify zero activation rows, and leave `LEAGUEVAULT_F1_ACTIVATION_ENABLED` unset/false. The activation route/UI is therefore dormant by default until legacy payment reconciliation, provider/payment-writer boundaries, and a separately approved production gate exist.

After activation, covered schedule evidence remains effectively locked by the existing D2 rules. F1 does not invent post-activation cancellation, reschedule, refund, allocation reversal, or activation-revision workflows. A newly added occurrence/team/term or any source drift fails closed until a separately reviewed workflow exists. Rollback is application-only: disable the feature, preserve immutable rows for review, and never reverse the migration or delete evidence.

An activated tenant is archived or retained rather than permanently deleted. The
runtime organization teardown has no trigger-bypass role or custom-GUC escape and
returns a generic retention conflict when F1 activation evidence exists. Any
future irreversible deletion requires a separately designed, audited retention
workflow; disposable test databases are the cleanup boundary for activation
fixtures.

## Smoke and rollback matrix

| Check | Expected result |
| --- | --- |
| org-admin read in own tenant | versioned report with explicit canonical/fallback source |
| ordinary member org-wide read | nondisclosing 404 |
| system-admin read | explicit `organizationId` required |
| malformed array/object scope | generic invalid-scope response |
| clean pre-activation league | labeled legacy fallback, active zero-payment bowlers present |
| partial D2 evidence | generic 409; no fallback |
| activation while dormant | generic 409; no writes/provider calls |
| canonical refund/dispute review | visible `review_required`, even at zero outstanding |
| migration rerun | no-op; checksum and snapshot exact |

No F1 endpoint calls Square, creates provider operations, activates schedulers/webhooks, links historical payments, creates collection plans, or sends receipts.

## Rollout and rollback

Apply migration 0024 before the application release. Verify migration bytes/checksum and that no activation rows exist. Deploy the application with activation UI hidden/unlinked unless separately authorized. Smoke-test read authorization and the unavailable/legacy-fallback labels; do not activate a league during rollout.

Rollback is application-only while migration 0024 remains installed. Do not reverse the forward-only migration or delete canonical evidence. If an activation/read issue appears, disable the F1 routes/UI through the application release and preserve rows for review. No provider or production data action is part of rollback.
