# Phase 4B dispute design

## Provider contract

LeagueVault's Square subscription is pinned to API version `2026-05-20`.
Square publishes `dispute.created` when a bank opens a dispute and
`dispute.state.updated` whenever its state changes, including final `WON` and
`LOST` outcomes. The payload contains the Square dispute ID, challenged
payment ID, location, amount/currency, reason, state, response deadline,
timestamps, and numeric object version.

The supported states are:

- `INQUIRY_EVIDENCE_REQUIRED`
- `INQUIRY_PROCESSING`
- `INQUIRY_CLOSED`
- `EVIDENCE_REQUIRED`
- `PROCESSING`
- `WON`
- `LOST`
- `ACCEPTED`

The disputed amount can be less than the original charge. `WON` releases held
funds; `LOST` and `ACCEPTED` return funds to the cardholder. These outcomes are
provider dispute facts, not LeagueVault refunds.

Official references:

- [dispute.created](https://developer.squareup.com/reference/square/disputes-api/webhooks/dispute.created)
- [dispute.state.updated](https://developer.squareup.com/reference/square/disputes-api/webhooks/dispute.state.updated)
- [Process Disputes](https://developer.squareup.com/docs/disputes-api/process-disputes)

## Identity and state model

The existing `payments.status` is deliberately not used for Phase 4B dispute
state. A refund and dispute can coexist, and one Square charge can produce
multiple LeagueVault allocation rows. Forcing either lifecycle into the one
payment status or one allocation row would lose information.

Phase 4B stores one independent provider dispute per Square dispute ID. It is
linked to the unique succeeded scheduled or interactive charge operation whose
tenant-scoped Square payment ID matches `disputed_payment.payment_id`. The
operation snapshot must match local/provider location and currency, its amount
must cover the potentially partial dispute, and its finalized payment
allocations must still be complete. Missing or ambiguous operations are not
owned by LeagueVault and cannot mutate payment or dispute business state.

Application, merchant, tenant, location, charge operation, provider payment,
amount, currency, reason, and provider dispute identity become immutable after
the first accepted version. The numeric Square dispute version controls
freshness. Older events are ignored; equal conflicting evidence fails closed;
newer versions may advance the independent dispute state.

## Crash, replay, and CU behavior

The webhook inbox row and independent dispute insert/update commit in one
PostgreSQL transaction. A crash before commit changes neither. A retry after
commit observes terminal inbox state and returns idempotent success. Concurrent
deliveries serialize without provider I/O.

Phase 4B adds no provider polling, inbox scan, startup sweep, fixed timer, or
empty query. Dispute reconciliation does not rearm the payment recovery
scheduler. Previously acknowledged dispute events remain pending until a
future deliberate event-ID replay action; changing modes never scans them.

## Activation and PR decomposition

`reconcile_payments` retains the deployed Phase 4A-2 behavior and continues to
acknowledge disputes without terminalizing them. The additive
`reconcile_payments_and_disputes` mode is the separate activation boundary.
The default remains `disabled`.

Migration 0016 is safe to apply before the application because Phase 4A-2
does not reference the new table. Deploy 4B-1 while preserving the current
`reconcile_payments` value, then activate the wider mode only in a separate
reviewed manual deployment. To roll back after activation, first restore
`reconcile_payments`, deploy the Phase 4A-2 application, and retain migration
0016 plus all independent dispute and inbox evidence.

The safe PR sequence is:

1. **4B-1:** additive dispute ledger, complete normalized evidence, atomic
   version-fenced reconciliation, explicit activation mode, retention rules,
   and PostgreSQL race/out-of-order tests. No provider calls, payment-status
   mutation, notifications, API, or UI.
2. **4B-2:** tenant-safe read APIs, durable notifications, and audited explicit
   replay of a pending event ID. Org admins remain confined to their tenant;
   system admins must select a tenant deliberately.
3. **4B-3A:** independent refund/dispute UX, provider-deadline and immutable
   state-history presentation, and tenant-wide acknowledgement of one exact
   provider version. This remains provider-effect-free and is specified in
   `docs/phase4b3a-dispute-acknowledgements.md`.
4. **4B-3B:** deferred indefinitely. Accepting a dispute or submitting
   evidence to Square is an irreversible provider effect and is intentionally
   not part of LeagueVault's dispute workflow.

Phase 4B-2 is implemented as the provider-effect-free operational slice
described in [Phase 4B-2 dispute operations](./phase4b2-dispute-operations.md).
It adds bounded tenant reads, transactionally durable in-app notifications,
and audited replay of one explicit retained pending dispute event ID. It adds
no email, UI, provider call, timer, sweep, or polling path.
