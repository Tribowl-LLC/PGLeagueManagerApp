import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sendSuccess, sendError, sanitizeUser, handleZodError, handleUserOrgError } from '../utils/api.js';
import { singleRouteParam } from '../utils/route-params';
import { storage } from '../storage';
import { db } from '../db';
import {
  countOrphanedRows,
  listOrphanedLeagues,
  listOrphanedTeams,
  listOrphanedBowlerLeagues,
  listOrphanedPayments,
  listOrphanedUsers,
  reassignOrphanedLeague,
  reassignOrphanedUser,
  undoReassignLeague,
  undoReassignUser,
  deleteOrphanedLeague,
  deleteOrphanedTeam,
  deleteOrphanedBowlerLeague,
  deleteOrphanedPayment,
  deleteOrphanedUser,
  recordOrphanCleanupAudit,
  getOrphanCleanupAuditById,
  markOrphanCleanupAuditUndone,
  listOrphanCleanupAudits,
  NotOrphanedError,
  OrphanRowNotFoundError,
  RowChangedSinceAuditError,
  type OrphanedResourceType,
} from '../storage/orphaned-data';
import { requireAdmin } from '../middleware/admin.js';
import { verifyTrustProxy } from '../lib/trust-proxy-check.js';
import { createLogger } from '../logger';
import {
  updateDeletionRequestStatusSchema,
  executeDeletionRequestSchema,
  DELETION_REQUEST_STATUSES,
  type DeletionRequestStatus,
} from '@shared/schema';
import { executeAccountDeletion } from '../services/account-deletion.js';
import {
  listAdminEmailChangeAudits,
  countAdminEmailChangeAudits,
  clampListLimit as clampAdminEmailChangeAuditListLimit,
} from '../storage/admin-email-change-audits';

const log = createLogger("SystemAdmin");

const router = Router();

router.post('/create/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }
    
    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    }

    if (user.role === 'system_admin') {
      return sendError(res, 'User is already a system admin', 400, 'ALREADY_SYSTEM_ADMIN');
    }
    
    const updatedUser = await storage.updateUserRole(userId, 'system_admin');
    sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error('Error creating system admin:', error);
    sendError(res, 'Failed to create system admin', 500, 'SERVER_ERROR');
  }
});

router.get('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await storage.getUsers();
    const systemAdmins = users.filter(user => user.role === 'system_admin');
    sendSuccess(res, systemAdmins.map(sanitizeUser));
  } catch (error) {
    log.error('Error fetching system admins:', error);
    sendError(res, 'Failed to fetch system admins', 500, 'SERVER_ERROR');
  }
});

router.post('/revoke/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }
    
    const user = await storage.getUser(userId);
    if (!user) {
      return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    }

    const users = await storage.getUsers();
    const systemAdmins = users.filter(u => u.role === 'system_admin');
    
    if (systemAdmins.length <= 1 && systemAdmins.some(admin => admin.id === userId)) {
      return sendError(res, 'Cannot revoke the last system admin', 400, 'LAST_SYSTEM_ADMIN');
    }

    if (req.user?.id === userId) {
      return sendError(res, 'Cannot revoke your own system admin access', 400, 'SELF_REVOKE_NOT_ALLOWED');
    }
    
    const updatedUser = await storage.updateUserRole(userId, 'user');
    sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error('Error revoking system admin:', error);
    sendError(res, 'Failed to revoke system admin privileges', 500, 'SERVER_ERROR');
  }
});

// Account deletion request management (system admin only)

// Lightweight count endpoint for the in-app sidebar badge. Polled
// frequently by the admin layout — keep it cheap (no row payload).
router.get('/deletion-requests/pending-count', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const count = await storage.countDeletionRequests({ status: 'pending' });
    sendSuccess(res, { count });
  } catch (error) {
    log.error('Error counting pending deletion requests:', error);
    sendError(res, 'Failed to count deletion requests', 500, 'SERVER_ERROR');
  }
});

router.get('/deletion-requests', requireAdmin, async (req: Request, res: Response) => {
  try {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status = statusParam && (DELETION_REQUEST_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as DeletionRequestStatus)
      : undefined;
    const rows = await storage.listDeletionRequests(status ? { status } : undefined);
    sendSuccess(res, rows);
  } catch (error) {
    log.error('Error listing deletion requests:', error);
    sendError(res, 'Failed to list deletion requests', 500, 'SERVER_ERROR');
  }
});

router.patch('/deletion-requests/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid request ID', 400, 'INVALID_ID');
    }

    const parsed = updateDeletionRequestStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return handleZodError(res, parsed.error);
    }

    const existing = await storage.getDeletionRequest(id);
    if (!existing) {
      return sendError(res, 'Deletion request not found', 404, 'NOT_FOUND');
    }
    if (existing.status !== 'pending') {
      return sendError(res, 'Request has already been reviewed', 400, 'ALREADY_REVIEWED');
    }

    const reviewerId = req.user?.id;
    if (!reviewerId) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    const updated = await storage.updateDeletionRequestStatus(
      id,
      parsed.data.status,
      reviewerId,
      parsed.data.adminNote ?? null,
    );
    sendSuccess(res, updated);
  } catch (error) {
    log.error('Error updating deletion request:', error);
    sendError(res, 'Failed to update deletion request', 500, 'SERVER_ERROR');
  }
});

// Automated account-data deletion. Performs the actual scrub of bowler
// rows, payment-provider customer records, pending email-change
// requests, and the user account, then marks the originating deletion
// request as completed with a JSON audit summary attached. Requires an
// explicit `confirm: "DELETE"` field in the body so a stray empty POST
// cannot trigger the destructive flow.
router.post('/deletion-requests/:id/execute', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid request ID', 400, 'INVALID_ID');
    }

    const parsed = executeDeletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return handleZodError(res, parsed.error);
    }

    const reviewerId = req.user?.id;
    if (!reviewerId) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    const existing = await storage.getDeletionRequest(id);
    if (!existing) {
      return sendError(res, 'Deletion request not found', 404, 'NOT_FOUND');
    }
    if (existing.status !== 'pending') {
      return sendError(res, 'Request has already been reviewed', 400, 'ALREADY_REVIEWED');
    }

    // Task #349: forward the requester's opt-out preference so the
    // service can skip the SendGrid confirmation email when they
    // unchecked the box on the public deletion-request form.
    const summary = await executeAccountDeletion(
      existing.email,
      reviewerId,
      existing.notifyOnCompletion,
    );
    const updated = await storage.completeDeletionRequestWithExecution(
      id,
      reviewerId,
      JSON.stringify(summary),
      parsed.data.adminNote ?? null,
    );
    sendSuccess(res, { request: updated, summary });
  } catch (error) {
    log.error('Error executing deletion request:', error);
    sendError(res, 'Failed to execute deletion request', 500, 'SERVER_ERROR');
  }
});

// Diagnostic endpoint: counts of org-less ("orphaned") rows per resource type.
// Per the access-control policy, normal CRUD paths deny access to rows with
// `organization_id IS NULL`. This endpoint is the explicit, opt-in admin tool
// that surfaces those rows so data-integrity issues are visible.
router.get('/orphaned-data-counts', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const counts = await countOrphanedRows();
    sendSuccess(res, counts);
  } catch (error) {
    log.error('Error counting orphaned rows:', error);
    sendError(res, 'Failed to count orphaned rows', 500, 'SERVER_ERROR');
  }
});

// Drill-down list endpoints for the data-integrity admin panel. Like the
// counts endpoint above, these are explicit "orphaned data" handlers that
// surface rows the regular CRUD paths intentionally hide.
const ORPHAN_TYPES: readonly OrphanedResourceType[] = [
  'leagues', 'teams', 'bowlerLeagues', 'payments', 'users',
] as const;

function parseOrphanType(raw: string): OrphanedResourceType | null {
  return (ORPHAN_TYPES as readonly string[]).includes(raw)
    ? (raw as OrphanedResourceType)
    : null;
}

router.get('/orphaned-data/:type', requireAdmin, async (req: Request, res: Response) => {
  const type = parseOrphanType(singleRouteParam(req.params.type));
  if (!type) return sendError(res, 'Invalid resource type', 400, 'INVALID_TYPE');
  try {
    const rows = await (
      type === 'leagues' ? listOrphanedLeagues() :
      type === 'teams' ? listOrphanedTeams() :
      type === 'bowlerLeagues' ? listOrphanedBowlerLeagues() :
      type === 'payments' ? listOrphanedPayments() :
      listOrphanedUsers()
    );
    sendSuccess(res, rows);
  } catch (error) {
    log.error(`Error listing orphaned ${type}:`, error);
    sendError(res, 'Failed to list orphaned rows', 500, 'SERVER_ERROR');
  }
});

const reassignBodySchema = z.object({
  organizationId: z.number().int().positive(),
});

function handleRepairError(res: Response, error: unknown, action: string, type: string) {
  if (error instanceof OrphanRowNotFoundError) {
    return sendError(res, error.message, 404, 'NOT_FOUND');
  }
  if (error instanceof NotOrphanedError) {
    return sendError(res, 'Row is not orphaned and cannot be repaired here', 409, 'NOT_ORPHANED');
  }
  if (error instanceof RowChangedSinceAuditError) {
    return sendError(res, 'Row has been modified since the cleanup; refusing to undo', 409, 'ROW_CHANGED');
  }
  log.error(`Error ${action} orphaned ${type}:`, error);
  sendError(res, `Failed to ${action} orphaned row`, 500, 'SERVER_ERROR');
}

router.post('/orphaned-data/:type/:id/reassign', requireAdmin, async (req: Request, res: Response) => {
  const type = parseOrphanType(singleRouteParam(req.params.type));
  if (!type) return sendError(res, 'Invalid resource type', 400, 'INVALID_TYPE');
  if (type !== 'leagues' && type !== 'users') {
    return sendError(res, 'Reassignment is only supported for leagues and users; child rows inherit their org from the parent league', 400, 'REASSIGN_UNSUPPORTED');
  }
  const id = parseInt(singleRouteParam(req.params.id), 10);
  if (isNaN(id)) return sendError(res, 'Invalid id', 400, 'INVALID_ID');
  const adminUserId = req.user?.id;
  if (!adminUserId) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  const parsed = reassignBodySchema.safeParse(req.body);
  if (!parsed.success) return handleZodError(res, parsed.error);
  try {
    await db.transaction(async (tx) => {
      const result = type === 'leagues'
        ? await reassignOrphanedLeague(id, parsed.data.organizationId, tx)
        : await reassignOrphanedUser(id, parsed.data.organizationId, tx);
      await recordOrphanCleanupAudit(
        {
          adminUserId,
          resourceType: type,
          resourceId: id,
          action: 'reassign',
          organizationId: parsed.data.organizationId,
          previousOrganizationId: result.previousOrganizationId,
        },
        tx,
      );
    });
    sendSuccess(res, { id, organizationId: parsed.data.organizationId });
  } catch (error) {
    handleRepairError(res, error, 'reassign', type);
  }
});

router.post('/orphaned-data/:type/:id/delete', requireAdmin, async (req: Request, res: Response) => {
  const type = parseOrphanType(singleRouteParam(req.params.type));
  if (!type) return sendError(res, 'Invalid resource type', 400, 'INVALID_TYPE');
  const id = parseInt(singleRouteParam(req.params.id), 10);
  if (isNaN(id)) return sendError(res, 'Invalid id', 400, 'INVALID_ID');
  const adminUserId = req.user?.id;
  if (!adminUserId) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  try {
    await db.transaction(async (tx) => {
      const snapshot = await (
        type === 'leagues' ? deleteOrphanedLeague(id, tx) :
        type === 'teams' ? deleteOrphanedTeam(id, tx) :
        type === 'bowlerLeagues' ? deleteOrphanedBowlerLeague(id, tx) :
        type === 'payments' ? deleteOrphanedPayment(id, tx) :
        deleteOrphanedUser(id, tx)
      );
      await recordOrphanCleanupAudit(
        {
          adminUserId,
          resourceType: type,
          resourceId: id,
          action: 'delete',
          organizationId: null,
          snapshot,
        },
        tx,
      );
    });
    sendSuccess(res, { id, deleted: true });
  } catch (error) {
    handleRepairError(res, error, 'delete', type);
  }
});

// Undo a previous reassign cleanup directly from the activity log. Looks up
// the original audit row, sets the resource back to its prior org (recorded
// at reassign time — null for a true orphan), marks the original audit row
// as undone, and writes a fresh `undo_reassign` audit row so the history
// remains traceable. Refuses to undo deletes (use the snapshot instead),
// re-undo a row that's already undone, or undo if the row has been moved
// out of the org we put it in (preventing an unrelated change from being
// silently reverted).
router.post('/orphaned-data-audits/:id/undo', requireAdmin, async (req: Request, res: Response) => {
    const auditId = parseInt(singleRouteParam(req.params.id), 10);
  if (isNaN(auditId)) return sendError(res, 'Invalid audit id', 400, 'INVALID_ID');
  const adminUserId = req.user?.id;
  if (!adminUserId) return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');

  try {
    const audit = await getOrphanCleanupAuditById(auditId);
    if (!audit) return sendError(res, 'Audit row not found', 404, 'NOT_FOUND');
    if (audit.action !== 'reassign') {
      return sendError(
        res,
        'Only reassign actions can be undone. For deletes, use the snapshot to reconstruct the row manually.',
        400,
        'UNDO_UNSUPPORTED',
      );
    }
    if (audit.undoneAt !== null) {
      return sendError(res, 'This cleanup has already been undone', 409, 'ALREADY_UNDONE');
    }
    if (audit.organizationId === null) {
      return sendError(res, 'Audit row is missing the org it reassigned to; cannot undo safely', 409, 'AUDIT_INCOMPLETE');
    }
    if (audit.resourceType !== 'leagues' && audit.resourceType !== 'users') {
      return sendError(res, 'Only league or user reassigns can be undone', 400, 'UNDO_UNSUPPORTED');
    }

    await db.transaction(async (tx) => {
      if (audit.resourceType === 'leagues') {
        await undoReassignLeague(audit.resourceId, audit.organizationId!, audit.previousOrganizationId, tx);
      } else {
        await undoReassignUser(audit.resourceId, audit.organizationId!, audit.previousOrganizationId, tx);
      }
      const undoEntry = await recordOrphanCleanupAudit(
        {
          adminUserId,
          resourceType: audit.resourceType as OrphanedResourceType,
          resourceId: audit.resourceId,
          action: 'undo_reassign',
          // The org we moved the row OUT of when undoing (i.e. the org it had
          // been reassigned into). Records the change in the same shape as a
          // reassign for easy display in the activity log.
          organizationId: audit.previousOrganizationId,
          previousOrganizationId: audit.organizationId,
        },
        tx,
      );
      await markOrphanCleanupAuditUndone(audit.id, undoEntry.id, tx);
    });
    sendSuccess(res, { id: auditId, undone: true });
  } catch (error) {
    handleRepairError(res, error, 'undo', 'audit');
  }
});

// Read-only history of admin-initiated email-change requests (task #325
// writes a row each time a system admin reroutes another user's login
// email; task #375 surfaces those rows here for support triage). The
// emails are stored already-masked, so this endpoint just returns the
// joined display names alongside the row — the live `users.email`
// values are intentionally NOT exposed because they may have changed
// since the audit was written and would mislead the reader.
router.get('/admin-email-change-audits', requireAdmin, async (req: Request, res: Response) => {
  try {
    const rawTarget = typeof req.query.targetUserId === 'string'
      ? parseInt(req.query.targetUserId, 10)
      : NaN;
    const targetUserId = Number.isFinite(rawTarget) && rawTarget > 0 ? rawTarget : undefined;

    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const requestedLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    // Echo the *effective* (clamped) limit so the client's pagination
    // math stays honest when a caller asks for more than the cap.
    const limit = clampAdminEmailChangeAuditListLimit(requestedLimit);
    const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const [rows, total] = await Promise.all([
      listAdminEmailChangeAudits({ targetUserId, limit, offset }),
      countAdminEmailChangeAudits({ targetUserId }),
    ]);
    sendSuccess(res, { rows, total, limit, offset });
  } catch (error) {
    log.error('Error listing admin email change audits:', error);
    sendError(res, 'Failed to list admin email change audits', 500, 'SERVER_ERROR');
  }
});

// Debug endpoint for the post-deploy trust-proxy smoke test (task
// #379). The boot guard at `assertTrustProxyAtBoot` catches code-side
// misconfiguration on startup, but a config change at the proxy layer
// (Replit edge, custom domain, future CDN) can re-introduce the bug
// without any code change. This endpoint exposes:
//
//   - `live`: what THIS request actually resolved to — the real
//     `req.ip` Express chose given the configured trust-proxy hop
//     count and the X-Forwarded-For header on the wire. A post-deploy
//     probe calling from a known external IP can compare and assert
//     they match (and definitely aren't loopback/private — which
//     would mean per-IP rate limiters are keying on the proxy).
//   - `config`: the configured `app.get('trust proxy')` value (raw
//     setting OR the compiled function's hop count if numeric).
//   - `synthetic`: the same `verifyTrustProxy` probe used at boot,
//     so the endpoint is also useful as an at-rest invariant check
//     without needing a known caller IP.
//
// Auth: two paths are accepted by the mount-layer wrapper
// `trustProxyProbeAuth` in `server/routes/index.ts`, NOT by a per-
// route middleware here. Per-route middleware would be unreachable
// because the mount-level `requireSystemAdmin` runs first and would
// reject a token-only caller before this router was ever entered.
//
//   1. A valid system_admin session (the original contract — humans
//      hitting the endpoint from a logged-in browser).
//   2. A constant-time match on the `X-Probe-Token` header against
//      the `TRUST_PROXY_PROBE_TOKEN` env var. This is how the
//      post-deploy CI probe authenticates so it does not need a
//      rotating session cookie (sessions expire after ~24h — see
//      `cookie.maxAge` in `server/auth.ts`). The token is a long-
//      lived shared secret deployed alongside the app and pasted
//      into the probe runner's secret store.
//
// system_admin only because `req.ip` and the raw XFF header can be
// considered PII / network metadata that we don't want exposed to a
// regular user. The token path inherits the same trust level — the
// token MUST be treated as a system_admin credential.
//
// The handler itself is registered without a per-route auth guard
// because the mount-layer wrapper has already enforced one of the
// two paths above by the time we get here.
router.get('/trust-proxy-status', async (req: Request, res: Response) => {
  try {
    const trustSetting = req.app.get('trust proxy');
    const xff = typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for']
      : Array.isArray(req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'].join(', ')
        : null;
    // Bound the echoed XFF in case an upstream client crafts a huge
    // header. 256 chars is plenty to debug a real proxy chain.
    const xffTruncated = xff && xff.length > 256 ? `${xff.slice(0, 256)}…` : xff;

    // `verifyTrustProxy` now accepts the bare `Application` shape it
    // actually uses (just `.get(...)`), so `req.app` flows through
    // without a cast.
    const synthetic = verifyTrustProxy(req.app);
    sendSuccess(res, {
      live: {
        resolvedIp: req.ip ?? null,
        socketRemoteAddress: req.socket?.remoteAddress ?? null,
        xForwardedFor: xffTruncated,
        protocol: req.protocol,
        hostname: req.hostname,
      },
      config: {
        trustProxySetting: typeof trustSetting === 'function'
          ? '[function]'
          : trustSetting ?? null,
      },
      synthetic: {
        ok: synthetic.ok,
        resolvedIp: synthetic.resolvedIp,
        reason: synthetic.reason ?? null,
      },
    });
  } catch (error) {
    log.error('Error reporting trust-proxy status:', error);
    sendError(res, 'Failed to report trust-proxy status', 500, 'SERVER_ERROR');
  }
});

// Recent activity feed for the data integrity admin panel.
router.get('/orphaned-data-audits', requireAdmin, async (req: Request, res: Response) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
    const rows = await listOrphanCleanupAudits(limit);
    sendSuccess(res, rows);
  } catch (error) {
    log.error('Error listing orphan cleanup audits:', error);
    sendError(res, 'Failed to list orphan cleanup audits', 500, 'SERVER_ERROR');
  }
});

export default router;
