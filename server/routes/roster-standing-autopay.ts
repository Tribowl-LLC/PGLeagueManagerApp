import { Router, type Request, type Response } from "express";
import { standingAutopayConsentRequestSchema, standingAutopayQuoteRequestSchema, standingAutopayRevokeRequestSchema } from "@shared/standing-autopay-contract";
import { hasAccessToLeague, hasAdminAccessToLeague, hasPaymentManagerAccessToLeague } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";
import { paymentWriteLimiter } from "../middleware/rate-limit.js";
import { activateStandingAutopayConsent, quoteStandingAutopay, readStandingAutopayConsent, revokeStandingAutopayConsent, StandingAutopayError, StandingAutopayReplay } from "../services/roster-standing-autopay.js";

const router = Router();

function leagueIdParam(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function scope(req: Request, leagueId: number, management = false) {
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || (req.user?.role !== "system_admin" && req.user?.organizationId !== league.organizationId)) return null;
  if (management) {
    if (req.user?.role !== "system_admin" && !(await hasAdminAccessToLeague(req, leagueId)) && !(await hasPaymentManagerAccessToLeague(req, leagueId))) return null;
  } else if (!(await hasAccessToLeague(req, leagueId))) return null;
  return league;
}

function payerId(req: Request): number | null {
  const value = req.user?.bowlerId;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function fail(res: Response, error: unknown): void {
  if (error instanceof StandingAutopayReplay) return sendSuccess(res, error.result);
  if (error instanceof StandingAutopayError) return sendError(res, error.message, error.status, error.code);
  return sendError(res, "Unable to process standing automatic-payment consent", 500, "INTERNAL_ERROR");
}

router.get("/leagues/:leagueId/standing-autopay/1", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await scope(req, leagueId);
  const ownPayerId = payerId(req);
  if (!league || league.organizationId === null || ownPayerId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await readStandingAutopayConsent({ organizationId: league.organizationId, leagueId, payerBowlerId: ownPayerId })); } catch (error) { return fail(res, error); }
});

router.post("/leagues/:leagueId/standing-autopay/1/consent", paymentWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await scope(req, leagueId);
  const ownPayerId = payerId(req);
  if (!league || league.organizationId === null || ownPayerId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = standingAutopayConsentRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid standing consent request", 400, "INVALID_REQUEST");
  try {
    const result = await activateStandingAutopayConsent({ organizationId: league.organizationId, leagueId, payerBowlerId: ownPayerId, actorUserId: req.user.id, request: parsed.data });
    return sendSuccess(res, result, 201);
  } catch (error) { return fail(res, error); }
});

router.post("/leagues/:leagueId/standing-autopay/1/revoke", paymentWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await scope(req, leagueId);
  const ownPayerId = payerId(req);
  if (!league || league.organizationId === null || ownPayerId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = standingAutopayRevokeRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid standing consent request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await revokeStandingAutopayConsent({ organizationId: league.organizationId, leagueId, payerBowlerId: ownPayerId, actorUserId: req.user.id, request: parsed.data })); } catch (error) { return fail(res, error); }
});

async function sendStandingAutopayQuote(req: Request, res: Response) {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await scope(req, leagueId);
  const ownPayerId = payerId(req);
  if (!league || league.organizationId === null || ownPayerId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await quoteStandingAutopay({ organizationId: league.organizationId, leagueId, payerBowlerId: ownPayerId })); } catch (error) { return fail(res, error); }
}

router.get("/leagues/:leagueId/standing-autopay/1/quote", sendStandingAutopayQuote);

router.post("/leagues/:leagueId/standing-autopay/1/quote", paymentWriteLimiter, async (req, res) => {
  const parsed = standingAutopayQuoteRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid standing quote request", 400, "INVALID_REQUEST");
  return sendStandingAutopayQuote(req, res);
});

export default router;
