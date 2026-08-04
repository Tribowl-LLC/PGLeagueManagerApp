# Phase 4B-3A: dispute visibility and acknowledgement

## Decision and provider boundary

LeagueVault presents Square dispute state as an operational task independent
from local payment and refund status. One authorized administrator can
acknowledge the organization's awareness of one exact Square dispute version.
The product term is always **acknowledged**. It never means resolved, accepted,
handled, challenged, or submitted to Square.

LeagueVault does not call the Square Disputes API in this phase. Operators
manage the dispute itself in Square. This boundary is intentional because:

- Square says applications should present the dispute reason, current state,
  and `due_at` deadline so the seller can decide how to respond:
  <https://developer.squareup.com/docs/disputes-api/overview>
- accepting a dispute returns the disputed amount to the cardholder and debits
  the seller:
  <https://developer.squareup.com/reference/square/disputes-api/accept-dispute>
- submitted evidence cannot be removed after submission:
  <https://developer.squareup.com/reference/square/disputes-api/submit-evidence>

Provider-effect work formerly described as Phase 4B-3B is deferred
indefinitely. Phase 4 can close after 4B-3A is migrated, deployed, and
verified.

## Durable model

Migration `0018_phase4b3a_dispute_acknowledgements` creates the additive
`payment_dispute_acknowledgements` table. Each immutable row contains:

- organization and local dispute identity;
- the exact Square provider version being acknowledged;
- acknowledging user and role; and
- acknowledgement timestamp.

The unique `(payment_dispute_id, provider_version)` index makes acknowledgement
tenant-wide and idempotent. A current dispute is acknowledged only when an
acknowledgement row matches both its local dispute ID and its current provider
version. When webhook reconciliation advances the provider version, the old
row remains immutable history but no longer matches current state. The newer
version is therefore unacknowledged automatically.

Acknowledgement rows use restrictive organization, dispute, and actor foreign
keys. Ordinary user deletion is rejected cleanly when the user owns retained
acknowledgement audit history. Full organization teardown explicitly deletes
acknowledgements before notifications, disputes, users, and webhook evidence
inside the existing atomic transaction.

## Authorization and race behavior

All reads and writes derive organization scope on the server:

- an organization administrator is forced to the organization in the
  authenticated session, regardless of a client-supplied organization;
- a system administrator must explicitly select one positive organization;
- an absent or cross-tenant dispute returns not found without revealing the
  owning tenant; and
- non-administrators are denied before dispute storage runs.

The acknowledgement request includes the provider version the operator
reviewed. The transaction locks the tenant-scoped dispute row and refuses a
new write with `DISPUTE_VERSION_CHANGED` if Square reconciliation has already
advanced it. A delayed retry of an acknowledgement that already committed
returns the immutable earlier acknowledgement successfully without clearing
the newer version. Webhook reconciliation locks the same dispute row when
updating an existing dispute. The unique constraint converges simultaneous
repeated acknowledgements. Consequently, an acknowledgement/webhook race can
at most record the older reviewed version; it can never silently acknowledge a
newer version the operator did not review.

The badge counts current dispute rows whose latest version lacks a matching
acknowledgement. It does not count historical unacknowledged notification
versions. Historical acknowledgement records remain visible alongside the
immutable, sanitized `payment_dispute_notifications` history. No encrypted
webhook payload, signature, provider credential, lease metadata, or raw body is
returned to the browser.

## Operator experience

The organization-admin Disputes page shows:

- current Square dispute state, reason, amount, and last provider update;
- the stored provider deadline;
- deadline warnings only while the current state is nonterminal;
- whether the exact current provider version is acknowledged and the actor and
  timestamp when it is; and
- immutable state-version history from sanitized notification records.

`INQUIRY_CLOSED`, `WON`, `LOST`, and `ACCEPTED` are terminal presentation
states. Their retained provider deadlines do not produce warnings. The page
does not change payment/refund status and contains no accept, challenge,
evidence, or other provider-action control.

Organization admins receive a navigation badge. It refreshes on normal page
load and browser-window focus. System administrators must select one tenant on
the page and do not receive a cross-tenant aggregate badge.

## CU behavior

4B-3A adds only operator-driven, indexed reads and explicit acknowledgement
writes. It adds no poll interval, timer, background worker, startup scan,
provider query, empty sweep, automatic replay, or notification delivery job.
An active organization-admin browser can refresh the count on mount and
window focus; an idle application performs no acknowledgement query and Neon
can autosuspend normally.

## Migration-first deployment and rollback

Migration 0018 is forward-only and additive. It creates one empty table, three
foreign keys, one unique index, two supporting indexes, and two check
constraints. It contains no backfill, update, delete, drop, rename, or provider
data mutation. Existing application code ignores the new table, so apply the
migration before deploying the matching application commit.

Recommended production sequence:

1. Keep Render Auto-Deploy off.
2. Back up Neon.
3. Apply migration 0018 from the exact CI-certified commit.
4. Deploy that exact commit without changing Square credentials,
   subscriptions, or webhook processing mode.
5. Verify health, authentication, organization/system-admin tenant selection,
   payment and refund independence, current dispute state, history, and badge.
6. Acknowledge a controlled non-production or approved test dispute version;
   verify idempotency, actor/timestamp, and that no Square request occurred.
7. If a newer approved Square test version is available, verify that it is
   unacknowledged and the older acknowledgement remains in history.
8. Confirm there are no new scheduler, lease, reconciliation, webhook,
   signature, or recurring Neon queries and observe normal autosuspension.

Application rollback deploys the previous verified application commit while
leaving migration 0018 and any acknowledgement audit rows in place. No database
rollback is required or recommended. Older application code does not access
the additive table; redeployment of 4B-3A restores the recorded state.
