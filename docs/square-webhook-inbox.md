# Square webhook inbox

## Phase 4A-1 boundary

Phase 4A-1 replaces the disabled Square tripwire at the existing canonical
`POST /api/payments-provider/webhooks/square` path with a disabled-by-default,
signature-validated durable inbox. The only active modes are:

| Mode | Behavior |
| --- | --- |
| `disabled` | Returns `503 SQUARE_WEBHOOK_DISABLED`; no signature configuration, database read, inbox write, claim, provider call, or business mutation occurs. This is the default. |
| `ingest_only` | Verifies exact raw bytes, parses a bounded event, resolves one tenant/location, and commits encrypted evidence before returning 2xx. No event is processed. |
| `reconcile_payments` | Preserves the signature and durable-ingestion boundary, then processes that exact event inline. Only conclusive known payment/refund completion can mutate business state. |
| `reconcile_payments_and_disputes` | Adds independent dispute-ledger reconciliation for known LeagueVault charges. It never changes payment/refund status or calls Square. |

No Phase 4A-1 code can finalize or otherwise change a payment, refund,
dispute, payment operation, schedule, receipt, or UI state. No startup scan,
polling loop, fixed-cadence query, empty sweep, provider API call, or scheduler
integration is added.

## Phase 4A-2 activation boundary

Phase 4A-2 adds `reconcile_payments` but leaves the default `disabled` and
leaves `ingest_only` unchanged. Processing begins only after the verified event
has committed to the inbox. It makes no Square API call and cannot create a
charge, refund, dispute, receipt delivery, or schedule. It consumes only the
provider object embedded in the signed notification.

For `refund.updated`, only `COMPLETED` can finalize. The event must match the
Square application and merchant evidence, tenant, local and provider location,
refund ID, original payment ID, amount, currency, and exactly one immutable
refund operation/snapshot. `PENDING`, `FAILED`, and `REJECTED` never change
payment or operation success state and leave sparse recovery intact.

For `payment.updated`, only `COMPLETED` can finalize. New LeagueVault charges
write the operation UUID to Square `Payment.reference_id`; older operations
can be found only when their Square payment ID was already persisted. The
matched operation and immutable scheduled/interactive snapshot must agree on
tenant, location, provider, amount, currency, provider payment/order identity,
and allocation semantics. The existing transaction-scoped finalizer inserts
allocation rows, applies receipt metadata, and updates the operation once.

`dispute.created` and `dispute.state.updated` are acknowledged but deliberately
remain nonterminal `pending` events in this mode. Their attempt, lease, error,
processed, and completed fields are not changed, so Phase 4B can claim and
process the original retained evidence without a replay backfill. No dispute
or refund state is conflated. Phase 4B still owns dispute storage, status
precedence, visibility, notifications, and operator actions.

## Phase 4B-1 activation boundary

Phase 4B-1 adds `reconcile_payments_and_disputes` as a distinct opt-in mode.
The deployed `reconcile_payments` behavior is unchanged, so applying the
migration and deploying this code does not activate dispute processing.

When separately activated, `dispute.created` and `dispute.state.updated` may
insert or advance an independent `payment_disputes` record only after the
provider application, merchant, tenant, local/provider location, Square
payment, succeeded charge operation, complete local allocation amount,
currency, partial disputed amount, reason, dispute identity, and numeric
version all pass tenant-scoped validation. Older versions are ignored and an
equal version with conflicting evidence fails closed. A valid dispute for a
Square payment not owned by LeagueVault is retained as terminal ignored
evidence with `DISPUTE_NOT_OWNED`.

Dispute state never writes `payments.status`, `payments.dispute_id`, refund
fields, or payment-operation status. Refund and dispute lifecycles can coexist
without precedence loss. Dispute commits do not wake the scheduled-payment
runtime. This slice adds no read API, notification, operator UI, provider
effect, polling, backlog scan, or automatic replay; those remain later 4B
work. See [the Phase 4B dispute design](./phase4b-dispute-design.md).

The processor locks the inbox row and performs local reconciliation plus inbox
completion in one PostgreSQL transaction. Concurrent duplicates wait for that
short, provider-I/O-free transaction and then return the terminal result. A
crash before commit rolls back both changes and receives no 2xx; a crash after
commit is an idempotent terminal duplicate. A completed payment/refund with no
LeagueVault operation reference or persisted provider identity is retained as
terminal `ignored` evidence with `OPERATION_NOT_OWNED` and receives 2xx. The
operation is committed before LeagueVault calls Square, so this is not treated
as a transient mapping race; sparse recovery remains available for a lost
provider response. There is no detached process-local task, inbox retry timer,
poller, sweep, or startup scan.

Events acknowledged while the service is deliberately in `ingest_only` remain
durable evidence; changing the mode does not scan or auto-process that backlog.
Sparse recovery remains the business-state backstop for those events. Phase 4B
operator tooling may later expose deliberate, tenant-scoped replay by event ID.

Refund numeric versions and payment `updated_at` timestamps are compared with
newer durable inbox evidence. Stale or equal/ambiguous freshness never mutates
business state. A webhook racing the sparse executor uses the same locked,
tenant-scoped finalization invariants; the losing executor observes succeeded
state and cannot create duplicate allocation rows or regress the operation.
After a committed completion, the existing one-shot ledger wake is rearmed so
obsolete sparse checks fall out while recovery remains available as a safety
backstop.

## Provider contract and event inventory

Square's documented signature is HMAC-SHA-256 over the exact notification URL
followed by the raw request body, using the webhook subscription's signature
key. The signature arrives in `x-square-hmacsha256-signature`. Square can send
the same `event_id` more than once, does not guarantee delivery order, expects
a timely 2xx acknowledgement, and retries non-2xx deliveries for up to 24
hours. See Square's official [signature-validation guide](https://developer.squareup.com/docs/webhooks/step3validate),
[webhook delivery contract](https://developer.squareup.com/docs/webhooks/overview),
and [notification URL requirements](https://developer.squareup.com/docs/webhooks/step1createurl).

The future LeagueVault processing subscription requires exactly:

- `refund.updated`
- `payment.updated`
- `dispute.created`
- `dispute.state.updated`

Phase 4A-1 recognizes those types and leaves them `pending`. A valid event of
another type is durably `ignored` only when it still provides enough identity
to resolve exactly one configured tenant/location. The intended Square
subscription must not use Select All. Official payload contracts are:
[refund.updated](https://developer.squareup.com/reference/square/refunds-api/webhooks/refund.updated),
[payment.updated](https://developer.squareup.com/reference/square/payments-api/webhooks/payment.updated),
and [Disputes webhooks](https://developer.squareup.com/reference/square/disputes-api/webhooks).

Square payment subscriptions are seller-wide: payment notifications can come
from the Dashboard, Point of Sale, Terminal, Invoices, other Square products,
or another API application connected to the seller. A subscription chooses
event types but cannot filter `payment.updated` by originating application.
See Square's official
[Payments API webhook behavior](https://developer.squareup.com/docs/payments-api/webhooks)
and [webhook overview](https://developer.squareup.com/docs/webhooks/overview).

The subscription API version is pinned to `2026-05-20`, matching the installed
Square SDK's audited wire version. A different configured version prevents
either enabled mode from starting; it is never guessed from an event body because Square
does not put the subscription API version in the event envelope.

## Signature-key ownership and exact notification URL

Square webhook subscriptions are owned by a Square application, not an
individual seller or location. Square therefore does not permit seller OAuth
tokens to manage them. See the official [Webhook Subscriptions API ownership
contract](https://developer.squareup.com/reference/square/webhook-subscriptions-api)
and [subscription signature-key response](https://developer.squareup.com/reference/square/webhook-subscriptions-api/retrieve-webhook-subscription).

LeagueVault keeps signature keys in the server-only
`SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON` environment value, keyed by Square
application ID. It does not add them to `locations.square_credentials`, return
them from Settings, or persist them in the inbox. This supports multiple
Square applications without incorrectly treating an application-owned key as
a location credential. The receiver tries the bounded configured key set and
continues only when exactly one application matches.

The production notification URL is exactly:

```text
https://leaguevault.app/api/payments-provider/webhooks/square
```

The receiver uses `SQUARE_WEBHOOK_NOTIFICATION_URL` directly. It never
reconstructs the signed URL from `Host`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, a Render origin, or an organization subdomain. A trailing
slash, query, alternate host, or scheme is a different signature input. In
`APP_ENV=prod`, the URL must use `APP_DOMAIN` and the exact canonical path.
Render's trusted proxy configuration therefore affects request metadata but
cannot alter signature calculation.

Configuration shape, using placeholders only:

```text
SQUARE_WEBHOOK_MODE=disabled
SQUARE_WEBHOOK_NOTIFICATION_URL=https://leaguevault.app/api/payments-provider/webhooks/square
SQUARE_WEBHOOK_API_VERSION=2026-05-20
SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON=[{"applicationId":"square-application-placeholder","signatureKey":"secret-manager-placeholder"}]
```

Keep the JSON value in Render's server-only secret environment. Never put a
real signature key in source, a prompt, a test fixture, a commit, a log, or a
browser-visible `VITE_` variable.

## Request and tenant boundary

The receiver remains mounted before tenant resolution and before the global
JSON parser. The request order is deliberately:

1. Apply response security headers and a server-generated request ID.
2. Read at most 12 KiB as a raw `Buffer` without JSON parsing.
3. Reject a missing or invalid signature using constant-time digest comparison.
4. Require JSON content type, decode strict UTF-8, and minimally parse the
   signed provider envelope plus payment origin fields in process memory.
5. Acknowledge a conclusively unrelated `payment.updated` with 2xx, before any
   PostgreSQL-backed middleware or storage code.
6. Apply the shared production rate limit only to potentially owned or
   ambiguous events.
7. Fully parse the signed bytes and require bounded provider event, merchant,
   location, object, and payment identities plus a valid provider timestamp.
8. Resolve `provider location ID -> exactly one LeagueVault location` while
   holding a short shared row lock, then require that location's configured
   Square application ID to match the signature-winning application.
9. Encrypt and insert the event in the same short transaction, then return 2xx.

Zero matches, multiple matches, cross-application matches, conflicting
envelope/object locations, malformed known event objects, and event-ID reuse
with different evidence all fail closed and receive non-2xx. The receiver
stores provider merchant, application, location, object, payment, version, and
update-time evidence, but does not guess a local payment or operation link.
Phase 4A-2 must resolve those links tenant-safely and uniquely before any
reconciliation. In particular, a combined Square payment can legitimately map
to multiple local allocation rows, and a dispute must not be forced onto one
of them by guesswork.

## Signed payment origin prefilter

The prefilter is intentionally separate from full business-event
normalization. It validates the bounded Square envelope, `payment.updated`
object type, payment/object ID agreement, location identity, optional
`application_details.application_id`, optional
`application_details.square_product`, and optional `reference_id`. It does not
require status, source, or a positive amount. This permits a structurally valid
zero-dollar cash POS update to be acknowledged without turning a provider
event that LeagueVault cannot own into a retry loop.

The server-side LeagueVault application identity is the application whose
configured webhook signature key uniquely verified the exact request. A
payment is potentially owned when that application matches the payment's
`application_id` or when `reference_id` is a valid payment-operation UUID.
Either marker is sufficient. Conflicting markers also take the durable path;
the prefilter never guesses which one is wrong.

With no valid operation reference, an explicit different `application_id` is
conclusive foreign evidence. If `application_id` is absent, the following
first-party Square products are also conclusive because LeagueVault creates
payments through the e-commerce API: Point of Sale, Terminal API, Invoices,
Virtual Terminal, Retail, Restaurants, Online Store, and Appointments.
`ECOMMERCE_API`, `OTHER`, a missing product, or an unknown future value remains
ambiguous and proceeds to the durable tenant/location lookup. This preserves
older LeagueVault payments that predate `reference_id` or whose
`application_details` is incomplete.

The prefilter applies only to `payment.updated`. `refund.updated`,
`dispute.created`, and `dispute.state.updated` retain their existing durable
mapping and reconciliation because they do not provide equivalent direct
payment-origin evidence.

Status policy is deliberate:

- missing/invalid signatures are rejected before classification;
- signed malformed JSON, envelopes, payment identity, or conflicting
  envelope/object locations receive the existing 4xx response;
- conclusively unrelated signed payments receive the existing successful
  `ignored` response without an inbox row; and
- potentially owned, ambiguous, refund, dispute, and other supported-version
  events continue through the existing limiter and durable response policy.

A conclusively unrelated payment has a zero-database invariant: it cannot run
the PostgreSQL rate limiter, tenant/location mapping, inbox insertion,
reconciliation, or scheduler rearm. It performs bounded HMAC and JSON work in
Render memory only. This prevents ordinary non-LeagueVault seller activity
from resetting Neon's autosuspend timer while preserving current CU for owned
and ambiguous evidence. No provider request, poller, timer, sweep, or startup
query is introduced.

## Durable inbox and replay rules

Migration `0014_square_webhook_inbox` adds `webhook_events` with:

- provider and provider event ID, unique as a pair;
- event type and provider creation timestamp;
- tenant and local/provider location identity;
- provider application, merchant, object, payment, object version, and object
  update-time metadata;
- provider API version, internal payload schema version, and SHA-256 hash;
- the exact verified JSON payload encrypted with the existing
  `FIELD_ENCRYPTION_KEY` AES-256-GCM boundary;
- processing status, attempts, due time, lease owner/token/expiration, and
  sanitized error classification/code; and
- received, last-processed, completed, and updated timestamps.

The payload hash is for immutable duplicate comparison, not authentication;
authentication is the Square HMAC gate. An exact delayed duplicate returns the
existing committed tenant mapping after its application, immutable metadata,
and hash match, even if current location settings have since changed. Concurrent
duplicates converge through the PostgreSQL unique index and repeat the same
comparison. A reused event ID with different bytes or identity returns a
conflict and never updates the original evidence.

Crash windows are:

- Before inbox commit: no 2xx is sent; Square can retry.
- After commit but before response: a retry finds the exact durable duplicate.
- After 2xx in Phase 4A-1: the event intentionally remains `pending`; no dormant
  processor was promised or scheduled.
- After a future explicit claim: the `processing` lease expires. Reclaim
  increments the attempt and replaces the token; every completion or retry
  write requires tenant, event ID, `processing` state, and the exact token, so
  the stale worker is fenced.

Attempt 20 is the final claim. A retry request from its token atomically
terminalizes the event as `failed` with sanitized `ATTEMPTS_EXHAUSTED` evidence
instead of creating unclaimable `retry_scheduled` work. If the final worker
crashes, an explicit claim of that event ID after lease expiry first performs
the same atomic exhaustion transition and returns no lease. The transition
also repairs a due final-attempt retry row if one is encountered. It is
tenant-scoped and time-gated; there is still no exhaustion sweep.

Claims are explicit by event ID. Phase 4A-1 has no "next event" query. A later
processor must not acknowledge and then start an untracked process-local task;
it must process inline from the committed event ID or use a deliberate durable
operator/wake handoff. Duplicate delivery and deliberate operator retry can
reclaim expired work without a polling loop.

## Phase 4A-2 reconciliation invariants

Phase 4A-2 preserves all of the following:

- `refund.updated` can finalize only `COMPLETED`, after provider, tenant,
  application, merchant, location, payment, refund ID, amount, currency, and
  unique refund operation identity all match.
- `PENDING` never marks a local payment refunded. `FAILED` or `REJECTED` never
  reverses an already succeeded operation.
- Numeric provider object versions and provider `updated_at` timestamps are
  freshness evidence. A stale, duplicate, delayed, retried, or out-of-order
  event cannot regress durable state. Equal/ambiguous freshness fails closed.
- Webhook finalization and sparse recovery must call the same atomic,
  tenant-scoped idempotent finalization primitive. Neither path may create a
  new charge/refund or change provider identity.
- `payment.updated` can reconcile only an existing unique operation. It cannot
  insert duplicate payment allocations or infer a new local payment from an
  otherwise valid Square event.
- A committed webhook transition rearms the existing one-shot payment wake so
  obsolete sparse refund checks disappear. Sparse recovery remains as a
  backstop.
- Square's `PaymentRefund` statuses are `PENDING`, `COMPLETED`, `REJECTED`, and
  `FAILED`; only `COMPLETED` proves refund success. See the official
  [PaymentRefund object](https://developer.squareup.com/reference/square/objects/PaymentRefund).
- Dispute ID, state, amount, payment, version, and lifecycle remain
  independently representable from refund state. See the official
  [Dispute object](https://developer.squareup.com/reference/square/objects/Dispute).

Phase 4B-1 resolves the combined-payment and status-precedence constraint by
linking each provider dispute to the succeeded charge operation, not an
arbitrary allocation row, and keeping its lifecycle independent from the
existing single `payments.status` plus `dispute_id` fields.

## Migration, rollback, and CU impact

Migration 0014 is one additive, forward-only migration. It creates the empty
inbox table, constraints, two foreign keys, provider/event uniqueness, and
tenant/location visibility indexes. It has no `ALTER` of an existing table,
backfill, data mutation, destructive statement, or startup schema mutation.

Migration `0015_square_webhook_object_freshness` adds one btree index over the
provider application/object freshness lookup used by out-of-order checks. It
has no table rewrite, backfill, destructive statement, or data mutation.

Migration `0016_payment_dispute_ledger` additively creates the empty
`payment_disputes` table, restrictive identity/evidence foreign keys, provider
dispute uniqueness, validation checks, and tenant/operation/provider indexes.
It has no backfill, destructive statement, existing-table rewrite, or data
mutation.

Migration-first is compatible: the deployed Phase 4A-2 application ignores
the new table under every existing mode, including `reconcile_payments`.
Application rollback keeps migrations 0014 through 0016 plus all inbox and
dispute evidence; do not reverse the migrations or delete events. If the new
mode has been activated, change it back to `reconcile_payments` before rolling
the application back to Phase 4A-2 because that version does not recognize the
new mode. Independently committed dispute records remain valid retained
evidence; payment/refund processing continues under the older mode. Rollback
does not mean reversing migration 0016 or deleting inbox/dispute evidence.

The restrictive organization/location foreign keys express the normal
retention policy. Ordinary location deletion is rejected with
`409 LOCATION_WEBHOOK_EVIDENCE_EXISTS` once evidence exists; archive the
location instead. The system-admin full-organization teardown is the deliberate
exception: it locks tenant locations and deletes tenant webhook evidence inside
the same atomic teardown before deleting locations and the organization. A
failure rolls the entire teardown back.

Each potentially owned or ambiguous delivery uses the existing shared
production rate-limit counter and performs an indexed event-ID lookup. A
unique delivery then performs one bounded location lookup and one indexed
insert; a concurrent duplicate
uses the unique-conflict path and an indexed read. Invalid signatures perform
no database work. There is no recurring query, so an unconfigured or idle
receiver cannot keep Neon awake. Encrypted payloads add storage per received
event but no background CU. Phase 4A-2 is expected to reduce Square polling and
Neon/provider work by promptly removing completed refunds from the existing
sparse one-shot recovery schedule.

In `reconcile_payments`, each potentially owned or ambiguous delivery adds
only bounded indexed lookups and one short transaction; there is still no idle
query. Prompt completion avoids later refund `GetRefund` calls and their
associated ledger wake transactions. Conclusively unrelated Square POS or
other first-party product payments are acknowledged before PostgreSQL and are
not retained.
Marker-poor historical or unknown-origin payments remain durable rather than
being silently discarded.

In `reconcile_payments_and_disputes`, each dispute delivery adds bounded
indexed operation/allocation lookups and one short transaction. It makes no
Square request and does not rearm payment recovery. There remains no idle
database query, so the new mode does not prevent Neon autosuspension.

## Phase 4B-1 production sequence (not performed by this PR)

1. Keep Render Auto-Deploy Off.
2. Back up the intended Neon production database.
3. Apply migration 0016 from the exact CI-certified commit and verify its
   journal, checksum, and schema.
4. Deploy that exact commit while preserving the currently approved Phase
   4A-2 mode (`reconcile_payments` when active); do not broaden the mode during
   the code deployment.
5. Verify health, authentication, tenant isolation, existing charges/refunds,
   sparse recovery, schedules, webhook deduplication, and sanitized logs.
6. Confirm the existing application-owned Square subscription still uses the
   canonical URL, API version `2026-05-20`, reviewed signature key, and exact
   event inventory. Do not rotate or reconfigure it merely for deployment.
7. Activate `reconcile_payments_and_disputes` only in a separate reviewed
   manual Render deployment.
8. Send controlled synthetic/nonproduction dispute events and verify tenant,
   location, operation, payment, amount/currency, version deduplication and
   out-of-order behavior, independent refund state, zero payment-recovery
   wake, sanitized logs, and a complete Neon autosuspension window.

Do not use a real pending production refund as a test event or replay target.

## Origin-prefilter deployment and rollback (not performed by this PR)

This is an application-only change. It adds no migration or database state,
and it does not change webhook mode or Square subscription configuration.

1. Merge only after Phase 4B-2 and every required check are green.
2. Keep Render Auto-Deploy Off.
3. Deploy the exact verified `main` commit without running a migration.
4. Preserve the currently approved `SQUARE_WEBHOOK_MODE`.
5. Verify health, authentication, tenant isolation, and representative
   scheduled, interactive, combined, and auto-pay setup payments.
6. Send or observe one unrelated POS payment update, one LeagueVault payment
   update, one safely available LeagueVault refund update, and a dispute only
   through an approved safe test mechanism.
7. Confirm the unrelated payment receives 200 and creates no inbox row.
8. Confirm owned payment/refund/dispute events retain durable processing.
9. Confirm no new scheduler, lease, reconciliation, Square, or signature
   errors and no sensitive origin evidence in logs.
10. Observe a complete Neon autosuspension window during ordinary
    non-LeagueVault POS activity.

Rollback is application-only: restore the previous exact verified application
commit while leaving the database and migrations intact. No provider event,
inbox row, dispute record, notification, or payment operation needs reversal.
