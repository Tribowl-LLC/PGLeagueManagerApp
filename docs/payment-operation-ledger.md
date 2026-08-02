# Payment operation ledger

## Phase 2A boundary

`payment_operations` is dormant infrastructure. Phase 2A creates the table,
stable request identity, and atomic storage operations, but it does not import
them from a scheduler, timer, route, startup hook, webhook, payment lifecycle,
or Square adapter. Existing scheduled charges, interactive charges, combined
charges, refunds, schedule progression, and the 60-second overdue behavior are
unchanged.

The ledger stores operational identifiers and sanitized classifications only.
It must never contain a card number, CVV, access token, authorization header,
raw provider response, raw provider error detail, payment source token, or
unnecessary customer data.

## Data and identity invariants

One row represents one logical provider operation. Supported operation types
are `scheduled_charge`, `interactive_charge`, and `refund`.

- `organization_id` is required, and every application read or mutation is
  qualified by it.
- `amount_minor` is an immutable positive integer. `currency` is an immutable
  uppercase three-letter code.
- A scheduled charge requires `payment_schedule_id` and `billing_cycle_at`.
  A partial unique index permits only one scheduled-charge operation for that
  schedule and UTC cycle timestamp. Interactive charges and refunds are not
  covered by that uniqueness predicate.
- `request_fingerprint` is `lvpayreq:v1:` plus the complete SHA-256 digest of
  canonical immutable input. The canonical input includes request version,
  tenant, operation type, internal target key, schedule/cycle when applicable,
  amount, currency, and provider.
- `provider_idempotency_key` is globally unique. It uses a readable version/type
  prefix and 192 SHA-256 bits encoded with base64url, producing a 42-character
  key under Square's 45-character limit.
- A recurring uniqueness conflict is returned as the existing operation only
  after every immutable field, fingerprint, and provider key matches. Any
  amount, currency, tenant, target, cycle, type, or provider mismatch fails
  closed.

The provider key does not contain wall-clock time, process identity, a random
value, attempt number, payment source, or personal information. Retries of the
same immutable request must reuse it exactly. For Square order-plus-payment
flows, Phase 2B must derive distinct deterministic order and payment keys from
the same fingerprint, each independently at most 45 characters; it must not
append `-order` or `-pay` to the stored 42-character key.

## State machine

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `pending` | Durable operation exists and is due | `leased`, `canceled` |
| `leased` | One worker owns a time-bounded attempt | `retry_scheduled`, `provider_unknown`, `succeeded`, `action_required`, `failed_terminal`, `canceled`, or `leased` after expiry/reclaim |
| `provider_unknown` | The provider may have accepted the request, but the caller did not receive a conclusive result | `leased` when recovery is due, `canceled` by deliberate reconciliation policy |
| `retry_scheduled` | A classified retry is due at `next_attempt_at` | `leased`, `canceled` |
| `succeeded` | Provider effect is confirmed and its object ID is stored | terminal |
| `action_required` | A hard decline or other customer/admin action is required | terminal in Phase 2A |
| `failed_terminal` | No automatic retry is permitted | terminal |
| `canceled` | The operation was deliberately stopped before success | terminal |

Database checks bind state to data: due states require `next_attempt_at`;
`leased` requires owner, token, and expiration; terminal states require
`completed_at`; success requires a provider object ID; retry/unknown/error
states require a sanitized classification; attempts are bounded at eight.
Retry due times must be in the future and within 30 days. Leases are bounded at
15 minutes.

## Lease and stale-worker protection

Acquisition and expired recovery use one conditional
`UPDATE ... WHERE ... RETURNING` statement. The update changes the state to
`leased`, replaces the random lease token, records the owner/expiration, and
increments the attempt count. A second worker cannot match an unexpired lease.

Every outcome mutation requires the tenant, operation UUID, `leased` state,
and exact lease token. When an expired lease is reclaimed, its new token fences
the old worker from retrying, canceling, or finalizing the row. Terminal states
retain the completing token so replaying the same success write with the same
provider object ID is idempotent; an older token still fails.

Recurring creation uses one short ownership-check/insert transaction. Every
lease and outcome transition is one conditional statement (with a follow-up
read only for deliberate transition diagnosis). No storage primitive accepts
provider work or exposes a transaction that a caller could hold during
provider HTTP. Phase 2B must keep that boundary: commit durable intent/lease
first, call Square without a database transaction, then commit the classified
result with the lease token.

## Provider-unknown recovery

An HTTP timeout, dropped connection, or ambiguous response after dispatch must
not be treated as a normal failure. The worker records `provider_unknown` with
a bounded recovery time and sanitized code, clears its active lease, and keeps
the immutable fingerprint/key.

Phase 2B recovery will lease that row for reconciliation. If a provider object
ID is known, it will query that object. Otherwise it will resend only the exact
immutable request with the exact same provider idempotency key, allowing the
provider's idempotency contract to return the original effect rather than
creating a new logical charge. A changed request must create a different key
and cannot reuse the row. Reconciliation records `succeeded`, schedules a
bounded retry, or sends the operation to `action_required`/`failed_terminal`;
it must never guess success from a transport error.

## Exact Phase 2B scheduled-charge cutover

1. Require migration `0007_payment_operation_ledger` to be present and verified
   before deploying the cutover application.
2. In one short transaction, lock the current schedule cycle, validate the
   tenant and immutable charge calculation (including double-pay and combined
   payees), insert or verify the cycle operation, advance the schedule to its
   next normal cycle, and commit. No provider call occurs in this transaction.
3. Replace direct scheduled execution with an event-driven wake for the newly
   due operation. Do not add a fixed recurring database sweep; arm the next
   wake from `next_attempt_at`/lease expiry and retain a bounded recovery path.
4. Atomically lease the operation. Only the lease winner constructs the exact
   immutable request and calls Square with the stored stable key. The Square
   order flow receives independently derived stable order/payment keys that
   both satisfy the 45-character limit.
5. Persist success plus provider object ID and the existing business payment
   rows, or persist a classified retry/unknown/action/terminal outcome, using
   the lease token. Schedule advancement must not be rolled back because the
   provider call failed.
6. Add reconciliation/operational visibility for `provider_unknown`, expired
   leases, exhausted attempts, and action-required arrears before enabling the
   cutover in production.
7. Run focused schedule, combined-payment, tenant, Square, race, and rollback
   tests; deploy the exact CI-verified main commit only after migration-first
   release checks.

Interactive charges and refunds should adopt the same create/lease/call/finalize
shape in later scoped changes. They are not part of the Phase 2B scheduled
cutover unless that PR explicitly includes and tests them.

## Hard-decline policy

The selected technical default for Phase 2B is:

- advance the recurring schedule normally after the cycle operation is
  durably created;
- preserve a hard-declined cycle as an `action_required` arrear;
- do not retry hard declines every minute; and
- continue creating future cycles according to the schedule unless an explicit
  organization/payment policy pauses them.

What remains a product-policy decision is the shape and authorization of an
explicit organization-level pause rule, notifications, and arrears-resolution
UI. Phase 2A implements none of those behaviors.

## Migration-first deployment

This additive table starts empty and needs no backfill. Hold Render Auto-Deploy,
back up the intended Neon database, and run `npm run db:migrate` from the exact
CI-verified commit. Expected output includes successful application of
`0007_payment_operation_ledger` and no unexpected schema statements. Inspect
the migration journal/table and the new empty table/indexes, then release the
matching application commit. Verify `/api/health`, `/healthz`, authentication,
tenant isolation, and representative scheduled/interactive/refund workflows.

The previous application revision safely ignores the additive table. Normal
rollback is therefore an application rollback while retaining the table and
its rows; do not drop it as part of rollback. If migration application fails,
stop before application deployment and restore from the reviewed backup when
required.
