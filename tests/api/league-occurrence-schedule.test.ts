import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  games,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagues,
  locations,
  organizations,
  scores,
  teams,
  users,
} from "@shared/schema";
import type { LeagueOccurrenceScheduleReadContract } from "@shared/league-occurrence-schedule";
import { LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION } from "@shared/league-setup-integration";
import { hashPassword } from "../../server/lib/password";
import { deleteOrganization } from "../../server/storage/organizations";
import { createGame } from "../../server/storage/games-scores";
import { createLeagueWithCanonicalSetup } from "../../server/services/league-setup-integration";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  apiGet,
  apiPost,
  login,
  type AuthSession,
} from "../helpers";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = "E1-local-password-1!";
const organizationsToDelete: number[] = [];

interface Fixture {
  organizationId: number;
  leagueId: number;
  teamId: number;
  bowlerId: number;
  admin: AuthSession;
  member: AuthSession;
  peer: AuthSession;
  unrostered: AuthSession;
}

async function fixture(label: string): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `E1 ${label}`,
    slug: `e1-${label}-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("E1 organization was not created");
  organizationsToDelete.push(organization.id);
  const [location] = await db.insert(locations).values({
    name: `E1 ${label} lanes`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("E1 location was not created");
  const [bowler] = await db.insert(bowlers).values({ name: `E1 ${label} bowler`, organizationId: organization.id }).returning({ id: bowlers.id });
  const [peerBowler] = await db.insert(bowlers).values({ name: `E1 ${label} peer`, organizationId: organization.id }).returning({ id: bowlers.id });
  if (!bowler || !peerBowler) throw new Error("E1 bowlers were not created");
  const hashed = await hashPassword(password);
  const adminEmail = `e1-${label}-admin-${suffix}@example.test`;
  const memberEmail = `e1-${label}-member-${suffix}@example.test`;
  const peerEmail = `e1-${label}-peer-${suffix}@example.test`;
  const unrosteredEmail = `e1-${label}-unrostered-${suffix}@example.test`;
  const [adminUser, memberUser, peerUser, unrosteredUser] = await db.insert(users).values([
    { email: adminEmail, password: hashed, name: `E1 ${label} admin`, role: "org_admin", organizationId: organization.id },
    { email: memberEmail, password: hashed, name: `E1 ${label} member`, role: "user", organizationId: organization.id, bowlerId: bowler.id },
    { email: peerEmail, password: hashed, name: `E1 ${label} peer`, role: "user", organizationId: organization.id, bowlerId: peerBowler.id },
    { email: unrosteredEmail, password: hashed, name: `E1 ${label} unrostered`, role: "user", organizationId: organization.id },
  ]).returning();
  if (!adminUser || !memberUser || !peerUser || !unrosteredUser) throw new Error("E1 users were not created");
  const league = await createLeagueWithCanonicalSetup({
    scope: { organizationId: organization.id, actorUserId: adminUser.id },
    league: {
      name: `E1 ${label} Fall league`,
      description: null,
      payingLineupSize: 4,
      active: true,
      allowPublicSignup: false,
      seasonStart: "2032-08-01T00:00:00.000Z",
      seasonEnd: "2032-08-22T00:00:00.000Z",
      weekDay: "Sunday",
      weeklyFee: 2_000,
      lineageFee: null,
      prizeFundFee: null,
      practiceStartTime: undefined,
      competitionStartTime: "19:00",
      timezone: "America/Detroit",
      paymentMode: "weekly",
      organizationId: organization.id,
      locationId: location.id,
      seasonNumber: 1,
      previousSeasonId: null,
      totalBowlingWeeks: 3,
      skipDates: ["2032-08-08"],
      cancelledDates: ["2032-08-15"],
      doublePayDates: ["2032-08-01"],
    },
    setup: {
      contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
      idempotencyKey: `10000000-0000-4000-8000-${label === "primary" ? "000000000001" : "000000000002"}`,
    },
  });
  const [team] = await db.insert(teams).values({ name: `E1 ${label} team`, number: 1, leagueId: league.id }).returning({ id: teams.id });
  if (!team) throw new Error("E1 team was not created");
  await db.insert(bowlerLeagues).values([
    { bowlerId: bowler.id, leagueId: league.id, teamId: team.id },
    { bowlerId: peerBowler.id, leagueId: league.id, teamId: team.id },
  ]);
  return {
    organizationId: organization.id,
    leagueId: league.id,
    teamId: team.id,
    bowlerId: bowler.id,
    admin: await login(adminEmail, password),
    member: await login(memberEmail, password),
    peer: await login(peerEmail, password),
    unrostered: await login(unrosteredEmail, password),
  };
}

async function writeSnapshot(leagueId: number): Promise<Record<string, string>> {
  const result = await db.execute<{ name: string; value: string }>(sql`
    SELECT 'league' AS name, row_to_json(l)::text AS value FROM leagues l WHERE l.id = ${leagueId}
    UNION ALL SELECT 'commands', count(*)::text FROM league_schedule_commands WHERE league_id = ${leagueId}
    UNION ALL SELECT 'runs', count(*)::text FROM league_occurrence_generation_runs WHERE league_id = ${leagueId}
    UNION ALL SELECT 'exceptions', count(*)::text FROM league_schedule_exceptions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'occurrences', count(*)::text FROM league_occurrences WHERE league_id = ${leagueId}
    UNION ALL SELECT 'terms', count(*)::text FROM league_occurrence_billing_terms WHERE league_id = ${leagueId}
    UNION ALL SELECT 'relationships', count(*)::text FROM league_occurrence_relationships WHERE league_id = ${leagueId}
    UNION ALL SELECT 'occurrence_revisions', count(*)::text FROM league_occurrence_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'exception_revisions', count(*)::text FROM league_schedule_exception_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'relationship_revisions', count(*)::text FROM league_occurrence_relationship_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'term_revisions', count(*)::text FROM league_occurrence_billing_term_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'discrepancies', count(*)::text FROM league_occurrence_generation_discrepancies WHERE league_id = ${leagueId}
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
  primary = await fixture("primary");
  other = await fixture("other");
  systemAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
});

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("E1 league occurrence schedule API", () => {
  it("authenticates, enforces roster visibility and tenant scope, and requires explicit system-admin organization selection", async () => {
    const unauthenticated = await apiGet(`/api/leagues/${primary.leagueId}/occurrence-schedule`);
    expect(unauthenticated.status).toBe(401);

    const member = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule`,
      primary.member,
    );
    expect(member.status).toBe(200);
    expect(member.data.data).toMatchObject({
      organizationId: primary.organizationId,
      leagueId: primary.leagueId,
      authoritativeSource: "canonical",
      administrator: null,
    });

    const unrostered = await apiGet(`/api/leagues/${primary.leagueId}/occurrence-schedule`, primary.unrostered);
    expect(unrostered.status).toBe(404);
    expect(unrostered.data.error?.code).toBe("NOT_FOUND");

    const crossTenant = await apiGet(`/api/leagues/${other.leagueId}/occurrence-schedule`, primary.admin);
    expect(crossTenant.status).toBe(404);
    expect(JSON.stringify(crossTenant.data)).not.toContain(other.organizationId.toString());

    const missingSystemScope = await apiGet(`/api/leagues/${primary.leagueId}/occurrence-schedule`, systemAdmin);
    expect(missingSystemScope.status).toBe(400);
    expect(missingSystemScope.data.error?.code).toBe("INVALID_REQUEST");
    const scopedSystem = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule?organizationId=${primary.organizationId}`,
      systemAdmin,
    );
    expect(scopedSystem.status).toBe(200);
    expect(scopedSystem.data.data?.administrator).not.toBeNull();
  });

  it("keeps incomplete canonical leagues listed but fails closed on detail reads", async () => {
    const beforeRead = await writeSnapshot(primary.leagueId);
    const [currentRun] = await db.select().from(leagueOccurrenceGenerationRuns).where(
      eq(leagueOccurrenceGenerationRuns.leagueId, primary.leagueId),
    );
    if (!currentRun) throw new Error("E1 canonical generation run was not returned");
    await db.update(leagueOccurrenceGenerationRuns).set({
      candidateOccurrenceCount: currentRun.candidateOccurrenceCount + 1,
      generatedOccurrenceCount: currentRun.generatedOccurrenceCount + 1,
    }).where(eq(leagueOccurrenceGenerationRuns.id, currentRun.id));
    try {
      const canonicalRead = await apiGet<LeagueOccurrenceScheduleReadContract>(
        `/api/leagues/${primary.leagueId}/occurrence-schedule`,
        primary.admin,
      );
      expect(canonicalRead.status).toBe(409);
      expect(canonicalRead.data.error?.code).toBe("CANONICAL_SCHEDULE_INCOMPATIBLE");
      const listedWhilePartial = await apiGet<Array<{ id: number }>>('/api/leagues', primary.admin);
      expect(listedWhilePartial.status).toBe(200);
      expect(listedWhilePartial.data.data?.some((league) => league.id === primary.leagueId)).toBe(true);
      const detailWhilePartial = await apiGet(`/api/leagues/${primary.leagueId}`, primary.admin);
      expect(detailWhilePartial.status).toBe(409);
      expect(detailWhilePartial.data.error?.code).toBe("CANONICAL_SCHEDULE_REQUIRED");
    } finally {
      await db.update(leagueOccurrenceGenerationRuns).set({
        candidateOccurrenceCount: currentRun.candidateOccurrenceCount,
        generatedOccurrenceCount: currentRun.generatedOccurrenceCount,
      }).where(eq(leagueOccurrenceGenerationRuns.id, currentRun.id));
    }
    expect(await writeSnapshot(primary.leagueId)).toEqual(beforeRead);
  });

  it("keeps incomplete approved-only leagues listed but fails closed on detail reads", async () => {
    const [currentRun] = await db.select().from(leagueOccurrenceGenerationRuns).where(
      eq(leagueOccurrenceGenerationRuns.leagueId, primary.leagueId),
    );
    if (!currentRun) throw new Error("E1 approved-only generation run was not returned");
    await db.update(leagueOccurrenceGenerationRuns).set({
      state: "approved",
      candidateOccurrenceCount: currentRun.candidateOccurrenceCount + 1,
      generatedOccurrenceCount: currentRun.generatedOccurrenceCount + 1,
    }).where(
      eq(leagueOccurrenceGenerationRuns.id, currentRun.id),
    );
    try {
      const listed = await apiGet<Array<{ id: number }>>('/api/leagues', primary.admin);
      expect(listed.status).toBe(200);
      expect(listed.data.data?.some((league) => league.id === primary.leagueId)).toBe(true);
      const detail = await apiGet(`/api/leagues/${primary.leagueId}`, primary.admin);
      expect(detail.status).toBe(409);
      expect(detail.data.error?.code).toBe("CANONICAL_SCHEDULE_REQUIRED");
    } finally {
      await db.update(leagueOccurrenceGenerationRuns).set({
        state: currentRun.state,
        candidateOccurrenceCount: currentRun.candidateOccurrenceCount,
        generatedOccurrenceCount: currentRun.generatedOccurrenceCount,
      }).where(
        eq(leagueOccurrenceGenerationRuns.id, currentRun.id),
      );
    }
  });

  it("cuts game and score routes to occurrence identity with tenant-safe atomic batches", async () => {
    const operational = await db.select().from(leagueOccurrences)
      .where(eq(leagueOccurrences.leagueId, primary.leagueId));
    const target = operational.find((row) => row.status === "scheduled" && row.competitionNumber !== null);
    if (!target?.competitionNumber) throw new Error("E2 API target occurrence was not found");
    const game = await createGame({
      leagueId: primary.leagueId,
      weekNumber: target.competitionNumber,
      gameNumber: 1,
      date: target.authoritativeLocalDate,
    });
    expect(game.occurrenceId).toBe(target.id);

    const memberGames = await apiGet<{
      authoritativeSource: string;
      games: Array<{ occurrenceId: string | null; occurrence: { occurrenceId: string } | null }>;
    }>(`/api/games?leagueId=${primary.leagueId}&weekNumber=${target.competitionNumber}`, primary.member);
    expect(memberGames.status).toBe(200);
    expect(memberGames.data.data?.authoritativeSource).toBe("canonical");
    expect(memberGames.data.data?.games).toHaveLength(1);
    expect(memberGames.data.data?.games[0]?.occurrenceId).toBe(target.id);
    expect(memberGames.data.data?.games[0]?.occurrence?.occurrenceId).toBe(target.id);
    const byOccurrence = await apiGet(
      `/api/games?leagueId=${primary.leagueId}&occurrenceId=${target.id}`,
      primary.member,
    );
    expect(byOccurrence.status).toBe(200);
    const spoofedOccurrence = await apiGet(
      `/api/games?leagueId=${primary.leagueId}&occurrenceId=00000000-0000-4000-8000-000000000099`,
      primary.member,
    );
    expect(spoofedOccurrence.status).toBe(409);
    expect(spoofedOccurrence.data.error?.code).toBe("CANONICAL_GAMES_SCORES_INCOMPATIBLE");

    const missingSystemScope = await apiGet(`/api/games?leagueId=${primary.leagueId}`, systemAdmin);
    expect(missingSystemScope.status).toBe(400);
    const scopedSystem = await apiGet(
      `/api/games?leagueId=${primary.leagueId}&organizationId=${primary.organizationId}`,
      systemAdmin,
    );
    expect(scopedSystem.status).toBe(200);
    const crossTenant = await apiGet(`/api/games?leagueId=${other.leagueId}`, primary.admin);
    expect(crossTenant.status).toBe(404);
    expect(JSON.stringify(crossTenant.data)).not.toContain(other.organizationId.toString());

    const validScore = {
      gameId: game.id,
      bowlerId: primary.bowlerId,
      teamId: primary.teamId,
      score: 190,
      handicap: 20,
      average: 175,
      position: 1,
      isVacant: false,
      isAbsent: false,
      isSub: false,
      laneNumber: 1,
      frames: [],
      splits: [],
      notes: [],
    };
    const beforeFinancialEvidence = await writeSnapshot(primary.leagueId);
    const created = await apiPost(`/api/scores/batch`, { scores: [validScore] }, primary.member);
    expect(created.status).toBe(201);
    const scoreRead = await apiGet<{
      authoritativeSource: string;
      scores: Array<{ game: { occurrence: { occurrenceId: string } | null } }>;
    }>(`/api/scores/league/${primary.leagueId}/week/${target.competitionNumber}`, primary.member);
    expect(scoreRead.status).toBe(200);
    expect(scoreRead.data.data?.authoritativeSource).toBe("canonical");
    expect(scoreRead.data.data?.scores).toHaveLength(1);
    expect(scoreRead.data.data?.scores[0]?.game.occurrence?.occurrenceId).toBe(target.id);
    const latestScoreRead = await apiGet<{
      selection: { kind: string; occurrenceId: string | null };
      scores: Array<{ game: { occurrence: { occurrenceId: string } | null } }>;
    }>(`/api/scores?leagueId=${primary.leagueId}&selection=latest_scored_session`, primary.member);
    expect(latestScoreRead.status).toBe(200);
    expect(latestScoreRead.data.data?.selection).toEqual({
      kind: "latest_scored_session",
      identitySource: "canonical_uuid",
      occurrenceId: target.id,
    });
    expect(latestScoreRead.data.data?.scores[0]?.game.occurrence?.occurrenceId).toBe(target.id);
    const missingSystemScoreScope = await apiGet(
      `/api/scores?leagueId=${primary.leagueId}&selection=latest_scored_session`,
      systemAdmin,
    );
    expect(missingSystemScoreScope.status).toBe(400);
    const scopedSystemScores = await apiGet(
      `/api/scores?leagueId=${primary.leagueId}&selection=latest_scored_session&organizationId=${primary.organizationId}`,
      systemAdmin,
    );
    expect(scopedSystemScores.status).toBe(200);
    const history = await apiGet<{
      scores: Array<{ game: { occurrence: { occurrenceId: string } | null } }>;
    }>(`/api/scores/history?bowlerId=${primary.bowlerId}`, primary.member);
    expect(history.status).toBe(200);
    expect(history.data.data?.scores[0]?.game.occurrence?.occurrenceId).toBe(target.id);
    const activeSharedLeagueHistory = await apiGet<{ scores: unknown[] }>(
      `/api/scores/history?bowlerId=${primary.bowlerId}`,
      primary.peer,
    );
    expect(activeSharedLeagueHistory.status).toBe(200);
    expect(activeSharedLeagueHistory.data.data?.scores).toHaveLength(1);
    const missingSystemHistoryScope = await apiGet(
      `/api/scores/history?bowlerId=${primary.bowlerId}`,
      systemAdmin,
    );
    expect(missingSystemHistoryScope.status).toBe(400);
    const scopedSystemHistory = await apiGet(
      `/api/scores/history?bowlerId=${primary.bowlerId}&organizationId=${primary.organizationId}`,
      systemAdmin,
    );
    expect(scopedSystemHistory.status).toBe(200);

    const [foreignGame] = await db.insert(games).values({
      leagueId: other.leagueId,
      weekNumber: 1,
      gameNumber: 1,
      date: "2032-08-01",
    }).returning();
    if (!foreignGame) throw new Error("E2 foreign game fixture was not created");
    const beforeMixed = await db.select().from(scores).where(eq(scores.gameId, game.id));
    const mixed = await apiPost(`/api/scores/batch`, {
      scores: [
        { ...validScore, position: 2, score: 191 },
        {
          ...validScore,
          gameId: foreignGame.id,
          bowlerId: other.bowlerId,
          teamId: other.teamId,
          position: 3,
        },
      ],
    }, primary.member);
    expect(mixed.status).toBe(404);
    expect(JSON.stringify(mixed.data)).not.toContain(other.organizationId.toString());
    expect(await db.select().from(scores).where(eq(scores.gameId, game.id))).toEqual(beforeMixed);

    const teamSpoof = await apiPost(`/api/scores/batch`, {
      scores: [{ ...validScore, teamId: other.teamId, position: 2 }],
    }, primary.member);
    expect(teamSpoof.status).toBe(400);
    const bowlerSpoof = await apiPost(`/api/scores/batch`, {
      scores: [{ ...validScore, bowlerId: other.bowlerId, position: 2 }],
    }, primary.member);
    expect(bowlerSpoof.status).toBe(400);
    expect(await db.select().from(scores).where(eq(scores.gameId, game.id))).toEqual(beforeMixed);
    expect(await writeSnapshot(primary.leagueId)).toEqual(beforeFinancialEvidence);

    await db.update(bowlerLeagues).set({ active: false }).where(eq(bowlerLeagues.bowlerId, primary.bowlerId));
    const retainedSelfHistory = await apiGet<{ scores: unknown[] }>(
      `/api/scores/history?bowlerId=${primary.bowlerId}`,
      primary.member,
    );
    expect(retainedSelfHistory.status).toBe(200);
    expect(retainedSelfHistory.data.data?.scores).toHaveLength(1);
    const retainedAdminHistory = await apiGet<{ scores: unknown[] }>(
      `/api/scores/history?bowlerId=${primary.bowlerId}`,
      primary.admin,
    );
    expect(retainedAdminHistory.status).toBe(200);
    expect(retainedAdminHistory.data.data?.scores).toHaveLength(1);
    const retainedSystemHistory = await apiGet<{ scores: unknown[] }>(
      `/api/scores/history?bowlerId=${primary.bowlerId}&organizationId=${primary.organizationId}`,
      systemAdmin,
    );
    expect(retainedSystemHistory.status).toBe(200);
    expect(retainedSystemHistory.data.data?.scores).toHaveLength(1);
    const formerPeerHistory = await apiGet(
      `/api/scores/history?bowlerId=${primary.bowlerId}`,
      primary.peer,
    );
    expect(formerPeerHistory.status).toBe(404);
  });
});
