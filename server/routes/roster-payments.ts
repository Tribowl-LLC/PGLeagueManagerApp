import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  canonicalCorrectionRequestSchema,
  canonicalManualRecordRequestSchema,
  interactiveObligationChargeRequestV2Schema,
  interactiveObligationQuoteRequestV2Schema,
  rosterPaymentResponsibilityRequestSchema,
  occurrenceResponsibilityInputSchema,
} from "@shared/roster-payment-contract";
import { hasAdminAccessToLeague, hasPaymentManagerAccessToLeague } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";
import {
  correctCanonicalAllocation,
  chargeInteractiveObligations,
  quoteInteractiveObligations,
  readCanonicalDuePastDue,
  readRosterPaymentResponsibility,
  recordCanonicalManualPayment,
  recordOccurrenceResponsibilities,
  RosterPaymentError,
  RosterPaymentReplay,
  saveTeamRoster,
} from "../services/roster-payment-core.js";

const router = Router();

function leagueIdParam(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function authorizedLeague(req: Request, leagueId: number) {
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || req.user?.organizationId !== league.organizationId && req.user?.role !== "system_admin") return null;
  if (!(await hasAdminAccessToLeague(req, leagueId)) && !(await hasPaymentManagerAccessToLeague(req, leagueId))) return null;
  return league;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof RosterPaymentReplay) {
    sendSuccess(res, error.result);
    return;
  }
  if (error instanceof RosterPaymentError) {
    sendError(res, error.message, error.status, error.code);
    return;
  }
  sendError(res, "Unable to process roster payment evidence", 500, "INTERNAL_ERROR");
}

router.get("/leagues/:leagueId/roster-payment-responsibility/1", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await readRosterPaymentResponsibility({ organizationId: league.organizationId, leagueId })); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/roster-payment-responsibility/1/teams/:teamId", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  const teamId = leagueIdParam(req.params.teamId);
  if (!leagueId || !teamId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = rosterPaymentResponsibilityRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid roster responsibility request", 400, "INVALID_REQUEST");
  try {
    return sendSuccess(res, await saveTeamRoster({ organizationId: league.organizationId, leagueId, teamId, actorUserId: req.user.id, request: parsed.data }), 201);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/roster-payment-responsibility/1/occurrences", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const bodySchema = z.object({ commandKey: z.string().trim().min(1).max(255), requestFingerprint: z.string().trim().min(1).max(128), responsibilities: z.array(occurrenceResponsibilityInputSchema).min(1) }).strict();
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid occurrence responsibility request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await recordOccurrenceResponsibilities({ ...parsed.data, organizationId: league.organizationId, leagueId, actorUserId: req.user.id }), 201); } catch (error) { return handleError(res, error); }
});

router.get("/leagues/:leagueId/canonical-due-past-due/2", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const payerBowlerId = req.query.bowlerId === undefined ? undefined : Number(req.query.bowlerId);
  if (payerBowlerId !== undefined && (!Number.isSafeInteger(payerBowlerId) || payerBowlerId <= 0)) return sendError(res, "Invalid bowler", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await readCanonicalDuePastDue({ organizationId: league.organizationId, leagueId, payerBowlerId })); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-quote/2", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = interactiveObligationQuoteRequestV2Schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid obligation quote request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await quoteInteractiveObligations({ organizationId: league.organizationId, leagueId, obligationIds: parsed.data.obligationIds })); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-charge/2", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = interactiveObligationChargeRequestV2Schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid obligation charge request", 400, "INVALID_REQUEST");
  try {
    const result = await chargeInteractiveObligations({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, request: parsed.data });
    return sendSuccess(res, result, result.status === "succeeded" ? 201 : 202);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/canonical/manual-record/1", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalManualRecordRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid manual payment request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await recordCanonicalManualPayment({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, request: parsed.data }), 201); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/canonical/corrections/1", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalCorrectionRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid correction request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await correctCanonicalAllocation({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, request: parsed.data }), 201); } catch (error) { return handleError(res, error); }
});

export default router;
