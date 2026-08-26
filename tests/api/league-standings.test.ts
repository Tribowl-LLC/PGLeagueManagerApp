import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  games,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  scores,
  teams,
  users,
} from "@shared/schema";
import type { LeagueStandingsReadContract } from "@shared/league-standings";
import { hashPassword } from "../../server/lib/password";
import { createAuthorizedScoreBatch } from "../../server/services/canonical-games-scores";
import {
  LeagueStandingsError,
  loadLeagueStandings,
  loadLeagueStandingsSnapshot,
} from "../../server/services/league-standings";
import { createGame } from "../../server/storage/games-scores";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  apiGet,
  login,
  type AuthSession,
} from "../helpers";
import { getTestDb, getTestPool } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = "E3-local-password-1!";
const organizationsToDelete: number[] = [];

interface Fixture {
  organizationId: number;
  leagueId: number;
  teamId: number;
  bowlerId: number;
  inactiveBowlerId: number;
  actorUserId: number;
  commandId: string;
  completedOccurrenceId: string;
  cancelledOccurrenceId: string;
  gameId: number;
  scoreId: number;
  admin: AuthSession;
  member: AuthSession;
  inactiveMember: AuthSession;
}

async function createFixture(label: string): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `E3 ${label}`,
    slug: `e3-${label}-${suffix}`,
  }).returning();
  if (!organization) throw new Error("E3 organization was not created");
  organizationsToDelete.push(organization.id);
  const [location] = await db.insert(locations).values({
    name: `E3 ${label} lanes`,
    organizationId: organization.id,
  }).returning();
  if (!location) throw new Error("E3 location was not created");
  const commonLeague = {
    organizationId: organization.id,
    locationId: location.id,
    seasonStart: "2039-01-01",
    seasonEnd: "2039-03-31",
    weekDay: "Saturday" as const,
    competitionStartTime: "19:00",
    timezone: "America/Detroit",
    weeklyFee: 2_000,
    totalBowlingWeeks: 10,
  };
  const [league] = await db.insert(leagues).values({
    ...commonLeague,
    name: `E3 ${label} canonical`,
  }).returning();
  if (!league) throw new Error("E3 league was not created");
  const [team] = await db.insert(teams).values({ name: `E3 ${label} team`, number: 1, leagueId: league.id }).returning();
  const [bowler] = await db.insert(bowlers).values({ name: `E3 ${label} bowler`, organizationId: organization.id }).returning();
  const [inactiveBowler] = await db.insert(bowlers).values({ name: `E3 ${label} inactive`, organizationId: organization.id }).returning();
  if (!team || !bowler || !inactiveBowler) throw new Error("E3 roster was not created");
  await db.insert(bowlerLeagues).values([
    { bowlerId: bowler.id, leagueId: league.id, teamId: team.id, active: true },
    { bowlerId: inactiveBowler.id, leagueId: league.id, teamId: team.id, active: false },
  ]);

  const hashed = await hashPassword(password);
  const adminEmail = `e3-${label}-admin-${suffix}@example.test`;
  const memberEmail = `e3-${label}-member-${suffix}@example.test`;
  const inactiveEmail = `e3-${label}-inactive-${suffix}@example.test`;
  const [actor] = await db.insert(users).values({
    email: adminEmail,
    password: hashed,
    name: `E3 ${label} admin`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning();
  await db.insert(users).values([
    {
      email: memberEmail,
      password: hashed,
      name: `E3 ${label} member`,
      role: "user",
      organizationId: organization.id,
      bowlerId: bowler.id,
    },
    {
      email: inactiveEmail,
      password: hashed,
      name: `E3 ${label} inactive member`,
      role: "user",
      organizationId: organization.id,
      bowlerId: inactiveBowler.id,
    },
  ]);
  if (!actor) throw new Error("E3 actor was not created");

  const [command] = await db.insert(leagueScheduleCommands).values({
    organizationId: organization.id,
    leagueId: league.id,
    actorUserId: actor.id,
    commandType: "publish",
    reason: "E3 operational fixture",
    idempotencyKey: `e3-publish-${label}-${suffix}`,
    requestFingerprint: `lvcanoncmd:v1:${"3".padStart(64, "0")}`,
  }).returning();
  if (!command) throw new Error("E3 command was not created");
  const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({
    organizationId: organization.id,
    leagueId: league.id,
    originatingCommandId: command.id,
    generatorVersion: "e3-fixture/1",
    inputFingerprint: `e3-${label}-${suffix}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { fixture: "e3" },
    rangeStartDate: "2039-01-01",
    rangeEndDate: "2039-01-31",
    candidateOccurrenceCount: 2,
    generatedOccurrenceCount: 2,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: "2038-12-01T00:00:00.000Z",
    approvedByUserId: actor.id,
    approvalCommandId: command.id,
  }).returning();
  if (!run) throw new Error("E3 run was not created");
  const occurrenceBase = {
    organizationId: organization.id,
    leagueId: league.id,
    locationId: location.id,
    generationRunId: run.id,
    timezone: "America/Detroit",
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous" as const,
    resolverVersion: "e3-test-resolver/1",
    lifecycle: "published" as const,
    lastCommandId: command.id,
    publishedAt: "2038-12-01T00:00:00.000Z",
    publishedByUserId: actor.id,
    publicationCommandId: command.id,
  };
  const [scheduled] = await db.insert(leagueOccurrences).values({
    ...occurrenceBase,
    generationKey: `e3-completed-${label}-${suffix}`,
    kind: "regular",
    status: "scheduled",
    authoritativeLocalDate: "2039-01-08",
    authoritativeLocalStartTime: "19:00:00",
    startAt: "2039-01-09T00:00:00.000Z",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
  }).returning();
  const [cancelled] = await db.insert(leagueOccurrences).values({
    ...occurrenceBase,
    generationKey: `e3-cancelled-${label}-${suffix}`,
    kind: "regular",
    status: "cancelled",
    authoritativeLocalDate: "2039-01-15",
    authoritativeLocalStartTime: "19:00:00",
    startAt: "2039-01-16T00:00:00.000Z",
    plannedOrdinal: 2,
    competitionNumber: null,
    competitive: false,
    countsInStandings: false,
    cancelledAt: "2038-12-02T00:00:00.000Z",
    cancelledByUserId: actor.id,
    cancellationCommandId: command.id,
  }).returning();
  if (!scheduled || !cancelled) throw new Error("E3 occurrences were not created");
  const createdGame = await createGame({
    leagueId: league.id,
    weekNumber: 1,
    gameNumber: 1,
    date: "2039-01-08",
  });
  const [createdScore] = await createAuthorizedScoreBatch({
    organizationId: organization.id,
    authorizedLeagueIds: [league.id],
    batchScores: [{
      gameId: createdGame.id,
      bowlerId: bowler.id,
      teamId: team.id,
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
    }],
  });
  if (!createdScore) throw new Error("E3 score was not created");
  await db.update(leagueOccurrences).set({
    lifecycle: "locked",
    status: "completed",
    lockedAt: "2039-01-09T01:00:00.000Z",
    lockedByUserId: actor.id,
    lockReason: "E3 completed fixture",
    lockCommandId: command.id,
    completedAt: "2039-01-09T03:00:00.000Z",
    completedByUserId: actor.id,
    completionCommandId: command.id,
  }).where(eq(leagueOccurrences.id, scheduled.id));

  return {
    organizationId: organization.id,
    leagueId: league.id,
    teamId: team.id,
    bowlerId: bowler.id,
    inactiveBowlerId: inactiveBowler.id,
    actorUserId: actor.id,
    commandId: command.id,
    completedOccurrenceId: scheduled.id,
    cancelledOccurrenceId: cancelled.id,
    gameId: createdGame.id,
    scoreId: createdScore.id,
    admin: await login(adminEmail, password),
    member: await login(memberEmail, password),
    inactiveMember: await login(inactiveEmail, password),
  };
}

async function evidenceSnapshot(leagueId: number): Promise<Record<string, string>> {
  const result = await db.execute<{ name: string; value: string }>(sql`
    SELECT 'league' AS name, row_to_json(l)::text AS value FROM leagues l WHERE l.id = ${leagueId}
    UNION ALL SELECT 'games', COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]'::jsonb)::text FROM games g WHERE g.league_id = ${leagueId}
    UNION ALL SELECT 'scores', COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)::text FROM scores s JOIN games g ON g.id = s.game_id WHERE g.league_id = ${leagueId}
    UNION ALL SELECT 'occurrences', COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]'::jsonb)::text FROM league_occurrences o WHERE o.league_id = ${leagueId}
    UNION ALL SELECT 'commands', COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)::text FROM league_schedule_commands c WHERE c.league_id = ${leagueId}
    UNION ALL SELECT 'runs', COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)::text FROM league_occurrence_generation_runs r WHERE r.league_id = ${leagueId}
    UNION ALL SELECT 'exceptions', count(*)::text FROM league_schedule_exceptions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'terms', count(*)::text FROM league_occurrence_billing_terms WHERE league_id = ${leagueId}
    UNION ALL SELECT 'relationships', count(*)::text FROM league_occurrence_relationships WHERE league_id = ${leagueId}
    UNION ALL SELECT 'canonical_revisions', (
      (SELECT count(*) FROM league_occurrence_revisions WHERE league_id = ${leagueId})
      + (SELECT count(*) FROM league_schedule_exception_revisions WHERE league_id = ${leagueId})
      + (SELECT count(*) FROM league_occurrence_relationship_revisions WHERE league_id = ${leagueId})
      + (SELECT count(*) FROM league_occurrence_billing_term_revisions WHERE league_id = ${leagueId})
    )::text
    UNION ALL SELECT 'canonical_discrepancies', count(*)::text FROM league_occurrence_generation_discrepancies WHERE league_id = ${leagueId}
    UNION ALL SELECT 'payment_schedules', count(*)::text FROM payment_schedules WHERE league_id = ${leagueId}
    UNION ALL SELECT 'payment_operations', count(*)::text FROM payment_operations po JOIN payment_schedules ps ON ps.id = po.payment_schedule_id WHERE ps.league_id = ${leagueId}
    UNION ALL SELECT 'payments', count(*)::text FROM payments WHERE league_id = ${leagueId}
  `);
  return Object.fromEntries(result.rows.map((row) => [row.name, row.value]));
}

let primary: Fixture;
let other: Fixture;
let systemAdmin: AuthSession;

beforeAll(async () => {
  primary = await createFixture("primary");
  other = await createFixture("other");
  systemAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
});

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("E3 league standings evidence API", () => {
  it("returns canonical UUID-linked eligibility evidence without writes or rankings", async () => {
    const before = await evidenceSnapshot(primary.leagueId);
    const response = await apiGet<LeagueStandingsReadContract>(
      `/api/leagues/${primary.leagueId}/standings?organizationId=${primary.organizationId}`,
      primary.member,
    );
    const after = await evidenceSnapshot(primary.leagueId);
    expect(response.status).toBe(200);
    expect(response.data.data).toMatchObject({
      contractVersion: "league-standings/1",
      organizationId: primary.organizationId,
      leagueId: primary.leagueId,
      authoritativeSource: "canonical",
      ranking: { state: "policy_required", policyVersion: null, rows: [] },
      summary: {
        occurrenceCount: 2,
        eligibleOccurrenceCount: 1,
        excludedOccurrenceCount: 1,
        resultSessionCount: 1,
        gameCount: 1,
        scoreCount: 1,
        discrepanciesTruncated: false,
      },
    });
    expect(response.data.data?.occurrences).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ occurrenceId: primary.completedOccurrenceId }),
        eligibility: expect.objectContaining({ state: "eligible_result_input" }),
      }),
      expect.objectContaining({
        identity: expect.objectContaining({ occurrenceId: primary.cancelledOccurrenceId }),
        eligibility: expect.objectContaining({ state: "excluded_cancelled" }),
      }),
    ]);
    expect(response.data.data?.resultSessions[0]).toMatchObject({
      identity: { identitySource: "canonical_uuid", occurrenceId: primary.completedOccurrenceId },
      occurrenceOrderIndex: 0,
      eligibility: { state: "eligible_result_input" },
      games: [{ gameId: primary.gameId, scores: [{ scoreId: primary.scoreId, score: 180 }] }],
    });
    expect(JSON.stringify(response.data.data)).not.toContain("frames");
    expect(JSON.stringify(response.data.data)).not.toContain("notes");
    expect(after).toEqual(before);

    const repeated = await apiGet<LeagueStandingsReadContract>(
      `/api/leagues/${primary.leagueId}/standings?organizationId=${primary.organizationId}`,
      primary.member,
    );
    expect(repeated.data.data?.evidenceFingerprint).toEqual(response.data.data?.evidenceFingerprint);
  });

  it("requires active membership and preserves tenant-safe admin/system scope", async () => {
    expect((await apiGet(`/api/leagues/${primary.leagueId}/standings`)).status).toBe(401);

    const inactive = await apiGet(`/api/leagues/${primary.leagueId}/standings`, primary.inactiveMember);
    expect(inactive.status).toBe(404);
    expect(inactive.data.error?.code).toBe("NOT_FOUND");

    expect((await apiGet(`/api/leagues/${primary.leagueId}/standings`, primary.admin)).status).toBe(200);
    const crossTenant = await apiGet(`/api/leagues/${other.leagueId}/standings`, primary.admin);
    expect(crossTenant.status).toBe(404);
    expect(JSON.stringify(crossTenant.data)).not.toContain(other.organizationId.toString());
    expect((await apiGet(
      `/api/leagues/${primary.leagueId}/standings?organizationId=${other.organizationId}`,
      primary.admin,
    )).status).toBe(403);

    const missingSystemScope = await apiGet(`/api/leagues/${primary.leagueId}/standings`, systemAdmin);
    expect(missingSystemScope.status).toBe(400);
    expect(missingSystemScope.data.error?.code).toBe("INVALID_REQUEST");
    expect((await apiGet(
      `/api/leagues/${primary.leagueId}/standings?organizationId=${primary.organizationId}`,
      systemAdmin,
    )).status).toBe(200);
    expect((await apiGet(
      `/api/leagues/${primary.leagueId}/standings?organizationId=${other.organizationId}`,
      systemAdmin,
    )).status).toBe(404);
    expect((await apiGet(`/api/leagues/nope/standings`, primary.admin)).status).toBe(400);
    expect((await apiGet(`/api/leagues/${primary.leagueId}/standings?unknown=1`, primary.admin)).status).toBe(400);
    expect((await apiGet(`/api/leagues/${primary.leagueId}/standings?organizationId=0`, systemAdmin)).status).toBe(400);
  });

  it("returns one generic bounded 409 for incompatible canonical game evidence", async () => {
    const [unlinked] = await db.insert(games).values({
      leagueId: primary.leagueId,
      weekNumber: 99,
      gameNumber: 3,
      date: "2039-02-01",
      occurrenceId: null,
    }).returning();
    if (!unlinked) throw new Error("E3 incompatible fixture was not created");
    try {
      const response = await apiGet(
        `/api/leagues/${primary.leagueId}/standings`,
        primary.admin,
      );
      expect(response.status).toBe(409);
      expect(response.data.error).toEqual({
        code: "CANONICAL_STANDINGS_INCOMPATIBLE",
        message: "Canonical standings evidence is incompatible and cannot be used safely",
      });
      expect(JSON.stringify(response.data)).not.toContain("unlinked_canonical_game");
    } finally {
      await db.delete(games).where(eq(games.id, unlinked.id));
    }
  });

  it("returns the same generic 409 for incompatible canonical schedule evidence", async () => {
    const [run] = await db.select().from(leagueOccurrenceGenerationRuns).where(
      eq(leagueOccurrenceGenerationRuns.leagueId, primary.leagueId),
    );
    if (!run) throw new Error("E3 generation run was not found");
    try {
      await db.update(leagueOccurrenceGenerationRuns).set({
        candidateOccurrenceCount: run.candidateOccurrenceCount + 1,
        generatedOccurrenceCount: run.generatedOccurrenceCount + 1,
      }).where(eq(leagueOccurrenceGenerationRuns.id, run.id));
      const response = await apiGet(
        `/api/leagues/${primary.leagueId}/standings`,
        primary.admin,
      );
      expect(response.status).toBe(409);
      expect(response.data.error).toEqual({
        code: "CANONICAL_STANDINGS_INCOMPATIBLE",
        message: "Canonical standings evidence is incompatible and cannot be used safely",
      });
      expect(JSON.stringify(response.data)).not.toContain("partial");
    } finally {
      await db.update(leagueOccurrenceGenerationRuns).set({
        candidateOccurrenceCount: run.candidateOccurrenceCount,
        generatedOccurrenceCount: run.generatedOccurrenceCount,
      }).where(eq(leagueOccurrenceGenerationRuns.id, run.id));
    }
  });

  it("uses repeatable-read/read-only semantics for the complete E1/E2 snapshot", async () => {
    const original = (await db.select({ score: scores.score }).from(scores).where(eq(scores.id, primary.scoreId)))[0]?.score;
    if (original === undefined) throw new Error("E3 source score was not found");
    const client = await getTestPool().connect();
    let insideFingerprint = "";
    try {
      await db.transaction(async (tx) => {
        const settings = await tx.execute<{ isolation: string; readOnly: string }>(sql`
          SELECT current_setting('transaction_isolation') AS isolation,
                 current_setting('transaction_read_only') AS "readOnly"
        `);
        expect(settings.rows[0]).toEqual({ isolation: "repeatable read", readOnly: "on" });
        const first = await loadLeagueStandingsSnapshot(tx, {
          organizationId: primary.organizationId,
          leagueId: primary.leagueId,
        });
        await client.query("UPDATE scores SET score = $1 WHERE id = $2", [original + 1, primary.scoreId]);
        const second = await loadLeagueStandingsSnapshot(tx, {
          organizationId: primary.organizationId,
          leagueId: primary.leagueId,
        });
        expect(second.evidenceFingerprint.value).toBe(first.evidenceFingerprint.value);
        insideFingerprint = first.evidenceFingerprint.value;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      const afterCommit = await loadLeagueStandings({
        organizationId: primary.organizationId,
        leagueId: primary.leagueId,
      });
      expect(afterCommit.evidenceFingerprint.value).not.toBe(insideFingerprint);
      expect(afterCommit.resultSessions[0]?.games[0]?.scores[0]?.score).toBe(original + 1);
    } finally {
      await client.query("UPDATE scores SET score = $1 WHERE id = $2", [original, primary.scoreId]).catch(() => undefined);
      client.release();
    }

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE leagues SET name = name WHERE id = ${primary.leagueId}`);
    }, { isolationLevel: "repeatable read", accessMode: "read only" })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "25006" }),
    });
  });

  it("translates E2 failures into bounded PII-safe service evidence", async () => {
    const [unlinked] = await db.insert(games).values({
      leagueId: primary.leagueId,
      weekNumber: 99,
      gameNumber: 3,
      date: "2039-02-01",
    }).returning();
    if (!unlinked) throw new Error("E3 unlinked service fixture was not created");
    try {
      await expect(loadLeagueStandings({
        organizationId: primary.organizationId,
        leagueId: primary.leagueId,
      })).rejects.toMatchObject({
        evidence: {
          classification: "canonical_games_scores_incompatible",
          organizationId: primary.organizationId,
          leagueId: primary.leagueId,
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    } finally {
      await db.delete(games).where(eq(games.id, unlinked.id));
    }
  });
});
