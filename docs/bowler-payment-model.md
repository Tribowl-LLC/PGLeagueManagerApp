# Bowler payment model

This is the current operating model for who owes league fees and how they pay.
It takes precedence over older phase and feature documents wherever they
disagree. The [status table](#implementation-status) records which parts are
already in the code and which are still being retired; do not build new
behavior on anything listed as retiring.

## Two kinds of bowler

Every bowler on a team is a roster member. A roster member is one of two
kinds, decided by one fact: whether they hold a lineup spot.

- **Regular.** Holds a lineup spot on a team (a `main` position in
  `team_payment_slots`). A regular is expected every week, so the system
  creates a payment line for each published week that is not yet confirmed.
  Weeks confirmed before the bowler took the spot keep whatever responsibility
  was recorded for them; taking a spot never creates liability for earlier
  confirmed weeks. A regular has a season total, can be paid through a number
  of weeks, can use automatic payments, and can be paid in full.
- **Sub.** Every other roster member. A sub owes only the weeks that staff
  assign to them in Manage Payments. A sub has no season total and is never
  paid in full, because nobody knows how many weeks they will bowl.

There is no third kind. A bowler who used to be a rotating member is a sub. A
team that shares a spot leaves that spot without a regular, and staff assign
the week to whoever bowled.

The `is_sub` flag on game scores is a scoring fact about one game. It is not a
payment classification and is unrelated to this model.

## Who owes for a week

Manage Payments (`/manage-payments`, organization administrators only) is the
only place where staff decide who owes for a week. Saving a week on the
worksheet confirms it and records which bowler owes which fee component (full,
lineage, or prize). Only confirmed weeks create collectible debt; unconfirmed
current and future weeks are forecasts. See
[`manage-payments-implementation.md`](manage-payments-implementation.md).

Payment managers review payment records and reports. They do not record
payments.

The team page shows the roster only: who is on the team and which members hold
a lineup spot. It has no payment controls.

## How a bowler pays

In a weekly league, bowlers pay on the Pay page by choosing a number of weeks.
In an upfront league, the Pay page offers one payment for the full season
balance and does not accept a week count; that mode is supported and stays. In
both modes a bowler never types a dollar amount, and there is no "add credit
to my account" option. Do not add one.

- A regular's weeks are priced from their own remaining season.
- Money that arrives before staff confirm a week waits as credit owned by that
  bowler, then pays their oldest confirmed week first. The bowler sees weeks,
  not a credit balance to manage.

All active leagues use the account ledger (`confirmed_account_v4`). A league
without it cannot take online payments and cannot be restored from the archive
until it is adopted.

## Paid in full

A bowler is told "Paid in full, no additional payment needed." only when the
server proves all of the following:

1. The bowler is a regular.
2. The whole season is published: no schedulable draft week, and the published
   schedule reaches the league's season end date.
3. Their applied payments and available credit cover every confirmed and
   forecast week.
4. There is real payment behind it. A zero balance alone is never proof, so a
   league with nothing set up, or a waived-only history, does not qualify.
5. Nothing of theirs is under refund, dispute, or staff review.

The answer describes today's schedule. If staff assign the bowler another week
or a fee changes, the message goes away and a balance returns.

A sub with nothing owing and clean evidence sees "No payment is due right
now." Any other zero balance keeps the "contact your league manager" message.
The client must never infer either state from a zero balance.

## Implementation status

As of 2026-10-08. Update this table as each item lands and delete rows once the
retired code and its documentation are gone.

| Area | State |
| --- | --- |
| Account ledger (V4) bowler checkout | Current. The legacy V3 bowler checkout is removed from the client. |
| Manage Payments worksheet | Current. The only screen for recording payments. |
| Per-league manual-record page (`/leagues/:leagueId/payments/manage`) | Removed, together with its `canonical/manual-record-batch` server endpoints. The single-payment `canonical/manual-record` endpoints remain; the payment form uses them. |
| Restoring an archived league | Requires account-ledger adoption. |
| Server-proven paid in full and nothing due | Current. The participants response carries `holdsLineupSpot`, `seasonPaidInFull`, and `noPaymentDue`. |
| Subs paying by weeks on the Pay page | Not built. Planned for weekly leagues: weeks priced at the league weekly fee, capped at the weeks left in the season, held until staff assign a week. |
| Rotating team payments panel on the team page | Removed. No screen creates a rotating slot, changes a rotation pool, or records a rotating assignment. The server endpoints behind it remain and are to be removed with the rest of the rotating code. |
| Rotating slots, rotation pools, weekly rotating assignments, rotating credit, and the rotating credit card on the Pay page | Retiring. Still in the code and schema. One team still has a rotating slot; the server refuses to turn off a rotating slot that has assignment history, so the team page shows it as a shared spot and saves it back unchanged. Remove the code only after that slot is converted or its season ends. |
| Per-week substitute and split overrides on a slot | Retiring. The team page controls are removed; the server endpoints remain. The worksheet's payer and fee component replace them. |
| Team payment policy (main pays full, substitute pays full, split) | Retiring. The team page no longer edits it and saves the stored value back unchanged. |
| Legacy V3 payment endpoints (`interactive-payment-participants/3`, `-quote/3`, `-charge/3`) | Live compatibility surface. The web client no longer calls them, but the server still serves them and will take a V3 card charge for a league without account-ledger adoption. Treat them as payment code, not history. Retiring them needs an explicit contract change. |

Schema and migration history is never rewritten. Retired tables and their
historical rows stay readable; retirement removes behavior, screens, and
documentation, not evidence.

## Superseded documents

These documents describe mechanisms this model retires. They remain only while
the code they describe still exists.

- [`rotating-team-payments.md`](rotating-team-payments.md): rotating slots,
  pools, and rotating credit.
- [`roster-driven-payments.md`](roster-driven-payments.md): the original
  slot-and-override responsibility model, including per-week substitute and
  split overrides and its statement that no credit ledger exists.
