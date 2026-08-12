# Engineering Context

This document records durable product and architecture decisions that are
useful during code changes. It is intentionally separate from release
procedures and historical review reports.

## Product Boundary

LeagueVault currently serves adult bowling leagues. Youth, minor, and guardian
league workflows were retired and should not be reintroduced as incidental
"generalization" work.

The application is multi-tenant. An organization owns locations, leagues,
teams, bowlers, payments, registrations, integrations, and related audit data.
Requests must prove that the acting user and every referenced resource belong
to the same organization unless a documented system-admin operation explicitly
allows otherwise.

## Frontend And Backend

- React and Vite provide the web client.
- TanStack Query owns server-state fetching and cache management.
- Wouter provides client routing.
- Express provides the HTTP API and serves the built client.
- Drizzle ORM and the `pg` driver access Neon PostgreSQL.
- Zod is used for environment and request validation.
- Square is the only supported payment-provider integration.

The frontend and backend deliberately contain some imperative effects for
browser APIs, payment SDK lifecycles, and state reconciliation. React Doctor
warnings are not automatically defects. Prefer focused fixes that improve
correctness or simplify a real workflow, especially around payment behavior.

## Security Boundaries

- Authentication uses server-side sessions and secure production cookies.
- CSRF coverage is enforced for state-changing API routes.
- Organization isolation coverage protects id-bearing read endpoints.
- Wire sanitization prevents raw sensitive database objects from reaching the
  client.
- Passwords and payment credentials must not appear in logs.
- Trust-proxy configuration affects IP-based rate limiting and is checked at
  boot and by the scheduled post-deploy probe.

Existing security contracts and their tests are documented under
`docs/security/`. Read the relevant contract before changing an auth, payment,
webhook, or tenant-access path.

## Data Lifecycle

Permanent organization teardown is system-admin-only and atomic. The database
transaction removes app-owned tenant records and organization-specific audit
records, while preserving platform system-admin accounts and detaching them
from the deleted organization. Remote Square customer records are
not removed by this operation.

New season creation carries forward the selected league structure while
allowing the new season schedule to be explicitly configured. Season dates,
weeks, weekday, skip dates, cancelled dates, and double-pay dates are
season-specific; they must not be copied implicitly when the product behavior
requires a new selection.

`leagues.payment_mode` is the authoritative collection-timing setting and is
limited to `weekly` or `upfront`. League creation and season rollover require
an explicit choice; historical payments must not be used to guess it. Both
modes retain per-session bowling obligations: prepaid means the season was
collected in advance, not that the sessions are nonbillable. Once canonical
schedule evidence exists, ordinary league editing cannot change this setting or
any other canonical schedule input. No-op submissions are allowed, while name,
description, public-signup visibility, unchanged Square catalog selections, and
double-pay collection evidence remain outside the canonical schedule lock.

Fall canonical schedule generation has one server-authoritative billing ordinal
policy: `dense_billable`. New weekly and upfront Fall drafts both number only
actual billable bowling sessions, so cancelled sessions have null billing data
and later draft ordinals close the gap. Clients do not select or submit this
policy. C1 request and input-snapshot versions must be advanced when this input
contract changes, and strict validation must reject retired policy fields.
Historical versioned C1 evidence is immutable: stored `planned_slot` semantics
remain readable and govern C2 cancellation/restoration where supported. They must
never be rewritten or silently treated as dense billable. Draft dense ordinals
may be renumbered after cancellation; published billing ordinals never are.

New active Fall league creation and season rollover generate the complete C1
draft set inside the same transaction as authoritative legacy setup. The
separate `league-setup-integration-request/1` entry-point contract does not bump
persisted C1/C2 versions. Existing eligible Fall leagues without canonical state
continue to use the explicit standalone preview/apply workflow. Season rollover
locks and re-reads the source, copies teams and the complete ordered roster,
generates the successor drafts, and archives the source in one commit; external
bowler synchronization is post-commit only.

Phase D1 keeps every legacy game and payment consumer authoritative while
event-driven writes attach nullable canonical compatibility evidence. Games
link physical occurrences, schedule cursors shadow exact future starts, and a
scheduled operation records only its trigger occurrence—not paid obligations.
Exact matching is tenant/league scoped and DST-safe; mismatches remain null and
are never guessed from proximity, amount, or roster membership. Linked games
and scheduled operations are effective-lock evidence, while a schedule cursor
alone is not. See `docs/phase-d1-canonical-occurrence-compatibility.md`.

Required weekly payer count and substitute-payer assignment are separate from
payment timing. A future money-consumer cutover must model the league's three-
or four-bowler team requirement and the actual bowlers responsible for each
occurrence; it must not infer payer responsibility merely from roster membership
or `payment_mode`.

Phase D2 models occurrence eligibility, occurrence team assignment, bowler
obligation, collection timing, operation intent, and payment settlement as
separate tenant-scoped evidence. Obligation amount/currency and billing-term
identity are immutable after creation. Weekly and upfront modes both retain
per-occurrence debts; upfront only moves collection earlier. Double-pay is one
plan over two real obligations, never a synthetic occurrence. Payment
settlement is many-to-many through explicit positive allocations protected by
the league advisory lock and database conservation triggers. Ready/fulfilled
plans collectively cannot over-plan an obligation; draft alternatives do not
reserve it. Existing payment
execution snapshot versions remain unchanged; the dormant `lvpayocc:v1`
supplement must match the operation type's execution-snapshot league and adds
obligation/occurrence allocation semantics without changing provider identity
or the interactive bowler-uniqueness contract. See
`docs/phase-d2-occurrence-financial-foundation.md`.

## Native And Handoff Targets

Capacitor, `ios/`, and `android/` are intentional native targets. They may look
unused from the web entrypoint but are maintained for the mobile application.

Replit is not production hosting. Replit-specific beta and handoff information
is kept in `docs/replit-handoff.md` so it does not redefine the Render release
workflow.

## Durable Documentation Map

- `AGENTS.md`: concise rules Codex and contributors should apply to every task.
- `docs/production-runbook.md`: Render, Neon, schema, and post-deploy steps.
- `docs/ci.md`: workflows, status checks, action pinning, and CI secrets.
- `docs/TEST_INFRA.md`: test database and worker isolation details.
- `docs/replit-handoff.md`: historical Replit beta and Chris handoff material.
- `CONTRIBUTING.md`: ESLint suppression-baseline rules.
