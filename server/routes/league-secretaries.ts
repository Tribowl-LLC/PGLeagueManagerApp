/**
 * Task #735 — League Secretary grant/revoke API.
 *
 * Mounted at `/api/leagues/:leagueId/secretaries`. All routes are
 * authenticated (mount-level `requireAuth` in `server/routes/index.ts`).
 *
 * Authorization policy:
 *   - GET (list)    — visible to org_admin of the league's owning org
 *                     ONLY. system_admin is rejected for parity with
 *                     grant/revoke (secretary management is org-scoped).
 *   - POST (grant)  — org_admin of the league's owning org ONLY.
 *                     system_admin is REJECTED with 403 SYSTEM_ADMIN_DENIED;
 *                     secretaries cannot grant other secretaries.
 *   - DELETE (revoke) — same as grant.
 *
 * Why is system_admin rejected from grant/revoke?
 *   Per the task spec, secretary management is the org's responsibility.
 *   A platform operator should not be able to silently confer per-league
 *   admin powers on an arbitrary user, because the audit trail would
 *   misattribute the act of trust. If a system_admin needs to provision
 *   a secretary, they must do so by impersonating an org_admin or by
 *   the org_admin acting directly.
 *
 * Org isolation:
 *   - The target user must belong to the same organization as the
 *     league. Granting a secretary role to a user from a different org
 *     is rejected with 422 USER_NOT_IN_ORG.
 *   - The DB-level invariant in `server/db-invariants.ts` enforces
 *     `league_secretaries.organization_id == leagues.organization_id`
 *     at write time as a defence-in-depth rail.
 *
 * Audit:
 *   Every grant/revoke writes a row to `league_secretary_audits` in the
 *   same transaction as the (insert | delete). IP and User-Agent are
 *   captured for forensic linkage.
 */
import { Router, Request, Response } from 'express';
import { singleRouteParam } from '../utils/route-params';
import { storage } from '../storage';
import { sendSuccess, sendError, handleZodError } from '../utils/api';
import {
  isSystemAdmin,
  hasAdminAccessToLeague,
  isLeagueSecretaryFor,
} from '../utils/access-control';
import { db } from '../db';
import { leagueSecretaries, leagueSecretaryAudits } from '@shared/schema';
import { z } from 'zod';
import { createLogger } from '../logger';

const log = createLogger('LeagueSecretaries');

// `mergeParams: true` so the parent `:leagueId` is available on req.params.
const router = Router({ mergeParams: true });

// Grant accepts EITHER a numeric userId OR an email. The email path is the
// user-facing entry from the org-admin UI: it scopes the lookup to the
// league's owning org so an org_admin cannot accidentally grant an arbitrary
// user from another org. The userId path remains supported for tooling.
const grantBodySchema = z
  .object({
    userId: z.number().int().positive().optional(),
    email: z.string().email().optional(),
  })
  .refine((v) => v.userId !== undefined || v.email !== undefined, {
    message: 'userId or email is required',
  });

function getLeagueIdParam(req: Request): number | null {
  const raw = (req.params as { leagueId?: string }).leagueId;
  if (!raw) return null;
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function clientIp(req: Request): string | null {
  const v = req.ip ?? req.socket.remoteAddress ?? null;
  return v ? v.toString().slice(0, 64) : null;
}

function clientUa(req: Request): string | null {
  const v = req.get('user-agent');
  return v ? v.slice(0, 512) : null;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const leagueId = getLeagueIdParam(req);
    if (leagueId === null) return sendError(res, 'Invalid league ID', 400, 'INVALID_ID');

    const league = await storage.getLeague(leagueId);
    if (!league) return sendError(res, 'League not found', 404, 'NOT_FOUND');
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    // Per task #735: secretary roster management is org-scoped.
    // Only the org_admin of the league's owning org may list, for
    // parity with the grant/revoke policy (system_admin is rejected
    // there too).
    if (!(req.user?.role === 'org_admin'
          && req.user.organizationId === league.organizationId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const rows = await storage.listSecretariesForLeague(leagueId);
    sendSuccess(res, rows);
  } catch (error) {
    log.error('Error listing secretaries:', error);
    sendError(res, 'Failed to list secretaries', 500);
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const leagueId = getLeagueIdParam(req);
    if (leagueId === null) return sendError(res, 'Invalid league ID', 400, 'INVALID_ID');

    const parsed = grantBodySchema.safeParse(req.body);
    if (!parsed.success) return handleZodError(res, parsed.error);
    const { userId: userIdInput, email } = parsed.data;

    if (!req.user) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');

    // System admin is explicitly NOT permitted to grant secretary roles.
    // See the file-level note for the rationale.
    if (isSystemAdmin(req.user)) {
      return sendError(
        res,
        'Secretary grants must be performed by an organization admin, not a system admin.',
        403,
        'SYSTEM_ADMIN_DENIED',
      );
    }

    if (req.user.role !== 'org_admin') {
      return sendError(res, 'Only organization admins may grant secretary roles.', 403, 'FORBIDDEN');
    }

    const league = await storage.getLeague(leagueId);
    if (!league) return sendError(res, 'League not found', 404, 'NOT_FOUND');
    if (league.organizationId === null) {
      return sendError(res, "League has no organization", 403, 'FORBIDDEN');
    }
    if (league.organizationId !== req.user.organizationId) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    // Resolve the target user from either userId or email. The email
    // path collapses "not found globally" and "found in another org"
    // into a single response (`USER_NOT_IN_ORG`) so an org_admin
    // cannot use this endpoint as an email-existence oracle for
    // sibling-org accounts. The userId path keeps the legacy
    // not-found / not-in-org distinction since a numeric ID alone
    // does not leak email existence.
    let targetUser = userIdInput !== undefined
      ? await storage.getUser(userIdInput)
      : undefined;
    if (userIdInput !== undefined && !targetUser) {
      return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    }
    if (!targetUser && email) {
      const found = await storage.getUserByEmail(email);
      if (!found || found.organizationId !== league.organizationId) {
        return sendError(
          res,
          "No user with that email belongs to this league's organization.",
          422,
          'USER_NOT_IN_ORG',
        );
      }
      targetUser = found;
    }
    if (!targetUser) return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    const userId = targetUser.id;

    if (targetUser.organizationId !== league.organizationId) {
      return sendError(
        res,
        "User does not belong to this league's organization.",
        422,
        'USER_NOT_IN_ORG',
      );
    }

    // Don't allow elevating a system_admin to a secretary — they
    // already have wider powers and the role would be meaningless.
    // Don't grant to other org_admins either — already strictly broader.
    if (targetUser.role === 'system_admin' || targetUser.role === 'org_admin') {
      return sendError(
        res,
        'User already has admin privileges; secretary grant is unnecessary.',
        422,
        'USER_ALREADY_ADMIN',
      );
    }

    // Idempotent: if the grant already exists, return it without
    // writing a duplicate audit row.
    const existing = await storage.getLeagueSecretary(userId, leagueId);
    if (existing) return sendSuccess(res, existing, 200);

    // Wrap insert + audit in a transaction so a partial failure cannot
    // leave a grant without an audit trail.
    const orgId = league.organizationId;
    const actorUserId = req.user.id;
    const grant = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(leagueSecretaries)
        .values({
          userId,
          leagueId,
          organizationId: orgId,
          grantedByUserId: actorUserId,
        })
        .returning();
      await tx.insert(leagueSecretaryAudits).values({
        actorUserId,
        targetUserId: userId,
        leagueId,
        organizationId: orgId,
        action: 'grant',
        ipAddress: clientIp(req),
        userAgent: clientUa(req),
      });
      return row;
    });

    sendSuccess(res, grant, 201);
  } catch (error) {
    log.error('Error granting secretary:', error);
    if (error instanceof z.ZodError) return handleZodError(res, error);
    sendError(res, 'Failed to grant secretary role', 500);
  }
});

router.delete('/:userId', async (req: Request, res: Response) => {
  try {
    const leagueId = getLeagueIdParam(req);
    if (leagueId === null) return sendError(res, 'Invalid league ID', 400, 'INVALID_ID');
    const userId = Number.parseInt(singleRouteParam(req.params.userId), 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }

    if (!req.user) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');

    if (isSystemAdmin(req.user)) {
      return sendError(
        res,
        'Secretary revokes must be performed by an organization admin, not a system admin.',
        403,
        'SYSTEM_ADMIN_DENIED',
      );
    }
    if (req.user.role !== 'org_admin') {
      return sendError(res, 'Only organization admins may revoke secretary roles.', 403, 'FORBIDDEN');
    }

    const league = await storage.getLeague(leagueId);
    if (!league) return sendError(res, 'League not found', 404, 'NOT_FOUND');
    if (league.organizationId === null) {
      return sendError(res, 'League has no organization', 403, 'FORBIDDEN');
    }
    if (league.organizationId !== req.user.organizationId) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const existing = await storage.getLeagueSecretary(userId, leagueId);
    if (!existing) return sendError(res, 'Secretary grant not found', 404, 'NOT_FOUND');

    const orgId = league.organizationId;
    const actorUserId = req.user.id;
    await db.transaction(async (tx) => {
      await tx.insert(leagueSecretaryAudits).values({
        actorUserId,
        targetUserId: userId,
        leagueId,
        organizationId: orgId,
        action: 'revoke',
        ipAddress: clientIp(req),
        userAgent: clientUa(req),
      });
      await storage.deleteLeagueSecretary(userId, leagueId, tx);
    });

    sendSuccess(res, null);
  } catch (error) {
    log.error('Error revoking secretary:', error);
    sendError(res, 'Failed to revoke secretary role', 500);
  }
});

/**
 * Companion route mounted at `/api/users/me/league-secretary-leagues`
 * (see routes/index.ts) — returns the league ids the calling user is a
 * secretary of. Used by the client to render the "My Leagues" landing
 * for secretary-only users.
 */
export const myLeagueSecretaryRouter = Router();
myLeagueSecretaryRouter.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.user) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    const ids = await storage.getSecretaryLeagueIdsForUser(req.user.id);
    if (ids.length === 0) return sendSuccess(res, []);
    const leagues = await storage.getLeaguesByIds(ids);
    // Defensive: only return leagues whose org matches the caller's org
    // (the DB invariant should already enforce this, but cheap to verify).
    const callerOrgId = req.user.organizationId;
    const filtered = leagues.filter(
      (l) => l.organizationId !== null && l.organizationId === callerOrgId,
    );
    sendSuccess(res, filtered);
  } catch (error) {
    log.error('Error fetching my secretary leagues:', error);
    sendError(res, 'Failed to fetch leagues', 500);
  }
});

export default router;
