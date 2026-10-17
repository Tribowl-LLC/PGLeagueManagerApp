# Manage Payments: accepted design and release plan

Manage Payments is the only place staff decide who owes for a week. For the
bowler types, how bowlers pay, and the paid-in-full rule, see
[`bowler-payment-model.md`](bowler-payment-model.md). Rotating credit described
below is retiring; existing rotating lots stay readable.

## Scope and existing surfaces

The organization-admin worksheet is the existing **Manage Payments** entry at
`/manage-payments`, implemented by `AdminWeeklyPaymentsPage` and
`AdminWeeklyPaymentsWorksheet`. Its versioned API is
`/api/financials/leagues/:leagueId/manage-payments/1`. The older
`/leagues/:leagueId/payments/manage` payment-manager page has been removed;
recording payments is an organization-admin action on this worksheet.
`/payments`, bowler login, saved-card management, receipts, and AutoPay setup
remain available.
This work adds no payment-history tab, add-bowler action, or rotating-credit
classification.

The worksheet edits one selected canonical occurrence and displays current
roster responsibility, fee component, payment history, balance, and derived
final-two-week coverage. Money is integer cents. The server owns team and
roster scope, published fee values, receipt identity, balances, and source
authorization. Each save is tied to the loaded revision and state fingerprint;
the server recomputes from current evidence under the league financial lock.

## Responsibility, debt, and credit

The worksheet records which rostered bowler is responsible for the selected
week and whether that responsibility covers the full, lineage, or prize fee.
An explicitly responsible zero-priced component remains evidence, but creates
no obligation. It preserves the current fee policy rather than altering the
underlying settled, refunded, or waived component history.

Reconciliation retains an exact existing component when responsibility and
amount are unchanged, including its settled, refunded, or waived history. A
changed or removed responsibility/component is retired with its correction
audit evidence; exact active source applications are released back to their
original owners before FIFO is recalculated for the resulting responsibility.
The writer fails closed when the allocation or refund evidence cannot be
safely reconciled. Saving a week does not blanket-retire its complete legacy
responsibility set.

Only confirmed weeks create collectible weekly debt. A worksheet save
explicitly confirms a selected week; the adoption cutoff retains eligible
historical weeks as confirmed. Unconfirmed current and future weeks remain
forecasts. New money applies FIFO only to the source owner's oldest confirmed
debt; an unresolved review hold at the oldest debt stops later applications.
Surplus remains credit owned by its original credited bowler. It does not pay a
future week before staff confirms that week's responsibility.

Each real tender remains one immutable parent payment. Its immutable funding
portions identify the credited bowler or bowlers and their exact shares;
`payments.bowlerId` remains the initiating payer. Actual allocations are
separate evidence of debt payment. Existing rotating-credit funding lots stay
in their existing ledger and are never copied into generic account funding.
On a responsibility correction, released value returns to the funding
portion's original owner and can then apply FIFO to that owner's oldest
confirmed debt. A retained team-owned obligation may be paid using its exact
`legacy_team_assignment` target when the assignment's actual bowler is that
source owner. A differing source owner and effective debtor requires exact
immutable authorization and correction proof; it must not transfer ownership
by inference.

The account balance is one league-wide budget per bowler: available generic
credit and existing rotating lots are considered together against confirmed
debt. The accepted shared projection is the source of truth for due and balance
views, the worksheet, team-envelope calculations, and final coverage; adapters
must not derive a separate balance by summing due rows or count a credit twice.
Final-two-week coverage uses that budget against both materialized obligations
and canonical forecast targets. Waived debt remains waived evidence;
unresolved refund, dispute, or financial-review holds prevent the system from
claiming coverage.
The existing final-two-week collection requirement and early-final collection
targets remain. The final-two-week responsibility editor is deferred; coverage
is derived, not manually marked paid. A final week is shown Paid only when
positive actual payment and/or projected credit fully covers a positive
required amount. Zero demand or waived-only evidence does not by itself count
as Paid.

## Receipts, collection dates, and refunds

The worksheet preserves each exact cash or check receipt. A new manual receipt
defaults to the selected occurrence's league-local collection date. Editing an
amount voids the old tender and records a replacement revision in the same
receipt lineage while preserving that business date. A blank or zero amount
clears only that receipt by voiding its tender and appending a null-payment
clear revision; it does not delete receipt history. The latest immutable
manual receipt revision supplies the business collection date for archive and
month filtering. The parent payment's `createdAt` remains the actual audit
timestamp.

Provider card receipts remain immutable and retain their actual collection
period, standing-autopay trigger mapping, and provider evidence. A receipt's
collection period is distinct from the week whose debt its money later pays;
allocation does not move income into that debt week. Existing V4 interactive
account funding and V5 standing-autopay funding record exact credited portions.
Existing card consent, saved-card, cutoff, AutoPay, and early/final collection
behavior remains in place. A successful collection without confirmed debt is
owned credit until a week is confirmed; no late catch-up rule is added.

A whole-parent card refund remains a separate action and returns to the
original card. Its immutable V3 evidence covers every owned portion and its
allocation/refund state. Unused value is removed from the credited owner's
source; spent value affects the corresponding debt only through the existing
still-owed or waived disposition. Those dispositions apply only to spent
debt. A pure-unused refund has no debt disposition choice. The archive reports
one parent tender in league gross and reports proven refunds separately; it
does not manufacture allocations for unused credit.

## Existing history and privacy

The canonical payment archive, F5 financial report, existing receipt details,
and receipt-opening authorization continue to serve payment history. The
owned-source projection adds valid unallocated and partially used funding
without inventing payment allocations. Administrators retain exact tender,
funding-portion, and application evidence. The initiating payer retains the
existing whole-receipt permission. Another credited recipient sees only their
own portion, including when it has no debt allocation; they do not receive
other recipients' names, amounts, IDs, or provider identifiers. A historical
allocation beneficiary keeps only the narrow visibility already authorized by
that allocation, not ownership of remaining source credit.

Redaction applies to nested receipt and allocation data, totals, and
transaction groupings, not only top-level fields. Credited-recipient access
does not grant hosted full-receipt access, mutation access, or saved-card
access. No receipt link authorization or lazy-fetch policy changes.

## Adoption boundaries

Existing leagues stay in legacy mode until a separate, reviewed,
league-scoped adoption passes a read-only preflight and commits atomically
under the league lock. The preflight preserves authorized source portions,
legacy allocations, corrections, refunds, disputes, and receipt history; an
ambiguous or unattributed source is held for explicit resolution rather than
guessed. One-time mapping of a legacy manual tender uses `payments.createdAt`
converted to the league-local collection date and its canonical collection
period; pre-adoption payments do not have worksheet receipt heads or revisions
to consult. After adoption, worksheet receipt revisions carry the business
collection date, and the latest revision drives archive/month filters while
`payments.createdAt` remains audit provenance. Legacy rotating lots remain
their own sources. Adoption does not run during GET, startup, or merely
because an older league is empty.

Pristine ledger initialization is a distinct setup action: it belongs only to
actual new-league or new-season creation, after the canonical schedule has
been published. It must not run on reads or startup and must not classify an
old empty league as new. The adoption initializer and CLI/operator runbook are
tracked separately; this document intentionally does not invent their
commands or options. No production adoption is asserted by this design note.

After adoption, rollback is not a code-only revert. A recovery plan must
reconcile or restore from a verified backup while preserving intervening
payments, refunds, waivers, allocation releases, receipt revisions, confirmed
weeks, ownership proofs, and the adoption marker. Never remove adoption
markers or discard post-adoption payment outcomes to make an older binary run.

## Frozen migration sequence and data impact

Migrations `0052` through `0055` are the reviewed, frozen schema sequence for
this release. The eleven new tables are:

| Migration | Tables and contract changes |
| --- | --- |
| `0052_weekly_admin_payments_ledger.sql` | Ten tables: `payment_allocation_funding_applications`, `weekly_payment_allocation_releases`, `weekly_payment_funding_authorization_items`, `weekly_payment_fundings`, `weekly_payment_ledger_adoption_allocation_proof_steps`, `weekly_payment_ledger_adoption_allocation_proofs`, `weekly_payment_ledger_adoptions`, `weekly_payment_week_confirmations`, `weekly_payment_worksheet_receipt_revisions`, and `weekly_payment_worksheet_receipts`. Adds the worksheet responsibility shape and fee-component field. |
| `0053_owned_payment_refund_support.sql` | Adds `account_payment_operation_snapshots` for V4 interactive account-funding authorization, plus source-portion refund evidence and typed assignment FK support. |
| `0054_weekly_standing_account_funding.sql` | Adds V5 standing-funding evidence and variant-specific checks. `source_kind`, `encrypted_source_id`, and `quote_fingerprint` may be null only in the V5 standing shape; V4 interactive snapshots continue to require their source and quote evidence. |
| `0055_owned_account_refunds_v3.sql` | Extends refund snapshots and adjustment evidence for full-parent refunds of owned V4/V5 or adopted funding, including typed allocation release. |

The four legacy responsibility fields `slot_id`, `slot_index`,
`position_index`, and `policy` become nullable only so the new worksheet
identity shape can omit slot/policy data. The new checks preserve the strict
legacy shape and constrain the worksheet shape separately.

The sequence replaces six checks that existed before 0052: the
responsibility-kind check in
0052; refund-snapshot version, fingerprint, and disposition checks in 0053;
and refund allocation-snapshot plus refund-adjustment fingerprint checks in
0055. It also adds or revises new checks and foreign keys for tenant-scoped
funding, typed assignments, V4/V5 snapshot variants, immutable refund proofs,
and applications/releases. The migrations add tables and evidence columns;
they do not drop tables or columns and contain no row deletion or truncation.

Because this sequence replaces production constraints, the explicit approval
rule in [AGENTS.md — Database And Schema Safety](../AGENTS.md#database-and-schema-safety)
applies. This design note is not that approval. Review the exact SQL and
production gates before any production operation.

## Required release sequence

Follow the [production runbook](production-runbook.md#default-release-lifecycle)
and [DATABASE production migration process](DATABASE.md#production-migration-process):

1. Complete local architect and internal review of the final branch, then open
   the single PR ready for review. After every push, recapture the head and
   verify the PR remains ready. The PR may open before its CI completes. Count
   the automatic independent GitHub review if one starts; otherwise, after
   verifying none is queued or running, request exactly one; internal review
   does not substitute for it. Before merge, disposition findings, reply to
   and resolve addressed threads, and pass the required CI checks on the final
   head without starting a second review loop. A ready PR is not permission to
   merge. Obtain the user's explicit approval for the production constraint
   changes before the production release proceeds.
2. Before merge, verify the known production service's Auto-Deploy is Off and
   record its prior setting. Keep it Off through certification, migration,
   adoption, deployment, and verification, as required by the
   [schema-release hold](production-runbook.md#schema-release-auto-deploy-hold).
3. After merge, certify the exact current merged `main` SHA. Verify the
   certification proves the merged PR, identical tree, PR check provenance,
   and certified SHA. The PR head and merge commit may have different SHAs;
   require their reviewed merge/tree/check provenance, not SHA equality. Stop
   if current `main` differs from the certified SHA or that evidence is
   missing.
4. From that exact certified commit, use the protected migration workflow:
   verify target identity and pre-fingerprint, create a current restorable
   backup, apply only the exact reviewed ordered `0052`–`0055` pending list,
   then require the guarded post-migration no-op. Never run production SQL
   directly from a local shell.
5. Manually deploy the exact certified SHA in dual mode: legacy leagues remain
   on their established paths while adopted leagues use the owned-credit
   ledger. Confirm the deployed SHA before any adoption.
6. For each league, run the separately documented read-only preflight, stop
   on blockers, and perform the guarded atomic apply only after its evidence
   passes. Use the adoption owner's reviewed CLI/runbook for exact commands;
   do not infer command names or flags from this document.
7. Verify health and matching SHA, authentication, tenant isolation, weekly
   worksheet and balance behavior, receipt/history redaction, refunds, provider
   receipts, and financial reports. Verify both legacy and adopted paths.
8. Restore the prior enabled Auto-Deploy mode only when the running service
   SHA and current `main` SHA still equal the certified SHA and all health and
   workflow checks pass. Otherwise leave Auto-Deploy Off and record the hold.

No schema migration, production adoption, or deployment is authorized by this
document alone. Production migration and adoption remain behind their exact
review, backup, approval, and verification gates.
