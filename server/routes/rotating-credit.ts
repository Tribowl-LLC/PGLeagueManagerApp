import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  rotatingCreditChargeRequestSchema,
  rotatingCreditManualFundingRequestSchema,
  rotatingCreditManualQuoteRequestSchema,
  rotatingCreditQuoteRequestSchema,
  rotatingCreditRecoverByRequestKeySchema,
  rotatingCreditRefundQuoteRequestSchema,
  rotatingCreditRefundRequestSchema,
} from "@shared/rotating-credit-contract";
import { hasAccessToLeague, hasAdminAccessToLeague, hasPaymentManagerAccessToLeague, requireOrganizationAccess } from "../utils/access-control.js";
import { canUserPayForBowler } from "../utils/bowler-payment-authz.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";
import { adminWriteLimiter, paymentWriteLimiter } from "../middleware/rate-limit.js";
import {
  RotatingCreditError,
  chargeRotatingCreditPurchase,
  listRotatingCreditFundedMembersForTeam,
  quoteRotatingCreditManualFunding,
  quoteRotatingCreditPurchase,
  readRotatingCreditBalance,
  recordRotatingCreditManualFunding,
  recoverRotatingCreditChargeByRequestKey,
  recoverRotatingCreditChargeOperation,
} from "../services/rotating-credit.js";
import {
  RotatingCreditRefundError,
  quoteRotatingCreditRefund,
  recordRotatingCreditRefund,
} from "../services/rotating-credit-refund.js";

const router = Router();

function parseLeagueId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function authorizedLeague(req: Request, leagueId: number, management = false) {
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null
    || !requireOrganizationAccess(req, league.organizationId, "league", leagueId)) return null;
  if (management) {
    if (!(await hasAdminAccessToLeague(req, leagueId)) && !(await hasPaymentManagerAccessToLeague(req, leagueId))) return null;
  } else if (!(await hasAccessToLeague(req, leagueId))) {
    return null;
  }
  return league;
}

async function selfPayer(req: Request, leagueId: number) {
  const bowlerId = req.user?.bowlerId;
  if (!req.user || bowlerId === null || bowlerId === undefined) return null;
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return null;
  const permission = await canUserPayForBowler(req, bowlerId);
  return permission.allowed ? { league, bowlerId } : null;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof RotatingCreditError || error instanceof RotatingCreditRefundError) {
    sendError(res, error.message, error.status, error.code);
    return;
  }
  sendError(res, "Unable to process rotating credit request", 500, "INTERNAL_ERROR");
}

router.get("/leagues/:leagueId/rotating-credit/1", async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  if (!leagueId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const payer = await selfPayer(req, leagueId);
  if (!payer || payer.league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    return sendSuccess(res, await readRotatingCreditBalance({
      organizationId: payer.league.organizationId,
      leagueId,
      bowlerId: payer.bowlerId,
    }));
  } catch (error) { return handleError(res, error); }
});

router.get("/leagues/:leagueId/rotating-credit/admin/:bowlerId/1", async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const bowlerId = parseLeagueId(String(req.params.bowlerId));
  if (!leagueId || !bowlerId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");

  try {
    const bowler = await storage.getBowler(bowlerId);
    if (!bowler || bowler.organizationId !== league.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
    const memberships = await storage.getBowlerLeagues({ bowlerId, leagueId });
    const balance = await readRotatingCreditBalance({
      organizationId: league.organizationId,
      leagueId,
      bowlerId,
    });
    // A former member can still own funded credit after leaving the pool or
    // league. Permit that scoped history, but don't expose an empty balance
    // for an unrelated bowler in the same organization.
    if (memberships.length === 0 && balance.lots.length === 0) return sendError(res, "Not found", 404, "NOT_FOUND");
    return sendSuccess(res, balance);
  } catch (error) { return handleError(res, error); }
});

router.get("/leagues/:leagueId/rotating-credit/admin/teams/:teamId/members/1", async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const teamId = parseLeagueId(String(req.params.teamId));
  if (!leagueId || !teamId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const team = await storage.getTeam(teamId);
    if (!team || team.leagueId !== leagueId) return sendError(res, "Not found", 404, "NOT_FOUND");
    return sendSuccess(res, { members: await listRotatingCreditFundedMembersForTeam({
      organizationId: league.organizationId,
      leagueId,
      teamId,
    }) });
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/quote/1", paymentWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditQuoteRequestSchema.safeParse(req.body);
  if (!leagueId || !parsed.success) return sendError(res, "Invalid rotating credit quote request", 400, "INVALID_REQUEST");
  const payer = await selfPayer(req, leagueId);
  if (!payer || payer.league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    return sendSuccess(res, await quoteRotatingCreditPurchase({
      organizationId: payer.league.organizationId,
      leagueId,
      bowlerId: payer.bowlerId,
      shareCount: parsed.data.shareCount,
    }));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/charge/1", paymentWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditChargeRequestSchema.safeParse(req.body);
  if (!leagueId || !parsed.success || !req.user) return sendError(res, "Invalid rotating credit charge request", 400, "INVALID_REQUEST");
  const payer = await selfPayer(req, leagueId);
  if (!payer || payer.league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const result = await chargeRotatingCreditPurchase({
      organizationId: payer.league.organizationId,
      leagueId,
      bowlerId: payer.bowlerId,
      actorUserId: req.user.id,
      request: parsed.data,
    });
    return sendSuccess(res, result, result.status === "succeeded" ? 201 : 202);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/manual/quote/1", adminWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditManualQuoteRequestSchema.safeParse(req.body);
  if (!leagueId || !parsed.success) return sendError(res, "Invalid rotating credit manual quote request", 400, "INVALID_REQUEST");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    return sendSuccess(res, await quoteRotatingCreditManualFunding({
      organizationId: league.organizationId,
      leagueId,
      bowlerId: parsed.data.bowlerId,
      amountMinor: parsed.data.amountMinor,
    }));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/manual/1", adminWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditManualFundingRequestSchema.safeParse(req.body);
  if (!leagueId || !parsed.success || !req.user) return sendError(res, "Invalid rotating credit manual funding request", 400, "INVALID_REQUEST");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    return sendSuccess(res, await recordRotatingCreditManualFunding({
      organizationId: league.organizationId,
      leagueId,
      actorUserId: req.user.id,
      request: parsed.data,
    }), 201);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/refund/quote/1", adminWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditRefundQuoteRequestSchema.safeParse(req.body);
  if (!leagueId || !parsed.success) return sendError(res, "Invalid rotating credit refund quote request", 400, "INVALID_REQUEST");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    return sendSuccess(res, await quoteRotatingCreditRefund({
      organizationId: league.organizationId,
      leagueId,
      fundingId: parsed.data.fundingId,
    }));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/refund/1", adminWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditRefundRequestSchema.safeParse(req.body);
  if (!leagueId || !parsed.success || !req.user) return sendError(res, "Invalid rotating credit refund request", 400, "INVALID_REQUEST");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const result = await recordRotatingCreditRefund({
      organizationId: league.organizationId,
      leagueId,
      actorUserId: req.user.id,
      request: parsed.data,
    });
    return sendSuccess(res, result, result.status === "succeeded" ? 201 : 202);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/operations/recover-by-request-key/1", paymentWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const parsed = rotatingCreditRecoverByRequestKeySchema.safeParse(req.body);
  if (!leagueId || !parsed.success || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const payer = await selfPayer(req, leagueId);
  if (!payer || payer.league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const result = await recoverRotatingCreditChargeByRequestKey({
      organizationId: payer.league.organizationId,
      leagueId,
      bowlerId: payer.bowlerId,
      actorUserId: req.user.id,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return sendSuccess(res, result, result.status === "succeeded" ? 200 : 202);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/rotating-credit/operations/:operationId/recover/1", paymentWriteLimiter, async (req, res) => {
  const leagueId = parseLeagueId(String(req.params.leagueId));
  const operationId = z.string().uuid().safeParse(req.params.operationId);
  if (!leagueId || !operationId.success || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const payer = await selfPayer(req, leagueId);
  if (!payer || payer.league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const operation = await storage.getPaymentOperationForOrganization(payer.league.organizationId, operationId.data);
  if (!operation || operation.leagueId !== leagueId || operation.authorizingUserId !== req.user.id) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const result = await recoverRotatingCreditChargeOperation({
      organizationId: payer.league.organizationId,
      leagueId,
      bowlerId: payer.bowlerId,
      operationId: operationId.data,
    });
    return sendSuccess(res, result, result.status === "succeeded" ? 200 : 202);
  } catch (error) { return handleError(res, error); }
});

export default router;
