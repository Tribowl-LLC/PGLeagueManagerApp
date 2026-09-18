import type { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/api.js";
import { hasActiveIdentitySecurityHold } from "../storage/profile-claim-notifications.js";

/**
 * Server-side enforcement for anonymous profile-claim reports. Destroying
 * sessions is the fast path, but this database-backed check remains
 * authoritative across replicas and catches a request racing the cleanup.
 */
export async function requireNoIdentitySecurityHold(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    next();
    return;
  }
  try {
    if (await hasActiveIdentitySecurityHold(req.user.id)) {
      sendError(
        res,
        "This account is temporarily restricted while a profile-security report is reviewed.",
        423,
        "IDENTITY_SECURITY_HOLD",
      );
      return;
    }
    next();
  } catch {
    // Fail closed: an unavailable hold lookup must not allow a potentially
    // disputed identity to mutate protected roster or credential state.
    sendError(res, "Account security status could not be verified", 503, "SECURITY_CHECK_UNAVAILABLE");
  }
}
