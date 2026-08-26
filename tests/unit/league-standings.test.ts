import { describe, expect, it } from "vitest";
import type {
  CanonicalGameProjection,
  CanonicalScoreProjection,
} from "@shared/canonical-games-scores";
import {
  LEAGUE_STANDINGS_CONTRACT_VERSION,
  LEAGUE_STANDINGS_FINGERPRINT_VERSION,
  LEAGUE_STANDINGS_ORDER_VERSION,
} from "@shared/league-standings";
import type {
  LeagueOccurrenceScheduleOccurrence,
  LeagueOccurrenceScheduleReadContract,
} from "@shared/league-occurrence-schedule";
import {
  MAX_LEAGUE_STANDINGS_DISCREPANCIES,
  LeagueStandingsError,
  buildLeagueStandingsContract,
} from "../../server/services/league-standings";
import type { CanonicalGamesScoresEvidenceSnapshot } from "../../server/services/canonical-games-scores";

const OCCURRENCE_ID = "11111111-1111-4111-8111-111111111111";

function occurrence(
  overrides: Partial<LeagueOccurrenceScheduleOccurrence> = {},
): LeagueOccurrenceScheduleOccurrence {
  return {
    occurrenceId: OCCURRENCE_ID,
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
    resolverVersion: "test-resolver/1",
    plannedOrdinal: 1,
    competitionNumber: 7,
    competitive: true,
    countsInStandings: true,
    currentRevision: 1,
    effectivelyLocked: false,
    effectiveLockReasons: [],
    billing: null,
    relationships: [],
    ...overrides,
  };
}

function schedule(
  occurrences: LeagueOccurrenceScheduleOccurrence[],
): LeagueOccurrenceScheduleReadContract {
  return {
    contractVersion: "league-occurrence-schedule/2",
    ordering: {
      version: "league-occurrence-schedule-order/1",
      keys: [
        "authoritativeLocalDate",
        "authoritativeLocalStartTime",
        "plannedOrdinal",
        "competitionNumber",
        "kind",
        "stableIdentity",
      ],
    },
    organizationId: 10,
    leagueId: 20,
    authoritativeSource: "canonical",
    occurrences,
    skippedDates: [],
    administrator: null,
  };
}

function game(
  target: LeagueOccurrenceScheduleOccurrence,
  overrides: Partial<CanonicalGameProjection> = {},
): CanonicalGameProjection {
  return {
    id: 101,
    leagueId: 20,
    weekNumber: 7,
    gameNumber: 1,
    date: "2038-01-08 00:00:00",
    occurrenceId: target.occurrenceId,
    identitySource: "canonical_uuid",
    occurrence: target,
    ...overrides,
  };
}

function score(
  targetGame: CanonicalGameProjection,
  overrides: Partial<CanonicalScoreProjection> = {},
): CanonicalScoreProjection {
  return {
    id: 201,
    gameId: targetGame.id,
    bowlerId: 301,
    teamId: 401,
    score: 180,
    handicap: 20,
    average: 170,
    position: 1,
    isVacant: false,
    isAbsent: false,
    isSub: false,
    laneNumber: 1,
    frames: ["X"],
    splits: [],
    notes: ["not part of E3 evidence"],
    bowler: { id: 301, name: "Private Bowler Name" },
    team: { id: 401, name: "Team One", number: 1, leagueId: 20, active: true },
    league: { id: 20, name: "League", description: null, active: true },
    game: targetGame,
    ...overrides,
  };
}

function snapshot(input: {
  occurrences?: LeagueOccurrenceScheduleOccurrence[];
  games?: CanonicalGameProjection[];
  scores?: CanonicalScoreProjection[];
} = {}): CanonicalGamesScoresEvidenceSnapshot {
  return {
    schedule: schedule(input.occurrences ?? [occurrence()]),
    games: input.games ?? [],
    scores: input.scores ?? [],
  };
}

describe("league-standings/1 evidence contract", () => {
  it("publishes explicit versions and a policy-required non-ranking state", () => {
    const contract = buildLeagueStandingsContract(snapshot());
    expect(contract).toMatchObject({
      contractVersion: LEAGUE_STANDINGS_CONTRACT_VERSION,
      ordering: { version: LEAGUE_STANDINGS_ORDER_VERSION },
      ranking: {
        state: "policy_required",
        policyVersion: null,
        reasonCode: "MATCHUP_AND_RANKING_POLICY_REQUIRED",
        rows: [],
      },
      evidenceFingerprint: {
        version: LEAGUE_STANDINGS_FINGERPRINT_VERSION,
        algorithm: "sha256",
        value: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(contract.discrepancies.map((row) => row.classification)).toEqual([
      "matchup_evidence_unavailable",
      "ranking_policy_required",
    ]);
  });

  it.each([
    {
      label: "cancelled",
      input: { status: "cancelled", competitive: false, countsInStandings: false, competitionNumber: null },
      state: "excluded_cancelled",
    },
    {
      label: "scheduled noncompetitive",
      input: { status: "scheduled", competitive: false, countsInStandings: false, competitionNumber: null },
      state: "excluded_noncompetitive",
    },
    {
      label: "scheduled excluded by standings flag",
      input: { status: "scheduled", competitive: true, countsInStandings: false },
      state: "excluded_by_standings_flag",
    },
    {
      label: "scheduled pending",
      input: { status: "scheduled", competitive: true, countsInStandings: true },
      state: "pending_not_completed",
    },
    {
      label: "completed noncompetitive",
      input: { status: "completed", lifecycle: "locked", competitive: false, countsInStandings: false, competitionNumber: null },
      state: "excluded_noncompetitive",
    },
    {
      label: "completed excluded by standings flag",
      input: { status: "completed", lifecycle: "locked", competitive: true, countsInStandings: false },
      state: "excluded_by_standings_flag",
    },
    {
      label: "completed eligible",
      input: { status: "completed", lifecycle: "locked", competitive: true, countsInStandings: true },
      state: "eligible_result_input",
    },
  ] as const)("applies canonical eligibility precedence for $label", ({ input, state }) => {
    const target = occurrence(input);
    const contract = buildLeagueStandingsContract(snapshot({ occurrences: [target] }));
    expect(contract.occurrences[0]?.eligibility.state).toBe(state);
  });

  it.each(["regular", "makeup", "position_round", "rolloff", "playoff", "extension"] as const)(
    "does not invent kind-specific policy for %s",
    (kind) => {
      const target = occurrence({
        kind,
        status: "completed",
        lifecycle: "locked",
        relationships: kind === "makeup" ? [{
          relationshipId: "22222222-2222-4222-8222-222222222222",
          kind: "makeup_for",
          role: "source",
          relatedOccurrenceId: "33333333-3333-4333-8333-333333333333",
          currentRevision: 1,
        }] : [],
      });
      const contract = buildLeagueStandingsContract(snapshot({ occurrences: [target] }));
      expect(contract.occurrences[0]?.eligibility.state).toBe("eligible_result_input");
      expect(contract.occurrences[0]?.relationships).toEqual(target.relationships.map((row) => ({
        kind: row.kind,
        role: row.role,
        relatedOccurrenceId: row.relatedOccurrenceId,
      })));
    },
  );

  it.each([
    occurrence({ status: "cancelled", competitive: true, countsInStandings: false }),
    occurrence({ status: "cancelled", competitive: false, countsInStandings: false, competitionNumber: 7 }),
    occurrence({ competitive: false, countsInStandings: true, competitionNumber: null }),
    occurrence({ status: "completed", lifecycle: "published" }),
  ])("fails closed on contradictory canonical status/flag evidence", (target) => {
    expect(() => buildLeagueStandingsContract(snapshot({ occurrences: [target] })))
      .toThrowError(LeagueStandingsError);
    try {
      buildLeagueStandingsContract(snapshot({ occurrences: [target] }));
    } catch (caught) {
      expect(caught).toMatchObject({ evidence: { classification: "canonical_occurrence_flag_contradiction" } });
    }
  });

  it("groups canonical results only by UUID and emits reduced deterministic score evidence", () => {
    const target = occurrence({ status: "completed", lifecycle: "locked" });
    const gameTwo = game(target, { id: 102, gameNumber: 2 });
    const gameOne = game(target, { id: 101, gameNumber: 1 });
    const scoreTwo = score(gameOne, { id: 202, teamId: 402, position: 2, team: { id: 402, name: "Team Two", number: 2, leagueId: 20, active: true } });
    const scoreOne = score(gameOne, { id: 201 });
    const contract = buildLeagueStandingsContract(snapshot({
      occurrences: [target],
      games: [gameTwo, gameOne],
      scores: [scoreTwo, scoreOne],
    }));
    expect(contract.resultSessions).toHaveLength(1);
    expect(contract.resultSessions[0]?.identity).toEqual(canonicalIdentityForTest(OCCURRENCE_ID));
    expect(contract.resultSessions[0]?.games.map((row) => row.gameId)).toEqual([101, 102]);
    expect(contract.resultSessions[0]?.games[0]?.scores.map((row) => row.scoreId)).toEqual([201, 202]);
    expect(JSON.stringify(contract)).not.toContain("Private Bowler Name");
    expect(JSON.stringify(contract)).not.toContain("not part of E3 evidence");
    expect(JSON.stringify(contract)).not.toContain("frames");
  });

  it("surfaces missing games, scoreless games, pending/excluded scores, and duplicate slots without ranking", () => {
    const eligibleWithoutGame = occurrence({
      occurrenceId: "11111111-1111-4111-8111-111111111112",
      status: "completed",
      lifecycle: "locked",
      plannedOrdinal: 1,
    });
    const eligibleWithScorelessGame = occurrence({
      occurrenceId: "11111111-1111-4111-8111-111111111113",
      status: "completed",
      lifecycle: "locked",
      plannedOrdinal: 2,
    });
    const pending = occurrence({
      occurrenceId: "11111111-1111-4111-8111-111111111114",
      plannedOrdinal: 3,
    });
    const excluded = occurrence({
      occurrenceId: "11111111-1111-4111-8111-111111111115",
      plannedOrdinal: 4,
      competitive: true,
      countsInStandings: false,
    });
    const eligibleGame = game(eligibleWithScorelessGame, { id: 111 });
    const pendingGame = game(pending, { id: 112 });
    const excludedGame = game(excluded, { id: 113 });
    const duplicateA = score(pendingGame, { id: 211 });
    const duplicateB = score(pendingGame, { id: 212 });
    const excludedScore = score(excludedGame, { id: 213 });
    const contract = buildLeagueStandingsContract(snapshot({
      occurrences: [eligibleWithoutGame, eligibleWithScorelessGame, pending, excluded],
      games: [eligibleGame, pendingGame, excludedGame],
      scores: [duplicateA, duplicateB, excludedScore],
    }));
    expect(contract.discrepancies.map((row) => row.classification)).toEqual(expect.arrayContaining([
      "completed_eligible_occurrence_without_games",
      "completed_eligible_game_without_scores",
      "pending_occurrence_has_score_evidence",
      "excluded_occurrence_has_score_evidence",
      "duplicate_score_slot",
    ]));
    expect(contract.discrepancies.find((row) => row.classification === "duplicate_score_slot"))
      .toMatchObject({ gameId: pendingGame.id, evidenceCount: 2 });
    expect(contract.ranking.rows).toEqual([]);
  });

  it("fingerprints semantic score evidence but ignores excluded names and notes", () => {
    const target = occurrence({ status: "completed", lifecycle: "locked" });
    const targetGame = game(target);
    const baselineScore = score(targetGame);
    const baseline = buildLeagueStandingsContract(snapshot({
      occurrences: [target], games: [targetGame], scores: [baselineScore],
    }));
    const renamed = buildLeagueStandingsContract(snapshot({
      occurrences: [target],
      games: [targetGame],
      scores: [score(targetGame, {
        bowler: { id: 301, name: "Changed Name" },
        notes: ["changed note"],
        frames: ["9/"],
      })],
    }));
    const rescored = buildLeagueStandingsContract(snapshot({
      occurrences: [target], games: [targetGame], scores: [score(targetGame, { score: 181 })],
    }));
    expect(renamed.evidenceFingerprint.value).toBe(baseline.evidenceFingerprint.value);
    expect(rescored.evidenceFingerprint.value).not.toBe(baseline.evidenceFingerprint.value);
    expect(buildLeagueStandingsContract(snapshot({
      occurrences: [target], games: [targetGame], scores: [baselineScore],
    })).evidenceFingerprint.value).toBe(baseline.evidenceFingerprint.value);
  });

  it("fails rather than guessing when a canonical result UUID is missing or ambiguous", () => {
    const target = occurrence();
    const foreign = game(target, {
      occurrenceId: "99999999-9999-4999-8999-999999999999",
      occurrence: occurrence({ occurrenceId: "99999999-9999-4999-8999-999999999999" }),
    });
    expect(() => buildLeagueStandingsContract(snapshot({ occurrences: [target], games: [foreign] })))
      .toThrowError(expect.objectContaining({
        evidence: expect.objectContaining({ classification: "canonical_result_occurrence_missing" }),
      }));

    const duplicate = occurrence({ occurrenceId: OCCURRENCE_ID, plannedOrdinal: 2 });
    const targetGame = game(target);
    expect(() => buildLeagueStandingsContract(snapshot({ occurrences: [target, duplicate], games: [targetGame] })))
      .toThrowError(expect.objectContaining({
        evidence: expect.objectContaining({ classification: "canonical_result_occurrence_ambiguous" }),
      }));
  });
});

function canonicalIdentityForTest(occurrenceId: string) {
  return { identitySource: "canonical_uuid", occurrenceId };
}
