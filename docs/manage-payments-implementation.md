# Manage Payments implementation plan

## Surface and contract

The production worksheet is a new LeagueVault admin surface at
`/manage-payments`, served by the main left navigation as **Manage Payments**.
The existing `/payments` route and other payment flows remain available. The
versioned API uses the same path for GET and POST:
`/api/financials/leagues/:leagueId/manage-payments/1`. Access to this new
surface is limited to organization and system administrators; existing
payment-manager access on other payment surfaces is unchanged.

The shared Zod contract lives in `shared/manage-payments-contract.ts`. Money is
integer cents. The client sends row identity (`teamId`, `bowlerId`),
responsibility, and a canonical fee component (`full`, `lineage`, or `prize`);
the server owns organization scope, roster membership, fee values, account
balances, and receipts. An empty `changedRows` list can confirm an unconfirmed
week using the server snapshot. Saves echo both the GET revision and opaque
state fingerprint. The fingerprint protects editable responsibility, fee,
and receipt identities; new read-only card receipts or a recomputed account
balance do not by themselves invalidate a staff edit. The service recomputes
FIFO coverage and current balances while holding the league financial lock.

A checked worksheet responsibility may select a zero-priced canonical fee
component; it remains responsibility evidence and creates no payment
obligation. The saved manual receipt array retains each exact cash/check
payment identity, type, amount, and revision; it does not merge legacy receipts. A zero edit logically clears that one receipt
through canonical void/replacement history. New manual receipts use cash and
the selected canonical occurrence's league-local date. Edits preserve the
original business date. Successful card receipts remain immutable and are
associated with their actual collection week. One tender can have authorized
recipient portions for multiple accounts; card evidence must display each
recipient's portion without treating the payer as every portion's owner.
Refunds remain a separate flow.

## Canonical ledger extension

This change extends the existing responsibilities, obligations, payments, and
allocations. It does not introduce a second payment ledger. A
`weekly_payment_fundings` row represents one recipient-owned portion of a real
tender. A combined checkout may create several portions against one canonical
payment; `payments.bowlerId` remains the tender's payer. V3 partner portions
retain the operation snapshot fingerprint and every contributing allocation
index, and portions must sum to the single tender amount. A payment already
represented by `rotating_credit_fundings` gets no generic funding row.

`payment_allocation_funding_applications` ties each new canonical allocation
to exactly one generic portion or one existing rotating lot, and records its
credited owner, amount, obligation, and target evidence. Ordinary bowler
responsibilities record the exact obligation payer. New applications must keep
the credited owner equal to that payer; a retained historical cross-owner
allocation is admissible only when its immutable adoption proof matches the
exact source portion, allocation/correction path, and obligation owner.
Retained team-owned debt can be settled only through the confirmed
`legacy_team_assignment` target with exact assignment evidence; its team owner
and history stay intact. Existing rows in `rotating_credit_applications`
remain authoritative and use their existing reversal path. A later guard must
prevent an allocation from appearing in both the old rotating table and the
new source-link table. New release evidence references the exact typed source
application and returns value to that source's credited owner, including when
the source obligation remains team-owned.

Available value is each recipient portion or rotating lot less its effective
applications, completed refunds, pending refund holds, and dispute/review
holds. All ordinary-payment and rotating-credit readers, writers, and refund
paths must share this calculation before adoption can run. Every funding,
application, release, refund, and reservation transition must be guarded
against overuse. Existing interactive and autopay snapshot contracts remain
unchanged. New V4 snapshots prove provider recipient portions without
obligation reservations; adopted legacy provider funding preserves exact
snapshot allocation indexes in its authorization evidence rows.

The shared transaction-only service surface lives in
`server/services/owned-payment-ledger.ts`. It exports:

- `readOwnedLedgerAdoptionInTransaction(tx, { organizationId, leagueId })` to
  read the unique per-league marker and fail closed on duplicate evidence.
- `isOccurrenceConfirmedInOwnedLedger(adoption, occurrenceLocalDate, explicit)`
  to accept explicit confirmation or a date at/before the adoption cutoff. The
  cutoff is before the current billable occurrence, so current and future
  weeks stay forecasts unless staff explicitly confirms them.
- `readConfirmedOwnedObligationsInTransaction(tx, { organizationId, leagueId,
  bowlerIds? })` to return exact effective debtor/assignment, actual paid,
  waived, outstanding, and review-hold amounts for confirmed obligations.
- `readOwnedAccountBalancesInTransaction(tx, { organizationId, leagueId,
  bowlerIds? })` to bulk-read the union of generic recipient portions and
  existing rotating lots and return available credit, confirmed debt, and
  signed net balance.
- `recordOwnedFundingInTransaction(tx, input)` to record one immutable portion
  of an already-persisted real manual/provider tender. It rejects a tender
  already represented by a rotating funding row and validates the exact V4
  recipient portion or legacy operation allocation-index evidence. Matching
  finalizer retries return the same immutable funding row.
- `applyOwnedFundingFifoInTransaction(tx, { organizationId, leagueId,
  bowlerId, actorUserId, now? })` to apply that credited bowler's generic and
  rotating lots together against their oldest confirmed obligations. A review
  hold at the oldest collectible obligation stops later applications; future
  forecasts never receive an allocation.
- `releaseOwnedFundingApplicationInTransaction(tx, { organizationId,
  leagueId, applicationId, actorUserId, reason, idempotencyKey, now? })` to
  append evidence releasing one exact application in full back to its original
  credited owner. A correction then re-runs FIFO against the updated confirmed
  debt. Release retries must match the original application, reason, and actor.

The follow-on ledger implementation adds typed FIFO application/release
writers and guards. Financial mutations call these helpers only after taking
the existing league schedule lock. Adopted account-funding refunds remain
full-tender only: their V3 immutable refund snapshot must bind every recipient
portion and each portion's unused credit together with current allocation
evidence before provider I/O. No refund is apportioned across partners.

`occurrence_payment_responsibilities` gains a `worksheet` branch. Worksheet
rows are payer/week identities associated with a current team, not invented
slot positions or `main_pays_full` policy rows. Only worksheet rows may have
null slot identity and policy fields; legacy responsibility shapes remain
strict. Current worksheet responsibility is unique per organization, league,
canonical occurrence, and payer. Obligations remain attached to the same
canonical responsibility and must match its payer, occurrence, amount,
currency, and fee component.

The existing `bowler_leagues` schema has a non-unique active lookup index, not
a database uniqueness rule for one active team per bowler/league. The regular
membership POST rejects duplicates, but the team-move PATCH and season-copy
paths do not provide a database-level guarantee. The GET/save adapter must
detect duplicate active memberships and refuse ambiguous billing until roster
ownership is resolved; it must not show two chargeable rows or infer which team
owns the canonical payer/week responsibility.

Weekly confirmation records and responsibility/receipt revisions are
append-only evidence. An absent confirmation denotes a forecast rather than
collectible weekly debt. Later service work must keep season forecasts while
ensuring collection readers use confirmed weeks. The per-league adoption
marker and cutoff prevent roster materialization from creating duplicate
legacy debt after adoption. Funding ownership comes from the authorized
recipient portion, not `payments.bowlerId` or the current obligation owner.
Existing allocations that cross credited-owner and obligation-owner
identities may be grandfathered only by exact adoption proof linking the
recipient portion, active and original allocations, each correction edge, the
target obligation, owner kind, and amount. A past team obligation without a
valid confirmed assignment, missing recipient authorization, unknown refund
ownership, or unattributed dispute remains a preflight exception requiring
explicit mapping; adoption must not guess or move money.

## Adoption and integration sequence

1. Keep ordinary historical tenders and rotating funding strict until a
   separately reviewed, guarded adoption. Startup does not auto-convert
   payments.
2. Preflight each league against canonical occurrence dates, existing
   responsibilities and allocations, roster/materializer state, provider
   operations, refunds, and disputes. Any unresolved provider/refund
   reservation defers adoption without mutation. An unassigned past team debt,
   missing source authorization, or unknown ownership mapping also blocks that
   league pending explicit resolution.
3. For adopted tenders, derive one owned portion per authorized recipient and
   capture its exact provider/manual provenance before exposing general owner
   credit. Preserve existing historical coverage and rotating lots without
   copying them into generic funding. Record exact proof for retained
   cross-owner allocations and their correction paths. Upcoming canonical
   weeks stay unconfirmed forecasts; eligible future allocations are released
   to their source portion's credited owner only in the guarded adoption
   operation. The current week stays unconfirmed unless existing confirmation
   evidence is explicit.
4. Preserve future obligations as forecasts. On first staff confirmation of a
   week, atomically retire that week's legacy default responsibility set and
   create worksheet responsibility and fee evidence so two collectible
   obligations cannot exist for one payer/week.
5. A week save creates or revises responsibility evidence, exact manual
   receipt history, and confirmation evidence in one league-locked
   transaction. New and released value applies FIFO to that credited owner's
   oldest confirmed debt only. Surplus remains owned credit; it is not assigned
   to a future week before staff confirms that responsibility.
6. Preserve current standing-autopay consent and cutoff behavior and existing
   weekly/final-collection targets. Existing owner credit can reduce a
   collection. A successful automatic collection without confirmed weekly
   responsibility remains recipient-owned credit until staff confirmation; no
   late catch-up rule is introduced here.
7. Keep the existing final-two-week collection requirement. After older debt
   is covered, current unused credit may cover the paired unconfirmed fees and
   completed final allocations count. The final-two-week responsibility editor
   is deferred; the worksheet must not ship sample-only paid status.

Legacy receipt week mapping follows the approved collection-period rule and
never uses the week of the debt allocation. Prefer an explicit standing-autopay
trigger occurrence when immutable metadata provides it. Otherwise convert the
actual receipt's business-local date into the league timezone and assign it to
the canonical collection period beginning at the latest occurrence local date
on or before that date and ending before the next occurrence local date.
Preseason receipts group with the first occurrence and postseason receipts
with the last. Same-date boundaries use canonical billing order and start
time. Only a truly invalid or missing schedule is an adoption preflight hold.
Keep each original payment timestamp unchanged. New worksheet entries store
the explicitly selected collection occurrence.

## Stage and release boundary

The schema addition is backward-compatible with legacy rows and legacy-mode
writers; the shared contract and schema draft do not implement ledger
services, provider adapters, production adoption, or frontend behavior. The
release sequence is: apply the reviewed schema migration; deploy dual-mode
code while every league remains in legacy mode; then, only with the exact
deployed SHA, run the separately reviewed and locked adoption for a league
after its read-only preflight passes; finally verify worksheet balances,
provider receipts, collection reports, and legacy paths before adopting more
leagues. Startup and page reads never adopt data.

Adoption changes which data paths can create collectible debt, so rollback
after adoption is not a code-only revert. Before adopting a league, retain the
preflight evidence and a verified backup/reconciliation point; after adoption,
rollback requires a reviewed reverse/reconciliation plan that preserves the
adoption marker, recipient portions, exact historical allocation proofs,
receipt lineage, and all confirmed obligations. The migration and this release
draft are not approval to apply a migration or write production data.
Production application remains behind the repository's protected migration
workflow, review, exact-main certification, and release gates. Root performed
an aggregate-only read-only production inspection: 548 payments (412 paid,
136 voided), 10,244 obligations, 2,422 allocations, 53 V3 partner snapshots,
zero rotating-credit fundings, 30 active team-owned obligations, and zero
duplicate active bowler/league memberships. Of those obligations, three are
before today's league-local date and all three have a latest non-null actual
bowler assignment; the other 27 are future obligations. No payment/customer rows were retrieved and
no production data was changed. These counts are discovery context only; the
future exact-SHA adoption preflight must be rerun before any league adoption.
