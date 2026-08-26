import type { CanonicalScoreProjection } from "@shared/canonical-games-scores";

export interface BowlerScoreSession {
  identityKey: string;
  date: string;
  weekNumber: number;
  games: (CanonicalScoreProjection | null)[];
  seriesTotal: number;
  league: { id: number; name: string };
  team: { id: number; name: string };
}

export function groupBowlerScoreHistory(scores: readonly CanonicalScoreProjection[]): BowlerScoreSession[] {
  return scores.reduce<BowlerScoreSession[]>((sessions, score) => {
    const identityKey = score.game.occurrence.occurrenceId;
    const authoritativeDate = score.game.occurrence.authoritativeLocalDate;
    const existing = sessions.find((session) => session.identityKey === identityKey);
    if (!existing) {
      const session: BowlerScoreSession = {
        identityKey,
        date: authoritativeDate,
        weekNumber: score.game.weekNumber,
        games: Array(3).fill(null),
        seriesTotal: score.score || 0,
        league: { id: score.league.id, name: score.league.name },
        team: { id: score.team.id, name: score.team.name },
      };
      session.games[score.game.gameNumber - 1] = score;
      sessions.push(session);
      return sessions;
    }
    existing.games[score.game.gameNumber - 1] = score;
    if (!score.isAbsent && !score.isVacant && score.score !== null) existing.seriesTotal += score.score;
    return sessions;
  }, []);
}
