import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { bowlerLeagues } from "@shared/schema";
import { db } from "../db.js";
import { filterByOrganization } from "../middleware/organization.js";
import {
  LeagueOccurrenceScheduleError,
  loadLeagueOccurrenceSchedule,
} from "../services/league-occurrence-schedule.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { singleRouteParam } from "../utils/route-params.js";
import { createLogger } from "../logger.js";
import { hasPaymentManagerAccessToLeague, isPaymentManager } from "../utils/access-control.js";

const log = createLogger("LeagueOccurrenceScheduleRoutes");
const router = Router();

router.use(filterByOrganization);

function positiveId(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function authorizedReadScope(req: Request): Promise<{
  organizationId: number;
  leagueId: number;
  includeAdministratorEvidence: boolean;
} | null> {
  if (!req.user) return null;
  const leagueId = positiveId(singleRouteParam(req.params.id));
  if (!leagueId) return null;
  if (req.user.role === "system_admin") {
    const organizationId = positiveId(req.query.organizationId);
    return organizationId === null
      ? null
      : { organizationId, leagueId, includeAdministratorEvidence: true };
  }
  const organizationId = req.user.organizationId;
  if (!organizationId || !Number.isSafeInteger(organizationId) || organizationId <= 0) return null;
  if (isPaymentManager(req.user)) {
    return await hasPaymentManagerAccessToLeague(req, leagueId)
      ? { organizationId, leagueId, includeAdministratorEvidence: true }
      : null;
  }
  if (req.user.role === "org_admin") {
    return { organizationId, leagueId, includeAdministratorEvidence: true };
  }
  if (!req.user.bowlerId) return null;
  const [membership] = await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(and(
    eq(bowlerLeagues.bowlerId, req.user.bowlerId),
    eq(bowlerLeagues.leagueId, leagueId),
    eq(bowlerLeagues.active, true),
  )).limit(1);
  return membership ? { organizationId, leagueId, includeAdministratorEvidence: false } : null;
}

router.get("/:id/occurrence-schedule", async (req: Request, res) => {
  try {
    const scope = await authorizedReadScope(req);
    if (!scope) {
      if (req.user?.role === "system_admin" && req.query.organizationId === undefined) {
        return sendError(
          res,
          "System administrators must select one organization with ?organizationId=<id>",
          400,
          "INVALID_REQUEST",
        );
      }
      return sendError(res, "League schedule not found", 404, "NOT_FOUND");
    }
    sendSuccess(res, await loadLeagueOccurrenceSchedule(scope));
  } catch (caught) {
    if (caught instanceof LeagueOccurrenceScheduleError) {
      if (caught.code === "invalid_scope") {
        return sendError(res, "A valid tenant-scoped league is required", 400, "INVALID_REQUEST");
      }
      if (caught.code === "league_not_found") {
        return sendError(res, "League schedule not found", 404, "NOT_FOUND");
      }
      return sendError(
        res,
        "Canonical schedule evidence is incompatible and cannot be displayed safely",
        409,
        "CANONICAL_SCHEDULE_INCOMPATIBLE",
      );
    }
    log.error("League occurrence schedule read failed", {
      error: caught instanceof Error ? caught.name : "unknown",
    });
    sendError(res, "League schedule could not be loaded", 500, "LEAGUE_SCHEDULE_ERROR");
  }
});

export default router;
