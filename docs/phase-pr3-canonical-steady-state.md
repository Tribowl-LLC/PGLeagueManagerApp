# PR3: canonical payment steady state

PR3 is the clean-slate boundary for the payment implementation. It keeps the
provider ledger and the roster-driven obligation model, and removes the
unused schedule/setup/snapshot authorities before the first new payment is
taken. No old payment evidence is inferred or converted.

## Runtime contract

`payment_operations` is the only provider-operation ledger. Its supported
operation types are `interactive_charge`, `standing_autopay_charge`, and
`refund`. The ledger retains the provider request fingerprint and idempotency
key, provider object/order IDs, amount/currency, actor and league scope,
leases, fencing, retry/reconciliation state, and interactive card-save state.
Interactive and standing execution snapshots both use
`payment_operation_roster_snapshots`; `payment_operation_roster_snapshot_items`
remain the exact reservation boundary for obligations. Interactive snapshots
also retain the encrypted source/customer/email references, payer and
location, direct-versus-order request shape, ordered catalog line items,
the required FIFO quote fingerprint, and full execution fingerprint. One
operation may cover multiple obligations for the same payer across different
occurrences and always creates one tender parent with allocation children.

Interactive operations are created with their league and authorizing user
already bound. Refunds are the only operation kind that may remain league- or
actor-unscoped.

Interactive preparation, dispatch, finalization, webhook completion, recovery,
refund linkage, and reporting use the unified roster snapshot contract. The
provider interface and provider calls are unchanged and remain outside database
transactions. A missing, malformed, cross-tenant, stale, or fingerprint-
mismatched snapshot fails closed before provider I/O.

## Removed authorities

PR3 removes the application declarations and runtime references for
`payment_schedules`, `autopay_setup_requests`, the generic interactive
snapshot/allocations/line-items tables, and the scheduled snapshot family.
`leagues.final_two_weeks_due_week` is removed. The old scheduled and
canonical-autopay operation types and their cycle/plan columns are removed.
The old weekly autopay planner is deleted because canonical obligations and
the standing-autopay contract now provide the only active payment planning
path.

Refund snapshots, disputes, webhook inbox/replay evidence, canonical
occurrences, collection groups, roster responsibilities, obligations,
allocations, consents, standing bindings/participants, and all provider ledger
controls remain as empty/current authorities. The existing card/customer vault
rows and webhook inbox are retained. The old generic `payments` and all
pre-cutover `payment_operations` are deliberately deleted by 0034 so the new
ledger cannot retain an operation whose execution snapshot was removed.

## Migration 0034

Migration `0034_pr3_canonical_steady_state` is one forward-only transaction.
It locks the old and new payment evidence boundaries, then refuses to proceed
when any payment operation is non-terminal, a dispute exists, canonical
obligations/allocations/consents/roster snapshots/standing evidence exists, or
a scored game lacks an occurrence. It drops the retired execution
authorities, deletes refund snapshots, all old `payments`, and all old
`payment_operations` in dependency order, and retains cards/customers and the
webhook inbox. It deletes only occurrence-less games with no scores before
making `games.occurrence_id` `NOT NULL`. It uses no `CASCADE`, backfill, archive
table, compatibility flag, or inferred allocation. The deletion is intentional
and must be covered by the pre-migration backup and restore plan.

The release order is: verified backup and restore plan; maintenance/traffic
pause; confirm the exact Neon target, migration journal, checksum, and schema
drift; apply 0034; deploy the exact certified application commit; then run the
authenticated payment, tenant-isolation, webhook/recovery, refund, and report
smoke matrix. If the migration guard fails, stop and reconcile the reported
evidence. After application deployment, rollback is a forward fix or traffic
pause; the pre-PR3 application is not a safe target after 0034 has run.
