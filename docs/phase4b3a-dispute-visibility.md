# Phase 4B-3A: payment-linked dispute visibility and Phase 4 completion

## Product and provider boundary

LeagueVault displays Square disputes on the payment allocations affected by
the disputed Square transaction. It does not create a separate Disputes
product, navigation queue, global badge, acknowledgement state, or escalation
workflow. Dispute state remains independent from local payment and refund
status.

Operators accept disputes and submit evidence in Square Dashboard. LeagueVault
makes no Square Disputes API call and exposes no control that implies a dispute
was resolved, accepted, challenged, or handled locally. The provider state
`ACCEPTED` is rendered as **Dispute accepted**, not "Accepted by Square",
because the stored state does not prove which actor initiated acceptance.

Square documents that sellers view the reason, current state, and response
deadline before deciding how to respond, and that submitted evidence cannot be
removed:

- [Disputes API overview](https://developer.squareup.com/docs/disputes-api/overview)
- [Process disputes](https://developer.squareup.com/docs/disputes-api/process-disputes)
- [View dispute reports in Square Dashboard](https://squareup.com/help/us/en/article/8361-view-dispute-reports)

Provider-side acceptance and evidence submission are intentionally outside
LeagueVault indefinitely. No Phase 4B-3B implementation remains planned.

## Payment-row projection

The Payments page requests `includeDisputes=true` on its existing paginated
payment-list request. Both a valid positive `page` and `limit` are mandatory
for this opt-in projection, and the existing 100-row maximum remains in force.
Unpaginated or malformed opt-in requests are rejected before payment or
dispute storage runs. Only organization and system administrators can request
the projection. Ordinary payment-list callers do not incur dispute queries.

The server batch-loads current dispute summaries for the payment IDs already
authorized by the Payments route. A dispute is returned only when all of these
durable relationships agree:

- the payment is on the already authorized page;
- the payment and dispute reference the same payment operation;
- the immutable payment-operation organization matches the dispute
  organization; and
- an organization-scoped request matches the authenticated tenant.

Webhook reconciliation already validates the dispute location against the
immutable scheduled or interactive operation snapshot before storing the
operation link. Projection deliberately does not compare that historical
location with the league's editable current location, so moving a league
within its tenant cannot hide a legitimate dispute. Missing, stale, or
cross-tenant operation relationships fail closed. A system administrator's
all-organization view is still limited to payment IDs selected by the existing
system-admin payment query.

For all matching disputes on a page, current summaries are fetched in one
query and their immutable state histories in one query. There is no query per
payment row. Only allowlisted ledger fields and sanitized notification fields
are returned. Encrypted webhook bodies, hashes, signatures, credentials,
application/merchant identities, lease data, and raw payloads never cross the
browser boundary.

## Operator presentation

Every affected payment allocation shows a prominent dispute badge beside its
unchanged local payment status. Expanded details show:

- current Square state;
- disputed amount and currency;
- reason;
- stored provider response deadline;
- last provider update;
- immutable, sanitized state/version history;
- the Square dispute reference; and
- a link to the Square Disputes dashboard.

Deadline warnings appear only for nonterminal states. `INQUIRY_CLOSED`, `WON`,
`LOST`, and `ACCEPTED` are terminal presentation states and never produce an
overdue warning from a retained deadline.

For a combined charge, every linked allocation displays the same dispute. The
UI states that the disputed amount applies to the shared Square transaction
and is not assigned to the displayed bowler. LeagueVault never divides or
attributes a transaction-level dispute amount between allocations.

Ordinary payment deletion is disabled for every row whose operation has any
retained dispute evidence, including terminal disputes. The server enforces
the same rule atomically with dispute reconciliation and returns HTTP 409 with
`PAYMENT_DISPUTE_EVIDENCE_EXISTS`; hiding the button is not the security
boundary. Full organization teardown remains the deliberate retention
exception and deletes dispute evidence in its existing dependency order.

## Refresh and Neon CU behavior

Dispute data loads only with the existing Payments page request and refreshes
through the page's normal browser-window-focus behavior. This slice adds no
polling interval, timer, navigation badge query, background worker, startup
scan, inbox sweep, provider query, automatic replay, or recurring Neon work.

The expected CU cost is at most two indexed batch reads for no more than 100
payment rows when an administrator loads or focuses the Payments page and its
current page contains durable operation-linked payments. All other pages and
ordinary payment API callers retain their existing database behavior. Idle
clients create no dispute read activity, so Neon can autosuspend normally.

## Schema, deployment, verification, and rollback

Phase 4B-3A is application-only. It removes the unmerged migration 0018 and
adds no table, column, constraint, index, backfill, or destructive statement.
Production migrations remain at 0017. No Render, Neon, Square, webhook-mode,
or subscription change belongs to this PR.

Recommended rollout:

1. Merge only after every required check is green.
2. Keep Render Auto-Deploy off.
3. Deploy the exact verified main commit without a migration and preserve the
   current webhook processing mode.
4. Verify health, authentication, organization/system-admin isolation, and
   representative scheduled, interactive, auto-pay, and refund behavior.
5. Verify a controlled or already approved dispute appears on every affected
   payment allocation with the correct state, amount, reason, deadline,
   provider update, reference, and sanitized history.
6. For a combined test transaction, verify each allocation shows the same
   transaction-level dispute warning.
7. Verify the Square Dashboard link and manage any dispute action only there.
8. Confirm unrelated signed POS payment updates still return success before
   Neon and create no inbox row, while LeagueVault payment/refund/dispute
   events continue through durable processing.
9. Confirm there are no new scheduler, lease, reconciliation, webhook,
   signature, provider-call, or recurring database errors.
10. Observe Neon autosuspension when the Payments page is idle and during
    ordinary unrelated Square POS activity.

Rollback is application-only: deploy the previous verified application
commit. No database reversal is required because this slice creates no schema
or business-state write. Existing dispute ledger and notification evidence
remain intact.

## Completion status

**Phase 4 implementation is complete when the final 4B-3A code PR is merged.**
Provider-side dispute acceptance and evidence submission remain intentionally
managed in Square.

**Phase 4 production rollout is complete only after** the exact merged commit
is deployed and the final Render, Neon, webhook, dispute-visibility,
payment/refund, tenant-isolation, and POS-origin-prefilter audits pass. Merging
the implementation does not claim those production checks have occurred.
