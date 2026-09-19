# Product

<!-- impeccable:product-schema 1 -->

<!--
Draft for review. This document records product context for UI and product
decisions; it is not a visual design specification. Items identified as
working drafts or open decisions should be confirmed before the redesign.
-->

## Platform
web

## Users

LeagueVault serves a single bowling business that operates multiple physical
locations and adult leagues.

- **System administrators** maintain platform and organization configuration
  and handle operational oversight.
- **Organization administrators** run the business's locations, leagues,
  seasons, teams, bowlers, users, communications, and integrations.
- **Payment managers** handle payment operations and reporting within their
  assigned organization and location.
- **Bowlers and ordinary users** register, establish an account, access the
  leagues connected to their bowler profile, make payments, view payment
  history, and manage their account profile.

The formal persona hierarchy, user research, and accessibility needs beyond
the repository's current requirements are open decisions for product review.

## Product Purpose

LeagueVault is a single-business, multi-location bowling league management
application for adult leagues. It gives the business one place to manage
locations, leagues and seasons, teams, bowlers, schedules, scores, standings,
registrations, payments, refunds, reporting, and administration.

It also gives bowlers a self-service path to register, safely connect an
account to the correct roster profile, view their league information, and pay
available balances without requiring staff to perform every account action.

The product should make the current league, roster, schedule, account, and
financial state clear and dependable. This success definition is a working
product assumption for review, not a measured KPI.

## Positioning

**Working positioning:** LeagueVault combines bowling-league operations for
the business with secure bowler self-service registration and payment in one
organization-scoped system.

The formal market position, competitive differentiators, pricing story,
approved claims, and proof points have not been established in repository
documentation and remain open decisions. The product must not invent
testimonials, customer counts, outcomes, or other marketing evidence.

## Operating Context

- The business manages adult bowling leagues across multiple physical
  locations. The deployed application currently has one configured business
  organization, with organization and location boundaries enforced in the
  application and database.
- Organization administrators perform detailed operational work on larger
  screens, while bowlers commonly encounter registration and payment flows on
  a phone during or around league night.
- Registration links may be shared through organization-specific URLs, QR
  codes, email invitations, and printed materials.
- Registration collects a full name, email address, and phone number. Current
  registration verifies phone ownership with a six-digit SMS code through
  Twilio Verify, then continues to account setup. Existing-account email
  cases follow account-recovery guidance instead of creating a duplicate
  account.
- A successful registration does not enroll a bowler in a league. After email
  ownership is established, a unique normalized exact-email match can link the
  account to an existing bowler profile. Missing, ambiguous, or duplicate
  matches remain pending for administrator resolution.
- The browser application is also packaged for iOS and Android with
  Capacitor. The native targets use the same web client and server-backed
  product model; they are not currently documented as separate platform
  experiences.
- The product integrates with external services including Square for
  payments, SendGrid for transactional email, Twilio Verify for registration
  SMS verification, Sentry for error monitoring, Render for hosting, and
  Neon PostgreSQL for production data storage.

The exact operating roles at each bowling location, support model, service
hours, and future native-specific behavior are open decisions.

## Capabilities and Constraints

### Core capabilities

- Manage the configured organization and its physical locations.
- Manage leagues, seasons, teams, bowlers, schedules, games, scores,
  standings, and operational reports.
- Support public bowler registration, password setup, login, password
  recovery, profile management, and account deletion requests.
- Link ordinary user accounts to bowler profiles using verified identity
  information and organization-scoped rules.
- Let administrators review pending or unlinked accounts, create or link
  profiles, send invitations, and resend account-ready messages when needed.
- Collect one-time and recurring/standing payments, support saved payment
  methods and supported wallet flows, process refunds, and expose payment
  history and past-due reporting.
- Support administrator messaging, email templates, integrations, and
  operational alerts.

### Product and technical constraints

- The server is authoritative for authentication, authorization, organization
  and resource access, payment amounts, refunds, and business rules. Client
  state must not be treated as proof of permission or financial truth.
- Organization and location context must remain explicit. A user must not see
  or act on another organization's resources through a client-supplied ID,
  hostname, or route parameter.
- Elevated roles are separate from ordinary bowler accounts. Current roles
  are `system_admin`, `org_admin`, `payment_manager`, and `user`.
- A bowler may not self-claim a profile by name alone. Email ownership and a
  unique exact normalized email match are required for automatic linking;
  administrators resolve ambiguous cases.
- Registration must not silently enroll a person in a league or expose
  another person's roster or payment information.
- Provider-backed actions must handle retries, idempotency, durable state,
  and provider failures without presenting an unconfirmed action as complete.
  A provider-accepted email or payment request is not the same as guaranteed
  inbox delivery or final settlement.
- Authentication and sensitive account actions require appropriate session,
  CSRF, rate-limit, verification, and audit protections. Sensitive data and
  secrets must not be exposed in browser code, logs, screenshots, or product
  copy.
- Every meaningful UI state must be designed and implemented: loading,
  empty, success, validation, error, unavailable-provider, and recovery
  states are part of the product experience.

## Brand Commitments

- The product name is **LeagueVault** and the canonical production domain is
  `leaguevault.app`.
- Organization context is part of the product identity. Public registration
  and other organization-facing surfaces may use the organization's name,
  logo, dark logo, and app icon where configured.
- Product copy must be clear about account status, verification, linking,
  payment status, and whether an action was accepted, completed, or needs
  administrator attention.
- No formal voice, personality, slogan, color system, typography system, or
  approved marketing language has been established here. Those decisions
  belong in the later design work and must not be inferred as product facts.

## Evidence on Hand

The following repository materials support this draft:

- [`README.md`](README.md) — product overview, architecture, integrations,
  deployment context, and local entry points.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — verified client/server
  boundaries, runtime responsibilities, and platform targets.
- [`docs/bowler-registration-guide.md`](docs/bowler-registration-guide.md) —
  organization registration, account linking, invitations, and pending-account
  behavior.
- [`client/src/App.tsx`](client/src/App.tsx) — current public, bowler,
  organization-admin, payment-manager, and system-admin route surfaces.
- [`shared/schema/`](shared/schema/) — organization, location, user-role,
  bowler, league, payment, and identity-link data contracts.
- [`server/services/`](server/services/) and [`server/routes/`](server/routes/)
  — current registration, authentication, payment, messaging, and provider
  workflows.
- [`capacitor.config.ts`](capacitor.config.ts) — current iOS and Android
  packaging configuration for the web client.
- [`AGENTS.md`](AGENTS.md) — durable security, accessibility, responsive UI,
  and implementation constraints.

There is currently no approved customer research summary, competitive brief,
testimonial set, case-study library, conversion baseline, or formal brand
guide in the repository.

## Product Principles

The following are **draft principles for review**:

1. **Operational truth over convenience.** Show the authoritative league,
   roster, schedule, and financial state, even when doing so requires an
   explicit recovery or review step.
2. **Secure identity before access.** Verify ownership and preserve clear
   account boundaries before linking profiles or exposing league and payment
   information.
3. **Self-service with safe escalation.** Let bowlers complete ordinary tasks
   themselves, while making ambiguous, failed, or exceptional cases easy for
   an administrator to resolve safely.
4. **Make recurring league work understandable.** Reduce the effort required
   to operate league nights, manage rosters and schedules, collect payments,
   and follow up on past-due or failed actions.
5. **Preserve organization and location context.** The product should always
   make it clear which business, location, league, and account a user is
   viewing or changing.

## Accessibility & Inclusion

- Support semantic HTML, accessible names and labels, keyboard interaction,
  visible focus, focus management, and meaningful status/error messaging.
- Support responsive layouts and touch-friendly interactions for bowlers using
  phones during league-night workflows, without removing essential information
  or functionality from larger screens.
- Do not rely on color alone to communicate account, payment, verification, or
  error state. Preserve readable contrast and clear text alternatives.
- Keep verification, registration, payment, and recovery flows understandable
  when delivery is delayed, a provider is unavailable, input is invalid, or an
  administrator must intervene.
- The formal WCAG conformance target, supported languages/locales, assistive
  technology test matrix, and additional accommodations are open decisions
  for product review.
