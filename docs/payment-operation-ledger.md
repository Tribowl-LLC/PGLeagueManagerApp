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

## Phase 2B-2 boundary (migration 0009)

Phase 2B-2 cuts scheduled charges over in code but remains activation-gated.
Migration 0009 is required because migration 0008 cannot represent the
automatic-execution terminal state where Square may already have charged:
`reconciliation_required` stops automatic leasing without asserting payment
failure and retains the exact token for explicit confirmation. The migration
also adds the partial active-schedule next-date index used by the unified wake
query. It changes no existing data, provider identity, or configured execution
mode; it only replaces payment-operation checks forward and adds the index.

Interactive charges, refunds, and webhooks remain outside this phase.

Production must explicitly set `SCHEDULED_PAYMENT_EXECUTION_MODE`. Missing mode
with either `NODE_ENV=production` or `APP_ENV=prod` fails startup. The modes are:

| Mode | Phase 2B-2 behavior |
| --- | --- |
| `legacy` | Legacy scheduled billing remains active, protected by the exact-cycle advisory lock and durable ledger guard; the ledger wake component performs no query or timer. |
| `ledger_paused` | Same legacy execution as `legacy`, including its safety guard. The ledger executor performs no operation query, wake timer, lease, or Square call. This is the required initial deployment mode. |
| `ledger_execute` | Legacy jobs/backstop are stopped. The unified one-shot scheduler prepares schedules and executes ledger operations. This is the only mode permitted to lease and call Square for scheduled ledger operations. |

Phase 2B-2 is safe to deploy in `ledger_paused`; activation remains a separate
operator action. Neither deployment nor migration 0009 changes the configured
mode.

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

Attempt eight for a provider-confirmed transient result may transition to
`failed_terminal`. Attempt eight for an uncertain provider outcome instead
transitions to `reconciliation_required`, clears automatic due/lease fields,
retains the exact fencing token, and records `PROVIDER_OUTCOME_UNCERTAIN` with
no failed payment-history row. It cannot be leased automatically again. An
explicit reconciliation may use that retained token to finalize a confirmed
Square success idempotently.

## Unified one-shot wake infrastructure

One query returns the earlier of (a) the earliest active
`payment_schedules.next_payment_date` whose tenant-owned cycle requires
preparation and (b) the earliest operation `next_attempt_at` or lease
expiration. Thus an empty operation table cannot forget a future schedule. The
component uses one unreferenced, safely clamped timeout, re-queries only at
startup or after a committed schedule/operation mutation, and leaves no timer
only when both work sources are empty.
An unchanged overdue row after a handler returns is treated as missing durable
progress and stops instead of forming a hot loop. A real overdue-work handler
failure gets one 60-second recovery wake, preserving the overdue discovery
guarantee without an empty sweep. `legacy` and `ledger_paused` return before
the first unified query or timer.

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
| `leased` | One worker owns a time-bounded attempt | `retry_scheduled`, `provider_unknown`, `succeeded`, `action_required`, `reconciliation_required`, `failed_terminal`, `canceled`, or `leased` after expiry/reclaim |
| `provider_unknown` | The provider may have accepted the request, but the caller did not receive a conclusive result | `leased` when recovery is due, `canceled` by deliberate reconciliation policy |
| `retry_scheduled` | A classified retry is due at `next_attempt_at` | `leased`, `canceled` |
| `succeeded` | Provider effect is confirmed and its object ID is stored | terminal |
| `action_required` | A hard decline or other customer/admin action is required | terminal in Phase 2A |
| `reconciliation_required` | Automatic execution stopped because a charge may exist; this is not proof of failure | explicit token-fenced confirmation may finalize `succeeded` |
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

Phase 2B recovery leases that row for reconciliation. If a provider object ID
is known, it queries that object. Otherwise it resends only the exact
immutable request with the exact same provider idempotency key, allowing the
provider's idempotency contract to return the original effect rather than
creating a new logical charge. A changed request must create a different key
and cannot reuse the row. Reconciliation records `succeeded`, schedules a
bounded retry after a provider-confirmed retryable result, or sends a confirmed
result to `action_required`/`failed_terminal`. Repeated unknowns end in
`reconciliation_required`, never in a state asserting failure. Recovery must
never guess success from a transport error.

## Exact Phase 2B-2 scheduled-charge cutover

1. Require migrations `0007_payment_operation_ledger` and
   `0008_scheduled_payment_operation_execution` to be present and verified
   before deploying the cutover application.
2. In one short `SERIALIZABLE` transaction (with bounded serialization/deadlock
   retry), acquire the transaction advisory lock for the versioned exact-cycle
   identity on that same database session, lock the schedule row `FOR UPDATE`,
   re-read the joined tenant/league
   state inside that transaction, and validate the tenant and immutable charge
   calculation (including double-pay and combined payees). Insert or verify the
   cycle operation, advance the schedule to its next normal cycle, and commit.
   No provider call occurs in this transaction. Every preparation code path
   must use this isolation/locking contract. Upfront schedules deactivate after
   their one prepared payment and create no future recurring cycle.
3. Replace direct scheduled execution with the unified schedule/operation
   one-shot wake. Do not add a fixed recurring database sweep.
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

Before a legacy Square call, the worker holds a nonblocking session advisory
lock for the versioned exact-cycle identity on one dedicated connection. It
must confirm advisory unlock before returning that connection; otherwise the
connection is destroyed. While locked it tenant-scopes the durable guard.
Every status blocks its own exact cycle; a currently leased operation and an
older `provider_unknown`/`reconciliation_required` operation also block more
broadly for rollback safety. Older `action_required` and definite failures do
not block later cycles. Duplicate scheduler delivery re-enters the same lock.

Legacy and ledger paths call the same `buildPaymentOperationIdentity` and
`buildSquarePaymentRequestIdentity` implementation. The exact versioned Square
order and payment keys—not merely independently deterministic keys—are reused
across cutover, retries, restarts, and recovery after legacy Square success.

Interactive charges and refunds should adopt the same create/lease/call/finalize
shape in later scoped changes. They are not part of the Phase 2B scheduled
cutover unless that PR explicitly includes and tests them.

## Phase 2B-2 verification matrix

The cutover is not activation-ready unless deterministic fake-provider tests
and real PostgreSQL tests cover these boundaries:

| Boundary | Required proof |
| --- | --- |
| Preparation identity | Recurring and upfront cycles create one immutable operation; two workers converge on the same exact cycle. |
| Legacy reservation death | A legacy worker may die after advisory-lock acquisition and before Square; connection loss releases ownership and restart can acquire the cycle without a successful-payment cursor mutation. |
| Legacy versus ledger | Real PostgreSQL contention proves the dedicated session lock and the in-transaction advisory lock cannot both own the exact cycle. |
| Legacy success crash | If legacy Square succeeds before local finalization and ledger later sees the cycle, both paths reuse the identical versioned order/payment keys and finalize the original charge. |
| Claims and restart | Lease acquisition is atomic and tenant-scoped; expiry is recoverable; a stale token cannot finalize or schedule another outcome. |
| Provider boundary | Square is called after the preparation/claim transaction; a crash before the call, during an ambiguous call, or after success reuses the immutable keys. |
| Local finalization | A simulated post-Square database failure creates no refund and no new provider identity; success replay is idempotent and token-fenced. |
| Outcome policy | Confirmed transient failures use bounded durable backoff; exhaustion is terminal; hard declines become `action_required`; repeated unknowns become `reconciliation_required`. |
| Future cycles | An `action_required` or definite failed cycle does not block the next exact cycle; uncertain or leased work applies the documented broader guard. |
| Payment semantics | Combined allocations, the single payer-level decline row, amounts, receipts, and schedule paid-in-full behavior remain unchanged. |
| Isolation and scope | Cross-tenant preparation, claim, finalization, and visibility fail closed; interactive payments, refunds, and webhooks are unchanged. |
| Wake/Neon behavior | The earliest of schedule preparation and operation execution arms one clamped wake; paused modes query nothing; empty work creates no timer; failures retain the 60-second overdue recovery bound. |
| Query plan | `EXPLAIN` for the production unified query uses the active schedule partial index for schedule work and the operation due index for retry/lease work. |

The real database coverage lives in
`tests/unit/scheduled-payment-ledger-cutover.test.ts` and
`tests/unit/payment-operations.test.ts`; wake-mode and no-regression boundaries
live in the corresponding focused unit suites.

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

## Phase 2B-2 deployment, activation, and rollback

Activation is not part of the code deployment. Use this conservative sequence:

1. **Deploy while paused.** Certify the exact main commit in CI, turn Render
   Auto-Deploy Off, record the Neon target/backup, and suspend/drain every old
   application instance **before migration 0009 or the first 2B-2 deploy**.
   Old revisions do not take the exact-cycle advisory lock and are unsafe in a
   mixed-version legacy scheduler fleet. Apply forward-only migration 0009,
   verify its checksum, `reconciliation_required` checks, and
   `payment_schedules_active_next_payment_idx`, then deploy that same certified
   commit with the already configured `ledger_paused` value. Do not change the
   mode as part of this step.
2. **Prove the ledger remains dormant.** Resume one 2B-2 instance. Verify the
   runtime SHA, `/healthz`, `/api/health`, authentication, tenant isolation,
   and startup mode. Logs and Neon query history must show no operation wake
   query, operation timer, lease, or ledger Square call. Legacy scheduled
   billing remains active behind its database guard. Interactive payments,
   refunds, and webhooks must match their pre-release smoke results.
3. **Drain legacy work before activation.** Schedule an activation window,
   suspend/drain every 2B-2 instance, and wait for all HTTP requests and legacy
   scheduled-provider calls to finish. Do not treat a disappearing process-local
   job list as sufficient while another Render instance is alive.
4. **Prove no conflict exists.** While all application instances are stopped,
   require zero rows from:

   ```sql
   SELECT status, count(*)
   FROM payment_operations
   WHERE operation_type = 'scheduled_charge'
     AND status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled',
                    'reconciliation_required')
   GROUP BY status;
   ```

   Also verify no application session holds an advisory lock and inspect every
   existing scheduled operation, if any. For the initial production activation
   the expected result is no scheduled operation rows at all. Stop on any
   unknown, active lease, cursor anomaly, tenantless schedule, or unexplained
   payment-history/Square mismatch.
5. **Activate explicitly.** Change only
   `SCHEDULED_PAYMENT_EXECUTION_MODE=ledger_execute`, deploy one certified
   2B-2 instance, and confirm startup reports `ledger_execute`. Do not run a
   migration in this step and do not start additional workers yet.
6. **Verify initial preparation and execution.** Observe the first real due
   cycle: one SERIALIZABLE preparation creates one operation/snapshot/allocation
   set, advances the schedule once, arms one operation wake, acquires one lease,
   and dispatches Square only after transaction completion. Verify the logged
   tenant/operation state progression without logging snapshot or provider
   payloads. A second worker may be added only after this proof.
7. **Validate local and Square outcomes.** For the first normal, combined, and
   deliberately declined sandbox/controlled cases, compare amounts, currency,
   exact versioned order/payment keys, provider payment/order identity, receipt
   fields, payer-level combined-decline history, allocation linkage, and
   schedule progression. `provider_unknown` must reconcile with the same keys;
   `reconciliation_required` must not be reported as payment failure.
8. **Confirm Neon autosuspension.** After all real work is complete, verify the
   unified query leaves no timer when neither schedules nor operations have
   future work, or exactly one long timer for the earliest future work. Observe
   a complete idle autosuspension window and confirm there is no one-minute or
   fifteen-minute empty database sweep.
9. **Pause immediately on anomalies.** Set `ledger_paused`, suspend/drain all
   instances, and resume only the certified 2B-2 guarded revision in paused
   mode. Preserve operations, snapshots, schedules, payment rows, logs, and
   Square identities. Do not delete operations, move cursors backward, invent
   a new key, or issue a compensation refund for local finalization failure.
10. **Apply rollback rules.** An application older than 2B-2 is safe to resume
    only if no ledger cycle has ever been prepared and the zero-row proof in
    step 4 still holds. The instant any scheduled ledger operation exists—even
    terminal work—an older unguarded application is no longer an approved
    rollback target. Keep migration 0009, use `ledger_paused` on the guarded
    2B-2 revision, reconcile uncertain/provider-success states, and deploy a
    forward fix. Explicit success reconciliation must use the retained exact
    token; automatic execution never leases `reconciliation_required`.

Phase 3 remains the separately reviewed adoption of the operation ledger by
interactive charges/refunds. Phase 4 remains broader reconciliation tooling,
notifications, and operator UX. Neither boundary is part of Phase 2B-2.
