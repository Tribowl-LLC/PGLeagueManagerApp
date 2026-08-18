# Phase F3: canonical auto-pay plans

F3 introduces a separately gated, provider-effect-free policy and plan
contract. It applies only to a complete F1 activation and never upgrades or
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

Ready F3 items reserve their exact amounts. F2 canonical quotes and locked
preparation include those reservations, so a manual payment cannot silently
consume a ready plan's capacity. F4 will later revalidate the frozen policy,
authorization, activation, location, partner, and collection-point evidence
before unattended execution. F3 itself makes no provider calls and does not
execute scheduled charges. Upfront leagues remain on F2 interactive one-time
collection.

Migration 0026 is additive and contains no backfill or production rows. The
tables use restrictive tenant-scoped foreign keys and immutable version and
fingerprint evidence. Rollback after v2 evidence exists is a forward fix or
traffic pause; the migration and evidence are retained.
