# Password recovery

The email link `/set-password?token=…` serves both account invitations and
password recovery. Its compatibility endpoint, `/api/auth/validate-invite`,
validates both supported purposes and returns only the masked email and the
server-verified action type. Validation must never consume a usable action.
Password submission repeats eligibility checks and claims the action in the
same database transaction that changes the password.

Password-reset completion returns the user to normal sign-in. Account
invitations retain the onboarding and automatic sign-in behavior. Recovery
does not link or reassign bowler identities. Reset tokens remain single-use,
hashed at rest, and valid for one hour unless consumed or invalidated by a
credential change. A newer reset request preserves existing usable links.

The page distinguishes used, expired, replaced, revoked, invalid, throttled,
and temporarily unavailable states. Network and server errors allow retry;
they must not be presented as expiration. Validation and submission responses
from a previous URL are ignored after the user follows another link.

## Required verification

`npm run test:local` builds the current frontend, installs the matching
Playwright Chromium binary, and runs the browser regression with the rest of
the suite. Linux hosts also need Playwright's OS dependencies installed
(`npx playwright install --with-deps chromium` on a host where package
installation is allowed). CI installs these dependencies explicitly. An
optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects an existing compatible binary.
Missing prerequisites fail the recovery regression instead of skipping it.

`tests/e2e/password-reset-journey.test.ts` starts a real isolated application,
requests recovery through the browser, captures the rendered email with the
blocked `vitest.local` recipient outbox, and follows its exact HTTPS link.
Only the network destination is mapped to the isolated local server; API
responses are not mocked. It exercises template and fallback email delivery
on organization and root hosts, repeated opens, no-cache/no-referrer headers,
password completion, normal sign-in, old-password rejection, and used-link
rejection. It never sends a message to a real mailbox.

Route and PostgreSQL tests cover both credential purposes and terminal states.
Component tests cover transport/server failures, throttling, URL changes, stale
responses, and expiration between validation and submission.

## Release checks

Follow `docs/production-runbook.md`, deploy the exact reviewed and CI-verified
main commit, and check health plus `/api/org-context`. Use an owned test account
to follow the real reset email after deployment; sending that email requires
explicit authorization. Never retrieve a customer's token, extend an old
token, or choose their password while verifying recovery.

Inspect structured `Account action validation` and `Account action consumption`
events for action ID and outcome. The events intentionally omit token material,
email addresses, and user IDs. Provider acceptance is not proof of inbox
delivery or that the recipient opened the email.

The initial validator/UI repair has no database migration or new environment
variable. The hardening changes below require their separately reviewed migration and rollout.

## Durable recovery delivery and token policy

Migration `0038_password_recovery_hardening` adds the delivery intent queue,
minimal SendGrid event evidence, and a database-managed credential generation.
It replaces the single-pending-action index with invitation-only uniqueness.
Password recovery allows at most three unexpired pending links per account;
a subsequent request does not invalidate an existing link. Requests within
five minutes of an accepted delivery are suppressed. At capacity, the user
can use an existing link or request another after expiration. Completing any
link revokes all remaining pending credential actions atomically.

The public request commits a job containing user/tenant IDs, generation, and
a one-hour deadline before responding. It stores no email address, raw token,
password, or rendered message. Unknown, passwordless, and suppressed accounts
receive the same public message. A 250 ms response floor reduces ordinary
lookup/enqueue timing differences; it is not a constant-time guarantee under
infrastructure delays. Existing IP throttling and the per-account cap remain
necessary abuse controls.

Workers claim due jobs with `FOR UPDATE SKIP LOCKED`, release the transaction,
and resolve the authoritative recipient. Issuance rechecks the expected
credential generation under an account lock and user row lock. Provider I/O
never holds the transaction or a session advisory lock. Claims use a 60-second
lease with fenced completion writes, a 30-second provider timeout, at most
four attempts, and delays of 30 seconds, two minutes, then ten minutes. The
original intent deadline remains authoritative on retries. An uncertain send
may produce more than one email; each link remains subject to the three-link
cap and single-use rules. This is deliberately not an exactly-once delivery
claim. Template absence uses the fallback renderer; a provider error does not
immediately dispatch a duplicate fallback email.
Definite failures before provider submission, such as missing SendGrid
configuration, revoke that attempt's unused action and free link capacity.
Uncertain provider outcomes retain their links, including after retry exhaustion.

Each application instance runs a scheduler. Local enqueue wakes it promptly;
a 60-second safety sweep discovers another instance's committed jobs and
expired leases after crashes. This polling can keep the Neon compute awake
and should be included in production cost expectations. Shutdown stops new
claims and drains in-flight work for up to 35 seconds before closing the pool.

## Session and credential invalidation

Passport stores `{ id, generation }` and checks the current database generation
on every authenticated request. Legacy numeric sessions mean generation zero.
The database trigger advances the generation whenever the password or email
changes, revokes pending account actions, and invalidates pending email-change
requests in the same transaction. Application writes cannot set the generation
directly. Stale authenticated snapshots cannot acquire a fresh generation at
session serialization. Deleting old session rows is cleanup; authorization
revocation does not depend on that deletion succeeding or on process caches.
Self-service password/email changes refresh the caller's session only after
the credential transaction commits. If session refresh fails, the response
still confirms the completed change with `requiresLogin: true`, and the client
clears cached authentication and directs the user to sign in again.
Unauthenticated recovery requires normal sign-in after completion.

## SendGrid delivery evidence

Configure a Signed Event Webhook at
`https://leaguevault.app/api/email/sendgrid/webhook`, with the public verification
key in server-only `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`. Enable processed,
delivered, deferred, bounce, and dropped events. The receiver verifies the exact
raw body plus timestamp using SendGrid's ECDSA signature, enforces a five-minute
signature timestamp window, and deduplicates `sg_event_id`. It requires known,
matching action/job IDs. Delayed events remain associated with their original
action even after another attempt is issued. Database failures receive a
retryable response. Missing or invalid signatures never enter the evidence
store. No recipient, raw payload, provider reason, or link is retained.

An HTTP acceptance from SendGrid is recorded separately from subsequent
mail delivery events. A delivered event is not proof that a human opened or
completed the reset. Do not enable engagement tracking on reset links.

## Rollout, monitoring, and rollback

1. Release the validator/UI repair independently through PR #219.
2. Review the hardening migration and its checked-in schema fingerprint. The
   generated redundant payment constraint rebuild was removed because migration
   0037 already installs that exact constraint; no payment DDL is included here.
3. Merge the hardening change only after its checks pass. Use the existing
   production database workflow to back up the intended Neon target, apply
   exactly `0038_password_recovery_hardening`, verify the fingerprint, and run
   the required no-op rerun. No schema mutation occurs at application startup.
4. Replace all application instances with the same verified commit. Use a
   coordinated drain/replacement: older processes do not understand the new
   session payload or generation revocation contract. Do not leave a mixed
   version pool serving authentication.
5. Configure the signed webhook and verification key. These are provider
   activation steps; the code change does not configure SendGrid automatically.
6. Verify health, production org context and commit, then use an owned test
   account for the actual email journey. Verify both root and organization
   hosts, two links requested more than five minutes apart, repeated preview
   opens, successful reset, and rejection of a pre-reset session. Send no
   customer messages as part of automated tests.

Use `scripts/sql/password-recovery-health.sql` for a read-only, aggregate
24-hour snapshot. Monitor structured validation/consumption outcomes and job
failure codes. Alert on any abandoned lease or overdue job older than two
minutes, terminal delivery failures, and a sustained rise in bounce/dropped
or expired-link outcomes. Confirm the signed webhook produces delivery events
before interpreting a missing event as a delivery failure. Alert destinations
must be configured in the production monitoring provider during activation;
this change supplies the evidence and query, not an external alert subscription.

Keep migration 0038 in place during application recovery; do not restore the
old unique reset index while multiple links exist. Prefer a forward fix that
preserves generation checks and queue processing. Rolling back to an older
application requires draining all instances, invalidating all sessions, and
explicitly reconciling pending delivery jobs; an old binary alone cannot
preserve this revocation guarantee. Use the production backup restore procedure
only for a verified data incident with a reviewed restore target.

Implementation references: [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html),
[SendGrid signature verification](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features),
and [SendGrid event/custom-argument contract](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event).
