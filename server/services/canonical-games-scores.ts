import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  games,
  leagues,
  scores,
  teams,
  type Game,
  type InsertGame,
  type InsertScore,
  type Score,
  type UpdateGame,
} from "@shared/schema";
import {
  CANONICAL_GAMES_SCORES_CONTRACT_VERSION,
  CANONICAL_GAMES_SCORES_FINGERPRINT_VERSION,
  CANONICAL_GAMES_SCORES_ORDER_VERSION,
  type BowlerScoreHistoryReadContract,
  type CanonicalGameProjection,
  type CanonicalGamesScoresIncompatibilityClassification,
  type CanonicalScoreProjection,
  type LeagueGamesReadContract,
  type LeagueScoresReadContract,
} from "@shared/canonical-games-scores";
import { compareCanonicalOccurrenceCompatibility } from "@shared/canonical-occurrence-compatibility";
import { canonicalJsonStringify, extractStoredDateOnly } from "@shared/completed-summer-comparator";
import type { LeagueOccurrenceScheduleReadContract } from "@shared/league-occurrence-schedule";
import { db } from "../db.js";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";
import {
  LeagueOccurrenceScheduleError,
  loadLeagueOccurrenceScheduleSnapshot,
} from "./league-occurrence-schedule.js";

const MAX_EVIDENCE_COUNT = 20;

export interface CanonicalGamesScoresErrorEvidence {
  contractVersion: typeof CANONICAL_GAMES_SCORES_CONTRACT_VERSION;
  organizationId: number;
  leagueId: number | null;
  classification: CanonicalGamesScoresIncompatibilityClassification;
  gameCount: number;
  scoreCount: number;
  fingerprintVersion: typeof CANONICAL_GAMES_SCORES_FINGERPRINT_VERSION;
  fingerprint: string;
}

export class CanonicalGamesScoresError extends Error {
  readonly evidence: CanonicalGamesScoresErrorEvidence;

  constructor(input: {
    organizationId: number;
    leagueId?: number | null;
    classification: CanonicalGamesScoresIncompatibilityClassification;
    gameCount?: number;
    scoreCount?: number;
  }) {
    super(`Canonical games/scores incompatibility: ${input.classification}`);
    this.name = "CanonicalGamesScoresError";
    const semantic = {
      contractVersion: CANONICAL_GAMES_SCORES_CONTRACT_VERSION,
      fingerprintVersion: CANONICAL_GAMES_SCORES_FINGERPRINT_VERSION,
      organizationId: input.organizationId,
      leagueId: input.leagueId ?? null,
      classification: input.classification,
      gameCount: Math.min(input.gameCount ?? 0, MAX_EVIDENCE_COUNT),
      scoreCount: Math.min(input.scoreCount ?? 0, MAX_EVIDENCE_COUNT),
    };
    this.evidence = {
      ...semantic,
      fingerprint: createHash("sha256").update(canonicalJsonStringify(semantic), "utf8").digest("hex"),
    };
  }
}

export type CanonicalGamesScoresReadExecutor = typeof db | LeagueScheduleTransaction;

type Executor = CanonicalGamesScoresReadExecutor;

interface LeagueReadInput {
  organizationId: number;
  leagueId: number;
  weekNumber?: number;
  occurrenceId?: string;
  latestScoredSession?: boolean;
}

function error(
  input: Pick<LeagueReadInput, "organizationId" | "leagueId">,
  classification: CanonicalGamesScoresIncompatibilityClassification,
  counts: { gameCount?: number; scoreCount?: number } = {},
): never {
  throw new CanonicalGamesScoresError({ ...input, classification, ...counts });
}

async function scheduleSnapshot(
  executor: Executor,
  input: Pick<LeagueReadInput, "organizationId" | "leagueId">,
): Promise<LeagueOccurrenceScheduleReadContract> {
  try {
    return await loadLeagueOccurrenceScheduleSnapshot({
      ...input,
      includeAdministratorEvidence: false,
    }, executor);
  } catch (caught) {
    if (caught instanceof LeagueOccurrenceScheduleError && caught.code === "incompatible_canonical_state") {
      return error(input, "canonical_schedule_incompatible");
    }
    throw caught;
  }
}

function legacyProjectionKey(game: Game): string {
  return `legacy-game:${game.leagueId}:${game.weekNumber}:${extractStoredDateOnly(game.date) ?? game.date}`;
}

function legacyProjection(game: Game): CanonicalGameProjection {
  return {
    ...game,
    identitySource: "legacy_projection",
    legacyProjectionKey: legacyProjectionKey(game),
    occurrence: null,
  };
}

function exactOccurrenceForCompetition(
  schedule: LeagueOccurrenceScheduleReadContract,
  input: LeagueReadInput,
) {
  const matching = schedule.occurrences.filter((row) => row.competitionNumber === input.weekNumber);
  if (matching.length === 0) return error(input, "competition_mapping_missing");
  if (matching.length !== 1) return error(input, "competition_mapping_ambiguous");
  return matching[0];
}

function selectedCanonicalOccurrenceIds(
  schedule: LeagueOccurrenceScheduleReadContract,
  input: LeagueReadInput,
): ReadonlySet<string> | null {
  if (input.occurrenceId !== undefined) {
    const occurrence = schedule.occurrences.find((row) => row.occurrenceId === input.occurrenceId);
    if (!occurrence?.occurrenceId) return error(input, "game_occurrence_not_operational");
    return new Set([occurrence.occurrenceId]);
  }
  if (input.weekNumber !== undefined) {
    const occurrence = exactOccurrenceForCompetition(schedule, input);
    if (!occurrence?.occurrenceId) return error(input, "competition_mapping_missing");
    return new Set([occurrence.occurrenceId]);
  }
  return null;
}

async function projectLeagueGames(
  executor: Executor,
  schedule: LeagueOccurrenceScheduleReadContract,
  input: LeagueReadInput,
): Promise<CanonicalGameProjection[]> {
  if (schedule.authoritativeSource === "legacy_fallback") {
    if (input.occurrenceId !== undefined) return error(input, "legacy_occurrence_access_unavailable");
    const where = input.weekNumber === undefined
      ? eq(games.leagueId, input.leagueId)
      : and(eq(games.leagueId, input.leagueId), eq(games.weekNumber, input.weekNumber));
    const rows = await executor.select().from(games).where(where).orderBy(
      input.weekNumber === undefined ? desc(games.date) : asc(games.gameNumber),
      asc(games.gameNumber),
      asc(games.id),
    );
    return rows.map(legacyProjection);
  }

  const rows = await executor.select().from(games)
    .where(eq(games.leagueId, input.leagueId))
    .orderBy(asc(games.id));
  const occurrenceMap = new Map(schedule.occurrences.flatMap((row) => row.occurrenceId ? [[row.occurrenceId, row] as const] : []));
  const occurrenceGameKeys = new Set<string>();
  const legacyKeys = new Set<string>();
  const projected: CanonicalGameProjection[] = [];

  for (const row of rows) {
    if (row.occurrenceId === null) {
      return error(input, "unlinked_canonical_game", { gameCount: rows.length });
    }
    const occurrenceId = row.occurrenceId;
    const occurrence = occurrenceMap.get(occurrenceId);
    if (!occurrence) {
      return error(input, "game_occurrence_not_operational", { gameCount: rows.length });
    }
    const occurrenceGameKey = `${occurrenceId}:${row.gameNumber}`;
    if (occurrenceGameKeys.has(occurrenceGameKey)) {
      return error(input, "duplicate_occurrence_game_number", { gameCount: rows.length });
    }
    occurrenceGameKeys.add(occurrenceGameKey);
    const legacyKey = `${row.weekNumber}:${row.gameNumber}`;
    if (legacyKeys.has(legacyKey)) {
      return error(input, "duplicate_legacy_game_key", { gameCount: rows.length });
    }
    legacyKeys.add(legacyKey);
    const compatibility = compareCanonicalOccurrenceCompatibility({
      subject: "game",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      canonicalStatePresent: true,
      publishedStatePresent: true,
      referencedOccurrenceInScope: true,
      existingReferenceId: occurrenceId,
      legacyCompetitionNumber: row.weekNumber,
      legacyTimestamp: row.date,
      duplicateLegacyKey: false,
      candidates: [{
        id: occurrenceId,
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        authoritativeLocalDate: occurrence.authoritativeLocalDate,
        authoritativeLocalStartTime: occurrence.authoritativeLocalStartTime ?? "00:00:00",
        timezone: occurrence.timezone,
        startAt: occurrence.startAt ?? "",
        foldResolution: occurrence.foldResolution ?? "unambiguous",
        competitionNumber: occurrence.competitionNumber,
        lifecycle: occurrence.lifecycle === "legacy" ? "draft" : occurrence.lifecycle,
        status: occurrence.status,
      }],
    });
    if (compatibility.classification !== "exact_match") {
      return error(input, "game_legacy_projection_mismatch", { gameCount: rows.length });
    }
    projected.push({
      ...row,
      identitySource: "canonical_uuid",
      legacyProjectionKey: null,
      occurrence,
    });
  }

  const occurrenceOrder = new Map(schedule.occurrences.map((row, index) => [row.occurrenceId, index]));
  projected.sort((left, right) =>
    (occurrenceOrder.get(left.occurrenceId) ?? Number.MAX_SAFE_INTEGER)
      - (occurrenceOrder.get(right.occurrenceId) ?? Number.MAX_SAFE_INTEGER)
    || left.gameNumber - right.gameNumber
    || left.id - right.id);
  const selectedIds = selectedCanonicalOccurrenceIds(schedule, input);
  return selectedIds === null ? projected : projected.filter((row) => row.occurrenceId && selectedIds.has(row.occurrenceId));
}

function baseContract(schedule: LeagueOccurrenceScheduleReadContract) {
  return {
    contractVersion: CANONICAL_GAMES_SCORES_CONTRACT_VERSION,
    orderingVersion: CANONICAL_GAMES_SCORES_ORDER_VERSION,
    organizationId: schedule.organizationId,
    leagueId: schedule.leagueId,
    authoritativeSource: schedule.authoritativeSource,
    operationalCanonicalStateExists: schedule.operationalCanonicalStateExists,
  } as const;
}

async function loadLeagueGamesSnapshot(executor: Executor, input: LeagueReadInput): Promise<LeagueGamesReadContract> {
  const schedule = await scheduleSnapshot(executor, input);
  return { ...baseContract(schedule), games: await projectLeagueGames(executor, schedule, input) };
}

export async function loadLeagueGames(input: LeagueReadInput): Promise<LeagueGamesReadContract> {
  return db.transaction((tx) => loadLeagueGamesSnapshot(tx, input), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function scoreRows(
  executor: Executor,
  gameRows: CanonicalGameProjection[],
  organizationId: number,
  leagueId: number,
): Promise<CanonicalScoreProjection[]> {
  const gameIds = gameRows.map((row) => row.id);
  if (gameIds.length === 0) return [];
  const gameMap = new Map(gameRows.map((row) => [row.id, row]));
  const rows = await executor.select({
    score: scores,
    bowler: { id: bowlers.id, name: bowlers.name, organizationId: bowlers.organizationId },
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
      organizationId: leagues.organizationId,
    },
  }).from(scores)
    .innerJoin(bowlers, eq(bowlers.id, scores.bowlerId))
    .innerJoin(teams, eq(teams.id, scores.teamId))
    .innerJoin(games, eq(games.id, scores.gameId))
    .innerJoin(leagues, eq(leagues.id, games.leagueId))
    .where(inArray(scores.gameId, gameIds))
    .orderBy(asc(scores.gameId), asc(teams.number), asc(scores.position), asc(scores.id));
  return rows.map((row) => {
    const game = gameMap.get(row.score.gameId);
    if (!game) throw new Error("Score game projection is unavailable");
    if (row.league.organizationId !== organizationId
      || row.league.id !== game.leagueId
      || row.team.leagueId !== game.leagueId
      || row.bowler.organizationId !== organizationId) {
      return error({ organizationId, leagueId }, "score_reference_out_of_scope", { scoreCount: rows.length });
    }
    return {
      ...row.score,
      bowler: { id: row.bowler.id, name: row.bowler.name },
      team: row.team,
      league: {
        id: row.league.id,
        name: row.league.name,
        description: row.league.description,
        active: row.league.active,
      },
      game,
    };
  }).sort((left, right) => gameIds.indexOf(left.gameId) - gameIds.indexOf(right.gameId)
    || left.team.number - right.team.number
    || left.position - right.position
    || left.id - right.id);
}

export interface CanonicalGamesScoresEvidenceSnapshot {
  schedule: LeagueOccurrenceScheduleReadContract;
  games: CanonicalGameProjection[];
  scores: CanonicalScoreProjection[];
}

/**
 * Server-internal E3 bridge. The caller owns the transaction so E1 schedule
 * selection, E2 game validation, and inherited score evidence share one
 * repeatable snapshot. This function never starts a nested transaction.
 */
export async function loadCanonicalGamesScoresEvidenceSnapshot(
  executor: CanonicalGamesScoresReadExecutor,
  input: Pick<LeagueReadInput, "organizationId" | "leagueId">,
): Promise<CanonicalGamesScoresEvidenceSnapshot> {
  const schedule = await scheduleSnapshot(executor, input);
  const gameRows = await projectLeagueGames(executor, schedule, input);
  return {
    schedule,
    games: gameRows,
    scores: await scoreRows(executor, gameRows, input.organizationId, input.leagueId),
  };
}

export async function loadLeagueScores(input: LeagueReadInput): Promise<LeagueScoresReadContract> {
  return db.transaction(async (tx) => {
    const gameContract = await loadLeagueGamesSnapshot(tx, input);
    let projectedScores = await scoreRows(tx, gameContract.games, input.organizationId, input.leagueId);
    let selection: LeagueScoresReadContract["selection"];
    if (input.latestScoredSession) {
      const sessions = new Map<string, {
        identitySource: "canonical_uuid" | "legacy_projection";
        occurrenceId: string | null;
        legacyProjectionKey: string | null;
        orderKey: string;
      }>();
      for (const row of projectedScores) {
        const occurrence = row.game.occurrence;
        const identitySource = row.game.identitySource;
        const identity = occurrence?.occurrenceId ?? row.game.legacyProjectionKey;
        if (!identity) return error(input, "latest_scored_session_ambiguous", { scoreCount: projectedScores.length });
        const orderKey = occurrence
          ? `${occurrence.authoritativeLocalDate}T${occurrence.authoritativeLocalStartTime ?? "00:00:00"}`
          : `${extractStoredDateOnly(row.game.date) ?? row.game.date}:${row.game.weekNumber.toString().padStart(10, "0")}:${identity}`;
        sessions.set(`${identitySource}:${identity}`, {
          identitySource,
          occurrenceId: occurrence?.occurrenceId ?? null,
          legacyProjectionKey: row.game.legacyProjectionKey,
          orderKey,
        });
      }
      const orderedSessions = [...sessions.entries()].sort((left, right) =>
        right[1].orderKey.localeCompare(left[1].orderKey) || right[0].localeCompare(left[0]))[0];
      const latest = orderedSessions;
      if (latest?.[1].identitySource === "canonical_uuid") {
        const tiedCanonicalSessions = [...sessions.values()].filter((session) =>
          session.identitySource === "canonical_uuid" && session.orderKey === latest[1].orderKey);
        if (tiedCanonicalSessions.length !== 1) {
          return error(input, "latest_scored_session_ambiguous", { scoreCount: projectedScores.length });
        }
      }
      if (latest) {
        const [latestKey, latestSession] = latest;
        projectedScores = projectedScores.filter((row) => {
          const identity = row.game.occurrence?.occurrenceId ?? row.game.legacyProjectionKey;
          return `${row.game.identitySource}:${identity}` === latestKey;
        });
        selection = {
          kind: "latest_scored_session",
          identitySource: latestSession.identitySource,
          occurrenceId: latestSession.occurrenceId,
          legacyProjectionKey: latestSession.legacyProjectionKey,
        };
      } else {
        selection = {
          kind: "latest_scored_session",
          identitySource: null,
          occurrenceId: null,
          legacyProjectionKey: null,
        };
      }
    } else if (input.occurrenceId !== undefined) {
      selection = { kind: "occurrence_id", occurrenceId: input.occurrenceId };
    } else if (input.weekNumber !== undefined) {
      selection = { kind: "competition_number", competitionNumber: input.weekNumber };
    } else {
      selection = { kind: "all" };
    }
    return {
      contractVersion: gameContract.contractVersion,
      orderingVersion: gameContract.orderingVersion,
      organizationId: gameContract.organizationId,
      leagueId: gameContract.leagueId,
      authoritativeSource: gameContract.authoritativeSource,
      operationalCanonicalStateExists: gameContract.operationalCanonicalStateExists,
      selection,
      scores: projectedScores,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function loadBowlerScoreHistory(input: {
  organizationId: number;
  bowlerId: number;
  allowedLeagueIds?: readonly number[];
}): Promise<BowlerScoreHistoryReadContract> {
  return db.transaction(async (tx) => {
    const [bowler] = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
      eq(bowlers.id, input.bowlerId),
      eq(bowlers.organizationId, input.organizationId),
    )).limit(1);
    if (!bowler) {
      throw new CanonicalGamesScoresError({
        organizationId: input.organizationId,
        classification: "score_reference_out_of_scope",
      });
    }
    const allowed = input.allowedLeagueIds === undefined ? null : new Set(input.allowedLeagueIds);
    const leagueIds = (await tx.selectDistinct({ leagueId: games.leagueId }).from(scores)
      .innerJoin(games, eq(games.id, scores.gameId))
      .innerJoin(leagues, eq(leagues.id, games.leagueId))
      .where(and(
        eq(scores.bowlerId, input.bowlerId),
        eq(leagues.organizationId, input.organizationId),
        eq(leagues.scheduleAuthority, "canonical"),
      ))
      .orderBy(asc(games.leagueId)))
      .map((row) => row.leagueId)
      .filter((leagueId) => allowed === null || allowed.has(leagueId));
    const allScores: CanonicalScoreProjection[] = [];
    for (const leagueId of leagueIds) {
      const gameContract = await loadLeagueGamesSnapshot(tx, {
        organizationId: input.organizationId,
        leagueId,
      });
      const leagueScores = await scoreRows(tx, gameContract.games, input.organizationId, leagueId);
      allScores.push(...leagueScores.filter((row) => row.bowlerId === input.bowlerId));
    }
    allScores.sort((left, right) => {
      const leftDate = left.game.occurrence?.authoritativeLocalDate ?? extractStoredDateOnly(left.game.date) ?? left.game.date;
      const rightDate = right.game.occurrence?.authoritativeLocalDate ?? extractStoredDateOnly(right.game.date) ?? right.game.date;
      return rightDate.localeCompare(leftDate)
        || left.league.id - right.league.id
        || left.game.gameNumber - right.game.gameNumber
        || left.team.number - right.team.number
        || left.position - right.position
        || left.id - right.id;
    });
    return {
      contractVersion: CANONICAL_GAMES_SCORES_CONTRACT_VERSION,
      orderingVersion: CANONICAL_GAMES_SCORES_ORDER_VERSION,
      organizationId: input.organizationId,
      bowlerId: input.bowlerId,
      scores: allScores,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

function validateCanonicalGameInput(
  schedule: LeagueOccurrenceScheduleReadContract,
  input: LeagueReadInput & { weekNumber: number; date: string },
) {
  const occurrence = exactOccurrenceForCompetition(schedule, input);
  const occurrenceId = occurrence?.occurrenceId;
  if (!occurrenceId || occurrence.status !== "scheduled") {
    return error(input, "game_occurrence_not_operational");
  }
  const comparison = compareCanonicalOccurrenceCompatibility({
    subject: "game",
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    canonicalStatePresent: true,
    publishedStatePresent: true,
    referencedOccurrenceInScope: true,
    existingReferenceId: occurrenceId,
    legacyCompetitionNumber: input.weekNumber,
    legacyTimestamp: input.date,
    duplicateLegacyKey: false,
    candidates: [{
      id: occurrenceId,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      authoritativeLocalDate: occurrence.authoritativeLocalDate,
      authoritativeLocalStartTime: occurrence.authoritativeLocalStartTime ?? "00:00:00",
      timezone: occurrence.timezone,
      startAt: occurrence.startAt ?? "",
      foldResolution: occurrence.foldResolution ?? "unambiguous",
      competitionNumber: occurrence.competitionNumber,
      lifecycle: occurrence.lifecycle === "legacy" ? "draft" : occurrence.lifecycle,
      status: occurrence.status,
    }],
  });
  if (comparison.classification !== "exact_match") return error(input, "game_legacy_projection_mismatch");
  return { occurrence, occurrenceId };
}

function normalizeGameDate(value: string | Date): string {
  const normalized = typeof value === "string" ? value : value.toISOString();
  if (!Number.isFinite(new Date(normalized).getTime())) throw new Error("Invalid date provided for game");
  return normalized;
}

export async function createCanonicalAwareGame(game: InsertGame): Promise<Game> {
  const date = normalizeGameDate(game.date);
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues).where(eq(leagues.id, game.leagueId)).limit(1);
    if (!scope) throw new Error("League not found for createGame");
    await lockLeagueSchedule(tx, scope.organizationId, game.leagueId);
    const [league] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
      .from(leagues).where(eq(leagues.id, game.leagueId)).limit(1).for("share");
    if (!league || league.organizationId !== scope.organizationId) throw new Error("League scope changed while createGame was waiting for its schedule lock");
    if (!league.active || league.scheduleAuthority !== "canonical") throw new Error("Inactive or retired leagues are read-only");
    if (league.organizationId === null) {
      const [created] = await tx.insert(games).values({ ...game, date, occurrenceId: null }).returning();
      if (!created) throw new Error("Game was not created");
      return created;
    }
    const schedule = await scheduleSnapshot(tx, { organizationId: league.organizationId, leagueId: game.leagueId });
    if (schedule.authoritativeSource === "legacy_fallback") {
      const [created] = await tx.insert(games).values({ ...game, date, occurrenceId: null }).returning();
      if (!created) throw new Error("Game was not created");
      return created;
    }
    await projectLeagueGames(tx, schedule, { organizationId: league.organizationId, leagueId: game.leagueId });
    const { occurrenceId } = validateCanonicalGameInput(schedule, {
      organizationId: league.organizationId,
      leagueId: game.leagueId,
      weekNumber: game.weekNumber,
      date,
    });
    const [duplicate] = await tx.select({ id: games.id }).from(games).where(and(
      eq(games.occurrenceId, occurrenceId),
      eq(games.gameNumber, game.gameNumber),
    )).limit(1).for("update");
    if (duplicate) return error({ organizationId: league.organizationId, leagueId: game.leagueId }, "duplicate_occurrence_game_number", { gameCount: 1 });
    const [created] = await tx.insert(games).values({ ...game, date, occurrenceId }).returning();
    if (!created) throw new Error("Game was not created");
    return created;
  });
}

export async function updateCanonicalAwareGame(id: number, patch: UpdateGame): Promise<Game> {
  return db.transaction(async (tx) => {
    const [preRead] = await tx.select({
      leagueId: games.leagueId,
      organizationId: leagues.organizationId,
      active: leagues.active,
      scheduleAuthority: leagues.scheduleAuthority,
    }).from(games).innerJoin(leagues, eq(leagues.id, games.leagueId))
      .where(eq(games.id, id)).limit(1);
    if (!preRead) throw new Error("Game not found for updateGame");
    if (!preRead.active || preRead.scheduleAuthority !== "canonical") throw new Error("Inactive or retired leagues are read-only");
    if (patch.leagueId !== undefined && patch.leagueId !== preRead.leagueId) {
      throw new CanonicalGamesScoresError({
        organizationId: preRead.organizationId ?? 0,
        leagueId: preRead.leagueId,
        classification: "game_occurrence_out_of_scope",
      });
    }
    await lockLeagueSchedule(tx, preRead.organizationId, preRead.leagueId);
    const [lockedLeague] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
      .from(leagues).where(eq(leagues.id, preRead.leagueId)).limit(1).for("share");
    if (!lockedLeague || lockedLeague.organizationId !== preRead.organizationId || !lockedLeague.active || lockedLeague.scheduleAuthority !== "canonical") {
      throw new Error("Inactive or retired leagues are read-only");
    }
    const [current] = await tx.select().from(games).where(eq(games.id, id)).limit(1).for("update");
    if (!current || current.leagueId !== preRead.leagueId) throw new Error("Game scope changed while updateGame was waiting for its league lock");
    const [league] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
      .from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (!league || league.organizationId !== preRead.organizationId) {
      throw new Error("League scope changed while updateGame was waiting for its league lock");
    }
    if (!league.active || league.scheduleAuthority !== "canonical") throw new Error("Inactive or retired leagues are read-only");
    const next = {
      leagueId: current.leagueId,
      weekNumber: patch.weekNumber ?? current.weekNumber,
      gameNumber: patch.gameNumber ?? current.gameNumber,
      date: patch.date === undefined ? current.date : normalizeGameDate(patch.date),
    };
    if (league.organizationId === null) {
      if (current.occurrenceId !== null) throw new Error("Linked game cannot move to an organization-less league");
      const [updated] = await tx.update(games).set(next).where(eq(games.id, id)).returning();
      if (!updated) throw new Error("Game not found for updateGame");
      return updated;
    }
    const scope = { organizationId: league.organizationId, leagueId: current.leagueId };
    const schedule = await scheduleSnapshot(tx, scope);
    if (schedule.authoritativeSource === "legacy_fallback") {
      if (current.occurrenceId !== null) return error(scope, "game_occurrence_not_operational");
      const [updated] = await tx.update(games).set(next).where(eq(games.id, id)).returning();
      if (!updated) throw new Error("Game not found for updateGame");
      return updated;
    }
    await projectLeagueGames(tx, schedule, scope);
    if (current.occurrenceId === null) return error(scope, "unlinked_canonical_game");
    const { occurrenceId } = validateCanonicalGameInput(schedule, { ...scope, weekNumber: next.weekNumber, date: next.date });
    if (occurrenceId !== current.occurrenceId) return error(scope, "game_occurrence_out_of_scope");
    const [duplicate] = await tx.select({ id: games.id }).from(games).where(and(
      eq(games.occurrenceId, current.occurrenceId),
      eq(games.gameNumber, next.gameNumber),
      sql`${games.id} <> ${id}`,
    )).limit(1).for("update");
    if (duplicate) return error(scope, "duplicate_occurrence_game_number", { gameCount: 1 });
    const [updated] = await tx.update(games).set(next).where(eq(games.id, id)).returning();
    if (!updated) throw new Error("Game not found for updateGame");
    return updated;
  });
}

export async function deleteCanonicalAwareGame(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [preRead] = await tx.select({
      leagueId: games.leagueId,
      organizationId: leagues.organizationId,
      active: leagues.active,
      scheduleAuthority: leagues.scheduleAuthority,
    }).from(games).innerJoin(leagues, eq(leagues.id, games.leagueId))
      .where(eq(games.id, id)).limit(1);
    if (!preRead) return;
    if (!preRead.active || preRead.scheduleAuthority !== "canonical") throw new Error("Inactive or retired leagues are read-only");
    await lockLeagueSchedule(tx, preRead.organizationId, preRead.leagueId);
    const [lockedLeague] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
      .from(leagues).where(eq(leagues.id, preRead.leagueId)).limit(1).for("share");
    if (!lockedLeague || lockedLeague.organizationId !== preRead.organizationId || !lockedLeague.active || lockedLeague.scheduleAuthority !== "canonical") {
      throw new Error("Inactive or retired leagues are read-only");
    }
    const [current] = await tx.select().from(games).where(eq(games.id, id)).limit(1).for("update");
    if (!current) return;
    if (current.leagueId !== preRead.leagueId) throw new Error("Game scope changed while deleteGame was waiting for its league lock");
    if (current.occurrenceId !== null) {
      throw new CanonicalGamesScoresError({
        organizationId: lockedLeague.organizationId ?? 0,
        leagueId: current.leagueId,
        classification: "linked_game_deletion_unsupported",
        gameCount: 1,
      });
    }
    await tx.delete(games).where(eq(games.id, id));
  });
}

export async function inspectScoreBatchLeagueIds(
  organizationId: number,
  gameIds: readonly number[],
): Promise<number[] | null> {
  const uniqueIds = [...new Set(gameIds)].sort((left, right) => left - right);
  if (uniqueIds.length === 0) return [];
  const rows = await db.select({ gameId: games.id, leagueId: games.leagueId }).from(games)
    .innerJoin(leagues, and(eq(leagues.id, games.leagueId), eq(leagues.organizationId, organizationId)))
    .where(inArray(games.id, uniqueIds))
    .orderBy(asc(games.id));
  if (rows.length !== uniqueIds.length) return null;
  return [...new Set(rows.map((row) => row.leagueId))].sort((left, right) => left - right);
}

export async function createAuthorizedScoreBatch(input: {
  organizationId: number;
  authorizedLeagueIds: readonly number[];
  batchScores: InsertScore[];
}): Promise<Score[]> {
  if (input.batchScores.length === 0) return [];
  return db.transaction(async (tx) => {
    const gameIds = [...new Set(input.batchScores.map((row) => row.gameId))].sort((left, right) => left - right);
    const initial = await tx.select({ gameId: games.id, leagueId: games.leagueId }).from(games)
      .innerJoin(leagues, and(eq(leagues.id, games.leagueId), eq(leagues.organizationId, input.organizationId)))
      .where(inArray(games.id, gameIds)).orderBy(asc(games.id));
    if (initial.length !== gameIds.length) {
      throw new CanonicalGamesScoresError({ organizationId: input.organizationId, classification: "score_reference_out_of_scope", scoreCount: input.batchScores.length });
    }
    const authorized = new Set(input.authorizedLeagueIds);
    const leagueIds = [...new Set(initial.map((row) => row.leagueId))].sort((left, right) => left - right);
    if (leagueIds.some((leagueId) => !authorized.has(leagueId))) {
      throw new CanonicalGamesScoresError({ organizationId: input.organizationId, classification: "score_reference_out_of_scope", scoreCount: input.batchScores.length });
    }
    for (const leagueId of leagueIds) await lockLeagueSchedule(tx, input.organizationId, leagueId);
    const lockedGames = await tx.select().from(games).where(inArray(games.id, gameIds)).orderBy(asc(games.id)).for("update");
    if (lockedGames.length !== gameIds.length) {
      throw new CanonicalGamesScoresError({ organizationId: input.organizationId, classification: "score_reference_out_of_scope", scoreCount: input.batchScores.length });
    }
    const gameMap = new Map(lockedGames.map((row) => [row.id, row]));
    for (const leagueId of leagueIds) {
      const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
        .from(leagues).where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).for("share");
      if (!league?.active || league.scheduleAuthority !== "canonical") {
        throw new CanonicalGamesScoresError({ organizationId: input.organizationId, leagueId, classification: "score_reference_out_of_scope", scoreCount: input.batchScores.length });
      }
      const schedule = await scheduleSnapshot(tx, { organizationId: input.organizationId, leagueId });
      await projectLeagueGames(tx, schedule, { organizationId: input.organizationId, leagueId });
    }
    const teamIds = [...new Set(input.batchScores.map((row) => row.teamId))].sort((left, right) => left - right);
    const bowlerIds = [...new Set(input.batchScores.map((row) => row.bowlerId))].sort((left, right) => left - right);
    const teamRows = await tx.select().from(teams)
      .where(inArray(teams.id, teamIds)).orderBy(asc(teams.id)).for("share");
    const bowlerRows = await tx.select({ id: bowlers.id, organizationId: bowlers.organizationId }).from(bowlers)
      .where(and(inArray(bowlers.id, bowlerIds), eq(bowlers.organizationId, input.organizationId)))
      .orderBy(asc(bowlers.id)).for("share");
    const membershipRows = await tx.select().from(bowlerLeagues).where(and(
      inArray(bowlerLeagues.bowlerId, bowlerIds),
      inArray(bowlerLeagues.leagueId, leagueIds),
      eq(bowlerLeagues.active, true),
    )).orderBy(asc(bowlerLeagues.bowlerId), asc(bowlerLeagues.leagueId), asc(bowlerLeagues.teamId)).for("share");
    const teamMap = new Map(teamRows.map((row) => [row.id, row]));
    const validBowlers = new Set(bowlerRows.map((row) => row.id));
    for (const row of input.batchScores) {
      const game = gameMap.get(row.gameId);
      const team = teamMap.get(row.teamId);
      if (!game || !team || team.leagueId !== game.leagueId) {
        throw new CanonicalGamesScoresError({ organizationId: input.organizationId, leagueId: game?.leagueId, classification: "score_team_relationship_invalid", scoreCount: input.batchScores.length });
      }
      if (!validBowlers.has(row.bowlerId)) {
        throw new CanonicalGamesScoresError({ organizationId: input.organizationId, leagueId: game.leagueId, classification: "score_bowler_relationship_invalid", scoreCount: input.batchScores.length });
      }
      const memberships = membershipRows.filter((membership) =>
        membership.bowlerId === row.bowlerId && membership.leagueId === game.leagueId);
      const relationshipIsValid = row.isSub
        ? memberships.length > 0
        : memberships.some((membership) => membership.teamId === row.teamId);
      if (!relationshipIsValid) {
        throw new CanonicalGamesScoresError({ organizationId: input.organizationId, leagueId: game.leagueId, classification: "score_bowler_relationship_invalid", scoreCount: input.batchScores.length });
      }
    }
    return tx.insert(scores).values(input.batchScores).returning();
  });
}
