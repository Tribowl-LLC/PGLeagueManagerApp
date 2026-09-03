# Standing roster automatic payments

Standing automatic payments are a payer-controlled, weekly-only consent for a
roster-configured league. The consent binds one tenant-owned saved provider
source/customer and an explicit list of accepted same-tenant partner links.
There is no payer plan, future obligation list, or legacy payment schedule.

At the authoritative occurrence cutoff, the ledger worker takes the league
advisory lock, revalidates consent, membership, partner-link fingerprints and
roster versions, then selects only the current collection point. Any older
open, partially settled, or reserved obligation—including one predating consent
activation—blocks the charge. A published double-pay group is selected by its
stored collection-group membership, never by date or amount. The worker writes
a `standing_autopay_charge` operation, immutable roster snapshot, participant
evidence, financial command and reservations before committing; provider I/O
occurs only after commit. Success creates one tender parent and one allocation
per covered obligation.

Standing provider charges are classified as unattended card-not-present
payments. The consent status read (`GET .../standing-autopay/1`) includes only
the narrow `paymentAttention: "scheduled_payment_declined"` signal when the
current consent has an actionable hard-declined charge with at least one
unsettled obligation. It does not expose provider or operation identifiers.
The signal clears when a one-time FIFO payment settles those obligations, so
the normal next-cutoff quote becomes visible again; the client refetches both
status and quote after a successful one-time payment.

Cutoff preparation failures are recorded durably per consent version, cutoff,
and occurrence revision. A transient failure is deferred with exponential
backoff (one minute through six hours), so another payer due at the same time
becomes the next scheduler wake instead of being held behind the failure. Each
payer remains FIFO: a failed older cutoff prevents that payer's later cutoffs
from overtaking it. Eleven consecutive preparation failures become terminal for
that consent cutoff while other payers continue normally.

The capability is gated by `ROSTER_STANDING_AUTOPAY_ENABLED=true` and requires
`SCHEDULED_PAYMENT_EXECUTION_MODE=ledger_execute`. The default is off. Upfront
leagues require a one-time payment for their complete remaining balance;
scheduled upfront collection is not supported.

Migration `0035_automatic_fifo_payment_allocation` establishes the one-tender
parent model and refuses to reshape unexpected payment/allocation/provider
evidence. Benign provider identities and webhook inbox rows remain intact.
Provider unknown, cancellation, partner revocation, and roster drift preserve
durable operation evidence and enter reconciliation; they never silently drop
a participant or issue an automatic refund.
