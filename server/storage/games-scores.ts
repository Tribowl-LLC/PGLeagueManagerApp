import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  games, scores, bowlers, teams, leagues,
  type Game, type InsertGame, type UpdateGame,
  type Score, type InsertScore, type UpdateScore,
} from "@shared/schema";
import { createLogger } from '../logger';
import {
  createCanonicalAwareGame,
  deleteCanonicalAwareGame,
  updateCanonicalAwareGame,
} from '../services/canonical-games-scores.js';
import { lockLeagueSchedule } from './league-schedule-lock.js';

const log = createLogger("StorageGamesScores");

export async function getGames(leagueId: number, weekNumber?: number): Promise<Game[]> {
  const canonicalLeague = sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${games.leagueId} AND authority_league.schedule_authority = 'canonical')`;
  if (weekNumber !== undefined) {
    return db
      .select()
      .from(games)
      .where(and(
        eq(games.leagueId, leagueId),
        eq(games.weekNumber, weekNumber),
        canonicalLeague,
      ))
      .orderBy(games.gameNumber);
  }
  return db
    .select()
    .from(games)
    .where(and(eq(games.leagueId, leagueId), canonicalLeague))
    .orderBy(desc(games.date), games.gameNumber);
}

export async function getGame(id: number): Promise<Game | undefined> {
  const [result] = await db.select().from(games).where(and(eq(games.id, id), sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${games.leagueId} AND authority_league.schedule_authority = 'canonical')`));
  return result;
}

export async function createGame(game: InsertGame): Promise<Game> {
  return createCanonicalAwareGame(game);
}

export async function updateGame(id: number, game: UpdateGame): Promise<Game> {
  return updateCanonicalAwareGame(id, game);
}

export async function deleteGame(id: number): Promise<void> {
  await deleteCanonicalAwareGame(id);
}

export async function getScores(gameId: number, teamId?: number): Promise<Score[]> {
  const canonicalGame = sql`EXISTS (SELECT 1 FROM games authority_game INNER JOIN leagues authority_league ON authority_league.id = authority_game.league_id WHERE authority_game.id = ${scores.gameId} AND authority_league.schedule_authority = 'canonical')`;
  if (teamId !== undefined) {
    return db
      .select()
      .from(scores)
      .where(and(
        eq(scores.gameId, gameId),
        eq(scores.teamId, teamId),
        canonicalGame,
      ))
      .orderBy(scores.position);
  }
  return db
    .select()
    .from(scores)
    .where(and(eq(scores.gameId, gameId), canonicalGame))
    .orderBy(scores.teamId, scores.position);
}

export async function getScore(id: number): Promise<Score | undefined> {
  const [result] = await db.select().from(scores).where(and(eq(scores.id, id), sql`EXISTS (SELECT 1 FROM games authority_game INNER JOIN leagues authority_league ON authority_league.id = authority_game.league_id WHERE authority_game.id = ${scores.gameId} AND authority_league.schedule_authority = 'canonical')`));
  return result;
}

export async function getBowlerScores(bowlerId: number): Promise<Score[]> {
  log.info('Fetching scores for bowler:', bowlerId);

  const results = await db
    .select({
      id: scores.id,
      gameId: scores.gameId,
      bowlerId: scores.bowlerId,
      teamId: scores.teamId,
      score: scores.score,
      handicap: scores.handicap,
      average: scores.average,
      position: scores.position,
      isVacant: scores.isVacant,
      isAbsent: scores.isAbsent,
      isSub: scores.isSub,
      laneNumber: scores.laneNumber,
      frames: scores.frames,
      splits: scores.splits,
      notes: scores.notes,
      game: {
        id: games.id,
        leagueId: games.leagueId,
        weekNumber: games.weekNumber,
        gameNumber: games.gameNumber,
        date: games.date,
      },
      team: {
        id: teams.id,
        name: teams.name,
        number: teams.number,
        leagueId: teams.leagueId,
        active: teams.active,
      },
      league: {
        id: leagues.id,
        name: leagues.name,
        description: leagues.description,
        active: leagues.active,
      }
    })
    .from(scores)
    .innerJoin(games, eq(games.id, scores.gameId))
    .innerJoin(teams, eq(teams.id, scores.teamId))
    .innerJoin(leagues, eq(leagues.id, games.leagueId))
    .where(and(eq(scores.bowlerId, bowlerId), eq(leagues.scheduleAuthority, "canonical")))
    .orderBy(desc(games.date), games.gameNumber);

  log.info('Found scores:', results.length);
  if (results.length > 0) {
    log.info('Sample score:', results[0]);
  }

  return results;
}

export async function createScore(score: InsertScore): Promise<Score> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: games.leagueId, organizationId: leagues.organizationId }).from(games).innerJoin(leagues, eq(leagues.id, games.leagueId)).where(eq(games.id, score.gameId)).limit(1);
    if (!scope) throw new Error('Game not found');
    await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, scope.leagueId)).limit(1).for('share');
    if (!league?.active || league.scheduleAuthority !== 'canonical') throw new Error('Inactive or retired leagues are read-only');
    const [result] = await tx.insert(scores).values(score).returning();
    return result;
  });
}

export async function updateScore(id: number, score: UpdateScore): Promise<Score> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: games.leagueId, organizationId: leagues.organizationId }).from(scores).innerJoin(games, eq(games.id, scores.gameId)).innerJoin(leagues, eq(leagues.id, games.leagueId)).where(eq(scores.id, id)).limit(1);
    if (!scope) throw new Error('Score not found');
    await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, scope.leagueId)).limit(1).for('share');
    if (!league?.active || league.scheduleAuthority !== 'canonical') throw new Error('Inactive or retired leagues are read-only');
    const [result] = await tx.update(scores).set(score).where(eq(scores.id, id)).returning();
    return result;
  });
}

export async function deleteScore(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: games.leagueId, organizationId: leagues.organizationId }).from(scores).innerJoin(games, eq(games.id, scores.gameId)).innerJoin(leagues, eq(leagues.id, games.leagueId)).where(eq(scores.id, id)).limit(1);
    if (!scope) return;
    await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, scope.leagueId)).limit(1).for('share');
    if (!league?.active || league.scheduleAuthority !== 'canonical') throw new Error('Inactive or retired leagues are read-only');
    await tx.delete(scores).where(eq(scores.id, id));
  });
}

export async function createBatchScores(batchScores: InsertScore[]): Promise<Score[]> {
  try {
    if (batchScores.length === 0) {
      log.info('No scores to create');
      return [];
    }

    log.info('Attempting to create batch scores:', {
      count: batchScores.length,
      sample: batchScores.slice(0, 2).map(score => ({
        gameId: score.gameId,
        bowlerId: score.bowlerId,
        teamId: score.teamId,
        score: score.score,
        laneNumber: score.laneNumber
      }))
    });

    const invalidScores = batchScores.filter(score =>
      !score.gameId || !score.bowlerId || !score.teamId ||
      typeof score.score !== 'number' || typeof score.handicap !== 'number'
    );

    if (invalidScores.length > 0) {
      log.error('Invalid scores found:',
        invalidScores.map(score => ({
          gameId: score.gameId,
          bowlerId: score.bowlerId,
          teamId: score.teamId,
          score: score.score,
          handicap: score.handicap
        }))
      );
      throw new Error('Invalid score data detected');
    }

    const results = await db.transaction(async (tx) => {
      const gameIds = [...new Set(batchScores.map((score) => score.gameId))];
      const gameRows = await tx.select({ id: games.id, leagueId: games.leagueId, organizationId: leagues.organizationId })
        .from(games).innerJoin(leagues, eq(leagues.id, games.leagueId))
        .where(inArray(games.id, gameIds));
      if (gameRows.length !== gameIds.length || gameRows.some((row) => row.leagueId !== gameRows[0]?.leagueId)) {
        throw new Error('Scores must target games in one league');
      }
      const leagueId = gameRows[0]?.leagueId;
      const organizationId = gameRows[0]?.organizationId;
      if (!leagueId) throw new Error('Score game league is unavailable');
      await lockLeagueSchedule(tx, organizationId, leagueId);
      const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority, organizationId: leagues.organizationId })
        .from(leagues).where(eq(leagues.id, leagueId)).limit(1).for('share');
      if (!league || league.organizationId !== organizationId || !league.active || league.scheduleAuthority !== 'canonical') {
        throw new Error('Inactive or retired leagues are read-only');
      }
      return tx.insert(scores).values(batchScores).returning();
    });

    log.info('Successfully created scores:', {
      requested: batchScores.length,
      created: results.length,
      sample: results.slice(0, 2).map(score => ({
        id: score.id,
        gameId: score.gameId,
        score: score.score,
        laneNumber: score.laneNumber
      }))
    });

    return results;
  } catch (error) {
    log.error('Error creating batch scores:', {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      scoreCount: batchScores.length,
      sampleScore: batchScores[0] ? {
        gameId: batchScores[0].gameId,
        bowlerId: batchScores[0].bowlerId,
        teamId: batchScores[0].teamId,
        score: batchScores[0].score,
        laneNumber: batchScores[0].laneNumber
      } : 'No scores'
    });
    throw error;
  }
}

export async function getGameScores(gameId: number): Promise<Score[]> {
  return db
    .select()
    .from(scores)
    .where(and(
      eq(scores.gameId, gameId),
      sql`EXISTS (SELECT 1 FROM games authority_game INNER JOIN leagues authority_league ON authority_league.id = authority_game.league_id WHERE authority_game.id = ${scores.gameId} AND authority_league.schedule_authority = 'canonical')`,
    ))
    .orderBy(scores.teamId, scores.position);
}

export async function getScoresByLeagueAndWeek(leagueId: number, weekNumber: number): Promise<Score[]> {
  log.info('Fetching scores for league:', leagueId, 'week:', weekNumber);

  const scoresWithDetails = await db
    .select({
      id: scores.id,
      gameId: scores.gameId,
      bowlerId: scores.bowlerId,
      teamId: scores.teamId,
      score: scores.score,
      handicap: scores.handicap,
      average: scores.average,
      position: scores.position,
      isVacant: scores.isVacant,
      isAbsent: scores.isAbsent,
      isSub: scores.isSub,
      laneNumber: scores.laneNumber,
      frames: scores.frames,
      splits: scores.splits,
      notes: scores.notes,
      bowler: {
        id: bowlers.id,
        name: bowlers.name,
      },
      team: {
        id: teams.id,
        name: teams.name,
        number: teams.number,
      },
      game: {
        id: games.id,
        weekNumber: games.weekNumber,
        gameNumber: games.gameNumber,
        date: games.date,
      },
    })
    .from(scores)
    .innerJoin(games, eq(games.id, scores.gameId))
    .innerJoin(bowlers, eq(bowlers.id, scores.bowlerId))
    .innerJoin(teams, eq(teams.id, scores.teamId))
    .where(
      and(
        eq(games.leagueId, leagueId),
        eq(games.weekNumber, weekNumber),
        sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${games.leagueId} AND authority_league.schedule_authority = 'canonical')`,
      )
    )
    .orderBy(games.gameNumber, teams.number, scores.position);

  log.info('Found scores:', scoresWithDetails.length);
  return scoresWithDetails;
}

export async function getScoresByGameIds(gameIds: number[]): Promise<Score[]> {
  if (gameIds.length === 0) return [];
  return db
    .select()
    .from(scores)
    .where(and(
      inArray(scores.gameId, gameIds),
      sql`EXISTS (SELECT 1 FROM games authority_game INNER JOIN leagues authority_league ON authority_league.id = authority_game.league_id WHERE authority_game.id = ${scores.gameId} AND authority_league.schedule_authority = 'canonical')`,
    ))
    .orderBy(scores.gameId, scores.teamId, scores.position);
}
