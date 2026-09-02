# Roster-driven payments

PR1 makes the Team Rosters surface the sole source of payer responsibility for
newly configured leagues. A league chooses a paying lineup size of three or
four, substitute access (`team_only` or `floating`), and a substitute payment
regime (`team_choice` or `league_lineage_prize_split`). Each team then stores
stable slots `0..lineupSize-1`; every slot is initially `unassigned`. There is
no league- or team-completion activation gate: each saved Main or explicit
`vacant` position is materialized independently, while `unassigned` positions
remain without responsibility or obligation. Readiness fields are informational
only.

Canonical occurrence evidence is recorded through
`roster-payment-responsibility/1`. It creates immutable responsibility versions
and exact `payment_obligations`. A Main is charged in full, a replacement uses
the selected team policy, a split creates lineage and prize component
obligations, and a vacant slot creates no obligation. Assignment is payment
evidence only and never changes scoring.

The `/2` due/past-due and interactive quote contracts read only
`payment_obligations`; they never infer a balance from historical payments.
One-time cash, check, card, and wallet requests contain only amount and payer
identity (plus tender/provider details where applicable). The server derives
FIFO allocation and returns an opaque quote fingerprint. Finalization
recomputes that allocation under the league lock and persists one tender parent
with one child allocation per obligation.

Every request is scoped to one payer and league. Accepted partner links remain
available to archive/history surfaces but cannot select obligations in the
checkout. A cash/check correction voids the whole tender and records one
`payment_voids` row; a corrected payment is a separate FIFO entry. Provider
refunds and disputes retain the original tender/allocation evidence.

All roster, responsibility, quote, manual, and correction commands take the
tenant+league advisory lock and record idempotency in `financial_commands`.
Provider calls are outside these transactions. Standing automatic collection
is current-point-only and refuses to run while any older open, partial, or
reserved debt remains.

Migration `0035_automatic_fifo_payment_allocation` is the clean-slate parent
model boundary. It fails closed before destructive DDL if payment/provider
evidence is present, makes tenant-safe parent/child keys and exact amount
conservation constraints, and removes obsolete week/lineage/per-allocation
payment fields. No old payment data is inferred or backfilled.
