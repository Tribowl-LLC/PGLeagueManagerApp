# Phase F5 — canonical receipts and payment reporting

F5 is a read-only reporting and receipt-contract cutover with narrowly scoped
mutation safety guards. It does not enable F1/F3/F4, call a provider, link
ambiguous historical payments, or create a canonical cash/check allocation.

## Contracts and evidence

The payment report contract is `canonical-payment-report/1`, ordered by league,
authoritative local occurrence business date (league timezone), bowler,
occurrence, allocation, and payment. It reports confirmed paid, active
allocated, refunded, disputed, review-required, unresolved operation, and
unallocated legacy totals independently. A combined charge is one transaction
parent with payment/allocation children and is grouped only by operation ID,
explicit legacy combined-group ID, or local payment-row identity. Parents are
the pagination unit; child rows are never split across pages. A payer/bowler
projection is applied only after full tenant/league operation conservation is
validated.

Canonical rows are derived only from exact occurrence allocations, obligations,
revisions, operation occurrence supplements, F4 snapshots, refunds, and
disputes. Dates, amounts, provider-ID proximity, roster membership, or payer
proximity never infer an allocation. Canonical evidence with extra historical
rows is reported as `canonical_with_unlinked_history`; those rows never settle
canonical obligations. No canonical activation and no partial evidence uses
`legacy_fallback`. Partial or inconsistent canonical evidence returns
`FINANCIAL_EVIDENCE_INCOMPATIBLE` and never falls back.

The receipt contract is `payment-receipt/1`. It carries scoped payment and
operation identity, amount/currency, canonical or unlinked source, exact
allocation children, refund/dispute/unresolved state, shared-transaction
grouping, hosted availability, resend capability, and delivery evidence.
Hosted receipt availability is separate from delivery evidence, which is
`delivery_not_recorded` unless a future provider-delivery ledger is explicitly
added. Initiating payers and scoped administrators may see a shared hosted
receipt; partner payees see only their own allocation detail; ordinary users
never receive provider/operation diagnostics. Cached receipts are served
without provider access. An explicit user receipt request may perform the
existing lazy provider `GetPayment` backfill through the internal tenant-scoped
cache helper; reports never perform that lookup and no bulk receipt polling is
allowed.

## Visibility and safety

F5 reads are tenant-scoped, bounded, deterministically ordered, and executed
in one repeatable-read, read-only transaction with an `asOf` timestamp and a
semantic fingerprint that excludes that generated read time. Org admins and
payment managers receive scoped operational detail; system admins must select
an organization; ordinary users receive only their own authorized rows.
Missing/incompatible canonical rows fail closed with HTTP 409 and never blend
legacy evidence into canonical totals. Active UIs consume this projection,
label canonical/unlinked/legacy evidence, preserve local dates and allocation
detail, and fail closed on report errors.

Operation-linked or occurrence-allocation-linked payments are immutable through
public PATCH and DELETE, including receipt metadata. Only the internal,
tenant-scoped locked receipt-cache path and locked refund/reconciliation paths
remain available. Every generic payment create is serialized with the
organization/league advisory lock and canonical evidence check. Complete F1
activation is rejected with `CANONICAL_ALLOCATION_REQUIRED`; partial or
inconsistent evidence is rejected with `FINANCIAL_EVIDENCE_INCOMPATIBLE`;
legacy bookkeeping is unchanged when no canonical evidence exists.

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

Focused coverage includes bounded parent pagination with atomic
combined-operation children, canonical partial and settled/voided allocation
reports, zero-payment unresolved operation participants, unlinked Summer
history, legacy fallback, incompatibility/no-fallback, semantic fingerprint
stability, cross-tenant bowler corruption, tampered revision snapshots, receipt
cache/lazy lookup contract, tenant scope, immutable payment mutation, F1-active
generic-create rejection, and unchanged legacy payment/refund/dispute behavior.
Full CI additionally exercises the reviewed F4 webhook/reconciliation and race
suites; the exact file/test count is emitted by the validation run and is not a
contract claim. Any future report/receipt behavior must add a focused
PostgreSQL or fake-provider regression before being described here.
