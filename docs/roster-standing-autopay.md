# Standing roster automatic payments

Standing automatic payments are a payer-controlled, weekly-only consent for a
roster-configured league. The consent binds one tenant-owned saved provider
source/customer and an explicit list of accepted same-tenant partner links.
There is no payer plan, future obligation list, or legacy payment schedule.

## Combined due-now checkout

Interactive payment v3 exposes `dueNowMinor`, `catchUpWeeks`, and
`catchUpAmountMinor` for each participant. Due-now membership uses the
authoritative `dueAt <= transaction_timestamp` boundary. The charge is the
smallest canonical FIFO prefix through the last due obligation, ordered by
published `effectiveCollectionAt`. A future paired obligation can therefore be
part of the prefix when its published collection position precedes a due
obligation. `catchUpAmountMinor` is the exact amount charged by
`dueNow: true`; `catchUpWeeks` is the stale-selection token and must still
match. A due-now selection contains exactly one self payer recipient. Zero due
returns zero and cannot be quoted as a due-now charge.

After the charge succeeds, the standing consent request may carry its
`paymentOperationId` instead of a direct `sourceId`. The server accepts that
operation only when its v3 snapshot is self-only due-now evidence for the same
tenant, league, actor, payer, and provider location, and the ledger contains a
finalized paid payment with matching active allocations. Saved-card evidence
must remain payer-owned. A new-card checkout must have `storeCard: true` and a
completed saved-card result; wallet evidence cannot authorize standing
consent. The first new-card checkout bootstraps a missing provider customer
before charge preparation and fails closed if the customer ID is not durably
saved on the payer.

Consent command fingerprints include the operation ID for operation-derived
requests. An applied command is replayed from its durable result before card
ownership lookup, including after a lost response or later provider/card state
change; a fresh request performs authoritative card ownership validation while
holding the league schedule lock. New consent activation also checks due-at-
arrived outstanding or reserved FIFO obligations under that lock. Replacing an
already active consent keeps the existing replacement behavior and does not add
this initial due-now guard.

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
unsettled obligation. For an active consent it may also include display-only
`paymentMethod` metadata (`brand` and `last4`) after the server resolves the
encrypted source/customer against the provider card list outside the schedule
transaction. Provider or operation identifiers are never exposed, and a
provider lookup failure leaves the active status intact with `paymentMethod`
set to `null`.
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
