# Rotating team payments

## Configure and record participation

Set a team's stable slot to **Rotating** in roster version 2, then choose the
active bowler pool for that team. A team may combine fixed Main slots and
rotating slots. A bowler cannot be both a fixed Main and an eligible rotating
member on the same team, and the same bowler cannot fill two paying positions
for one date, including substitute and split positions. Existing no-rotation
rosters and their standing autopay rules continue to use the original flow.

After a published canonical date is materialized, a manager records who bowled
in each rotating position. The service verifies the date's published billing
ordinal, active pool membership, and the expected assignment revision. Changing
or clearing a confirmed participant requires a reason. A slot cannot be turned
off after its due time or canonical start time, or if it has any assignment
history, non-open obligation, allocation, provider reservation, or credit
application. Future open obligations with no assignment or payment evidence
can be voided by the roster save that turns the slot off.

The team remains responsible for the rotating slot's obligation. A participant
may buy personal rotating credit; that credit is applied only after the
participant is confirmed for an open, team-owned obligation, in published
billing order. Unused value remains personal prepaid credit and does not create
a payment allocation until it is applied. Assignment corrections reverse the
exact original credit allocation and re-run the affected participants' FIFO
credit against their other confirmed dates.

Converting an existing fixed Main position to rotating/team ownership is
conservative: any refund attempt or refund snapshot for a tender on that date
blocks conversion, even when the provider later confirms that no refund was
issued. Review and reconcile that history before changing ownership. The save
error identifies refund history that needs review.

## Payment and refund handling

Rotating participation is manual-only. Do not enable standing autopay for a
bowler solely because that bowler belongs to a rotating pool. Teams without
rotating slots retain their existing fixed-payer standing autopay behavior.

Credit balances are derived from the original tender, active applications,
reversals, and refund operations; no stored balance is authoritative. A refund
uses only unused credit. Pending, provider-unknown, or reconciliation-required
refunds hold the amount from further use. A confirmed Square `REJECTED` or
`FAILED` refund outcome releases that value because Square did not issue a
refund. An `action_required` `REFUND_DECLINED` result also releases the amount
only when Square returned no refund object and the recorded classification is
`hard_decline`. Other action-required or ambiguous terminal provider evidence
stays held for review. A dispute or inconsistent tender, allocation, or refund
snapshot holds the remaining lot for review.

F5 reports mark an unallocated credit funding tender as `prepaid_credit`; applied
credit uses `canonical_allocation`. The payer-facing F5 view shows provider refund IDs and
refund history only to the original credit payer. Authorized staff retains
access for financial reconciliation; other participants do not see that
provider evidence.

Staff can look up both current and historical pool members, open a member's
funded credit lots, and request a fresh server quote for the unused amount in
one lot. When the quote permits provider refund, issue it through Square; for
cash or check, record the manual issuance reference with the refund request.
Applied credit is not available to refund until its application is reversed.

## Migration 0050 and compatibility

Migration `0050_rotating_team_payments` adds team-owned obligation revisions,
rotating assignments, credit funding/application/refund ledgers, and deferred
database guards. It allows `payment_obligations.payer_bowler_id` to be null only
when the latest owner revision assigns the obligation to its canonical team.
The migration replaces `payment_allocations_payment_obligation_unique` with
`payment_allocations_payment_obligation_active_unique`, which applies only to
active ordinary allocations. Credit allocations carry the explicit
`allocation_kind = 'rotating_credit'` marker; deferred ledger guards require an
exact matching immutable credit application and reject credit evidence on an
ordinary allocation. This keeps ordinary tender/obligation uniqueness while
allowing a credit lot to append multiple active tranches to the same obligation
after a reversal and FIFO re-sweep. Reversed children remain voided and
append-only. An obligation may reopen after a credit correction only when the
same transaction records its exact reversal and the active allocation and
refund balance derives the new state. The migration drops no payment or
allocation rows.

This is a forward-only schema change. Deploy the application version that
understands nullable payer identity and rotating-credit evidence with the
migration; older binaries do not understand team-owned or rotating obligations.
There is no in-place down migration. If rollback is required, restore a
coordinated database backup and matching application release, or ship a
forward fix; do not manually recreate the unfiltered unique index or delete
retained ledger rows. Older binaries also lack the allocation discriminator
and cannot safely write credit applications after migration 0050.
