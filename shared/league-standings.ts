import type {
  LeagueOccurrenceKind,
  LeagueOccurrenceLifecycle,
  LeagueOccurrenceStatus,
} from "./schema/canonical-occurrences";
import type { LeagueOccurrenceScheduleSource } from "./league-occurrence-schedule";

export const LEAGUE_STANDINGS_CONTRACT_VERSION = "league-standings/1" as const;
export const LEAGUE_STANDINGS_ORDER_VERSION = "league-standings-order/1" as const;
export const LEAGUE_STANDINGS_FINGERPRINT_VERSION = "league-standings-fingerprint/1" as const;
export const LEAGUE_STANDINGS_FINGERPRINT_ALGORITHM = "sha256" as const;

export const LEAGUE_STANDINGS_ELIGIBILITY_STATES = [
  "eligible_result_input",
  "pending_not_completed",
  "excluded_cancelled",
  "excluded_noncompetitive",
  "excluded_by_standings_flag",
  "legacy_unverified",
] as const;
export type LeagueStandingsEligibilityState =
  (typeof LEAGUE_STANDINGS_ELIGIBILITY_STATES)[number];

export const LEAGUE_STANDINGS_DISCREPANCY_CLASSIFICATIONS = [
  "ranking_policy_required",
  "matchup_evidence_unavailable",
  "legacy_completion_unproven",
  "legacy_standings_eligibility_unproven",
  "completed_eligible_occurrence_without_games",
  "completed_eligible_game_without_scores",
  "excluded_occurrence_has_score_evidence",
  "pending_occurrence_has_score_evidence",
  "duplicate_score_slot",
] as const;
export type LeagueStandingsDiscrepancyClassification =
  (typeof LEAGUE_STANDINGS_DISCREPANCY_CLASSIFICATIONS)[number];

export const LEAGUE_STANDINGS_DISCREPANCY_SEVERITIES = ["info", "warning"] as const;
export type LeagueStandingsDiscrepancySeverity =
  (typeof LEAGUE_STANDINGS_DISCREPANCY_SEVERITIES)[number];

export const LEAGUE_STANDINGS_INCOMPATIBILITY_CLASSIFICATIONS = [
  "canonical_schedule_incompatible",
  "canonical_games_scores_incompatible",
  "canonical_occurrence_flag_contradiction",
  "canonical_result_occurrence_missing",
  "canonical_result_occurrence_ambiguous",
] as const;
export type LeagueStandingsIncompatibilityClassification =
  (typeof LEAGUE_STANDINGS_INCOMPATIBILITY_CLASSIFICATIONS)[number];

export interface CanonicalLeagueStandingsIdentity {
  identitySource: "canonical_uuid";
  occurrenceId: string;
  legacyProjectionKey: null;
}

export interface LegacyScheduleStandingsIdentity {
  identitySource: "legacy_schedule_projection";
  occurrenceId: null;
  legacyProjectionKey: string;
}

export interface LegacyGameStandingsIdentity {
  identitySource: "legacy_game_projection";
  occurrenceId: null;
  legacyProjectionKey: string;
}

export type LeagueStandingsStableIdentity =
  | CanonicalLeagueStandingsIdentity
  | LegacyScheduleStandingsIdentity
  | LegacyGameStandingsIdentity;

export interface LeagueStandingsEligibility {
  state: LeagueStandingsEligibilityState;
  reason:
    | "completed_competitive_counts_in_standings"
    | "scheduled_not_completed"
    | "cancelled"
    | "noncompetitive"
    | "counts_in_standings_false"
    | "legacy_completion_and_policy_unproven";
}

export interface LeagueStandingsOccurrenceEvidence {
  orderIndex: number;
  identity: CanonicalLeagueStandingsIdentity | LegacyScheduleStandingsIdentity;
  kind: LeagueOccurrenceKind;
  status: Exclude<LeagueOccurrenceStatus, "discarded">;
  lifecycle: LeagueOccurrenceLifecycle | "legacy";
  authoritativeLocalDate: string;
  authoritativeLocalStartTime: string | null;
  timezone: string;
  startAt: string | null;
  plannedOrdinal: number | null;
  competitionNumber: number | null;
  competitive: boolean;
  countsInStandings: boolean;
  relationships: ReadonlyArray<{
    kind: "makeup_for";
    role: "source" | "target";
    relatedOccurrenceId: string;
  }>;
  eligibility: LeagueStandingsEligibility;
}

export interface LeagueStandingsScoreEvidence {
  scoreId: number;
  bowlerId: number;
  teamId: number;
  teamNumber: number;
  gameId: number;
  score: number;
  handicap: number;
  average: number;
  position: number;
  isVacant: boolean;
  isAbsent: boolean;
  isSub: boolean;
  laneNumber: number;
}

export interface LeagueStandingsGameEvidence {
  gameId: number;
  gameNumber: number;
  legacyWeekNumber: number;
  legacyDate: string;
  scores: LeagueStandingsScoreEvidence[];
}

export interface LeagueStandingsResultSessionEvidence {
  orderIndex: number;
  identity: CanonicalLeagueStandingsIdentity | LegacyGameStandingsIdentity;
  occurrenceOrderIndex: number | null;
  eligibility: LeagueStandingsEligibility;
  games: LeagueStandingsGameEvidence[];
}

export interface LeagueStandingsDiscrepancy {
  classification: LeagueStandingsDiscrepancyClassification;
  severity: LeagueStandingsDiscrepancySeverity;
  identity: LeagueStandingsStableIdentity | null;
  gameId: number | null;
  evidenceCount: number;
}

export interface LeagueStandingsSummary {
  occurrenceCount: number;
  eligibleOccurrenceCount: number;
  pendingOccurrenceCount: number;
  excludedOccurrenceCount: number;
  legacyUnverifiedOccurrenceCount: number;
  resultSessionCount: number;
  gameCount: number;
  scoreCount: number;
  discrepancyCount: number;
  discrepanciesTruncated: boolean;
}

export interface LeagueStandingsReadContract {
  contractVersion: typeof LEAGUE_STANDINGS_CONTRACT_VERSION;
  ordering: {
    version: typeof LEAGUE_STANDINGS_ORDER_VERSION;
    occurrenceKeys: readonly ["e1PhysicalOrder"];
    canonicalResultSessionKeys: readonly ["occurrenceOrderIndex"];
    legacyResultSessionKeys: readonly ["e2FirstGameOrder"];
    gameKeys: readonly ["gameNumber", "gameId"];
    scoreKeys: readonly ["teamNumber", "teamId", "position", "scoreId"];
    discrepancyKeys: readonly ["classification", "stableIdentity", "gameId"];
  };
  organizationId: number;
  leagueId: number;
  authoritativeSource: LeagueOccurrenceScheduleSource;
  operationalCanonicalStateExists: boolean;
  ranking: {
    state: "policy_required";
    policyVersion: null;
    reasonCode: "MATCHUP_AND_RANKING_POLICY_REQUIRED";
    rows: [];
  };
  occurrences: LeagueStandingsOccurrenceEvidence[];
  resultSessions: LeagueStandingsResultSessionEvidence[];
  discrepancies: LeagueStandingsDiscrepancy[];
  summary: LeagueStandingsSummary;
  evidenceFingerprint: {
    version: typeof LEAGUE_STANDINGS_FINGERPRINT_VERSION;
    algorithm: typeof LEAGUE_STANDINGS_FINGERPRINT_ALGORITHM;
    value: string;
  };
}
