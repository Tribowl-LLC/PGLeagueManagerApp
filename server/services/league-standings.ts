import { createHash } from "node:crypto";
import type {
  CanonicalGameProjection,
  CanonicalScoreProjection,
} from "@shared/canonical-games-scores";
import { canonicalJsonStringify } from "@shared/completed-summer-comparator";
import {
  LEAGUE_STANDINGS_CONTRACT_VERSION,
  LEAGUE_STANDINGS_FINGERPRINT_ALGORITHM,
  LEAGUE_STANDINGS_FINGERPRINT_VERSION,
  LEAGUE_STANDINGS_ORDER_VERSION,
  type CanonicalLeagueStandingsIdentity,
  type LeagueStandingsDiscrepancy,
  type LeagueStandingsDiscrepancyClassification,
  type LeagueStandingsEligibility,
  type LeagueStandingsGameEvidence,
  type LeagueStandingsIncompatibilityClassification,
  type LeagueStandingsOccurrenceEvidence,
  type LeagueStandingsReadContract,
  type LeagueStandingsResultSessionEvidence,
  type LeagueStandingsScoreEvidence,
  type LeagueStandingsStableIdentity,
  type LeagueStandingsSummary,
} from "@shared/league-standings";
import type {
  LeagueOccurrenceScheduleOccurrence,
  LeagueOccurrenceScheduleReadContract,
} from "@shared/league-occurrence-schedule";
import { db } from "../db.js";
import {
  CanonicalGamesScoresError,
  loadCanonicalGamesScoresEvidenceSnapshot,
  type CanonicalGamesScoresEvidenceSnapshot,
  type CanonicalGamesScoresReadExecutor,
} from "./canonical-games-scores.js";

export const MAX_LEAGUE_STANDINGS_DISCREPANCIES = 200;
const MAX_ERROR_EVIDENCE_COUNT = 20;

const ORDERING: LeagueStandingsReadContract["ordering"] = {
  version: LEAGUE_STANDINGS_ORDER_VERSION,
  occurrenceKeys: ["e1PhysicalOrder"],
  canonicalResultSessionKeys: ["occurrenceOrderIndex"],
  resultSessionKeys: ["occurrenceOrderIndex"],
  gameKeys: ["gameNumber", "gameId"],
  scoreKeys: ["teamNumber", "teamId", "position", "scoreId"],
  discrepancyKeys: ["classification", "stableIdentity", "gameId"],
};

const RANKING: LeagueStandingsReadContract["ranking"] = {
  state: "policy_required",
  policyVersion: null,
  reasonCode: "MATCHUP_AND_RANKING_POLICY_REQUIRED",
  rows: [],
};

export interface LeagueStandingsErrorEvidence {
  contractVersion: typeof LEAGUE_STANDINGS_CONTRACT_VERSION;
  fingerprintVersion: typeof LEAGUE_STANDINGS_FINGERPRINT_VERSION;
  organizationId: number;
  leagueId: number;
  classification: LeagueStandingsIncompatibilityClassification;
  occurrenceCount: number;
  gameCount: number;
  scoreCount: number;
  fingerprint: string;
}

export class LeagueStandingsError extends Error {
  readonly evidence: LeagueStandingsErrorEvidence;

  constructor(input: {
    organizationId: number;
    leagueId: number;
    classification: LeagueStandingsIncompatibilityClassification;
    occurrenceCount?: number;
    gameCount?: number;
    scoreCount?: number;
  }) {
    super(`League standings evidence is incompatible: ${input.classification}`);
    this.name = "LeagueStandingsError";
    const semantic = {
      contractVersion: LEAGUE_STANDINGS_CONTRACT_VERSION,
      fingerprintVersion: LEAGUE_STANDINGS_FINGERPRINT_VERSION,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      classification: input.classification,
      occurrenceCount: Math.min(input.occurrenceCount ?? 0, MAX_ERROR_EVIDENCE_COUNT),
      gameCount: Math.min(input.gameCount ?? 0, MAX_ERROR_EVIDENCE_COUNT),
      scoreCount: Math.min(input.scoreCount ?? 0, MAX_ERROR_EVIDENCE_COUNT),
    };
    this.evidence = {
      ...semantic,
      fingerprint: sha256(semantic),
    };
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
}

function incompatible(
  schedule: LeagueOccurrenceScheduleReadContract,
  classification: LeagueStandingsIncompatibilityClassification,
  snapshot?: Pick<CanonicalGamesScoresEvidenceSnapshot, "games" | "scores">,
): never {
  throw new LeagueStandingsError({
    organizationId: schedule.organizationId,
    leagueId: schedule.leagueId,
    classification,
    occurrenceCount: schedule.occurrences.length,
    gameCount: snapshot?.games.length,
    scoreCount: snapshot?.scores.length,
  });
}

function canonicalIdentity(occurrenceId: string): CanonicalLeagueStandingsIdentity {
  return { identitySource: "canonical_uuid", occurrenceId };
}

function eligibilityFor(
  schedule: LeagueOccurrenceScheduleReadContract,
  occurrence: LeagueOccurrenceScheduleOccurrence,
  snapshot: Pick<CanonicalGamesScoresEvidenceSnapshot, "games" | "scores">,
): LeagueStandingsEligibility {
  if (occurrence.lifecycle !== "published" && occurrence.lifecycle !== "locked") {
    return incompatible(schedule, "canonical_occurrence_flag_contradiction", snapshot);
  }
  if (occurrence.status === "completed" && occurrence.lifecycle !== "locked") {
    return incompatible(schedule, "canonical_occurrence_flag_contradiction", snapshot);
  }
  if (occurrence.countsInStandings && !occurrence.competitive) {
    return incompatible(schedule, "canonical_occurrence_flag_contradiction", snapshot);
  }
  if (occurrence.status === "cancelled" && (
    occurrence.competitive
    || occurrence.countsInStandings
    || occurrence.competitionNumber !== null
  )) {
    return incompatible(schedule, "canonical_occurrence_flag_contradiction", snapshot);
  }
  if (occurrence.status === "cancelled") {
    return { state: "excluded_cancelled", reason: "cancelled" };
  }
  if (!occurrence.competitive) {
    return { state: "excluded_noncompetitive", reason: "noncompetitive" };
  }
  if (!occurrence.countsInStandings) {
    return { state: "excluded_by_standings_flag", reason: "counts_in_standings_false" };
  }
  if (occurrence.status === "scheduled") {
    return { state: "pending_not_completed", reason: "scheduled_not_completed" };
  }
  if (occurrence.status === "completed") {
    return {
      state: "eligible_result_input",
      reason: "completed_competitive_counts_in_standings",
    };
  }
  return incompatible(schedule, "canonical_occurrence_flag_contradiction", snapshot);
}

function occurrenceEvidence(
  snapshot: CanonicalGamesScoresEvidenceSnapshot,
): LeagueStandingsOccurrenceEvidence[] {
  const { schedule } = snapshot;
  return schedule.occurrences.map((occurrence, orderIndex) => {
    const identity = canonicalIdentity(occurrence.occurrenceId);
    return {
      orderIndex,
      identity,
      kind: occurrence.kind,
      status: occurrence.status,
      lifecycle: occurrence.lifecycle,
      authoritativeLocalDate: occurrence.authoritativeLocalDate,
      authoritativeLocalStartTime: occurrence.authoritativeLocalStartTime,
      timezone: occurrence.timezone,
      startAt: occurrence.startAt,
      plannedOrdinal: occurrence.plannedOrdinal,
      competitionNumber: occurrence.competitionNumber,
      competitive: occurrence.competitive,
      countsInStandings: occurrence.countsInStandings,
      relationships: occurrence.relationships.map((relationship) => ({
        kind: relationship.kind,
        role: relationship.role,
        relatedOccurrenceId: relationship.relatedOccurrenceId,
      })),
      eligibility: eligibilityFor(schedule, occurrence, snapshot),
    };
  });
}

function compareScores(left: LeagueStandingsScoreEvidence, right: LeagueStandingsScoreEvidence): number {
  return left.teamNumber - right.teamNumber
    || left.teamId - right.teamId
    || left.position - right.position
    || left.scoreId - right.scoreId;
}

function scoreEvidence(score: CanonicalScoreProjection): LeagueStandingsScoreEvidence {
  return {
    scoreId: score.id,
    bowlerId: score.bowlerId,
    teamId: score.teamId,
    teamNumber: score.team.number,
    gameId: score.gameId,
    score: score.score,
    handicap: score.handicap,
    average: score.average,
    position: score.position,
    isVacant: score.isVacant,
    isAbsent: score.isAbsent,
    isSub: score.isSub,
    laneNumber: score.laneNumber,
  };
}

function gameEvidence(
  game: CanonicalGameProjection,
  scoresByGameId: ReadonlyMap<number, CanonicalScoreProjection[]>,
): LeagueStandingsGameEvidence {
  return {
    gameId: game.id,
    gameNumber: game.gameNumber,
    scores: (scoresByGameId.get(game.id) ?? []).map(scoreEvidence).sort(compareScores),
  };
}

function resultSessionEvidence(
  snapshot: CanonicalGamesScoresEvidenceSnapshot,
  occurrences: LeagueStandingsOccurrenceEvidence[],
): LeagueStandingsResultSessionEvidence[] {
  const scoresByGameId = new Map<number, CanonicalScoreProjection[]>();
  const gameIds = new Set(snapshot.games.map((game) => game.id));
  for (const score of snapshot.scores) {
    if (!gameIds.has(score.gameId)) {
      return incompatible(snapshot.schedule, "canonical_games_scores_incompatible", snapshot);
    }
    const rows = scoresByGameId.get(score.gameId) ?? [];
    rows.push(score);
    scoresByGameId.set(score.gameId, rows);
  }

  const grouped = new Map<string, CanonicalGameProjection[]>();
  for (const game of snapshot.games) {
    if (game.identitySource !== "canonical_uuid"
      || game.occurrence.occurrenceId !== game.occurrenceId) {
      return incompatible(snapshot.schedule, "canonical_games_scores_incompatible", snapshot);
    }
    const key = `canonical:${game.occurrenceId}`;
    const rows = grouped.get(key) ?? [];
    rows.push(game);
    grouped.set(key, rows);
  }

  const canonicalOccurrences = new Map<string, LeagueStandingsOccurrenceEvidence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.identity.identitySource !== "canonical_uuid") continue;
    const rows = canonicalOccurrences.get(occurrence.identity.occurrenceId) ?? [];
    rows.push(occurrence);
    canonicalOccurrences.set(occurrence.identity.occurrenceId, rows);
  }

  const sessions: LeagueStandingsResultSessionEvidence[] = [];
  for (const games of grouped.values()) {
    const first = games[0];
    if (!first) continue;
    const matching = canonicalOccurrences.get(first.occurrenceId) ?? [];
    if (matching.length === 0) return incompatible(snapshot.schedule, "canonical_result_occurrence_missing", snapshot);
    if (matching.length !== 1) return incompatible(snapshot.schedule, "canonical_result_occurrence_ambiguous", snapshot);
    const occurrence = matching[0];
    sessions.push({
      orderIndex: occurrence.orderIndex,
      identity: canonicalIdentity(first.occurrenceId),
      occurrenceOrderIndex: occurrence.orderIndex,
      eligibility: occurrence.eligibility,
      games: games.map((game) => gameEvidence(game, scoresByGameId))
        .sort((left, right) => left.gameNumber - right.gameNumber || left.gameId - right.gameId),
    });
  }
  sessions.sort((left, right) => left.occurrenceOrderIndex - right.occurrenceOrderIndex);
  sessions.forEach((session, orderIndex) => { session.orderIndex = orderIndex; });
  return sessions;
}

function identitySortKey(identity: LeagueStandingsStableIdentity | null): string {
  if (identity === null) return "~";
  if (identity.identitySource === "canonical_uuid") return `canonical:${identity.occurrenceId}`;
  return `canonical:${identity.occurrenceId}`;
}

function compareDiscrepancies(
  left: LeagueStandingsDiscrepancy,
  right: LeagueStandingsDiscrepancy,
): number {
  return left.classification.localeCompare(right.classification)
    || identitySortKey(left.identity).localeCompare(identitySortKey(right.identity))
    || (left.gameId ?? Number.MAX_SAFE_INTEGER) - (right.gameId ?? Number.MAX_SAFE_INTEGER);
}

function combineDiscrepancies(
  discrepancies: LeagueStandingsDiscrepancy[],
): LeagueStandingsDiscrepancy[] {
  const combined = new Map<string, LeagueStandingsDiscrepancy>();
  for (const discrepancy of discrepancies) {
    const key = [
      discrepancy.classification,
      discrepancy.severity,
      identitySortKey(discrepancy.identity),
      discrepancy.gameId ?? "none",
    ].join(":");
    const existing = combined.get(key);
    if (existing) {
      existing.evidenceCount += discrepancy.evidenceCount;
    } else {
      combined.set(key, { ...discrepancy });
    }
  }
  return [...combined.values()].sort(compareDiscrepancies);
}

function buildDiscrepancies(
  snapshot: CanonicalGamesScoresEvidenceSnapshot,
  occurrences: LeagueStandingsOccurrenceEvidence[],
  resultSessions: LeagueStandingsResultSessionEvidence[],
): LeagueStandingsDiscrepancy[] {
  const discrepancies: LeagueStandingsDiscrepancy[] = [
    {
      classification: "ranking_policy_required",
      severity: "info",
      identity: null,
      gameId: null,
      evidenceCount: 1,
    },
    {
      classification: "matchup_evidence_unavailable",
      severity: "warning",
      identity: null,
      gameId: null,
      evidenceCount: 1,
    },
  ];
  const add = (
    classification: LeagueStandingsDiscrepancyClassification,
    severity: LeagueStandingsDiscrepancy["severity"],
    identity: LeagueStandingsStableIdentity,
    gameId: number | null,
    evidenceCount: number,
  ) => discrepancies.push({ classification, severity, identity, gameId, evidenceCount });

  for (const resultSession of resultSessions) {
    for (const game of resultSession.games) {
      const slots = new Map<string, number>();
      for (const score of game.scores) {
        const key = `${score.teamId}:${score.position}`;
        slots.set(key, (slots.get(key) ?? 0) + 1);
      }
      for (const count of slots.values()) {
        if (count > 1) {
          add("duplicate_score_slot", "warning", resultSession.identity, game.gameId, count);
        }
      }
    }
  }

  const sessionsByOccurrence = new Map(resultSessions.flatMap((session) =>
    [[session.identity.occurrenceId, session] as const]));
  for (const occurrence of occurrences) {
    const resultSession = sessionsByOccurrence.get(occurrence.identity.occurrenceId);
    if (occurrence.eligibility.state === "eligible_result_input" && !resultSession) {
      add("completed_eligible_occurrence_without_games", "warning", occurrence.identity, null, 1);
      continue;
    }
    if (!resultSession) continue;
    const sessionScoreCount = resultSession.games.reduce((sum, game) => sum + game.scores.length, 0);
    if (occurrence.eligibility.state === "eligible_result_input") {
      for (const game of resultSession.games) {
        if (game.scores.length === 0) {
          add("completed_eligible_game_without_scores", "warning", occurrence.identity, game.gameId, 1);
        }
      }
    } else if (occurrence.eligibility.state === "pending_not_completed" && sessionScoreCount > 0) {
      add("pending_occurrence_has_score_evidence", "info", occurrence.identity, null, sessionScoreCount);
    } else if (occurrence.eligibility.state.startsWith("excluded_") && sessionScoreCount > 0) {
      add("excluded_occurrence_has_score_evidence", "warning", occurrence.identity, null, sessionScoreCount);
    }
  }
  return combineDiscrepancies(discrepancies);
}

function buildSummary(
  occurrences: LeagueStandingsOccurrenceEvidence[],
  resultSessions: LeagueStandingsResultSessionEvidence[],
  discrepancyCount: number,
): LeagueStandingsSummary {
  return {
    occurrenceCount: occurrences.length,
    eligibleOccurrenceCount: occurrences.filter((row) => row.eligibility.state === "eligible_result_input").length,
    pendingOccurrenceCount: occurrences.filter((row) => row.eligibility.state === "pending_not_completed").length,
    excludedOccurrenceCount: occurrences.filter((row) => row.eligibility.state.startsWith("excluded_")).length,
    resultSessionCount: resultSessions.length,
    gameCount: resultSessions.reduce((sum, session) => sum + session.games.length, 0),
    scoreCount: resultSessions.reduce((sessionSum, session) => sessionSum
      + session.games.reduce((gameSum, game) => gameSum + game.scores.length, 0), 0),
    discrepancyCount,
    discrepanciesTruncated: discrepancyCount > MAX_LEAGUE_STANDINGS_DISCREPANCIES,
  };
}

export function buildLeagueStandingsContract(
  snapshot: CanonicalGamesScoresEvidenceSnapshot,
): LeagueStandingsReadContract {
  const occurrences = occurrenceEvidence(snapshot);
  const resultSessions = resultSessionEvidence(snapshot, occurrences);
  const allDiscrepancies = buildDiscrepancies(snapshot, occurrences, resultSessions);
  const summary = buildSummary(occurrences, resultSessions, allDiscrepancies.length);
  const fingerprintSemantic = {
    contractVersion: LEAGUE_STANDINGS_CONTRACT_VERSION,
    orderingVersion: LEAGUE_STANDINGS_ORDER_VERSION,
    fingerprintVersion: LEAGUE_STANDINGS_FINGERPRINT_VERSION,
    organizationId: snapshot.schedule.organizationId,
    leagueId: snapshot.schedule.leagueId,
    authoritativeSource: snapshot.schedule.authoritativeSource,
    ranking: {
      state: RANKING.state,
      policyVersion: RANKING.policyVersion,
      reasonCode: RANKING.reasonCode,
    },
    occurrences,
    resultSessions,
    discrepancies: allDiscrepancies,
    summary,
  };
  return {
    contractVersion: LEAGUE_STANDINGS_CONTRACT_VERSION,
    ordering: ORDERING,
    organizationId: snapshot.schedule.organizationId,
    leagueId: snapshot.schedule.leagueId,
    authoritativeSource: snapshot.schedule.authoritativeSource,
    ranking: RANKING,
    occurrences,
    resultSessions,
    discrepancies: allDiscrepancies.slice(0, MAX_LEAGUE_STANDINGS_DISCREPANCIES),
    summary,
    evidenceFingerprint: {
      version: LEAGUE_STANDINGS_FINGERPRINT_VERSION,
      algorithm: LEAGUE_STANDINGS_FINGERPRINT_ALGORITHM,
      value: sha256(fingerprintSemantic),
    },
  };
}

export async function loadLeagueStandings(input: {
  organizationId: number;
  leagueId: number;
}): Promise<LeagueStandingsReadContract> {
  return db.transaction(
    (tx) => loadLeagueStandingsSnapshot(tx, input),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function loadLeagueStandingsSnapshot(
  executor: CanonicalGamesScoresReadExecutor,
  input: { organizationId: number; leagueId: number },
): Promise<LeagueStandingsReadContract> {
  try {
    const snapshot = await loadCanonicalGamesScoresEvidenceSnapshot(executor, input);
    return buildLeagueStandingsContract(snapshot);
  } catch (caught) {
    if (caught instanceof LeagueStandingsError) throw caught;
    if (caught instanceof CanonicalGamesScoresError) {
      throw new LeagueStandingsError({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        classification: caught.evidence.classification === "canonical_schedule_incompatible"
          ? "canonical_schedule_incompatible"
          : "canonical_games_scores_incompatible",
        gameCount: caught.evidence.gameCount,
        scoreCount: caught.evidence.scoreCount,
      });
    }
    throw caught;
  }
}
