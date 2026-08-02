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

## Phase 2B-1 boundary (migration 0008)

Phase 2B-1 remains dormant. It adds only the data and service primitives needed
to make the later scheduled-charge cutover reviewable:

- forward-only additive migration
  `0008_scheduled_payment_operation_execution`;
- one encrypted, versioned execution snapshot per scheduled operation, plus
  structured allocation and Square order-line children;
- deterministic, domain-separated Square order and payment keys;
- structured provider failure dispositions;
- transaction-capable operation creation/snapshot and atomic
  operation/payment-row finalization primitives;
- atomic attempt-exhaustion and expired-lease recovery bookkeeping; and
- an unconnected one-shot operation wake component.

No scheduler, startup hook, route, payment lifecycle, interactive charge,
refund, or Square webhook constructs or starts the operation executor in this
phase. The production scheduled-payment path remains the legacy path. Migration
0008 performs no backfill, and the Phase 2A application safely ignores all new
tables and nullable columns.

Production must explicitly set `SCHEDULED_PAYMENT_EXECUTION_MODE`. Missing mode
with either `NODE_ENV=production` or `APP_ENV=prod` fails startup. The modes are:

| Mode | Phase 2B-1 behavior | Phase 2B-2 contract |
| --- | --- | --- |
| `legacy` | Existing scheduled behavior; operation wake code is not started | Temporary rollback-compatible mode, subject to the nonterminal-operation guard |
| `ledger_paused` | Existing scheduled behavior remains unchanged; the dormant operation wake component performs no query and creates no timer | No ledger provider calls, no executor query/timer/hot loop, and no legacy fallback for a cycle represented in the ledger |
| `ledger_execute` | Still inert because nothing wires the component | The only mode permitted to lease and call Square for scheduled ledger operations |

`ledger_execute` must not be selected in production for the Phase 2B-1 commit.
The Phase 2B-1 `ledger_paused` setting proves the startup gate and zero-query
executor behavior; it does not claim to pause the still-unmodified legacy
scheduler.

## Immutable scheduled execution snapshot

The snapshot is the minimum semantic input needed to reconstruct exactly the
same Square request. Sensitive source, customer, and buyer-email references are
encrypted with the existing `FIELD_ENCRYPTION_KEY` AES-256-GCM mechanism. No
new secret is required. Card numbers, CVVs, credentials, authorization headers,
raw responses, and raw provider errors are prohibited.

The canonical `lvpayexec:v1` fingerprint covers every
Square-idempotency-relevant field:

- tenant, schedule, UTC billing cycle, amount, currency, and provider;
- immutable league, internal location, and Square location context;
- direct-versus-order request shape;
- independently derived payment and optional order idempotency keys;
- `autocomplete` and `storeCard` request semantics;
- encrypted-at-rest source, customer, and buyer-email values (plaintext only
  while calculating or reconstructing the semantic fingerprint);
- double-pay and paid-in-full calculation inputs;
- every allocation index, bowler, total, lineage/prize split, note, and
  paid-by-user reference; and
- every Square catalog object identifier, line index, and quantity.

The children use stable indexes and database uniqueness. Allocations must sum
to the operation total. An order request must have line items and both keys; a
direct request must have neither order line items nor an order key. On every
retry the encrypted fields are authenticated and the complete fingerprint is
recomputed. Decryption, validation, derived-key, or fingerprint mismatch fails
closed before provider dispatch. Mutable schedule, league, partner-link,
payment-method, location, or catalog rows are not an alternative source for an
existing operation.

The 42-character Phase 2A logical provider key is never suffixed. Square keys
are derived with distinct `order` and `payment` domains and are each independently
at most 45 characters.

## Atomic local finalization and failed history

Success finalization conditionally changes the leased operation to `succeeded`
and inserts all local `payments` rows in one database transaction, guarded by
tenant, operation UUID, `leased` state, and the exact lease token. Nullable
`payments.payment_operation_id` plus the allocation index link split rows to
the operation. A partial unique index permits several legitimate combined rows
with one provider payment ID while preventing a second local row for the same
operation/allocation.

If any payment-row insert fails, the operation transition rolls back and stays
recoverable under its lease. The storage layer has no provider or refund
dependency: a database finalization failure can never initiate an automatic
compensation refund. Recovery must replay Square with the identical request
and keys, accept Square's original idempotent result, and retry the same local
transaction.

Phase 2B-2 must preserve the existing deliberate failed-history behavior: no
row for a transient attempt, and at most one operation-linked failed row when a
hard decline or terminal policy requires history. For a combined charge this
preserves the legacy shape: one ungrouped payer-level failed row for the payer's
base scheduled amount, not one row per payee, the combined provider total, or
each retry. The terminal transition and that row insert are one transaction and
idempotent on replay.

Attempt eight transitions directly from the completing lease to
`failed_terminal`, clears `next_attempt_at`, sets `completed_at` and sanitized
`ATTEMPTS_EXHAUSTED`, and inserts any deliberate terminal history in the same
transaction. It cannot briefly become retryable, and lease acquisition requires
an attempt count below eight.

## Dormant one-shot wake infrastructure

The wake query returns only the earliest `next_attempt_at` for pending,
provider-unknown, or retry-scheduled work, or the earliest lease expiration.
The component uses one unreferenced timeout, re-queries only at startup or after
a committed operation transition, and leaves no timer when the queue is empty.
An unchanged overdue row after a handler returns is treated as missing durable
progress and stops instead of forming a hot loop. `legacy` and `ledger_paused`
return before the first queue query or timer. Phase 2B-1 does not start this
component at all.

Provider results preserve structured Square information before a generic user
message is chosen: ambiguous transport and non-specific 5xx outcomes are
`provider_unknown`; 429 and Square's documented `TEMPORARY_ERROR` are definite
transient results; hard card errors are `action_required`; authentication,
location, permission, and processing-enable errors are configuration failures;
and definite bad requests are invalid. Known provider order IDs may be retained
for reconciliation. Only sanitized codes enter the ledger.

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

## Exact Phase 2B-2 scheduled-charge cutover

1. Require migrations `0007_payment_operation_ledger` and
   `0008_scheduled_payment_operation_execution` to be present and verified
   before deploying the cutover application.
2. In one short `SERIALIZABLE` transaction (with bounded serialization retry),
   lock the exact schedule row `FOR UPDATE`, re-read the joined tenant/league
   state inside that transaction, and validate the tenant and immutable charge
   calculation (including double-pay and combined payees). Insert or verify the
   cycle operation, advance the schedule to its next normal cycle, and commit.
   No provider call occurs in this transaction. Every preparation code path
   must use this isolation/locking contract. Upfront schedules deactivate after
   their one prepared payment and create no future recurring cycle.
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

Before the first legacy Square call, Phase 2B-2 must tenant-scope a check for
any nonterminal operation on that schedule. If one exists, legacy execution is
prohibited even if the mode is changed back to `legacy`; the operation must be
paused or recovered through the ledger. Duplicate scheduler delivery must
re-enter the same locked preparation and converge on the same operation.

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

## Phase 2B-1 migration-first deployment and verification

Migration 0007 is already present in production. Migration 0008 is additive,
starts empty, needs no backfill, and uses only the existing field-encryption
key. Use this exact sequence for the 2B-1 release:

1. Leave the PR unmerged until every GitHub check is green and the migration
   SQL, Drizzle snapshot, journal entry, and checksum are reviewed. Record the
   exact certified main SHA.
2. Set Render Auto-Deploy to **Off before merging** the schema release. Confirm
   it remains Off after merge and certification.
3. Confirm production still reports the previously verified Phase 2A-or-later
   SHA, `/healthz` is `ok`, `/api/health` is healthy, and scheduled,
   interactive, and refund smoke checks are normal.
4. Create/verify the intended Neon backup or restorable branch and record the
   exact database target. Do not proceed on a target, journal, or fingerprint
   mismatch.
5. Drain the old application instance: suspend the single Render web service,
   wait for active HTTP requests to finish, and verify no service instance or
   scheduled-payment process remains running. This prevents a scheduler from
   crossing the migration/deploy boundary.
6. While the service is suspended, set
   `SCHEDULED_PAYMENT_EXECUTION_MODE=ledger_paused` together with the existing
   production values (`APP_ENV=prod`, `NODE_ENV=production`). Do not select
   `ledger_execute`.
7. From the exact CI-certified release SHA, run the guarded migration preflight
   and `npm run db:migrate` once against the recorded Neon target. Verify
   migration 0008's checksum/journal row, three snapshot/child tables, nullable
   payment linkage, operation recovery columns, constraints, and indexes.
8. Manually deploy that same exact SHA and resume one Render instance while
   Auto-Deploy remains Off. Verify the runtime commit, `/healthz`,
   `/api/health`, authentication, tenant isolation, and startup logs showing
   explicit `ledger_paused` with no operation lease, queue query, wake timer,
   or Square operation call.
9. Run deterministic sandbox/fake-provider smoke checks for one normal legacy
   scheduled payment, one interactive payment, and one refund. Confirm no
   `payment_operations` or snapshot rows were created by those production
   paths and no payment amount/receipt/refund behavior changed.
10. Observe at least one full idle autosuspension window: no empty operation
    query/timer may appear in logs or Neon query history, and Neon compute must
    return to autosuspended state. Restore normal Render Auto-Deploy only after
    this release is accepted; do not activate `ledger_execute` in 2B-1.

If migration 0008 fails, keep Render suspended and Auto-Deploy Off, preserve all
output, and use the reviewed Neon restore procedure when necessary. Do not edit
0007/0008, invent a reverse migration, or deploy 2B-1 code without its schema.

Before any 2B-2 cutover, repeat steps 1-8 with the new certified commit and an
old-instance drain, initially deploying 2B-2 in `ledger_paused`. Verify no
legacy or ledger provider dispatch occurs for a cycle with a nonterminal
operation, then switch only the environment mode to `ledger_execute`, deploy
one instance, and confirm: one due cycle creates one immutable operation,
schedule cursor advancement commits before Square, one lease winner dispatches,
local rows link atomically, retries retain keys/fingerprint, the queue arms only
its earliest real wake, and idle Neon autosuspends. Activation is an explicit
operator action; no default enables it.

For 2B-1 rollback, suspend the service, restore the prior Phase 2A application,
and retain migration 0008. Because 2B-1 never creates scheduled ledger work,
the prior application safely ignores the additive structures. Keep production
mode requirements appropriate to the deployed revision and rerun health,
tenant, scheduled, interactive, and refund checks before resuming.

After 2B-2 has created any nonterminal operation, do **not** roll back to an
application lacking the nonterminal-operation legacy guard and resume billing;
that could charge a ledger-represented cycle through legacy code. The safe
rollback is: set `ledger_paused`, drain/suspend all instances, preserve schedule
cursors and operations, reconcile every ambiguous/provider-success state, and
deploy a forward fix or a reviewed guarded revision. Never delete operations,
move schedule cursors backward, or refund a confirmed provider success merely
because local finalization failed.
