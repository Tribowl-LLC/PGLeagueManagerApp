# Phase F3: canonical auto-pay plans

F3 introduces a separately gated, setup-only policy and plan contract. Policy
candidate/read, policy, preauthorization-quote, and persisted-plan read
operations are provider-free. It applies only to a complete F1 activation and never upgrades or
interprets v1 payment schedules. The gate is `LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED`
and is false when unset.

An organization administrator approves an immutable, versioned policy whose
rows name real canonical occurrence UUIDs. A normal group has one row. A
double-pay group has exactly two rows and each row explicitly names the other
occurrence as its pair. Collection points are UUID evidence; dates and row
ordering never establish a pair. A policy is tied to the F1 activation
revision and source fingerprint and becomes unusable on source drift.

A payer authorization is a separate immutable version. It names the payer,
covered bowlers, accepted partners, exact collection points, timing, and
payer-owned payment method evidence. The server derives plan items from
approved policy and current obligations. Each item equals the exact remaining
unreserved obligation balance, including a balance left after a partial F2
allocation. Settled, voided, review-required, missing, duplicate, or
inconsistent evidence fails closed.

Ready F3 items are persisted as D2 `occurrence_collection_plans` and
`occurrence_collection_plan_items`; F3 stores provenance only and does not
create a competing financial lifecycle. They reserve their exact amounts.
F2 canonical quotes and locked preparation include those reservations, so a
manual payment cannot silently consume a ready plan's capacity. F4 will later
revalidate the frozen policy, authorization, activation, location, partner,
and collection-point evidence before unattended execution. Policy
candidate/create/approve, preauthorization quote, persisted-plan read, and D2
persistence are provider-free. Payer authorization performs exactly one
read-only payer-owned card/customer/location ownership lookup outside the
database transaction. F3 performs no provider mutation, charge, setup, refund,
or scheduled execution. Upfront leagues remain
on F2 interactive one-time collection. Any due or past-due item blocks
readiness with an explicit F2 catch-up requirement; immediate collection uses
the existing F2 quote, reservation, provider, and finalization flow.

Migration 0026 is additive and contains no backfill or production rows. The
tables use restrictive tenant-scoped foreign keys and immutable version and
fingerprint evidence. Rollback after v2 evidence exists is a forward fix or
traffic pause; the migration and evidence are retained. Enabling requires an
explicit reviewed environment gate change and a smoke test for one approved
league; merging the migration does not activate F3 or create production data.

## Contract and route boundary

The wire contracts are versioned as `canonical-collection-policy/1`,
`canonical-autopay-preauthorization-quote/1`, `payer-autopay-authorization/1`,
and `canonical-autopay-plan/1`. Routes are scoped beneath
`/api/financials/f3/leagues/:leagueId`: administrators use `policy/candidates`,
`policy`, and `policy/:policyId/approve`; a payer uses `prequote`, `authorize`,
`quote` for durable ready evidence, and `authorize/:authorizationId/revoke`.
Tenant, league, membership, role, and payer-self authorization apply to every
route; system administrators must provide explicit organization scope.

Policy approval is organization-admin evidence, not payment approval. Payer
authorization is separate immutable consent for the exact ordered obligation
IDs, occurrences, payees, collection points, amounts, timing, source
fingerprint, policy version, activation source, and preauthorization
fingerprint. Material changes create a new version; ready, superseded, and
revoked states remain auditable evidence.

## Atomic conservation behavior

Prequote and durable-plan reads use one repeatable-read, provider-free
snapshot. Authorization takes the league advisory lock, then locks obligations
in F2's deterministic order before re-reading policy, activation, membership,
partner, schedule, allocation, and reservation evidence. D2 ready plans/items
and F3 provenance are inserted atomically. Stale quotes and racing
authorizations produce typed conflicts with zero partial F3 writes.

F2 treats ready-plan amounts as reserved capacity and rejects conflicting
manual selections. Active F2 pending, leased, provider-unknown,
retry-scheduled, or reconciliation-required snapshots block F3 readiness;
terminal operation states do not reserve. Refund/dispute timestamps or
dispute-ledger evidence make allocations review-required. Missing, duplicate,
extra, over-allocated, lifecycle-inconsistent, or over-reserved evidence fails
closed.

## Release and smoke matrix

With the gate unset or false, F3 routes and UI capability are unavailable and
v1/F2 behavior is unchanged. With a separately authorized gate, verify: an
inactive or partial F1 league is rejected; an administrator can review exact
normal and double-pay rows and approve once; a payer can prequote, select
partners/card, authorize, reload durable ready evidence, and revoke; F2 shows
reservations and rejects conflicts; and stale, cross-tenant, upfront,
legacy-schedule, pending-operation, refund/dispute, provider-outage, and
location/card-drift cases are nondisclosing and zero-write. No provider
mutation or unattended execution occurs. Do not enable production from merge
or migration application alone. Existing v1 schedules are never upgraded,
backfilled, blended, or cancelled implicitly.
