import { describe, expect, it } from "vitest";
import type { CanonicalScoreProjection } from "@shared/canonical-games-scores";
import { groupBowlerScoreHistory } from "../../client/src/lib/bowler-score-history";

function score(input: {
  id: number;
  leagueId: number;
  gameNumber: number;
  occurrenceId?: string;
  legacyProjectionKey?: string;
  date?: string;
}): CanonicalScoreProjection {
  const date = input.date ?? "2038-01-08 00:00:00";
  const occurrenceId = input.occurrenceId ?? null;
  return {
    id: input.id,
    gameId: input.id,
    bowlerId: 1,
    teamId: input.leagueId,
    score: 180,
    handicap: 20,
    average: 170,
    position: 1,
    isVacant: false,
    isAbsent: false,
    isSub: false,
    laneNumber: 1,
    frames: [],
    splits: [],
    notes: [],
    bowler: { id: 1, name: "Bowler" },
    team: { id: input.leagueId, name: "Team", number: 1, leagueId: input.leagueId, active: true },
    league: { id: input.leagueId, name: "League", description: null, active: true },
    game: {
      id: input.id,
      leagueId: input.leagueId,
      weekNumber: 7,
      gameNumber: input.gameNumber,
      date,
      occurrenceId,
      identitySource: occurrenceId ? "canonical_uuid" : "legacy_projection",
      legacyProjectionKey: input.legacyProjectionKey ?? null,
      occurrence: occurrenceId ? {
        occurrenceId,
        legacyProjectionKey: null,
        identitySource: "canonical_uuid",
        kind: "regular",
        status: "scheduled",
        lifecycle: "published",
        authoritativeLocalDate: "2038-01-08",
        authoritativeLocalStartTime: "19:00:00",
        timezone: "America/Detroit",
        startAt: "2038-01-09T00:00:00.000Z",
        selectedUtcOffsetMinutes: -300,
        foldResolution: "unambiguous",
        resolverVersion: "test",
        plannedOrdinal: 2,
        competitionNumber: 7,
        competitive: true,
        countsInStandings: false,
        currentRevision: 2,
        effectivelyLocked: false,
        effectiveLockReasons: [],
        billing: null,
        relationships: [],
      } : null,
    },
  };
}

describe("bowler score history grouping", () => {
  it("groups canonical games only by stable occurrence UUID", () => {
    const occurrenceId = "11111111-1111-4111-8111-111111111111";
    const sessions = groupBowlerScoreHistory([
      score({ id: 1, leagueId: 1, gameNumber: 1, occurrenceId, date: "2038-01-08" }),
      score({ id: 2, leagueId: 1, gameNumber: 2, occurrenceId, date: "2038-01-09" }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.identityKey).toBe(occurrenceId);
    expect(sessions[0]?.games.filter(Boolean)).toHaveLength(2);
  });

  it("keeps deterministic fallback keys distinct and never fabricates a UUID", () => {
    const sessions = groupBowlerScoreHistory([
      score({ id: 3, leagueId: 1, gameNumber: 1, legacyProjectionKey: "legacy-game:1:7:2038-01-08" }),
      score({ id: 4, leagueId: 2, gameNumber: 1, legacyProjectionKey: "legacy-game:2:7:2038-01-08" }),
    ]);
    expect(sessions.map((session) => session.identityKey)).toEqual([
      "legacy-game:1:7:2038-01-08",
      "legacy-game:2:7:2038-01-08",
    ]);
  });
});
