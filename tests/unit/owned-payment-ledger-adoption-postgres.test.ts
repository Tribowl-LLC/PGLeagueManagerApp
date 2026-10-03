import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bowlers,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocations,
  paymentObligations,
  payments,
  teams,
  users,
  weeklyPaymentAllocationReleases,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentLedgerAdoptionAllocationProofs,
  weeklyPaymentLedgerAdoptionAllocationProofSteps,
  weeklyPaymentFundingAuthorizationItems,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
  paymentAllocationFundingApplications,
} from "@shared/schema";
import { deriveOwnedPaymentAdoptionCutoff, preflightOwnedPaymentLedgerAdoption } from "../../server/services/owned-payment-ledger-adoption";
import { localDateForInstant } from "../../server/services/manage-payments-worksheet-projection";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let actorUserId: number;
let bowlerId: number;
let teamId: number;
let generationRunId: string;
let occurrenceIds: string[] = [];

async function createPublishedOccurrence(ordinal: number, localDate: string) {
  const commandId = randomUUID();
  const startAt = `${localDate}T19:00:00.000Z`;
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `owned-adoption-publish-${suffix}-${ordinal}`,
    requestFingerprint: `owned-adoption-publish-fingerprint-${ordinal}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId,
    generationRunId,
    generationKey: `owned-adoption-occurrence-${suffix}-${ordinal}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: localDate,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "owned-adoption-test",
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
  return occurrence.id;
}

async function createPayerObligation(occurrenceId: string, localDate: string) {
  const at = `${localDate}T19:00:00.000Z`;
  const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId,
    leagueId,
    occurrenceId,
    teamId,
    responsibilityKind: "worksheet",
    worksheetFeeComponent: "full",
    payerBowlerId: bowlerId,
    amountMinor: 1_000,
    currency: "USD",
    dueAt: at,
    pastDueAt: at,
    recordedByUserId: actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id });
  const [obligation] = await db.insert(paymentObligations).values({
    organizationId,
    leagueId,
    occurrenceId,
    responsibilityId: responsibility.id,
    component: "full",
    payerBowlerId: bowlerId,
    amountMinor: 1_000,
    currency: "USD",
    dueAt: at,
    pastDueAt: at,
    state: "open",
    createdByUserId: actorUserId,
  }).returning({ id: paymentObligations.id });
  return obligation.id;
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: "Owned Payment Adoption Fixture",
    slug: `owned-payment-adoption-${suffix}`,
  }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "Adoption Fixture Location" })
    .returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Owned Payment Adoption Fixture",
    organizationId,
    locationId,
    payingLineupSize: 3,
    weeklyFee: 10,
    seasonStart: "2038-02-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [actor] = await db.insert(users).values({
    email: `owned-adoption-${suffix}@example.test`,
    password: "fixture-password-hash",
    name: "Adoption Fixture Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const generationCommandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: generationCommandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "generate",
    idempotencyKey: `owned-adoption-generation-${suffix}`,
    requestFingerprint: `owned-adoption-generation-fingerprint-${suffix}`,
  });
  generationRunId = randomUUID();
  await db.insert(leagueOccurrenceGenerationRuns).values({
    id: generationRunId,
    organizationId,
    leagueId,
    originatingCommandId: generationCommandId,
    generatorVersion: "owned-adoption-legacy-test-v1",
    inputFingerprint: `owned-adoption-legacy-input-${suffix}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { fixtureKind: "legacy_published_schedule" },
    rangeStartDate: "2038-02-01",
    rangeEndDate: "2038-02-08",
    candidateOccurrenceCount: 2,
    generatedOccurrenceCount: 2,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: "2038-01-01T00:00:00.000Z",
    approvedByUserId: actorUserId,
    approvalCommandId: generationCommandId,
  });
  const [bowler] = await db.insert(bowlers).values({ organizationId, name: "Adoption Fixture Bowler" })
    .returning({ id: bowlers.id });
  bowlerId = bowler.id;
  const [team] = await db.insert(teams).values({ name: "Adoption Fixture Team", number: 1, leagueId })
    .returning({ id: teams.id });
  teamId = team.id;
  occurrenceIds = [await createPublishedOccurrence(1, "2038-02-01"), await createPublishedOccurrence(2, "2038-02-08")];

  const firstOccurrenceId = occurrenceIds[0];
  const secondOccurrenceId = occurrenceIds[1];
  if (!firstOccurrenceId || !secondOccurrenceId) throw new Error("adoption fixture schedule is incomplete");
  const obligationIds = [
    await createPayerObligation(firstOccurrenceId, "2038-02-01"),
    await createPayerObligation(secondOccurrenceId, "2038-02-08"),
  ];
  await db.transaction(async (tx) => {
    const [payment] = await tx.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId,
      amount: 1_200,
      currency: "USD",
      status: "paid",
      type: "cash",
      createdAt: "2038-02-04T16:30:00.000Z",
    }).returning({ id: payments.id });
    if (!payment) throw new Error("adoption fixture payment was not created");
    await tx.insert(paymentAllocations).values(obligationIds.map((obligationId, index) => ({
      organizationId,
      leagueId,
      paymentId: payment.id,
      obligationId,
      amountMinor: index === 0 ? 900 : 300,
      currency: "USD" as const,
      state: "active" as const,
      allocationKind: "ordinary" as const,
      recordedByUserId: actorUserId,
    })));
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId).catch(() => undefined);
});

describe("owned payment ledger adoption preflight", () => {
  it("uses the previous day before the latest actual local week and the pre-season boundary", () => {
    expect(deriveOwnedPaymentAdoptionCutoff(["2026-10-02", "2026-10-03", "2026-10-10"], "2026-10-03"))
      .toBe("2026-10-02");
    expect(deriveOwnedPaymentAdoptionCutoff(["2026-10-04", "2026-10-11"], "2026-10-03"))
      .toBe("2026-10-03");
    expect(localDateForInstant("2026-10-04T06:30:00.000Z", "America/Los_Angeles"))
      .toBe("2026-10-03");
  });

  it("plans exact manual sources, honors explicit confirmation, and releases future allocations without writing", async () => {
    const firstOccurrenceId = occurrenceIds[0];
    if (!firstOccurrenceId) throw new Error("adoption fixture schedule did not create its first occurrence");
    await db.insert(weeklyPaymentWeekConfirmations).values({
      organizationId,
      leagueId,
      occurrenceId: firstOccurrenceId,
      revision: 1,
      stateFingerprint: `lvmanagepayments:v1:${"1".repeat(64)}`,
      requestFingerprint: `lvmanagepaymentsrequest:v1:${"2".repeat(64)}`,
      responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${"3".repeat(64)}`,
      idempotencyKey: `owned-adoption-confirm-${suffix}`,
      requestSnapshot: { fixture: true },
      recordedByUserId: actorUserId,
    });
    const before = await Promise.all([
      db.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundingAuthorizationItems.id }).from(weeklyPaymentFundingAuthorizationItems).where(eq(weeklyPaymentFundingAuthorizationItems.leagueId, leagueId)),
      db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofs.id }).from(weeklyPaymentLedgerAdoptionAllocationProofs).where(eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofSteps.id }).from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, leagueId)),
      db.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(eq(weeklyPaymentAllocationReleases.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceipts.id }).from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceiptRevisions.id }).from(weeklyPaymentWorksheetReceiptRevisions).where(eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWeekConfirmations.id }).from(weeklyPaymentWeekConfirmations).where(eq(weeklyPaymentWeekConfirmations.leagueId, leagueId)),
    ]);

    const first = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId }, db);
    const replay = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId }, db);
    expect(first.ready).toBe(true);
    expect(first.adoptedThroughLocalDate).toBe("2038-01-31");
    expect(first.counts).toEqual({
      paidPayments: 1,
      genericFundingPortions: 1,
      retainedAllocations: 1,
      genericAllocationReleases: 1,
      rotatingAllocationReleases: 0,
      grandfatheredAllocations: 0,
      manualReceipts: 1,
      preservedVoidedPayments: 0,
    });
    expect(first.resultFingerprint).toMatch(/^lvweeklyadopt:v1:[0-9a-f]{64}$/);
    expect(first.sourceFingerprint).toMatch(/^lvweeklyadoptpre:v1:[0-9a-f]{64}$/);
    expect(first.blockers).toEqual([]);
    expect(replay.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(replay.resultFingerprint).toBe(first.resultFingerprint);
    const after = await Promise.all([
      db.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundingAuthorizationItems.id }).from(weeklyPaymentFundingAuthorizationItems).where(eq(weeklyPaymentFundingAuthorizationItems.leagueId, leagueId)),
      db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofs.id }).from(weeklyPaymentLedgerAdoptionAllocationProofs).where(eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofSteps.id }).from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, leagueId)),
      db.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(eq(weeklyPaymentAllocationReleases.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceipts.id }).from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceiptRevisions.id }).from(weeklyPaymentWorksheetReceiptRevisions).where(eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWeekConfirmations.id }).from(weeklyPaymentWeekConfirmations).where(eq(weeklyPaymentWeekConfirmations.leagueId, leagueId)),
    ]);
    expect(after).toEqual(before);
  });

  it("counts retained manual cross-owner allocations as blockers without guessing authorization", async () => {
    const firstOccurrenceId = occurrenceIds[0];
    if (!firstOccurrenceId) throw new Error("adoption fixture schedule did not create its first occurrence");
    const [otherOwner] = await db.insert(bowlers).values({ organizationId, name: "Adoption Fixture Other Owner" })
      .returning({ id: bowlers.id });
    if (!otherOwner) throw new Error("manual cross-owner fixture owner was not created");
    const dueAt = "2038-02-01T19:00:00.000Z";
    const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
      organizationId,
      leagueId,
      occurrenceId: firstOccurrenceId,
      teamId,
      responsibilityKind: "worksheet",
      worksheetFeeComponent: "full",
      payerBowlerId: otherOwner.id,
      amountMinor: 500,
      currency: "USD",
      dueAt,
      pastDueAt: dueAt,
      recordedByUserId: actorUserId,
    }).returning({ id: occurrencePaymentResponsibilities.id });
    const [obligation] = await db.insert(paymentObligations).values({
      organizationId,
      leagueId,
      occurrenceId: firstOccurrenceId,
      responsibilityId: responsibility.id,
      component: "full",
      payerBowlerId: otherOwner.id,
      amountMinor: 500,
      currency: "USD",
      dueAt,
      pastDueAt: dueAt,
      state: "open",
      createdByUserId: actorUserId,
    }).returning({ id: paymentObligations.id });
    const [allocation] = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        leagueId,
        bowlerId,
        amount: 500,
        currency: "USD",
        status: "paid",
        type: "cash",
        createdAt: dueAt,
      }).returning({ id: payments.id });
      return tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId: obligation.id,
        amountMinor: 500,
        currency: "USD",
        state: "active",
        allocationKind: "ordinary",
        recordedByUserId: actorUserId,
      }).returning({ id: paymentAllocations.id });
    });
    if (!allocation) throw new Error("manual cross-owner fixture allocation is missing");

    const preflight = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId }, db);
    const blocker = preflight.blockers.find((row) => row.code === "CROSS_OWNER_ALLOCATION_AUTHORIZATION_UNPROVEN");
    expect(preflight.ready).toBe(false);
    expect(blocker).toEqual({
      code: "CROSS_OWNER_ALLOCATION_AUTHORIZATION_UNPROVEN",
      count: 1,
      entityIds: [allocation.id],
    });
  });
});
