# Phase F5 — canonical receipts and payment reporting

F5 presents payment evidence from canonical occurrence allocations and the
immutable operation/provider ledger. It is read-only apart from the existing
receipt-cache and refund/reconciliation paths. It does not infer allocations,
link historical payments, or change provider behavior.

## Contracts and evidence

The payment report contract is `canonical-payment-report/2`, ordered by league,
authoritative local occurrence business date, bowler, occurrence, allocation,
and payment. It reports confirmed, allocated, refunded, disputed,
review-required, and unresolved-operation totals. A combined charge is one
transaction parent with exact allocation children; the parent is the
pagination unit and children are never split across pages.

Rows are derived only from exact canonical occurrence allocations,
obligations, revisions, operation snapshots, refunds, and disputes. Dates,
amounts, provider IDs, roster membership, or payer proximity never infer an
allocation. Every payment row is either an exact canonical allocation or an
unresolved operation whose uncertainty is shown explicitly. Missing or
inconsistent evidence returns `FINANCIAL_EVIDENCE_INCOMPATIBLE` and never
falls back to another source.

The report carries authoritative weekly/upfront timing and, when applicable,
the exact collection-point and covered-occurrence evidence for normal or
double-pay grouping. Grouping is never inferred from an amount, date, or item
count. All money is rendered as USD minor units converted to readable dollar
amounts; provider payloads and credentials are never returned to the client.

The receipt contract remains `payment-receipt/1`. It carries scoped payment and
operation identity, amount/currency, exact allocation children,
refund/dispute/unresolved state, shared-transaction grouping, hosted receipt
availability, resend capability, delivery evidence, and payment timing.
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
semantic fingerprint that excludes generated read time. Organization admins
and payment managers receive scoped operational detail; system admins must
select an organization; ordinary users receive only their own authorized rows.
Missing or incompatible canonical evidence fails closed with HTTP 409.

Operation-linked and occurrence-allocation-linked payments are immutable
through public bookkeeping edits. Corrections append explicit evidence, while
refunds and disputes retain the original allocation and remain review-required.
Cash/check recording uses the canonical roster quote and exact obligation IDs;
there is no generic payment-create path that can bypass canonical allocation.

F1 due/past-due remains the sole debt source. F5 collections never recompute
debt from `weekOf` or payment totals. Refunds and disputes retain original
allocation evidence and do not reopen or reassign obligations. Settled and
voided allocation details remain visible; voided obligations contribute zero
outstanding.

## Rollout and validation

F5 requires no new migration. Verify the existing migration journal and
checksum state before release. Focused PostgreSQL and fake-provider tests
prove pagination/conservation, partial and multi-obligation allocation,
refund/dispute visibility, receipt privacy, tenant scope, immutable payment
evidence, and zero report writes or provider calls during reporting.
Rollback is an application traffic pause and forward fix.

Focused coverage includes bounded parent pagination with atomic
combined-operation children, canonical partial and settled/voided allocation
reports, unresolved operation participants, semantic fingerprint stability,
cross-tenant scope, tampered revision snapshots, receipt cache/lazy lookup,
immutable payment mutation, payer privacy totals, payment timing, and
normal/double-pay grouping labels. Any future report/receipt behavior must add
a focused PostgreSQL or fake-provider regression before being described here.
