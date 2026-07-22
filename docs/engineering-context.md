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
