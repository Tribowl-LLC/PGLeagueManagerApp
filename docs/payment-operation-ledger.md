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

## Phase 3A-2 general interactive charge cutover

Phase 3A-2 activates the dormant general interactive snapshot and executor
created by migration 0011 for the regular single-bowler and combined Square
charge routes. Weekly auto-pay setup continues to use `autopay_setup_requests`
and its own `autopay-setup:` operation namespace; scheduled billing continues
to use scheduled snapshots. Refunds remain outside this phase.

Every interactive charge requires an `Idempotency-Key` header containing 16–109
URL-safe ASCII characters. The web and Capacitor clients generate a UUID when
the user begins one exact payment intent, persist only that UUID locally, and
reuse it for retries of that intent. New payments, including a new saved card
choice or changed amount/allocation semantics, receive a new key. Missing or
malformed keys fail with an upgrade/validation response before snapshot
creation or Square money movement. The raw client key is never sent to
Square; the tenant- and operation-scoped ledger identity derives bounded,
domain-separated Square payment/order keys.

The immutable encrypted snapshot covers tenant, league/location, payer,
request kind, amount/currency, source/customer/email references, save-card
intent, server-authoritative business-day `weekOf`, ordered allocations, and
ordered Square line items. Same key plus the same fingerprint converges on one
operation. A different fingerprint returns `409 IDEMPOTENCY_CONFLICT`; it can
never silently adopt whichever concurrent request won the insert race.

The charge operation is committed before the executor acquires its expiring
fenced lease or calls Square. Provider calls occur outside PostgreSQL
transactions. Only Square `COMPLETED` results finalize paid rows. Transient or
ambiguous results retain the immutable request and key for durable recovery;
`provider_unknown` and `reconciliation_required` are never presented as a
confirmed failure. Local finalization failure never triggers a compensation
refund. Payment rows and combined allocations finalize atomically and link to
the operation UUID, which is globally safe even when two tenants use the same
client key.

Card vaulting is a separate post-charge, idempotent side effect. A vaulting
failure leaves the charge successful and is reported as `cardSaveStatus`; it
does not retry or reverse the charge. The status endpoint
`GET /api/payments-provider/payment-operations/status` and recovery endpoint
`POST /api/payments-provider/payment-operations/recover` accept the same key,
are tenant-scoped, and let a restarted client recover an ephemeral-token
intent without retokenization.

This release requires no migration because 0011 is already additive and
migrated before the route cutover. The safe deployment order is client support
(including distributed native header/recovery support), then the server
cutover. The pre-3A-2 application remains safe only while no general
interactive operations exist. Once this release creates the first one, the
pre-3A-2 application is not an approved rollback target; roll forward or
restore the compatible application/database pair. No Render, Neon, Square, or
environment-variable changes are part of the code release.

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

## Weekly auto-pay setup foundation and activation

Migration `0010_autopay_setup_foundation` adds a dormant setup workflow for a
later interactive-charge cutover. The migration-only release did not add a
route, change a client, create a setup row, acquire an operation lease, or call
Square. The following behavior release activates that already-migrated
foundation only for weekly auto-pay setup; one-time/upfront charges, general
interactive payments, refunds, and webhooks remain on their prior paths.

`autopay_setup_requests` is not a second provider ledger. It owns only:

- the setup workflow state (`pending`, `completed`, or `canceled`);
- the immutable ordered per-occurrence allocation snapshot;
- the first future automatic occurrence and recurring setup parameters; and
- links to the one immediate charge operation, when needed, and the resulting
  schedule after workflow completion.

When the immutable snapshot has a positive immediate amount, the setup request
links to exactly one `payment_operations` row with
`operation_type = 'interactive_charge'`. `payment_operations` remains the sole
owner of the provider request fingerprint/key, leases, fencing, attempts,
retries, provider-unknown recovery, provider payment/order IDs, error
classification, and terminal outcome. A zero-dollar setup has no payment
operation. Later success finalization will use the existing
`payments.payment_operation_id` and allocation index; no setup-specific
payment lineage columns exist.

The activated setup flow obtains a server-authoritative occurrence quote before
confirmation. The quote assigns paid money to exact `week_of` occurrences,
classifies the current bowling-day amount as `due_today` until three hours
after the league-local start time, requires all older occurrences to be
settled, and identifies the first unpaid future automatic occurrence. The
client sends no amount or next-payment timestamp.

A zero-dollar pre-start setup creates the future weekly schedule without a
payment operation or provider charge. A positive setup creates one
`interactive_charge` operation, acquires an expiring fenced lease, calls
Square outside every database transaction with the operation's stable order
and payment keys, and atomically commits the operation success, one local
payment row per covered occurrence, the future schedule, and setup completion.
Unknown outcomes and transient failures use the existing durable retry wake;
hard declines require another saved card. The wake dispatcher branches on
operation type so an interactive setup can never be interpreted as a scheduled
snapshot.

`payment_schedules.amount` remains the per-bowler weekly base. Combined
auto-pay stores selected partners in `additional_bowler_ids`; the scheduled
executor performs the existing payer-plus-partners multiplication exactly once.
No new migration is required for this activation release.

Migration 0010 also adds a partial unique index permitting only one active
payment schedule per bowler and league. This changes database enforcement for
concurrent legacy schedule inserts: a second active insert that previously
could succeed will now fail with a unique violation. The migration preflight
aborts if duplicate active schedules already exist. This enforcement change is
intentional, but it must be reviewed and deployed while the application is
drained as described in the production runbook.

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

## Phase 3A-1 boundary (migration 0011)

Phase 3A-1 adds a dormant foundation for general interactive charges. It does
not change a route, scheduler, startup hook, wake dispatcher, provider adapter,
weekly auto-pay setup, scheduled billing, or refund behavior. General
interactive operations are not created or executed by production code in this
phase.

The additive migration adds one encrypted interactive snapshot per general
`interactive_charge` operation, ordered allocation children, and ordered
Square line-item children. It deliberately does not reuse scheduled snapshots
or `autopay_setup_requests`. The snapshot stores no PAN, CVV, credential, raw
provider response, or raw provider request body. Source, customer, and buyer
email identities use the existing field-encryption boundary.

The `lvpayexecic:v1` fingerprint covers the complete normalized semantic
request: tenant, location and Square location, direct-versus-order charge
kind, currency, amount, encrypted-at-rest source/customer/email identities,
save-card intent, exact Square payment/order identities, week, combined-charge
group, every ordered allocation and every ordered Square line item. The
plaintext semantic values are fingerprinted before encryption so randomized
authenticated ciphertext does not change a retry fingerprint. Child indexes
are persisted and validated; order changes are not interchangeable.

General logical targets use the reserved `interactive-charge:` namespace and
never use a Square source token as identity. Preparation converges only when
the logical target and immutable fingerprint match. A mismatching fingerprint
fails closed, while a genuinely new target creates a separate operation.
Tenant validation proves that the operation, league, location, payer,
allocation bowlers, roster links, and paid-by users belong to the same
organization before any snapshot row is written. A deferred PostgreSQL
constraint trigger also requires allocation amounts to equal the parent
operation amount at commit time, in addition to positive-minor-unit and
ordered-child constraints.

The dormant executor demonstrates the Phase 3A-2 call boundary: commit the
lease before provider HTTP, call Square outside PostgreSQL, and finalize local
payment rows with the exact fenced operation. A local finalization failure
retains the operation for same-key replay and never issues a compensation
refund. Only a provider result with status `COMPLETED` may finalize local paid
rows; pending, approved, failed, canceled, missing-status, or missing-ID
results fail closed. Store-card execution is explicitly rejected until the
Phase 3A-2 route cutover owns the vault-write behavior. No application import
reaches this executor in Phase 3A-1.

## Phase 3A-2 general interactive charge cutover

The single-payment and combined-payment routes now require an
`Idempotency-Key` header before snapshot creation or provider dispatch. The
server accepts 16-109 URL-safe ASCII characters, scopes the durable target by
organization and `interactive_charge`, and derives bounded Square payment and
order keys from the immutable operation identity. The raw client key is never
sent to Square and source tokens are never used as logical identities.

The client creates and stores a UUID when a checkout intent begins, reuses it
only for retries of that intent, and clears it after confirmed success. New
card and wallet tokens are not stored client-side. Missing headers receive an
explicit upgrade-required response so older web or Capacitor clients cannot
fall back to the legacy charge behavior. The status and recovery endpoints are
tenant-scoped by the authenticated organization and allow a restarted client
to recover an ephemeral-token operation by key without retokenizing.

Preparation reconstructs and persists the exact business-time-zone `weekOf`,
allocation order, split amounts, paid-by attribution, receipt email, save-card
intent, and ordered Square line items. Same key plus the same fingerprint
converges on the existing operation; a fingerprint mismatch returns a
conflict. Initial requests execute once after the preparation transaction
commits. Duplicate requests observe the durable state, while the recovery
endpoint may retry only due work or an expired lease. `provider_unknown`,
`reconciliation_required`, and in-flight work are never reported as confirmed
payment failure.

For a new-card request with `storeCard=true`, the executor first calls
Square `CreateCard` outside PostgreSQL using a stable key derived from the
durable operation identity. The selected new-card or fingerprint survivor is
encrypted and persisted under the operation lease before `CreatePayment` or
the order/payment sequence is dispatched. The charge then uses that saved-card
ID and the operation's existing stable payment/order keys. A saved-card source
never calls `CreateCard`; wallet sources are never vaulted. A Square card ID
is accepted only as `saved_card` and must pass the customer ownership lookup;
labeling a card ID as `new_card` or `wallet` fails closed before provider money
movement. Missing or unsupported source kinds also fail closed.

Card-save state is stored on `payment_operations` itself: `pending` means the
exact CreateCard request may be replayed, `saved` includes the encrypted
survivor ID, and terminal `failed`/`not_available` states are retained for
response reconstruction. A database failure after CreateCard success retains
the lease and retries the same CreateCard key; it does not issue a charge,
refund, or new provider identity. A database failure after payment success
retains the lease and retries the same payment key. No compensation refund is
issued for local charge-finalization failure.

CreateCard error classification preserves Square's structured outcome:
rate limits and explicit temporary errors schedule a same-key retry;
timeouts, transport failures, 5xx responses, and otherwise unknown outcomes
remain `provider_unknown`; authentication/authorization failures are
configuration errors; and definite 4xx/card failures are terminal invalid or
action-required outcomes. Ambiguous card creation never marks the card-save
state failed and never dispatches the charge.

If card creation succeeds and the payment is later declined, the saved card is
retained as the user-authorized vault side effect. It is not disabled or
compensated. The optional payer schedule-card update remains best effort and
never changes the durable charge result. Responses and status/recovery
reconstruction return the persisted `savedCardId` and card-save status without
repeating provider calls.

Migration 0012 is additive and must be applied before the new application
code: it adds nullable vault-result fields to `payment_operations`, adds the
nullable source-kind column, and broadens the interactive snapshot checks to
read legacy v1 rows and write v2 rows. The deployed 78f54468-era application
ignores these nullable fields, but code-before-migration is not safe because
the new application selects and updates them. The new client and server must
be cut over together for web. Before enforcing source-kind validation for
native clients, distribute a Capacitor version that sends source kind and
persists/reuses the request key; older native versions fail closed with an
upgrade-required response.

Existing v1 operations remain readable and successful responses never replay
their old post-charge vault side effect. A pending v1 save-card request that
provably has never acquired a provider-attempt lease fails closed as an
upgrade-required request. Any v1 save-card operation recovered from
`provider_unknown`, retry, or an expired lease moves directly to
`reconciliation_required`; it is never presented as a confirmed failure and
never receives a new provider identity. New v2 operations require explicit
source kind and durable pre-charge vaulting. Once a v2 general interactive
operation exists, a pre-fix application is no longer an approved rollback
target for payment traffic. Rollback requires the compatible schema and
application revision to preserve operation leases, saved-card state, and
provider identities. The migration adds a few indexed-row columns but no
polling or wake path, so the expected Neon CU impact is limited to the extra
operation-row writes/reads during interactive checkout and one bounded card
ownership read for saved-card charges.

Immediately before application activation, operators should perform a
read-only preflight count of nonterminal v1 interactive snapshots with
`store_card=true`. Zero is the expected drained state. A nonzero count blocks
cutover until each operation is understood; uncertain rows must remain on
their existing provider identity and be reconciled, never replayed as a new
payment intent. This preflight does not modify production data.

### Phase 3 split and rollback

The remaining work is intentionally split into focused pull requests:

1. Phase 3A-1: this dormant general interactive snapshot, storage, executor,
   migration, and concurrency/tenant/encryption foundation.
2. Phase 3A-2: separately reviewed cutover of single and combined interactive
   charge routes, including the validated client logical-request identity.
3. Phase 3A-2 save-card safety fix: pre-charge CreateCard, durable survivor
   persistence, stable card identity, and source-kind enforcement (this
   release).
4. Phase 3B: durable refund operations, stable refund keys, provider-state
   handling, and atomic local refund finalization. Refund statuses and policy
   are not changed here.
5. Phase 4: webhook inbox, reconciliation tooling, disputes, and operator UX.

Migration 0011 was the dormant foundation. Migration 0012 must be applied
before this release's application code and is not applied to production by
this implementation PR. The 78f54468 application can safely ignore its
nullable additions while the path remains disabled, but after this release
creates a v2 operation, the 78f54468 application is no longer an approved
rollback target for payment traffic; rollback must preserve operation rows
and use a compatible application or forward recovery. No production migration
or deployment is performed as part of this PR.

Phase 3 remains separate from Phase 4's broader reconciliation tooling,
notifications, disputes, webhooks, and operator UX.
