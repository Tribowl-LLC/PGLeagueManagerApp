import { Router } from 'express';
import { storage } from '../storage';
import { sendSuccess, sendError, handleZodError } from '../utils/api';
import { z } from 'zod';
import { hasAccessToLeague } from '../utils/access-control.js';
import { createLogger } from '../logger';

const log = createLogger("Games");

const router = Router();

// Input validation schema - make leagueId required and ensure it's properly transformed
const getGamesQuerySchema = z.object({
  leagueId: z.coerce.number({
    error: (issue) => issue.input === undefined
      ? "League ID is required"
      : "League ID must be a number",
  }),
  weekNumber: z.coerce.number().optional()
});

// Get games for a league
router.get('/', async (req, res) => {
  try {
    const validationResult = getGamesQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const { leagueId, weekNumber } = validationResult.data;
    
    // Check organization access for the league
    if (req.user?.role !== 'system_admin') {
      const hasAccess = await hasAccessToLeague(req, leagueId);
      if (!hasAccess) {
        return sendError(res, "You don't have access to this league's games", 403, 'FORBIDDEN');
      }
    }

    const games = await storage.getGames(leagueId, weekNumber);
    sendSuccess(res, games);
  } catch (error) {
    log.error('Error fetching games:', error);
    sendError(res, 'Failed to fetch games', 500);
  }
});

export default router;
