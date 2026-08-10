import type { Express, Request, Response, NextFunction } from "express";
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { sendError } from "../utils/api.js";
import leaguesRouter from './leagues.js';
import fallDraftGenerationRouter from './fall-draft-generation.js';
import teamsRouter from './teams.js';
import bowlersRouter from './bowlers.js';
import paymentsRouter from './payments/index.js';
import bowlerLeaguesRouter from './bowler-leagues.js';
import scoresRouter from './scores.js';
import gamesRouter from './games.js';
import paymentRoutesRouter from './payments-provider/index.js';
import adminRouter from './admin.js';
import organizationsRouter from './organizations.js';
import organizationsPublicRouter from './organizations-public.js';
import orgAdminRouter from './organization-admin.js';
import userBowlersRouter from './user-bowlers.js';
import setupAdminRouter from './setup-admin.js';
import systemAdminRouter from './system-admin.js';
import userAvatarRouter from './user-avatar.js';
import locationsRouter from './locations.js';
import paymentSchedulesRouter from './payment-schedules.js';
import accountRouter from './account.js';
import { registerAuthRoutes } from './auth.js';
import searchRouter from './search.js';
import bowlerLinksRouter from './bowler-links.js';
import bowlerLinkRespondRouter from './bowler-link-respond.js';
import paymentDisputesRouter from './payment-disputes.js';
import { requireAuth, requireOrgAdmin, requireSystemAdmin, requirePasswordRotated } from '../middleware/auth.js';
import { createLogger } from '../logger';

const log = createLogger("Routes");

// Mount-layer auth wrapper for `/api/system-admin/*`. Behaves
// identically to `requireSystemAdmin` for every path EXCEPT the
// post-deploy probe endpoint `/trust-proxy-status`, which also
// accepts an `X-Probe-Token` bearer header that matches the
// `TRUST_PROXY_PROBE_TOKEN` env var on the server.
//
// We intercept at the mount layer (rather than as a per-route
// middleware in `system-admin.ts`) because per-route middleware on
// a router is unreachable when the mount-level auth check rejects
// first — `requireSystemAdmin` would 401 the token-only caller
// before the router was ever entered.
//
// Why a token at all (task #379 follow-up): the original probe
// authenticated by pasting a system_admin session cookie into a
// repo secret, which broke every ~24h when the session expired
// (`cookie.maxAge` in `server/auth.ts`). A long-lived shared secret
// avoids the rotation pain. The token is treated as a system_admin
// credential — it must be deployed only into trusted secret stores.
//
// Constraints enforced here, mirrored by
// `scripts/verify-trust-proxy-deploy.ts`:
//   - server-side token must be >=32 chars (a short / empty / typo
//     value cannot accidentally make the endpoint trivially callable)
//   - constant-time compare via `timingSafeEqual` (length-checked
//     first because the function throws on length mismatch)
//   - if a token IS presented but does not match, we reject with
//     `INVALID_PROBE_TOKEN` instead of falling through to session
//     auth — falling through would let an attacker probe for valid
//     tokens with a stolen admin cookie and never see a failure
//     signal
function trustProxyProbeAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/trust-proxy-status') {
    const expected = process.env.TRUST_PROXY_PROBE_TOKEN?.trim();
    const presentedRaw = req.headers['x-probe-token'];
    const presented = typeof presentedRaw === 'string' ? presentedRaw : null;
    if (expected && expected.length >= 32 && presented) {
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(presented, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return next();
      }
      sendError(res, 'Invalid probe token', 401, 'INVALID_PROBE_TOKEN');
      return;
    }
  }
  return requireSystemAdmin(req, res, next);
}

export function registerRoutes(app: Express): void {
  log.info('Registering API routes...');

  // The SPA still calls these two auth endpoints without the `/auth` segment.
  // Register the aliases before the canonical auth mount so `next()` continues
  // into `/api/auth/*` after rewriting the URL. This keeps the dispatch on
  // Express's normal middleware chain and avoids relying on private router
  // internals that changed in Express 5.
  app.get('/api/user', (req, res, next) => {
    req.url = '/api/auth/user';
    next();
  });

  app.post('/api/logout', (req, res, next) => {
    req.url = '/api/auth/logout';
    next();
  });

  // Auth endpoints (/api/auth/*) are mounted before the broader /api/*
  // middleware below.
  registerAuthRoutes(app);

  app.use('/api/organizations', organizationsPublicRouter);
  // Task #704: one-click accept/decline for bowler-payment-link invites.
  // Mounted BEFORE requirePasswordRotated/requireAuth because the link
  // recipient may not be logged in (or may be logged in as a different
  // user). Auth comes from the HMAC-signed token in the query string,
  // verified inside the router. GET-only, so no CSRF token is needed.
  app.use('/api/bowler-link-respond', bowlerLinkRespondRouter);

  // Task #455: server-side enforcement of the must-change-password
  // gate. Mounted here so the auth routes registered above (and the
  // /api/user / /api/logout aliases) remain reachable for a flagged
  // user — they need to sign out, refetch their flag, and POST
  // /api/account/change-password — but every other protected
  // /api/* endpoint returns 403 PASSWORD_CHANGE_REQUIRED until the
  // flag is cleared. See the middleware doc for the full allowlist
  // and the security rationale.
  app.use('/api', requirePasswordRotated);

  app.use('/api/leagues', requireAuth, fallDraftGenerationRouter);
  app.use('/api/leagues', requireAuth, leaguesRouter);
  app.use('/api/teams', requireAuth, teamsRouter);
  app.use('/api/bowlers', requireAuth, bowlersRouter);
  app.use('/api/bowler-leagues', requireAuth, bowlerLeaguesRouter);
  app.use('/api/payments', requireAuth, paymentsRouter);
  app.use('/api/scores', requireAuth, scoresRouter);
  app.use('/api/games', requireAuth, gamesRouter);
  // The disabled-by-default Square receiver is registered earlier in
  // `server/app.ts` so it never enters tenant resolution or global JSON parsing.
  app.use('/api/payments-provider', requireAuth, paymentRoutesRouter);
  app.use('/api/admin', requireOrgAdmin, adminRouter);
  app.use('/api/organizations', requireAuth, organizationsRouter);
  app.use('/api/org-admin', requireOrgAdmin, orgAdminRouter);
  app.use('/api/user-bowlers', requireAuth, userBowlersRouter);
  app.use('/api/setup', setupAdminRouter); // setup routes have their own secret-based auth
  app.use('/api/system-admin', trustProxyProbeAuth, systemAdminRouter);
  app.use('/api/user', requireAuth, userAvatarRouter);
  app.use('/api/locations', requireAuth, locationsRouter);
  app.use('/api/payment-schedules', requireAuth, paymentSchedulesRouter);
  app.use('/api/payment-disputes', requireOrgAdmin, paymentDisputesRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/search', requireAuth, searchRouter);
  app.use('/api/bowler-links', requireAuth, bowlerLinksRouter);
  log.info('API routes registered');
}
