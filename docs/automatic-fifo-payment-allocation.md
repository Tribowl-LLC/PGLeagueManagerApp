# Automatic FIFO payment allocation

LeagueVault records one real tender as one immutable `payments` parent. The
parent belongs to one organization, bowler, and league and stores the tender
total and `createdAt`; child `payment_allocations` rows are internal ledger
evidence linking that total to obligations. A Square operation therefore
creates one payment parent, even when it settles several occurrences.

## Collection behavior

The one-time cash, check, card, and wallet flows ask only for the bowler,
league, amount, and tender method. The server takes the league lock, reads
the current canonical responsibility and collection-group evidence, and
derives FIFO allocations. A quote fingerprint is advisory immutable evidence;
finalization recomputes the candidate set under the same lock and rejects
drift, stale reservations, review-required evidence, and amounts larger than
the remaining eligible balance.

For weekly leagues, FIFO order is effective collection order: older unpaid or
past-due obligations, the current due occurrence, a paired final occurrence
when its published trigger arrives, and then future occurrences. Stable
member, billing, occurrence, and obligation identities break ties. Each
oldest obligation is completed before the next is selected; a final remainder
may partially settle the next obligation. Weekly payments may prepay future
weeks. Upfront leagues require the complete remaining balance.

Standing automatic payment is current-point-only. It is blocked by any older
open, partially settled, or reserved debt, which must be settled by a one-time
FIFO payment first. A published double-pay group is captured in one operation
and one tender parent with exactly two hidden allocations. Provider calls stay
outside database transactions and retain idempotency, leases, fencing, and
reconciliation behavior.

## Corrections and presentation

Cash/check correction is a whole-payment void: all active allocations are
voided together and a `payment_voids` audit row records the actor and reason.
A corrected tender is a separate new FIFO entry. Card correction remains a
provider refund/reconciliation operation. Receipts and ordinary history show
the tender total/date and remaining unpaid balance or weeks; allocation IDs
and obligation details are restricted to audit/reporting views.

## Clean-slate migration

Migration `0035_automatic_fifo_payment_allocation` is intentionally a
fail-closed boundary. It locks the payment/provider evidence tree, requires
the pre-cutover schema, and aborts before DDL if any payment, allocation,
operation, consent, standing snapshot, refund, dispute, financial-command,
or provider-linked webhook evidence exists. No payment data is inferred or
backfilled. Benign webhook inbox rows and provider customer/card identities
remain untouched. The migration removes per-allocation parent columns and
legacy correction lineage, adds tenant-safe parent keys and amount/currency
checks, and creates the whole-payment void audit table.
