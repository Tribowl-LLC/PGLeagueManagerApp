import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  occurrencePaymentResponsibilities,
  paymentAllocationCorrections,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  payments,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import {
  correctHistoricalSquarePaymentAllocation,
  historicalSquareAllocationCorrectionFingerprint,
  historicalSquareAllocationFingerprint,
} from "../../server/services/historical-square-payment-correction";
import { readCanonicalPaymentReport } from "../../server/services/roster-payment-archive-report";
import { prepareRefundPaymentOperation } from "../../server/services/refund-payment-operation-preparation";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `historical-square-correction-${suffix}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let actorUserId: number;
let bowlerId: number;
let teamId: number;
let occurrenceOrdinal = 0;

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  for (const row of leftovers) await deleteOrganization(row.id);
  const [organization] = await db.insert(organizations).values({ name: "Historical Square Test Organization", slug }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ name: "Historical Square Test Location", organizationId }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Historical Square Test League",
    organizationId,
    locationId,
    payingLineupSize: 3,
    paymentMode: "weekly",
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
  leagueId = league.id;
  const [actor] = await db.insert(users).values({
    email: `historical-square-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Historical Square Test Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const [team] = await db.insert(teams).values({ name: "Historical Square Test Team", number: 1, leagueId }).returning({ id: teams.id });
  teamId = team.id;
  const [bowler] = await db.insert(bowlers).values({ name: "Historical Square Test Bowler", email: `historical-square-bowler-${suffix}@example.test`, organizationId }).returning({ id: bowlers.id });
  bowlerId = bowler.id;
  await db.insert(bowlerLeagues).values({ bowlerId, leagueId, teamId });
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

async function createOccurrence() {
  const ordinal = occurrenceOrdinal + 1;
  occurrenceOrdinal = ordinal;
  const commandId = randomUUID();
  const startAt = new Date(Date.UTC(2038, 1, ordinal + 1, 19, 0, 0)).toISOString();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `historical-square-publish-${suffix}-${ordinal}`,
    requestFingerprint: `historical-square-publish-fingerprint-${ordinal}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId,
    generationKey: `historical-square-occurrence-${suffix}-${ordinal}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: startAt.slice(0, 10),
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "historical-square-test",
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
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: ordinal,
    version: 1,
    state: "published",
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.transaction(async (tx) => {
    await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId: occurrence.id, actorUserId });
  });
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.teamId, teamId),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  if (!responsibility) throw new Error("historical Square test responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, organizationId),
    eq(paymentObligations.leagueId, leagueId),
    eq(paymentObligations.responsibilityId, responsibility.id),
  ));
  if (!obligation) throw new Error("historical Square test obligation was not materialized");
  return { responsibility, obligation };
}

describe("historical Square payment allocation correction", () => {
  it("preserves retained allocations, reports confirmed paid, and refunds active replacements", async () => {
    const sourceFixtures = await Promise.all([createOccurrence(), createOccurrence(), createOccurrence()]);
    const targetFixture = await createOccurrence();
    const sourceRows = sourceFixtures.map(({ obligation, responsibility }) => ({ obligation, responsibility }));
    const firstSource = sourceRows[0];
    const secondSource = sourceRows[1];
    const thirdSource = sourceRows[2];
    if (!firstSource || !secondSource || !thirdSource) throw new Error("historical Square test source fixtures are incomplete");
    const operationId = randomUUID();
    const providerPaymentId = `historical-square-provider-${operationId}`;
    const payment = await db.transaction(async (tx) => {
      await tx.insert(paymentOperations).values({
        id: operationId,
        organizationId,
        authorizingUserId: actorUserId,
        operationType: "interactive_charge",
        targetKey: `historical-square-charge:${operationId}`,
        leagueId,
        amountMinor: 6_000,
        currency: "USD",
        requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
        providerIdempotencyKey: `historical-square-${operationId}`.slice(0, 45),
        providerName: "square",
        providerObjectId: providerPaymentId,
        status: "succeeded",
        nextAttemptAt: null,
        completedAt: "2038-02-20T20:00:00.000Z",
      });
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: bowlerId,
        requestKind: "direct",
        encryptedSourceId: "historical-square-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: 6_000,
        currency: "USD",
        obligations: sourceRows.map(({ obligation, responsibility }) => ({ id: obligation.id, responsibilityId: responsibility.id, responsibilityVersion: 1, payerBowlerId: bowlerId, amountMinor: 2_000 })),
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"b".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values(sourceRows.map(({ obligation }, allocationIndex) => ({
        operationId,
        organizationId,
        leagueId,
        obligationId: obligation.id,
        allocationIndex,
        amountMinor: 2_000,
        state: "finalized" as const,
      })));
      const [createdPayment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 6_000,
        currency: "USD",
        status: "paid",
        type: "square",
        providerPaymentId,
        paymentOperationId: operationId,
        idempotencyKey: `${operationId}:payment`,
      }).returning();
      if (!createdPayment) throw new Error("historical Square test payment was not created");
      await tx.insert(paymentAllocations).values(sourceRows.map(({ obligation }) => ({
        organizationId,
        leagueId,
        paymentId: createdPayment.id,
        obligationId: obligation.id,
        amountMinor: 2_000,
        currency: "USD" as const,
        recordedByUserId: actorUserId,
      })));
      await tx.update(paymentObligations).set({ state: "settled" }).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, firstSource.obligation.id),
      ));
      await tx.update(paymentObligations).set({ state: "settled" }).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, secondSource.obligation.id),
      ));
      await tx.update(paymentObligations).set({ state: "settled" }).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, thirdSource.obligation.id),
      ));
      return createdPayment;
    });
    const sourceAllocations = await db.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.paymentId, payment.id),
    ));
    const targetAllocations = [
      { obligationId: firstSource.obligation.id, amountMinor: 2_000 },
      { obligationId: secondSource.obligation.id, amountMinor: 2_000 },
      { obligationId: targetFixture.obligation.id, amountMinor: 2_000 },
    ];
    const expectedOldAllocationFingerprint = historicalSquareAllocationFingerprint(sourceAllocations.map((row) => ({
      allocationId: row.id,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: row.state,
      allocationKind: row.allocationKind,
    })));
    const expectedTargetAllocationFingerprint = historicalSquareAllocationFingerprint(targetAllocations.map((row) => ({
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: "active" as const,
      allocationKind: "ordinary" as const,
    })));
    const requestWithoutFingerprint = {
      paymentId: payment.id,
      expectedOldAllocationFingerprint,
      expectedTargetAllocationFingerprint,
      targetAllocations,
      reason: "historical Square FIFO correction",
      idempotencyKey: `historical-square-correction-${randomUUID()}`,
    };
    const staleRequestWithoutFingerprint = {
      ...requestWithoutFingerprint,
      expectedOldAllocationFingerprint: "stale-source-evidence",
      idempotencyKey: `historical-square-stale-${randomUUID()}`,
    };
    await expect(correctHistoricalSquarePaymentAllocation({
      organizationId,
      leagueId,
      actorUserId,
      allowlist: { organizationId, leagueId, paymentAmountsMinor: { [payment.id]: 6_000 } },
      request: {
        ...staleRequestWithoutFingerprint,
        requestFingerprint: historicalSquareAllocationCorrectionFingerprint({ organizationId, leagueId, request: staleRequestWithoutFingerprint }),
      },
    })).rejects.toMatchObject({ code: "SOURCE_FINGERPRINT_MISMATCH" });
    const validRequest = {
      ...requestWithoutFingerprint,
      requestFingerprint: historicalSquareAllocationCorrectionFingerprint({ organizationId, leagueId, request: requestWithoutFingerprint }),
    };
    const correctionInput = {
      organizationId,
      leagueId,
      actorUserId,
      allowlist: { organizationId, leagueId, paymentAmountsMinor: { [payment.id]: 6_000 } },
      request: validRequest,
    };
    const result = await correctHistoricalSquarePaymentAllocation(correctionInput);
    const replay = await correctHistoricalSquarePaymentAllocation(correctionInput);
    expect(replay).toEqual(result);
    expect(result.sourceAllocations).toHaveLength(1);
    expect(result.replacementAllocations).toHaveLength(1);
    expect(result.corrections).toHaveLength(1);

    const storedAllocations = await db.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.paymentId, payment.id),
    ));
    expect(storedAllocations.filter((row) => row.state === "active")).toHaveLength(3);
    expect(storedAllocations.filter((row) => row.state === "voided")).toHaveLength(1);
    const corrections = await db.select().from(paymentAllocationCorrections).where(eq(paymentAllocationCorrections.paymentId, payment.id));
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.sourceObligationId).toBe(thirdSource.obligation.id);
    expect(corrections[0]?.targetObligationId).toBe(targetFixture.obligation.id);
    const retainedSource = storedAllocations.find((row) => row.obligationId === firstSource.obligation.id);
    const retainedReplacement = storedAllocations.find((row) => row.obligationId === secondSource.obligation.id);
    const movedSource = storedAllocations.find((row) => row.obligationId === thirdSource.obligation.id);
    if (!retainedSource || !retainedReplacement || !movedSource) throw new Error("historical Square test allocation evidence is incomplete");
    await expect(db.insert(paymentAllocationCorrections).values({
      organizationId,
      leagueId,
      paymentId: payment.id,
      sourceAllocationId: retainedSource.id,
      replacementAllocationId: retainedReplacement.id,
      sourceObligationId: retainedSource.obligationId,
      targetObligationId: movedSource.obligationId,
      amountMinor: retainedSource.amountMinor,
      currency: retainedSource.currency,
      reason: "forged active source evidence",
      recordedByUserId: actorUserId,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/historical Square allocation correction evidence does not match its rows/) },
    });

    const report = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: payment.id });
    expect(report.rows[0]).toMatchObject({ status: "confirmed_paid", reviewRequired: false, unresolved: false, allocatedMinor: 6_000 });

    const refund = await prepareRefundPaymentOperation({
      paymentId: payment.id,
      disposition: "still_owed",
      reason: "historical Square correction refund test",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    if (!("allocations" in refund.snapshot)) throw new Error("refund snapshot did not use the canonical allocation contract");
    expect(refund.snapshot.allocations).toHaveLength(3);
    expect(refund.snapshot.allocations.map((row) => row.allocationId).sort()).toEqual(storedAllocations.filter((row) => row.state === "active").map((row) => row.id).sort());
    expect(refund.snapshot.allocations.map((row) => row.allocationId)).not.toContain(result.sourceAllocations[0]?.allocationId);
  });
});
