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
credential change or a newer request under the current resend policy.

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
variable. Resend-policy, durable delivery, and session-revocation changes must
follow their separately reviewed migration and rollout instructions.
