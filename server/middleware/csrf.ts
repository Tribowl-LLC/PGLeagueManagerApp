import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { createLogger } from '../logger';
import { safeTokenCompare } from '../lib/password';

const log = createLogger("CSRF");

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
  }
}

const EXEMPT_PATHS = [
  '/auth/login',
  '/auth/register',
  '/auth/set-password',
  '/auth/validate-invite',
  '/auth/forgot-password',
  '/health',
  '/csrf-token',
  '/setup/create-first-admin',
  // Disaster-recovery promote-to-admin endpoint. Authenticated by the
  // `x-setup-secret` header, not a session-bound CSRF token — operators run
  // this from `curl` against a fresh DB before any browser session exists.
  // See `docs/security/csrf-coverage.md` and AGENTS.md for operational rules.
  '/setup/first-system-admin',
  '/account/request-deletion',
  // Confirmation link in the email is the auth factor (like password
  // reset). Anonymous clicks must succeed without a session-bound CSRF
  // token. The handler validates a single-use, expiring token from the
  // request body before mutating any state.
  '/account/confirm-email-change',
  // Test-only endpoint mounted under /account/_test/ when NODE_ENV !== 'production'
  // (resets the confirm-email-change rate-limit bucket so route-level tests
  // can exercise the post-window-reset path without 10 minutes of waiting).
  // Production never mounts the route, so the exemption is inert there.
  '/account/_test',
  // Task #681: public, no-auth embed registration submit. The endpoint
  // originates from third-party parent pages that have no session-bound
  // CSRF token; abuse is bounded by the per-IP rate limiter wired in
  // server/routes/public-embed-registration.ts.
  '/public/embed',
];

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isExemptPath(path: string): boolean {
  return EXEMPT_PATHS.some(exempt => path === exempt || path.startsWith(exempt + '/'));
}

function getOrCreateToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

export function csrfTokenEndpoint(req: Request, res: Response) {
  const token = getOrCreateToken(req);
  res.json({ success: true, data: { token } });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    return next();
  }

  if (isExemptPath(req.path)) {
    return next();
  }

  if (!req.session) {
    log.warn(`No session available for ${req.method} ${req.path} — rejecting`);
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_ERROR',
        message: 'Session required. Please refresh the page and try again.',
      },
    });
  }

  const sessionToken = req.session.csrfToken;
  if (!sessionToken) {
    log.warn(`Missing session CSRF token for ${req.method} ${req.path}`);
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_ERROR',
        message: 'CSRF validation failed. Please refresh the page and try again.',
      },
    });
  }

  const headerToken = req.headers['x-csrf-token'] as string | undefined;
  if (!headerToken || !safeTokenCompare(headerToken, sessionToken)) {
    log.warn(`CSRF token mismatch for ${req.method} ${req.path}`);
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_ERROR',
        message: 'CSRF validation failed. Please refresh the page and try again.',
      },
    });
  }

  next();
}
