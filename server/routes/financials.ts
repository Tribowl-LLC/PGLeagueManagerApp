import { Router } from "express";
import { createLogger } from "../logger.js";
import { LeagueOccurrenceScheduleError } from "../services/league-occurrence-schedule.js";
import { readCanonicalDuePastDue, RosterPaymentError } from "../services/roster-payment-core.js";
import {
  readTeamEnvelopeReport,
  renderTeamEnvelopePdf,
  TeamEnvelopeReportError,
  teamEnvelopeFilename,
} from "../services/team-envelope-report.js";
import { hasAdminAccessToLeague, hasAccessToLeague, hasPaymentManagerAccessToLeague, isPaymentManager, requireOrganizationAccess } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";

const log = createLogger("FinancialRoutes");
const router = Router();

function positive(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

router.get("/leagues/:leagueId/team-envelope-slips.pdf", async (req, res) => {
  if (!req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const leagueId = positive(req.params.leagueId);
  if (!leagueId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrg = positive(req.query.organizationId);
  if (requestedOrg === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");

  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!requireOrganizationAccess(req, league.organizationId, "league", leagueId)) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  if (req.user.role === "system_admin") {
    const selectedOrg = req.organizationContextId ?? requestedOrg ?? req.user.organizationId ?? undefined;
    if (!selectedOrg) {
      return sendError(res, "Select an organization before creating envelope slips", 400, "INVALID_SCOPE");
    }
    if (selectedOrg !== league.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
  } else {
    if (requestedOrg !== undefined && requestedOrg !== req.user.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
    if (req.user.organizationId !== league.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
    const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId);
    if (!privileged) return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  try {
    const report = await readTeamEnvelopeReport({ organizationId: league.organizationId, leagueId });
    const pdf = await renderTeamEnvelopePdf(report);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${teamEnvelopeFilename(report)}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(pdf));
  } catch (error) {
    if (error instanceof TeamEnvelopeReportError || error instanceof RosterPaymentError) {
      return sendError(res, error.message, error.status, error.code);
    }
    if (error instanceof LeagueOccurrenceScheduleError) {
      if (error.code === "league_not_found") return sendError(res, "Not found", 404, "NOT_FOUND");
      return sendError(res, "Canonical schedule evidence cannot safely produce envelope slips", 409, "CANONICAL_SCHEDULE_INCOMPATIBLE");
    }
    log.error("Team envelope PDF creation failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return sendError(res, "Unable to create team envelope slips", 500, "TEAM_ENVELOPE_PDF_ERROR");
  }
});

router.get("/due-past-due", async (req, res) => {
  if (!req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrg = positive(req.query.organizationId);
  if (requestedOrg === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user.role !== "system_admin" && req.user.role !== "org_admin" && !isPaymentManager(req.user)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (requestedOrg !== undefined && req.user.role !== "system_admin" && requestedOrg !== req.user.organizationId) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  const organizationId = req.organizationContextId
    ?? (req.user.role === "system_admin" ? requestedOrg : req.user.organizationId);
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
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId);
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
