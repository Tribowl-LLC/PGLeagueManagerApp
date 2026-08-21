import { Router } from "express";
import { parseOptionalIntParam, sendError, sendSuccess } from "../utils/api.js";
import {
  hasAdminAccessToLeague,
  hasPaymentManagerAccessToLeague,
  isPaymentManager,
} from "../utils/access-control.js";
import { storage } from "../storage/index.js";
import {
  CanonicalPaymentReportIncompatibilityError,
  readCanonicalPaymentReport,
} from "../services/canonical-payment-report.js";

const router = Router();

function positiveQuery(value: unknown): number | undefined | null {
  const parsed = parseOptionalIntParam(value);
  if (parsed === undefined) return undefined;
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

function pageQuery(value: unknown, fallback: number): number | undefined | null {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

router.get("/payments", async (req, res) => {
  const organizationId = positiveQuery(req.query.organizationId);
  const leagueId = positiveQuery(req.query.leagueId);
  const requestedBowlerId = positiveQuery(req.query.bowlerId);
  const page = pageQuery(req.query.page, 1);
  const limit = pageQuery(req.query.limit, 50);
  if (organizationId === null || leagueId === null || requestedBowlerId === null || page === null || limit === null) {
    return sendError(res, "Invalid financial report scope", 400, "INVALID_SCOPE");
  }
  if (leagueId === undefined) return sendError(res, "League scope is required", 400, "INVALID_SCOPE");
  if (!req.user) return sendError(res, "Not found", 404, "NOT_FOUND");

  const isSystemAdmin = req.user.role === "system_admin";
  const effectiveOrganizationId = isSystemAdmin ? organizationId : req.user.organizationId;
  if (!effectiveOrganizationId || (organizationId !== undefined && organizationId !== effectiveOrganizationId)) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId !== effectiveOrganizationId) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const adminAccess = await hasAdminAccessToLeague(req, leagueId);
  const paymentManagerAccess = await hasPaymentManagerAccessToLeague(req, leagueId);
  const privileged = isSystemAdmin || adminAccess || paymentManagerAccess;
  const bowlerId: number | undefined = privileged ? requestedBowlerId ?? undefined : req.user.bowlerId ?? undefined;
  if (!privileged && (!bowlerId || (requestedBowlerId !== undefined && requestedBowlerId !== bowlerId))) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  if (isPaymentManager(req.user) && !paymentManagerAccess && !isSystemAdmin) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  try {
    const report = await readCanonicalPaymentReport({
      organizationId: effectiveOrganizationId,
      leagueId,
      bowlerId,
      page,
      limit,
    });
    return sendSuccess(res, report);
  } catch (error) {
    if (error instanceof CanonicalPaymentReportIncompatibilityError) {
      return sendError(res, "Financial evidence requires review", 409, "FINANCIAL_EVIDENCE_INCOMPATIBLE");
    }
    return sendError(res, "Unable to read payment evidence", 500, "INTERNAL_ERROR");
  }
});

export default router;
