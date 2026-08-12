import type { CanonicalScoreProjection } from "@shared/canonical-games-scores";

export type ScoreWithRelations = CanonicalScoreProjection;

interface BowlerScores {
  bowlerId: number;
  bowlerName: string;
  position: number;
  isVacant: boolean;
  isAbsent: boolean;
  isSub: boolean;
  handicap: number | null;
  games: Array<{
    gameNumber: number;
    score: number | null;
  }>;
}

interface TeamScores {
  teamId: number;
  teamName: string;
  teamNumber: number;
  laneNumber: number;
  bowlers: BowlerScores[];
}
