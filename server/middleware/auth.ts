import { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/api.js";

/**
 * Middleware that rejects unauthenticated requests at the router level.
 * Apply to any router whose endpoints all require authentication.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
    return;
  }
  next();
}

// Task #455: server-side enforcement of the forced-rotation flag.
// The client-side ProtectedRoute / RootRedirectHandler guards are UX
// only — without this server-side gate, an authenticated user whose
// `mustChangePassword` row is true could still drive every protected
// endpoint via curl, fetch, or Postman with their session cookie.
// That defeats the entire impersonation-window mitigation, since the
// admin who reset the password necessarily knows the working
// credential until the user rotates it.
//
// Mounted as `app.use('/api', requirePasswordRotated)` right after
// the auth routes are registered (so /api/auth/* keeps responding
// without going through this gate) and BEFORE the broad protected
// routers, so the only authenticated paths a flagged user can hit
// are the ones in the small allowlist below:
//
//   * /api/auth/*           login, logout, user, set-password, forgot-
//                           password, change-email-confirm.
//                           These are the user's auth-management surface
//                           — they must remain reachable so the user can
//                           sign out, refetch their flag, or recover via
//                           the forgot-password flow if they don't
//                           remember the admin-set password.
//   * /api/user             Alias of /api/auth/user — needed so the
//                           client can refetch and observe the flag
//                           clear after a successful rotation.
//   * /api/logout           Alias of /api/auth/logout.
//   * /api/csrf-token       The CSRF token fetch — without it the user
//                           can't submit the change-password form.
//   * /api/account/change-password
//                           The rotation endpoint itself.
//
// Anything else (leagues, bowlers, payments, admin actions, etc.)
// returns 403 PASSWORD_CHANGE_REQUIRED until the flag is cleared.
const PASSWORD_CHANGE_REQUIRED_EXEMPT_PATHS = new Set<string>([
  '/api/csrf-token',
  '/api/user',
  '/api/logout',
  '/api/account/change-password',
]);

const PASSWORD_CHANGE_REQUIRED_EXEMPT_PREFIXES = [
  '/api/auth/',
];

export function requirePasswordRotated(req: Request, res: Response, next: NextFunction): void {
  // Anonymous traffic — the flag is a property of an authenticated
  // session, so let downstream handlers decide whether to challenge
  // for auth or serve the public route.
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    next();
    return;
  }
  // Happy path: vast majority of requests where the user has a normal
  // (not just-reset-by-admin) password. Keep this branch cheap.
  const user = req.user as { mustChangePassword?: boolean };
  if (user.mustChangePassword !== true) {
    next();
    return;
  }
  // Use `originalUrl` (with the query stripped) rather than `req.path`
  // because this middleware is mounted under `app.use('/api', ...)`
  // in server/routes/index.ts, which makes `req.path` RELATIVE to
  // that prefix (e.g. `/user` instead of `/api/user`). Building the
  // allowlist out of full `/api/...` paths keeps the rule readable
  // and makes the middleware robust if the mount point is ever
  // changed or duplicated.
  const path = (req.originalUrl || req.url).split('?')[0];
  if (PASSWORD_CHANGE_REQUIRED_EXEMPT_PATHS.has(path)) {
    next();
    return;
  }
  for (const prefix of PASSWORD_CHANGE_REQUIRED_EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) {
      next();
      return;
    }
  }
  // Distinct error code so the client can branch on it (e.g. force a
  // refetch of /api/user and bounce to /change-password-required).
  // Using 403 (not 401) because the user IS authenticated — they're
  // just not allowed to do anything else until they rotate.
  sendError(
    res,
    'You must change your password before continuing.',
    403,
    'PASSWORD_CHANGE_REQUIRED',
  );
}

/**
 * Middleware that requires org_admin or system_admin role.
 */
export function requireOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
    return;
  }
  const { role } = req.user;
  if (role !== "org_admin" && role !== "system_admin") {
    sendError(res, "Insufficient permissions", 403, "FORBIDDEN");
    return;
  }
  next();
}

/**
 * Middleware that requires system_admin role.
 */
export function requireSystemAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
    return;
  }
  if (req.user.role !== "system_admin") {
    sendError(res, "Insufficient permissions", 403, "FORBIDDEN");
    return;
  }
  next();
}
