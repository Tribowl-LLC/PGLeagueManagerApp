import { Router, Request, Response } from 'express';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { storage } from '../storage';
import { db } from '../db.js';
import {
  users,
  bowlers,
  bowlerLeagues,
  teams,
  leagues,
} from '@shared/schema';
import { sendSuccess, sendError, handleZodError, sanitizeUser, sanitizePayments, handleUserOrgError } from '../utils/api';
import { singleRouteParam } from '../utils/route-params';
import { z } from 'zod';
import { updateEmailTemplateSchema } from '@shared/schema/email-templates';
import { requireAdmin } from '../middleware/admin';
import { sendTestEmail, sendTemplatedEmail, getBaseUrl, getOrgLogoUrl } from '../services/email';
import { emailTestLimiter, adminWriteLimiter } from '../middleware/rate-limit';
import { cacheInvalidate } from '../utils/cache';
import { createLogger } from '../logger';

const log = createLogger("Admin");

const router = Router();

// Schema for making a user an admin
const setAdminStatusSchema = z.object({
  userId: z.number().int().positive('User ID must be a positive number'),
  makeSystemAdmin: z.boolean()
});

// Get all users (admin only)
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await storage.getUsers();
    sendSuccess(res, users.map(sanitizeUser));
  } catch (error) {
    log.error('Error fetching users:', error);
    sendError(res, 'Failed to fetch users');
  }
});

// Make a user an admin (admin only)
router.patch('/users/:userId/admin-status', requireAdmin, async (req, res) => {
  try {
    const userId = singleRouteParam(req.params.userId);
    const parsedData = setAdminStatusSchema.parse({ 
      userId: parseInt(userId), 
      makeSystemAdmin: req.body.isAdmin ?? req.body.makeSystemAdmin
    });

    const requestingUser = req.user;
    if (!requestingUser) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }
    if (requestingUser.id === parsedData.userId) {
      log.error('User attempted to change their own admin status');
      return sendError(res, 'Cannot modify your own admin status', 403, 'SELF_MODIFICATION_DENIED');
    }
    
    const newRole = parsedData.makeSystemAdmin ? 'system_admin' : 'user';
    const updatedUser = await storage.updateUserRole(parsedData.userId, newRole);
    sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error('Error updating admin status:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to update admin status');
  }
});

// Get admin dashboard stats (admin only)
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    
    // Fetch data for dashboard (system admin sees all)
    const [bowlers, leagues, teams, payments] = await Promise.all([
      storage.getAllBowlersSystemAdmin(),
      storage.getAllLeaguesSystemAdmin(),
      storage.getTeams(),
      storage.getAllPaymentsSystemAdmin()
    ]);
    
    // Get recent payments (last 5). Sanitize at the response boundary
    // (task #504) — the dashboard payload embeds the raw `Payment[]`
    // returned by the storage layer and would otherwise leak any
    // future column added to the table.
    const recentPayments = sanitizePayments(
      payments
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5)
    );
    
    // Calculate count of active entities
    const activeBowlers = bowlers.filter(b => b.active).length;
    const activeLeagues = leagues.filter(l => l.active).length;
    const activeTeams = teams.filter(t => t.active).length;
    
    // Count payments by status
    const paidPayments = payments.filter(p => p.status === 'paid').length;
    const pendingPayments = payments.filter(p => p.status === 'pending').length;
    
    // Calculate total paid
    const totalAmountPaid = payments
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + p.amount, 0);
    
    const stats = {
      bowlers: {
        total: bowlers.length,
        active: activeBowlers
      },
      leagues: {
        total: leagues.length,
        active: activeLeagues
      },
      teams: {
        total: teams.length,
        active: activeTeams
      },
      payments: {
        total: payments.length,
        paid: paidPayments,
        pending: pendingPayments,
        totalAmountPaid
      },
      recentPayments
    };

    sendSuccess(res, stats);
  } catch (error) {
    log.error('Error fetching admin dashboard stats:', error);
    sendError(res, 'Failed to fetch admin dashboard stats');
  }
});

router.get('/email-templates', requireAdmin, async (req, res) => {
  try {
    const templates = await storage.getEmailTemplates();
    sendSuccess(res, templates);
  } catch (error) {
    log.error('Error fetching email templates:', error);
    sendError(res, 'Failed to fetch email templates');
  }
});

router.get('/email-templates/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid template ID', 400, 'InvalidRequest');
    }
    const template = await storage.getEmailTemplate(id);
    if (!template) {
      return sendError(res, 'Email template not found', 404, 'NOT_FOUND');
    }
    sendSuccess(res, template);
  } catch (error) {
    log.error('Error fetching email template:', error);
    sendError(res, 'Failed to fetch email template');
  }
});

router.patch('/email-templates/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid template ID', 400, 'InvalidRequest');
    }
    const existing = await storage.getEmailTemplate(id);
    if (!existing) {
      return sendError(res, 'Email template not found', 404, 'NOT_FOUND');
    }
    const validated = updateEmailTemplateSchema.parse(req.body);
    const updated = await storage.updateEmailTemplate(id, validated);
    sendSuccess(res, updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    log.error('Error updating email template:', error);
    sendError(res, 'Failed to update email template');
  }
});

router.post('/email-templates/:id/send-test', requireAdmin, emailTestLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid template ID', 400, 'InvalidRequest');
    }
    const { toEmail, organizationId } = req.body;
    if (!toEmail || typeof toEmail !== 'string') {
      return sendError(res, 'Email address is required', 400, 'InvalidRequest');
    }
    const template = await storage.getEmailTemplate(id);
    if (!template) {
      return sendError(res, 'Email template not found', 404, 'NOT_FOUND');
    }
    let organization = undefined;
    if (organizationId) {
      organization = await storage.getOrganization(parseInt(organizationId, 10));
    }
    const success = await sendTestEmail(template, toEmail, organization);
    if (success) {
      sendSuccess(res, { message: `Test email sent to ${toEmail}` });
    } else {
      sendError(res, 'Failed to send test email. Check SendGrid configuration.', 500, 'SendFailed');
    }
  } catch (error) {
    log.error('Error sending test email:', error);
    sendError(res, 'Failed to send test email');
  }
});

// =============================================================================
// Task #667: Admin claim of self-registered users
//
// When a bowler self-registers via /api/auth/register but the system can't
// auto-link them to an existing roster bowler (different name spelling, new
// to the league, etc.), the user is left with `bowlerId = null` and parked
// on /registration-complete. These routes give org_admin / system_admin a
// surface to triage that backlog: list the unlinked self-registered users
// for their org, then either CREATE a fresh bowler row (when the user
// genuinely is new) or LINK to an existing unlinked bowler (when the user
// already has a roster entry under a different spelling).
//
// Both write paths assign a league + team in the same atomic transaction
// as the bowler/link mutation so a partial failure can't leave a bowler
// unassigned. After the write commits the user is notified by templated
// email (`admin_claim_complete`); send is best-effort — silent no-op if
// the template isn't configured (matches existing sendTemplatedEmail
// contract — `false` return on missing slug).
//
// Authorization: this router is mounted behind `requireOrgAdmin` so any
// authenticated org_admin or system_admin can reach these routes. The
// helper below ALSO scopes by organizationId for org_admins (system_admin
// may pass `?organizationId=N` to target a specific org). Cross-org
// targets are rejected with 403.
// =============================================================================

function resolveAdminOrgId(
  req: Request,
  res: Response,
): { orgId: number; isSystemAdmin: boolean } | null {
  const actor = req.user;
  if (!actor) {
    sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    return null;
  }
  const isSystemAdmin = actor.role === 'system_admin';
  const queryOrgIdRaw = req.query.organizationId;
  const queryOrgId = typeof queryOrgIdRaw === 'string' ? parseInt(queryOrgIdRaw, 10) : NaN;

  if (isSystemAdmin) {
    if (Number.isFinite(queryOrgId) && queryOrgId > 0) {
      return { orgId: queryOrgId, isSystemAdmin };
    }
    if (actor.organizationId) {
      return { orgId: actor.organizationId, isSystemAdmin };
    }
    sendError(res, 'organizationId is required for system_admin requests', 400, 'ORG_REQUIRED');
    return null;
  }

  // org_admin: ignore any query org override and use their own org.
  if (!actor.organizationId) {
    sendError(res, 'Organization context missing', 403, 'ORG_REQUIRED');
    return null;
  }
  return { orgId: actor.organizationId, isSystemAdmin };
}

const createBowlerForUserSchema = z.object({
  leagueId: z.number().int().positive(),
  teamId: z.number().int().positive(),
});

const linkExistingBowlerSchema = z.object({
  bowlerId: z.number().int().positive(),
  leagueId: z.number().int().positive().optional(),
  teamId: z.number().int().positive().optional(),
}).refine(
  (v) => (v.leagueId === undefined) === (v.teamId === undefined),
  { message: 'leagueId and teamId must be provided together', path: ['teamId'] },
);

interface UnlinkedUserRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  organizationId: number | null;
  createdAt?: string | null;
}

/**
 * List self-registered users that have not yet been linked to a bowler.
 * Scoped to the actor's organization (or `?organizationId=` for
 * system_admin). Filters to role='user' so admins (who never have a
 * bowlerId either by design) don't pollute the list.
 */
router.get('/unclaimed-users', async (req, res) => {
  try {
    const ctx = resolveAdminOrgId(req, res);
    if (!ctx) return;

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        organizationId: users.organizationId,
      })
      .from(users)
      .where(and(
        isNull(users.bowlerId),
        eq(users.role, 'user'),
        eq(users.organizationId, ctx.orgId),
      ))
      .orderBy(users.id);

    sendSuccess(res, rows as UnlinkedUserRow[]);
  } catch (error) {
    log.error('Error listing unclaimed users:', error);
    sendError(res, 'Failed to list unclaimed users');
  }
});

async function notifyAccountReady(opts: {
  toEmail: string;
  toName: string;
  bowlerName: string;
  leagueName: string;
  teamName: string;
  organizationId: number | null;
}): Promise<void> {
  try {
    const organization = opts.organizationId
      ? await storage.getOrganization(opts.organizationId)
      : undefined;
    const baseUrl = getBaseUrl(organization?.slug ?? undefined);
    await sendTemplatedEmail('admin_claim_complete', opts.toEmail, {
      user_name: opts.toName,
      bowler_name: opts.bowlerName,
      league_name: opts.leagueName,
      team_name: opts.teamName,
      organization_name: organization?.name ?? '',
      organization_logo_url: organization ? getOrgLogoUrl(organization) : '',
      dashboard_link: `${baseUrl}/bowler-dashboard`,
      login_link: `${baseUrl}/login`,
    });
  } catch (err) {
    // Best-effort notify — never fail the admin write because of email.
    log.warn('admin_claim_complete email failed (non-fatal):', err);
  }
}

/**
 * Create a new bowler for an unlinked user and assign them to the
 * requested league/team — atomically with the user→bowler link.
 *
 * The whole flow runs inside a single `db.transaction(...)` that:
 *   1. Re-reads the target user FOR UPDATE and re-asserts org match +
 *      bowlerId IS NULL inside the lock so racing requests can't both
 *      create a bowler.
 *   2. Validates league + team belong to the same org as the user.
 *   3. Inserts the bowler (org-stamped from the user).
 *   4. Locks the team row and inserts the bowler_leagues row at
 *      max(order)+1, mirroring `createBowlerLeagueIfNotInLeague`.
 *   5. Sets users.bowler_id = newBowler.id.
 *
 * If any step throws, the whole txn rolls back — no orphaned bowlers,
 * no half-linked users.
 */
router.post('/unclaimed-users/:userId/create-bowler', async (req, res) => {
  try {
    const ctx = resolveAdminOrgId(req, res);
    if (!ctx) return;

    const userId = parseInt(singleRouteParam(req.params.userId), 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendError(res, 'Invalid user ID', 400, 'InvalidRequest');
    }
    const body = createBowlerForUserSchema.parse(req.body);

    const result = await db.transaction(async (tx) => {
      // Lock the user row so concurrent admin requests serialize.
      await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);

      const [targetUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!targetUser) {
        throw new HttpError(404, 'NOT_FOUND', 'User not found');
      }
      if (targetUser.organizationId !== ctx.orgId) {
        throw new HttpError(403, 'CROSS_ORG_DENIED', 'User belongs to a different organization');
      }
      if (targetUser.bowlerId !== null) {
        throw new HttpError(409, 'ALREADY_LINKED', 'User is already linked to a bowler');
      }

      const [league] = await tx.select().from(leagues).where(eq(leagues.id, body.leagueId)).limit(1);
      if (!league || league.organizationId !== ctx.orgId) {
        throw new HttpError(400, 'INVALID_LEAGUE', 'League not found in this organization');
      }
      const [team] = await tx.select().from(teams).where(eq(teams.id, body.teamId)).limit(1);
      if (!team || team.leagueId !== body.leagueId) {
        throw new HttpError(400, 'INVALID_TEAM', 'Team not found in the selected league');
      }

      const [newBowler] = await tx
        .insert(bowlers)
        .values({
          name: targetUser.name,
          email: targetUser.email,
          phone: targetUser.phone ?? null,
          active: true,
          organizationId: ctx.orgId,
        })
        .returning();

      // Lock team for max(order) computation, mirroring createBowlerLeague.
      await tx.execute(sql`SELECT id FROM ${teams} WHERE id = ${body.teamId} FOR UPDATE`);
      const [maxOrder] = await tx
        .select({ maxOrder: sql<number>`max(${bowlerLeagues.order})` })
        .from(bowlerLeagues)
        .where(eq(bowlerLeagues.teamId, body.teamId));
      const order = (maxOrder?.maxOrder ?? -1) + 1;

      await tx.insert(bowlerLeagues).values({
        bowlerId: newBowler.id,
        leagueId: body.leagueId,
        teamId: body.teamId,
        active: true,
        order,
      });

      await tx
        .update(users)
        .set({ bowlerId: newBowler.id })
        .where(eq(users.id, userId));

      return { user: targetUser, bowler: newBowler, league, team };
    });

    cacheInvalidate('bowlers:');
    cacheInvalidate(`user:${userId}`);

    await notifyAccountReady({
      toEmail: result.user.email,
      toName: result.user.name,
      bowlerName: result.bowler.name,
      leagueName: result.league.name,
      teamName: result.team.name,
      organizationId: ctx.orgId,
    });

    sendSuccess(res, {
      userId: result.user.id,
      bowlerId: result.bowler.id,
      leagueId: result.league.id,
      teamId: result.team.id,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return sendError(res, error.message, error.status, error.code);
    }
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    log.error('Error creating bowler for unclaimed user:', error);
    sendError(res, 'Failed to create bowler');
  }
});

/**
 * Link an unlinked self-registered user to an existing UNLINKED bowler in
 * the same organization. Optionally adds the bowler to a league/team in
 * the same atomic txn.
 */
router.post('/unclaimed-users/:userId/link-existing', async (req, res) => {
  try {
    const ctx = resolveAdminOrgId(req, res);
    if (!ctx) return;

    const userId = parseInt(singleRouteParam(req.params.userId), 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendError(res, 'Invalid user ID', 400, 'InvalidRequest');
    }
    const body = linkExistingBowlerSchema.parse(req.body);

    const result = await db.transaction(async (tx) => {
      // Lock both rows so concurrent admin claims for either side serialize.
      await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${bowlers} WHERE id = ${body.bowlerId} FOR UPDATE`);

      const [targetUser] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!targetUser) {
        throw new HttpError(404, 'NOT_FOUND', 'User not found');
      }
      if (targetUser.organizationId !== ctx.orgId) {
        throw new HttpError(403, 'CROSS_ORG_DENIED', 'User belongs to a different organization');
      }
      if (targetUser.bowlerId !== null) {
        throw new HttpError(409, 'ALREADY_LINKED', 'User is already linked to a bowler');
      }

      const [targetBowler] = await tx.select().from(bowlers).where(eq(bowlers.id, body.bowlerId)).limit(1);
      if (!targetBowler) {
        throw new HttpError(404, 'BOWLER_NOT_FOUND', 'Bowler not found');
      }
      if (targetBowler.organizationId !== ctx.orgId) {
        throw new HttpError(403, 'CROSS_ORG_DENIED', 'Bowler belongs to a different organization');
      }

      // Refuse if some other user already claims this bowler.
      const [conflict] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.bowlerId, body.bowlerId))
        .limit(1);
      if (conflict) {
        throw new HttpError(409, 'BOWLER_TAKEN', 'Bowler is already linked to another user');
      }

      let assignedLeague: { id: number; name: string } | null = null;
      let assignedTeam: { id: number; name: string } | null = null;

      if (body.leagueId !== undefined && body.teamId !== undefined) {
        const [league] = await tx.select().from(leagues).where(eq(leagues.id, body.leagueId)).limit(1);
        if (!league || league.organizationId !== ctx.orgId) {
          throw new HttpError(400, 'INVALID_LEAGUE', 'League not found in this organization');
        }
        const [team] = await tx.select().from(teams).where(eq(teams.id, body.teamId)).limit(1);
        if (!team || team.leagueId !== body.leagueId) {
          throw new HttpError(400, 'INVALID_TEAM', 'Team not found in the selected league');
        }
        assignedLeague = { id: league.id, name: league.name };
        assignedTeam = { id: team.id, name: team.name };

        const existingLink = await tx
          .select({ id: bowlerLeagues.id })
          .from(bowlerLeagues)
          .where(and(
            eq(bowlerLeagues.bowlerId, body.bowlerId),
            eq(bowlerLeagues.leagueId, body.leagueId),
            eq(bowlerLeagues.active, true),
          ))
          .limit(1);

        if (existingLink.length === 0) {
          await tx.execute(sql`SELECT id FROM ${teams} WHERE id = ${body.teamId} FOR UPDATE`);
          const [maxOrder] = await tx
            .select({ maxOrder: sql<number>`max(${bowlerLeagues.order})` })
            .from(bowlerLeagues)
            .where(eq(bowlerLeagues.teamId, body.teamId));
          const order = (maxOrder?.maxOrder ?? -1) + 1;
          await tx.insert(bowlerLeagues).values({
            bowlerId: body.bowlerId,
            leagueId: body.leagueId,
            teamId: body.teamId,
            active: true,
            order,
          });
        }
      }

      await tx
        .update(users)
        .set({ bowlerId: body.bowlerId })
        .where(eq(users.id, userId));

      return { user: targetUser, bowler: targetBowler, league: assignedLeague, team: assignedTeam };
    });

    cacheInvalidate('bowlers:');
    cacheInvalidate(`user:${userId}`);

    await notifyAccountReady({
      toEmail: result.user.email,
      toName: result.user.name,
      bowlerName: result.bowler.name,
      leagueName: result.league?.name ?? '',
      teamName: result.team?.name ?? '',
      organizationId: ctx.orgId,
    });

    sendSuccess(res, {
      userId: result.user.id,
      bowlerId: result.bowler.id,
      leagueId: result.league?.id ?? null,
      teamId: result.team?.id ?? null,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return sendError(res, error.message, error.status, error.code);
    }
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    log.error('Error linking unclaimed user to existing bowler:', error);
    sendError(res, 'Failed to link bowler');
  }
});

/**
 * Permanently delete a self-registered user that is still unclaimed
 * (role='user', bowlerId IS NULL). This is the third triage option on the
 * /admin/unclaimed-users page — for spam signups and never-completed
 * registrations the admin doesn't want to keep.
 *
 * Strict guards inside a transaction:
 *   1. Row-level lock the user FOR UPDATE so we re-read state under the
 *      lock (a racing claim/link can't slip in after our preflight).
 *   2. Org match (org_admin can only delete in their own org;
 *      system_admin already routed via resolveAdminOrgId).
 *   3. role === 'user' (refuse if they were promoted to org_admin /
 *      system_admin between page load and click).
 *   4. bowlerId IS NULL (refuse if a sibling claim/link landed first).
 *   5. Delegate to storage.deleteUser, which nulls the audit FKs we
 *      preserve (apple_pay_jobs.created_by, deletion_requests.reviewed_by)
 *      and refuses on any orphan_cleanup_audits rows.
 *
 * Rate-limited via adminWriteLimiter.
 */
router.delete('/unclaimed-users/:userId', adminWriteLimiter, async (req, res) => {
  try {
    const ctx = resolveAdminOrgId(req, res);
    if (!ctx) return;

    const userId = parseInt(singleRouteParam(req.params.userId), 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendError(res, 'Invalid user ID', 400, 'InvalidRequest');
    }

    // Hold the row lock end-to-end across both the precondition checks
    // and storage.deleteUser so a concurrent /create-bowler or
    // /link-existing can't slip a bowlerId onto this user between the
    // check and the delete.
    const deleted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);
      const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!row) {
        throw new HttpError(404, 'NOT_FOUND', 'User not found');
      }
      if (row.organizationId !== ctx.orgId) {
        throw new HttpError(403, 'CROSS_ORG_DENIED', 'User belongs to a different organization');
      }
      if (row.role !== 'user') {
        throw new HttpError(409, 'NOT_UNCLAIMED', 'User is not an unclaimed self-registered account');
      }
      if (row.bowlerId !== null) {
        throw new HttpError(409, 'ALREADY_LINKED', 'User has already been linked to a bowler');
      }
      return storage.deleteUser(row.id, tx);
    });

    cacheInvalidate(`user:${userId}`);
    log.info('Unclaimed user deleted', {
      deletedUserId: deleted.id,
      deletedEmail: deleted.email,
      actingUserId: req.user?.id,
      orgId: ctx.orgId,
    });

    sendSuccess(res, { id: deleted.id, email: deleted.email });
  } catch (error) {
    if (error instanceof HttpError) {
      return sendError(res, error.message, error.status, error.code);
    }
    const errObj = (error && typeof error === 'object') ? error as { name?: string; message?: string } : {};
    if (errObj.name === 'CannotDeleteAdminError') {
      return sendError(res, errObj.message ?? 'Cannot delete admin', 403, 'forbidden');
    }
    if (errObj.name === 'UserHasAuditTrailError') {
      return sendError(res, errObj.message ?? 'Audit trail conflict', 409, 'AUDIT_TRAIL_CONFLICT');
    }
    log.error('Error deleting unclaimed user:', error);
    sendError(res, 'Failed to delete unclaimed user');
  }
});

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export default router;
