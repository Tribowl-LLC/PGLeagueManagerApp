import { and, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { bowlerLeagues } from "@shared/schema";
import { db } from "../db.js";
import { createLogger } from "../logger.js";
import {
  LeagueOccurrenceScheduleError,
} from "../services/league-occurrence-schedule.js";
import {
  LeagueStandingsError,
  loadLeagueStandings,
} from "../services/league-standings.js";
import { storage } from "../storage/index.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { singleRouteParam } from "../utils/route-params.js";

const log = createLogger("LeagueStandingsRoutes");
const router = Router();

function positiveId(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function authorizedStandingsScope(req: Request): Promise<{
  organizationId: number;
  leagueId: number;
} | "invalid_request" | "not_found"> {
  if (!req.user) return "not_found";
  if (Object.keys(req.query).some((key) => key !== "organizationId")) return "invalid_request";
  const leagueId = positiveId(singleRouteParam(req.params.leagueId));
  if (leagueId === null) return "invalid_request";
  const rawOrganizationId = req.query.organizationId;
  const requestedOrganizationId = rawOrganizationId === undefined
    ? undefined
    : positiveId(rawOrganizationId);
  if (rawOrganizationId !== undefined && requestedOrganizationId === null) return "invalid_request";

  let organizationId: number;
  if (req.user.role === "system_admin") {
    if (requestedOrganizationId === undefined || requestedOrganizationId === null) return "invalid_request";
    organizationId = requestedOrganizationId;
  } else {
    const sessionOrganizationId = req.user.organizationId;
    if (!sessionOrganizationId
      || !Number.isSafeInteger(sessionOrganizationId)
      || sessionOrganizationId <= 0) return "not_found";
    if (requestedOrganizationId !== undefined && requestedOrganizationId !== sessionOrganizationId) {
      return "not_found";
    }
    organizationId = sessionOrganizationId;
  }

  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId !== organizationId) return "not_found";
  if (req.user.role === "system_admin" || req.user.role === "org_admin") {
    return { organizationId, leagueId };
  }
  if (!req.user.bowlerId) return "not_found";
  const [activeMembership] = await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(and(
    eq(bowlerLeagues.bowlerId, req.user.bowlerId),
    eq(bowlerLeagues.leagueId, leagueId),
    eq(bowlerLeagues.active, true),
  )).limit(1);
  return activeMembership ? { organizationId, leagueId } : "not_found";
}

router.get("/:leagueId/standings", async (req, res) => {
  try {
    const scope = await authorizedStandingsScope(req);
    if (scope === "invalid_request") {
      return sendError(
        res,
        req.user?.role === "system_admin" && req.query.organizationId === undefined
          ? "System administrators must select one organization with ?organizationId=<id>"
          : "A valid league and organization scope is required",
        400,
        "INVALID_REQUEST",
      );
    }
    if (scope === "not_found") {
      return sendError(res, "League standings not found", 404, "NOT_FOUND");
    }
    return sendSuccess(res, await loadLeagueStandings(scope));
  } catch (caught) {
    if (caught instanceof LeagueStandingsError) {
      log.warn("Canonical standings evidence is incompatible", caught.evidence);
      return sendError(
        res,
        "Canonical standings evidence is incompatible and cannot be used safely",
        409,
        "CANONICAL_STANDINGS_INCOMPATIBLE",
      );
    }
    if (caught instanceof LeagueOccurrenceScheduleError && caught.code === "league_not_found") {
      return sendError(res, "League standings not found", 404, "NOT_FOUND");
    }
    log.error("League standings read failed", {
      error: caught instanceof Error ? caught.name : "unknown",
    });
    return sendError(res, "League standings could not be loaded", 500, "LEAGUE_STANDINGS_ERROR");
  }
});

export default router;
