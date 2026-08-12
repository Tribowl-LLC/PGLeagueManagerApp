import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  games, scores, bowlers, teams, leagues,
  type Game, type InsertGame, type UpdateGame,
  type Score, type InsertScore, type UpdateScore,
} from "@shared/schema";
import { createLogger } from '../logger';
import { lockLeagueSchedule } from './league-schedule-lock.js';
import {
  assertNoOccurrenceReferenceConflict,
  logOccurrenceCompatibility,
  OccurrenceCompatibilityConflictError,
  resolveCanonicalOccurrenceCompatibility,
} from '../services/canonical-occurrence-compatibility.js';

const log = createLogger("StorageGamesScores");

export async function getGames(leagueId: number, weekNumber?: number): Promise<Game[]> {
  if (weekNumber !== undefined) {
    return db
      .select()
      .from(games)
      .where(and(
        eq(games.leagueId, leagueId),
        eq(games.weekNumber, weekNumber)
      ))
      .orderBy(games.gameNumber);
  }
  return db
    .select()
    .from(games)
    .where(eq(games.leagueId, leagueId))
    .orderBy(desc(games.date), games.gameNumber);
}

export async function getGame(id: number): Promise<Game | undefined> {
  const [result] = await db.select().from(games).where(eq(games.id, id));
  return result;
}

export async function createGame(game: InsertGame): Promise<Game> {
  const gameDate = typeof game.date === 'string' ? new Date(game.date) : game.date;
  if (gameDate instanceof Date && isNaN(gameDate.getTime())) {
    throw new Error('Invalid date provided to createGame');
  }
  const dateStr = gameDate instanceof Date ? gameDate.toISOString() : String(game.date);

  const { result, comparison } = await db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues).where(eq(leagues.id, game.leagueId)).limit(1);
    if (!league) throw new Error('League not found for createGame');
    if (league.organizationId === null) {
      const [legacyResult] = await tx.insert(games).values({
        leagueId: game.leagueId,
        weekNumber: game.weekNumber,
        gameNumber: game.gameNumber,
        date: dateStr,
      }).returning();
      return { result: legacyResult, comparison: null };
    }
    await lockLeagueSchedule(tx, league.organizationId, game.leagueId);
    const [duplicate] = await tx.select({ id: games.id }).from(games).where(and(
      eq(games.leagueId, game.leagueId),
      eq(games.weekNumber, game.weekNumber),
      eq(games.gameNumber, game.gameNumber),
    )).limit(1).for('update');
    const compatibility = await resolveCanonicalOccurrenceCompatibility(tx, {
      subject: 'game',
      organizationId: league.organizationId,
      leagueId: game.leagueId,
      legacyCompetitionNumber: game.weekNumber,
      legacyTimestamp: dateStr,
      duplicateLegacyKey: duplicate !== undefined,
      existingReferenceId: null,
    });
    assertNoOccurrenceReferenceConflict(compatibility);
    const [created] = await tx.insert(games).values({
      leagueId: game.leagueId,
      weekNumber: game.weekNumber,
      gameNumber: game.gameNumber,
      date: dateStr,
      occurrenceId: compatibility.classification === 'exact_match'
        ? compatibility.occurrenceId
        : null,
    }).returning();
    return { result: created, comparison: compatibility };
  });
  if (comparison) logOccurrenceCompatibility('game_create', comparison);
  if (!result) throw new Error('Game was not created');
  return result;
}

export async function updateGame(id: number, game: UpdateGame): Promise<Game> {
  const normalizedDate = game.date
    ? (typeof game.date === 'string' ? game.date : new Date(game.date).toISOString())
    : undefined;
  const { result, comparison } = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(games).where(eq(games.id, id)).limit(1).for('update');
    if (!current) return { result: undefined, comparison: null };
    const next = {
      leagueId: game.leagueId ?? current.leagueId,
      weekNumber: game.weekNumber ?? current.weekNumber,
      gameNumber: game.gameNumber ?? current.gameNumber,
      date: normalizedDate ?? current.date,
    };
    const [league] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues).where(eq(leagues.id, next.leagueId)).limit(1);
    if (!league) throw new Error('League not found for updateGame');
    if (league.organizationId === null) {
      if (current.occurrenceId !== null) throw new Error('Linked game cannot move to an organization-less league');
      const [updated] = await tx.update(games).set({ ...game, date: normalizedDate })
        .where(eq(games.id, id)).returning();
      return { result: updated, comparison: null };
    }
    await lockLeagueSchedule(tx, league.organizationId, next.leagueId);
    const [duplicate] = await tx.select({ id: games.id }).from(games).where(and(
      eq(games.leagueId, next.leagueId),
      eq(games.weekNumber, next.weekNumber),
      eq(games.gameNumber, next.gameNumber),
      sql`${games.id} <> ${id}`,
    )).limit(1).for('update');
    const compatibility = await resolveCanonicalOccurrenceCompatibility(tx, {
      subject: 'game',
      organizationId: league.organizationId,
      leagueId: next.leagueId,
      legacyCompetitionNumber: next.weekNumber,
      legacyTimestamp: next.date,
      duplicateLegacyKey: duplicate !== undefined,
      existingReferenceId: current.occurrenceId,
    });
    assertNoOccurrenceReferenceConflict(compatibility);
    if (current.occurrenceId !== null
      && (compatibility.classification !== 'exact_match'
        || compatibility.occurrenceId !== current.occurrenceId)) {
      throw new OccurrenceCompatibilityConflictError(compatibility);
    }
    const [updated] = await tx.update(games).set({
      ...game,
      date: normalizedDate,
      occurrenceId: compatibility.classification === 'exact_match'
        ? compatibility.occurrenceId
        : null,
    }).where(eq(games.id, id)).returning();
    return { result: updated, comparison: compatibility };
  });
  if (comparison) logOccurrenceCompatibility('game_update', comparison);
  if (!result) throw new Error('Game not found for updateGame');
  return result;
}

export async function deleteGame(id: number): Promise<void> {
  await db.delete(games).where(eq(games.id, id));
}

export async function getScores(gameId: number, teamId?: number): Promise<Score[]> {
  if (teamId !== undefined) {
    return db
      .select()
      .from(scores)
      .where(and(
        eq(scores.gameId, gameId),
        eq(scores.teamId, teamId)
      ))
      .orderBy(scores.position);
  }
  return db
    .select()
    .from(scores)
    .where(eq(scores.gameId, gameId))
    .orderBy(scores.teamId, scores.position);
}

export async function getScore(id: number): Promise<Score | undefined> {
  const [result] = await db.select().from(scores).where(eq(scores.id, id));
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
    .where(eq(scores.bowlerId, bowlerId))
    .orderBy(desc(games.date), games.gameNumber);

  log.info('Found scores:', results.length);
  if (results.length > 0) {
    log.info('Sample score:', results[0]);
  }

  return results;
}

export async function createScore(score: InsertScore): Promise<Score> {
  const [result] = await db.insert(scores).values(score).returning();
  return result;
}

export async function updateScore(id: number, score: UpdateScore): Promise<Score> {
  const [result] = await db.update(scores).set(score).where(eq(scores.id, id)).returning();
  return result;
}

export async function deleteScore(id: number): Promise<void> {
  await db.delete(scores).where(eq(scores.id, id));
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

    const results = await db
      .insert(scores)
      .values(batchScores)
      .returning();

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
    .where(eq(scores.gameId, gameId))
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
        eq(games.weekNumber, weekNumber)
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
    .where(inArray(scores.gameId, gameIds))
    .orderBy(scores.gameId, scores.teamId, scores.position);
}
