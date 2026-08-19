# Phase F4: canonical scheduled execution

F4 is the separately gated worker-owned execution path for the immutable D2
plans prepared by F3. It introduces the `canonical_autopay_charge` operation
type and the `canonical-autopay-plan:<d2PlanId>` target namespace. Existing
`scheduled_charge`, interactive, setup, refund, dispute, webhook, and payment
schedule rows are never upgraded or blended.

Preparation is enabled only when F1 is live, F3 setup is enabled, the F4 gate
`LEAGUEVAULT_F4_CANONICAL_AUTOPAY_EXECUTION_ENABLED` is true, and
`SCHEDULED_PAYMENT_EXECUTION_MODE=ledger_execute`. It takes the league
serialization lock, revalidates the exact approved policy, payer
authorization, activation, occurrence, ready plan, and item balances, then
creates one operation, an immutable `canonical-autopay-execution/1` snapshot,
and the `payment-operation-occurrence-snapshot/1` allocation supplement in one
short serializable transaction. Provider lookup and `processPayment` happen
after commit using the separately-derived F4 Square key.

The worker leases with the existing fencing/retry state machine. Snapshot or
authorization drift fails closed without a provider call; provider-unknown and
local-finalization failures retain the operation and exact key for recovery.
Gate-off excludes F4 plan wakes, preparation, leases, retries, and provider
calls while preserving legacy wakes and uncertain rows for reconciliation.

Migration `0027_phase_f4_canonical_scheduled_execution` is additive and has no
backfill or down migration. A deployment does not authorize enabling either
gate. Once F4 evidence exists, rollback is a traffic pause and forward fix;
never remove or reinterpret the immutable evidence.
