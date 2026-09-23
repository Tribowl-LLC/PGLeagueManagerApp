import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentObligations,
  rotatingOccurrenceAssignments,
  teamPaymentRotationMembers,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { deleteBowlerLeague, updateBowlerLeague, BowlerLeagueMutationError } from "../../server/storage/bowlers";
import {
  canonicalRotatingAssignmentFingerprint,
  canonicalRotatingRosterFingerprint,
  saveRotatingOccurrenceAssignments,
  saveTeamRoster,
} from "../../server/services/roster-payment-core";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { readConfirmedRotatingObligationsForCredit } from "../../server/services/rotating-team-payments";
import { readRotatingCreditTermsInTransaction } from "../../server/services/rotating-credit";

const db = getTestDb();
const key = randomUUID();
let organizationId: number;
let locationId: number;
let leagueId: number;
let teamId: number;
let actorUserId: number;
let rotatingBowlerId: number;
let reserveRotatingBowlerId: number;
let mainBowlerId: number;
let leagueMembershipId: number;
let reserveLeagueMembershipId: number;

async function createConfirmedOpenRotatingDate() {
  const ordinal = 17;
  const commandId = randomUUID();
  const startAt = "2038-05-17T19:00:00.000Z";
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `credit-eligibility-publish-${key}`,
    requestFingerprint: `credit-eligibility-publish-${key}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId,
    generationKey: `credit-eligibility-occurrence-${key}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: startAt.slice(0, 10),
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "credit-eligibility-test",
    plannedOrdinal: ordinal,
    competitionNumber: ordinal,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  await db.insert(leagueOccurrenceBillingTerms).values({
    organizationId,
    leagueId,
    occurrenceId: occurrence.id,
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: 1_000,
    currency: "USD",
    billingOrdinal: ordinal,
    version: 1,
    state: "published",
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.transaction((tx) => materializeRosterPaymentOccurrenceInTransaction(tx, {
    organizationId,
    leagueId,
    occurrenceId: occurrence.id,
    actorUserId,
    teamId,
  }));
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.teamId, teamId),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  if (!responsibility) throw new Error("rotating responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, organizationId),
    eq(paymentObligations.leagueId, leagueId),
    eq(paymentObligations.responsibilityId, responsibility.id),
  ));
  if (!obligation) throw new Error("rotating obligation was not materialized");

  const assignmentRequest = {
    commandKey: `credit-eligibility-assignment-${key}`,
    requestFingerprint: "",
    assignments: [{
      occurrenceId: occurrence.id,
      teamId,
      slotIndex: 0,
      expectedRevision: null,
      actualBowlerId: rotatingBowlerId,
    }],
  };
  assignmentRequest.requestFingerprint = canonicalRotatingAssignmentFingerprint(assignmentRequest);
  await saveRotatingOccurrenceAssignments({ organizationId, leagueId, actorUserId, request: assignmentRequest });
  const [assignment] = await db.select().from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, leagueId),
    eq(rotatingOccurrenceAssignments.occurrenceId, occurrence.id),
    eq(rotatingOccurrenceAssignments.teamId, teamId),
    eq(rotatingOccurrenceAssignments.slotIndex, 0),
    eq(rotatingOccurrenceAssignments.version, 1),
  ));
  if (!assignment) throw new Error("rotating assignment was not recorded");
  return { occurrence, responsibility, obligation, assignment };
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: `Credit Eligibility ${key}`,
    slug: `credit-eligibility-${key}`,
  }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: `Credit Eligibility ${key}` }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    organizationId,
    locationId,
    name: `Credit Eligibility ${key}`,
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    weeklyFee: 1_000,
    payingLineupSize: 3,
    paymentMode: "weekly",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [team] = await db.insert(teams).values({ name: `Credit Eligibility Team ${key}`, number: 1, leagueId }).returning({ id: teams.id });
  teamId = team.id;
  const [actor] = await db.insert(users).values({
    email: `credit-eligibility-${key}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Credit Eligibility Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const [rotatingBowler] = await db.insert(bowlers).values({ name: `Rotating Bowler ${key}`, organizationId }).returning({ id: bowlers.id });
  rotatingBowlerId = rotatingBowler.id;
  const [reserveRotatingBowler] = await db.insert(bowlers).values({ name: `Reserve Rotating Bowler ${key}`, organizationId }).returning({ id: bowlers.id });
  reserveRotatingBowlerId = reserveRotatingBowler.id;
  const [mainBowler] = await db.insert(bowlers).values({ name: `Main Bowler ${key}`, organizationId }).returning({ id: bowlers.id });
  mainBowlerId = mainBowler.id;
  const memberships = await db.insert(bowlerLeagues).values([
    { bowlerId: rotatingBowlerId, leagueId, teamId },
    { bowlerId: reserveRotatingBowlerId, leagueId, teamId },
    { bowlerId: mainBowlerId, leagueId, teamId },
  ]).returning({ id: bowlerLeagues.id, bowlerId: bowlerLeagues.bowlerId });
  const rotatingMembership = memberships.find((row) => row.bowlerId === rotatingBowlerId);
  if (!rotatingMembership) throw new Error("rotating league membership was not created");
  leagueMembershipId = rotatingMembership.id;
  const reserveMembership = memberships.find((row) => row.bowlerId === reserveRotatingBowlerId);
  if (!reserveMembership) throw new Error("reserve league membership was not created");
  reserveLeagueMembershipId = reserveMembership.id;
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: rotatingBowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
  const rosterRequest = {
    commandKey: `credit-eligibility-roster-${key}`,
    requestFingerprint: "",
    lineupSize: 3 as const,
    slots: [
      { slotIndex: 0, occupant: "rotating" as const, mainBowlerId: null },
      { slotIndex: 1, occupant: "main" as const, mainBowlerId },
      { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
    ],
    eligibleRotatingBowlerIds: [rotatingBowlerId, reserveRotatingBowlerId],
  };
  rosterRequest.requestFingerprint = canonicalRotatingRosterFingerprint(rosterRequest);
  await saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request: rosterRequest });
  await createConfirmedOpenRotatingDate();
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

describe("rotating credit eligibility fences on PostgreSQL", () => {
  it("preserves existing confirmed-date access and blocks league or pool removal until the obligation closes", async () => {
    const confirmed = await db.transaction((tx) => readConfirmedRotatingObligationsForCredit(tx, { organizationId, leagueId, bowlerId: rotatingBowlerId }));
    expect(confirmed.map((row) => ({ obligationId: row.obligationId, teamId: row.teamId, state: row.state, owner: row.owner }))).toMatchObject([
      { teamId, state: "open", owner: { kind: "team", teamId } },
    ]);

    await expect(updateBowlerLeague(leagueMembershipId, { active: false }, actorUserId))
      .rejects.toBeInstanceOf(BowlerLeagueMutationError);
    await expect(deleteBowlerLeague(leagueMembershipId))
      .rejects.toMatchObject({ code: "ROTATING_MEMBER_HAS_OPEN_ASSIGNMENT", status: 409 });

    const poolRemoval = {
      commandKey: `credit-eligibility-remove-pool-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      slots: [
        { slotIndex: 0, occupant: "rotating" as const, mainBowlerId: null },
        { slotIndex: 1, occupant: "main" as const, mainBowlerId },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
      eligibleRotatingBowlerIds: [reserveRotatingBowlerId],
    };
    poolRemoval.requestFingerprint = canonicalRotatingRosterFingerprint(poolRemoval);
    await expect(saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request: poolRemoval }))
      .rejects.toMatchObject({ code: "ROTATING_MEMBER_HAS_OPEN_ASSIGNMENT" });

    // Simulate legacy eligibility data that predates the guard. Existing
    // confirmed assignment evidence must still drive candidate and terms reads.
    await db.update(bowlerLeagues).set({ active: false }).where(eq(bowlerLeagues.id, leagueMembershipId));
    await db.update(teamPaymentRotationMembers).set({ active: false }).where(and(
      eq(teamPaymentRotationMembers.organizationId, organizationId),
      eq(teamPaymentRotationMembers.leagueId, leagueId),
      eq(teamPaymentRotationMembers.teamId, teamId),
      eq(teamPaymentRotationMembers.bowlerId, rotatingBowlerId),
    ));
    await db.update(bowlerLeagues).set({ active: false }).where(eq(bowlerLeagues.id, reserveLeagueMembershipId));
    await db.update(teamPaymentRotationMembers).set({ active: false }).where(and(
      eq(teamPaymentRotationMembers.organizationId, organizationId),
      eq(teamPaymentRotationMembers.leagueId, leagueId),
      eq(teamPaymentRotationMembers.teamId, teamId),
      eq(teamPaymentRotationMembers.bowlerId, reserveRotatingBowlerId),
    ));
    const historicalCandidates = await db.transaction((tx) => readConfirmedRotatingObligationsForCredit(tx, { organizationId, leagueId, bowlerId: rotatingBowlerId }));
    expect(historicalCandidates.map((row) => row.obligationId)).toContain(confirmed[0]?.obligationId);
    const terms = await db.transaction((tx) => readRotatingCreditTermsInTransaction(tx, { organizationId, leagueId, bowlerId: rotatingBowlerId }));
    expect(terms.eligible).toBe(true);
    const unconfirmedTerms = await db.transaction((tx) => readRotatingCreditTermsInTransaction(tx, { organizationId, leagueId, bowlerId: reserveRotatingBowlerId }));
    expect(unconfirmedTerms.eligible).toBe(false);
  });
});
