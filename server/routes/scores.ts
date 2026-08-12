import { Router } from 'express';
import { storage } from '../storage';
import { sendSuccess, sendError, handleZodError } from '../utils/api.js';
import { z } from 'zod';
import { insertScoreSchema } from '@shared/schema';
import { hasAccessToBowler, hasAccessToLeague } from '../utils/access-control.js';
import { createLogger } from '../logger';
import {
  CanonicalGamesScoresError,
  createAuthorizedScoreBatch,
  inspectScoreBatchLeagueIds,
  loadBowlerScoreHistory,
  loadLeagueScores,
} from '../services/canonical-games-scores.js';
import { authorizedLeagueScope, authorizedOrganizationId } from './games-scores-scope.js';

const log = createLogger("Scores");

const getLeagueScoresSchema = z.object({
  leagueId: z.coerce.number().int().positive(),
  weekNumber: z.coerce.number().int().positive(),
});

const getScoresQuerySchema = z.object({
  leagueId: z.coerce.number().int().positive(),
  weekNumber: z.coerce.number().int().positive().optional(),
  occurrenceId: z.string().uuid().optional(),
}).refine((value) => value.weekNumber === undefined || value.occurrenceId === undefined, {
  message: "weekNumber and occurrenceId cannot be combined",
});

const historyQuerySchema = z.object({ bowlerId: z.coerce.number().int().positive() });
const scoreBatchSchema = z.object({ scores: z.array(insertScoreSchema).min(1).max(200) });

const router = Router();

router.get('/league/:leagueId/week/:weekNumber', async (req, res) => {
  try {
    const validationResult = getLeagueScoresSchema.safeParse({
      leagueId: req.params.leagueId,
      weekNumber: req.params.weekNumber
    });

    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const { leagueId, weekNumber } = validationResult.data;

    const scope = await authorizedLeagueScope(req, leagueId);
    if (scope.kind === "system_scope_required") {
      return sendError(res, "System administrators must select one organization with ?organizationId=<id>", 400, "INVALID_REQUEST");
    }
    if (scope.kind === "not_found") return sendError(res, "League scores not found", 404, "NOT_FOUND");
    return sendSuccess(res, await loadLeagueScores({ ...scope, weekNumber }));
  } catch (error) {
    return handleScoresError(res, error, "fetching league scores");
  }
});

router.get('/history', async (req, res) => {
  try {
    const validationResult = historyQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }
    const { bowlerId } = validationResult.data;
    const organizationId = authorizedOrganizationId(req);
    if (organizationId === "system_scope_required") {
      return sendError(res, "System administrators must select one organization with ?organizationId=<id>", 400, "INVALID_REQUEST");
    }
    if (organizationId === null || !(await hasAccessToBowler(req, bowlerId))) {
      return sendError(res, "Bowler score history not found", 404, "NOT_FOUND");
    }
    const bowler = await storage.getBowler(bowlerId);
    if (!bowler || bowler.organizationId !== organizationId) {
      return sendError(res, "Bowler score history not found", 404, "NOT_FOUND");
    }
    const targetMemberships = (await storage.getBowlerLeagues({ bowlerId })).filter((row) => row.active);
    let allowedLeagueIds = targetMemberships.map((row) => row.leagueId);
    if (req.user?.role !== "system_admin" && req.user?.role !== "org_admin" && req.user?.bowlerId !== bowlerId) {
      const ownMemberships = req.user?.bowlerId
        ? await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId })
        : [];
      const ownLeagueIds = new Set(ownMemberships.filter((row) => row.active).map((row) => row.leagueId));
      allowedLeagueIds = allowedLeagueIds.filter((leagueId) => ownLeagueIds.has(leagueId));
    }
    return sendSuccess(res, await loadBowlerScoreHistory({ organizationId, bowlerId, allowedLeagueIds }));
  } catch (error) {
    return handleScoresError(res, error, "fetching bowler score history");
  }
});

router.get('/', async (req, res) => {
  try {
    const parsed = getScoresQuerySchema.safeParse(req.query);
    if (!parsed.success) return handleZodError(res, parsed.error);
    const scope = await authorizedLeagueScope(req, parsed.data.leagueId);
    if (scope.kind === "system_scope_required") {
      return sendError(res, "System administrators must select one organization with ?organizationId=<id>", 400, "INVALID_REQUEST");
    }
    if (scope.kind === "not_found") return sendError(res, "League scores not found", 404, "NOT_FOUND");
    return sendSuccess(res, await loadLeagueScores({ ...scope, weekNumber: parsed.data.weekNumber, occurrenceId: parsed.data.occurrenceId }));
  } catch (error) {
    return handleScoresError(res, error, "fetching scores");
  }
});

router.post('/batch', async (req, res) => {
  try {
    const parsed = scoreBatchSchema.safeParse(req.body);
    if (!parsed.success) return handleZodError(res, parsed.error);
    const organizationId = authorizedOrganizationId(req);
    if (organizationId === "system_scope_required") {
      return sendError(res, "System administrators must select one organization with ?organizationId=<id>", 400, "INVALID_REQUEST");
    }
    if (organizationId === null) return sendError(res, "Score batch not found", 404, "NOT_FOUND");
    const leagueIds = await inspectScoreBatchLeagueIds(organizationId, parsed.data.scores.map((row) => row.gameId));
    if (leagueIds === null) return sendError(res, "Score batch contains unavailable references", 404, "NOT_FOUND");
    for (const leagueId of leagueIds) {
      if (!(await hasAccessToLeague(req, leagueId))) {
        return sendError(res, "Score batch contains unavailable references", 404, "NOT_FOUND");
      }
    }
    return sendSuccess(res, await createAuthorizedScoreBatch({
      organizationId,
      authorizedLeagueIds: leagueIds,
      batchScores: parsed.data.scores,
    }), 201);
  } catch (error) {
    return handleScoresError(res, error, "creating score batch", true);
  }
});

function handleScoresError(
  res: Parameters<typeof sendError>[0],
  caught: unknown,
  action: string,
  scoreBatchWrite = false,
) {
  if (caught instanceof CanonicalGamesScoresError) {
    log.warn(`Canonical games/scores failure while ${action}`, caught.evidence);
    if (scoreBatchWrite && caught.evidence.classification.startsWith("score_")) {
      return sendError(res, "Score batch contains invalid or unavailable relationships", 400, "INVALID_SCORE_BATCH");
    }
    return sendError(res, "Canonical game or score evidence is incompatible and cannot be used safely", 409, "CANONICAL_GAMES_SCORES_INCOMPATIBLE");
  }
  log.error(`Error while ${action}:`, caught);
  return sendError(res, 'Scores request failed', 500);
}

export default router;
