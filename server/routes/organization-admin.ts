import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { db } from '../db';
import { storage } from '../storage';
import { sendSuccess, sendError, sanitizeUser, handleZodError, handleUserOrgError } from '../utils/api';
import { singleRouteParam } from '../utils/route-params';
import { hashPassword, destroyOtherSessionsForUser } from '../auth';
import {
  sendInviteEmail,
  sendTemplatedEmail,
  getBaseUrl,
  getOrgLogoUrl,
  sendPasswordChangedNotification,
} from '../services/email';
import { passwordSchema } from '@shared/password-validation';
import { z } from 'zod';
import { adminWriteLimiter, inviteLimiter } from '../middleware/rate-limit';
import { createLogger } from '../logger';
import { recordAdminPasswordResetAudit } from '../storage/admin-password-reset-audits';
import { recordAdminRoleChangeAudit } from '../storage/admin-role-change-audits';
import type { User, UserRole } from '@shared/schema';
import { publicAccountInvitation } from '../services/account-invitation.js';
import {
  lockAccountCredential,
  withAccountActionDeliveryLock,
} from '../storage/account-action-requests.js';
import { isNormalizedUserEmailConflict } from '../utils/db-errors.js';

const log = createLogger("OrgAdmin");

// Define error code type for type safety
type ErrorCode = string;

/**
 * Atomic write of an admin-driven password reset (task #458). The
 * password update on `users` and the audit row on
 * `admin_password_reset_audits` share one `db.transaction(...)` so
 * they succeed or fail together — if either insert throws, drizzle
 * issues ROLLBACK and neither write is observable. The route below
 * delegates to this helper so the contract is exercised by the SAME
 * code path tests run, not a handcrafted replica.
 *
 * Order inside the transaction matches task #424 (password-update
 * first, audit second) so a maintainer reading top-to-bottom sees the
 * same write order as the unit-test invocation-order assertions.
 *
 * Exported so the rollback contract can be pinned end-to-end against
 * a real Postgres connection by
 * `tests/unit/admin-password-reset-atomicity.test.ts` (task #519).
 */
export async function resetUserPasswordTxn(opts: {
  targetUserId: number;
  hashedPassword: string;
  audit: {
    actorUserId: number;
    organizationId: number | null;
    ipAddress: string | null;
    userAgent: string | null;
  };
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockAccountCredential(tx, opts.targetUserId);
    await storage.revokePendingAccountActionsForUser(
      opts.targetUserId,
      ['password_reset'],
      tx,
    );

    await storage.updateUser(
      opts.targetUserId,
      {
        password: opts.hashedPassword,
        mustChangePassword: true,
      },
      tx,
    );

    await storage.invalidatePendingEmailChangeRequestsForUser(
      opts.targetUserId,
      tx,
    );

    await recordAdminPasswordResetAudit(
      {
        actorUserId: opts.audit.actorUserId,
        targetUserId: opts.targetUserId,
        organizationId: opts.audit.organizationId,
        ipAddress: opts.audit.ipAddress,
        userAgent: opts.audit.userAgent,
      },
      tx,
    );
  });
}

/**
 * Atomic write of an admin-driven role change (task #461). The role
 * update on `users` and the audit row on `admin_role_change_audits`
 * share one `db.transaction(...)` so they succeed or fail together —
 * if either insert throws, drizzle issues ROLLBACK and neither write
 * is observable. The route below delegates to this helper so the
 * contract is exercised by the SAME code path tests run, not a
 * handcrafted replica.
 *
 * Order inside the transaction matches task #459 (role-update first,
 * audit second) so a maintainer reading top-to-bottom sees the same
 * write order as the unit-test invocation-order assertions ("we never
 * log a role change that didn't happen").
 *
 * Exported so the rollback contract can be pinned end-to-end against
 * a real Postgres connection by
 * `tests/unit/admin-role-change-audit-atomicity.test.ts` (task #544),
 * mirroring the pattern landed for `resetUserPasswordTxn` (#519) and
 * `applyEmailChangeRequestTxn` (#377).
 */
export async function applyRoleChangeWithAuditTxn(opts: {
  targetUserId: number;
  newRole: UserRole;
  audit: {
    actorUserId: number;
    targetUserId: number;
    organizationId: number | null;
    oldRole: UserRole;
    newRole: UserRole;
    ipAddress: string | null;
    userAgent: string | null;
  };
}): Promise<User> {
  return db.transaction(async (tx) => {
    const updated = await storage.updateUserRole(
      opts.targetUserId,
      opts.newRole,
      tx,
    );

    await recordAdminRoleChangeAudit(
      {
        actorUserId: opts.audit.actorUserId,
        targetUserId: opts.audit.targetUserId,
        organizationId: opts.audit.organizationId,
        oldRole: opts.audit.oldRole,
        newRole: opts.audit.newRole,
        ipAddress: opts.audit.ipAddress,
        userAgent: opts.audit.userAgent,
      },
      tx,
    );

    return updated;
  });
}

const router = Router();

// Middleware to check if the user is an organization admin or a system admin
async function requireOrgAdminOrSystemAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated() || !req.user) {
    return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
  }

  // Capture in a local so subsequent property reads don't need a `!`
  // assertion to defeat TS's getter-aware narrowing of `req.user`.
  const user = req.user;

  // Allow system admins
  if (user.role === 'system_admin') {
    return next();
  }

  if (user.role === 'org_admin' && user.organizationId) {
    return next();
  }

  return sendError(res, 'You do not have permission to access this resource', 403, 'FORBIDDEN');
}

// Get all users in the current user's organization
router.get('/users', requireOrgAdminOrSystemAdmin, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    // A system admin can specify any organization
    let organizationId: number | null = req.query.organizationId 
      ? parseInt(String(req.query.organizationId), 10) 
      : null;
    
    // For organization admins, force their own organization
    if (actingUser.role === 'org_admin') {
      organizationId = actingUser.organizationId;
    }
    
    if (!organizationId) {
      return sendError(res, 'Organization ID is required', 400, 'bad_request');
    }
    
    const users = await storage.getOrganizationUsers(organizationId);
    const latestInvitations = await storage.getLatestAccountInvitationsForUsers(
      users.map((user) => user.id),
      organizationId,
    );
    
    const bowlerIds = users
      .map((u) => u.bowlerId)
      .filter((id): id is number => id != null);

    const [allBowlers, allBowlerLeagueEntries] = await Promise.all([
      storage.getBowlersByIds(bowlerIds),
      storage.getBowlerLeaguesByBowlerIds(bowlerIds),
    ]);

    // The composite users→bowlers FK prevents this mismatch after the
    // identity migration, but keep this read path fail-closed for legacy or
    // manually repaired rows: an org admin must never see a linked bowler
    // from another tenant through a stale users.bowler_id.
    const scopedBowlers = allBowlers.filter((bowler) => bowler.organizationId === organizationId);
    const scopedBowlerIds = new Set(scopedBowlers.map((bowler) => bowler.id));
    const scopedBowlerLeagueEntries = allBowlerLeagueEntries.filter((entry) => scopedBowlerIds.has(entry.bowlerId));
    const bowlerMap = new Map(scopedBowlers.map(b => [b.id, b]));
    const blByBowler = new Map<number, typeof allBowlerLeagueEntries>();
    for (const bl of scopedBowlerLeagueEntries) {
      const bowlerLeagueEntries = blByBowler.get(bl.bowlerId) ?? [];
      bowlerLeagueEntries.push(bl);
      blByBowler.set(bl.bowlerId, bowlerLeagueEntries);
    }

    const leagueIds = [...new Set(scopedBowlerLeagueEntries.map(bl => bl.leagueId))];
    const teamIds = [...new Set(scopedBowlerLeagueEntries.map(bl => bl.teamId))];
    const [allLeagues, allTeams] = await Promise.all([
      storage.getLeaguesByIds(leagueIds),
      storage.getTeamsByIds(teamIds),
    ]);
    const leagueMap = new Map(allLeagues.map(l => [l.id, l]));
    const teamMap = new Map(allTeams.map(t => [t.id, t]));

    const usersWithBowlerInfo = users.map((user) => {
      const safeUser = sanitizeUser(user);
      if (!user.bowlerId) {
        return {
          ...safeUser,
          linkedBowler: null,
          invitation: publicAccountInvitation(latestInvitations.get(user.id)),
        };
      }
      const bowler = bowlerMap.get(user.bowlerId);
      if (!bowler) {
        return {
          ...safeUser,
          linkedBowler: null,
          invitation: publicAccountInvitation(latestInvitations.get(user.id)),
        };
      }
      const entries = (blByBowler.get(bowler.id) || [])
        .filter((entry) => leagueMap.get(entry.leagueId)?.organizationId === organizationId);
      let leagueName: string | null = null;
      let teamName: string | null = null;
      if (entries.length > 0) {
        const bl = entries[0];
        leagueName = leagueMap.get(bl.leagueId)?.name || null;
        teamName = teamMap.get(bl.teamId)?.name || null;
      }
      return {
        ...safeUser,
        linkedBowler: {
          id: bowler.id,
          name: bowler.name,
          leagueName,
          teamName,
        },
        invitation: publicAccountInvitation(latestInvitations.get(user.id)),
      };
    });

    return sendSuccess(res, usersWithBowlerInfo);
  } catch (error) {
    log.error('Error getting organization users:', error);
    return sendError(res, 'Failed to get organization users', 500, 'internal_error');
  }
});

// Update a user's organization admin status
router.patch('/users/:id/admin-status', requireOrgAdminOrSystemAdmin, adminWriteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'bad_request');
    }
    
    // Validate request body
    const schema = z.object({
      makeOrgAdmin: z.boolean().optional(),
      role: z.enum(['user', 'org_admin', 'payment_manager', 'admin']).optional(),
    }).refine((value) => value.makeOrgAdmin !== undefined || value.role !== undefined, {
      message: 'A target role is required',
    });
    
    const parseResult = schema.safeParse({
      makeOrgAdmin: req.body.isOrganizationAdmin ?? req.body.makeOrgAdmin,
      role: req.body.role,
    });
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }
    
    const roleInput = parseResult.data.role;
    const newRole: UserRole = roleInput === 'admin' || roleInput === 'org_admin' || parseResult.data.makeOrgAdmin === true
      ? 'org_admin'
      : roleInput === 'payment_manager'
        ? 'payment_manager'
        : 'user';
    
    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'NOT_FOUND');
    }

    // Task #462: an admin cannot change their OWN admin status through
    // this endpoint. Without this guard a self-demotion silently flips
    // the role, writes an audit row, and locks the caller out of the
    // user-management screen on their next page load — leaving the org
    // potentially without an admin for a window even when the
    // last-admin guard further down would otherwise have caught it.
    // Mirrors the same self-action block on the admin-driven password
    // reset endpoint a few hundred lines down (search for "Use
    // change-password to rotate your own password"), so the policy is
    // consistent across all admin-on-self mutations: ask another
    // admin to do it, or transfer ownership first. The client also
    // disables the role toggle for the current user
    // (client/src/components/users-table.tsx), but this server-side
    // check is the source of truth — a future client refactor or a
    // direct API call cannot bypass it.
    if (user.id === actingUser.id) {
      return sendError(
        res,
        'You cannot change your own admin status. Ask another administrator to do it, or transfer ownership first.',
        403,
        'forbidden',
      );
    }

    if (actingUser.role === 'org_admin') {
      if (user.role === 'system_admin') {
        return sendError(res, 'Organization admins cannot modify system admin accounts', 403, 'forbidden');
      }
      if (user.organizationId !== actingUser.organizationId) {
        return sendError(res, 'You can only update users in your own organization', 403, 'forbidden');
      }
    }
    
    if (newRole === 'payment_manager' && user.locationId === null) {
      return sendError(res, 'Payment managers must be assigned to a location before promotion', 400, 'LOCATION_REQUIRED');
    }

    if (newRole !== 'org_admin' && user.role === 'org_admin' && user.organizationId) {
      const adminCount = await storage.countOrgAdmins(user.organizationId);
      if (adminCount <= 1) {
        return sendError(res, 'Cannot remove the last administrator from this organization', 400, 'bad_request');
      }
    }

    // Task #461: the role update and the audit insert run inside ONE
    // database transaction so they succeed or fail together. If the
    // audit insert throws, drizzle rolls the role update back and the
    // outer catch returns 500 — the admin can safely retry because no
    // row was committed. Mirrors the same atomic contract task #458
    // pinned for the admin-driven password reset, and #325 for the
    // admin-driven email change.
    //
    // Strict ordering inside the transaction (asserted by the unit
    // test): updateUserRole first, audit insert second. Reordering
    // would still be atomic at the DB level, but the invocation-order
    // assertion keeps the source-of-truth narrative obvious to a
    // future maintainer ("we never log a role change that didn't
    // happen").
    const rawUaForAudit = (req.get('user-agent') ?? '').slice(0, 512);
    const updatedUser = await applyRoleChangeWithAuditTxn({
      targetUserId: userId,
      newRole,
      audit: {
        actorUserId: actingUser.id,
        targetUserId: user.id,
        organizationId: user.organizationId ?? null,
        oldRole: user.role,
        newRole,
        ipAddress: req.ip ?? null,
        userAgent: rawUaForAudit || null,
      },
    });

    return sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error('Error updating organization admin status:', error);
    return sendError(res, 'Failed to update organization admin status', 500, 'internal_error');
  }
});

// Add a user to the organization
router.post('/users/:id/add', requireOrgAdminOrSystemAdmin, adminWriteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'bad_request');
    }
    
    // Validate request body
    const schema = z.object({
      organizationId: z.number().optional(),
      makeOrgAdmin: z.boolean().optional().default(false),
    });
    
    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }
    
    const { makeOrgAdmin } = parseResult.data;
    
    let organizationId: number;
    
    if (actingUser.role === 'system_admin' && req.body.organizationId !== undefined) {
      organizationId = parseInt(String(req.body.organizationId), 10);
      if (isNaN(organizationId)) {
        return sendError(res, 'Invalid organization ID', 400, 'bad_request');
      }
    } else {
      // Organization admins must use their own organization
      if (!actingUser.organizationId) {
        return sendError(res, 'Organization ID is required', 400, 'bad_request');
      }
      organizationId = actingUser.organizationId;
    }
    
    if (!organizationId) {
      return sendError(res, 'Organization ID is required', 400, 'bad_request');
    }

    // Task #454: existence pre-check for the admin-supplied
    // organizationId (system_admin override branch). Without this, a
    // typoed/stale id falls through to the
    // `users.organization_id -> organizations.id` foreign key and
    // surfaces as a generic 500. Mirrors the #422 reference fix in
    // server/routes/bowlers.ts.
    const orgRow = await storage.getOrganization(organizationId);
    if (!orgRow) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'NOT_FOUND');
    }

    if (actingUser.role === 'org_admin' && user.role === 'system_admin') {
      return sendError(res, 'Organization admins cannot modify system admin accounts', 403, 'forbidden');
    }

    // Check if user is already in an organization
    if (user.organizationId) {
      // If they're in the same org we're trying to add them to, just update admin status
      if (user.organizationId === organizationId) {
        const desiredRole = makeOrgAdmin ? 'org_admin' : 'user';
        if (desiredRole !== user.role) {
          if (desiredRole === 'user' && user.role === 'org_admin') {
            const adminCount = await storage.countOrgAdmins(user.organizationId);
            if (adminCount <= 1) {
              return sendError(res, 'Cannot remove the last administrator from this organization', 400, 'bad_request');
            }
          }
          const updatedUser = await storage.updateUserRole(userId, desiredRole);
          return sendSuccess(res, sanitizeUser(updatedUser));
        }
        
        return sendSuccess(res, sanitizeUser(user));
      }
      
      return sendError(res, 'User is already in another organization', 409, 'conflict');
    }
    
    // Use setUserOrganization to set the user's organization
    const updatedUser = await storage.setUserOrganization(userId, organizationId);
    
    // If requested to make user an org admin and they aren't already
    if (makeOrgAdmin && updatedUser.role !== 'org_admin') {
      await storage.updateUserRole(userId, 'org_admin');
    }
    
    const refreshedUser = await storage.getUser(userId);
    if (!refreshedUser) {
      return sendError(res, 'User not found after update', 500, 'internal_error');
    }
    return sendSuccess(res, sanitizeUser(refreshedUser));
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error('Error adding user to organization:', error);
    return sendError(res, 'Failed to add user to organization', 500, 'internal_error');
  }
});

// Permanently delete a user account (#268). Replaces the old "remove
// from organization" path, which can no longer leave a non-admin user
// orphaned thanks to the `users_role_org_required` CHECK constraint.
router.delete('/users/:id', requireOrgAdminOrSystemAdmin, adminWriteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'bad_request');
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'NOT_FOUND');
    }

    // Authorization: deletion is intentionally locked down so neither
    // an org_admin nor a system_admin can ever delete:
    //   - themselves (would lock them out, and for the only sysadmin
    //     would brick the platform)
    //   - another system_admin (audit-trail FK is RESTRICT, and admin
    //     accounts must be demoted via system-admin tooling first)
    if (user.id === actingUser.id) {
      return sendError(res, 'You cannot delete your own account', 403, 'forbidden');
    }
    if (user.role === 'system_admin') {
      return sendError(
        res,
        'System admin accounts cannot be deleted from this page. Demote the user first.',
        403,
        'forbidden',
      );
    }

    if (actingUser.role === 'org_admin' && user.organizationId !== actingUser.organizationId) {
      return sendError(res, 'You can only delete users from your own organization', 403, 'forbidden');
    }

    // A live organization must always retain an administrator. The
    // system-admin organization deletion flow is the sole exception:
    // after an organization is archived, its final administrator may be
    // deleted so the now-inactive tenant can be permanently removed.
    if (user.role === 'org_admin' && user.organizationId) {
      const adminCount = await storage.countOrgAdmins(user.organizationId);
      if (adminCount <= 1) {
        const organization = await storage.getOrganization(user.organizationId);
        const deletingArchivedOrganizationAdmin =
          actingUser.role === 'system_admin' && organization?.active === false;

        if (!deletingArchivedOrganizationAdmin) {
          return sendError(
            res,
            'Cannot delete the last administrator in this organization. Archive the organization first before permanently removing it.',
            400,
            'bad_request',
          );
        }
      }
    }

    const deleted = await storage.deleteUser(userId, undefined, actingUser.id);
    log.info('User permanently deleted', {
      deletedUserId: deleted.id,
      deletedEmail: deleted.email,
      actingUserId: actingUser.id,
    });
    return sendSuccess(res, { id: deleted.id, email: deleted.email });
  } catch (error) {
    const errObj = (error && typeof error === 'object') ? error as { name?: string; message?: string } : {};
    if (errObj.name === 'CannotDeleteAdminError') {
      return sendError(res, errObj.message ?? 'Cannot delete admin', 403, 'forbidden');
    }
    if (errObj.name === 'UserHasAuditTrailError') {
      return sendError(res, errObj.message ?? 'Audit trail conflict', 409, 'AUDIT_TRAIL_CONFLICT');
    }
    log.error('Error deleting user:', error);
    return sendError(res, 'Failed to delete user', 500, 'internal_error');
  }
});

// Update a user's location assignment
router.patch('/users/:id/location', requireOrgAdminOrSystemAdmin, adminWriteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'bad_request');
    }

    const schema = z.object({
      locationId: z.number().int().positive().nullable(),
    });

    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'NOT_FOUND');
    }

    if (actingUser.role === 'org_admin') {
      if (user.role === 'system_admin') {
        return sendError(res, 'Organization admins cannot modify system admin accounts', 403, 'forbidden');
      }
      if (user.organizationId !== actingUser.organizationId) {
        return sendError(res, 'You can only update users in your own organization', 403, 'forbidden');
      }
    }

    // Task #454: existence + same-tenant guard for the admin-supplied
    // locationId. A null clears the assignment (no FK to validate). A
    // numeric id must match an existing location row whose org matches
    // the target user's org — without this, a typoed/stale id falls
    // through to the `users.location_id -> locations.id` foreign key
    // and 500s, and a wrong-tenant id would silently cross the org
    // boundary.
    const newLocationId = parseResult.data.locationId;
    if (user.role === 'payment_manager' && newLocationId === null) {
      return sendError(res, 'Payment managers must remain assigned to a location', 400, 'LOCATION_REQUIRED');
    }
    if (newLocationId !== null) {
      const locationRow = await storage.getLocation(newLocationId);
      if (
        !locationRow ||
        (user.organizationId !== null && locationRow.organizationId !== user.organizationId)
      ) {
        return sendError(res, 'Location not found for this user\'s organization', 404, 'NOT_FOUND');
      }
    }

    const updatedUser = await storage.setUserLocation(userId, newLocationId);
    return sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    log.error('Error updating user location:', error);
    return sendError(res, 'Failed to update user location', 500, 'internal_error');
  }
});

router.post('/users/create', requireOrgAdminOrSystemAdmin, inviteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const schema = z.object({
      firstName: z.string().min(1, 'First name is required').max(50),
      lastName: z.string().min(1, 'Last name is required').max(50),
      email: z.string().email('Invalid email address'),
      makeOrgAdmin: z.boolean().default(false),
      // `admin` remains accepted as the historical client label; all writes
      // are normalized to the explicit persisted role `org_admin`.
      role: z.enum(['user', 'org_admin', 'payment_manager', 'admin']).optional(),
      locationId: z.number().int().positive().nullable().optional(),
    });

    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }

    const { firstName, lastName, makeOrgAdmin, locationId } = parseResult.data;
    const email = parseResult.data.email.trim().toLowerCase();
    const fullName = `${firstName} ${lastName}`;
    const requestedRole = parseResult.data.role;
    const role: 'user' | 'org_admin' | 'payment_manager' =
      requestedRole === 'admin' || requestedRole === 'org_admin' || makeOrgAdmin
        ? 'org_admin'
        : requestedRole === 'payment_manager'
          ? 'payment_manager'
          : 'user';

    let organizationId: number;
    if (actingUser.role === 'system_admin' && req.body.organizationId) {
      organizationId = parseInt(String(req.body.organizationId), 10);
    } else {
      if (!actingUser.organizationId) {
        return sendError(res, 'Organization ID is required', 400, 'bad_request');
      }
      organizationId = actingUser.organizationId;
    }

    if (!organizationId) {
      return sendError(res, 'Organization ID is required', 400, 'bad_request');
    }

    // Task #454: existence pre-check for the admin-supplied
    // organizationId. The new user is inserted with this id stamped on
    // `users.organization_id`; without this guard a typoed id from the
    // sysadmin override branch falls through to the FK constraint and
    // 500s. Mirrors server/routes/bowlers.ts (#422).
    const orgRow = await storage.getOrganization(organizationId);
    if (!orgRow) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    // Task #454: same existence + same-tenant guard for the optional
    // admin-supplied locationId. Locations are tenant-scoped, so a
    // cross-tenant stamp is meaningless either way.
    if (locationId !== null && locationId !== undefined) {
      const locationRow = await storage.getLocation(locationId);
      if (!locationRow || locationRow.organizationId !== organizationId) {
        return sendError(res, 'Location not found for this organization', 404, 'NOT_FOUND');
      }
    }

    if (role === 'payment_manager' && (locationId === null || locationId === undefined)) {
      return sendError(res, 'Payment managers must be assigned to a location', 400, 'bad_request');
    }

    const existingUser = await storage.getUserByEmail(email);
    if (existingUser) {
      return sendError(res, 'A user with this email address already exists', 409, 'conflict');
    }

    const placeholderPassword = await hashPassword(randomBytes(32).toString('hex'));
    const assignedLocationId = role === 'org_admin' ? null : (locationId ?? null);
    const invitationExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // User creation and action issuance share the same transaction. The raw
    // token exists only in this return value so the email can be sent after
    // commit; neither its value nor its hash is returned to the client.
    const created = await db.transaction(async (tx) => {
      const newUser = await storage.createUser({
        email,
        password: placeholderPassword,
        name: fullName,
        role,
        organizationId,
        locationId: assignedLocationId,
      }, tx);
      const issued = await storage.issueAccountAction({
        userId: newUser.id,
        action: 'account_invite',
        expiresAt: invitationExpiry,
        organizationId,
        createdByUserId: actingUser.id,
      }, tx);
      return { newUser, issued };
    });

    const organization = orgRow;

    const baseUrl = getBaseUrl(organization);
    const setupUrl = `${baseUrl}/set-password?token=${created.issued.token}`;
    const variables: Record<string, string> = {
      user_name: firstName,
      invite_link: setupUrl,
      organization_name: organization?.name || 'your organization',
    };
    if (organization?.slug) {
      variables.organization_logo_url = getOrgLogoUrl(organization);
    }
    let emailSent = false;
    try {
      emailSent = await sendTemplatedEmail('org_end_user_invite', email, variables);
    } catch (error) {
      log.warn('Invitation email failed after account creation:', error);
    }
    const invitation = await storage.updateAccountActionDeliveryStatus(
      created.issued.request.id,
      emailSent ? 'sent' : 'failed',
    ) ?? created.issued.request;

    const finalUser = await storage.getUser(created.newUser.id);

    if (!finalUser) {
      return sendError(res, 'User not found after creation', 500, 'internal_error');
    }
    return sendSuccess(res, {
      user: sanitizeUser(finalUser),
      emailSent,
      invitation: publicAccountInvitation(invitation),
    });
  } catch (error) {
    if (isNormalizedUserEmailConflict(error)) {
      return sendError(res, 'A user with this email address already exists', 409, 'conflict');
    }
    if (handleUserOrgError(res, error)) return;
    log.error('Error creating user:', error);
    return sendError(res, 'Failed to create user', 500, 'internal_error');
  }
});

// Admin-driven password reset (task #416). Mirrors the security
// surface of the self-service change-password endpoint at
// server/routes/account.ts:686 — hash, persist, invalidate any
// pending email-change tokens, destroy other sessions for the
// target user, and dispatch the "your password was just changed"
// notification with `actor: 'admin'` so the recipient can tell a
// delegated rotation apart from an account takeover. The notice
// is fire-and-forget; an outbound email failure must NOT roll back
// the password update that already committed (tested in
// tests/unit/admin-reset-password-notification.test.ts).
//
// Authorization rules (intentionally strict):
//   - Caller must be org_admin (in their own org) or system_admin
//     (the existing `requireOrgAdminOrSystemAdmin` middleware).
//   - Caller cannot reset their OWN password through this endpoint
//     — that's what /api/account/change-password is for, and it
//     requires the current password as a defense-in-depth check.
//   - Caller cannot reset another system_admin (matches the same
//     guard on /users/:id/admin-status and /users/:id earlier in
//     this file — system_admin demotion / mutation goes through
//     dedicated tooling so we don't have one admin silently
//     unlocking another's account).
//   - org_admin callers can only act on users in their own org.
router.post('/users/:id/reset-password', requireOrgAdminOrSystemAdmin, adminWriteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'bad_request');
    }

    const schema = z.object({ newPassword: passwordSchema });
    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }
    const { newPassword } = parseResult.data;

    const targetUser = await storage.getUser(userId);
    if (!targetUser) {
      return sendError(res, 'User not found', 404, 'NOT_FOUND');
    }

    if (targetUser.id === actingUser.id) {
      return sendError(
        res,
        'Use change-password to rotate your own password',
        403,
        'forbidden',
      );
    }

    if (targetUser.role === 'system_admin') {
      return sendError(
        res,
        'System admin passwords cannot be reset from this endpoint',
        403,
        'forbidden',
      );
    }

    if (
      actingUser.role === 'org_admin' &&
      targetUser.organizationId !== actingUser.organizationId
    ) {
      return sendError(
        res,
        'You can only reset passwords for users in your own organization',
        403,
        'forbidden',
      );
    }

    const hashedNew = await hashPassword(newPassword);
    const rawUaForAudit = (req.get('user-agent') ?? '').slice(0, 512);

    // Task #458: the password update and the audit insert run inside
    // ONE database transaction so they succeed or fail together. If
    // the audit insert throws, drizzle rolls the password update back
    // and the outer catch returns 500 — the admin can safely retry
    // because no row was committed and `updateUser` is idempotent for
    // the caller. Task #519 extracted the body into
    // `resetUserPasswordTxn` (above) so the rollback contract is
    // exercised by the SAME code path the route runs through, against
    // a real Postgres connection in
    // `tests/unit/admin-password-reset-atomicity.test.ts`.
    //
    // Task #455 (still in force): the "must change password on next
    // sign-in" flag is written in the SAME update as the new hash so
    // the new credential and the forced-rotation gate land atomically.
    // Without the flag, an admin who resets a user's password
    // necessarily knows the working password until the user happens
    // to rotate it themselves — a real impersonation window. The
    // self-service /api/account/change-password endpoint clears the
    // flag back to false on a successful rotation; the App.tsx route
    // guards intercept the user and route them to
    // /change-password-required as long as it remains true.
    //
    // Task #424 (still in force): order inside the transaction is
    // password-update first, audit second, so a future maintainer
    // reading top-to-bottom sees the same write order as the
    // unit-test invocation-order assertions.
    await resetUserPasswordTxn({
      targetUserId: targetUser.id,
      hashedPassword: hashedNew,
      audit: {
        actorUserId: actingUser.id,
        organizationId: targetUser.organizationId ?? null,
        ipAddress: req.ip ?? null,
        userAgent: rawUaForAudit || null,
      },
    });

    // Force-log-out every other session for the target user. The
    // admin is rotating their password specifically because they're
    // assumed to need fresh access — leaving stale cookies alive
    // defeats the purpose. We do NOT pass a current-session id to
    // preserve here because the admin's session cookie belongs to a
    // DIFFERENT user (themselves), so there's nothing to keep.
    try {
      const dropped = await destroyOtherSessionsForUser(targetUser.id, null);
      if (dropped > 0) {
        log.info('Destroyed sessions on admin password reset', {
          targetUserId: targetUser.id,
          actingUserId: actingUser.id,
          count: dropped,
        });
      }
    } catch (err) {
      log.error('Failed to destroy sessions on admin password reset', {
        targetUserId: targetUser.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Industry-standard "your password was just changed" notice
    // (task #416). Best-effort — a SendGrid failure must not roll
    // back the password rotation that already committed. Sent with
    // `actor: 'admin'` so the i18n "performed by an administrator"
    // line is included in the rendered body.
    try {
      const rawUa = (req.get('user-agent') ?? '').slice(0, 256);
      void sendPasswordChangedNotification(targetUser.email, targetUser.name, {
        changedAt: new Date(),
        ipAddress: req.ip ?? null,
        userAgent: rawUa || null,
        locale: targetUser.preferredLanguage ?? null,
        actor: 'admin',
      })
        .then(ok => {
          if (!ok) {
            log.warn('Password-changed notification returned false (admin reset)', {
              targetUserId: targetUser.id,
            });
          }
        })
        .catch(err => {
          log.error('Password-changed notification threw (admin reset)', {
            targetUserId: targetUser.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (notifyError) {
      log.error('Failed to schedule password-changed notification (admin reset)', {
        targetUserId: targetUser.id,
        error: notifyError instanceof Error ? notifyError.message : String(notifyError),
      });
    }

    log.info('Admin reset user password', {
      targetUserId: targetUser.id,
      actingUserId: actingUser.id,
    });

    return sendSuccess(res, { id: targetUser.id });
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error('Error resetting user password:', error);
    return sendError(res, 'Failed to reset user password', 500, 'internal_error');
  }
});

router.post('/users/:id/resend-invite', requireOrgAdminOrSystemAdmin, inviteLimiter, async (req: Request, res: Response) => {
  try {
    const actingUser = req.user;
    if (!actingUser) {
      return sendError(res, 'You must be logged in to access this resource', 401, 'UNAUTHORIZED');
    }

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'bad_request');
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'NOT_FOUND');
    }

    if (actingUser.role === 'org_admin') {
      if (user.organizationId !== actingUser.organizationId) {
        return sendError(res, 'You can only manage users in your own organization', 403, 'forbidden');
      }
    }

    const organization = user.organizationId ? await storage.getOrganization(user.organizationId) : null;
    const { delivery, emailSent } = await withAccountActionDeliveryLock(userId, 'account_invite', async (lockedDb) => {
      const invitation = await storage.issueAccountAction({
        userId,
        action: 'account_invite',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organizationId: user.organizationId,
        createdByUserId: actingUser.id,
      }, lockedDb);

      const firstName = user.name.split(' ')[0];
      let emailSent = false;
      try {
        emailSent = await sendInviteEmail(
          user.email.trim().toLowerCase(),
          firstName,
          invitation.token,
          organization?.name,
          organization?.id,
          organization?.slug,
        );
      } catch (error) {
        log.warn('Invitation resend email failed:', error);
      }
      const delivery = await storage.updateAccountActionDeliveryStatus(
        invitation.request.id,
        emailSent ? 'sent' : 'failed',
        lockedDb,
      ) ?? invitation.request;
      return { delivery, emailSent };
    });

    return sendSuccess(res, {
      emailSent,
      invitation: publicAccountInvitation(delivery),
    });
  } catch (error) {
    log.error('Error resending invite:', error);
    return sendError(res, 'Failed to resend invite', 500, 'internal_error');
  }
});

export default router;
