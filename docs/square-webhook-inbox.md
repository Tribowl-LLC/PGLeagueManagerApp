# Square webhook inbox

## Phase 4A-1 boundary

Phase 4A-1 replaces the disabled Square tripwire at the existing canonical
`POST /api/payments-provider/webhooks/square` path with a disabled-by-default,
signature-validated durable inbox. The only active modes are:

| Mode | Behavior |
| --- | --- |
| `disabled` | Returns `503 SQUARE_WEBHOOK_DISABLED`; no signature configuration, database read, inbox write, claim, provider call, or business mutation occurs. This is the default. |
| `ingest_only` | Verifies exact raw bytes, parses a bounded event, resolves one tenant/location, and commits encrypted evidence before returning 2xx. No event is processed. |

No Phase 4A-1 code can finalize or otherwise change a payment, refund,
dispute, payment operation, schedule, receipt, or UI state. No startup scan,
polling loop, fixed-cadence query, empty sweep, provider API call, or scheduler
integration is added.

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

The subscription API version is pinned to `2026-05-20`, matching the installed
Square SDK's audited wire version. A different configured version prevents
`ingest_only` startup; it is never guessed from an event body because Square
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
4. Apply the shared production rate limit; invalid signatures therefore cause
   no PostgreSQL work.
5. Require JSON content type, decode strict UTF-8, and parse the signed bytes.
6. Require bounded provider event, merchant, location, object, and payment
   identities plus a valid provider timestamp.
7. Resolve `provider location ID -> exactly one LeagueVault location` while
   holding a short shared row lock, then require that location's configured
   Square application ID to match the signature-winning application.
8. Encrypt and insert the event in the same short transaction, then return 2xx.

Zero matches, multiple matches, cross-application matches, conflicting
envelope/object locations, malformed known event objects, and event-ID reuse
with different evidence all fail closed and receive non-2xx. The receiver
stores provider merchant, application, location, object, payment, version, and
update-time evidence, but does not guess a local payment or operation link.
Phase 4A-2 must resolve those links tenant-safely and uniquely before any
reconciliation. In particular, a combined Square payment can legitimately map
to multiple local allocation rows, and a dispute must not be forced onto one
of them by guesswork.

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

Phase 4A-2 must preserve all of the following:

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

Phase 4B must make an explicit product/storage decision for combined-payment
disputes and status precedence before activating dispute mutations. The
existing single `payments.status` plus `dispute_id` fields are not sufficient
to represent every refund/dispute combination without loss.

## Migration, rollback, and CU impact

Migration 0014 is one additive, forward-only migration. It creates the empty
inbox table, constraints, two foreign keys, provider/event uniqueness, and
tenant/location visibility indexes. It has no `ALTER` of an existing table,
backfill, data mutation, destructive statement, or startup schema mutation.

Migration-first is compatible: the Phase 3B application ignores the new
table. The Phase 4A-1 application is also safe with the migration present while
`SQUARE_WEBHOOK_MODE=disabled`. Application rollback keeps migration 0014 and
all inbox evidence; do not reverse the migration or delete events. Since 4A-1
never changes business state, the existing Phase 3B application remains an
application rollback target if the receiver itself regresses.

The restrictive organization/location foreign keys express the normal
retention policy. Ordinary location deletion is rejected with
`409 LOCATION_WEBHOOK_EVIDENCE_EXISTS` once evidence exists; archive the
location instead. The system-admin full-organization teardown is the deliberate
exception: it locks tenant locations and deletes tenant webhook evidence inside
the same atomic teardown before deleting locations and the organization. A
failure rolls the entire teardown back.

Each valid delivery first performs an indexed event-ID lookup and uses the
existing shared production rate-limit counter. A unique delivery then performs
one bounded location lookup and one indexed insert; a concurrent duplicate
uses the unique-conflict path and an indexed read. Invalid signatures perform
no database work. There is no recurring query, so an unconfigured or idle
receiver cannot keep Neon awake. Encrypted payloads add storage per received
event but no background CU. Phase 4A-2 is expected to reduce Square polling and
Neon/provider work by promptly removing completed refunds from the existing
sparse one-shot recovery schedule.

## Future production sequence (not performed by this PR)

1. Keep Render Auto-Deploy Off.
2. Back up the intended Neon production database.
3. Apply migration 0014 from the exact CI-certified commit and verify its
   journal/checksum/schema.
4. Deploy that exact commit with `SQUARE_WEBHOOK_MODE=disabled`; verify health,
   authentication, tenant isolation, existing payments/refunds/schedules, and
   zero inbox activity.
5. Configure each application-owned Square subscription for the exact
   notification URL, `2026-05-20`, and the four reviewed event types; store the
   matching signature keys in Render, then deploy `ingest_only` separately.
6. Send controlled Square test events with synthetic/nonproduction identities.
7. Activate Phase 4A-2 processing only in a separate reviewed release and
   operator action.
8. Verify deduplication, app/tenant/location mapping, eventual refund
   completion, sanitized logs, sparse-backstop rearming, and a complete Neon
   autosuspension window.

Do not use a real pending production refund as a test event or replay target.
