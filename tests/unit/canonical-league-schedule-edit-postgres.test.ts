import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  bowlerLeagues,
  bowlers,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  occurrencePaymentResponsibilities,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION } from "@shared/league-setup-integration";
import { createLeagueWithCanonicalSetup } from "../../server/services/league-setup-integration";
import { CanonicalLeagueScheduleEditError, editCanonicalLeagueSchedule } from "../../server/services/canonical-league-schedule-edit";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { canonicalResponsibilityFingerprint, recordOccurrenceResponsibilities } from "../../server/services/roster-payment-core";
import { occurrenceSnapshot } from "../../server/services/fall-draft-review";
import * as leagueOccurrenceSchedule from "../../server/services/league-occurrence-schedule";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${randomUUID()}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let actorUserId: number;
let payerBowlerId: number;
let teamId: number;

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: `Schedule edit ${suffix}`,
    slug: `schedule-edit-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("schedule edit organization fixture was not created");
  organizationId = organization.id;

  const [actor] = await db.insert(users).values({
    email: `schedule-edit-${suffix}@example.test`,
    password: "schedule-edit-test-password-hash",
    name: "Schedule edit actor",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  if (!actor) throw new Error("schedule edit actor fixture was not created");
  actorUserId = actor.id;

  const [location] = await db.insert(locations).values({
    name: `Schedule edit location ${suffix}`,
    organizationId,
  }).returning({ id: locations.id });
  if (!location) throw new Error("schedule edit location fixture was not created");
  locationId = location.id;

  const created = await createLeagueWithCanonicalSetup({
    scope: { organizationId, actorUserId },
    league: {
      name: "Canonical schedule edit fixture",
      description: "database-backed schedule edit fixture",
      organizationId,
      locationId,
      active: true,
      allowPublicSignup: false,
      seasonStart: "2032-09-05",
      seasonEnd: "2032-09-26",
      weekDay: "Sunday",
      totalBowlingWeeks: 4,
      skipDates: [],
      cancelledDates: [],
      doublePayDates: ["2032-09-05"],
      competitionStartTime: "19:00",
      timezone: "America/New_York",
      weeklyFee: 2_000,
      paymentMode: "weekly",
      payingLineupSize: 3,
      seasonNumber: 1,
    },
    setup: {
      contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
      idempotencyKey: randomUUID(),
    },
  });
  leagueId = created.id;

  const [team] = await db.insert(teams).values({
    name: "Schedule edit team",
    number: 1,
    leagueId,
  }).returning({ id: teams.id });
  if (!team) throw new Error("schedule edit team fixture was not created");
  teamId = team.id;
  const [payer] = await db.insert(bowlers).values({
    name: "Schedule edit payer",
    organizationId,
  }).returning({ id: bowlers.id });
  if (!payer) throw new Error("schedule edit payer fixture was not created");
  payerBowlerId = payer.id;
  await db.insert(bowlerLeagues).values({
    bowlerId: payerBowlerId,
    leagueId,
    teamId,
    active: true,
    order: 0,
  });
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: payerBowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
  const occurrences = await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences)
    .where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId)))
    .orderBy(asc(leagueOccurrences.plannedOrdinal));
  await db.transaction(async (tx) => {
    for (const occurrence of occurrences) {
      await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId: occurrence.id, actorUserId });
    }
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

function editInput(expectedScheduleRevision: number, idempotencyKey: string, overrides: Partial<Parameters<typeof editCanonicalLeagueSchedule>[0]> = {}) {
  const input: Parameters<typeof editCanonicalLeagueSchedule>[0] = {
    organizationId,
    leagueId,
    actorUserId,
    expectedScheduleRevision,
    idempotencyKey,
    reason: "Correct the canonical schedule in the builder",
    doublePayDates: ["2032-09-05"],
    ...overrides,
  };
  return input;
}

describe("canonical schedule edits (PostgreSQL)", () => {
  it("retains physical UUIDs and financial identities while adding/removing a skip", async () => {
    const [beforeLeague] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
    if (!beforeLeague) throw new Error("schedule edit league fixture is missing");
    const beforeOccurrences = await db.select({
      id: leagueOccurrences.id,
      ordinal: leagueOccurrences.plannedOrdinal,
      localDate: leagueOccurrences.authoritativeLocalDate,
    }).from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, leagueId)).orderBy(asc(leagueOccurrences.plannedOrdinal));
    const beforeTerms = await db.select({ occurrenceId: leagueOccurrenceBillingTerms.occurrenceId, id: leagueOccurrenceBillingTerms.id, amount: leagueOccurrenceBillingTerms.defaultAmountMinor, ordinal: leagueOccurrenceBillingTerms.billingOrdinal })
      .from(leagueOccurrenceBillingTerms).where(and(eq(leagueOccurrenceBillingTerms.leagueId, leagueId), eq(leagueOccurrenceBillingTerms.state, "published")));
    const applied = await editCanonicalLeagueSchedule(editInput(beforeLeague.canonicalScheduleRevision, "schedule-edit-add-skip", {
      seasonEnd: "2032-10-03",
      skipDates: ["2032-09-12"],
    }));
    expect(applied.mode).toBe("applied");
    expect(applied.scheduleRevision).toBe(beforeLeague.canonicalScheduleRevision + 1);

    const afterOccurrences = await db.select({
      id: leagueOccurrences.id,
      ordinal: leagueOccurrences.plannedOrdinal,
      localDate: leagueOccurrences.authoritativeLocalDate,
    }).from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, leagueId)).orderBy(asc(leagueOccurrences.plannedOrdinal));
    expect(afterOccurrences.map((row) => row.id)).toEqual(beforeOccurrences.map((row) => row.id));
    expect(afterOccurrences.map((row) => row.localDate)).toEqual(["2032-09-05", "2032-09-19", "2032-09-26", "2032-10-03"]);

    const afterTerms = await db.select({ occurrenceId: leagueOccurrenceBillingTerms.occurrenceId, id: leagueOccurrenceBillingTerms.id, amount: leagueOccurrenceBillingTerms.defaultAmountMinor, ordinal: leagueOccurrenceBillingTerms.billingOrdinal })
      .from(leagueOccurrenceBillingTerms).where(and(eq(leagueOccurrenceBillingTerms.leagueId, leagueId), eq(leagueOccurrenceBillingTerms.state, "published")));
    expect(afterTerms).toEqual(expect.arrayContaining(beforeTerms));
    const afterResponsibilities = await db.select({ occurrenceId: occurrencePaymentResponsibilities.occurrenceId, payer: occurrencePaymentResponsibilities.payerBowlerId, amount: occurrencePaymentResponsibilities.amountMinor, state: occurrencePaymentResponsibilities.state, version: occurrencePaymentResponsibilities.version })
      .from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId)));
    expect(afterResponsibilities.filter((row) => row.state === "active")).toHaveLength(4);
    expect(afterResponsibilities.filter((row) => row.state === "active").every((row) => row.payer === payerBowlerId && row.amount === 2_000)).toBe(true);
    expect(afterResponsibilities.filter((row) => row.state === "voided")).toHaveLength(3);

    const [exception] = await db.select().from(leagueScheduleExceptions).where(and(eq(leagueScheduleExceptions.organizationId, organizationId), eq(leagueScheduleExceptions.leagueId, leagueId), eq(leagueScheduleExceptions.localDate, "2032-09-12")));
    expect(exception?.lifecycle).toBe("published");
    const groups = await db.select({ groupId: canonicalCollectionGroups.id, state: canonicalCollectionGroups.state, pairedDate: canonicalCollectionGroups.pairedLocalDate }).from(canonicalCollectionGroups).where(eq(canonicalCollectionGroups.leagueId, leagueId)).orderBy(asc(canonicalCollectionGroups.currentRevision));
    expect(groups.filter((group) => group.state === "published")).toHaveLength(1);
    expect(groups.filter((group) => group.state === "revoked")).toHaveLength(1);
    expect(groups.filter((group) => group.state === "published")[0]?.pairedDate).toBe("2032-10-03");
    const activeMembers = await db.select({ occurrenceId: canonicalCollectionGroupMembers.occurrenceId }).from(canonicalCollectionGroupMembers)
      .where(and(eq(canonicalCollectionGroupMembers.organizationId, organizationId), eq(canonicalCollectionGroupMembers.leagueId, leagueId), eq(canonicalCollectionGroupMembers.active, true)));
    expect(activeMembers).toHaveLength(2);

    const retry = await editCanonicalLeagueSchedule(editInput(beforeLeague.canonicalScheduleRevision, "schedule-edit-add-skip", {
      seasonEnd: "2032-10-03",
      skipDates: ["2032-09-12"],
    }));
    expect(retry).toMatchObject({ mode: "idempotent_retry", writesPerformed: false, scheduleRevision: applied.scheduleRevision });

    await expect(editCanonicalLeagueSchedule(editInput(beforeLeague.canonicalScheduleRevision, "schedule-edit-stale", {
      seasonEnd: "2032-10-03",
      skipDates: ["2032-09-12"],
    }))).rejects.toMatchObject({ code: "stale_revision" });

    const removed = await editCanonicalLeagueSchedule(editInput(applied.scheduleRevision, "schedule-edit-remove-skip", {
      seasonEnd: "2032-09-26",
      skipDates: [],
    }));
    expect(removed.mode).toBe("applied");
    const restoredOccurrences = await db.select({ id: leagueOccurrences.id, localDate: leagueOccurrences.authoritativeLocalDate }).from(leagueOccurrences)
      .where(eq(leagueOccurrences.leagueId, leagueId)).orderBy(asc(leagueOccurrences.plannedOrdinal));
    expect(restoredOccurrences.map((row) => row.id)).toEqual(beforeOccurrences.map((row) => row.id));
    expect(restoredOccurrences.map((row) => row.localDate)).toEqual(beforeOccurrences.map((row) => row.localDate));
    const [revokedException] = await db.select({ lifecycle: leagueScheduleExceptions.lifecycle }).from(leagueScheduleExceptions).where(and(eq(leagueScheduleExceptions.leagueId, leagueId), eq(leagueScheduleExceptions.localDate, "2032-09-12")));
    expect(revokedException?.lifecycle).toBe("revoked");

    // A time-only edit must be allowed to revoke/rebuild the existing group;
    // its active member is still valid open evidence, not a lock by itself.
    const timed = await editCanonicalLeagueSchedule(editInput(removed.scheduleRevision, "schedule-edit-time-only", {
      competitionStartTime: "20:00",
    }));
    expect(timed.mode).toBe("applied");
    const timedGroups = await db.select({ state: canonicalCollectionGroups.state, pairedDate: canonicalCollectionGroups.pairedLocalDate }).from(canonicalCollectionGroups).where(eq(canonicalCollectionGroups.leagueId, leagueId));
    expect(timedGroups.filter((group) => group.state === "published")).toHaveLength(1);
    expect(timedGroups.filter((group) => group.state === "published")[0]?.pairedDate).toBe("2032-09-26");

    const [substitute] = await db.insert(bowlers).values({ name: "Schedule edit substitute", organizationId }).returning({ id: bowlers.id });
    if (!substitute) throw new Error("schedule edit substitute fixture was not created");
    await db.insert(bowlerLeagues).values({ bowlerId: substitute.id, leagueId, teamId, active: true, order: 1 });
    await db.update(leagues).set({ substitutePaymentRegime: "league_lineage_prize_split", lineageFee: 1_000, prizeFundFee: 1_000 }).where(eq(leagues.id, leagueId));
    const [splitOccurrence] = await db.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt }).from(leagueOccurrences)
      .where(and(eq(leagueOccurrences.leagueId, leagueId), eq(leagueOccurrences.authoritativeLocalDate, "2032-09-12")));
    if (!splitOccurrence) throw new Error("schedule edit split occurrence fixture is missing");
    const splitResponsibility = {
      occurrenceId: splitOccurrence.id,
      teamId,
      slotIndex: 0,
      positionIndex: 0,
      kind: "split" as const,
      mainBowlerId: payerBowlerId,
      substituteBowlerId: substitute.id,
      payerBowlerId: substitute.id,
      policy: "special_split" as const,
      amountMinor: 2_000,
      assignmentNote: "schedule edit split fixture",
      dueAt: splitOccurrence.startAt,
      pastDueAt: "2032-09-12T23:00:00.000Z",
    };
    await recordOccurrenceResponsibilities({
      organizationId,
      leagueId,
      actorUserId,
      commandKey: "schedule-edit-split-responsibility",
      requestFingerprint: canonicalResponsibilityFingerprint([splitResponsibility]),
      responsibilities: [splitResponsibility],
    });
    const [splitBefore] = await db.select({ payer: occurrencePaymentResponsibilities.payerBowlerId, lineagePayer: occurrencePaymentResponsibilities.lineagePayerBowlerId, prizePayer: occurrencePaymentResponsibilities.prizePayerBowlerId, amount: occurrencePaymentResponsibilities.amountMinor, lineageAmount: occurrencePaymentResponsibilities.lineageAmountMinor, prizeAmount: occurrencePaymentResponsibilities.prizeFundAmountMinor, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities)
      .where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId), eq(occurrencePaymentResponsibilities.occurrenceId, splitOccurrence.id), eq(occurrencePaymentResponsibilities.state, "active")));
    expect(splitBefore).toMatchObject({ payer: substitute.id, lineagePayer: substitute.id, prizePayer: payerBowlerId, amount: 2_000, lineageAmount: 1_000, prizeAmount: 1_000, state: "active" });

    const [inactiveBeforeOccurrence] = await db.select({ localDate: leagueOccurrences.authoritativeLocalDate, revision: leagueOccurrences.currentRevision })
      .from(leagueOccurrences).where(eq(leagueOccurrences.id, splitOccurrence.id));
    const inactiveBeforeObligations = await db.select({ id: paymentObligations.id, dueAt: paymentObligations.dueAt, state: paymentObligations.state })
      .from(paymentObligations).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, leagueId), eq(paymentObligations.occurrenceId, splitOccurrence.id)));
    await db.update(teams).set({ active: false }).where(eq(teams.id, teamId));
    const [inactiveLeague] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(eq(leagues.id, leagueId));
    if (!inactiveLeague || !inactiveBeforeOccurrence) throw new Error("schedule edit inactive-team fixture is missing");
    const inactiveError = await editCanonicalLeagueSchedule(editInput(inactiveLeague.canonicalScheduleRevision, "schedule-edit-inactive-team", {
      competitionStartTime: "20:30",
      doublePayDates: ["2032-09-05"],
    })).then(() => null, (caught: unknown) => caught);
    expect(inactiveError).toBeInstanceOf(CanonicalLeagueScheduleEditError);
    expect((inactiveError as CanonicalLeagueScheduleEditError).code).toBe("financial_conflict");
    expect((inactiveError as CanonicalLeagueScheduleEditError).message).toContain("inactive team");
    expect(await db.select({ localDate: leagueOccurrences.authoritativeLocalDate, revision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(eq(leagueOccurrences.id, splitOccurrence.id))).toEqual([inactiveBeforeOccurrence]);
    expect(await db.select({ id: paymentObligations.id, dueAt: paymentObligations.dueAt, state: paymentObligations.state }).from(paymentObligations).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, leagueId), eq(paymentObligations.occurrenceId, splitOccurrence.id)))).toEqual(inactiveBeforeObligations);
    await db.update(teams).set({ active: true }).where(eq(teams.id, teamId));

    // Simulate the reported mistaken elapsed start. The editor may correct it
    // only when every proposed slot is new/future and no payment evidence or
    // game exists; all occurrence UUIDs remain the same.
    const [elapsedTarget] = await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences)
      .where(and(eq(leagueOccurrences.leagueId, leagueId), eq(leagueOccurrences.authoritativeLocalDate, "2032-09-05")));
    if (!elapsedTarget) throw new Error("schedule edit elapsed occurrence fixture is missing");
    await db.update(leagueOccurrences).set({ startAt: "2026-01-04T00:00:00.000Z" }).where(eq(leagueOccurrences.id, elapsedTarget.id));
    const [currentForElapsed] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(eq(leagues.id, leagueId));
    if (!currentForElapsed) throw new Error("schedule edit league fixture is missing");
    const corrected = await editCanonicalLeagueSchedule(editInput(currentForElapsed.canonicalScheduleRevision, "schedule-edit-elapsed-correction", {
      seasonStart: "2033-09-04",
      seasonEnd: "2033-09-25",
      doublePayDates: ["2033-09-04"],
    }));
    expect(corrected.mode).toBe("applied");
    const correctedOccurrences = await db.select({ id: leagueOccurrences.id, localDate: leagueOccurrences.authoritativeLocalDate }).from(leagueOccurrences)
      .where(eq(leagueOccurrences.leagueId, leagueId)).orderBy(asc(leagueOccurrences.plannedOrdinal));
    expect(correctedOccurrences.map((row) => row.id)).toEqual(beforeOccurrences.map((row) => row.id));
    expect(correctedOccurrences.map((row) => row.localDate)).toEqual(["2033-09-04", "2033-09-11", "2033-09-18", "2033-09-25"]);
    const [splitAfter] = await db.select({ payer: occurrencePaymentResponsibilities.payerBowlerId, lineagePayer: occurrencePaymentResponsibilities.lineagePayerBowlerId, prizePayer: occurrencePaymentResponsibilities.prizePayerBowlerId, amount: occurrencePaymentResponsibilities.amountMinor, lineageAmount: occurrencePaymentResponsibilities.lineageAmountMinor, prizeAmount: occurrencePaymentResponsibilities.prizeFundAmountMinor, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities)
      .where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId), eq(occurrencePaymentResponsibilities.occurrenceId, splitOccurrence.id), eq(occurrencePaymentResponsibilities.state, "active")));
    expect(splitAfter).toMatchObject({ payer: substitute.id, lineagePayer: substitute.id, prizePayer: payerBowlerId, amount: 2_000, lineageAmount: 1_000, prizeAmount: 1_000, state: "active" });

    // The first row is deliberately corrected from a legacy elapsed instant
    // without an accompanying historical revision, so verify the audit chain
    // on an unaffected retained row while asserting the correction above.
    const [finalOccurrence] = await db.select().from(leagueOccurrences)
      .where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId), eq(leagueOccurrences.id, correctedOccurrences[1]?.id ?? "")));
    if (!finalOccurrence) throw new Error("schedule edit final occurrence fixture is missing");
    const revisions = await db.select().from(leagueOccurrenceRevisions)
      .where(and(eq(leagueOccurrenceRevisions.organizationId, organizationId), eq(leagueOccurrenceRevisions.leagueId, leagueId), eq(leagueOccurrenceRevisions.occurrenceId, finalOccurrence.id)))
      .orderBy(asc(leagueOccurrenceRevisions.revisionNumber));
    expect(revisions).toHaveLength(finalOccurrence.currentRevision);
    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]?.beforeSnapshot).toEqual(revisions[index - 1]?.afterSnapshot);
    }
    expect(revisions.at(-1)?.afterSnapshot).toEqual(occurrenceSnapshot(finalOccurrence));
  });

  it("rejects a reserved roster snapshot before changing dates or collection evidence", async () => {
    const [league] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(eq(leagues.id, leagueId));
    if (!league) throw new Error("schedule edit league fixture is missing");
    const [occurrence] = await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(and(eq(leagueOccurrences.leagueId, leagueId), eq(leagueOccurrences.authoritativeLocalDate, "2033-09-04")));
    if (!occurrence) throw new Error("schedule edit occurrence fixture is missing");
    const before = await db.select({ localDate: leagueOccurrences.authoritativeLocalDate, revision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(eq(leagueOccurrences.id, occurrence.id));
    const [obligation] = await db.select({ id: paymentObligations.id }).from(paymentObligations)
      .where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, leagueId), eq(paymentObligations.occurrenceId, occurrence.id)));
    if (!obligation) throw new Error("schedule edit obligation fixture is missing");
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      leagueId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `schedule-edit-reserved-${suffix}`,
      amountMinor: 2_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
      providerIdempotencyKey: `schedule-edit-reserved-${suffix}`.slice(0, 45),
      providerName: "square",
      status: "failed_terminal",
      nextAttemptAt: null,
      completedAt: "2032-09-01T23:00:00.000Z",
      errorClassification: "internal",
      errorCode: "FIXTURE_FAILURE",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotKind: "interactive",
        requestKind: "direct",
        payerBowlerId,
        encryptedSourceId: "fixture-encrypted-source",
        encryptedCustomerId: "fixture-encrypted-customer",
        sourceKind: "saved_card",
        quoteFingerprint: `lvrosterquote:v1:${"c".repeat(64)}`,
        amountMinor: 2_000,
        currency: "USD",
        obligations: [{ obligationId: obligation.id, amountMinor: 2_000 }],
        snapshotFingerprint: `lvstandingcutoff:v1:${"b".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({
        operationId,
        organizationId,
        leagueId,
        obligationId: obligation.id,
        allocationIndex: 0,
        amountMinor: 2_000,
        state: "reserved",
      });
    });
    const error = await editCanonicalLeagueSchedule(editInput(league.canonicalScheduleRevision, "schedule-edit-reserved", {
      competitionStartTime: "21:00",
      doublePayDates: ["2033-09-04"],
    })).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanonicalLeagueScheduleEditError);
    expect((error as CanonicalLeagueScheduleEditError).code).toBe("financial_conflict");
    expect(await db.select({ localDate: leagueOccurrences.authoritativeLocalDate, revision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(eq(leagueOccurrences.id, occurrence.id))).toEqual(before);

    // A group-only double-pay edit must hit the same immutable item fence;
    // operation status alone cannot make a reserved snapshot editable.
    const groupOnlyError = await editCanonicalLeagueSchedule(editInput(league.canonicalScheduleRevision, "schedule-edit-reserved-group-only", {
      doublePayDates: [],
    })).then(() => null, (caught: unknown) => caught);
    expect(groupOnlyError).toBeInstanceOf(CanonicalLeagueScheduleEditError);
    expect((groupOnlyError as CanonicalLeagueScheduleEditError).code).toBe("financial_conflict");
    expect(await db.select({ localDate: leagueOccurrences.authoritativeLocalDate, revision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(eq(leagueOccurrences.id, occurrence.id))).toEqual(before);
  });

  it("propagates unexpected final schedule-read failures without reclassifying them", async () => {
    const [league] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision, doublePayDates: leagues.doublePayDates })
      .from(leagues).where(eq(leagues.id, leagueId));
    if (!league) throw new Error("schedule edit league fixture is missing");
    const scheduleRead = vi.spyOn(leagueOccurrenceSchedule, "loadLeagueOccurrenceScheduleSnapshot")
      .mockRejectedValueOnce(new Error("simulated database detail"));
    try {
      const error = await editCanonicalLeagueSchedule(editInput(league.canonicalScheduleRevision, "schedule-edit-final-read-failure", {
        doublePayDates: league.doublePayDates,
        metadata: { description: "final-read failure rollback" },
      })).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CanonicalLeagueScheduleEditError);
      expect((error as Error).message).toBe("simulated database detail");
    } finally {
      scheduleRead.mockRestore();
    }
  });
});
