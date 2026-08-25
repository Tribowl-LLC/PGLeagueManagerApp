# Canonical schedule authority (PR1)

`leagues.schedule_authority` is the database-owned product boundary for
schedule history:

| Authority | Active | Product behavior |
| --- | --- | --- |
| `canonical` | true | Editable canonical schedule; published create/rollover is atomic. |
| `canonical` | false | Read-only archive. It remains visible to tenant readers and retains all evidence, but cannot be edited, reactivated, or scheduled. |
| `retired_legacy` | false | Permanently immutable and omitted from every tenant/product list, history, schedule, game, score, standings, and report surface. |

Migration `0034_canonical_schedule_authority` classifies rows from invariant
canonical evidence only. It refuses to run when an operational marker has no
complete applied/approved generation run, when a run's counts disagree with
its occurrences/exceptions, when an occurrence has missing or multiple
published billing terms, or when collection-group evidence is incomplete.
Only an applied generation run counts as operational canonical evidence;
draft/approved v1/v2 rows remain retired. Legacy date arrays remain intact for
evidence and reconciliation.

Creation and future-season rollover share the editable schedule builder. Each
generated date is either Bowling or No Bowling (a skip with no occurrence);
double-pay is an independent marker on at most two real Bowling occurrences.
Direct occurrence cancel/reschedule/restore and double-pay edits remain
available only on active canonical schedules.

Archiving and rollover acquire the tenant/league advisory lock, revoke active
standing-autopay consent, and fence the source ledger. Undispatched pending,
leased, or retry work releases reservations and is canceled. Anything with a
dispatch claim, provider identity/payment evidence, or provider-unknown state
is retained as reconciliation evidence and is never released or retried.
