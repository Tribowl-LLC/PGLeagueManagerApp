# CSRF Coverage Audit

_Audit date: 2026-04-21 (task #297)._

## TL;DR

- **Global mount**: `app.use('/api', csrfProtection)` in `server/index.ts:107`
  covers every state-changing request to `/api/**` that is not in
  `EXEMPT_PATHS` (see `server/middleware/csrf.ts`).
- **Session cookie**: `sameSite: 'lax'` in production (see `server/auth.ts:62`).
  Defense-in-depth is in place — CSRF tokens are not the only barrier.
- **Routes mounted before the global mount**: only GET routes (manifest,
  static avatars, well-known files, `/api/csrf-token`). No state-changing
  route bypasses the global mount.
- **Routes mounted outside `/api`**: only GETs (well-known files, manifest,
  static avatars). None are state-changing.
- **Two routes target the previously-flagged paths**:
  - `PATCH /api/account/profile/:id` — covered by global mount.
  - `POST /api/account/change-password` — covered by global mount.
- **One gap fixed in this audit**: `POST /api/setup/first-system-admin/:id`
  (the disaster-recovery promote-existing-user endpoint) was unreachable
  via `curl` because it required a session-bound CSRF token but operators
  run it before any browser session exists. Added to `EXEMPT_PATHS` — the
  `x-setup-secret` header remains the auth factor, exactly like
  `/setup/create-first-admin` already was.

## How CSRF protection is wired

```
server/index.ts
  app.use(requestTracker)                 # GET-only / no body inspection
  app.use(subdomainDetection)             # tags req.org from hostname
  app.use(compression())                  # response compressor
  app.use(securityHeaders)                # global headers
  app.use(express.json(...))              # body parser
  app.use(express.urlencoded(...))        # body parser
  await setupAuth(app)                    # session + passport
  app.use(orgSessionGuard)                # tenant guard
  app.use(manifestRouter)                 # GET only
  app.use('/uploads/avatars', static)     # GET only
  app.get('/loaderio-...', ...)           # GET only
  app.get('/.well-known/...', ...)        # GET only (3 endpoints)
  app.use('/api', apiHeaders)             # API-only headers
  app.get('/api/csrf-token', ...)         # GET — emits the token
  app.use('/api', csrfProtection)         # ← THE GLOBAL MOUNT
  app.get('/api/health', ...)             # GET
  registerRoutes(app)                     # all /api/** routers
```

The global mount sits **before** `registerRoutes`. Every router registered
inside `registerRoutes(app)` is mounted under `/api` (verified by grep:
`server/routes/index.ts` only contains `app.use('/api/...', router)`
forms), so the global mount catches them all.

## EXEMPT_PATHS (`server/middleware/csrf.ts:14`)

| Path | Justification |
|------|---------------|
| `/auth/login` | Pre-auth. No session/CSRF token exists yet. CSRF would also be moot — the attacker would have to know the victim's password. Brute-force is mitigated by `loginLimiter`. |
| `/auth/register` | Pre-auth, public signup. Rate-limited via `registerLimiter`. |
| `/auth/set-password` | Auth factor is the single-use invite token from email, validated in handler. |
| `/auth/validate-invite` | Read-only invite check using a single-use token. |
| `/auth/forgot-password` | Pre-auth, public. Rate-limited via `forgotPasswordLimiter`. |
| `/health` | Public liveness probe; GET in practice. |
| `/csrf-token` | The token-issuance endpoint itself — bootstrap. |
| `/setup/create-first-admin` | Disaster recovery; auth factor is `x-setup-secret` header (out-of-band). Atomic advisory-lock guard inside `bootstrapFirstAdmin`. |
| `/setup/first-system-admin` | **Added in this audit.** Same disaster-recovery rationale as above — auth is `x-setup-secret`, called from `curl` before any session exists. |
| `/account/request-deletion` | Public deletion-request submission for users who lost access. Rate-limited via `deletionRequestLimiter`. |
| `/account/confirm-email-change` | Anonymous click on an emailed link; auth factor is the single-use, expiring token validated in handler. |

`isExemptPath` matches both the exact path and any `${exempt}/...` child
path (`server/middleware/csrf.ts:33`), so `/setup/first-system-admin/42`
correctly falls under the new entry.

## State-changing routes — verdict by router

All routers below are mounted under `/api/**` via `registerRoutes` and are
therefore covered by the global `csrfProtection` mount unless the path
appears in `EXEMPT_PATHS`.

| Mount | Covered by global? | Notes |
|-------|--------------------|-------|
| `app.post('/api/logout', ...)` (legacy alias) | Yes | Defined in `server/routes/index.ts`. |
| `/api/auth/*` | Yes | EXEMPT entries listed above. `POST /auth/logout` and `POST /auth/claim-bowler` additionally apply `csrfProtection` directly (defense-in-depth — harmless redundancy). |
| `/api/account/*` | Yes | Two EXEMPT entries (`request-deletion`, `confirm-email-change`); all other PATCH/POST/DELETE — including the audit-flagged `PATCH /profile/:id` and `POST /change-password` — go through the global mount. |
| `/api/setup/*` | Yes (with EXEMPT entries) | Both bootstrap endpoints are exempt; setup-secret header is the auth factor. |
| `/api/leagues`, `/api/teams`, `/api/bowlers`, `/api/payments`, `/api/scores`, `/api/games`, `/api/payments-provider`, `/api/admin`, `/api/organizations`, `/api/org-admin`, `/api/user-bowlers`, `/api/system-admin`, `/api/user`, `/api/locations`, `/api/payment-schedules`, `/api/bn`, `/api/integrations`, `/api/search` | Yes | All mounted under `/api`. None are in `EXEMPT_PATHS`. |

## Routes mounted outside `/api`

Verified by the CI guard `scripts/check-csrf-coverage.ts` (task #308,
extended in #338, #397, #445, #446, and #471, wired into CI in #398).
The guard walks `server/`, finds every state-changing route — direct
`app.<method>(...)` calls (including `.all()`), single-level
`app.use('<prefix>', router)` mounts, nested
`parentRouter.use('<sub>', childRouter)` composition followed
transitively, AND any `app.use('<prefix>', <inlineHandler>)` /
`router.use('<prefix>', <inlineHandler>)` mount where
`<inlineHandler>` is an arrow/function literal or an identifier that
does NOT resolve to a Router (i.e. a plain handler/middleware import
rather than a sub-router) — and exits non-zero if any effective path
falls outside `/api/` without an entry in
`EXPLICIT_NON_API_ALLOWLIST`. Add to that allowlist only with an
inline justification (e.g. an out-of-band auth factor like
`x-setup-secret`, or a handler that doesn't actually mutate state for
the methods CSRF protects).

The current allowlist entries are:

| Effective path | Why it's safe |
|----------------|---------------|
| `/uploads/avatars` | `app.use('/uploads/avatars', express.static(...))` in `server/index.ts`. `express.static` is read-only — it only responds to GET/HEAD and falls through for POST/PUT/PATCH/DELETE, so no CSRF-protectable mutation is possible. |
| `/{*splat}` | `app.use("/{*splat}", ...)` SPA catchalls in `server/vite.ts` (dev-mode Vite middleware and prod static fallback). Both handlers respond with HTML for unknown paths and don't mutate any server state. The named braced wildcard is required by Express 5 and preserves the previous catch-all behavior. |

The guard runs as a standalone step in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) on every
pull request to `main` and every push to `main`. A failing run fails
the workflow alongside the existing type-check and lint steps. The
guard's own behavior is additionally pinned by 36 unit fixtures in
`tests/unit/check-csrf-coverage.test.ts` (part of the `npm test`
vitest suite). Locally, run `npm run check:csrf` to invoke the guard
directly — it returns in well under a second on the current tree.

### CI / branch protection (operational requirement)

The workflow above only **blocks merges** if GitHub's branch
protection on `main` requires the relevant status check to pass
before a pull request can be merged. That setting lives in GitHub
repo settings → Branches → branch protection rules, not in this
repo. If branch protection isn't configured (or isn't configured to
require these statuses), the workflow will still run and report red
on a failing PR, but the merge button will not be gated.

Two `ci.yml` jobs need to be wired as required checks to fully pin
this guard:

- **`Type check & lint`** — runs `npm run check:csrf` against the
  live `server/` tree, so a state-changing route mounted outside
  `/api` without an allowlist entry fails the build at PR time.
- **`Tests`** — runs `npm test` (vitest), which executes the 36
  fixtures in `tests/unit/check-csrf-coverage.test.ts` that pin the
  guard's own parser / propagation logic. Without this check
  required, a contributor could change `scripts/check-csrf-coverage.ts`
  in a way that breaks the regex parsing or the propagation logic
  but happens not to flag anything in the current tree, and the
  regression would not be caught — `Type check & lint` would still
  report green because the guard runs against the (unflagged) live
  codebase. The `Tests` job (added in #442, kept required by #447)
  is what gives those self-tests teeth on PRs.

When extending CI with additional static checks, **append a step to
the existing `check-and-lint` job** rather than renaming the job or
splitting into a new job. The job's GitHub-Actions display name
(`Type check & lint`) is what branch protection keys on; renaming it
silently de-protects `main` until an operator updates the rule. The
same applies to `Tests` — append a vitest file rather than renaming
the job. The in-file comment in `ci.yml` repeats this for future
contributors.

The non-`/api` mounts are:

- `manifestRouter` — only `GET /manifest.json` (and `GET /api/org-context`,
  which is under `/api` and read-only).
- `/uploads/avatars` — `express.static`, GET only.
- `/.well-known/*` — three GET endpoints (Apple App Site Association,
  Android assetlinks, Apple Pay merchant-id verification).
- `/loaderio-...` — load-test verification GET.

## Session cookie posture (`server/auth.ts:60-66`)

```ts
cookie: {
  secure: !isDev || !!env.REPLIT_DEPLOYMENT || !!env.REPLIT_DOMAINS,
  sameSite: (isDev && !!env.REPLIT_DOMAINS) ? "none" : "lax",
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  ...(isProduction ? { domain: `.${env.APP_DOMAIN}` } : {}),
},
```

- Production / deployment: `sameSite: 'lax'` and `secure: true`. CSRF tokens
  are a defense-in-depth layer, not the only barrier. Cross-site POSTs from
  a third-party origin will not carry the session cookie.
- Local dev with no Replit preview: `sameSite: 'lax'`, `secure: false`.
- The Replit-iframe dev case (`isDev && REPLIT_DOMAINS`) is the only place
  we drop to `sameSite: 'none'`, and only because the workspace previews
  the app in an iframe under a different parent origin. This is dev-only.

## Single gap, fixed in this task

| Path | Method | Verdict | Action |
|------|--------|---------|--------|
| `/api/setup/first-system-admin/:id` | POST | Operationally broken (not exploitable; just unreachable for the curl flow) | Added `/setup/first-system-admin` to `EXEMPT_PATHS`; auth remains `x-setup-secret` header. Regression test in `tests/api/csrf-coverage.test.ts`. |

## Logging contract

`server/middleware/csrf.ts` emits warn-level log lines on every reject
branch (no session, missing session token, header missing or mismatched).
Those log lines **must not** interpolate any of the following — at any
log level, including `debug`:

- The session-bound CSRF token (`req.session.csrfToken`)
- The header CSRF token (`req.headers['x-csrf-token']`)
- The session ID (`req.session.id`)
- Any prefix of those values long enough to be useful (treat 8+
  contiguous bytes as a leak)

Why this matters: an operator who turns on `LOG_LEVEL=debug` to
investigate an incident must not end up shipping live, replayable CSRF
tokens to the production log sink, where any operator with log access
could reuse them until the session expires. This is a defense-in-depth
contract on top of the `httpOnly`/`sameSite=lax` cookie posture
documented above — the tokens are session-bound and short-lived, but
that is no excuse to log them.

The current warn-line shape is:

```
CSRF token mismatch for ${req.method} ${req.path}
```

(plus the analogous `Missing session CSRF token for ...` and
`No session available for ...` variants.) Only the request method and
path are interpolated. The path is logged verbatim — if a caller puts
token-shaped bytes into the URL itself, that's the caller's choice and
not a middleware leak.

**Regression guard:** `tests/unit/csrf-no-token-leak.test.ts` mocks the
logger, drives every reject branch with known token bytes, and asserts
that no captured log line contains the session token, header token,
session ID, or an 8-byte prefix of either. The exact warn-line shape
shown above is also pinned by that test — any change to the warn-line
format requires updating the assertion. If you need to add a new log
line in `server/middleware/csrf.ts`, extend the test with the new
branch first; do not weaken the existing assertions.

The same contract is applied to every other auth surface that handles
secret material (login passwords, invite / reset / email-change
tokens, the `x-setup-secret` header). The full audit table — with the
shared assertion helper and one regression test per surface — lives in
[`no-secrets-in-logs.md`](./no-secrets-in-logs.md).

## Regression tests

`tests/api/csrf-coverage.test.ts` pins:

- `PATCH /api/account/profile/:id` returns 403 + `CSRF_ERROR` when the
  CSRF header is missing, and a non-403 (validation/auth) response when
  the token is included.
- `POST /api/account/change-password` returns 403 + `CSRF_ERROR` when the
  CSRF header is missing, and a non-403 response when the token is
  included.
- `POST /api/setup/first-system-admin/:id` does NOT return `CSRF_ERROR`
  when called without a CSRF header — proving the EXEMPT entry is in
  effect. (The endpoint still rejects the call for other reasons —
  missing setup secret, an admin already exists, etc. — so we only
  assert the absence of `CSRF_ERROR`.)
