import { Router, Request, Response, NextFunction } from 'express';
import { storage } from '../storage';
import { sendSuccess, sendError, handleZodError, sanitizeUser, sanitizeBowler } from '../utils/api';
import { z } from 'zod';
import { User as SelectUser } from '@shared/schema';
import { hasAccessToBowler } from '../utils/access-control.js';
import {
  IdentityLinkError,
  linkUserToBowler,
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

// Schema for linking bowler to user
const linkBowlerSchema = z.object({
  bowlerId: z.number().int().positive('Bowler ID must be a positive number'),
});

function handleIdentityLinkError(res: Response, error: unknown): boolean {
  if (!(error instanceof IdentityLinkError)) return false;
  // Preserve this endpoint's long-standing 400/ALREADY_LINKED contract for
  // clients that retry a claim after the account already has a bowler. The
  // service keeps the stricter conflict status for other callers/races.
  const status = error.code === 'ALREADY_LINKED' ? 400 : error.status;
  sendError(res, error.message, status, error.code);
  return true;
}

// Link a bowler to the authenticated user
router.post('/link-bowler', requireAuth, async (req, res) => {
  try {
    const user = req.user as SelectUser;
    if (user.role !== 'user') {
      return sendError(res, 'Staff accounts cannot be linked to bowler records', 403, 'FORBIDDEN');
    }
    const { bowlerId } = linkBowlerSchema.parse(req.body);

    // Verify bowler exists
    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) {
      return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
    }

    // Org membership gate.
    if (!user.organizationId || bowler.organizationId !== user.organizationId) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    // Email ownership proof — required for all targets, including blank-email
    // bowlers. Without an email match, there is no shared secret to verify
    // the caller owns this profile. An admin must set the bowler's email first.
    if (!bowler.email || bowler.email.trim() === '') {
      return sendError(res, "This bowler profile has no email address on record. Please contact your league administrator to link your account.", 403, 'FORBIDDEN');
    }
    if (bowler.email.toLowerCase().trim() !== user.email.toLowerCase().trim()) {
      return sendError(res, "You can only link a bowler profile that matches your email address", 403, 'FORBIDDEN');
    }

    // Keep the established 400/ALREADY_LINKED response for this API while
    // the transactional service below repeats the check under a bowler-row
    // lock to close the race between this compatibility read and the write.
    if (await storage.isBowlerLinked(bowlerId)) {
      return sendError(res, "This bowler is already linked to another account", 400, "ALREADY_LINKED");
    }

    // The service repeats the user/bowler/org/claim checks while holding row
    // locks. The email check above is a proof-of-ownership gate; it is not a
    // substitute for the transactional integrity check.
    const updated = await linkUserToBowler({
      organizationId: user.organizationId,
      userId: user.id,
      bowlerId,
      actorUserId: user.id,
      source: 'user-bowler-link',
    });
    sendSuccess(res, sanitizeUser(updated.user));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    if (handleIdentityLinkError(res, error)) return;
    sendError(res, 'Failed to link bowler to user');
  }
});

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
