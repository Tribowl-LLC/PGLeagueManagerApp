# Standing roster automatic payments (PR2)

Standing automatic payments are a payer-controlled, weekly-only consent for a
roster-configured league. The consent binds one tenant-owned saved provider
source/customer and an explicit list of accepted same-tenant partner links.
There is no payer plan, future obligation list, or legacy payment schedule.

At the authoritative occurrence cutoff, the ledger worker takes the league
advisory lock, revalidates consent, membership, partner-link fingerprints and
roster versions, then selects only the exact remaining balance of open or
partially-settled obligations. A published double-pay group is selected by its
stored collection-group membership, never by date or amount. Manual payment or
another reservation wins deterministically. The worker writes a
`standing_autopay_charge` operation, immutable roster snapshot, participant
evidence, financial command and reservations before committing; provider I/O
occurs only after commit.

The capability is gated by `ROSTER_STANDING_AUTOPAY_ENABLED=true` and requires
`SCHEDULED_PAYMENT_EXECUTION_MODE=ledger_execute`. The default is off. Upfront
leagues continue to use interactive exact-obligation checkout; scheduled
upfront collection is not supported.

Legacy `payment_schedules` and F3 plan authorities are removed by the PR3
clean-slate migration after its terminal-operation and zero-canonical-evidence
guard. All pre-cutover payment rows and provider-operation rows are discarded
in dependency order; no old schedule or payment evidence is backfilled.
Provider unknown,
cancellation, partner revocation, and roster drift preserve durable operation
evidence and enter reconciliation; they never silently drop a participant or
issue an automatic refund.
