/**
 * Payment reporting endpoints (mounted under /api/payments).
 *
 * Currently exposes the list/filter endpoint used to build payment reports
 * for bowlers, leagues, teams, and organizations.
 */
import { Router } from 'express';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { storage } from '../../storage';
import { db } from '../../db.js';
import { users, type Payment } from '@shared/schema';
import {
  sendSuccess,
  sendError,
  sendPaginatedSuccess,
  parsePaginationParams,
  parseOptionalIntParam,
  parseOptionalDateParam,
  sanitizePayments,
} from '../../utils/api.js';
import { hasAdminAccessToLeague } from '../../utils/access-control.js';
import { createLogger } from '../../logger';
import { listPaymentDisputeSummariesForPayments } from '../../storage/payment-dispute-operations.js';

/**
 * build a Map<paidByUserId, displayName> for the rows in
 * `payments`. Uses the user's `name` only — never the email — so a
 * partner's address is never disclosed via paid-by attribution even
 * if a row has somehow lost its name. Returns an empty map when no
 * row carries a `paidByUserId` (autopay-attribution is sparse — most
 * rows are one-off charges and have a null `paidByUserId`).
 *
 * The lookup is **org-scoped** when an `organizationId` is supplied
 * (i.e. for non-sysadmin reads and for sysadmin reads that picked an
 * org). System-admin "all-orgs" reads (`organizationId === null`) skip
 * the org filter — those callers are already trusted to see every
 * tenant's data. This guards against a stale or cross-org
 * `paidByUserId` value leaking a foreign user's display name into an
 * org-scoped report.
 */
export async function buildPayerNameMap(
  payments: Payment[],
  organizationId: number | null,
): Promise<Map<number, string>> {
  const ids = Array.from(
    new Set(payments.map((p) => p.paidByUserId).filter((id): id is number => !!id)),
  );
  if (ids.length === 0) return new Map();
  // sysadmin all-orgs view: no extra constraint. Org-scoped view:
  // restrict to users in that org OR users with a null organizationId
  // (sysadmins who paid carry a null org and are by definition trusted
  // to be attributable inside any org's report).
  const finalWhere =
    organizationId === null
      ? inArray(users.id, ids)
      : and(
          inArray(users.id, ids),
          or(eq(users.organizationId, organizationId), isNull(users.organizationId)),
        );
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(finalWhere);
  return new Map(
    rows
      .map((r) => [r.id, r.name && r.name.trim()] as const)
      .filter((entry): entry is readonly [number, string] => !!entry[1])
      .map(([id, name]) => [id, name]),
  );
}

const log = createLogger("Payments");

const router = Router();

// Tri-state filter-parser helpers (`parseOptionalIntParam`,
// `parseOptionalDateParam`) live in `server/utils/api.ts` as of task
// #421 so every list endpoint can adopt the same contract. The
// behavior below is unchanged — same `null` → 400 short-circuit, same
// empty-string-as-no-filter regression pin in the test file.

// Get payments with optional filters
router.get("/", async (req, res) => {
  try {
    // task #406: validate every numeric/date filter up front instead
    // of forwarding NaN / Invalid Date into the storage layer (which
    // produced confusing 500s and noisy logs). Each param is
    // independently checked so the 400 message tells the caller
    // exactly which one was malformed.
    const isSystemAdmin = req.user?.role === 'system_admin';
    const rawIncludeDisputes = req.query.includeDisputes;
    if (
      rawIncludeDisputes !== undefined
      && rawIncludeDisputes !== 'true'
      && rawIncludeDisputes !== 'false'
    ) {
      return sendError(res, "Invalid includeDisputes format", 400, 'INVALID_QUERY');
    }
    const includeDisputes = rawIncludeDisputes === 'true';
    if (
      includeDisputes
      && req.user?.role !== 'org_admin'
      && req.user?.role !== 'system_admin'
    ) {
      return sendError(res, "Administrator access is required", 403, 'FORBIDDEN');
    }

    const rawQueryOrgId = parseOptionalIntParam(req.query.organizationId);
    if (rawQueryOrgId === null) {
      return sendError(res, "Invalid organization ID format", 400);
    }
    const leagueId = parseOptionalIntParam(req.query.leagueId);
    if (leagueId === null) {
      return sendError(res, "Invalid league ID format", 400);
    }
    const bowlerId = parseOptionalIntParam(req.query.bowlerId);
    if (bowlerId === null) {
      return sendError(res, "Invalid bowler ID format", 400);
    }
    const teamId = parseOptionalIntParam(req.query.teamId);
    if (teamId === null) {
      return sendError(res, "Invalid team ID format", 400);
    }
    const weekOf = parseOptionalDateParam(req.query.weekOf);
    if (weekOf === null) {
      return sendError(res, "Invalid weekOf date format", 400);
    }

    // Effective org context: explicit param > sysadmin's own org > null (unaffiliated sysadmin)
    const effectiveOrgId: number | null = isSystemAdmin
      ? (rawQueryOrgId ?? req.user?.organizationId ?? null)
      : (req.user?.organizationId ?? null);

    if (leagueId) {
      const league = await storage.getLeague(leagueId);
      if (!league) {
        return sendError(res, "League not found", 404, 'NOT_FOUND');
      }
      // Payment reports require administrator access to the league.
      if (!(await hasAdminAccessToLeague(req, leagueId))) {
        return sendError(res, "You don't have access to this league's payments", 403, 'FORBIDDEN');
      }
    }

    if (!isSystemAdmin && effectiveOrgId === null) {
      return sendSuccess(res, []);
    }

    // Plain users may only list their own bowler payments.
    let scopedBowlerId: number | null | undefined = bowlerId;
    if (!isSystemAdmin && req.user?.role !== 'org_admin' && req.user?.id) {
      if (leagueId === undefined) {
        if (!req.user.bowlerId) {
          return sendSuccess(res, []);
        }
        if (bowlerId != null && bowlerId !== req.user.bowlerId) {
          return sendSuccess(res, []);
        }
        scopedBowlerId = req.user.bowlerId;
      }
    }

    const baseFilters = {
      bowlerId: scopedBowlerId,
      leagueId,
      teamId,
      weekOf,
    };

    const paginationParams = parsePaginationParams(req.query);

    const preparePayments = async (
      rows: Payment[],
      organizationId: number | null,
    ) => {
      const nameMap = await buildPayerNameMap(rows, organizationId);
      const sanitized = sanitizePayments(rows, nameMap);
      if (!includeDisputes) return sanitized;
      const disputesByPaymentId = await listPaymentDisputeSummariesForPayments({
        paymentRows: rows,
        organizationId,
      });
      return sanitized.map((payment) => ({
        ...payment,
        disputes: disputesByPaymentId.get(payment.id) ?? [],
      }));
    };

    if (isSystemAdmin && effectiveOrgId === null) {
      if (paginationParams) {
        const result = await storage.getAllPaymentsPaginatedSystemAdmin(baseFilters, paginationParams.page, paginationParams.limit);
        return sendPaginatedSuccess(res, await preparePayments(result.items, null), result.pagination);
      }
      const payments = await storage.getAllPaymentsSystemAdmin(baseFilters);
      return sendSuccess(res, await preparePayments(payments, null));
    }

    const filters = {
      ...baseFilters,
      organizationId: effectiveOrgId!,
    };

    if (paginationParams) {
      const result = await storage.getPaymentsPaginated(filters, paginationParams.page, paginationParams.limit);
      return sendPaginatedSuccess(
        res,
        await preparePayments(result.items, effectiveOrgId),
        result.pagination,
      );
    }

    const payments = await storage.getPayments(filters);
    sendSuccess(res, await preparePayments(payments, effectiveOrgId));
  } catch (error) {
    log.error('Get error:', error);
    sendError(res, 'Failed to fetch payments');
  }
});

export default router;
