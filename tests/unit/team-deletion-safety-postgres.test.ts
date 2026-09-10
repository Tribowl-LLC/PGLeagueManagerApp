import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  autopayConsents,
  autopayConsentPartners,
  bowlerLeagues,
  bowlers,
  bowlerPaymentLinks,
  games,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  payments,
  paymentVoids,
  scores,
  organizations,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  deleteTeam,
  TeamDeletionRequiresArchiveError,
  TeamOrganizationChangedError,
} from "../../server/storage/teams";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { quoteInteractiveObligations, recordCanonicalManualPayment } from "../../server/services/roster-payment-core";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const organizationIds: number[] = [];

interface Fixture {
  organizationId: number;
  actorUserId: number;
  leagueId: number;
  teamIds: number[];
}

async function fixture(label: string, teamCount = 3): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `Team deletion ${label}`,
    slug: `team-deletion-${label.toLowerCase()}-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("organization fixture was not created");
  organizationIds.push(organization.id);

  const [actor] = await db.insert(users).values({
    email: `team-deletion-${label.toLowerCase()}-${suffix}@example.test`,
    password: "test-password-hash",
    name: `Team deletion ${label} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!actor) throw new Error("actor fixture was not created");

  const [location] = await db.insert(locations).values({
    name: `Team deletion ${label} location`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("location fixture was not created");

  const [league] = await db.insert(leagues).values({
    name: `Team deletion ${label} league`,
    organizationId: organization.id,
    locationId: location.id,
    payingLineupSize: 3,
    seasonStart: "2034-01-01",
    seasonEnd: "2034-12-31",
    weekDay: "Sunday",
    timezone: "America/New_York",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("league fixture was not created");

  const insertedTeams = await db.insert(teams).values(Array.from({ length: teamCount }, (_, index) => ({
    name: `Team deletion ${label} team ${index + 1}`,
    leagueId: league.id,
    number: index + 1,
    displayOrder: index,
  }))).returning({ id: teams.id });
  if (insertedTeams.length !== teamCount) throw new Error("team fixtures were not created");

  for (const team of insertedTeams) {
    await db.insert(teamPaymentSlots).values(Array.from({ length: 3 }, (_, slotIndex) => ({
      organizationId: organization.id,
      leagueId: league.id,
      teamId: team.id,
      slotIndex,
      lineupSize: 3,
      occupant: "unassigned" as const,
      recordedByUserId: actor.id,
    })));
  }

  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    leagueId: league.id,
    teamIds: insertedTeams.map(({ id }) => id),
  };
}

interface RichFixture {
  base: Fixture;
  bowlerIds: number[];
  occurrenceIds: string[];
  otherLeagueId: number;
  otherTeamId: number;
}

/** A bounded season-shaped fixture used to prove cleanup across every
 * occurrence while retaining profiles and an unrelated league membership. */
async function richFixture(label: string): Promise<RichFixture> {
  const base = await fixture(label, 2);
  await db.update(leagues).set({ weeklyFee: 2_000, paymentMode: "weekly" }).where(eq(leagues.id, base.leagueId));

  const insertedBowlers = await db.insert(bowlers).values(Array.from({ length: 4 }, (_, index) => ({
    name: `Synthetic deletion ${label} bowler ${index + 1}`,
    email: `synthetic-deletion-${label.toLowerCase()}-${suffix}-${index}@example.test`,
    organizationId: base.organizationId,
  }))).returning({ id: bowlers.id });
  if (insertedBowlers.length !== 4) throw new Error("rich bowler fixtures were not created");
  const bowlerIds = insertedBowlers.map(({ id }) => id);
  await db.insert(bowlerLeagues).values(bowlerIds.map((bowlerId, index) => ({
    bowlerId,
    leagueId: base.leagueId,
    teamId: base.teamIds[0],
    active: index < 3,
    order: index,
  })));
  for (const [slotIndex, bowlerId] of bowlerIds.slice(0, 3).entries()) {
    await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: bowlerId })
      .where(and(eq(teamPaymentSlots.organizationId, base.organizationId), eq(teamPaymentSlots.leagueId, base.leagueId), eq(teamPaymentSlots.teamId, base.teamIds[0]), eq(teamPaymentSlots.slotIndex, slotIndex)));
  }

  const [otherLeague] = await db.insert(leagues).values({
    name: `Synthetic deletion ${label} other league`,
    organizationId: base.organizationId,
    locationId: (await db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, base.organizationId)).limit(1))[0]?.id,
    payingLineupSize: 3,
    weeklyFee: 2_000,
    seasonStart: "2034-01-01",
    seasonEnd: "2034-12-31",
    weekDay: "Sunday",
    timezone: "America/New_York",
  }).returning({ id: leagues.id });
  if (!otherLeague) throw new Error("other league fixture was not created");
  const [otherTeam] = await db.insert(teams).values({ name: `Synthetic deletion ${label} other team`, leagueId: otherLeague.id, number: 1, displayOrder: 0 }).returning({ id: teams.id });
  if (!otherTeam) throw new Error("other team fixture was not created");
  await db.insert(bowlerLeagues).values({ bowlerId: bowlerIds[0], leagueId: otherLeague.id, teamId: otherTeam.id, active: true });

  const [leagueLocation] = await db.select({ id: locations.id }).from(locations)
    .where(eq(locations.organizationId, base.organizationId)).limit(1);
  if (!leagueLocation) throw new Error("league location fixture was not created");
  const occurrenceIds: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const commandId = randomUUID();
    const date = new Date(Date.UTC(2034, 0, index + 2, 19, 0, 0));
    const startAt = date.toISOString();
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId: base.organizationId,
      leagueId: base.leagueId,
      actorUserId: base.actorUserId,
      commandType: "publish",
      idempotencyKey: `synthetic-team-delete-${label}-${index}-${suffix}`,
      requestFingerprint: `synthetic-team-delete-fingerprint-${label}-${index}-${suffix}`,
    });
    const [occurrence] = await db.insert(leagueOccurrences).values({
      id: randomUUID(),
      organizationId: base.organizationId,
      leagueId: base.leagueId,
      locationId: leagueLocation.id,
      generationKey: `synthetic-team-delete-occurrence-${label}-${index}-${suffix}`,
      kind: "regular",
      status: "scheduled",
      lifecycle: "published",
      authoritativeLocalDate: startAt.slice(0, 10),
      authoritativeLocalStartTime: "19:00:00",
      timezone: "America/New_York",
      startAt,
      selectedUtcOffsetMinutes: -300,
      foldResolution: "unambiguous",
      resolverVersion: "team-deletion-test",
      plannedOrdinal: index + 1,
      competitionNumber: index + 1,
      competitive: true,
      countsInStandings: true,
      currentRevision: 1,
      publishedAt: startAt,
      publishedByUserId: base.actorUserId,
      publicationCommandId: commandId,
    }).returning({ id: leagueOccurrences.id });
    if (!occurrence) throw new Error("occurrence fixture was not created");
    occurrenceIds.push(occurrence.id);
    await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: base.organizationId,
      leagueId: base.leagueId,
      occurrenceId: occurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 2_000,
      currency: "USD",
      billingOrdinal: index + 1,
      version: 1,
      state: "published",
      publishedAt: startAt,
      publishedByUserId: base.actorUserId,
      publicationCommandId: commandId,
    });
    await db.transaction(async (tx) => {
      await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId: base.organizationId, leagueId: base.leagueId, occurrenceId: occurrence.id, actorUserId: base.actorUserId, teamId: base.teamIds[0] });
    });
  }

  return { base, bowlerIds, occurrenceIds, otherLeagueId: otherLeague.id, otherTeamId: otherTeam.id };
}

async function firstTargetObligation(f: RichFixture, payerBowlerId?: number) {
  const conditions = [
    eq(paymentObligations.organizationId, f.base.organizationId),
    eq(paymentObligations.leagueId, f.base.leagueId),
    eq(occurrencePaymentResponsibilities.teamId, f.base.teamIds[0]),
  ];
  if (payerBowlerId !== undefined) conditions.push(eq(paymentObligations.payerBowlerId, payerBowlerId));
  const [row] = await db.select({ obligation: paymentObligations }).from(paymentObligations).innerJoin(
    occurrencePaymentResponsibilities,
    and(
      eq(occurrencePaymentResponsibilities.id, paymentObligations.responsibilityId),
      eq(occurrencePaymentResponsibilities.organizationId, paymentObligations.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, paymentObligations.leagueId),
    ),
  ).where(and(...conditions)).orderBy(paymentObligations.dueAt, paymentObligations.id).limit(1);
  if (!row?.obligation) throw new Error("target obligation fixture was not created");
  return row.obligation;
}

async function addPaymentForObligation(
  f: RichFixture,
  obligationId: string,
  bowlerId: number,
  amount: number,
  allocatedAmount = amount,
  status: "paid" | "refunded" | "voided" = "paid",
): Promise<number> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.insert(payments).values({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      bowlerId,
      amount,
      type: "cash",
      status: status === "voided" ? "voided" : "paid",
    }).returning({ id: payments.id });
    if (!payment) throw new Error("payment fixture was not created");
    await tx.insert(paymentAllocations).values({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      paymentId: payment.id,
      obligationId,
      amountMinor: allocatedAmount,
      state: status === "voided" ? "voided" : "active",
      recordedByUserId: f.base.actorUserId,
    });
    if (status === "refunded") {
      await tx.update(payments).set({ status: "refunded" }).where(eq(payments.id, payment.id));
    } else if (status === "voided") {
      await tx.insert(paymentVoids).values({
        organizationId: f.base.organizationId,
        leagueId: f.base.leagueId,
        paymentId: payment.id,
        reason: "synthetic team deletion blocker",
        recordedByUserId: f.base.actorUserId,
      });
      await tx.update(payments).set({ status: "voided" }).where(eq(payments.id, payment.id));
      await tx.update(paymentAllocations).set({ state: "voided" }).where(eq(paymentAllocations.paymentId, payment.id));
    }
    return payment.id;
  });
}

/** Add one same-league obligation for the first retained bowler on the
 * sibling team. This gives the race tests a concrete unrelated obligation
 * while the target team's historical setup remains independently deletable.
 */
async function addSameLeagueSiblingObligation(f: RichFixture, occurrenceIndex = 0) {
  const siblingTeamId = f.base.teamIds[1];
  const bowlerId = f.bowlerIds[0];
  // The slot identity is unique within an organization/league. The bowler's
  // historical target responsibilities remain intact after this vacancy,
  // while the current membership is deliberately moved to the sibling team.
  await db.update(teamPaymentSlots).set({ occupant: "vacant", mainBowlerId: null }).where(and(
    eq(teamPaymentSlots.organizationId, f.base.organizationId),
    eq(teamPaymentSlots.leagueId, f.base.leagueId),
    eq(teamPaymentSlots.teamId, f.base.teamIds[0]),
    eq(teamPaymentSlots.slotIndex, 0),
  ));
  await db.insert(bowlerLeagues).values({
    bowlerId,
    leagueId: f.base.leagueId,
    teamId: siblingTeamId,
    active: true,
    order: 0,
  });
  await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: bowlerId }).where(and(
    eq(teamPaymentSlots.organizationId, f.base.organizationId),
    eq(teamPaymentSlots.leagueId, f.base.leagueId),
    eq(teamPaymentSlots.teamId, siblingTeamId),
    eq(teamPaymentSlots.slotIndex, 0),
  ));
  await db.transaction(async (tx) => {
    await materializeRosterPaymentOccurrenceInTransaction(tx, {
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      occurrenceId: f.occurrenceIds[occurrenceIndex],
      actorUserId: f.base.actorUserId,
      teamId: siblingTeamId,
    });
  });
  const [row] = await db.select({ obligation: paymentObligations }).from(paymentObligations).innerJoin(
    occurrencePaymentResponsibilities,
    and(
      eq(occurrencePaymentResponsibilities.id, paymentObligations.responsibilityId),
      eq(occurrencePaymentResponsibilities.organizationId, paymentObligations.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, paymentObligations.leagueId),
    ),
  ).where(and(
    eq(paymentObligations.organizationId, f.base.organizationId),
    eq(paymentObligations.leagueId, f.base.leagueId),
    eq(occurrencePaymentResponsibilities.teamId, siblingTeamId),
    eq(paymentObligations.payerBowlerId, bowlerId),
  )).orderBy(paymentObligations.dueAt, paymentObligations.id).limit(1);
  if (!row?.obligation) throw new Error("sibling obligation fixture was not created");
  return row.obligation;
}

async function addSnapshotEvidence(
  f: RichFixture,
  obligation: Awaited<ReturnType<typeof firstTargetObligation>>,
  normalizedItemObligation = obligation,
): Promise<void> {
  const operationId = randomUUID();
  const fingerprint = "d".repeat(64);
  await db.transaction(async (tx) => {
    await tx.insert(paymentOperations).values({
      id: operationId,
      organizationId: f.base.organizationId,
      authorizingUserId: f.base.actorUserId,
      operationType: "interactive_charge",
      targetKey: `synthetic-team-delete-operation-${operationId}`,
      leagueId: f.base.leagueId,
      amountMinor: obligation.amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${fingerprint}`,
      providerIdempotencyKey: `synthetic-team-delete-${operationId}`.slice(0, 45),
      providerName: "square",
      status: "failed_terminal",
      nextAttemptAt: null,
      attemptCount: 1,
      startedAt: "2034-01-01T19:00:00.000Z",
      completedAt: "2034-01-01T19:01:00.000Z",
      errorClassification: "hard_decline",
      errorCode: "DECLINED",
    });
    await tx.insert(paymentOperationRosterSnapshots).values({
      operationId,
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      snapshotKind: "interactive",
      amountMinor: obligation.amountMinor,
      currency: "USD",
      obligations: [{ obligationId: obligation.id, responsibilityId: obligation.responsibilityId, amountMinor: obligation.amountMinor }],
      payerBowlerId: obligation.payerBowlerId,
      requestKind: "direct",
      encryptedSourceId: "synthetic-source",
      sourceKind: "new_card",
      quoteFingerprint: `lvrosterquote:v1:${fingerprint}`,
      snapshotFingerprint: `lvrosterexec:v1:${fingerprint}`,
    });
    // Released rows are still immutable operation evidence and must remain a
    // blocker even though they no longer reserve the obligation. The JSON
    // snapshot may independently reference another exact target obligation;
    // callers can use a sibling item to prove that JSON scanning is enforced.
    await tx.insert(paymentOperationRosterSnapshotItems).values({
      operationId,
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      obligationId: normalizedItemObligation.id,
      allocationIndex: 0,
      amountMinor: normalizedItemObligation.amountMinor,
      state: "released",
    });
  });
}

async function addActiveConsentForPayer(f: RichFixture, payerBowlerId: number): Promise<void> {
  await db.insert(autopayConsents).values({
    id: randomUUID(),
    organizationId: f.base.organizationId,
    leagueId: f.base.leagueId,
    payerBowlerId,
    consentVersion: 1,
    state: "active",
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${"e".repeat(64)}`,
    providerName: "square",
    providerLocationId: "synthetic-location",
    encryptedSourceId: "synthetic-source",
    encryptedCustomerId: "synthetic-customer",
    createdByUserId: f.base.actorUserId,
  });
}

afterAll(async () => {
  for (const organizationId of organizationIds.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("team deletion safety boundaries", () => {
  it("removes vacant and revised setup when no financial evidence exists", async () => {
    const f = await fixture("unused-setup", 1);
    const [slot] = await db.select({ id: teamPaymentSlots.id })
      .from(teamPaymentSlots)
      .where(and(
        eq(teamPaymentSlots.organizationId, f.organizationId),
        eq(teamPaymentSlots.leagueId, f.leagueId),
        eq(teamPaymentSlots.teamId, f.teamIds[0]),
        eq(teamPaymentSlots.slotIndex, 0),
      ));
    if (!slot) throw new Error("slot fixture was not created");

    await db.update(teamPaymentSlots).set({ occupant: "vacant", currentRevision: 2 })
      .where(eq(teamPaymentSlots.id, slot.id));

    await expect(deleteTeam(f.teamIds[0], f.organizationId)).resolves.toBeUndefined();
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[0])))[0])
      .toBeUndefined();
    expect((await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots).where(eq(teamPaymentSlots.id, slot.id)))[0])
      .toBeUndefined();
  });

  it("rejects a mismatched tenant scope without deleting the team", async () => {
    const first = await fixture("tenant-a", 1);
    const second = await fixture("tenant-b", 1);

    await expect(deleteTeam(first.teamIds[0], second.organizationId))
      .rejects.toBeInstanceOf(TeamOrganizationChangedError);
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, first.teamIds[0])))[0]?.id)
      .toBe(first.teamIds[0]);
  });

  it("deletes four-bowler, twelve-occurrence unpaid setup while retaining profiles and other league data", async () => {
    const f = await richFixture("season-success");
    const targetTeamId = f.base.teamIds[0];
    const beforeResponsibilities = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, f.base.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, f.base.leagueId),
      eq(occurrencePaymentResponsibilities.teamId, targetTeamId),
    ));
    const beforeObligations = await db.select({ id: paymentObligations.id }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, f.base.organizationId),
      eq(paymentObligations.leagueId, f.base.leagueId),
    ));
    expect(f.occurrenceIds).toHaveLength(12);
    expect(f.bowlerIds).toHaveLength(4);
    expect(beforeResponsibilities).toHaveLength(36);
    expect(beforeObligations).toHaveLength(36);
    await expect(deleteTeam(targetTeamId, f.base.organizationId)).resolves.toBeUndefined();

    expect(await db.select({ id: teams.id }).from(teams).where(eq(teams.id, targetTeamId))).toHaveLength(0);
    expect(await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots).where(eq(teamPaymentSlots.teamId, targetTeamId))).toHaveLength(0);
    expect(await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(inArray(occurrencePaymentResponsibilities.id, beforeResponsibilities.map(({ id }) => id)))).toHaveLength(0);
    expect(await db.select({ id: paymentObligations.id }).from(paymentObligations).where(inArray(paymentObligations.id, beforeObligations.map(({ id }) => id)))).toHaveLength(0);
    expect(await db.select({ id: bowlers.id }).from(bowlers).where(inArray(bowlers.id, f.bowlerIds))).toHaveLength(4);
    expect(await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, f.base.organizationId),
      eq(leagueOccurrences.leagueId, f.base.leagueId),
      inArray(leagueOccurrences.id, f.occurrenceIds),
    ))).toHaveLength(12);
    expect(await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.otherTeamId))).toHaveLength(1);
    expect(await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(and(
      eq(bowlerLeagues.bowlerId, f.bowlerIds[0]),
      eq(bowlerLeagues.leagueId, f.otherLeagueId),
      eq(bowlerLeagues.teamId, f.otherTeamId),
    ))).toHaveLength(1);
  });

  it.each([
    "settled obligation",
    "refunded payment allocation",
    "voided payment allocation",
    "released operation snapshot",
    "JSON-only failed operation snapshot",
    "score history",
  ])("blocks retained %s with an actionable archive conflict", async (kind) => {
    const f = await richFixture(`block-${kind.replaceAll(" ", "-")}`);
    const obligation = await firstTargetObligation(f);
    if (kind === "settled obligation") {
      await db.update(paymentObligations).set({ state: "settled" }).where(eq(paymentObligations.id, obligation.id));
    } else if (kind === "refunded payment allocation" || kind === "voided payment allocation") {
      await addPaymentForObligation(f, obligation.id, obligation.payerBowlerId, obligation.amountMinor, obligation.amountMinor, kind === "voided payment allocation" ? "voided" : "refunded");
    } else if (kind === "released operation snapshot") {
      await addSnapshotEvidence(f, obligation);
    } else if (kind === "JSON-only failed operation snapshot") {
      const siblingObligation = await addSameLeagueSiblingObligation(f, 11);
      await addSnapshotEvidence(f, obligation, siblingObligation);
    } else {
      const [game] = await db.insert(games).values({
        leagueId: f.base.leagueId,
        weekNumber: 1,
        gameNumber: 1,
        date: "2034-01-02T19:00:00.000Z",
        occurrenceId: f.occurrenceIds[0],
      }).returning({ id: games.id });
      if (!game) throw new Error("score game fixture was not created");
      await db.insert(scores).values({
        gameId: game.id,
        bowlerId: f.bowlerIds[0],
        teamId: f.base.teamIds[0],
        score: 200,
        handicap: 0,
        average: 190,
        position: 1,
        laneNumber: 1,
      });
    }

    await expect(deleteTeam(f.base.teamIds[0], f.base.organizationId)).rejects.toMatchObject({
      blockerCode: expect.any(String),
    });
    expect(await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.base.teamIds[0]))).toHaveLength(1);
  });

  it("blocks an active consent for a member losing the last active team", async () => {
    const f = await richFixture("active-consent");
    await addActiveConsentForPayer(f, f.bowlerIds[0]);
    await expect(deleteTeam(f.base.teamIds[0], f.base.organizationId)).rejects.toMatchObject({ blockerCode: "AUTOPAY_ACTIVITY" });
  });

  it("blocks an active external-payer consent accepted by a last-team member", async () => {
    const f = await richFixture("external-partner-consent");
    const [external] = await db.insert(bowlers).values({
      name: "Synthetic external payer",
      email: `synthetic-external-payer-${suffix}@example.test`,
      organizationId: f.base.organizationId,
    }).returning({ id: bowlers.id });
    if (!external) throw new Error("external payer fixture was not created");
    const [link] = await db.insert(bowlerPaymentLinks).values({
      bowlerAId: Math.min(external.id, f.bowlerIds[0]),
      bowlerBId: Math.max(external.id, f.bowlerIds[0]),
      organizationId: f.base.organizationId,
      status: "accepted",
      createdByUserId: f.base.actorUserId,
      respondedAt: "2034-01-01T00:00:00.000Z",
    }).returning({ id: bowlerPaymentLinks.id });
    if (!link) throw new Error("external payer link fixture was not created");
    const consentId = randomUUID();
    await db.insert(autopayConsents).values({
      id: consentId,
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      payerBowlerId: external.id,
      consentVersion: 1,
      state: "active",
      paymentMode: "weekly",
      consentFingerprint: `lvstandingconsent:v1:${"f".repeat(64)}`,
      providerName: "square",
      providerLocationId: "synthetic-location",
      encryptedSourceId: "synthetic-source",
      encryptedCustomerId: "synthetic-customer",
      createdByUserId: f.base.actorUserId,
    });
    await db.insert(autopayConsentPartners).values({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      consentId,
      consentVersion: 1,
      partnerBowlerId: f.bowlerIds[0],
      paymentLinkId: link.id,
      linkFingerprint: `lvpartnerlink:v1:${"1".repeat(64)}`,
    });

    await expect(deleteTeam(f.base.teamIds[0], f.base.organizationId)).rejects.toMatchObject({ blockerCode: "AUTOPAY_ACTIVITY" });
  });

  it("preserves an active consent when its payer remains on another team", async () => {
    const f = await richFixture("consent-other-team");
    await db.insert(bowlerLeagues).values({ bowlerId: f.bowlerIds[0], leagueId: f.base.leagueId, teamId: f.base.teamIds[1], active: true });
    await addActiveConsentForPayer(f, f.bowlerIds[0]);
    await expect(deleteTeam(f.base.teamIds[0], f.base.organizationId)).resolves.toBeUndefined();
    expect(await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.base.teamIds[1]))).toHaveLength(1);
    expect(await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(and(
      eq(bowlerLeagues.bowlerId, f.bowlerIds[0]),
      eq(bowlerLeagues.leagueId, f.base.leagueId),
      eq(bowlerLeagues.teamId, f.base.teamIds[1]),
    ))).toHaveLength(1);
  });

  it("allows a fully allocated payment that belongs only to the payer's other team", async () => {
    const f = await richFixture("other-team-payment");
    const siblingObligation = await addSameLeagueSiblingObligation(f);
    const paymentId = await addPaymentForObligation(
      f,
      siblingObligation.id,
      f.bowlerIds[0],
      siblingObligation.amountMinor,
    );
    await addActiveConsentForPayer(f, f.bowlerIds[0]);

    await expect(deleteTeam(f.base.teamIds[0], f.base.organizationId)).resolves.toBeUndefined();
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId))).toHaveLength(1);
    expect(await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.paymentId, paymentId),
      eq(paymentAllocations.obligationId, siblingObligation.id),
    ))).toHaveLength(1);
    expect(await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, siblingObligation.id))).toHaveLength(1);
    expect(await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(and(
      eq(bowlerLeagues.bowlerId, f.bowlerIds[0]),
      eq(bowlerLeagues.leagueId, f.base.leagueId),
      eq(bowlerLeagues.teamId, f.base.teamIds[1]),
    ))).toHaveLength(1);
  });

  it("serializes a retained roster update ahead of deletion", async () => {
    const f = await fixture("concurrent", 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });

    const rosterUpdate = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, f.organizationId, f.leagueId);
      locked();
      await held;
      await tx.update(teamPaymentSlots).set({ occupant: "vacant", currentRevision: 2 })
        .where(and(
          eq(teamPaymentSlots.organizationId, f.organizationId),
          eq(teamPaymentSlots.leagueId, f.leagueId),
          eq(teamPaymentSlots.teamId, f.teamIds[0]),
          eq(teamPaymentSlots.slotIndex, 0),
        ));
    });

    await acquired;
    const deletion = deleteTeam(f.teamIds[0], f.organizationId);
    release();
    await rosterUpdate;
    await expect(deletion).resolves.toBeUndefined();
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[0])))[0])
      .toBeUndefined();
  });

  it("lets a lock-ordered manual payment win and retains every row for the refused delete", async () => {
    const f = await richFixture("payment-wins-race");
    const obligation = await firstTargetObligation(f);
    const quote = await quoteInteractiveObligations({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      amountMinor: obligation.amountMinor,
      payerBowlerId: obligation.payerBowlerId,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, f.base.organizationId, f.base.leagueId);
      acquired();
      await held;
    });
    await lockAcquired;

    const paymentWrite = recordCanonicalManualPayment({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      actorUserId: f.base.actorUserId,
      request: {
        amountMinor: obligation.amountMinor,
        payerBowlerId: obligation.payerBowlerId,
        type: "cash",
        idempotencyKey: `synthetic-payment-wins-${randomUUID()}`,
        requestFingerprint: quote.fingerprint,
      },
    });
    // Do not release the holder until the existing manual-payment service is
    // visibly queued for this exact advisory lock. This makes the winner
    // deterministic while still exercising the real writer transaction.
    let deletion: Promise<void> | undefined;
    try {
      let paymentQueued = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const lockRows = await db.execute(sql`SELECT COUNT(*)::int AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = ${f.base.organizationId}
            AND objid = ${f.base.leagueId}
            AND granted = false`);
        if (Number((lockRows.rows[0] as { count?: number | string } | undefined)?.count ?? 0) > 0) {
          paymentQueued = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(paymentQueued).toBe(true);
      deletion = deleteTeam(f.base.teamIds[0], f.base.organizationId);
      release();
      await holder;
      await expect(paymentWrite).resolves.toBeDefined();
      await expect(deletion).rejects.toMatchObject({ blockerCode: "SETTLED_OBLIGATION" });
      expect(await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.base.teamIds[0]))).toHaveLength(1);
      expect(await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, obligation.id))).toHaveLength(1);
      expect(await db.select({ id: payments.id }).from(payments).where(and(
        eq(payments.organizationId, f.base.organizationId),
        eq(payments.leagueId, f.base.leagueId),
        eq(payments.bowlerId, obligation.payerBowlerId),
      ))).toHaveLength(1);
      expect(await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(eq(paymentAllocations.obligationId, obligation.id))).toHaveLength(1);
    } finally {
      // Keep a failed lock-queue probe from leaking the holder transaction
      // into later fixture cleanup, and drain whichever waiters were started.
      release();
      const waiters: Promise<unknown>[] = [holder, paymentWrite];
      if (deletion) waiters.push(deletion);
      await Promise.allSettled(waiters);
    }
  });

  it("refuses a stale manual quote after deletion wins and leaves no payment rows", async () => {
    const f = await richFixture("deletion-wins-stale-quote");
    const siblingObligation = await addSameLeagueSiblingObligation(f, 11);
    const targetObligation = await firstTargetObligation(f, f.bowlerIds[0]);
    const payerBowlerId = targetObligation.payerBowlerId;
    const quote = await quoteInteractiveObligations({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      amountMinor: targetObligation.amountMinor,
      payerBowlerId,
    });
    expect(quote.obligations.some((row) => row.id === targetObligation.id)).toBe(true);

    await expect(deleteTeam(f.base.teamIds[0], f.base.organizationId)).resolves.toBeUndefined();
    await expect(recordCanonicalManualPayment({
      organizationId: f.base.organizationId,
      leagueId: f.base.leagueId,
      actorUserId: f.base.actorUserId,
      request: {
        amountMinor: targetObligation.amountMinor,
        payerBowlerId,
        type: "cash",
        idempotencyKey: `synthetic-stale-quote-${randomUUID()}`,
        requestFingerprint: quote.fingerprint,
      },
    })).rejects.toMatchObject({
      code: "STALE_QUOTE",
    });
    expect(await db.select({ id: payments.id }).from(payments).where(and(
      eq(payments.organizationId, f.base.organizationId),
      eq(payments.leagueId, f.base.leagueId),
      eq(payments.bowlerId, payerBowlerId),
    ))).toHaveLength(0);
    expect(await db.select({ id: paymentObligations.id }).from(paymentObligations).where(eq(paymentObligations.id, siblingObligation.id))).toHaveLength(1);
  });

  it("rolls back the full team obligation cleanup if renumbering fails", async () => {
    const rich = await richFixture("rollback-full");
    const f = rich.base;
    const beforeResponsibilities = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, f.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, f.leagueId),
      eq(occurrencePaymentResponsibilities.teamId, f.teamIds[0]),
    ));
    const beforeObligations = await db.select({ id: paymentObligations.id }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, f.organizationId),
      eq(paymentObligations.leagueId, f.leagueId),
      inArray(paymentObligations.responsibilityId, beforeResponsibilities.map(({ id }) => id)),
    ));
    await db.execute(sql`CREATE OR REPLACE FUNCTION team_delete_test_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.number < 0 THEN RAISE EXCEPTION 'intentional team renumber failure'; END IF;
        RETURN NEW;
      END; $$`);
    await db.execute(sql`CREATE TRIGGER team_delete_test_failure_trigger
      BEFORE UPDATE OF number ON teams FOR EACH ROW
      EXECUTE FUNCTION team_delete_test_failure()`);
    try {
      // Drizzle wraps the PostgreSQL trigger message in its failed-query
      // error, so the rollback assertion below is the stable contract.
      await expect(deleteTeam(f.teamIds[0], f.organizationId)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS team_delete_test_failure_trigger ON teams`);
      await db.execute(sql`DROP FUNCTION IF EXISTS team_delete_test_failure()`);
    }

    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[0])))[0]?.id)
      .toBe(f.teamIds[0]);
    const rows = await db.select({ id: teams.id, number: teams.number, displayOrder: teams.displayOrder })
      .from(teams).where(eq(teams.leagueId, f.leagueId)).orderBy(teams.number);
    expect(rows.map(({ id, number, displayOrder }) => ({ id, number, displayOrder })))
      .toEqual(f.teamIds.map((id, index) => ({ id, number: index + 1, displayOrder: index })));
    expect((await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots)
      .where(and(
        eq(teamPaymentSlots.organizationId, f.organizationId),
        eq(teamPaymentSlots.leagueId, f.leagueId),
        eq(teamPaymentSlots.teamId, f.teamIds[0]),
      ))).length).toBe(3);
    expect(await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities)
      .where(inArray(occurrencePaymentResponsibilities.id, beforeResponsibilities.map(({ id }) => id)))).toHaveLength(beforeResponsibilities.length);
    expect(await db.select({ id: paymentObligations.id }).from(paymentObligations)
      .where(inArray(paymentObligations.id, beforeObligations.map(({ id }) => id)))).toHaveLength(beforeObligations.length);
  });

  it("deletes and renumbers active teams atomically under one league lock", async () => {
    const f = await fixture("success");
    await expect(deleteTeam(f.teamIds[1], f.organizationId)).resolves.toBeUndefined();

    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[1])))[0]).toBeUndefined();
    const rows = await db.select({ id: teams.id, number: teams.number, displayOrder: teams.displayOrder })
      .from(teams).where(eq(teams.leagueId, f.leagueId)).orderBy(teams.number);
    expect(rows.map(({ id, number, displayOrder }) => ({ id, number, displayOrder })))
      .toEqual([
        { id: f.teamIds[0], number: 1, displayOrder: 0 },
        { id: f.teamIds[2], number: 2, displayOrder: 1 },
      ]);
    expect((await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots)
      .where(eq(teamPaymentSlots.teamId, f.teamIds[1]))).length).toBe(0);
  });
});
