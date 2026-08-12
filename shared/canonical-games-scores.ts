import type { Game, Score } from "./schema/games";
import type { LeagueOccurrenceScheduleOccurrence, LeagueOccurrenceScheduleSource } from "./league-occurrence-schedule";

export const CANONICAL_GAMES_SCORES_CONTRACT_VERSION = "canonical-games-scores/1" as const;
export const CANONICAL_GAMES_SCORES_ORDER_VERSION = "canonical-games-scores-order/1" as const;
export const CANONICAL_GAMES_SCORES_FINGERPRINT_VERSION = "canonical-games-scores-fingerprint/1" as const;

export const CANONICAL_GAMES_SCORES_INCOMPATIBILITY_CLASSIFICATIONS = [
  "canonical_schedule_incompatible",
  "unlinked_canonical_game",
  "game_occurrence_out_of_scope",
  "game_occurrence_not_operational",
  "game_legacy_projection_mismatch",
  "linked_game_deletion_unsupported",
  "duplicate_occurrence_game_number",
  "duplicate_legacy_game_key",
  "competition_mapping_missing",
  "competition_mapping_ambiguous",
  "legacy_occurrence_access_unavailable",
  "latest_scored_session_ambiguous",
  "score_reference_out_of_scope",
  "score_team_relationship_invalid",
  "score_bowler_relationship_invalid",
] as const;

export type CanonicalGamesScoresIncompatibilityClassification =
  (typeof CANONICAL_GAMES_SCORES_INCOMPATIBILITY_CLASSIFICATIONS)[number];

export interface CanonicalGameProjection extends Game {
  identitySource: "canonical_uuid" | "legacy_projection";
  legacyProjectionKey: string | null;
  occurrence: LeagueOccurrenceScheduleOccurrence | null;
}

export interface CanonicalScoreProjection extends Score {
  bowler: { id: number; name: string };
  team: { id: number; name: string; number: number; leagueId: number; active: boolean };
  league: { id: number; name: string; description: string | null; active: boolean };
  game: CanonicalGameProjection;
}

interface GamesScoresReadBase {
  contractVersion: typeof CANONICAL_GAMES_SCORES_CONTRACT_VERSION;
  orderingVersion: typeof CANONICAL_GAMES_SCORES_ORDER_VERSION;
  organizationId: number;
  leagueId: number;
  authoritativeSource: LeagueOccurrenceScheduleSource;
  operationalCanonicalStateExists: boolean;
}

export interface LeagueGamesReadContract extends GamesScoresReadBase {
  games: CanonicalGameProjection[];
}

export interface LeagueScoresReadContract extends GamesScoresReadBase {
  selection:
    | { kind: "all" }
    | { kind: "competition_number"; competitionNumber: number }
    | { kind: "occurrence_id"; occurrenceId: string }
    | {
        kind: "latest_scored_session";
        identitySource: "canonical_uuid" | "legacy_projection" | null;
        occurrenceId: string | null;
        legacyProjectionKey: string | null;
      };
  scores: CanonicalScoreProjection[];
}

export interface BowlerScoreHistoryReadContract {
  contractVersion: typeof CANONICAL_GAMES_SCORES_CONTRACT_VERSION;
  orderingVersion: typeof CANONICAL_GAMES_SCORES_ORDER_VERSION;
  organizationId: number;
  bowlerId: number;
  scores: CanonicalScoreProjection[];
}
