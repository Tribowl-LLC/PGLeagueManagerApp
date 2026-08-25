import { Router } from "express";
import { readCanonicalDuePastDue, RosterPaymentError } from "../services/roster-payment-core.js";
import { hasAdminAccessToLeague, hasAccessToLeague, hasPaymentManagerAccessToLeague, isPaymentManager } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";

const router = Router();

function positive(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

router.get("/due-past-due", async (req, res) => {
  if (!req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrg = positive(req.query.organizationId);
  if (requestedOrg === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user.role !== "system_admin" && req.user.role !== "org_admin" && !isPaymentManager(req.user)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (requestedOrg !== undefined && req.user.role !== "system_admin" && requestedOrg !== req.user.organizationId) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  const organizationId = req.user.role === "system_admin" ? requestedOrg : req.user.organizationId;
  if (!organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const user = req.user;
  const leagues = (await storage.getLeagues(organizationId)).filter((league) => !isPaymentManager(user) || league.locationId === user.locationId);
  try {
    const reports = await Promise.all(leagues.map(async (league) => ({ leagueId: league.id, name: league.name, report: await readCanonicalDuePastDue({ organizationId, leagueId: league.id }) })));
    return sendSuccess(res, { contractVersion: "canonical-due-past-due/2" as const, orderVersion: "due-at,payer,occurrence,obligation/2" as const, organizationId, authoritativeSource: "payment_obligations" as const, leagues: reports });
  } catch (error) {
    if (error instanceof RosterPaymentError) return sendError(res, error.message, error.status, error.code);
    return sendError(res, "Unable to read financial evidence", 500, "INTERNAL_ERROR");
  }
});

router.get("/leagues/:leagueId/due-past-due", async (req, res) => {
  if (!req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const leagueId = positive(req.params.leagueId);
  if (!leagueId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  if ((!privileged && !(await hasAccessToLeague(req, leagueId))) || (req.user.role !== "system_admin" && req.user.organizationId !== league.organizationId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requested = positive(req.query.bowlerId);
  if (requested === null) return sendError(res, "Invalid bowler", 400, "INVALID_SCOPE");
  const payerBowlerId = privileged ? requested : req.user.bowlerId ?? undefined;
  if (!privileged && requested !== undefined && requested !== payerBowlerId) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await readCanonicalDuePastDue({ organizationId: league.organizationId, leagueId, payerBowlerId })); }
  catch (error) { if (error instanceof RosterPaymentError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Unable to read financial evidence", 500, "INTERNAL_ERROR"); }
});

router.all("/leagues/:leagueId/source", (_req, res) => sendError(res, "Legacy financial activation is retired", 410, "FINANCIAL_ACTIVATION_RETIRED"));
router.all("/leagues/:leagueId/roster", (_req, res) => sendError(res, "Legacy financial activation is retired", 410, "FINANCIAL_ACTIVATION_RETIRED"));
router.all("/leagues/:leagueId/activate", (_req, res) => sendError(res, "Legacy financial activation is retired", 410, "FINANCIAL_ACTIVATION_RETIRED"));

export default router;
