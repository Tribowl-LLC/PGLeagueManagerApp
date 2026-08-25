import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  finalizeRosterSnapshotInTransaction,
  RosterSnapshotFinalizationError,
} from "../../server/services/roster-payment-finalizer";
import { recoverRosterPaymentOperation } from "../../server/services/roster-payment-recovery";
import { acquireInteractivePaymentOperationDispatchCutoff } from "../../server/storage/payment-operations";
import { chargeInteractiveObligations, quoteInteractiveObligations } from "../../server/services/roster-payment-core";
import { interactivePaymentOperationExecutor } from "../../server/services/interactive-payment-operation-executor";
import { prepareInteractivePaymentOperation } from "../../server/services/interactive-payment-operation-preparation";
import { finalizeChargeFromWebhookEvidenceInTransaction } from "../../server/storage/payment-operations";
import { buildCanonicalScheduleCommandFingerprint, cancelOccurrence } from "../../server/services/canonical-occurrence-transactions";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";

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
  const [bowler] = await db.insert(bowlers).values({ name: "Roster Fixture Main", organizationId }).returning({ id: bowlers.id });
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
  const startAt = `2038-02-${String(occurrenceOrdinal + 1).padStart(2, "0")}T19:00:00.000Z`;
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

async function createRosterOperation(obligationId: string, responsibilityId: string, operationAmount = 2_000) {
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
      snapshotVersion: 1,
      amountMinor: operationAmount,
      currency: "USD",
      obligations: [{ id: obligationId, responsibilityId, responsibilityVersion: 1, payerBowlerId: bowlerId, amountMinor: operationAmount }],
      snapshotFingerprint: `lvroster:v1:${"b".repeat(64)}`,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId, allocationIndex: 0, amountMinor: operationAmount, state: "reserved" });
    const [payment] = await tx.insert(payments).values({
      bowlerId,
      leagueId,
      amount: operationAmount,
      weekOf: "2038-02-01T19:00:00.000Z",
      status: "paid",
      type: "square",
      providerPaymentId,
      paymentOperationId: operationId,
      paymentOperationAllocationIndex: 0,
      idempotencyKey: `${operationId}:0`,
    }).returning();
    if (!operation || !payment) throw new Error("fixture operation/payment was not created");
    return { operation, payment };
  });
}

describe("PR1 roster snapshot finalization on PostgreSQL", () => {
  it("links a real interactive preparation to its league and creates the roster snapshot", async () => {
    const fixture = await createOccurrence();
    const quote = await quoteInteractiveObligations({ organizationId, leagueId, obligationIds: [fixture.obligation.id] });
    const providerObjectId = `roster-preparation-provider-${randomUUID()}`;
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockImplementation(async ({ operationId }) => {
      const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
      if (!operation) throw new Error("prepared operation was not persisted");
      const [snapshot] = await db.select().from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, operationId));
      const [item] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operationId));
      if (!snapshot || !item) throw new Error("roster snapshot was not created before provider dispatch");
      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: "succeeded", providerObjectId, completedAt: "2038-03-01T21:00:00.000Z", nextAttemptAt: null }).where(eq(paymentOperations.id, operationId));
        await tx.insert(payments).values({
          bowlerId: fixture.obligation.payerBowlerId,
          leagueId,
          amount: item.amountMinor,
          weekOf: fixture.obligation.dueAt,
          status: "paid",
          type: "square",
          providerPaymentId: providerObjectId,
          paymentOperationId: operationId,
          paymentOperationAllocationIndex: item.allocationIndex,
          idempotencyKey: `${operationId}:0`,
        });
      });
      return (await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)))[0];
    });
    try {
      const result = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: fixture.obligation.payerBowlerId,
        request: {
          obligationIds: [fixture.obligation.id],
          sourceId: "card-source-preparation-test",
          sourceKind: "new_card",
          storeCard: false,
          idempotencyKey: `preparation-test-${randomUUID()}`,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(result.status).toBe("succeeded");
      const [operation] = await db.select({ leagueId: paymentOperations.leagueId }).from(paymentOperations).where(eq(paymentOperations.providerObjectId, providerObjectId));
      expect(operation?.leagueId).toBe(leagueId);
      const [snapshot] = await db.select({ leagueId: paymentOperationRosterSnapshots.leagueId }).from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.leagueId, leagueId)).orderBy(paymentOperationRosterSnapshots.createdAt);
      expect(snapshot?.leagueId).toBe(leagueId);
    } finally {
      execute.mockRestore();
    }
  });

  it("finalizes a roster snapshot from webhook evidence exactly once", async () => {
    const fixture = await createOccurrence();
    const providerObjectId = `roster-webhook-provider-${randomUUID()}`;
    const operation = await prepareInteractivePaymentOperation({
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
      weekOf: new Date(fixture.obligation.dueAt).toISOString(),
      combined: false,
      allocations: [{ allocationIndex: 0, bowlerId: fixture.obligation.payerBowlerId, amountMinor: fixture.obligation.amountMinor, lineageAmountMinor: null, prizeFundAmountMinor: null, weekOf: new Date(fixture.obligation.dueAt).toISOString(), notes: "webhook test", paidByUserId: actorUserId }],
      lineItems: [],
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId: operation.id,
        organizationId,
        leagueId,
        snapshotVersion: 1,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: fixture.obligation.payerBowlerId, amountMinor: fixture.obligation.amountMinor, dueAt: new Date(fixture.obligation.dueAt).toISOString(), pastDueAt: new Date(fixture.obligation.pastDueAt).toISOString() }],
        snapshotFingerprint: `lvrosterquote:v1:${"c".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId: operation.id, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
      await tx.update(paymentOperations).set({ status: "provider_unknown", errorClassification: "provider_unknown", errorCode: "WEBHOOK_PENDING" }).where(eq(paymentOperations.id, operation.id));
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
    expect(first.allocationIds).toHaveLength(1);
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

  it("blocks an interactive provider cutoff when a reserved roster version is stale", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
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
  });

  it("rejects snapshot totals that disagree with the operation or obligation at commit", async () => {
    const fixture = await createOccurrence();
    await expect(createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 2_500)).rejects.toThrow();
    const [remaining] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    expect(remaining?.state).toBe("open");
  });

  it("keeps tenant-scoped reservation identity and allocation index unique", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    await expect(db.insert(paymentOperationRosterSnapshotItems).values({ operationId: operation.id, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: 2_000, state: "reserved" })).rejects.toThrow();
    const itemRows = await db.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    expect(itemRows).toHaveLength(1);
  });
});
