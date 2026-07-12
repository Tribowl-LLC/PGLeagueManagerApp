/**
 * Task #681 — admin endpoints for managing a league's custom embed
 * registration questions. Authenticated org_admin / system_admin only;
 * the public embed page reads the same questions through the unauthed
 * `/api/public/embed/leagues/:leagueId` endpoint.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { storage } from "../storage";
import * as regStorage from "../storage/league-registrations";
import { sendSuccess, sendError, handleZodError } from "../utils/api";
import { singleRouteParam } from "../utils/route-params";
import { hasAccessToLeague, isOrgOrHigher } from "../utils/access-control";
import {
  REGISTRATION_QUESTION_TYPES,
  insertRegistrationQuestionSchema,
} from "@shared/schema";
import { createLogger } from "../logger";

const log = createLogger("LeagueRegQuestions");

const router = Router({ mergeParams: true });

function parseLeagueId(req: Request): number | null {
  const id = parseInt(singleRouteParam(req.params.leagueId), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function requireLeagueAdmin(req: Request, leagueId: number): Promise<boolean> {
  if (!req.user || !isOrgOrHigher(req.user)) return false;
  return hasAccessToLeague(req, leagueId);
}

router.get("/", async (req, res) => {
  const leagueId = parseLeagueId(req);
  if (!leagueId) return sendError(res, "Invalid league id", 400, "INVALID_ID");
  if (!(await requireLeagueAdmin(req, leagueId))) return sendError(res, "Forbidden", 403, "FORBIDDEN");
  try {
    const rows = await regStorage.listQuestions(leagueId);
    sendSuccess(res, rows);
  } catch (err) {
    log.error("list questions failed", err);
    sendError(res, "Failed to list questions", 500, "SERVER_ERROR");
  }
});

const replaceBodySchema = z.object({
  questions: z
    .array(
      insertRegistrationQuestionSchema
        .omit({ leagueId: true, displayOrder: true })
        .extend({ type: z.enum(REGISTRATION_QUESTION_TYPES) }),
    )
    .max(50, "At most 50 questions per league"),
});

router.put("/", async (req, res) => {
  const leagueId = parseLeagueId(req);
  if (!leagueId) return sendError(res, "Invalid league id", 400, "INVALID_ID");
  if (!(await requireLeagueAdmin(req, leagueId))) return sendError(res, "Forbidden", 403, "FORBIDDEN");
  try {
    const parsed = replaceBodySchema.parse(req.body);
    // Refuse single/multi-select with no options.
    for (const q of parsed.questions) {
      if ((q.type === "single_select" || q.type === "multi_select") && q.options.length === 0) {
        return sendError(
          res,
          `Question "${q.label}" of type ${q.type} requires at least one option`,
          400,
          "MISSING_OPTIONS",
        );
      }
    }
    const rows = await regStorage.replaceQuestions(leagueId, parsed.questions);
    sendSuccess(res, rows);
  } catch (err) {
    if (err instanceof z.ZodError) {
      handleZodError(res, err);
      return;
    }
    log.error("replace questions failed", err);
    sendError(res, "Failed to update questions", 500, "SERVER_ERROR");
  }
});

router.get("/registrations", async (req, res) => {
  const leagueId = parseLeagueId(req);
  if (!leagueId) return sendError(res, "Invalid league id", 400, "INVALID_ID");
  if (!(await requireLeagueAdmin(req, leagueId))) return sendError(res, "Forbidden", 403, "FORBIDDEN");
  try {
    const rows = await regStorage.listRegistrations(leagueId);
    sendSuccess(res, rows);
  } catch (err) {
    log.error("list registrations failed", err);
    sendError(res, "Failed to list registrations", 500, "SERVER_ERROR");
  }
});

void storage; // imported for parity with sibling route files

export default router;
