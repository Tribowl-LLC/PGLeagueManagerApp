# Roster-driven payments (PR1)

PR1 makes the Team Rosters surface the sole source of payer responsibility for
newly configured leagues. A league chooses a paying lineup size of three or
four, substitute access (`team_only` or `floating`), and a substitute payment
regime (`team_choice` or `league_lineage_prize_split`). Each team then stores
stable slots `0..lineupSize-1`; every slot is initially `unassigned` and must be
set to a Main bowler or explicit `vacant` before payment readiness is true.

Canonical occurrence evidence is recorded through
`roster-payment-responsibility/1`. It creates immutable responsibility versions
and exact `payment_obligations`. A Main is charged in full, a replacement uses
the selected team policy, a split creates lineage and prize component
obligations, and a vacant slot creates no obligation. Assignment is payment
evidence only and never changes scoring.

The `/2` due/past-due and interactive quote contracts read only
`payment_obligations`; they never infer a balance from historical payments.
The interactive charge endpoint accepts the same exact obligation IDs and
quote fingerprint; it prepares a durable operation, calls the provider only
after commit, and allocates the immutable provider result in a second locked
transaction. Cash/check administration uses the exact obligation IDs and quote
fingerprint.

PR1 intentionally scopes an interactive charge to one payer identity. Accepted
partner links remain available to retained archive/history surfaces, but the new
roster checkout hides combined/partner controls and rejects partner IDs. This
prevents one payer's card from selecting another payer's obligations until a
separately reviewed multi-payer snapshot contract can bind each accepted
partner, payment-method owner, and allocation in one immutable operation
(planned for PR2).
Corrections append a voided allocation record, and provider refunds/disputes
retain allocation evidence while marking it for review.

All roster, responsibility, quote, manual, and correction commands take the
tenant+league advisory lock and record idempotency in `financial_commands`.
Provider calls are outside these transactions. Automatic collection and
standing consent remain dormant for PR2.

Migration `0032_roster_driven_payments_core` refuses to run if any abandoned
F1/D2/F3/F4 canonical evidence exists. Historical payments, refunds, disputes,
the general operation ledger, operation snapshots, schedules, and canonical
collection groups are retained as read-only history.
