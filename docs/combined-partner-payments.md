# Combined partner payments

Interactive v3 lets a signed-in active league member quote and authorize one
charge for their own payable balance and/or accepted direct partners in the
same league. The server derives the payer from the session and resolves
participants within the league's organization; unclaimed direct partners are
eligible, while pending/retired/transitive/cross-organization and
cross-league links are rejected. The payer may select weekly counts or a full
remaining balance. The quote is authoritative: it includes each recipient's
subtotal, covered-week labels, and FIFO allocations, and a stale or changed
selection rejects the whole charge.

The v3 operation stores an immutable selection, allocation, payer, and
accepted-link evidence snapshot; only provider source/customer/email fields
remain encrypted as they do for existing operations. Locks and idempotency
preserve the existing reservation, provider, recovery, and reconciliation
boundaries. An unlink before reservation prevents the charge. Once the
snapshot is committed, recovery uses that original evidence and does not
reinterpret live link status. A successful charge has one payer tender and
recipient-scoped allocations; recipient history exposes only that recipient's
credited amount and “Paid by” context. Admin refund confirmation covers every
allocation in the one charge, with existing still-owed/waived behavior and
conservation checks. Provider receipt identifiers remain payer/admin-only; v3
quote and charge responses use an explicit allowlist.

Migration `0041_combined_partner_payment_snapshot.sql` is additive and extends
the existing operation snapshot for v3 evidence. Deploy the application after
the migration has been applied and its checked-in fingerprint verified; the
older v2 interactive and standing-autopay snapshot codec remains readable and
unchanged. If an application rollback is required, use the existing forward
fix/traffic-pause procedure and retain the v3 evidence. Validate with
`npm run db:check`, `npm run db:migration-bytes:check`, focused v3/route/PG
tests, the local suite, and the normal check/lint/build/security gates. Local
PG smoke tests must use a disposable database and a test provider/outbox; no
provider or production requests belong in validation.
