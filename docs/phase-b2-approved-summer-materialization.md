# Phase B2: approved Completed-Summer materialization

Phase B2 is a dormant, single-league operator and service that turns one
explicitly approved Phase B1 report into the Phase A1 canonical tables. It has
no route, UI, worker, scheduler, provider integration, or automatic production
entry point.

## Contracts

- approval/materialization: `completed-summer-materialization/1`
- materialization semantics: `completed-summer-materialization-semantics/1`
- result: `completed-summer-materialization-result/1`
- command fingerprint envelope: `canonical-occurrence-command/1`, stored as
  `lvcanoncmd:v1:<lowercase-sha256>`
- accepted B1 report: `canonical-occurrence-comparison-report/1`
- accepted comparator: `completed-summer-comparator/3`
- accepted selection: `completed-summer-selection/1`
- accepted A2 result/generator/DST versions: the exact merged A2 versions

The approval request contains an authorized actor, nonempty trimmed reason,
organization and league IDs, the B1 report fingerprint, A2 input and physical
schedule fingerprints, exact source revision, materialization contract,
idempotency key, normalized B1 operator scope, and the sorted stable references
of every acknowledged non-info finding.

The operation-specific command fingerprint recomputes over all of those
semantic values plus a candidate-set fingerprint and these explicit mapping
semantics:

- occurrences are published canonical history;
- scheduled candidates stay `scheduled`;
- cancelled candidates stay `cancelled`;
- billing terms are published version 1 policy snapshots;
- skip lifecycle follows the A2 candidate intent;
- historical lock timestamps are not invented;
- an imported cancellation with no historical event time records the B2 action
  time in `cancelled_at`;
- no payment/obligation link or occurrence relationship is created; and
- initial occurrence, billing-term, and exception snapshots use schema version
  1.

Changing the actor, reason, report, acknowledgement set, A2 fingerprint,
candidate/amount/currency/policy, revision, or mapping semantics changes the
request fingerprint. The caller's fingerprint is never trusted: the service
recomputes `lvcanoncmd:v1` before command insertion.

## Report and acknowledgement validation

The report artifact must be canonical stable JSON byte-for-byte (apart from
the surrounding file newline removed by the operator). Its B1 fingerprint is
recomputed over canonical UTF-8 JSON with recursively sorted object keys,
excluding `reportFingerprint`, exactly as B1 specifies.

The artifact must select exactly one explicit tenant-proven league and its
normalized inputs must equal the requested organization, league, Summer year,
as-of date, fold choice, currency, billing policy, billing ordinal policy, and
source revision. Report and generator fatal counts must be zero. The embedded
A2 result is regenerated from its normalized input and must compare exactly.
Initial approval also requires every B1 A1-evidence count to be zero.

Every warning or error that is allowed to proceed must be acknowledged by its
stable B1 reference. The supplied list must have no duplicates and must equal
the complete sorted set; unknown, missing, or extra references fail closed.
There is no blanket acceptance flag.

These conditions are hard blockers and cannot be acknowledged through:

- report/generator fatal errors;
- invalid or cross-tenant evidence;
- unsupported or noncanonical contract data;
- source revision or regenerated-result mismatch;
- same-day or exact-start collisions;
- skip/occurrence collisions;
- activity on a cancelled candidate;
- conflicting legacy session dates or a proven start-instant contradiction;
- stale current evidence; or
- partial, foreign, manually inserted, or competing A1 state.

Missing/unexpected legacy sessions, local-date hints, unproven legacy starts,
numbering differences, missing game numbers, duplicate historical game keys,
ambiguous historical payments, and refunded/disputed operation warnings remain
review evidence and require their individual references. Acknowledgement is not
resolution: persisted B2 discrepancies remain `open`.

## Atomic boundary and source revision

The operator creates one dedicated `pg.Client`. The service acquires the shared
two-integer league advisory-lock key at session scope before beginning the
repeatable-read transaction, then acquires the transaction-scoped shared A2
lock inside it. This ordering prevents a concurrent waiter from fixing a stale
repeatable-read snapshot while blocked. The session lock is released after the
transaction commits or rolls back, and the operator closes the client on every
path.

Under that uninterrupted lock and transaction the service:

1. proves the league and actor using the merged A2 authorization rule;
2. detects an exact retry without writing;
3. invokes the exported B1 data loader through the same PostgreSQL client and
   requires the current report to equal the approved report;
4. allocates `max(source_schedule_revision) + 1` with the A2 allocator and
   requires it to equal the approved revision;
5. runs the A2 in-transaction occurrence and exception collision checks;
6. creates all commands, the applied generation run, candidates, initial
   revisions, and supported discrepancies; and
7. commits once.

No command is inserted before current B1 equivalence, source allocation, and
collision validation succeed. Any failure rolls back every B2 write. Plan mode
executes the same locked validation branch but never calls an insert/update/
delete branch; it is explicitly a preflight, not a reservation.

## Attribution and mapping

The generation run originates from a `generate` command. Approval metadata
points to an `approve_generation` command. Publication metadata for occurrences
and billing terms points to `publish`. Cancelled occurrence metadata and its
initial final-state revision point to `cancel`. Generated skip exceptions use
`create_exception` while draft; a future A2 candidate with published intent
would use `publish` for publication metadata. No unrelated command is used to
claim publication, cancellation, or historical locking.

Occurrence physical fields, DST tuple, generation key, ordinals, competition
number, competitive flag, and standings flag are copied from A2 without date,
timezone, amount, or numbering recalculation. Billing terms map one-to-one from
A2 and remain separate from physical occurrences. A cancelled/nonbillable term
preserves `none`, zero, and null ordinal. Double-pay evidence is not consulted.
A skip creates an exception and no occurrence. B2 creates no makeup
relationship.

Initial revision rows have revision 1, null `before_snapshot`, an explicitly
versioned complete sanitized `after_snapshot`, and the command responsible for
the stored state.

## Idempotency and concurrency

The operator-provided key belongs to the approval command; related command keys
are deterministic hashes of tenant, league, operator key, and command role.
Under the league lock, an exact same-key retry verifies:

- the entire expected command set and fingerprints;
- exactly one applied run and all run fields;
- every occurrence, term, exception, and command attribution field;
- every initial revision and deterministic snapshot;
- every supported persisted discrepancy; and
- zero relationships or extra/partial A1 rows.

Only then are the previously committed durable UUIDs returned. A changed
payload under the same key is an idempotency conflict. A different key cannot
adopt existing generation rows. Concurrent identical requests converge on one
atomic result; concurrent different approvals serialize and at most one can
materialize.

## Persisted discrepancy mapping

B2 stores only truthful A1 enum mappings:

- `duplicate_historical_game_key`
- `ambiguous_historical_payment`
- A2 `outside_season_occurrence`
- A2 `total_week_mismatch`

Details contain the sanitized B1 stable reference and only the already
sanitized IDs/evidence needed for later review. Unsupported B1 classifications
remain bound by the report fingerprint and acknowledgement list; they are not
coerced into another enum or hidden in the generation input snapshot.

## Absolute money and legacy boundaries

The only money-related canonical rows B2 creates are A1 default billing-policy
terms. They are not bowler debts, obligations, collection plans, or payment
allocations. B2 never creates or updates a payment-to-occurrence,
payment-to-term, or operation link, and never infers one from `week_of`, game
dates, amount similarity, bowler identity, or proximity. Proven B1 operation
evidence remains path-specific evidence only. Ambiguous payments remain valid
and unlinked. Refunds and disputes are untouched.

B2 performs no write to leagues, locations, games, scores, teams, bowlers,
payments, payment operations, snapshots, allocations, refunds, disputes,
provider data, or legacy collection fields. It imports no payment/provider,
encryption, receipt, or email module and makes no provider call.

## Operator

`scripts/materialize-completed-summer-occurrences.ts` handles exactly one
organization/league. Required flags are listed by `--help`. The default is a
zero-write plan. Apply additionally requires:

```text
--apply
--confirmReportFingerprint=<approved B1 SHA-256>
--confirmRequestFingerprint=<lvcanoncmd:v1 fingerprint emitted by the plan>
```

Unknown, duplicated, missing, or misplaced flags fail closed. Semantic JSON is
written to stdout and diagnostics to stderr. Database addresses, credentials,
personal names/emails, encrypted fields, provider identifiers/payloads, and raw
payment-provider data are never emitted. There is no production or Neon mode.

## Phase boundary

B2 does not implement Fall generation, future editing, games/scores cutover,
eligibility, bowler obligations, collection plans, payment allocations,
calendar/reporting consumption, rollover, due calculations, dual-write, or
production cutover. Those remain later C1/D1/D2 and games/payment phases.
