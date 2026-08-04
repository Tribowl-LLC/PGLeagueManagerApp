# Phase 4B-2 dispute operations

## Scope and provider contract

Phase 4B-2 exposes the independent Phase 4B-1 dispute ledger to authorized
operators, writes durable in-app notifications, and permits deliberate replay
of one retained pending dispute event ID. It does not call Square, accept a
dispute, submit evidence, change a refund or payment status, send email, scan
the inbox, or add a timer.

Square does not guarantee webhook delivery order and retries unsuccessful
delivery only for 24 hours. Square recommends `dispute.created` and
`dispute.state.updated` for timely dispute updates. The latter includes final
`WON` and `LOST` outcomes. LeagueVault remains pinned to Square API version
`2026-05-20` and continues to use only those two dispute event types.

Official references:

- [Square webhook delivery and retry contract](https://developer.squareup.com/docs/webhooks/overview)
- [`dispute.created` and `dispute.state.updated` guidance](https://developer.squareup.com/docs/disputes-api/process-disputes#webhook-notifications)
- [`dispute.state.updated` payload](https://developer.squareup.com/reference/square/disputes-api/webhooks/dispute.state.updated)

## Tenant and response boundary

All read and replay routes are mounted below `requireOrgAdmin` at
`/api/payment-disputes`.

- An organization admin's tenant always comes from the authenticated session.
  A supplied organization ID cannot widen that scope.
- A system admin has no implicit global view and must provide a positive
  organization ID on every request.
- Every storage query includes the resolved organization ID. An event UUID
  belonging to another tenant is indistinguishable from an absent event.
- List endpoints use a maximum page size of 100 and stable, opaque keyset
  cursors. They return allowlisted operational fields only. Encrypted payloads,
  payload hashes, provider application/merchant IDs, signature configuration,
  leases, credentials, and raw bodies never cross the API boundary.

The API provides bounded dispute, notification, pending-event, and replay-audit
lists. These are operator-driven reads; no request is issued when nobody opens
the surface.

## Durable notifications

`payment_dispute_notifications` stores one row per accepted dispute ID and
provider version. A unique PostgreSQL index fences duplicate and concurrent
deliveries. The notification contains only tenant/location, local dispute and
verified inbox identities, kind, dispute state, version, and creation time.

The dispute insert/update, notification insert, and inbox completion share the
same PostgreSQL transaction. A crash or constraint failure before commit leaves
all three unchanged. A crash after commit leaves a terminal inbox event and one
visible notification. Older, ambiguous, duplicate-version, unowned, or invalid
events do not emit a notification.

These records are durable in-app operational signals, not an email outbox.
Phase 4B-3A uses them as the immutable, sanitized state history displayed on
affected payment rows. LeagueVault intentionally adds no acknowledgement,
recipient, escalation, or automatic-delivery workflow.

## Explicit replay and audit

`POST /api/payment-disputes/pending-events/:eventId/replay` accepts exactly one
retained `pending` `dispute.created` or `dispute.state.updated` inbox UUID. It:

1. resolves the tenant from the authenticated operator boundary;
2. loads only that tenant/event pair;
3. decrypts the already signature-verified payload and verifies its SHA-256
   evidence hash;
4. normalizes it through the same bounded Square event parser;
5. locks the inbox row and revalidates every normalized identity against the
   immutable inbox metadata;
6. runs the existing Phase 4B-1 reconciliation with no provider I/O; and
7. inserts an immutable operator/result audit in the reconciliation transaction.

Terminal, leased, scheduled-retry, non-dispute, corrupt, cross-tenant, or absent
events are not eligible. A webhook delivery racing an explicit replay
serializes on the inbox row. The first transaction may change business state;
the second observes terminal state and cannot create another dispute version or
notification. When both authorized replay requests reached the locked event,
each action has its own audit row and only one reports a state change.

Crash windows are:

- before transaction commit: dispute, notification, inbox completion, and
  replay audit all roll back;
- after commit but before the HTTP response: a repeated action sees terminal
  inbox state and is idempotent;
- before replay begins, during payload decryption/normalization: no business
  state is changed and the event remains pending for investigation.

Replay is not a provider reconciliation call and cannot issue a charge, refund,
dispute acceptance, or evidence submission.

## Migration, retention, rollback, and CU

Migration `0017_phase4b2_dispute_operations` is additive and forward-only. It
creates the notification and replay-audit tables plus a tenant/status/type/time
index for explicit pending-event reads. There is no backfill, update, delete,
column rewrite, or application activation in the migration. It is safe to
apply before deploying the application.

Ordinary location deletion continues to be rejected while retained dispute or
webhook evidence references it. Replay audit history also prevents ordinary
deletion of its admin actor. Full organization teardown is the explicit
retention exception: it deletes replay audits, notifications, disputes,
operations, and webhook evidence in dependency order inside the existing
atomic tenant teardown.

Application rollback retains migration 0017 and its evidence. Old application
code does not reference the new tables. New dispute reconciliation on the old
application produces no notification; the dispute ledger remains the source of
truth and 4B-2 deliberately performs no backfill or scan.

The slice adds no provider polling, event retry worker, inbox sweep, startup
scan, fixed-cadence query, or automatic notification delivery. Neon work is
limited to indexed operator requests and the small writes attached to a real
dispute reconciliation.

## Future activation and remaining decisions

After CI certification, the future production sequence is migration first,
then application deployment. No Square subscription or webhook mode change is
required for 4B-2. Operators should verify own-tenant lists, a controlled
retained pending-event replay if one exists, audit/notification deduplication,
sanitized logs, and Neon autosuspension. This task does not perform those steps.

Phase 4B-3A adds provider-effect-free dispute visibility directly to affected
rows on the existing Payments page, including provider deadlines and immutable
sanitized history, as described in `docs/phase4b3a-dispute-visibility.md`.
LeagueVault continues to manage disputes in Square. A separate dispute-action
or acknowledgement product is not planned.
