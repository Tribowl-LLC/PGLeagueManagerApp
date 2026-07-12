# Replit Handoff (Historical)

This runbook describes how to set up and operate a **beta** environment
when a separate Replit copy of LeagueVault is used. It is retained for the
Replit handoff and is not the production deployment process.

Production is hosted on Render and uses Neon PostgreSQL. Do not use this
document to deploy or operate `leaguevault.app`.

Beta exists so a Replit copy can test pre-release changes against a realistic
deploy (Replit Reserved-VM, real domain, real CDN, real Vite build) without
risking production data or charging real cards.

## TL;DR

| | dev | beta | prod |
| --- | --- | --- | --- |
| Repl | local workspace | forked Repl | not applicable; production is Render |
| Domain | Replit dev URL | `beta.leaguevault.app` | `leaguevault.app` |
| Branch | `main` | `beta` | `main` on GitHub |
| Database | dev DB (separate) | beta DB (separate, empty) | prod DB |
| Payment creds | as configured | **sandbox only** | live |
| `APP_ENV` | unset (defaults to `dev`) | **`beta`** (must be set) | **`prod`** on Render |
| BETA banner | hidden | **visible** | hidden |

## How environment is detected

`APP_ENV` is the canonical signal — see `shared/app-env.ts` for the
typed enum and `server/config.ts` for the validation.

Resolution rules (single source of truth in `resolveAppEnv`):

1. If `APP_ENV` is set explicitly to `dev`, `beta`, or `prod`, that wins.
2. Otherwise: `prod` when `REPLIT_DEPLOYMENT` is non-empty, else `dev`.

`beta` is **never** a default. The beta Repl MUST set `APP_ENV=beta`
in Secrets — otherwise it would boot as `prod` and the BETA banner /
sandbox-creds guard would silently disable themselves.

## One-time beta setup

### 1. Fork the production Repl

In the Replit workspace, fork the live LeagueVault Repl. The fork
inherits the codebase but **not** the secrets — that's intentional.

### 2. Point the fork at the `beta` Git branch

The beta Repl tracks the `beta` branch. Configure the Git pane in
the forked Repl to use `beta` as the default branch. Day-to-day Replit
promotion is historical. The current production branch and Render workflow
are documented in `AGENTS.md` and `docs/production-runbook.md`.

### 3. Provision a separate empty database

Beta starts with an **empty** database — no production data is
copied over. Provision a fresh Replit-managed Postgres for the beta
Repl and set its `DATABASE_URL` in Secrets. Run `npm run db:push`
once to apply the schema.

### 4. Configure beta secrets (sandbox only)

Set the following in the beta Repl's Secrets pane. **Never paste a
production credential into the beta Repl** — the server refuses to
start when `APP_ENV=beta` and any of the live-credential heuristics
match (see `server/utils/live-credential-check.ts`).

#### Required

| Secret | Value | Notes |
| --- | --- | --- |
| `APP_ENV` | `beta` | Locks in the beta envelope. |
| `DATABASE_URL` | (auto-set by Replit DB) | Must point at the beta DB, not prod. |
| `SESSION_SECRET` | `openssl rand -base64 48` | Generate fresh — do **not** reuse prod. |
| `FIELD_ENCRYPTION_KEY` | `openssl rand -hex 32` | Generate fresh — do **not** reuse prod. With a fresh value, any encrypted Clover credentials seeded into beta must be re-entered. |
| `APP_DOMAIN` | `leaguevault.app` | Stays the same — the parent domain controls subdomain matching. |

#### Square (sandbox)

Use Square's **sandbox** application from the [Square Developer Dashboard](https://developer.squareup.com/apps).

| Secret | Source |
| --- | --- |
| `SQUARE_ACCESS_TOKEN` | Sandbox Access Token |
| `SQUARE_APP_ID` | Sandbox Application ID |
| `SQUARE_LOCATION_ID` | Sandbox Location ID |
| `VITE_SQUARE_APP_ID` | Same as `SQUARE_APP_ID` |
| `VITE_SQUARE_LOCATION_ID` | Same as `SQUARE_LOCATION_ID` |

**Do NOT set** `SQUARE_PROD_TOKEN`, `SQUARE_PRODUCTION_ACCESS_TOKEN`,
`SQUARE_PRODUCTION_APP_ID`, or `SQUARE_PRODUCTION_LOCATION_ID` on
beta. Their presence is one of the things the boot guard catches.

**Also do not paste production Square credentials into the un-prefixed
sandbox slots** (`SQUARE_ACCESS_TOKEN`, `SQUARE_APP_ID`,
`VITE_SQUARE_APP_ID`). The boot guard inspects the *values* in those
slots and refuses to start when:

- The App ID starts with `sq0idp-` (Square's production prefix).
  Sandbox App IDs are prefixed `sandbox-sq0idp-`.
- The access token starts with `EAAAEv` or `EAAAl7` (Square's
  production token prefixes per
  `server/services/square-provider.ts`). Sandbox tokens have a
  different shape.

If the boot guard fires, the error log lists each offending env var
and the matched heuristic.

#### Clover (per-tenant, in DB)

Clover credentials are encrypted in the database, not env vars. After
the beta DB is provisioned and a test organization is seeded, use the
in-app Integrations page to enter **Clover sandbox** credentials for
each test tenant. (Clover sandbox is at `https://sandbox.dev.clover.com`.)

#### Optional / disabled by default on beta

| Secret | Recommendation |
| --- | --- |
| `SENDGRID_API_KEY` | Use a SendGrid sandbox key, or omit to disable email entirely. |
| `BN_API_KEY` | Use a BowlNow staging key, or omit to disable CRM sync. |
| `SENTRY_DSN` | Either point at a separate "leaguevault-beta" Sentry project, or omit. |
| `SETUP_SECRET` | Generate a fresh strong value if needed for bootstrap. |
| `BLOCK_EMAIL_DOMAINS` | Set to `vitest.local,example.com` if you want extra bounce protection. |

### 5. Configure the `beta.leaguevault.app` custom domain

In the beta Repl's Deployments → Custom Domains panel, attach
`beta.leaguevault.app`. In the DNS provider for `leaguevault.app`,
add the records Replit prompts for:

- `CNAME beta` → the value Replit shows (typically `<repl-id>.replit.app` or
  the Replit edge hostname).
- (If Replit prompts) a TXT verification record under `_replit-challenge.beta`.

Wait for SSL provisioning (typically a few minutes). Confirm by
hitting `https://beta.leaguevault.app/api/health` — the response
should include `"appEnv":"beta"` and a short commit SHA.

### 6. Configure sandbox webhooks

Square sandbox webhooks must be aimed at the beta domain, not prod.
In the Square Developer Dashboard → your sandbox app → Webhooks:

- Notification URL: `https://beta.leaguevault.app/api/webhooks/square`
  (or whichever path you use for Square webhooks today).
- Subscribe to the same event topics as production.

For Clover sandbox webhooks, configure them per-tenant inside the
LeagueVault Integrations UI as you would in prod, but with the beta
domain as the callback URL.

### 7. Seed test data

Beta starts empty. Seed enough data to exercise the flows you want
to test:

```bash
# In the beta Repl shell
npx tsx scripts/seed.ts all
```

This creates the standard test users (admin, org admin, bowler) with
predictable credentials — see `scripts/seed.ts` for the actual values.
Then sign in as the system admin and create at least one test
organization with one test league so payment / scheduling flows can
be exercised.

### 8. Verify

After deploy:

1. Visit `https://beta.leaguevault.app/login`. The yellow **BETA
   ENVIRONMENT** banner must be pinned to the top of every page,
   including the commit short SHA on the right (hidden on `<sm`).
2. Hit `/api/health` — confirm `"appEnv":"beta"` and a non-`"unknown"`
   commit value.
3. Tail the deploy logs and confirm the boot line:
   `[INFO] [Server] Runtime envelope {"appEnv":"beta","commit":"…","squareCreds":"sandbox/fallback",…}`
4. Run an end-to-end payment with a Square sandbox test card (e.g.
   `4111 1111 1111 1111`, any future expiry). Confirm the charge
   appears in the Square sandbox dashboard, **not** the live one.

## Day-to-day operations

### Adding a new secret to prod

If a code change pulled into beta requires a new secret, mirror it
from prod with the **sandbox / test** equivalent. Never re-use the
prod value. The post-pull script reminds you of this when run with
`APP_ENV=beta` (see `scripts/post-pull.sh`).

### Deploying a change to beta

The beta Repl follows the same `git pull` → `bash scripts/post-pull.sh`
→ Replit "Deploy" flow as any other Replit deploy. The old promotion
direction (`main` → `beta` for testing, then back into `main`) is historical
and is not used for Render production releases.

### Resetting beta data

Beta data is disposable. To reset, drop the beta database in the
Replit Database pane and re-run `npm run db:push` followed by
`npx tsx scripts/seed.ts all`.

### Suspecting a creds leak

If the boot guard fires (`Refusing to start: APP_ENV=beta but live
payment credentials are present in environment`), do **not**
override the check. Find and remove the offending Secret in the
beta Repl, then re-deploy. The error log lists each offending
variable name.

## Replit Canvas Mockup Sandbox

The former `artifacts/mockup-sandbox` directory was isolated Replit Canvas
preview tooling. It rendered individual components for design exploration and
was never part of the production runtime or threat model.

It is intentionally absent from the production LeagueVault `main` branch. It
may remain in Chris's separate Replit handoff repository so Canvas previews
continue to work there. Do not add its dependencies or workflows to the Render
production release process.
