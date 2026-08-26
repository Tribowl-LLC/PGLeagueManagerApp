import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  games,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  scores,
  teams,
  users,
} from "@shared/schema";
import { getTestDb, getTestPool } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { createGame, deleteGame, updateGame } from "../../server/storage/games-scores";
import { archiveLeague } from "../../server/storage/leagues";
import { createTeam, deleteTeam, renumberActiveTeams, reorderTeams, updateTeam } from "../../server/storage/teams";
import {
  CanonicalGamesScoresError,
  createAuthorizedScoreBatch,
  loadBowlerScoreHistory,
  loadLeagueGames,
  loadLeagueScores,
} from "../../server/services/canonical-games-scores";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}`;
let organizationId = 0;
let otherOrganizationId = 0;
let leagueId = 0;
let fallbackLeagueId = 0;
let otherLeagueId = 0;
let teamId = 0;
let fallbackTeamId = 0;
let otherTeamId = 0;
let bowlerId = 0;
let foreignBowlerId = 0;
let actorUserId = 0;
let scheduledOccurrenceId = "";
let cancelledOccurrenceId = "";
let makeupOccurrenceId = "";

function scoreInput(gameId: number, overrides: Partial<typeof scores.$inferInsert> = {}) {
  return {
    gameId,
    bowlerId,
    teamId,
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
    ...overrides,
  };
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: "E2 canonical games scores",
    slug: `e2-canonical-${suffix}`,
  }).returning();
  const [otherOrganization] = await db.insert(organizations).values({
    name: "E2 other tenant",
    slug: `e2-other-${suffix}`,
  }).returning();
  if (!organization || !otherOrganization) throw new Error("E2 organizations were not created");
  organizationId = organization.id;
  otherOrganizationId = otherOrganization.id;
  const [actor] = await db.insert(users).values({
    email: `e2-actor-${suffix}@example.test`,
    password: "test-password-hash",
    name: "E2 actor",
    role: "org_admin",
    organizationId,
  }).returning();
  if (!actor) throw new Error("E2 actor was not created");
  actorUserId = actor.id;
  const [location] = await db.insert(locations).values({ name: "E2 lanes", organizationId }).returning();
  const [otherLocation] = await db.insert(locations).values({ name: "E2 other lanes", organizationId: otherOrganizationId }).returning();
  if (!location || !otherLocation) throw new Error("E2 locations were not created");
  const leagueValues = {
    seasonStart: "2037-01-01",
    seasonEnd: "2037-03-31",
    weekDay: "Thursday" as const,
    competitionStartTime: "19:00",
    timezone: "America/Detroit",
    weeklyFee: 2_000,
    totalBowlingWeeks: 10,
  };
  const [league] = await db.insert(leagues).values({
    ...leagueValues,
    name: "E2 operational league",
    organizationId,
    locationId: location.id,
  }).returning();
  const [fallbackLeague] = await db.insert(leagues).values({
    ...leagueValues,
    name: "E2 fallback league",
    organizationId,
    locationId: location.id,
  }).returning();
  const [otherLeague] = await db.insert(leagues).values({
    ...leagueValues,
    name: "E2 other tenant league",
    organizationId: otherOrganizationId,
    locationId: otherLocation.id,
  }).returning();
  if (!league || !fallbackLeague || !otherLeague) throw new Error("E2 leagues were not created");
  leagueId = league.id;
  fallbackLeagueId = fallbackLeague.id;
  otherLeagueId = otherLeague.id;
  const [team] = await db.insert(teams).values({ name: "E2 team", number: 1, leagueId }).returning();
  const [fallbackTeam] = await db.insert(teams).values({ name: "E2 fallback team", number: 1, leagueId: fallbackLeagueId }).returning();
  const [otherTeam] = await db.insert(teams).values({ name: "E2 other team", number: 1, leagueId: otherLeagueId }).returning();
  const [bowler] = await db.insert(bowlers).values({ name: "E2 bowler", organizationId }).returning();
  const [foreignBowler] = await db.insert(bowlers).values({ name: "E2 foreign bowler", organizationId: otherOrganizationId }).returning();
  if (!team || !fallbackTeam || !otherTeam || !bowler || !foreignBowler) throw new Error("E2 score principals were not created");
  teamId = team.id;
  fallbackTeamId = fallbackTeam.id;
  otherTeamId = otherTeam.id;
  bowlerId = bowler.id;
  foreignBowlerId = foreignBowler.id;
  await db.insert(bowlerLeagues).values([
    { bowlerId, leagueId, teamId, active: true },
    { bowlerId, leagueId: fallbackLeagueId, teamId: fallbackTeamId, active: true },
  ]);

  const [command] = await db.insert(leagueScheduleCommands).values({
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    reason: "E2 operational fixture",
    idempotencyKey: `e2-publish-${suffix}`,
    requestFingerprint: `lvcanoncmd:v1:${"1".padStart(64, "0")}`,
  }).returning();
  if (!command) throw new Error("E2 publication command was not created");
  const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({
    organizationId,
    leagueId,
    originatingCommandId: command.id,
    generatorVersion: "e2-operational-fixture/1",
    inputFingerprint: `e2-operational-${suffix}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { fixture: "e2-operational" },
    rangeStartDate: "2037-01-01",
    rangeEndDate: "2037-01-31",
    candidateOccurrenceCount: 2,
    generatedOccurrenceCount: 2,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: "2036-12-01T00:00:00.000Z",
    approvedByUserId: actorUserId,
    approvalCommandId: command.id,
  }).returning();
  if (!run) throw new Error("E2 generation run was not created");
  const occurrenceBase = {
    organizationId,
    leagueId,
    locationId: location.id,
    timezone: "America/Detroit",
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous" as const,
    resolverVersion: "e2-test-resolver/1",
    lifecycle: "published" as const,
    lastCommandId: command.id,
    publishedAt: "2036-12-01T00:00:00.000Z",
    publishedByUserId: actorUserId,
    publicationCommandId: command.id,
  };
  const [scheduled] = await db.insert(leagueOccurrences).values({
    ...occurrenceBase,
    generationKey: `e2-regular-${suffix}`,
    generationRunId: run.id,
    kind: "regular",
    status: "scheduled",
    authoritativeLocalDate: "2037-01-08",
    authoritativeLocalStartTime: "19:00:00",
    startAt: "2037-01-09T00:00:00.000Z",
    plannedOrdinal: 1,
    competitionNumber: 7,
    competitive: true,
    countsInStandings: true,
  }).returning();
  const [cancelled] = await db.insert(leagueOccurrences).values({
    ...occurrenceBase,
    generationKey: `e2-cancelled-${suffix}`,
    generationRunId: run.id,
    kind: "regular",
    status: "cancelled",
    authoritativeLocalDate: "2037-01-15",
    authoritativeLocalStartTime: "19:00:00",
    startAt: "2037-01-16T00:00:00.000Z",
    plannedOrdinal: 2,
    competitionNumber: null,
    competitive: false,
    countsInStandings: false,
    cancelledAt: "2036-12-02T00:00:00.000Z",
    cancelledByUserId: actorUserId,
    cancellationCommandId: command.id,
  }).returning();
  const [makeup] = await db.insert(leagueOccurrences).values({
    ...occurrenceBase,
    generationKey: `e2-makeup-${suffix}`,
    generationRunId: null,
    kind: "makeup",
    status: "scheduled",
    authoritativeLocalDate: "2037-01-22",
    authoritativeLocalStartTime: "19:00:00",
    startAt: "2037-01-23T00:00:00.000Z",
    plannedOrdinal: 3,
    competitionNumber: 8,
    competitive: true,
    countsInStandings: false,
  }).returning();
  if (!scheduled || !cancelled || !makeup) throw new Error("E2 occurrences were not created");
  scheduledOccurrenceId = scheduled.id;
  cancelledOccurrenceId = cancelled.id;
  makeupOccurrenceId = makeup.id;
  await db.insert(leagueOccurrenceRelationships).values({
    organizationId,
    leagueId,
    kind: "makeup_for",
    sourceOccurrenceId: makeup.id,
    targetOccurrenceId: cancelled.id,
    state: "published",
    lastCommandId: command.id,
    publishedAt: "2036-12-02T00:00:00.000Z",
    publishedByUserId: actorUserId,
    publicationCommandId: command.id,
  });

  await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId: fallbackLeagueId,
    locationId: location.id,
    generationKey: `e2-draft-${suffix}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "draft",
    authoritativeLocalDate: "2037-01-08",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "America/Detroit",
    startAt: "2037-01-09T00:00:00.000Z",
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous",
    resolverVersion: "e2-test-resolver/1",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
  if (otherOrganizationId) await deleteOrganization(otherOrganizationId);
});

describe("E2 canonical games and scores PostgreSQL behavior", () => {
  it("keeps draft-only leagues on deterministic legacy fallback without synthesizing identity", async () => {
    const first = await createGame({ leagueId: fallbackLeagueId, weekNumber: 1, gameNumber: 1, date: "2037-01-08" });
    const second = await createGame({ leagueId: fallbackLeagueId, weekNumber: 1, gameNumber: 1, date: "2037-01-08" });
    expect(first.occurrenceId).toBeNull();
    expect(second.occurrenceId).toBeNull();
    const before = await db.select().from(games).where(eq(games.leagueId, fallbackLeagueId));
    const contract = await loadLeagueGames({ organizationId, leagueId: fallbackLeagueId, weekNumber: 1 });
    const after = await db.select().from(games).where(eq(games.leagueId, fallbackLeagueId));
    expect(contract).toMatchObject({ authoritativeSource: "legacy_fallback", operationalCanonicalStateExists: false });
    expect(contract.games.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(contract.games.every((row) => row.identitySource === "legacy_projection" && row.occurrence === null)).toBe(true);
    expect(after).toEqual(before);
    await createAuthorizedScoreBatch({
      organizationId,
      authorizedLeagueIds: [fallbackLeagueId],
      batchScores: [scoreInput(first.id, { teamId: fallbackTeamId })],
    });
    const recent = await loadLeagueScores({ organizationId, leagueId: fallbackLeagueId, latestScoredSession: true });
    expect(recent.selection).toEqual({
      kind: "latest_scored_session",
      identitySource: "legacy_projection",
      occurrenceId: null,
      legacyProjectionKey: recent.scores[0]?.game.legacyProjectionKey,
    });
    expect(recent.scores).toHaveLength(1);
  });

  it("links canonical games exactly, preserves distinct ordinals, and serializes duplicate creates", async () => {
    const first = await createGame({ leagueId, weekNumber: 7, gameNumber: 1, date: "2037-01-08" });
    const [secondAttempt, duplicateAttempt] = await Promise.allSettled([
      createGame({ leagueId, weekNumber: 7, gameNumber: 2, date: "2037-01-08" }),
      createGame({ leagueId, weekNumber: 7, gameNumber: 2, date: "2037-01-08" }),
    ]);
    expect(first.occurrenceId).toBe(scheduledOccurrenceId);
    expect([secondAttempt.status, duplicateAttempt.status].sort()).toEqual(["fulfilled", "rejected"]);
    const second = secondAttempt.status === "fulfilled"
      ? secondAttempt.value
      : duplicateAttempt.status === "fulfilled" ? duplicateAttempt.value : null;
    if (!second) throw new Error("one concurrent game create should succeed");
    const makeup = await createGame({ leagueId, weekNumber: 8, gameNumber: 1, date: "2037-01-22" });
    expect(makeup.occurrenceId).toBe(makeupOccurrenceId);

    const byWeek = await loadLeagueGames({ organizationId, leagueId, weekNumber: 7 });
    expect(byWeek.authoritativeSource).toBe("canonical");
    expect(byWeek.games.map((row) => row.gameNumber)).toEqual([1, 2]);
    expect(byWeek.games[0]?.occurrence).toMatchObject({
      occurrenceId: scheduledOccurrenceId,
      plannedOrdinal: 1,
      competitionNumber: 7,
    });
    await expect(deleteGame(first.id)).rejects.toMatchObject({
      evidence: { classification: "linked_game_deletion_unsupported" },
    });
    const byOccurrence = await loadLeagueGames({ organizationId, leagueId, occurrenceId: makeupOccurrenceId });
    expect(byOccurrence.games).toHaveLength(1);
    expect(byOccurrence.games[0]?.occurrence?.kind).toBe("makeup");
    await expect(loadLeagueGames({ organizationId, leagueId, occurrenceId: "00000000-0000-4000-8000-000000000099" }))
      .rejects.toBeInstanceOf(CanonicalGamesScoresError);
    await expect(createGame({ leagueId, weekNumber: 2, gameNumber: 1, date: "2037-01-15" }))
      .rejects.toMatchObject({ evidence: { classification: "competition_mapping_missing" } });

    await db.update(leagueOccurrences).set({
      lifecycle: "locked",
      status: "completed",
      lockedAt: "2037-01-09T01:00:00.000Z",
      lockedByUserId: actorUserId,
      lockReason: "E2 completed fixture",
      lockCommandId: (await db.select({ id: leagueScheduleCommands.id }).from(leagueScheduleCommands)
        .where(eq(leagueScheduleCommands.leagueId, leagueId)).limit(1))[0]?.id,
      completedAt: "2037-01-09T03:00:00.000Z",
      completedByUserId: actorUserId,
      completionCommandId: (await db.select({ id: leagueScheduleCommands.id }).from(leagueScheduleCommands)
        .where(eq(leagueScheduleCommands.leagueId, leagueId)).limit(1))[0]?.id,
    }).where(eq(leagueOccurrences.id, scheduledOccurrenceId));
    expect((await loadLeagueGames({ organizationId, leagueId, weekNumber: 7 })).games).toHaveLength(2);
    await expect(createGame({ leagueId, weekNumber: 7, gameNumber: 3, date: "2037-01-08" }))
      .rejects.toMatchObject({ evidence: { classification: "game_occurrence_not_operational" } });
  });

  it("inherits score identity through game ID and rejects an invalid batch atomically", async () => {
    const gameRows = await db.select().from(games).where(and(
      eq(games.leagueId, leagueId),
      eq(games.occurrenceId, scheduledOccurrenceId),
    )).orderBy(games.gameNumber);
    expect(gameRows).toHaveLength(2);
    const created = await createAuthorizedScoreBatch({
      organizationId,
      authorizedLeagueIds: [leagueId],
      batchScores: gameRows.map((row, index) => scoreInput(row.id, { score: 180 + index })),
    });
    expect(created).toHaveLength(2);
    expect("occurrenceId" in scores).toBe(false);
    const read = await loadLeagueScores({ organizationId, leagueId, weekNumber: 7 });
    expect(read.scores).toHaveLength(2);
    expect(read.scores.every((row) => row.game.occurrence?.occurrenceId === scheduledOccurrenceId)).toBe(true);
    const history = await loadBowlerScoreHistory({ organizationId, bowlerId, allowedLeagueIds: [leagueId] });
    expect(history.scores.map((row) => row.game.occurrence?.occurrenceId)).toEqual([
      scheduledOccurrenceId,
      scheduledOccurrenceId,
    ]);

    const makeupGame = (await db.select().from(games).where(eq(games.occurrenceId, makeupOccurrenceId)))[0];
    if (!makeupGame) throw new Error("makeup game fixture was not found");
    await createAuthorizedScoreBatch({
      organizationId,
      authorizedLeagueIds: [leagueId],
      batchScores: [scoreInput(makeupGame.id, { score: 205 })],
    });
    const latest = await loadLeagueScores({ organizationId, leagueId, latestScoredSession: true });
    expect(latest.selection).toEqual({
      kind: "latest_scored_session",
      identitySource: "canonical_uuid",
      occurrenceId: makeupOccurrenceId,
      legacyProjectionKey: null,
    });
    expect(latest.scores.map((row) => row.game.occurrence?.occurrenceId)).toEqual([makeupOccurrenceId]);

    const before = await db.select().from(scores).where(eq(scores.gameId, makeupGame.id));
    await expect(createAuthorizedScoreBatch({
      organizationId,
      authorizedLeagueIds: [leagueId],
      batchScores: [
        scoreInput(makeupGame.id),
        scoreInput(makeupGame.id, { teamId: otherTeamId, position: 2 }),
      ],
    })).rejects.toMatchObject({ evidence: { classification: "score_team_relationship_invalid" } });
    await expect(createAuthorizedScoreBatch({
      organizationId,
      authorizedLeagueIds: [leagueId],
      batchScores: [scoreInput(makeupGame.id, { bowlerId: foreignBowlerId })],
    })).rejects.toMatchObject({ evidence: { classification: "score_bowler_relationship_invalid" } });
    expect(await db.select().from(scores).where(eq(scores.gameId, makeupGame.id))).toEqual(before);
  });

  it("takes the league advisory lock before the game row for concurrent updates and score batches", async () => {
    const makeupGame = (await db.select().from(games).where(eq(games.occurrenceId, makeupOccurrenceId)))[0];
    if (!makeupGame) throw new Error("makeup game fixture was not found");
    const blocker = await getTestPool().connect();
    const probe = await getTestPool().connect();
    let updatePromise: Promise<unknown> | undefined;
    let batchPromise: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [organizationId, leagueId]);
      updatePromise = updateGame(makeupGame.id, { date: makeupGame.date });
      batchPromise = createAuthorizedScoreBatch({
        organizationId,
        authorizedLeagueIds: [leagueId],
        batchScores: [scoreInput(makeupGame.id, { score: 211, position: 4 })],
      });

      let waitingMutations = 0;
      for (let attempt = 0; attempt < 200 && waitingMutations < 2; attempt += 1) {
        const waiting = await probe.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1::oid
            AND objid = $2::oid
            AND granted = false
        `, [organizationId, leagueId]);
        waitingMutations = Number(waiting.rows[0]?.count ?? 0);
        if (waitingMutations < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingMutations).toBeGreaterThanOrEqual(2);

      await probe.query("BEGIN");
      await expect(probe.query("SELECT id FROM games WHERE id = $1 FOR UPDATE NOWAIT", [makeupGame.id]))
        .resolves.toMatchObject({ rowCount: 1 });
      await probe.query("ROLLBACK");
      await blocker.query("COMMIT");
      await expect(Promise.all([updatePromise, batchPromise])).resolves.toHaveLength(2);
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([updatePromise, batchPromise].filter((value): value is Promise<unknown> => value !== undefined));
      probe.release();
      blocker.release();
    }
  });

  it("fails closed on unlinked or duplicate canonical game evidence without guessing", async () => {
    const [unlinked] = await db.insert(games).values({
      leagueId,
      weekNumber: 99,
      gameNumber: 3,
      date: "2037-02-01",
    }).returning();
    await expect(loadLeagueGames({ organizationId, leagueId }))
      .rejects.toMatchObject({ evidence: { classification: "unlinked_canonical_game" } });
    if (unlinked) await db.delete(games).where(eq(games.id, unlinked.id));

    const existing = (await db.select().from(games).where(and(
      eq(games.leagueId, leagueId),
      eq(games.occurrenceId, scheduledOccurrenceId),
      eq(games.gameNumber, 1),
    )))[0];
    if (!existing) throw new Error("canonical duplicate source game was not found");
    const [duplicate] = await db.insert(games).values({
      leagueId,
      weekNumber: existing.weekNumber,
      gameNumber: existing.gameNumber,
      date: existing.date,
      occurrenceId: existing.occurrenceId,
    }).returning();
    await expect(loadLeagueGames({ organizationId, leagueId }))
      .rejects.toMatchObject({ evidence: { classification: "duplicate_occurrence_game_number" } });
    if (duplicate) await db.delete(games).where(eq(games.id, duplicate.id));
  });

  it("lets an archive win the league lock before game and score writers, including a repeated archive", async () => {
    await db.insert(bowlerLeagues).values({
      bowlerId: foreignBowlerId,
      leagueId: otherLeagueId,
      teamId: otherTeamId,
      active: true,
    });
    const baseline = await createGame({ leagueId: otherLeagueId, weekNumber: 1, gameNumber: 1, date: "2037-01-08" });
    const blocker = await getTestPool().connect();
    let archivePromise: Promise<unknown> | undefined;
    let createPromise: Promise<unknown> | undefined;
    let scorePromise: Promise<unknown> | undefined;
    try {
      // The archive acquires the same league advisory lock as every scoped
      // writer. Holding it briefly makes the ordering deterministic: once the
      // archive commits, both queued mutations must reread retired authority.
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [otherOrganizationId, otherLeagueId]);
      archivePromise = archiveLeague(otherLeagueId, otherOrganizationId);
      let archiveWaiting = 0;
      for (let attempt = 0; attempt < 200 && archiveWaiting < 1; attempt += 1) {
        const waiting = await blocker.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1::oid
            AND objid = $2::oid
            AND granted = false
        `, [otherOrganizationId, otherLeagueId]);
        archiveWaiting = Number(waiting.rows[0]?.count ?? 0);
        if (archiveWaiting < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(archiveWaiting).toBeGreaterThanOrEqual(1);
      createPromise = createGame({ leagueId: otherLeagueId, weekNumber: 1, gameNumber: 2, date: "2037-01-08" });
      scorePromise = createAuthorizedScoreBatch({
        organizationId: otherOrganizationId,
        authorizedLeagueIds: [otherLeagueId],
        batchScores: [scoreInput(baseline.id, { bowlerId: foreignBowlerId, teamId: otherTeamId })],
      });
      await blocker.query("COMMIT");
      const archived = await archivePromise;
      expect(archived).toMatchObject({ id: otherLeagueId, active: false, scheduleAuthority: "canonical" });
      await expect(createPromise).rejects.toThrow(/archive|read-only|canonical/i);
      await expect(scorePromise).rejects.toThrow();
      expect(await db.select().from(games).where(eq(games.leagueId, otherLeagueId))).toHaveLength(1);
      await expect(archiveLeague(otherLeagueId, otherOrganizationId)).resolves.toMatchObject({
        id: otherLeagueId,
        active: false,
        scheduleAuthority: "canonical",
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([archivePromise, createPromise, scorePromise].filter((value): value is Promise<unknown> => value !== undefined));
      blocker.release();
    }
  });

  it("keeps retired legacy league evidence immutable at the database and child-writer boundaries", async () => {
    const [retainedGame] = await db.select().from(games).where(eq(games.leagueId, fallbackLeagueId)).limit(1);
    if (!retainedGame) throw new Error("retired legacy fixture game was not created");
    await db.update(leagues).set({ active: false, scheduleAuthority: "retired_legacy" }).where(eq(leagues.id, fallbackLeagueId));
    await expect(db.update(leagues).set({ name: "illegal retired rename" }).where(eq(leagues.id, fallbackLeagueId))).rejects.toThrow();
    await expect(db.delete(leagues).where(eq(leagues.id, fallbackLeagueId))).rejects.toThrow();
    await expect(updateGame(retainedGame.id, { date: retainedGame.date })).rejects.toThrow(/archive|read-only|canonical/i);
    await expect(deleteGame(retainedGame.id)).rejects.toThrow();
  });

  it("fences every known team writer after a league archive", async () => {
    await expect(createTeam({ leagueId: otherLeagueId, name: "late team", number: 2, active: true })).rejects.toThrow(/archive|read-only/i);
    await expect(updateTeam(otherTeamId, { name: "late rename" })).rejects.toThrow(/archive|read-only/i);
    await expect(deleteTeam(otherTeamId)).rejects.toThrow(/archive|read-only/i);
    await expect(reorderTeams([{ id: otherTeamId, displayOrder: 0, number: 1 }])).rejects.toThrow(/archive|read-only/i);
    await expect(renumberActiveTeams(otherLeagueId)).rejects.toThrow(/archive|read-only/i);
  });
});
