import { Router } from 'express';
import { sendSuccess, sendError, handleZodError } from '../utils/api';
import { z } from 'zod';
import { createLogger } from '../logger';
import { CanonicalGamesScoresError, loadLeagueGames } from '../services/canonical-games-scores.js';
import { authorizedLeagueScope } from './games-scores-scope.js';

const log = createLogger("Games");

const router = Router();

// Input validation schema - make leagueId required and ensure it's properly transformed
const getGamesQuerySchema = z.object({
  leagueId: z.coerce.number({
    error: (issue) => issue.input === undefined
      ? "League ID is required"
      : "League ID must be a number",
  }).int().positive(),
  weekNumber: z.coerce.number().int().positive().optional(),
  occurrenceId: z.string().uuid().optional(),
}).refine((value) => value.weekNumber === undefined || value.occurrenceId === undefined, {
  message: "weekNumber and occurrenceId cannot be combined",
});

// Get games for a league
router.get('/', async (req, res) => {
  try {
    const validationResult = getGamesQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const { leagueId, weekNumber, occurrenceId } = validationResult.data;
    const scope = await authorizedLeagueScope(req, leagueId);
    if (scope.kind === "system_scope_required") {
      return sendError(res, "System administrators must select one organization with ?organizationId=<id>", 400, "INVALID_REQUEST");
    }
    if (scope.kind === "not_found") return sendError(res, "League games not found", 404, "NOT_FOUND");
    sendSuccess(res, await loadLeagueGames({ ...scope, weekNumber, occurrenceId }));
  } catch (error) {
    if (error instanceof CanonicalGamesScoresError) {
      log.warn("Canonical game evidence is incompatible", error.evidence);
      return sendError(res, "Canonical game evidence is incompatible and cannot be used safely", 409, "CANONICAL_GAMES_SCORES_INCOMPATIBLE");
    }
    log.error('Error fetching games:', error);
    return sendError(res, 'Failed to fetch games', 500);
  }
});

export default router;
