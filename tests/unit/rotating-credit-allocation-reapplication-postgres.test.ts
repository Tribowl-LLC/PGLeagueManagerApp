import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  payments,
  rotatingCreditApplications,
  rotatingCreditFundings,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  paymentAllocationFundingApplications,
  weeklyPaymentWeekConfirmations,
  rotatingOccurrenceAssignments,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { buildCanonicalScheduleCommandFingerprint, rescheduleOccurrence } from "../../server/services/canonical-occurrence-transactions";
import {
  canonicalRotatingAssignmentFingerprint,
  canonicalRotatingRosterFingerprint,
  saveRotatingOccurrenceAssignments,
  saveTeamRoster,
} from "../../server/services/roster-payment-core";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { readCanonicalPaymentReport } from "../../server/services/canonical-payment-report";
import { prepareRefundPaymentOperation } from "../../server/services/refund-payment-operation-preparation";
import { quoteRotatingCreditManualFunding, recordRotatingCreditManualFunding } from "../../server/services/rotating-credit";
import { prepareRotatingCreditPaymentOperation } from "../../server/services/rotating-credit-operation-preparation";
import { finalizeRosterSnapshotInTransaction } from "../../server/services/roster-payment-finalizer";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import {
  acquirePaymentOperationLease,
  finalizeRefundPaymentOperationSuccess,
} from "../../server/storage/payment-operations";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const operationNow = new Date("2038-02-01T20:00:00.000Z");

let organizationId: number;
let locationId: number;
let leagueId: number;
let teamId: number;
let actorUserId: number;
let bowlerId: number;
let replacementMainId: number;
let correctionBowlerId: number;

async function createOccurrence(
  ordinal: number,
  amountMinor = 1_000,
  scope: { leagueId?: number; teamId?: number } = {},
) {
  const targetLeagueId = scope.leagueId ?? leagueId;
  const targetTeamId = scope.teamId ?? teamId;
  const commandId = randomUUID();
  const startAt = new Date(Date.UTC(2038, 1, ordinal * 7 + 1, 19, 0, 0)).toISOString();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId: targetLeagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `credit-reapply-publish-${suffix}-${ordinal}-${randomUUID()}`,
    requestFingerprint: `credit-reapply-publish-fingerprint-${ordinal}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId: targetLeagueId,
    locationId,
    generationKey: `credit-reapply-occurrence-${suffix}-${ordinal}-${randomUUID()}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: startAt.slice(0, 10),
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "credit-reapplication-test",
    plannedOrdinal: ordinal,
    competitionNumber: ordinal,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id, authoritativeLocalDate: leagueOccurrences.authoritativeLocalDate });
  await db.insert(leagueOccurrenceBillingTerms).values({
    organizationId,
    leagueId: targetLeagueId,
    occurrenceId: occurrence.id,
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: amountMinor,
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
    leagueId: targetLeagueId,
    occurrenceId: occurrence.id,
    actorUserId,
  }));
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, targetLeagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.teamId, targetTeamId),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  if (!responsibility) throw new Error("credit reapplication responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, organizationId),
    eq(paymentObligations.leagueId, targetLeagueId),
    eq(paymentObligations.responsibilityId, responsibility.id),
  ));
  if (!obligation) throw new Error("credit reapplication obligation was not materialized");
  return { occurrence, responsibility, obligation };
}

async function createPartialProviderTender(
  obligation: Awaited<ReturnType<typeof createOccurrence>>["obligation"],
  amountMinor = 600,
) {
  const operationId = randomUUID();
  const providerPaymentId = `credit-reapply-charge-${operationId}`;
  const fingerprint = operationId.replaceAll("-", "").padEnd(64, "0");
  return db.transaction(async (tx) => {
    await tx.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:roster-finalizer:${operationId}`,
      leagueId,
      amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${fingerprint}`,
      providerIdempotencyKey: `credit-reapply-charge-${operationId}`.slice(0, 45),
      providerName: "square",
      providerObjectId: providerPaymentId,
      status: "succeeded",
      nextAttemptAt: null,
      completedAt: operationNow.toISOString(),
      createdAt: operationNow.toISOString(),
      updatedAt: operationNow.toISOString(),
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
      encryptedSourceId: "credit-reapplication-test-source",
      sourceKind: "new_card",
      quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
      amountMinor,
      currency: "USD",
      obligations: [{
        id: obligation.id,
        responsibilityId: obligation.responsibilityId,
        responsibilityVersion: 1,
        payerBowlerId: bowlerId,
        amountMinor,
      }],
      lineItems: [],
      snapshotFingerprint: `lvrosterexec:v1:${"b".repeat(64)}`,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values({
      operationId,
      organizationId,
      leagueId,
      obligationId: obligation.id,
      allocationIndex: 0,
      amountMinor,
      state: "finalized",
    });
    const [payment] = await tx.insert(payments).values({
      organizationId,
      bowlerId,
      leagueId,
      amount: amountMinor,
      currency: "USD",
      status: "paid",
      type: "square",
      providerPaymentId,
      paymentOperationId: operationId,
      idempotencyKey: `${operationId}:0`,
      createdAt: operationNow.toISOString(),
    }).returning({ id: payments.id });
    if (!payment) throw new Error("partial ordinary tender was not created");
    await tx.insert(paymentAllocations).values({
      organizationId,
      leagueId,
      paymentId: payment.id,
      obligationId: obligation.id,
      amountMinor,
      currency: "USD",
      recordedByUserId: actorUserId,
    });
    await tx.update(paymentObligations).set({ state: "partially_settled" }).where(eq(paymentObligations.id, obligation.id));
    return { paymentId: payment.id, operationId };
  });
}

async function createCashCreditFunding(amountMinor: number) {
  const idempotencyKey = `credit-reapplication-${randomUUID()}`;
  return db.transaction(async (tx) => {
    const [payment] = await tx.insert(payments).values({
      organizationId,
      bowlerId,
      leagueId,
      amount: amountMinor,
      currency: "USD",
      status: "paid",
      type: "cash",
      createdAt: operationNow.toISOString(),
    }).returning({ id: payments.id });
    if (!payment) throw new Error("prepaid credit tender was not created");
    await tx.insert(rotatingCreditFundings).values({
      organizationId,
      leagueId,
      bowlerId,
      paymentId: payment.id,
      amountMinor,
      currency: "USD",
      fundingKind: "cash",
      idempotencyKey,
      requestFingerprint: `lvrotcrreq:v1:${"c".repeat(64)}`,
      quoteFingerprint: `lvrotcrquote:v1:${"d".repeat(64)}`,
      actorUserId,
      createdAt: operationNow.toISOString(),
    });
    return payment;
  });
}

async function convertTeamToRotating() {
  const request = {
    commandKey: `credit-reapplication-roster-${randomUUID()}`,
    requestFingerprint: "",
    lineupSize: 3 as const,
    slots: [
      { slotIndex: 0, occupant: "rotating" as const, mainBowlerId: null },
      { slotIndex: 1, occupant: "main" as const, mainBowlerId: replacementMainId },
      { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
    ],
    eligibleRotatingBowlerIds: [bowlerId, correctionBowlerId],
  };
  request.requestFingerprint = canonicalRotatingRosterFingerprint(request);
  await saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request });
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: `Credit Reapplication Organization ${suffix}`,
    slug: `credit-reapplication-${suffix}-${randomUUID().slice(0, 8)}`,
  }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({
    organizationId,
    name: `Credit Reapplication Location ${suffix}`,
  }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    organizationId,
    locationId,
    name: `Credit Reapplication League ${suffix}`,
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    weeklyFee: 1_000,
    payingLineupSize: 3,
    paymentMode: "weekly",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [team] = await db.insert(teams).values({ name: "Credit Reapplication Team", number: 1, leagueId }).returning({ id: teams.id });
  teamId = team.id;
  const [actor] = await db.insert(users).values({
    email: `credit-reapplication-admin-${suffix}-${randomUUID()}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Credit Reapplication Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const bowlersCreated = await db.insert(bowlers).values([
    { name: "Rotating Member A", organizationId },
    { name: "Replacement Main", organizationId },
    { name: "Corrected Rotating Member", organizationId },
  ]).returning({ id: bowlers.id });
  const first = bowlersCreated[0];
  const main = bowlersCreated[1];
  const correction = bowlersCreated[2];
  if (!first || !main || !correction) throw new Error("rotating credit reapplication bowlers were not created");
  bowlerId = first.id;
  replacementMainId = main.id;
  correctionBowlerId = correction.id;
  await db.insert(bowlerLeagues).values(bowlersCreated.map((bowler) => ({ bowlerId: bowler.id, leagueId, teamId })));
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
  await convertTeamToRotating();
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

describe("rotating credit allocation reapplication on PostgreSQL", () => {
  it("reschedules an untouched future rotating date while keeping assigned dates locked", async () => {
    const makeRescheduleRequest = (occurrenceId: string, idempotencyKey: string, date: string) => {
      const request = {
        organizationId,
        leagueId,
        actorUserId,
        commandType: "reschedule" as const,
        occurrenceId,
        now: "2038-01-01T00:00:00.000Z",
        authoritativeLocalDate: date,
        authoritativeLocalStartTime: "19:00",
        timezone: "UTC",
        ambiguousFold: "reject" as const,
        idempotencyKey,
        requestFingerprint: "",
        reason: "Move an untouched future rotating date",
      };
      request.requestFingerprint = buildCanonicalScheduleCommandFingerprint(request);
      return request;
    };

    const untouched = await createOccurrence(7);
    const moved = await rescheduleOccurrence(makeRescheduleRequest(
      untouched.occurrence.id,
      `credit-reapplication-reschedule-untouched-${randomUUID()}`,
      "2038-04-05",
    ));
    expect(moved).toMatchObject({ id: untouched.occurrence.id, authoritativeLocalDate: "2038-04-05" });
    const movedResponsibilities = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state, dueAt: occurrencePaymentResponsibilities.dueAt }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, untouched.occurrence.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    )).orderBy(occurrencePaymentResponsibilities.version);
    expect(movedResponsibilities.map((row) => row.state)).toEqual(["voided", "active"]);
    expect(movedResponsibilities.at(-1)).toMatchObject({ version: 2, state: "active" });
    expect(new Date(movedResponsibilities.at(-1)?.dueAt ?? "").toISOString()).toBe(new Date(moved.startAt).toISOString());
    const movedObligations = await db.select({ state: paymentObligations.state, dueAt: paymentObligations.dueAt, responsibilityId: paymentObligations.responsibilityId }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      inArray(paymentObligations.responsibilityId, movedResponsibilities.map((row) => row.id)),
    )).orderBy(paymentObligations.createdAt);
    expect(movedObligations.map((row) => row.state)).toEqual(["voided", "open"]);
    expect(new Date(movedObligations.at(-1)?.dueAt ?? "").toISOString()).toBe(new Date(moved.startAt).toISOString());

    const assigned = await createOccurrence(8);
    const assignmentRequest = {
      commandKey: `credit-reapplication-reschedule-assignment-${randomUUID()}`,
      requestFingerprint: "",
      assignments: [{
        occurrenceId: assigned.occurrence.id,
        teamId,
        slotIndex: 0,
        expectedRevision: null,
        actualBowlerId: bowlerId,
      }],
    };
    assignmentRequest.requestFingerprint = canonicalRotatingAssignmentFingerprint(assignmentRequest);
    await saveRotatingOccurrenceAssignments({ organizationId, leagueId, actorUserId, request: assignmentRequest });
    const [assignedBeforeReschedule] = await db.select({ authoritativeLocalDate: leagueOccurrences.authoritativeLocalDate }).from(leagueOccurrences).where(eq(leagueOccurrences.id, assigned.occurrence.id));
    if (!assignedBeforeReschedule) throw new Error("assigned schedule snapshot is missing");
    const assignmentResponsibilitiesBeforeNoOp = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, assigned.occurrence.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    )).orderBy(occurrencePaymentResponsibilities.version);
    const noOpReschedule = await rescheduleOccurrence(makeRescheduleRequest(
      assigned.occurrence.id,
      `credit-reapplication-reschedule-noop-${randomUUID()}`,
      assignedBeforeReschedule.authoritativeLocalDate,
    ));
    expect(noOpReschedule.authoritativeLocalDate).toBe(assignedBeforeReschedule.authoritativeLocalDate);
    const assignmentResponsibilitiesAfterNoOp = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, assigned.occurrence.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    )).orderBy(occurrencePaymentResponsibilities.version);
    expect(assignmentResponsibilitiesAfterNoOp).toEqual(assignmentResponsibilitiesBeforeNoOp);
    await expect(rescheduleOccurrence(makeRescheduleRequest(
      assigned.occurrence.id,
      `credit-reapplication-reschedule-assigned-${randomUUID()}`,
      "2038-04-12",
    ))).rejects.toThrow("ROTATING_SCHEDULE_EVIDENCE_LOCKED");
    const [unchangedOccurrence] = await db.select({ authoritativeLocalDate: leagueOccurrences.authoritativeLocalDate }).from(leagueOccurrences).where(eq(leagueOccurrences.id, assigned.occurrence.id));
    expect(unchangedOccurrence?.authoritativeLocalDate).toBe(assignedBeforeReschedule?.authoritativeLocalDate);
  });

  it("sweeps a partially refunded, corrected lot back to the earlier obligation with multiple active credit children", async () => {
    const earlier = await createOccurrence(1);
    const later = await createOccurrence(2, 600);
    const ordinaryTender = await createPartialProviderTender(earlier.obligation);

    const creditPayment = await createCashCreditFunding(1_000);

    const firstAssignmentRequest = {
      commandKey: `credit-reapplication-assign-${randomUUID()}`,
      requestFingerprint: "",
      assignments: [earlier, later].map(({ occurrence }) => ({
        occurrenceId: occurrence.id,
        teamId,
        slotIndex: 0,
        expectedRevision: null,
        actualBowlerId: bowlerId,
      })),
    };
    firstAssignmentRequest.requestFingerprint = canonicalRotatingAssignmentFingerprint(firstAssignmentRequest);
    await saveRotatingOccurrenceAssignments({ organizationId, leagueId, actorUserId, request: firstAssignmentRequest });

    const initialCreditRows = await db.select({
      allocationId: paymentAllocations.id,
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
      allocationKind: paymentAllocations.allocationKind,
      state: paymentAllocations.state,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.paymentId, creditPayment.id),
    ));
    expect(initialCreditRows.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([400, 600]);
    expect(initialCreditRows.every((row) => row.allocationKind === "rotating_credit" && row.state === "active")).toBe(true);
    const initialReport = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: creditPayment.id, page: 1, limit: 1 });
    expect(initialReport.rows[0]?.source).toBe("canonical_allocation");

    await expect(db.transaction(async (tx) => tx.update(paymentObligations).set({ state: "open" }).where(eq(paymentObligations.id, earlier.obligation.id))))
      .rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringContaining("roster payment evidence is append-only") }),
      });

    const unpairedCreditAllocation = db.transaction(async (tx) => tx.insert(paymentAllocations).values({
      organizationId,
      leagueId,
      paymentId: creditPayment.id,
      obligationId: later.obligation.id,
      amountMinor: 1,
      currency: "USD",
      allocationKind: "rotating_credit",
      recordedByUserId: actorUserId,
    }));
    await expect(unpairedCreditAllocation).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("rotating credit allocation must use its discriminator and have one exact immutable application"),
      }),
    });
    const laterCreditAllocation = initialCreditRows.find((row) => row.obligationId === later.obligation.id);
    if (!laterCreditAllocation) throw new Error("later credit allocation was not created");
    await expect(db.transaction(async (tx) => tx.update(paymentAllocations).set({ allocationKind: "ordinary" }).where(eq(paymentAllocations.id, laterCreditAllocation.allocationId))))
      .rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining("rotating credit allocation must use its discriminator and have one exact immutable application"),
        }),
      });

    const preparedRefund = await prepareRefundPaymentOperation({
      paymentId: ordinaryTender.paymentId,
      disposition: "still_owed",
      reason: "partial tender refund that remains owed",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
      now: operationNow,
    });
    const leasedRefund = await acquirePaymentOperationLease({
      organizationId,
      operationId: preparedRefund.operation.id,
      leaseOwner: `credit-reapplication-refund-${randomUUID()}`,
      leaseDurationMs: 60_000,
      now: operationNow,
    });
    if (!leasedRefund?.leaseToken) throw new Error("ordinary partial refund lease was not acquired");
    await finalizeRefundPaymentOperationSuccess({
      organizationId,
      operationId: preparedRefund.operation.id,
      leaseToken: leasedRefund.leaseToken,
      providerObjectId: `square-credit-reapplication-refund-${randomUUID()}`,
      now: operationNow,
    });

    const correctionRequest = {
      commandKey: `credit-reapplication-correction-${randomUUID()}`,
      requestFingerprint: "",
      assignments: [{
        occurrenceId: later.occurrence.id,
        teamId,
        slotIndex: 0,
        expectedRevision: 1,
        actualBowlerId: correctionBowlerId,
        correctionReason: "corrected the second date's participant",
      }],
    };
    correctionRequest.requestFingerprint = canonicalRotatingAssignmentFingerprint(correctionRequest);
    await saveRotatingOccurrenceAssignments({ organizationId, leagueId, actorUserId, request: correctionRequest });

    const currentRows = await db.select({
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
      allocationKind: paymentAllocations.allocationKind,
      state: paymentAllocations.state,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.paymentId, creditPayment.id),
    ));
    const earlierCreditRows = currentRows.filter((row) => row.obligationId === earlier.obligation.id && row.state === "active");
    const laterCreditRows = currentRows.filter((row) => row.obligationId === later.obligation.id && row.state === "active");
    expect(earlierCreditRows.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([400, 600]);
    expect(earlierCreditRows.every((row) => row.allocationKind === "rotating_credit")).toBe(true);
    expect(laterCreditRows).toHaveLength(0);
    expect(currentRows.filter((row) => row.obligationId === later.obligation.id && row.state === "voided")).toHaveLength(1);
    const creditApplications = await db.select({
      id: rotatingCreditApplications.id,
      amountMinor: rotatingCreditApplications.amountMinor,
    }).from(rotatingCreditApplications).where(and(
      eq(rotatingCreditApplications.organizationId, organizationId),
      eq(rotatingCreditApplications.leagueId, leagueId),
      eq(rotatingCreditApplications.paymentId, creditPayment.id),
    ));
    expect(creditApplications.map((application) => application.amountMinor).sort((a, b) => a - b)).toEqual([400, 600, 600]);
    const assignment = await db.select({ actualBowlerId: rotatingOccurrenceAssignments.actualBowlerId }).from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, leagueId),
      eq(rotatingOccurrenceAssignments.occurrenceId, later.occurrence.id),
      eq(rotatingOccurrenceAssignments.teamId, teamId),
      eq(rotatingOccurrenceAssignments.slotIndex, 0),
      eq(rotatingOccurrenceAssignments.version, 2),
    ));
    expect(assignment[0]?.actualBowlerId).toBe(correctionBowlerId);
    const finalReport = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: creditPayment.id, page: 1, limit: 1 });
    expect(finalReport.rows[0]).toMatchObject({ source: "canonical_allocation", allocatedMinor: 1_000, unresolved: false });

    const [unrelatedMain] = await db.insert(bowlers).values({ name: `Unrelated roster edit Main ${randomUUID()}`, organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: unrelatedMain.id, leagueId, teamId });
    const unrelatedRosterRequest = {
      commandKey: `credit-reapplication-unrelated-roster-edit-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      slots: [
        { slotIndex: 0, occupant: "rotating" as const, mainBowlerId: null },
        { slotIndex: 1, occupant: "main" as const, mainBowlerId: unrelatedMain.id },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
      eligibleRotatingBowlerIds: [bowlerId, correctionBowlerId],
    };
    unrelatedRosterRequest.requestFingerprint = canonicalRotatingRosterFingerprint(unrelatedRosterRequest);
    await expect(saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request: unrelatedRosterRequest })).resolves.toBeDefined();

    // The old settled -> open refund policy is intentionally broad, so test
    // stale reversal rejection from the partial -> open edge instead. This
    // obligation has no refund adjustment or cash-void evidence to satisfy a
    // legacy reopening branch.
    await db.update(paymentObligations).set({ state: "partially_settled" }).where(eq(paymentObligations.id, later.obligation.id));
    await expect(db.transaction(async (tx) => tx.update(paymentObligations).set({ state: "open" }).where(eq(paymentObligations.id, later.obligation.id))))
      .rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringContaining("roster payment evidence is append-only") }),
      });
  });

  it("keeps a waived refund while correcting and reopening the obligation", async () => {
    const occurrence = await createOccurrence(3, 100);
    const ordinaryTender = await createPartialProviderTender(occurrence.obligation, 40);
    const creditPayment = await createCashCreditFunding(60);

    const initialAssignment = {
      commandKey: `credit-waived-reopen-assignment-${randomUUID()}`,
      requestFingerprint: "",
      assignments: [{
        occurrenceId: occurrence.occurrence.id,
        teamId,
        slotIndex: 0,
        expectedRevision: null,
        actualBowlerId: bowlerId,
      }],
    };
    initialAssignment.requestFingerprint = canonicalRotatingAssignmentFingerprint(initialAssignment);
    await saveRotatingOccurrenceAssignments({ organizationId, leagueId, actorUserId, request: initialAssignment });

    const [initialCreditAllocation] = await db.select({
      id: paymentAllocations.id,
      state: paymentAllocations.state,
      amountMinor: paymentAllocations.amountMinor,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.paymentId, creditPayment.id),
    ));
    expect(initialCreditAllocation).toMatchObject({ state: "active", amountMinor: 60 });

    const preparedRefund = await prepareRefundPaymentOperation({
      paymentId: ordinaryTender.paymentId,
      disposition: "waived",
      reason: "waive the returned ordinary tender",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
      now: operationNow,
    });
    const leasedRefund = await acquirePaymentOperationLease({
      organizationId,
      operationId: preparedRefund.operation.id,
      leaseOwner: `credit-waived-refund-${randomUUID()}`,
      leaseDurationMs: 60_000,
      now: operationNow,
    });
    if (!leasedRefund?.leaseToken) throw new Error("waived ordinary refund lease was not acquired");
    await finalizeRefundPaymentOperationSuccess({
      organizationId,
      operationId: preparedRefund.operation.id,
      leaseToken: leasedRefund.leaseToken,
      providerObjectId: `square-credit-waived-refund-${randomUUID()}`,
      now: operationNow,
    });
    const correction = {
      commandKey: `credit-waived-reopen-correction-${randomUUID()}`,
      requestFingerprint: "",
      assignments: [{
        occurrenceId: occurrence.occurrence.id,
        teamId,
        slotIndex: 0,
        expectedRevision: 1,
        actualBowlerId: correctionBowlerId,
        correctionReason: "corrected a waived-refund date",
      }],
    };
    correction.requestFingerprint = canonicalRotatingAssignmentFingerprint(correction);
    await saveRotatingOccurrenceAssignments({ organizationId, leagueId, actorUserId, request: correction });

    const [reopened] = await db.select({ state: paymentObligations.state }).from(paymentObligations)
      .where(eq(paymentObligations.id, occurrence.obligation.id));
    expect(reopened?.state).toBe("open");
    const [reversedAllocation] = await db.select({ state: paymentAllocations.state }).from(paymentAllocations)
      .where(eq(paymentAllocations.id, initialCreditAllocation.id));
    expect(reversedAllocation?.state).toBe("voided");
  });

  it("applies an adopted manual rotating top-up through owned FIFO without duplicating its source lot", async () => {
    const [adoptedLeague] = await db.insert(leagues).values({
      organizationId,
      locationId,
      name: `Credit Adoption FIFO League ${randomUUID()}`,
      seasonStart: "2038-01-01T00:00:00.000Z",
      seasonEnd: "2038-12-31T23:59:59.000Z",
      weekDay: "Monday",
      weeklyFee: 1_000,
      payingLineupSize: 3,
      paymentMode: "weekly",
      substitutePaymentRegime: "team_choice",
      timezone: "UTC",
    }).returning({ id: leagues.id });
    const [adoptedTeam] = await db.insert(teams).values({
      name: "Credit Adoption FIFO Team",
      number: 1,
      leagueId: adoptedLeague.id,
    }).returning({ id: teams.id });
    const [member] = await db.insert(bowlers).values({
      name: "Credit Adoption FIFO Member",
      organizationId,
    }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: member.id, leagueId: adoptedLeague.id, teamId: adoptedTeam.id });
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId: adoptedLeague.id, teamId: adoptedTeam.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: member.id, recordedByUserId: actorUserId },
      { organizationId, leagueId: adoptedLeague.id, teamId: adoptedTeam.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId: adoptedLeague.id, teamId: adoptedTeam.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    ]);
    const rosterRequest = {
      commandKey: `credit-adoption-rotation-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      slots: [
        { slotIndex: 0, occupant: "rotating" as const, mainBowlerId: null },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
      eligibleRotatingBowlerIds: [member.id],
    };
    rosterRequest.requestFingerprint = canonicalRotatingRosterFingerprint(rosterRequest);
    await saveTeamRoster({ organizationId, leagueId: adoptedLeague.id, teamId: adoptedTeam.id, actorUserId, request: rosterRequest });

    const confirmed = await createOccurrence(1, 1_000, { leagueId: adoptedLeague.id, teamId: adoptedTeam.id });
    const forecast = await createOccurrence(30, 1_000, { leagueId: adoptedLeague.id, teamId: adoptedTeam.id });
    const assignmentRequest = {
      commandKey: `credit-adoption-assignment-${randomUUID()}`,
      requestFingerprint: "",
      assignments: [confirmed, forecast].map(({ occurrence }) => ({
        occurrenceId: occurrence.id,
        teamId: adoptedTeam.id,
        slotIndex: 0,
        expectedRevision: null,
        actualBowlerId: member.id,
      })),
    };
    assignmentRequest.requestFingerprint = canonicalRotatingAssignmentFingerprint(assignmentRequest);
    await saveRotatingOccurrenceAssignments({ organizationId, leagueId: adoptedLeague.id, actorUserId, request: assignmentRequest });

    const preflight = randomUUID().replaceAll("-", "").repeat(2);
    const resultFingerprint = randomUUID().replaceAll("-", "").repeat(2);
    await db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, adoptedLeague.id);
      await tx.insert(weeklyPaymentLedgerAdoptions).values({
        organizationId,
        leagueId: adoptedLeague.id,
        adoptedThroughLocalDate: confirmed.occurrence.authoritativeLocalDate,
        preflightFingerprint: `lvweeklyadoptpre:v1:${preflight}`,
        resultFingerprint: `lvweeklyadopt:v1:${resultFingerprint}`,
        grandfatheredAllocationCount: 0,
        recordedByUserId: actorUserId,
      });
    });

    const quote = await quoteRotatingCreditManualFunding({
      organizationId,
      leagueId: adoptedLeague.id,
      bowlerId: member.id,
      amountMinor: 1_000,
    });
    const result = await recordRotatingCreditManualFunding({
      organizationId,
      leagueId: adoptedLeague.id,
      actorUserId,
      request: {
        bowlerId: member.id,
        amountMinor: 1_000,
        tenderType: "cash",
        quoteFingerprint: quote.fingerprint,
        idempotencyKey: `credit-adoption-topup-${randomUUID()}`,
      },
    });
    if (!result.paymentId || !result.fundingId) throw new Error("adopted rotating top-up was not recorded");

    const ownedApps = await db.select().from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, organizationId),
      eq(paymentAllocationFundingApplications.leagueId, adoptedLeague.id),
      eq(paymentAllocationFundingApplications.paymentId, result.paymentId),
    ));
    const allocations = await db.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor })
      .from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, adoptedLeague.id),
        eq(paymentAllocations.paymentId, result.paymentId),
      ));
    expect(result.balance).toMatchObject({ fundedMinor: 1_000, availableMinor: 0, appliedMinor: 1_000 });
    expect(ownedApps).toHaveLength(1);
    expect(ownedApps[0]).toMatchObject({
      paymentId: result.paymentId,
      creditedBowlerId: member.id,
      genericFundingId: null,
      rotatingFundingId: result.fundingId,
      obligationId: confirmed.obligation.id,
      amountMinor: 1_000,
    });
    expect(allocations).toEqual([{ obligationId: confirmed.obligation.id, amountMinor: 1_000 }]);
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.paymentId, result.paymentId))).toHaveLength(0);
    expect(await db.select({ id: rotatingCreditApplications.id }).from(rotatingCreditApplications).where(eq(rotatingCreditApplications.paymentId, result.paymentId))).toHaveLength(0);

    // Explicit confirmation makes the later occurrence owned debt. A new
    // provider top-up after adoption must use the same owner FIFO as manual
    // cash and replay its single source without creating another receipt.
    await db.insert(weeklyPaymentWeekConfirmations).values({
      organizationId,
      leagueId: adoptedLeague.id,
      occurrenceId: forecast.occurrence.id,
      revision: 1,
      stateFingerprint: `lvmanagepayments:v1:${"a".repeat(64)}`,
      requestFingerprint: `lvmanagepaymentsrequest:v1:${"b".repeat(64)}`,
      responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${"c".repeat(64)}`,
      idempotencyKey: `adopted-provider-confirm-${randomUUID()}`,
      requestSnapshot: { occurrenceId: forecast.occurrence.id, fixture: "adopted rotating provider top-up" },
      recordedByUserId: actorUserId,
    });
    const providerIdempotencyKey = `adopted-provider-topup-${randomUUID()}`;
    const providerOperation = await prepareRotatingCreditPaymentOperation({
      organizationId,
      leagueId: adoptedLeague.id,
      authorizingUserId: actorUserId,
      bowlerId: member.id,
      amountMinor: 1_000,
      currency: "USD",
      shareCount: 1,
      providerName: "square",
      locationId,
      providerLocationId: null,
      sourceKind: "new_card",
      sourceId: "test-provider-source",
      customerId: "test-provider-customer",
      buyerEmail: null,
      quoteFingerprint: `lvrotcrquote:v1:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
      idempotencyKey: providerIdempotencyKey,
    });
    const providerPaymentId = `provider-rotating-${randomUUID()}`;
    await db.update(paymentOperations).set({
      status: "succeeded",
      providerObjectId: providerPaymentId,
      nextAttemptAt: null,
      completedAt: "2038-02-01T20:01:00.000Z",
      updatedAt: "2038-02-01T20:01:00.000Z",
    }).where(eq(paymentOperations.id, providerOperation.id));
    const finalized = await db.transaction((tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId: adoptedLeague.id,
      operationId: providerOperation.id,
      now: "2038-02-01T20:02:00.000Z",
      actorUserId,
    }));
    const replayed = await db.transaction((tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId: adoptedLeague.id,
      operationId: providerOperation.id,
      now: "2038-02-01T20:03:00.000Z",
      actorUserId,
    }));
    expect(finalized.finalized).toBe(true);
    expect(finalized.allocationIds).toHaveLength(1);
    expect(replayed).toEqual(finalized);
    const providerPayments = await db.select({ id: payments.id }).from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, adoptedLeague.id),
      eq(payments.paymentOperationId, providerOperation.id),
    ));
    expect(providerPayments).toHaveLength(1);
    const providerPayment = providerPayments[0];
    if (!providerPayment) throw new Error("adopted provider top-up receipt is missing");
    const providerFundings = await db.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, organizationId),
      eq(rotatingCreditFundings.leagueId, adoptedLeague.id),
      eq(rotatingCreditFundings.paymentId, providerPayment.id),
    ));
    expect(providerFundings).toHaveLength(1);
    const providerFunding = providerFundings[0];
    if (!providerFunding) throw new Error("adopted provider top-up funding is missing");
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.paymentId, providerPayment.id))).toHaveLength(0);
    expect(await db.select().from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, organizationId),
      eq(paymentAllocationFundingApplications.leagueId, adoptedLeague.id),
      eq(paymentAllocationFundingApplications.paymentId, providerPayment.id),
    ))).toMatchObject([{
      creditedBowlerId: member.id,
      genericFundingId: null,
      rotatingFundingId: providerFunding.id,
      obligationId: forecast.obligation.id,
      amountMinor: 1_000,
    }]);
    expect(await db.select({ id: rotatingCreditApplications.id }).from(rotatingCreditApplications).where(eq(rotatingCreditApplications.paymentId, providerPayment.id))).toHaveLength(0);
  });
});
