# Phase F5 — canonical receipts and payment reporting

F5 is a read-only reporting and receipt-contract cutover with narrowly scoped
mutation safety guards. It does not enable F1/F3/F4, call a provider, link
ambiguous historical payments, or create a canonical cash/check allocation.

## Contracts and evidence

The payment report contract is `canonical-payment-report/1`, ordered by
league, canonical occurrence business date, bowler, occurrence, allocation,
and payment. It reports confirmed paid, active allocated, refunded,
disputed/review-required, unresolved operation, and unallocated legacy totals
separately. A combined charge is one transaction parent with payment/allocation
children and is grouped only by operation ID, explicit legacy combined-group
ID, or local payment-row identity.

Canonical rows are derived only from exact occurrence allocations, obligations,
revisions, operation occurrence supplements, F4 snapshots, refunds, and
disputes. Dates, amounts, provider-ID proximity, roster membership, or payer
proximity never infer an allocation. Canonical evidence with extra historical
rows is reported as `canonical_with_unlinked_history`; those rows never settle
canonical obligations. No canonical activation and no partial evidence uses
`legacy_fallback`. Partial or inconsistent canonical evidence returns
`FINANCIAL_EVIDENCE_INCOMPATIBLE` and never falls back.

The receipt contract is `payment-receipt/1`. Hosted receipt availability is
separate from delivery evidence, which is `delivery_not_recorded` unless a
future provider-delivery ledger is explicitly added. Cached receipts are
served without provider access. An explicit user receipt request may perform
the existing lazy provider `GetPayment` backfill; reports never perform that
lookup and no bulk receipt polling is allowed.

## Visibility and safety

F5 reads are tenant-scoped, bounded, deterministically ordered, and executed
in one repeatable-read, read-only transaction with an `asOf` timestamp and
fingerprint. Org admins and payment managers receive scoped operational detail;
system admins must select an organization; ordinary users receive only their
own authorized rows. Partner payees do not automatically receive a payer's
shared hosted receipt.

Operation-linked or occurrence-allocation-linked payments are immutable through
public PATCH and DELETE. Receipt-cache updates and locked reconciliation paths
remain available. Generic cash/check creation is rejected for complete F1
activation (`CANONICAL_ALLOCATION_REQUIRED`) and for partial/inconsistent
canonical evidence (`FINANCIAL_EVIDENCE_INCOMPATIBLE`); legacy bookkeeping is
unchanged when no canonical evidence exists.

F1 due/past-due remains the sole debt source. F5 collections never recompute
debt from `weekOf` or payment totals. Refunds and disputes retain original
allocation evidence and do not reopen or reassign obligations. Settled and
voided allocation details remain visible; voided obligations contribute zero
outstanding.

## Rollout and validation

F5 requires no migration: it reads the existing F1/F2/F3/F4 tables and F4
`0029` schema. Deploy only after the normal migration/checksum state is
verified. Keep all execution gates and webhook processing unchanged. Reports
and receipt reads are smoke-tested with isolated PostgreSQL fixtures and fake
providers only; the smoke must prove zero `processPayment` calls and zero
report writes. After canonical evidence exists, rollback is traffic pause and
forward fix, never a down migration or historical relinking.

Focused coverage includes canonical partial and settled/voided allocation
reports, double-pay and combined charges, unlinked Summer history, legacy
fallback, incompatibility/no-fallback, conservation, duplicate webhook and
reconciliation convergence, receipt cache/lazy lookup/privacy, tenant scope,
immutable payment mutation, F1-active cash/check rejection, pagination,
timezone ordering, and unchanged legacy payment/refund/dispute behavior.
