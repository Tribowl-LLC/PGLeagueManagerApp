import { Router } from 'express';
import { db } from '../db.js';
import { leagues } from '@shared/schema';
import { teams } from '@shared/schema';
import { bowlers, bowlerLeagues } from '@shared/schema';
import { ilike, eq, or, and, inArray } from 'drizzle-orm';
import { sendSuccess, sendError } from '../utils/api.js';
import { createLogger } from '../logger';
import {
  getPaymentManagerAccessibleLeagueIds,
  isPaymentManager,
} from '../utils/access-control.js';

const log = createLogger("Search");
const router = Router();

const MAX_RESULTS_PER_CATEGORY = 5;

router.get("/", async (req, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q || q.length < 2) {
      return sendSuccess(res, { leagues: [], teams: [], bowlers: [] });
    }

    const organizationId: number | null = req.user?.organizationId ?? null;

    if (!organizationId) {
      return sendSuccess(res, { leagues: [], teams: [], bowlers: [] });
    }

    const pattern = `%${q}%`;
    // Search is a convenience endpoint, but it still returns tenant data.
    // Organization membership is not enough for a payment manager: their
    // results must be limited to configured leagues at the assigned location.
    // Resolve this once and reuse the same scope for every category so a
    // league result can never be paired with an out-of-scope team or bowler.
    const paymentManagerLeagueIds = isPaymentManager(req.user)
      ? await getPaymentManagerAccessibleLeagueIds(req)
      : null;

    if (paymentManagerLeagueIds && paymentManagerLeagueIds.length === 0) {
      return sendSuccess(res, { leagues: [], teams: [], bowlers: [] });
    }

    const leagueScope = paymentManagerLeagueIds
      ? inArray(leagues.id, paymentManagerLeagueIds)
      : eq(leagues.organizationId, organizationId);

    const matchedLeagues = await db
      .select({ id: leagues.id, name: leagues.name, active: leagues.active })
      .from(leagues)
      .where(and(
        ilike(leagues.name, pattern),
        leagueScope,
      ))
      .limit(MAX_RESULTS_PER_CATEGORY);

    const matchedTeams = await db
      .select({
        id: teams.id,
        name: teams.name,
        number: teams.number,
        leagueId: teams.leagueId,
        leagueName: leagues.name,
      })
      .from(teams)
      .innerJoin(leagues, eq(teams.leagueId, leagues.id))
      .where(and(
        ilike(teams.name, pattern),
        leagueScope,
      ))
      .limit(MAX_RESULTS_PER_CATEGORY);

    let matchedBowlers: { id: number; name: string; email: string | null }[] = [];
    const scopedLeagues = await db
      .select({ id: leagues.id })
      .from(leagues)
      .where(leagueScope);
    const scopedLeagueIds = scopedLeagues.map(l => l.id);

    if (scopedLeagueIds.length > 0) {
      const orgBowlerRows = await db
        .selectDistinct({ bowlerId: bowlerLeagues.bowlerId })
        .from(bowlerLeagues)
        .where(and(
          inArray(bowlerLeagues.leagueId, scopedLeagueIds),
          eq(bowlerLeagues.active, true),
        ));
      const orgBowlerIds = orgBowlerRows.map(r => r.bowlerId);

      if (orgBowlerIds.length > 0) {
        matchedBowlers = await db
          .select({ id: bowlers.id, name: bowlers.name, email: bowlers.email })
          .from(bowlers)
          .where(and(
            inArray(bowlers.id, orgBowlerIds),
            eq(bowlers.organizationId, organizationId),
            or(
              ilike(bowlers.name, pattern),
              ilike(bowlers.email, pattern)
            )
          ))
          .limit(MAX_RESULTS_PER_CATEGORY);
      }
    }

    sendSuccess(res, {
      leagues: matchedLeagues,
      teams: matchedTeams,
      bowlers: matchedBowlers,
    });
  } catch (error) {
    log.error('Search error:', error);
    sendError(res, 'Search failed');
  }
});

export default router;
