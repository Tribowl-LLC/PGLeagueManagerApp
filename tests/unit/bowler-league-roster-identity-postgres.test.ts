import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { updateBowlerLeague } from "../../server/storage/bowlers";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `bowler-league-identity-${suffix}`;
let organizationId: number;
let leagueId: number;
let teamId: number;
let actorUserId: number;
let membershipId: number;
let oldMainId: number;
let occurrenceId: string;

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  for (const row of leftovers) await deleteOrganization(row.id);

  const [organization] = await db.insert(organizations).values({ name: "Bowler Identity Fixture", slug }).returning({ id: organizations.id });
  if (!organization) throw new Error("identity fixture organization was not created");
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "Identity Fixture Location" }).returning({ id: locations.id });
  if (!location) throw new Error("identity fixture location was not created");
  const [league] = await db.insert(leagues).values({
    name: "Identity Fixture League",
    organizationId,
    locationId: location.id,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("identity fixture league was not created");
  leagueId = league.id;
  const [actor] = await db.insert(users).values({
    email: `identity-fixture-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Identity Fixture Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  if (!actor) throw new Error("identity fixture actor was not created");
  actorUserId = actor.id;
  const [team] = await db.insert(teams).values({ name: "Identity Fixture Team", number: 1, leagueId }).returning({ id: teams.id });
  if (!team) throw new Error("identity fixture team was not created");
  teamId = team.id;
  const [oldMain] = await db.insert(bowlers).values({ name: "Identity Fixture Old Main", organizationId }).returning({ id: bowlers.id });
  const [replacement] = await db.insert(bowlers).values({ name: "Identity Fixture Replacement", organizationId }).returning({ id: bowlers.id });
  if (!oldMain || !replacement) throw new Error("identity fixture bowlers were not created");
  oldMainId = oldMain.id;
  const [membership] = await db.insert(bowlerLeagues).values({ bowlerId: oldMain.id, leagueId, teamId: team.id }).returning({ id: bowlerLeagues.id });
  if (!membership) throw new Error("identity fixture membership was not created");
  membershipId = membership.id;
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: oldMain.id, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);

  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `identity-fixture-publish-${suffix}`,
    requestFingerprint: `identity-fixture-fingerprint-${suffix}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId: location.id,
    generationKey: `identity-fixture-occurrence-${suffix}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: "2038-02-01",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: "2038-02-01T19:00:00.000Z",
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "identity-fixture-test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    publishedAt: "2038-01-01T00:00:00.000Z",
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  if (!occurrence) throw new Error("identity fixture occurrence was not created");
  occurrenceId = occurrence.id;
  await db.transaction(async (tx) => {
    await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId, actorUserId });
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

describe("bowler-league roster identity changes on PostgreSQL", () => {
  it("voids the old Main responsibility and VACANTs its stable slot", async () => {
    const [oldResponsibility] = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, occurrenceId),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
      eq(occurrencePaymentResponsibilities.mainBowlerId, oldMainId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    if (!oldResponsibility) throw new Error("identity fixture Main responsibility was not materialized");

    const [replacement] = await db.select({ id: bowlers.id }).from(bowlers).where(and(
      eq(bowlers.organizationId, organizationId),
      eq(bowlers.name, "Identity Fixture Replacement"),
    ));
    if (!replacement) throw new Error("identity fixture replacement is missing");
    await updateBowlerLeague(membershipId, { bowlerId: replacement.id }, actorUserId);

    const [slot] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, teamId),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    expect(slot).toMatchObject({ occupant: "vacant", mainBowlerId: null });
    const [oldActive] = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, occurrenceId),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
      eq(occurrencePaymentResponsibilities.mainBowlerId, oldMainId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(oldActive).toBeUndefined();
  });
});
