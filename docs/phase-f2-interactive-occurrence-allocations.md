# Phase F2: interactive occurrence allocations

F2 adds an explicit, tenant-scoped `interactive-obligation-quote/1` contract to
general one-time interactive payments. A canonical F1 activation is required;
partial or incompatible evidence fails closed with a bounded conflict and never
falls back to legacy financial identity. Leagues without an operational
canonical activation retain the existing payment behavior and create no D2
supplement.

The request carries unique obligation UUIDs and positive minor-unit amounts.
Selections are deterministic (`dueAt`, bowler, occurrence, obligation), may be
partial, and may intentionally target future obligations. The quote fingerprint
is semantic evidence, not a time-to-live. `payments.weekOf` remains the
compatibility/display day (the league-local day at preparation); the occurrence
snapshot and settlement allocation are authoritative financial identity.

Preparation locks the complete activation and obligation evidence, rechecks the
quote, and counts both settled allocations and nonterminal operation supplements
before accepting capacity. This prevents two request keys from reserving the
same outstanding amount. The provider call remains outside the database
transaction. Success finalization uses the immutable supplement to create the
ordinary bowler-level payment rows, one occurrence allocation per obligation,
and revision-1 evidence atomically. Webhook reconciliation uses that same
finalizer.

New interactive operations retain immutable `authorizing_user_id` evidence.
That actor or a properly scoped organization/system administrator may recover an
F2 operation; old operations without actor evidence retain their prior provider
identity but require current payer linkage or scoped administration. Refund,
dispute, receipt, reporting, and auto-pay/scheduled behavior are unchanged.

Migration `0025_f2_interactive_occurrence_actor` is additive and has no
backfill. The activation flag remains operationally off until separately
authorized. Once F2 rows exist, recovery is roll-forward/traffic-pause only;
an application revision that cannot read F2 actor evidence is not an approved
rollback target.
