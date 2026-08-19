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

## Money-path contract

The due instant is the exact published/locked collection-point occurrence
`startAt`; a future wake only arms that instant, and a late wake may execute
immediately. A cancelled, discarded, or superseded occurrence cancels the
ready plan durably. F4 never invents a makeup date or retargets an obligation.
Each D2 plan has exactly one direct Square charge. A double-pay plan carries
both real occurrence obligations, while a combined payer remains one charge;
there is no catalog/order line-item flow. Payment rows are aggregated per
bowler and the occurrence supplement retains each item identity.

Immediately before dispatch, the worker rechecks the complete live F1
activation and F3 policy/provenance/plan, exact occurrence and collection point,
obligations and reservations, payer authorization and consent items, active
memberships, accepted partner links, payer-owned customer/card, and current
tenant location/provider scope. The org/league advisory lock, plan lock, and
operation lease establish one explicit cutoff shared with F3 revoke/supersede:
revoke-first cancels pending work with zero provider calls; claim-first permits
only that exact in-flight operation to complete and blocks later plans.

The worker leases with the existing fencing/retry state machine. A hard decline
is `action_required`, preserves exact evidence for follow-up, and blocks later
plans under that authorization. Definitive no-charge invalid/configuration
errors release or cancel the exact reservation; transient errors clear the
dispatch claim and retry the same operation/key; provider-unknown and
reconciliation-required states retain the claim, provider identity, and exact
snapshot. Confirmed success atomically writes payments, allocation and
obligation revisions, plan fulfillment evidence, and the immutable operation.
Webhook and explicit reconciliation completion use the same finalizer and are
idempotent. Refunds and disputes retain the original F4 operation and never
automatically reopen or reassign an obligation; no compensating refund is
created by F4.

Gate-off excludes F4 plan wakes, preparation, automatic leases, retries, and
provider calls while preserving legacy scheduled/interactive/refund wakes and
uncertain F4 rows for explicit reconciliation. No receipt or report UI is
required in F4.

`dispatchClaimedAt` is null for every non-canonical operation and for a
canonical operation before its leased attempt. A canonical claim is written
only at the serialized cutoff after the attempt has started; terminal
action-required/definitive states may retain that historical claim as audit
evidence, while retryable configuration/transient states clear it before the
next cutoff. Provider-unknown and reconciliation-required states retain it.

## Migration and rollout

Migration `0028_phase_f4_canonical_scheduled_execution` is additive and has no
backfill, destructive statement, or down migration. It adds tenant-scoped F4
operation/snapshot linkage, immutable snapshot guards, occurrence evidence,
  and tenant-scoped operation/snapshot indexes used by the canonical wake
  anti-join without changing prior operation domains. A
deployment does not authorize enabling either gate. Before the first F4 row,
rollback is ordinary code rollback; after F4 evidence exists, rollback is a
traffic pause and forward fix that preserves the evidence and original key.

The focused smoke matrix exercises direct completed conservation (payments,
allocations, obligation and plan revisions), invalid-card and configuration
recovery, ownership/membership/partner/policy/activation/occurrence/item and
location drift, revoke/dispatch cutoff, hard-decline blocking, duplicate
fencing, webhook/reconciliation convergence, tenant-scoped future wake/index
planning, migration constraints, and legacy v1/v2 compatibility. Tests use
isolated PostgreSQL and fake providers only; secrets and raw provider payloads
are never logged.
