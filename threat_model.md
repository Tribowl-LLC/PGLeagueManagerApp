# Threat Model

## Project Overview

LeagueVault is a multi-tenant adult bowling league management application with an Express/Passport backend, React/Vite frontend, and PostgreSQL database accessed through Drizzle. It stores league rosters, bowler profiles, payment history, saved-card references, and organization-scoped operational data for league administrators and bowlers.

Production scope for this threat model excludes the mockup sandbox, local-only scripts, and test infrastructure unless production reachability is demonstrated. In production, `NODE_ENV=production`; TLS termination is handled by the platform.

## Assets

- **User accounts and sessions** - email addresses, password hashes, session cookies, invite/reset flows, and account-to-bowler links. Compromise allows impersonation and access to tenant data.
- **Bowler data** - names, emails, phone numbers, team/league membership, and related profile state. This is tenant-sensitive PII.
- **Payment state** - payment rows, provider payment IDs, saved-card references, provider customer IDs, autopay schedules, refunds, receipts, and payment-verification metadata. Raw PAN data is delegated to payment providers, but tokenized references still enable sensitive actions.
- **Tenant boundaries** - `organizationId`, subdomain routing, and organization-scoped admin capabilities. Loss of tenant isolation exposes one league operator's data to another.
- **Application secrets and third-party credentials** - database URL, session secret, webhook secrets, SendGrid/payment-provider credentials, and setup secret.

## Trust Boundaries

- **Browser/mobile client to API** - all request bodies, query params, and route paths are attacker-controlled. Client-side UI restrictions are not security boundaries.
- **Public routes to authenticated routes** - public surfaces such as `/api/auth/*`, `/api/bowler-link-respond/*`, `/api/setup/*`, `/api/payments-provider/webhooks/*`, and public organization redirects must not inherit privileges intended for signed-in users.
- **Authenticated user to org admin/system admin** - normal bowlers, organization admins, and system admins have materially different privileges. Role checks and row-level scoping must be enforced server-side per route.
- **Cross-tenant organization boundary** - organization-scoped data is keyed by `organizationId` and sometimes subdomain context. Matching organization membership alone is not sufficient for every sensitive bowler or payment action.
- **Server to database** - the API has broad write access to user, bowler, and payment tables. Authorization failures at the route layer can become direct database tampering.
- **Server to external services** - payment providers and SendGrid are trusted integrations reached with stored secrets. Webhooks and callback-style traffic must be authenticated and fail closed.

## Scan Anchors

- **Production entry points:** `server/index.ts`, `server/app.ts`, `server/routes/index.ts`
- **Highest-risk code areas:** `server/routes/auth.ts`, `server/utils/access-control.ts`, `server/routes/bowlers.ts`, `server/routes/user-bowlers.ts`, `server/routes/payments-provider/`, `server/routes/payment-schedules.ts`, `server/routes/public-embed-registration.ts`
- **Public surfaces:** `/api/auth/*`, `/api/bowler-link-respond/*`, `/api/setup/*`, `/api/payments-provider/webhooks/*`, `/api/organizations/public-*`, `/api/health`
- **Authenticated/admin surfaces:** `requireAuth` and `requireOrgAdmin` middleware, organization-scoped CRUD routes, and payment-provider admin/verification routes
- **Usually dev-only / out of scope:** test setup under `tests/`, local scripts under `scripts/` unless they are invoked by production runtime

## Threat Categories

### Spoofing

LeagueVault relies on session authentication plus route-level authorization, but several production flows allow identity claims to be made from attacker-controlled inputs. The system must require server-side proof before binding an account to a bowler and before accepting any tenant context supplied by the client. Public setup and webhook routes must continue to authenticate callers with shared secrets or signatures and fail closed when those proofs are absent.

### Tampering

This application exposes mutable business objects with real-world consequences: bowler profiles, autopay schedules, saved-card vault entries, refunds, and account links. Sensitive mutations must require stronger checks than simple same-organization visibility. Client-side workflow assumptions, hidden UI, or route naming are not sufficient controls; the server must verify that the acting user owns the target bowler or has the appropriate admin role.

### Information Disclosure

The main disclosure risk is broken tenant or bowler scoping. Bowler details, payment history, saved-card metadata, and payment-verification data must only be returned to users with a legitimate need to know. API responses should remain deny-by-default, and log output must continue to avoid secrets and high-value PII in production.

### Denial of Service

Public registration, login, password-reset, and webhook endpoints are exposed to untrusted internet traffic; payment and sync paths also depend on external providers. The system must keep rate limiting on abuse-prone public routes, reject malformed requests cheaply, and avoid expensive provider/database work before basic validation and authorization succeed.

### Elevation of Privilege

The highest-risk class in this codebase is broken access control: tenant self-enrollment, bowler-claim flows, and bowler/payment operations that trust broad organization membership or guessable numeric IDs. The application must enforce per-route, server-side authorization that distinguishes roster visibility from account ownership and from admin-only payment operations. Any endpoint that reads or mutates another bowler's financial or profile state must require explicit ownership or admin privilege scoped to the owning organization.
