# Identity integrity and account roles

An account and a bowler are separate concepts. A `user` account may claim one
bowler in its organization. Staff accounts (`org_admin`, `payment_manager`,
and `system_admin`) cannot be linked to a bowler. A payment manager must also
have one organization and one location; its operational access is limited to
reading leagues, teams, and bowlers plus recording cash/check payments at that
location. Roster and team mutations remain administrator-only.

`server/services/identity-link.ts` is the transactional owner for every
account-to-bowler mutation. It locks the user and target bowler rows, requires
an ordinary account in the requested organization, rejects an already claimed
target, updates `users.bowler_id`, and appends an `identity_link_events` row in
the same transaction. Registration, self-service claims, admin assignment,
replacement, and unlinking all use this service. Callers that
already own a transaction pass its executor so user creation, roster changes,
the claim, and the audit event commit together.

Self-service claims prove that the locked user and bowler rows have the same
normalized email inside the identity-link transaction. Route-level checks can
still fail fast, but they are not the security boundary. Email matching is
organization-scoped and only auto-links when exactly one bowler matches; a
shared or duplicate email requires an explicit administrator decision.

Events store allowlisted bowler snapshots only (`id`, `name`, organization,
and active state); raw email, phone, account-action tokens, passwords, and
payment-provider identifiers are never persisted in the event payload. Every
event also carries an immutable subject user ID separate from its nullable user
foreign key, so account deletion retains who the link history concerned. A
linked-account deletion appends an `access_cleanup` event before removing the
user.

## Credential actions

`account_action_requests` is authoritative for account invitations and
password resets. It stores only a SHA-256 token digest and has explicit
`pending`, `consumed`, `superseded`, `revoked`, and `expired` states. Issuance
supersedes the previous pending action of the same type under a transaction
advisory lock. Password setup claims the pending row and changes the password
in one transaction, making replay and concurrent acceptance idempotent.
Issuance through delivery is additionally serialized per user/action so a slow
older resend cannot deliver a token after a newer token supersedes it.

Email is attempted after the account/action transaction commits. The action's
delivery state (`not_attempted`, `sent`, or `failed`) is durable and exposed to
the admin UI without either the raw token or its digest. This is deliberately
a focused hardening step, not a general email outbox; a process crash in the
small post-commit/pre-send window leaves a visible `not_attempted` invitation
that an administrator can resend.

The legacy `users.invite_token` columns remain for one compatibility release,
but application code neither accepts nor writes them. The release order is:

```bash
# Before the migration, against the intended database:
npm run db:preflight:identity-integrity
npm run db:migrate

# After deploying the matching application build:
npm run db:migrate:legacy-account-actions
npm run db:migrate:legacy-account-actions -- --execute
```

The first legacy-action command is a PII-free dry run. `--execute` reissues
active legacy actions into hashed invitations, records email delivery, clears
all plaintext/stale legacy markers, preserves each active token's original
expiration, and exits nonzero when any delivery fails.
Failed rows remain visible for administrator resend. Back up and verify the
target database before the schema migration and execute the bridge against the
same target immediately after deploying the matching application build.
