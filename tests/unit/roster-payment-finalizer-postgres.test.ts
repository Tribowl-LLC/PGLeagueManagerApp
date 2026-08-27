import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagueOccurrenceBillingTerms,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperations,
  paymentVoids,
  paymentOperationRosterSnapshots,
  payments,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb, getTestPool } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { updateBowler } from "../../server/storage/bowlers";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import {
  finalizeRosterSnapshotInTransaction,
  RosterSnapshotFinalizationError,
} from "../../server/services/roster-payment-finalizer";
import { recoverRosterPaymentOperation, recoverRosterPaymentOperationByRequestKey } from "../../server/services/roster-payment-recovery";
import { acquireInteractivePaymentOperationDispatchCutoff } from "../../server/storage/payment-operations";
import { chargeInteractiveObligations, quoteInteractiveObligations } from "../../server/services/roster-payment-core";
import { interactivePaymentOperationExecutor } from "../../server/services/interactive-payment-operation-executor";
import { paymentOperationRetryExecutor } from "../../server/services/payment-operation-retry-executor";
import { prepareInteractivePaymentOperation } from "../../server/services/interactive-payment-operation-preparation";
import { finalizeChargeFromWebhookEvidenceInTransaction } from "../../server/storage/payment-operations";
import { buildCanonicalScheduleCommandFingerprint, cancelOccurrence, rescheduleOccurrence } from "../../server/services/canonical-occurrence-transactions";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import { readCanonicalPaymentReport } from "../../server/services/canonical-payment-report";
import * as paymentProviderFactory from "../../server/services/payment-provider-factory";
import { decrypt } from "../../server/utils/crypto";
import { expectErrorLog } from "../helpers/expected-error-logs";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `roster-payment-finalizer-${suffix}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let teamId: number;
let bowlerId: number;
let actorUserId: number;
let occurrenceOrdinal = 0;

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  for (const row of leftovers) await deleteOrganization(row.id);
  const [organization] = await db.insert(organizations).values({ name: "Roster Finalizer Fixture", slug }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "Roster Fixture Location" }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Roster Finalizer League",
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
  leagueId = league.id;
  const [actor] = await db.insert(users).values({
    email: `roster-finalizer-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Roster Finalizer Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const [team] = await db.insert(teams).values({ name: "Roster Fixture Team", number: 1, leagueId }).returning({ id: teams.id });
  teamId = team.id;
  const [bowler] = await db.insert(bowlers).values({ name: "Roster Fixture Main", email: "roster-main@example.test", organizationId }).returning({ id: bowlers.id });
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

// Each test owns its occurrence/payment evidence. Release only unfinished
// reservations and void untouched obligations so the next FIFO test starts
// with no historical debt; settled/payment evidence remains immutable.
afterEach(async () => {
  if (!organizationId) return;
  await db.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
  ));
  await db.transaction(async (tx) => {
    const activePayments = await tx.select({ paymentId: paymentAllocations.paymentId }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.state, "active"),
    ));
    for (const paymentId of [...new Set(activePayments.map((row) => row.paymentId))]) {
      await tx.insert(paymentVoids).values({ organizationId, leagueId, paymentId, reason: "test fixture cleanup", recordedByUserId: actorUserId });
      await tx.update(payments).set({ status: "voided" }).where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId), eq(payments.leagueId, leagueId)));
      await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.paymentId, paymentId),
        eq(paymentAllocations.state, "active"),
      ));
    }
  });
  await db.update(paymentObligations).set({ state: "voided", voidedAt: "2038-12-31T23:59:59.000Z" }).where(and(
    eq(paymentObligations.organizationId, organizationId),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
  ));
  await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
});

async function createOccurrence() {
  occurrenceOrdinal += 1;
  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `roster-finalizer-publish-${suffix}-${occurrenceOrdinal}`,
    requestFingerprint: `roster-finalizer-fingerprint-${occurrenceOrdinal}`,
  });
  const startAt = new Date(Date.UTC(2038, 1, occurrenceOrdinal + 1, 19, 0, 0)).toISOString();
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId,
    generationKey: `roster-finalizer-occurrence-${suffix}-${occurrenceOrdinal}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: startAt.slice(0, 10),
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "roster-finalizer-test",
    plannedOrdinal: occurrenceOrdinal,
    competitionNumber: occurrenceOrdinal,
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
    billingOrdinal: occurrenceOrdinal,
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
    eq(occurrencePaymentResponsibilities.state, "active"),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
  ));
  if (!responsibility) throw new Error("fixture responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(eq(paymentObligations.responsibilityId, responsibility.id));
  if (!obligation) throw new Error("fixture obligation was not materialized");
  return { occurrence, responsibility, obligation };
}

async function createRosterOperation(
  obligationId: string,
  responsibilityId: string,
  operationAmount = 2_000,
  options: { withCanonicalPayment?: boolean } = {},
) {
  const withCanonicalPayment = options.withCanonicalPayment ?? true;
  const operationId = randomUUID();
  const providerPaymentId = `roster-provider-${operationId}`;
  return db.transaction(async (tx) => {
    const [operation] = await tx.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:roster-finalizer:${operationId}`,
      leagueId,
      amountMinor: operationAmount,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
      providerIdempotencyKey: `roster-${operationId}`.slice(0, 45),
      providerName: "square",
      providerObjectId: providerPaymentId,
      status: "succeeded",
      nextAttemptAt: null,
      completedAt: "2038-02-01T20:00:00.000Z",
    }).returning();
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
      encryptedSourceId: "fixture-source",
      sourceKind: "new_card",
      quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
      amountMinor: operationAmount,
      currency: "USD",
      obligations: [{ id: obligationId, responsibilityId, responsibilityVersion: 1, payerBowlerId: bowlerId, amountMinor: operationAmount }],
      lineItems: [],
      snapshotFingerprint: `lvrosterexec:v1:${"b".repeat(64)}`,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId, allocationIndex: 0, amountMinor: operationAmount, state: withCanonicalPayment ? "finalized" : "reserved" });
    if (withCanonicalPayment) {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: operationAmount,
        status: "paid",
        type: "square",
        providerPaymentId,
        paymentOperationId: operationId,
        idempotencyKey: `${operationId}:0`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("fixture payment was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId,
        amountMinor: operationAmount,
        currency: "USD",
        recordedByUserId: actorUserId,
      });
      const [obligation] = await tx.select({ amountMinor: paymentObligations.amountMinor }).from(paymentObligations).where(and(
        eq(paymentObligations.id, obligationId),
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
      )).limit(1);
      const [activeTotal] = await tx.select({ amountMinor: sql<number>`COALESCE(SUM(${paymentAllocations.amountMinor}), 0)` }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.obligationId, obligationId),
        eq(paymentAllocations.state, "active"),
      ));
      await tx.update(paymentObligations).set({ state: Number(activeTotal?.amountMinor ?? 0) >= Number(obligation?.amountMinor ?? 0) ? "settled" : "partially_settled" }).where(and(
        eq(paymentObligations.id, obligationId),
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
      ));
    }
    if (!operation) throw new Error("fixture operation was not created");
    return { operation };
  });
}

describe("PR1 roster snapshot finalization on PostgreSQL", () => {
  it("reports unresolved operation evidence in league-local dates and preserves upfront mode", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "upfront", timezone: "Pacific/Kiritimati" }).where(eq(leagues.id, leagueId));
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `report-operation-only-${operationId}`,
      leagueId,
      amountMinor: fixture.obligation.amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"d".repeat(64)}`,
      providerIdempotencyKey: `report-${operationId}`.slice(0, 45),
      providerName: "square",
      status: "provider_unknown",
      errorClassification: "provider_unknown",
      errorCode: "REPORT_TEST_PENDING",
      nextAttemptAt: "2038-02-01T20:00:00.000Z",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: fixture.obligation.payerBowlerId,
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: fixture.obligation.payerBowlerId, amountMinor: fixture.obligation.amountMinor }],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"e".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
    });
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 20 });
    const unresolved = report.rows.find((row) => row.paymentOperationId === operationId);
    expect(report.paymentTiming).toMatchObject({ paymentMode: "upfront", source: "canonical" });
    expect(unresolved).toMatchObject({ source: "unresolved_operation", businessDate: "2038-02-03", authoritativeLocalDate: "2038-02-03", operationStatus: "provider_unknown" });
  });

  it("does not count a provider-linked payment as confirmed before canonical allocation finalization", async () => {
    const fixture = await createOccurrence();
    const beforeReport = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 100 });
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `report-missing-allocation-${operationId}`,
      leagueId,
      amountMinor: fixture.obligation.amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"f".repeat(64)}`,
      providerIdempotencyKey: `report-missing-${operationId}`.slice(0, 45),
      providerName: "square",
      // Provider success without local finalization is retained as
      // reconciliation evidence; no orphan parent payment is persisted.
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "LOCAL_FINALIZATION_FAILED",
      nextAttemptAt: null,
      providerObjectId: `provider-${operationId}`,
      completedAt: "2038-02-01T20:00:00.000Z",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: fixture.obligation.payerBowlerId,
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: fixture.obligation.payerBowlerId, amountMinor: fixture.obligation.amountMinor }],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"2".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
    });
    const paymentsForOperation = await db.select({ id: payments.id }).from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
      eq(payments.paymentOperationId, operationId),
    ));
    expect(paymentsForOperation).toEqual([]);
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 20 });
    const row = report.rows.find((candidate) => candidate.paymentOperationId === operationId);
    expect(row).toMatchObject({
      paymentId: null,
      status: "unresolved",
      reviewRequired: true,
      unresolved: true,
      paymentOperationId: operationId,
      allocatedMinor: 0,
      unallocatedMinor: fixture.obligation.amountMinor,
    });
    expect(report.totals.grossConfirmedPaidMinor).toBe(0);
    expect(report.totals.reviewRequiredMinor - beforeReport.totals.reviewRequiredMinor).toBe(fixture.obligation.amountMinor);
    expect(report.totals.unresolvedOperationMinor - beforeReport.totals.unresolvedOperationMinor).toBe(fixture.obligation.amountMinor);
  });

  it("fails closed for the unallocated item of a succeeded multi-item operation", async () => {
    const first = await createOccurrence();
    const second = await createOccurrence();
    const beforeReport = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 200 });
    const operationId = randomUUID();
    const providerPaymentId = `provider-${operationId}`;
    const totalMinor = first.obligation.amountMinor + second.obligation.amountMinor;
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `report-multi-item-${operationId}`,
      leagueId,
      amountMinor: totalMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"1".repeat(64)}`,
      providerIdempotencyKey: `report-multi-${operationId}`.slice(0, 45),
      providerName: "square",
      providerObjectId: providerPaymentId,
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "LOCAL_FINALIZATION_FAILED",
      nextAttemptAt: null,
      completedAt: "2038-02-01T20:00:00.000Z",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: first.obligation.payerBowlerId,
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: totalMinor,
        currency: "USD",
        obligations: [
          { id: first.obligation.id, responsibilityId: first.responsibility.id, responsibilityVersion: first.responsibility.version, payerBowlerId: first.obligation.payerBowlerId, amountMinor: first.obligation.amountMinor },
          { id: second.obligation.id, responsibilityId: second.responsibility.id, responsibilityVersion: second.responsibility.version, payerBowlerId: second.obligation.payerBowlerId, amountMinor: second.obligation.amountMinor },
        ],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"3".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values([
        { operationId, organizationId, leagueId, obligationId: first.obligation.id, allocationIndex: 0, amountMinor: first.obligation.amountMinor, state: "finalized" },
        { operationId, organizationId, leagueId, obligationId: second.obligation.id, allocationIndex: 1, amountMinor: second.obligation.amountMinor, state: "finalized" },
      ]);
    });
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 20 });
    const firstRow = report.rows.find((row) => row.paymentOperationId === operationId);
    expect(firstRow).toMatchObject({ paymentId: null, status: "unresolved", reviewRequired: true, unresolved: true, allocatedMinor: 0, unallocatedMinor: totalMinor });
    expect(report.rows.filter((row) => row.paymentOperationId === operationId)).toHaveLength(1);
    expect(report.totals.grossConfirmedPaidMinor - beforeReport.totals.grossConfirmedPaidMinor).toBe(0);
  });

  it("persists one upfront due instant with no grace window across later occurrences", async () => {
    await db.update(leagues).set({ paymentMode: "upfront", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const first = await createOccurrence();
    const second = await createOccurrence();
    expect(first.obligation.dueAt).toBe(first.obligation.pastDueAt);
    expect(second.obligation.dueAt).toBe(second.obligation.pastDueAt);
    expect(second.obligation.dueAt).toBe(first.obligation.dueAt);
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 100 });
    expect(report.paymentTiming).toMatchObject({
      paymentMode: "upfront",
      upfrontDueAt: new Date(first.obligation.dueAt).toISOString(),
      upfrontDueAtLocal: first.obligation.dueAt.slice(0, 10),
      source: "canonical",
    });
  });

  it("reschedules a future roster-ready occurrence by versioning open obligations", async () => {
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const fixture = await createOccurrence();
    const request = {
      organizationId,
      leagueId,
      actorUserId,
      commandType: "reschedule" as const,
      occurrenceId: fixture.occurrence.id,
      now: "2038-01-01T00:00:00.000Z",
      authoritativeLocalDate: "2038-03-15",
      authoritativeLocalStartTime: "19:00",
      timezone: "UTC",
      ambiguousFold: "reject" as const,
      idempotencyKey: `roster-reschedule-open-${randomUUID()}`,
      requestFingerprint: "",
      reason: "Move the future session while payment remains open",
    };
    const rescheduled = await rescheduleOccurrence({ ...request, requestFingerprint: buildCanonicalScheduleCommandFingerprint(request) });
    expect(rescheduled.id).toBe(fixture.occurrence.id);
    expect(rescheduled.authoritativeLocalDate).toBe("2038-03-15");
    const responsibilities = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state, dueAt: occurrencePaymentResponsibilities.dueAt }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    )).orderBy(occurrencePaymentResponsibilities.version);
    expect(responsibilities.map((row) => row.state)).toEqual(["voided", "active"]);
    const correctedDueAt = new Date(rescheduled.startAt).toISOString();
    expect(new Date(responsibilities.at(-1)?.dueAt ?? "").toISOString()).toBe(correctedDueAt);
    expect(responsibilities.at(-1)).toMatchObject({ version: 2, state: "active" });
    const obligations = await db.select({ state: paymentObligations.state, dueAt: paymentObligations.dueAt, responsibilityId: paymentObligations.responsibilityId }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.occurrenceId, fixture.occurrence.id),
      eq(paymentObligations.payerBowlerId, bowlerId),
    )).orderBy(paymentObligations.createdAt);
    expect(obligations.map((row) => row.state)).toEqual(["voided", "open"]);
    expect(new Date(obligations.at(-1)?.dueAt ?? "").toISOString()).toBe(correctedDueAt);
    expect(obligations.at(-1)).toMatchObject({ state: "open", responsibilityId: responsibilities.at(-1)?.id });
  });

  it("blocks reschedule when roster evidence is reserved or paid", async () => {
    const reservedFixture = await createOccurrence();
    const reservedOperation = await createRosterOperation(reservedFixture.obligation.id, reservedFixture.responsibility.id, 2_000, { withCanonicalPayment: false });
    const makeRequest = (occurrenceId: string, key: string) => ({
      organizationId,
      leagueId,
      actorUserId,
      commandType: "reschedule" as const,
      occurrenceId,
      now: "2038-01-01T00:00:00.000Z",
      authoritativeLocalDate: "2038-03-20",
      authoritativeLocalStartTime: "19:00",
      timezone: "UTC",
      ambiguousFold: "reject" as const,
      idempotencyKey: key,
      requestFingerprint: "",
      reason: "Attempt to move an occurrence with payment evidence",
    });
    const reservedRequest = makeRequest(reservedFixture.occurrence.id, `roster-reschedule-reserved-${randomUUID()}`);
    await expect(rescheduleOccurrence({ ...reservedRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(reservedRequest) })).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
    expect(reservedOperation.operation.id).toBeTruthy();

    const paidFixture = await createOccurrence();
    const paidOperation = await createRosterOperation(paidFixture.obligation.id, paidFixture.responsibility.id);
    await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: paidOperation.operation.id, now: "2038-02-01T21:00:00.000Z", actorUserId }));
    const paidRequest = makeRequest(paidFixture.occurrence.id, `roster-reschedule-paid-${randomUUID()}`);
    await expect(rescheduleOccurrence({ ...paidRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(paidRequest) })).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
  });

  it("permits sequential provider partials after the first roster snapshot is finalized", async () => {
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const fixture = await createOccurrence();
    const first = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 1_000);
    await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId,
      operationId: first.operation.id,
      now: "2038-02-01T21:00:00.000Z",
      actorUserId,
    }));
    const second = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 1_000);
    await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId,
      operationId: second.operation.id,
      now: "2038-02-01T22:00:00.000Z",
      actorUserId,
    }));

    const allocations = await db.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.obligationId, fixture.obligation.id),
      eq(paymentAllocations.state, "active"),
    ));
    const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const items = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, leagueId),
      eq(paymentOperationRosterSnapshotItems.obligationId, fixture.obligation.id),
    ));
    expect(allocations.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([1_000, 1_000]);
    expect(allocations.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(fixture.obligation.amountMinor);
    expect(obligation?.state).toBe("settled");
    expect(items).toHaveLength(2);
    expect(items.every((row) => row.state === "finalized")).toBe(true);
  });

  it("allows only one unresolved reservation while concurrent provider preparations race", async () => {
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const fixture = await createOccurrence();
    const reserve = async (suffixValue: string) => {
      const operationId = randomUUID();
      return db.transaction(async (tx) => {
        await tx.insert(paymentOperations).values({
          id: operationId,
          organizationId,
          authorizingUserId: actorUserId,
          operationType: "interactive_charge",
          targetKey: `reservation-race:${suffixValue}:${operationId}`,
          leagueId,
          amountMinor: 1_000,
          currency: "USD",
          requestFingerprint: `lvpayreq:v1:${"f".repeat(64)}`,
          providerIdempotencyKey: `race-${operationId}`.slice(0, 45),
          providerName: "square",
          status: "pending",
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
          encryptedSourceId: "fixture-source",
          sourceKind: "new_card",
          quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
          amountMinor: 1_000,
          currency: "USD",
          obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: bowlerId, amountMinor: 1_000 }],
          lineItems: [],
          snapshotFingerprint: `lvrosterexec:v1:${"1".repeat(64)}`,
        });
        await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: 1_000, state: "reserved" });
        return operationId;
      });
    };
    const results = await Promise.allSettled([reserve("a"), reserve("b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reservations = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, leagueId),
      eq(paymentOperationRosterSnapshotItems.obligationId, fixture.obligation.id),
    ));
    expect(reservations).toEqual([{ state: "reserved" }]);
  });

  it("links a real interactive preparation to its league and creates the roster snapshot", async () => {
    const fixture = await createOccurrence();
    expectErrorLog("Payment operation retry scheduler rearm failed after interactive checkout");
    // The first report test deliberately exercises upfront mode and leaves the
    // shared fixture in that mode. This preparation path is the weekly exact-
    // obligation contract, so reset the fixture's authoritative league mode
    // before quoting one obligation.
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const firstQuote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: fixture.obligation.payerBowlerId,
    });
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockImplementation(async ({ operationId }) => {
      const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
      if (!operation) throw new Error("prepared operation was not persisted");
      const [snapshot] = await db.select().from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, operationId));
      const [item] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operationId));
      if (!snapshot || !item) throw new Error("roster snapshot was not created before provider dispatch");
      const providerObjectId = `roster-preparation-provider-${operationId}`;
      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: "succeeded", providerObjectId, completedAt: "2038-03-01T21:00:00.000Z", nextAttemptAt: null }).where(eq(paymentOperations.id, operationId));
        await tx.insert(payments).values({
          organizationId,
          bowlerId: fixture.obligation.payerBowlerId,
          leagueId,
          amount: item.amountMinor,
          status: "paid",
          type: "square",
          providerPaymentId: providerObjectId,
          paymentOperationId: operationId,
          idempotencyKey: `${operationId}:0`,
        });
        await finalizeRosterSnapshotInTransaction(tx, {
          organizationId,
          leagueId,
          operationId,
          now: "2038-03-01T21:00:00.000Z",
          actorUserId,
        });
      });
      return (await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)))[0];
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const rearm = vi.spyOn(paymentOperationRetryExecutor, "rearm").mockRejectedValue(new Error("scheduler unavailable"));
    try {
      const result = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: 1_000,
          sourceId: "card-source-preparation-test",
          sourceKind: "new_card",
          storeCard: false,
          idempotencyKey: `preparation-test-${randomUUID()}`,
          requestFingerprint: firstQuote.fingerprint,
        },
      });
      expect(result.status).toBe("succeeded");
      expect(rearm).toHaveBeenCalled();
      const [interactiveSnapshot] = await db.select({ encryptedBuyerEmail: paymentOperationRosterSnapshots.encryptedBuyerEmail }).from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, result.operationId));
      expect(interactiveSnapshot?.encryptedBuyerEmail ? decrypt(interactiveSnapshot.encryptedBuyerEmail) : null).toBe("roster-main@example.test");
      const firstOperation = await db.select({ id: paymentOperations.id, leagueId: paymentOperations.leagueId }).from(paymentOperations).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.leagueId, leagueId), eq(paymentOperations.operationType, "interactive_charge"))).orderBy(paymentOperations.createdAt);
      expect(firstOperation.at(-1)?.leagueId).toBe(leagueId);

      // The first provider snapshot is now finalized, so the public quote must
      // treat it as immutable history and expose the exact remaining balance
      // for the second preparation rather than returning OBLIGATION_RESERVED.
      const secondQuote = await quoteInteractiveObligations({
        organizationId,
        leagueId,
        amountMinor: 1_000,
        payerBowlerId: fixture.obligation.payerBowlerId,
      });
      expect(secondQuote.amountMinor).toBe(1_000);
      const secondResult = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: 1_000,
          sourceId: "card-source-preparation-test-second",
          sourceKind: "new_card",
          storeCard: false,
          idempotencyKey: `preparation-test-second-${randomUUID()}`,
          requestFingerprint: secondQuote.fingerprint,
        },
      });
      expect(secondResult.status).toBe("succeeded");
      const snapshots = await db.select({ leagueId: paymentOperationRosterSnapshots.leagueId, amountMinor: paymentOperationRosterSnapshots.amountMinor }).from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.organizationId, organizationId), eq(paymentOperationRosterSnapshots.leagueId, leagueId))).orderBy(paymentOperationRosterSnapshots.createdAt);
      expect(snapshots.slice(-2)).toEqual([
        { leagueId, amountMinor: 1_000 },
        { leagueId, amountMinor: 1_000 },
      ]);
    } finally {
      execute.mockRestore();
      provider.mockRestore();
      rearm.mockRestore();
    }
  });

  it.each([
    { label: "missing payer email", storedEmail: null, requestedEmail: undefined },
    { label: "malformed stored email", storedEmail: "not-an-email", requestedEmail: undefined },
    { label: "malformed fallback email", storedEmail: null, requestedEmail: "not-an-email" },
  ])("rejects a $label before provider dispatch", async ({ storedEmail, requestedEmail }) => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    await db.update(bowlers).set({ email: storedEmail }).where(eq(bowlers.id, fixture.obligation.payerBowlerId));
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: fixture.obligation.payerBowlerId,
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute");
    try {
      await expect(chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: 1_000,
          sourceId: `email-validation-${randomUUID()}`,
          sourceKind: "new_card",
          buyerEmail: requestedEmail,
          storeCard: false,
          idempotencyKey: `email-validation-${randomUUID()}`,
          requestFingerprint: quote.fingerprint,
        },
      })).rejects.toMatchObject({ code: "BUYER_EMAIL_REQUIRED", status: 422 });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
      execute.mockRestore();
      await db.update(bowlers).set({ email: "roster-main@example.test" }).where(eq(bowlers.id, fixture.obligation.payerBowlerId));
    }
  });

  it("rejects an administrator attempting to save a card for another bowler before operation creation", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: fixture.obligation.payerBowlerId,
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute");
    const requestKey = `admin-card-save-${randomUUID()}`;
    try {
      await expect(chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: 1_000,
          sourceId: "admin-card-save-source",
          sourceKind: "new_card",
          buyerEmail: "roster-main@example.test",
          storeCard: true,
          idempotencyKey: requestKey,
          requestFingerprint: quote.fingerprint,
        },
      })).rejects.toMatchObject({ code: "CARD_SAVE_OWNER_REQUIRED", status: 403 });
      expect(execute).not.toHaveBeenCalled();
      const operations = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
        eq(paymentOperations.organizationId, organizationId),
        eq(paymentOperations.leagueId, leagueId),
        eq(paymentOperations.targetKey, `interactive-charge:${requestKey}`),
      ));
      expect(operations).toHaveLength(0);
    } finally {
      provider.mockRestore();
      execute.mockRestore();
    }
  });

  it("allows the payer account to save its own new card", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    await db.update(bowlers).set({ paymentCustomerId: "customer-self-save" }).where(eq(bowlers.id, fixture.obligation.payerBowlerId));
    const [payerUser] = await db.insert(users).values({
      email: `roster-payer-${randomUUID()}@example.test`,
      password: "deterministic-test-password-hash",
      name: "Roster Payer",
      role: "user",
      organizationId,
      bowlerId: fixture.obligation.payerBowlerId,
    }).returning({ id: users.id });
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: fixture.obligation.payerBowlerId,
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockResolvedValue(undefined);
    try {
      const result = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId: payerUser.id,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: 1_000,
          sourceId: "self-card-save-source",
          sourceKind: "new_card",
          storeCard: true,
          idempotencyKey: `self-card-save-${randomUUID()}`,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(result.status).toBe("pending");
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      provider.mockRestore();
      execute.mockRestore();
    }
  });

  it("replays an existing request key without treating the browser email as a new identity", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: fixture.obligation.amountMinor,
      payerBowlerId: fixture.obligation.payerBowlerId,
    });
    const requestKey = `email-replay-${randomUUID()}`;
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    let executions = 0;
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockImplementation(async ({ operationId }) => {
      const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
      if (!operation) throw new Error("prepared operation was not persisted");
      if (executions++ > 0) return operation;
      const providerObjectId = `email-replay-provider-${operationId}`;
      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: "succeeded", providerObjectId, completedAt: "2038-04-01T21:00:00.000Z", nextAttemptAt: null }).where(eq(paymentOperations.id, operationId));
        const [item] = await tx.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operationId));
        if (!item) throw new Error("prepared roster item was not persisted");
        const [payment] = await tx.insert(payments).values({
          organizationId,
          bowlerId: fixture.obligation.payerBowlerId,
          leagueId,
          amount: item.amountMinor,
          status: "paid",
          type: "square",
          providerPaymentId: providerObjectId,
          paymentOperationId: operationId,
          idempotencyKey: `${operationId}:0`,
        }).returning({ id: payments.id });
        if (!payment) throw new Error("provider payment fixture was not persisted");
        await finalizeRosterSnapshotInTransaction(tx, {
          organizationId,
          leagueId,
          operationId,
          now: "2038-04-01T21:00:00.000Z",
          actorUserId,
        });
      });
      return (await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)))[0];
    });
    try {
      const first = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: fixture.obligation.amountMinor,
          sourceId: "email-replay-source",
          sourceKind: "new_card",
          buyerEmail: "browser-fallback@example.test",
          storeCard: false,
          idempotencyKey: requestKey,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(first.status).toBe("succeeded");
      const [snapshot] = await db.select({ encryptedBuyerEmail: paymentOperationRosterSnapshots.encryptedBuyerEmail }).from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, first.operationId));
      expect(snapshot?.encryptedBuyerEmail ? decrypt(snapshot.encryptedBuyerEmail) : null).toBe("roster-main@example.test");

      const replay = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          amountMinor: fixture.obligation.amountMinor,
          sourceId: "email-replay-source",
          sourceKind: "new_card",
          buyerEmail: "another-browser-value@example.test",
          storeCard: false,
          idempotencyKey: requestKey,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(replay).toMatchObject({ operationId: first.operationId, status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      provider.mockRestore();
      execute.mockRestore();
    }
  });

  it("finalizes a roster snapshot from webhook evidence exactly once", async () => {
    const fixture = await createOccurrence();
    const providerObjectId = `roster-webhook-provider-${randomUUID()}`;
    const operation = await db.transaction(async (tx) => {
      const prepared = await prepareInteractivePaymentOperation({
        organizationId,
        authorizingUserId: actorUserId,
        requestKey: `webhook-preparation-${randomUUID()}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        providerName: "square",
        leagueId,
        locationId,
        providerLocationId: null,
        payerBowlerId: fixture.obligation.payerBowlerId,
        requestKind: "direct",
        sourceId: "webhook-test-source",
        customerId: null,
        buyerEmail: null,
        storeCard: false,
        sourceKind: "new_card",
        allocations: [{ allocationIndex: 0, bowlerId: fixture.obligation.payerBowlerId, amountMinor: fixture.obligation.amountMinor, notes: "webhook test", paidByUserId: actorUserId, obligationId: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version }],
        lineItems: [],
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        transaction: tx,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId: prepared.id, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
      await tx.update(paymentOperations).set({ status: "provider_unknown", errorClassification: "provider_unknown", errorCode: "WEBHOOK_PENDING" }).where(eq(paymentOperations.id, prepared.id));
      return prepared;
    });
    const evidence = {
      organizationId,
      operationId: operation.id,
      locationId,
      providerLocationId: undefined,
      providerObjectId,
      providerPaymentId: providerObjectId,
      providerOrderId: null,
      amountMinor: fixture.obligation.amountMinor,
      currency: "USD",
      receiptUrl: null,
      receiptNumber: null,
      now: new Date("2038-04-01T21:00:00.000Z"),
    };
    const first = await db.transaction(async (tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    const replay = await db.transaction(async (tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    expect(first.status).toBe("succeeded");
    expect(replay.id).toBe(operation.id);
    const allocations = await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.leagueId, leagueId), eq(paymentAllocations.obligationId, fixture.obligation.id), eq(paymentAllocations.state, "active")));
    expect(allocations).toHaveLength(1);
  });

  it("serializes cancellation against provider success and preserves the winning evidence", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    const cancellationRequest = {
      organizationId,
      leagueId,
      actorUserId,
      commandType: "cancel",
      occurrenceId: fixture.occurrence.id,
      now: "2038-01-01T00:00:00.000Z",
      idempotencyKey: `roster-cancel-race-${randomUUID()}`,
      requestFingerprint: "",
      reason: "provider race test",
    } as const;
    const cancellation = cancelOccurrence({ ...cancellationRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancellationRequest) });
    const providerFinalization = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, leagueId);
      return finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-01-01T00:00:00.000Z", actorUserId });
    });
    const [cancelResult, providerResult] = await Promise.allSettled([cancellation, providerFinalization]);
    expect(cancelResult.status).toBe("fulfilled");
    const [storedOperation] = await db.select({ status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    const [storedObligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const activeAllocations = await db.select({ id: paymentAllocations.id, reviewRequired: paymentAllocations.reviewRequired }).from(paymentAllocations).where(and(eq(paymentAllocations.obligationId, fixture.obligation.id), eq(paymentAllocations.state, "active")));
    // Whichever transaction acquired the league lock first owns the outcome:
    // cancellation either voids the unpaid reservation and provider recovery
    // fails closed, or provider evidence settles first and cancellation marks
    // that evidence for review. Both outcomes retain operation identity.
    expect(storedOperation?.status).toBe("reconciliation_required");
    if (providerResult.status === "fulfilled") {
      expect(storedObligation?.state).toBe("settled");
      expect(activeAllocations).toHaveLength(1);
      expect(activeAllocations[0]?.reviewRequired).toBe(true);
    } else {
      expect(storedObligation?.state).toBe("voided");
      expect(activeAllocations).toHaveLength(0);
    }
  });

  it("finalizes exact reservations idempotently and conserves the obligation", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    const first = await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-02-01T21:00:00.000Z", actorUserId }));
    const second = await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-02-01T21:01:00.000Z", actorUserId }));
    expect(first.finalized).toBe(true);
    expect(first.allocationIds).toEqual([]);
    expect(second.allocationIds).toEqual([]);
    const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const allocations = await db.select().from(paymentAllocations).where(and(eq(paymentAllocations.obligationId, fixture.obligation.id), eq(paymentAllocations.state, "active")));
    expect(obligation?.state).toBe("settled");
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.amountMinor).toBe(2_000);
  });

  it("persists reconciliation when a provider snapshot becomes stale and recovers by operation id", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
    await expect(db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-02-02T21:00:00.000Z", actorUserId }))).rejects.toBeInstanceOf(RosterSnapshotFinalizationError);
    const recovered = await recoverRosterPaymentOperation({ organizationId, leagueId, operationId: operation.id, actorUserId });
    expect(recovered.status).toBe("reconciliation_required");
  });

  it("recovers by request key only for the same tenant, league, and authorizing user", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    const requestKey = `recover-by-key-${randomUUID()}`;
    await db.update(paymentOperations).set({ targetKey: `interactive-charge:${requestKey}` }).where(eq(paymentOperations.id, operation.id));

    await expect(recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId: actorUserId + 1 })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId: leagueId + 1, requestKey, actorUserId })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const recovered = await recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId });
    expect(recovered).toMatchObject({ id: operation.id, status: "succeeded" });
  });

  it("returns a discovered pending operation without provider recovery or redispatch", async () => {
    const requestKey = `pending-recovery-${randomUUID()}`;
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:${requestKey}`,
      leagueId,
      amountMinor: 1_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"6".repeat(64)}`,
      providerIdempotencyKey: `pending-recovery-${operationId}`.slice(0, 45),
      providerName: "square",
      status: "pending",
      nextAttemptAt: "2038-06-01T20:00:00.000Z",
    });

    const discovered = await recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId });
    expect(discovered).toMatchObject({ id: operationId, status: "pending", providerObjectId: null });
  });

  it("waits for an in-flight preparation commit before recovering by request key", async () => {
    const fixture = await createOccurrence();
    const operationId = randomUUID();
    const requestKey = `recovery-wait-${randomUUID()}`;
    const providerPaymentId = `recovery-wait-provider-${operationId}`;
    let preparationReady!: () => void;
    let preparationFailed!: (error: unknown) => void;
    let releasePreparation!: () => void;
    const preparationReadyPromise = new Promise<void>((resolve, reject) => {
      preparationReady = resolve;
      preparationFailed = reject;
    });
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });

    const preparation = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, leagueId);
      await tx.insert(paymentOperations).values({
        id: operationId,
        organizationId,
        authorizingUserId: actorUserId,
        operationType: "interactive_charge",
        targetKey: `interactive-charge:${requestKey}`,
        leagueId,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        requestFingerprint: `lvpayreq:v1:${"4".repeat(64)}`,
        providerIdempotencyKey: `recovery-wait-${operationId}`.slice(0, 45),
        providerName: "square",
        providerObjectId: providerPaymentId,
        status: "succeeded",
        nextAttemptAt: null,
        completedAt: "2038-05-01T20:00:00.000Z",
      });
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: fixture.obligation.payerBowlerId,
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: fixture.obligation.payerBowlerId, amountMinor: fixture.obligation.amountMinor }],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"5".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({
        operationId,
        organizationId,
        leagueId,
        obligationId: fixture.obligation.id,
        allocationIndex: 0,
        amountMinor: fixture.obligation.amountMinor,
        state: "reserved",
      });
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId: fixture.obligation.payerBowlerId,
        leagueId,
        amount: fixture.obligation.amountMinor,
        status: "paid",
        type: "square",
        providerPaymentId,
        paymentOperationId: operationId,
        idempotencyKey: `${operationId}:0`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("provider payment fixture was not persisted");
      await finalizeRosterSnapshotInTransaction(tx, {
        organizationId,
        leagueId,
        operationId,
        now: "2038-05-01T20:00:00.000Z",
        actorUserId,
      });
      preparationReady();
      await preparationGate;
    }).catch((error) => {
      preparationFailed(error);
      throw error;
    });

    await preparationReadyPromise;
    const recovery = recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId });
    let recoverySettled = false;
    const recoveryWithState = recovery.finally(() => { recoverySettled = true; });
    const lockClient = await getTestPool().connect();
    try {
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await lockClient.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted = false) AS waiting",
          [organizationId, leagueId],
        );
        waiting = result.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(recoverySettled).toBe(false);
    } finally {
      releasePreparation();
      await preparation;
      lockClient.release();
    }

    await expect(recoveryWithState).resolves.toMatchObject({ id: operationId, status: "succeeded" });
  });

  it("blocks an interactive provider cutoff when a reserved roster version is stale", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 2_000, { withCanonicalPayment: false });
    await db.update(paymentOperations).set({ providerObjectId: null, status: "pending", nextAttemptAt: "2038-02-03T18:00:00.000Z", completedAt: null }).where(eq(paymentOperations.id, operation.id));
    const leaseToken = randomUUID();
    await db.update(paymentOperations).set({
      status: "leased",
      leaseOwner: "roster-cutoff-test",
      leaseToken,
      leaseExpiresAt: "2038-02-03T20:00:00.000Z",
      nextAttemptAt: null,
      dispatchClaimedAt: null,
      completedAt: null,
    }).where(eq(paymentOperations.id, operation.id));
    await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
    const cutoff = await acquireInteractivePaymentOperationDispatchCutoff({ organizationId, operationId: operation.id, leaseToken, now: new Date("2038-02-03T19:00:00.000Z") });
    expect(cutoff).toBe(false);
    const [blocked] = await db.select({ status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    expect(blocked?.status).toBe("reconciliation_required");
    const [releasedItem] = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    expect(releasedItem?.state).toBe("released");
  });

  it("invalidates Main slots when a bowler is directly deactivated", async () => {
    const [team] = await db.insert(teams).values({ name: "Direct Deactivation Team", number: 2, leagueId }).returning({ id: teams.id });
    const [deactivated] = await db.insert(bowlers).values({ name: "Direct Deactivation Main", organizationId }).returning({ id: bowlers.id, active: bowlers.active });
    await db.insert(bowlerLeagues).values({ bowlerId: deactivated.id, leagueId, teamId: team.id });
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: deactivated.id, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    ]);
    const fixture = await createOccurrence();
    const before = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.mainBowlerId, deactivated.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(before).toHaveLength(1);
    const updated = await updateBowler(deactivated.id, { active: false }, actorUserId);
    expect(updated.active).toBe(false);
    const [slot] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, team.id),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    expect(slot).toMatchObject({ occupant: "vacant", mainBowlerId: null });
    const after = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.mainBowlerId, deactivated.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(after).toHaveLength(0);
  });

  it("rejects snapshot totals that disagree with the operation or obligation at commit", async () => {
    const fixture = await createOccurrence();
    await expect(createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 2_500)).rejects.toThrow();
    const [remaining] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    expect(remaining?.state).toBe("open");
  });

  it("enforces exact one-parent gross conservation and whole-payment voids", async () => {
    const underallocated = await createOccurrence();
    await expect(db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 2_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-under-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("underallocated payment fixture was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId: underallocated.obligation.id,
        amountMinor: 1_000,
        currency: "USD",
        recordedByUserId: actorUserId,
      });
    })).rejects.toThrow();

    const overallocated = await createOccurrence();
    await expect(db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 2_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-over-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("overallocated payment fixture was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId: overallocated.obligation.id,
        amountMinor: 3_000,
        currency: "USD",
        recordedByUserId: actorUserId,
      });
    })).rejects.toThrow();

    const first = await createOccurrence();
    const second = await createOccurrence();
    const paymentId = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 4_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-exact-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("exact payment fixture was not created");
      await tx.insert(paymentAllocations).values([
        { organizationId, leagueId, paymentId: payment.id, obligationId: first.obligation.id, amountMinor: 2_000, currency: "USD", recordedByUserId: actorUserId },
        { organizationId, leagueId, paymentId: payment.id, obligationId: second.obligation.id, amountMinor: 2_000, currency: "USD", recordedByUserId: actorUserId },
      ]);
      return payment.id;
    });
    const exactAllocations = await db.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId));
    expect(exactAllocations.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([2_000, 2_000]);

    const sharedObligation = await createOccurrence();
    await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 1_500,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-shared-first-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("first shared-obligation payment fixture was not created");
      await tx.insert(paymentAllocations).values({ organizationId, leagueId, paymentId: payment.id, obligationId: sharedObligation.obligation.id, amountMinor: 1_500, currency: "USD", recordedByUserId: actorUserId });
    });
    await expect(db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 1_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-shared-second-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("second shared-obligation payment fixture was not created");
      await tx.insert(paymentAllocations).values({ organizationId, leagueId, paymentId: payment.id, obligationId: sharedObligation.obligation.id, amountMinor: 1_000, currency: "USD", recordedByUserId: actorUserId });
    })).rejects.toThrow();

    await expect(db.transaction(async (tx) => {
      await tx.insert(paymentVoids).values({ organizationId, leagueId, paymentId, reason: "mixed-state regression", recordedByUserId: actorUserId });
      await tx.update(payments).set({ status: "voided" }).where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId), eq(payments.leagueId, leagueId)));
      await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.paymentId, paymentId),
        eq(paymentAllocations.obligationId, first.obligation.id),
      ));
    })).rejects.toThrow();
  });

  it("keeps tenant-scoped reservation identity and allocation index unique", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    await expect(db.insert(paymentOperationRosterSnapshotItems).values({ operationId: operation.id, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: 2_000, state: "reserved" })).rejects.toThrow();
    const itemRows = await db.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    expect(itemRows).toHaveLength(1);
  });
});
