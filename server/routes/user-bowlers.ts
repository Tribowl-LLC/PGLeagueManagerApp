import { Router, Request, Response, NextFunction } from 'express';
import { storage } from '../storage';
import { sendSuccess, sendError, sanitizeBowler } from '../utils/api';
import { User as SelectUser } from '@shared/schema';
import { hasAccessToBowler } from '../utils/access-control.js';
import {
  IdentityLinkError,
  unlinkUserFromBowler,
} from '../services/identity-link.js';

const router = Router();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  }
  const user = req.user as SelectUser | undefined;
  if (!user) {
    return sendError(res, 'Invalid session', 401, 'INVALID_SESSION');
  }
  next();
}

function handleIdentityLinkError(res: Response, error: unknown): boolean {
  if (!(error instanceof IdentityLinkError)) return false;
  // Preserve this route's long-standing 400/ALREADY_LINKED contract if the
  // identity service reports that conflict. Other callers keep the stricter
  // service status.
  const status = error.code === 'ALREADY_LINKED' ? 400 : error.status;
  sendError(res, error.message, status, error.code);
  return true;
}

// Get the bowler associated with the authenticated user
router.get('/bowler', requireAuth, async (req, res) => {
  try {
    const user = req.user as SelectUser;
    if (user.role !== 'user') {
      // Staff accounts never have a self-service bowler identity. Treat a
      // stale legacy link as unavailable without disclosing the bowler row.
      return sendSuccess(res, null);
    }
    if (!user.bowlerId) {
      return sendSuccess(res, null);
    }

    const bowler = await storage.getBowler(user.bowlerId);
    
    // Verify the user still has access to this bowler 
    // (in case organization access changed after linking)
    if (bowler && !(await hasAccessToBowler(req, bowler.id))) {
      // If the user no longer has access, unlink the bowler
      if (!user.organizationId) {
        return sendError(res, "You no longer have access to this bowler", 403, 'FORBIDDEN');
      }
      await unlinkUserFromBowler({
        organizationId: user.organizationId,
        userId: user.id,
        actorUserId: user.id,
        source: 'access-cleanup',
        reason: 'bowler-access-revoked',
        eventType: 'access_cleanup',
      });
      return sendError(res, "You no longer have access to this bowler", 403, 'FORBIDDEN');
    }
    
    // task #381: deny-by-default projection — same rationale as the
    // bowlers/locations CRUD endpoints. Returns the bowler if the
    // pre-condition above didn't already short-circuit with null.
    sendSuccess(res, bowler ? sanitizeBowler(bowler) : null);
  } catch (error) {
    sendError(res, 'Failed to fetch bowler');
  }
});

// Unlink bowler from user
router.delete('/unlink-bowler', requireAuth, async (req, res) => {
  try {
    const user = req.user as SelectUser;
    if (user.role !== 'user') {
      return sendError(res, 'Staff accounts cannot manage bowler links', 403, 'FORBIDDEN');
    }
    
    // If the user has a linked bowler, verify they still have access
    if (user.bowlerId && !(await hasAccessToBowler(req, user.bowlerId))) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    if (!user.organizationId) {
      return sendError(res, 'Organization context missing', 403, 'FORBIDDEN');
    }
    
    await unlinkUserFromBowler({
      organizationId: user.organizationId,
      userId: user.id,
      actorUserId: user.id,
      source: 'user-bowler-unlink',
      reason: 'user-requested',
      eventType: 'unlink',
    });
    sendSuccess(res, { message: 'Bowler unlinked successfully' });
  } catch (error) {
    if (handleIdentityLinkError(res, error)) return;
    sendError(res, 'Failed to unlink bowler');
  }
});

export default router;
