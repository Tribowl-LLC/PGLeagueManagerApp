import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  bowlers,
  bowlerPaymentLinks,
  canonicalCollectionGroupMemberRevisions,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroups,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  payments,
  scheduledPaymentOperationAllocations,
  users,
} from "@shared/schema";
import { getTestDb, getTestPool } from "../setup/test-db";
import { expectErrorLog } from "../helpers/expected-error-logs";
import { deleteOrganization } from "../../server/storage/organizations";
import { archiveLeague, updateLeague } from "../../server/storage/leagues";
import {
  deactivatePaymentSchedule,
  deletePayment,
  updatePayment,
  updatePaymentReceiptCacheForOrganization,
  updatePaymentScheduleCard,
  updatePaymentScheduleFields,
} from "../../server/storage/payments";
import {
  acquirePaymentOperationLease,
  acquireScheduledPaymentOperationDispatchCutoff,
  buildNextPaymentOperationWakeQuery,
  getLegacyScheduledPaymentCycleBlock,
  getNextPaymentOperationWake,
  getPaymentOperationForOrganization,
  finalizePaymentOperationSuccess,
  recordPaymentOperationActionRequired,
} from "../../server/storage/payment-operations";
import {
  acquireLegacyScheduledCycleLock,
} from "../../server/services/scheduled-payment-cycle-lock";
import {
  prepareScheduledPaymentCycle,
} from "../../server/services/scheduled-payment-operation-preparation";
import { persistCanonicalCollectionGroupsInTransaction } from "../../server/services/canonical-collection-groups";
import {
  buildPaymentOperationIdentity,
  buildSquarePaymentRequestIdentity,
} from "../../server/services/payment-operation-idempotency";
import { ScheduledPaymentOperationExecutor } from "../../server/services/scheduled-payment-operation-executor";
import {
  buildCanonicalScheduleCommandFingerprint,
  cancelOccurrence,
} from "../../server/services/canonical-occurrence-transactions";
import { PaymentProviderError } from "../../server/services/payment-errors";
import type {
  OrderLineItem,
  PaymentCustomer,
  PaymentIdempotencyInput,
  PaymentProvider,
  PaymentResult,
  PaymentVerification,
  RefundResult,
  SavedCard,
} from "../../server/services/payment-provider";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `scheduled-ledger-cutover-${suffix}`;
const cycleAt = "2032-01-05T18:30:00.000Z";
const dueNow = new Date("2032-01-06T00:00:00.000Z");
let organizationId: number;
let locationId: number;

function identityKey(input?: PaymentIdempotencyInput): string {
  if (typeof input === "string") return input;
  if (!input) throw new Error("fake Square call did not receive an idempotency identity");
  return `${input.orderKey ?? "direct"}:${input.paymentKey}`;
}

class DeterministicSquareProvider implements PaymentProvider {
  readonly providerName = "square";
  readonly requests: string[] = [];
  readonly providerEffects = new Map<string, PaymentResult>();
  unknownAfterFirstEffect = false;
  beforeEffect: (() => Promise<void>) | undefined;

  constructor(readonly locationId: number) {}

  async processPayment(
    _sourceId: string,
    _amount: number,
    _storeCard?: boolean,
    _customerId?: string,
    _buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    return this.effect(identityKey(idempotencyKey));
  }

  async createOrderWithPayment(
    _sourceId: string,
    _amount: number,
    _lineItems: OrderLineItem[],
    _storeCard?: boolean,
    _customerId?: string,
    _buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    return this.effect(identityKey(idempotencyKey));
  }

  private async effect(key: string): Promise<PaymentResult> {
    await this.beforeEffect?.();
    this.requests.push(key);
    const existing = this.providerEffects.get(key);
    if (existing) return existing;
    const created = {
      id: `square-payment-${this.providerEffects.size + 1}`,
      status: "COMPLETED",
      receiptUrl: "https://square.example.test/receipt",
      receiptNumber: "LV-TEST",
    };
    this.providerEffects.set(key, created);
    if (this.unknownAfterFirstEffect) {
      this.unknownAfterFirstEffect = false;
      throw new PaymentProviderError(
        "Payment outcome could not be confirmed.",
        "REQUEST_TIMEOUT",
        undefined,
        { disposition: "provider_unknown", providerCode: "REQUEST_TIMEOUT" },
      );
    }
    return created;
  }

  async refundPayment(): Promise<RefundResult> {
    throw new Error("refunds are outside the scheduled-ledger test boundary");
  }
  async saveCardOnFile(): Promise<SavedCard | null> { return null; }
  async listCardsOnFile(): Promise<SavedCard[]> { return []; }
  async disableCard(): Promise<void> {}
  async createOrUpdateCustomer(): Promise<PaymentCustomer | null> { return null; }
  async getPayment(): Promise<PaymentVerification | null> { return null; }
  validateCardId(cardId: string | null): boolean { return cardId?.startsWith("ccof:") === true; }
}

async function createSchedule(input: {
  paymentMode?: "weekly" | "upfront";
  frequency?: "weekly" | "upfront";
  nextPaymentDate?: string;
  order?: boolean;
  combined?: boolean;
  organizationIdOverride?: number;
  locationIdOverride?: number;
} = {}) {
  const fixtureOrganizationId = input.organizationIdOverride ?? organizationId;
  const fixtureLocationId = input.locationIdOverride ?? locationId;
  const [league] = await db.insert(leagues).values({
    name: `Scheduled Ledger ${Math.random()}`,
    seasonStart: "2032-01-01T00:00:00.000Z",
    seasonEnd: "2032-12-31T23:59:59.000Z",
    weekDay: "Monday",
    competitionStartTime: "18:30",
    timezone: "UTC",
    weeklyFee: 2_000,
    totalBowlingWeeks: 40,
    paymentMode: input.paymentMode ?? "weekly",
    lineageItemVariationId: input.order ? "catalog-lineage-variation" : null,
    organizationId: fixtureOrganizationId,
    locationId: fixtureLocationId,
  }).returning();
  if (!league) throw new Error("league fixture was not created");
  const [bowler] = await db.insert(bowlers).values({
    name: `Scheduled Ledger Bowler ${Math.random()}`,
    email: `scheduled-${Math.random()}@example.test`,
    paymentCustomerId: `customer-${Math.random()}`,
    organizationId: fixtureOrganizationId,
  }).returning();
  if (!bowler) throw new Error("bowler fixture was not created");
  let partnerId: number | null = null;
  if (input.combined) {
    const [partner] = await db.insert(bowlers).values({
      name: `Scheduled Ledger Partner ${Math.random()}`,
      email: `scheduled-partner-${Math.random()}@example.test`,
      paymentCustomerId: `customer-partner-${Math.random()}`,
      organizationId: fixtureOrganizationId,
    }).returning({ id: bowlers.id });
    if (!partner) throw new Error("partner fixture was not created");
    partnerId = partner.id;
    await db.insert(bowlerPaymentLinks).values({
      bowlerAId: bowler.id,
      bowlerBId: partner.id,
      organizationId: fixtureOrganizationId,
      status: "accepted",
    });
  }
  const [schedule] = await db.insert(paymentSchedules).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    frequency: input.frequency ?? "weekly",
    amount: 2_000,
    nextPaymentDate: input.nextPaymentDate ?? cycleAt,
    paymentCardId: "ccof:scheduled-ledger-test",
    additionalBowlerIds: partnerId === null ? null : [partnerId],
  }).returning();
  if (!schedule) throw new Error("schedule fixture was not created");
  return { schedule, league, bowler };
}

async function createCanonicalCursorEvidence(leagueId: number): Promise<{
  triggerId: string;
  pairedId: string;
  followingId: string;
  actorUserId: number;
}> {
  const [actor] = await db.insert(users).values({
    email: `scheduled-cursor-${Math.random()}@example.test`,
    password: "scheduled-cursor-test-password-hash",
    name: "Scheduled cursor actor",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  if (!actor) throw new Error("scheduled cursor actor was not created");
  const [generationCommand] = await db.insert(leagueScheduleCommands).values({
    organizationId,
    leagueId,
    actorUserId: actor.id,
    commandType: "generate",
    idempotencyKey: `scheduled-cursor-generate-${Math.random()}`,
    requestFingerprint: `lvcanoncmd:v1:${"1".repeat(64)}`,
  }).returning({ id: leagueScheduleCommands.id });
  if (!generationCommand) throw new Error("scheduled cursor generation command was not created");
  const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({
    organizationId,
    leagueId,
    originatingCommandId: generationCommand.id,
    generatorVersion: "scheduled-cursor-test/1",
    inputFingerprint: "2".repeat(64),
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { cursor: true },
    rangeStartDate: "2032-01-01",
    rangeEndDate: "2032-03-01",
    candidateOccurrenceCount: 4,
    generatedOccurrenceCount: 4,
  }).returning({ id: leagueOccurrenceGenerationRuns.id });
  if (!run) throw new Error("scheduled cursor generation run was not created");
  const [publicationCommand] = await db.insert(leagueScheduleCommands).values({
    organizationId,
    leagueId,
    actorUserId: actor.id,
    commandType: "publish",
    idempotencyKey: `scheduled-cursor-publish-${Math.random()}`,
    requestFingerprint: `lvcanoncmd:v1:${"3".repeat(64)}`,
  }).returning({ id: leagueScheduleCommands.id });
  if (!publicationCommand) throw new Error("scheduled cursor publication command was not created");
  const rows = [
    ["2032-01-05", "2032-01-05T18:30:00.000Z", 1],
    ["2032-01-12", "2032-01-12T18:30:00.000Z", 2],
    ["2032-01-19", "2032-01-19T18:30:00.000Z", 3],
    ["2032-01-26", "2032-01-26T18:30:00.000Z", 4],
  ] as const;
  const occurrences = await db.insert(leagueOccurrences).values(rows.map(([date, startAt, ordinal]) => ({
    organizationId,
    leagueId,
    locationId,
    generationKey: `scheduled-cursor-${date}-${Math.random()}`,
    generationRunId: run.id,
    kind: "regular" as const,
    status: "scheduled" as const,
    lifecycle: "published" as const,
    authoritativeLocalDate: date,
    authoritativeLocalStartTime: "18:30:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous" as const,
    resolverVersion: "scheduled-cursor-test/1",
    plannedOrdinal: ordinal,
    competitionNumber: ordinal,
    competitive: true,
    countsInStandings: true,
    lastCommandId: publicationCommand.id,
    publishedAt: "2032-01-01T00:00:00.000Z",
    publishedByUserId: actor.id,
    publicationCommandId: publicationCommand.id,
  }))).returning({ id: leagueOccurrences.id, authoritativeLocalDate: leagueOccurrences.authoritativeLocalDate });
  if (occurrences.length !== 4) throw new Error("scheduled cursor occurrences were not created");
  await db.insert(leagueOccurrenceBillingTerms).values(occurrences.map((occurrence, index) => ({
    organizationId,
    leagueId,
    occurrenceId: occurrence.id,
    purpose: "league_weekly_fee" as const,
    obligationPolicy: "eligible_bowlers" as const,
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: index + 1,
    version: 1,
    state: "published" as const,
    publishedAt: "2032-01-01T00:00:00.000Z",
    publishedByUserId: actor.id,
    publicationCommandId: publicationCommand.id,
  })));
  await db.transaction(async (tx) => {
    await persistCanonicalCollectionGroupsInTransaction(tx, {
      organizationId,
      leagueId,
      actorUserId: actor.id,
      generationRunId: run.id,
      generationRunSourceScheduleRevision: 1,
      sourceScheduleRevision: 1,
      doublePayDates: ["2032-01-05", "2032-01-19"],
      idempotencyKey: `scheduled-cursor-groups-${Math.random()}`,
      reason: "Persist scheduled cursor test grouping",
    });
  });
  await db.update(leagues).set({ canonicalScheduleRevision: 1 })
    .where(eq(leagues.id, leagueId));
  const trigger = occurrences[0];
  const paired = occurrences[1];
  const following = occurrences[2];
  if (!trigger || !paired || !following) throw new Error("scheduled cursor occurrence identity is incomplete");
  return {
    triggerId: trigger.id,
    pairedId: paired.id,
    followingId: following.id,
    actorUserId: actor.id,
  };
}

async function cancelCursorOccurrence(input: {
  leagueId: number;
  occurrenceId: string;
  actorUserId: number;
  key: string;
  now?: Date;
}): Promise<void> {
  const request = {
    organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: "cancel" as const,
    idempotencyKey: input.key,
    requestFingerprint: "",
    reason: "Cancel exact canonical collection member",
    occurrenceId: input.occurrenceId,
    now: (input.now ?? dueNow).toISOString(),
  };
  await cancelOccurrence({
    ...request,
    requestFingerprint: buildCanonicalScheduleCommandFingerprint(request),
  });
}

beforeAll(async () => {
  const [leftover] = await db.select({ id: organizations.id })
    .from(organizations).where(eq(organizations.slug, slug)).limit(1);
  if (leftover) await deleteOrganization(leftover.id);
  const [organization] = await db.insert(organizations).values({
    name: "Scheduled Ledger Cutover",
    slug,
  }).returning();
  if (!organization) throw new Error("organization fixture was not created");
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({
    name: "Scheduled Ledger Square Location",
    organizationId,
    squareCredentials: {
      appId: "sandbox-app",
      accessToken: ["fixture", "access", "value"].join("-"),
      locationId: "SQUARE_LOCATION_TEST",
    },
  }).returning();
  if (!location) throw new Error("location fixture was not created");
  locationId = location.id;
});

afterAll(async () => {
  if (organizationId) {
    await db.delete(canonicalCollectionGroupMemberRevisions).where(eq(canonicalCollectionGroupMemberRevisions.organizationId, organizationId));
    await db.delete(canonicalCollectionGroupRevisions).where(eq(canonicalCollectionGroupRevisions.organizationId, organizationId));
    await db.delete(canonicalCollectionGroupMembers).where(eq(canonicalCollectionGroupMembers.organizationId, organizationId));
    await db.delete(canonicalCollectionGroups).where(eq(canonicalCollectionGroups.organizationId, organizationId));
    await deleteOrganization(organizationId);
  }
});

describe("scheduled payment ledger cutover PostgreSQL behavior", () => {
  it("claims the dispatch cutoff once per lease token", async () => {
    const { schedule } = await createSchedule();
    const prepared = await prepareScheduledPaymentCycle({ paymentScheduleId: schedule.id, billingCycleAt: cycleAt, now: dueNow });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("scheduled operation was not prepared");
    const leased = await acquirePaymentOperationLease({ organizationId, operationId: prepared.operation.id, leaseOwner: "cutoff-regression", leaseDurationMs: 300_000, now: dueNow });
    if (!leased?.leaseToken) throw new Error("scheduled operation was not leased");
    expect(await acquireScheduledPaymentOperationDispatchCutoff({ organizationId, operationId: leased.id, leaseToken: leased.leaseToken, now: dueNow })).toBe(true);
    expect(await acquireScheduledPaymentOperationDispatchCutoff({ organizationId, operationId: leased.id, leaseToken: leased.leaseToken, now: dueNow })).toBe(false);
  });

  it("keeps automatic provider execution dormant in PR1", async () => {
    const { schedule } = await createSchedule();
    const prepared = await prepareScheduledPaymentCycle({ paymentScheduleId: schedule.id, billingCycleAt: cycleAt, now: dueNow });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("scheduled operation was not prepared");
    const provider = new DeterministicSquareProvider(locationId);
    const executor = new ScheduledPaymentOperationExecutor({ now: () => dueNow, leaseOwner: "pr1-dormant-worker", getProvider: async () => provider });
    await executor.handleWake({ kind: "operation", organizationId, operationId: prepared.operation.id, operationType: "scheduled_charge", status: prepared.operation.status, attemptCount: prepared.operation.attemptCount, dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString() });
    await expect(getPaymentOperationForOrganization(organizationId, prepared.operation.id)).resolves.toMatchObject({ status: "pending" });
    expect(provider.requests).toHaveLength(0);
  });

  it.skip("fails closed on tenant-scoped Square seller-location drift before dispatch", async () => {
    const { schedule } = await createSchedule();
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("drift operation was not prepared");
    const provider = new DeterministicSquareProvider(locationId);
    await db.update(locations).set({
      squareCredentials: {
        appId: "sandbox-app",
        accessToken: ["fixture", "access", "value"].join("-"),
        locationId: "SQUARE_LOCATION_DRIFTED",
      },
    }).where(eq(locations.id, locationId));
    try {
      const executor = new ScheduledPaymentOperationExecutor({
        now: () => dueNow,
        leaseOwner: "scheduled-location-drift-worker",
        getProvider: async () => provider,
      });
      await executor.handleWake({
        kind: "operation",
        organizationId,
        operationId: prepared.operation.id,
        operationType: "scheduled_charge",
        status: prepared.operation.status,
        attemptCount: prepared.operation.attemptCount,
        dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString(),
      });
      const operation = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
      expect(operation).toMatchObject({ status: "failed_terminal", errorCode: "PROVIDER_LOCATION_DRIFT" });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await db.update(locations).set({
        squareCredentials: {
          appId: "sandbox-app",
          accessToken: ["fixture", "access", "value"].join("-"),
          locationId: "SQUARE_LOCATION_TEST",
        },
      }).where(eq(locations.id, locationId));
    }
  });

  it("advances a canonical trigger to its paired occurrence and then the exact following UUID", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: cycleAt });
    const cursor = await createCanonicalCursorEvidence(league.id);
    await db.update(paymentSchedules).set({ nextOccurrenceId: cursor.triggerId })
      .where(eq(paymentSchedules.id, schedule.id));
    const first = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in first) || !first.operation) throw new Error("canonical trigger was not prepared");
    expect(first.operation.triggerOccurrenceId).toBe(cursor.triggerId);
    const afterTrigger = await db.select().from(paymentSchedules).where(eq(paymentSchedules.id, schedule.id)).then((rows) => rows[0]);
    expect(afterTrigger?.nextOccurrenceId).toBe(cursor.pairedId);
    expect(afterTrigger?.nextPaymentDate).toContain("2032-01-12 18:30:00");
    const paired = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: afterTrigger?.nextPaymentDate ?? "",
      now: new Date("2032-01-13T00:00:00.000Z"),
    });
    expect(paired.kind).toBe("skipped");
    if (paired.kind !== "skipped") throw new Error("paired canonical cycle did not skip");
    expect(paired.schedule.nextOccurrenceId).toBe(cursor.followingId);
    expect(paired.schedule.nextPaymentDate).toContain("2032-01-19 18:30:00");
  });

  it.skip("cancels a prepared shared trigger operation when its paired member is cancelled", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: cycleAt, combined: true });
    const cursor = await createCanonicalCursorEvidence(league.id);
    await db.update(paymentSchedules).set({ nextOccurrenceId: cursor.triggerId })
      .where(eq(paymentSchedules.id, schedule.id));
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("shared trigger operation was not prepared");
    expect(prepared.operation.amountMinor).toBe(8_000);
    expect(await db.select().from(scheduledPaymentOperationAllocations)
      .where(eq(scheduledPaymentOperationAllocations.operationId, prepared.operation.id))).toHaveLength(2);
    await cancelCursorOccurrence({
      leagueId: league.id,
      occurrenceId: cursor.pairedId,
      actorUserId: cursor.actorUserId,
      key: `cancel-paired-before-dispatch-${Math.random()}`,
    });
    const cancelled = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(cancelled).toMatchObject({ status: "canceled", dispatchClaimedAt: null });
    const provider = new DeterministicSquareProvider(locationId);
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => dueNow,
      leaseOwner: "paired-cancel-before-dispatch",
      getProvider: async () => provider,
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: prepared.operation.status,
      attemptCount: prepared.operation.attemptCount,
      dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString(),
    });
    expect(provider.requests).toHaveLength(0);
  });

  it.skip("retains claim-first scheduled success as review evidence after trigger/paired cancellation", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: cycleAt });
    const cursor = await createCanonicalCursorEvidence(league.id);
    await db.update(paymentSchedules).set({ nextOccurrenceId: cursor.triggerId })
      .where(eq(paymentSchedules.id, schedule.id));
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("claim-first operation was not prepared");
    const provider = new DeterministicSquareProvider(locationId);
    let cancelledAfterProviderSuccess = false;
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => dueNow,
      leaseOwner: "paired-cancel-after-provider-success",
      getProvider: async () => provider,
      finalizeSuccess: async (input) => {
        if (!cancelledAfterProviderSuccess) {
          cancelledAfterProviderSuccess = true;
          await cancelCursorOccurrence({
            leagueId: league.id,
            occurrenceId: cursor.pairedId,
            actorUserId: cursor.actorUserId,
            key: `cancel-paired-after-provider-success-${Math.random()}`,
          });
        }
        return finalizePaymentOperationSuccess(input);
      },
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: prepared.operation.status,
      attemptCount: prepared.operation.attemptCount,
      dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString(),
    });
    const completed = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(completed).toMatchObject({
      status: "reconciliation_required",
      providerObjectId: "square-payment-1",
      errorCode: "CANCELLATION_REVIEW",
    });
    expect(provider.requests).toHaveLength(1);
    const linkedPayments = await db.select({ id: payments.id }).from(payments)
      .where(eq(payments.paymentOperationId, prepared.operation.id));
    expect(linkedPayments).toHaveLength(1);
    const linkedPayment = linkedPayments[0];
    if (!linkedPayment) throw new Error("claim-first provider payment was not linked");
    const [storedSchedule] = await db.select().from(paymentSchedules).where(eq(paymentSchedules.id, schedule.id));
    expect(storedSchedule?.active).toBe(true);
  });

  it.skip("moves a persisted shared success to cancellation review when the paired member is cancelled", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: cycleAt });
    const cursor = await createCanonicalCursorEvidence(league.id);
    await db.update(paymentSchedules).set({ nextOccurrenceId: cursor.triggerId })
      .where(eq(paymentSchedules.id, schedule.id));
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("persisted pair operation was not prepared");
    const provider = new DeterministicSquareProvider(locationId);
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => dueNow,
      leaseOwner: "paired-persisted-success",
      getProvider: async () => provider,
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: prepared.operation.status,
      attemptCount: prepared.operation.attemptCount,
      dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString(),
    });
    const succeeded = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(succeeded?.status).toBe("succeeded");
    if (!succeeded?.completedAt) throw new Error("persisted pair success has no completion timestamp");
    await cancelCursorOccurrence({
      leagueId: league.id,
      occurrenceId: cursor.pairedId,
      actorUserId: cursor.actorUserId,
      key: `cancel-paired-after-persisted-success-${Math.random()}`,
      now: new Date("2032-01-01T00:00:00.000Z"),
    });
    const reviewed = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(reviewed).toMatchObject({ status: "reconciliation_required", errorCode: "CANCELLATION_REVIEW" });
    expect(reviewed?.completedAt).toBe(succeeded.completedAt);
    expect(Date.parse(reviewed?.updatedAt ?? "invalid")).toBeGreaterThanOrEqual(Date.parse(reviewed?.completedAt ?? "invalid"));
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, prepared.operation.id))).toHaveLength(1);
  });

  it.skip("moves a persisted shared success to cancellation review when the trigger is cancelled", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: cycleAt });
    const cursor = await createCanonicalCursorEvidence(league.id);
    await db.update(paymentSchedules).set({ nextOccurrenceId: cursor.triggerId })
      .where(eq(paymentSchedules.id, schedule.id));
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared) || !prepared.operation) throw new Error("persisted trigger operation was not prepared");
    const provider = new DeterministicSquareProvider(locationId);
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => dueNow,
      leaseOwner: "trigger-persisted-success",
      getProvider: async () => provider,
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: prepared.operation.status,
      attemptCount: prepared.operation.attemptCount,
      dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString(),
    });
    const succeeded = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(succeeded?.status).toBe("succeeded");
    if (!succeeded?.completedAt) throw new Error("persisted trigger success has no completion timestamp");
    await cancelCursorOccurrence({
      leagueId: league.id,
      occurrenceId: cursor.triggerId,
      actorUserId: cursor.actorUserId,
      key: `cancel-trigger-after-persisted-success-${Math.random()}`,
      now: new Date("2032-01-01T00:00:00.000Z"),
    });
    const reviewed = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(reviewed).toMatchObject({ status: "reconciliation_required", errorCode: "CANCELLATION_REVIEW" });
    expect(reviewed?.completedAt).toBe(succeeded.completedAt);
    expect(Date.parse(reviewed?.updatedAt ?? "invalid")).toBeGreaterThanOrEqual(Date.parse(reviewed?.completedAt ?? "invalid"));
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, prepared.operation.id))).toHaveLength(1);
  });

  it("prepares one exact cycle under two concurrent workers", async () => {
    const { schedule } = await createSchedule();
    const results = await Promise.all([
      prepareScheduledPaymentCycle({ paymentScheduleId: schedule.id, billingCycleAt: cycleAt, now: dueNow }),
      prepareScheduledPaymentCycle({ paymentScheduleId: schedule.id, billingCycleAt: cycleAt, now: dueNow }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["existing", "prepared"]);
    expect(await db.select().from(paymentOperations)
      .where(eq(paymentOperations.paymentScheduleId, schedule.id))).toHaveLength(1);
  });

  it("serializes scheduled preparation and league PATCH without a lock inversion", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: cycleAt });
    let locationReady!: () => void;
    const ready = new Promise<void>((resolve) => { locationReady = resolve; });
    let releaseLocation!: () => void;
    const release = new Promise<void>((resolve) => { releaseLocation = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: locations.id })
        .from(locations)
        .where(eq(locations.id, locationId))
        .for("update");
      locationReady();
      await release;
    });
    await ready;

    // Queue PATCH behind the held location row before starting preparation.
    // Under the former location -> league order, preparation then owns the
    // league advisory lock and waits on this row while PATCH owns the row and
    // waits on that advisory lock: PostgreSQL reliably reports 40P01.
    const patch = updateLeague(league.id, { locationId });
    let queued = false;
    for (let attempt = 0; attempt < 200 && !queued; attempt += 1) {
      const waiting = await getTestPool().query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE '%locations%'
          AND query ILIKE '%for update%'
      `);
      queued = Number(waiting.rows[0]?.count ?? 0) > 0;
      if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!queued) {
      releaseLocation();
      await Promise.allSettled([patch, holder]);
    }
    expect(queued).toBe(true);
    const preparation = prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLocation();
    const [patchResult, preparationResult, holderResult] = await Promise.allSettled([patch, preparation, holder]);
    expect(patchResult.status).toBe("fulfilled");
    expect(preparationResult.status).toBe("fulfilled");
    expect(holderResult.status).toBe("fulfilled");
    if (patchResult.status === "fulfilled") expect(patchResult.value).toMatchObject({ id: league.id, locationId });
    if (preparationResult.status === "fulfilled") expect(preparationResult.value.kind).toBe("prepared");
    expect(await db.select().from(paymentOperations).where(eq(paymentOperations.paymentScheduleId, schedule.id))).toHaveLength(1);
  });

  it("serializes organization teardown with scheduled preparation without 40P01 or provider effect", async () => {
    const [teardownOrganization] = await db.insert(organizations).values({
      name: `Scheduled teardown race ${Math.random()}`,
      slug: `scheduled-teardown-race-${Math.random()}`,
    }).returning();
    const [teardownLocation] = await db.insert(locations).values({
      name: "Scheduled teardown race location",
      organizationId: teardownOrganization.id,
      squareCredentials: { appId: "sandbox-app", accessToken: "test-token", locationId: "SQUARE_LOCATION_TEST" },
    }).returning();
    const { schedule } = await createSchedule({
      organizationIdOverride: teardownOrganization.id,
      locationIdOverride: teardownLocation.id,
      nextPaymentDate: cycleAt,
    });
    const provider = new DeterministicSquareProvider(teardownLocation.id);
    const blocker = await getTestPool().connect();
    let teardown: Promise<void> | undefined;
    let preparation: Promise<Awaited<ReturnType<typeof prepareScheduledPaymentCycle>>> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM payment_schedules WHERE id = $1 FOR UPDATE`,
        [schedule.id],
      );

      // Queue teardown behind the held schedule row. This is the first lock
      // in deleteOrganization's schedule -> league -> location order, so the
      // later preparation waiter must queue behind the same row rather than
      // forming a lock-order cycle with teardown.
      teardown = deleteOrganization(teardownOrganization.id);
      let teardownWaiting = false;
      for (let attempt = 0; attempt < 200 && !teardownWaiting; attempt += 1) {
        const waiting = await getTestPool().query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%payment_schedules%'
            AND query ILIKE '%league_id%'
            AND query ILIKE '%order by%'
            AND query ILIKE '%for update%'
        `);
        teardownWaiting = Number(waiting.rows[0]?.count ?? 0) > 0;
        if (!teardownWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(teardownWaiting).toBe(true);

      // Start preparation only after teardown is observed waiting. Both
      // contenders now wait on the known blocker, making the release and the
      // resulting teardown-first outcome deterministic.
      preparation = prepareScheduledPaymentCycle({
        paymentScheduleId: schedule.id,
        billingCycleAt: cycleAt,
        now: dueNow,
      });
      let contendersWaiting = false;
      for (let attempt = 0; attempt < 200 && !contendersWaiting; attempt += 1) {
        const waiting = await getTestPool().query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%payment_schedules%'
            AND query ILIKE '%for update%'
        `);
        contendersWaiting = Number(waiting.rows[0]?.count ?? 0) >= 2;
        if (!contendersWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(contendersWaiting).toBe(true);
      await blocker.query("COMMIT");

      const [teardownResult, preparationResult] = await Promise.allSettled([teardown, preparation]);
      expect(teardownResult.status).toBe("fulfilled");
      expect(preparationResult.status).toBe("fulfilled");
      if (preparationResult.status === "fulfilled") {
        expect(preparationResult.value.kind).toBe("stale");
      }
      expect(await db.select().from(paymentOperations)
        .where(eq(paymentOperations.paymentScheduleId, schedule.id))).toHaveLength(0);
      expect(provider.requests).toHaveLength(0);
      expect(provider.providerEffects.size).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      const pending: Array<Promise<unknown>> = [];
      if (teardown) pending.push(teardown);
      if (preparation) pending.push(preparation);
      await Promise.allSettled(pending);
    }
  });

  it("gives an upfront cycle durable identity before deactivating its schedule", async () => {
    const { schedule } = await createSchedule({ paymentMode: "upfront", frequency: "upfront" });
    const result = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    expect(result.kind).toBe("prepared");
    const [stored] = await db.select().from(paymentSchedules)
      .where(eq(paymentSchedules.id, schedule.id));
    expect(stored?.active).toBe(false);
    expect(await db.select().from(paymentOperations)
      .where(eq(paymentOperations.paymentScheduleId, schedule.id))).toHaveLength(1);
  });

  it("recovers when a legacy worker dies after lock ownership but before Square", async () => {
    const { schedule } = await createSchedule();
    const deadWorkerLock = await acquireLegacyScheduledCycleLock(schedule.id, cycleAt);
    if (!deadWorkerLock) throw new Error("dead-worker fixture did not acquire the lock");
    expect(await acquireLegacyScheduledCycleLock(schedule.id, cycleAt)).toBeUndefined();
    deadWorkerLock.client.release(true);

    const restartedWorkerLock = await acquireLegacyScheduledCycleLock(schedule.id, cycleAt);
    expect(restartedWorkerLock).toBeDefined();
    await restartedWorkerLock?.release();
  });

  it("serializes legacy-versus-ledger ownership on the same exact cycle", async () => {
    const { schedule } = await createSchedule();
    const legacyLock = await acquireLegacyScheduledCycleLock(schedule.id, cycleAt);
    if (!legacyLock) throw new Error("legacy contention fixture did not acquire the lock");
    let preparationSettled = false;
    const preparation = prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    }).finally(() => { preparationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(preparationSettled).toBe(false);

    await db.update(paymentSchedules).set({
      nextPaymentDate: "2032-01-12T18:30:00.000Z",
      lastPaymentDate: cycleAt,
    }).where(eq(paymentSchedules.id, schedule.id));
    await legacyLock.release();
    expect((await preparation).kind).toBe("stale");
    expect(await db.select().from(paymentOperations)
      .where(eq(paymentOperations.paymentScheduleId, schedule.id))).toHaveLength(0);
  });

  it("fences archive-first and callback-first cycle races without provider dispatch", async () => {
    const callbackOwned = await createSchedule({ nextPaymentDate: cycleAt });
    const callbackLock = await acquireLegacyScheduledCycleLock(callbackOwned.schedule.id, cycleAt);
    if (!callbackLock) throw new Error("callback-first fixture did not acquire the cycle lock");
    let archiveSettled = false;
    const callbackFirstArchive = archiveLeague(callbackOwned.league.id, organizationId).finally(() => { archiveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(archiveSettled).toBe(false);
    // A legacy callback cannot acquire the exact cycle while archive waits for
    // the callback's already-owned lock; releasing it lets archive fence the
    // schedule before its transaction commits.
    expect(await acquireLegacyScheduledCycleLock(callbackOwned.schedule.id, cycleAt)).toBeUndefined();
    await callbackLock.release();
    await expect(callbackFirstArchive).resolves.toMatchObject({ active: false, id: callbackOwned.league.id });

    const archiveOwned = await createSchedule({ nextPaymentDate: "2032-02-05T18:30:00.000Z" });
    const leagueBlocker = await getTestPool().connect();
    let archiveFirst: Promise<unknown> | undefined;
    try {
      await leagueBlocker.query("BEGIN");
      await leagueBlocker.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [organizationId, archiveOwned.league.id]);
      archiveFirst = archiveLeague(archiveOwned.league.id, organizationId);
      let archiveWaiting = 0;
      for (let attempt = 0; attempt < 200 && archiveWaiting < 1; attempt += 1) {
        const waiting = await leagueBlocker.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1::oid
            AND objid = $2::oid
            AND granted = false
        `, [organizationId, archiveOwned.league.id]);
        archiveWaiting = Number(waiting.rows[0]?.count ?? 0);
        if (archiveWaiting < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(archiveWaiting).toBeGreaterThanOrEqual(1);
      // The archive holds the cycle fence while it waits on the league lock;
      // a callback therefore returns without entering provider code.
      expect(await acquireLegacyScheduledCycleLock(archiveOwned.schedule.id, archiveOwned.schedule.nextPaymentDate)).toBeUndefined();
      await leagueBlocker.query("COMMIT");
      await expect(archiveFirst).resolves.toMatchObject({ active: false, id: archiveOwned.league.id });
    } finally {
      await leagueBlocker.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([archiveFirst].filter((value): value is Promise<unknown> => value !== undefined));
      leagueBlocker.release();
    }
  });

  it("fences schedule preparation and all schedule writers after a repeated archive", async () => {
    const { schedule, league } = await createSchedule({ nextPaymentDate: "2032-03-05T18:30:00.000Z" });
    await expect(archiveLeague(league.id, organizationId)).resolves.toMatchObject({ active: false, id: league.id });
    await expect(prepareScheduledPaymentCycle({ paymentScheduleId: schedule.id, billingCycleAt: schedule.nextPaymentDate, now: dueNow }))
      .resolves.toMatchObject({ kind: "stale" });
    await expect(updatePaymentScheduleFields(schedule.id, { amount: 2_100 })).rejects.toThrow(/archived|read-only/i);
    await expect(updatePaymentScheduleCard(schedule.bowlerId, schedule.leagueId, "ccof:archived-card"))
      .rejects.toThrow(/archived|read-only/i);
    await expect(deactivatePaymentSchedule(schedule.id, "late archive writer"))
      .rejects.toThrow(/archived|read-only/i);
    await expect(archiveLeague(league.id, organizationId)).resolves.toMatchObject({ active: false, id: league.id });
    const [stored] = await db.select().from(paymentSchedules).where(eq(paymentSchedules.id, schedule.id));
    expect(stored).toMatchObject({ active: false, cancelReason: "league_archived" });
  });

  it("rechecks active canonical authority for public payment mutation while retaining receipt reconciliation", async () => {
    const { league, bowler } = await createSchedule({ nextPaymentDate: "2032-04-05T18:30:00.000Z" });
    const [payment] = await db.insert(payments).values({
      bowlerId: bowler.id,
      leagueId: league.id,
      amount: 2_000,
      weekOf: "2032-04-05T18:30:00.000Z",
      status: "paid",
      type: "cash",
    }).returning();
    if (!payment) throw new Error("payment authority fixture was not created");
    await archiveLeague(league.id, organizationId);
    await expect(updatePaymentReceiptCacheForOrganization(payment.id, organizationId, {
      receiptUrl: "https://square.example.test/archived-receipt",
      receiptNumber: "ARCHIVED-RECEIPT",
    })).resolves.toMatchObject({ id: payment.id, receiptNumber: "ARCHIVED-RECEIPT" });
    await expect(updatePayment(payment.id, { notes: "late public edit" })).rejects.toThrow(/archived|read-only/i);
    await expect(deletePayment(payment.id)).rejects.toThrow(/archived|read-only/i);
  });

  it("allows a later cycle after hard decline while blocking the owned cycle", async () => {
    const { schedule } = await createSchedule();
    const first = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in first)) throw new Error("first cycle was not prepared");
    const lease = await acquirePaymentOperationLease({
      organizationId,
      operationId: first.operation.id,
      leaseOwner: "hard-decline-worker",
      leaseDurationMs: 60_000,
      now: dueNow,
    });
    if (!lease?.leaseToken) throw new Error("hard-decline lease was not acquired");
    await recordPaymentOperationActionRequired({
      organizationId,
      operationId: lease.id,
      leaseToken: lease.leaseToken,
      errorCode: "CARD_DECLINED",
      now: new Date(dueNow.getTime() + 1),
    });
    expect(await getLegacyScheduledPaymentCycleBlock({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
    })).toMatchObject({ scope: "exact_cycle", status: "action_required" });

    const [advanced] = await db.select().from(paymentSchedules)
      .where(eq(paymentSchedules.id, schedule.id));
    if (!advanced) throw new Error("advanced schedule was not found");
    expect(await getLegacyScheduledPaymentCycleBlock({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: advanced.nextPaymentDate,
    })).toBeUndefined();
    const next = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: advanced.nextPaymentDate,
      now: new Date("2032-02-01T00:00:00.000Z"),
    });
    expect(next.kind).toBe("prepared");
  });

  it.skip("reuses the legacy Square effect after provider success and pre-finalization death", async () => {
    const { schedule } = await createSchedule({ order: true });
    const provider = new DeterministicSquareProvider(locationId);
    const logical = buildPaymentOperationIdentity({
      organizationId,
      operationType: "scheduled_charge",
      targetKey: `payment-schedule:${schedule.id}`,
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      amountMinor: schedule.amount,
      currency: "USD",
      providerName: "square",
    });
    const legacyIdentity = buildSquarePaymentRequestIdentity({
      providerIdempotencyKey: logical.providerIdempotencyKey,
      requestKind: "order",
    });
    const legacyLock = await acquireLegacyScheduledCycleLock(schedule.id, cycleAt);
    if (!legacyLock) throw new Error("legacy crash fixture did not acquire the lock");
    const original = await provider.createOrderWithPayment(
      schedule.paymentCardId,
      schedule.amount,
      [{ catalogObjectId: "catalog-lineage-variation", quantity: "1" }],
      false,
      undefined,
      undefined,
      legacyIdentity,
    );
    legacyLock.client.release(true);

    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared)) throw new Error("ledger recovery cycle was not prepared");
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => dueNow,
      leaseOwner: "legacy-crash-ledger-recovery",
      getProvider: async () => provider,
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: prepared.operation.status,
      attemptCount: prepared.operation.attemptCount,
      dueAt: prepared.operation.nextAttemptAt ?? dueNow.toISOString(),
    });

    const [completed] = await db.select().from(paymentOperations)
      .where(eq(paymentOperations.id, prepared.operation.id));
    const linked = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, prepared.operation.id));
    expect(completed?.status).toBe("succeeded");
    expect(completed?.providerObjectId).toBe(original.id);
    expect(linked).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toBe(provider.requests[0]);
    expect(provider.providerEffects.size).toBe(1);
  });

  it.skip("recovers an ambiguous provider result with the same keys", async () => {
    expectErrorLog(/Scheduled operation provider attempt recorded/);
    const { schedule } = await createSchedule();
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared)) throw new Error("ambiguous cycle was not prepared");
    let clock = dueNow;
    const provider = new DeterministicSquareProvider(locationId);
    provider.unknownAfterFirstEffect = true;
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => clock,
      leaseOwner: "ambiguous-result-worker",
      getProvider: async () => provider,
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: "pending",
      attemptCount: 0,
      dueAt: prepared.operation.nextAttemptAt ?? clock.toISOString(),
    });
    const uncertain = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(uncertain?.status).toBe("provider_unknown");
    if (!uncertain?.nextAttemptAt) throw new Error("unknown result has no recovery time");
    const [advancedSchedule] = await db.select().from(paymentSchedules)
      .where(eq(paymentSchedules.id, schedule.id));
    if (!advancedSchedule) throw new Error("advanced ambiguous schedule was not found");
    expect(await getLegacyScheduledPaymentCycleBlock({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: advancedSchedule.nextPaymentDate,
    })).toMatchObject({ scope: "uncertain", status: "provider_unknown" });
    clock = new Date(`${uncertain.nextAttemptAt}Z`);

    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: uncertain.id,
      operationType: "scheduled_charge",
      status: uncertain.status,
      attemptCount: uncertain.attemptCount,
      dueAt: uncertain.nextAttemptAt,
    });
    expect((await getPaymentOperationForOrganization(organizationId, uncertain.id))?.status)
      .toBe("succeeded");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toBe(provider.requests[0]);
    expect(provider.providerEffects.size).toBe(1);
  });

  it.skip("keeps the lease after local finalization failure and recovers without a second effect", async () => {
    expectErrorLog(/Scheduled operation local finalization failed/);
    const { schedule } = await createSchedule();
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared)) throw new Error("finalization cycle was not prepared");
    let clock = dueNow;
    let finalizeCalls = 0;
    const provider = new DeterministicSquareProvider(locationId);
    provider.beforeEffect = async () => {
      await db.transaction(async (tx) => {
        await tx.select({ id: paymentOperations.id })
          .from(paymentOperations)
          .where(eq(paymentOperations.id, prepared.operation.id))
          .for("update", { noWait: true });
      });
    };
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => clock,
      leaseOwner: "local-finalization-recovery-worker",
      getProvider: async () => provider,
      finalizeSuccess: async (input) => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error("deterministic local finalization failure");
        return finalizePaymentOperationSuccess(input);
      },
    });
    await expect(executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: prepared.operation.id,
      operationType: "scheduled_charge",
      status: "pending",
      attemptCount: 0,
      dueAt: prepared.operation.nextAttemptAt ?? clock.toISOString(),
    })).rejects.toThrow("deterministic local finalization failure");
    const leased = await getPaymentOperationForOrganization(organizationId, prepared.operation.id);
    expect(leased?.status).toBe("leased");
    if (!leased?.leaseExpiresAt) throw new Error("failed finalization did not retain its lease");
    clock = new Date(`${leased.leaseExpiresAt}Z`);

    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: leased.id,
      operationType: "scheduled_charge",
      status: leased.status,
      attemptCount: leased.attemptCount,
      dueAt: leased.leaseExpiresAt,
    });
    expect((await getPaymentOperationForOrganization(organizationId, leased.id))?.status)
      .toBe("succeeded");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toBe(provider.requests[0]);
    expect(provider.providerEffects.size).toBe(1);
  });

  it.skip("recovers a worker death before provider dispatch after lease expiry", async () => {
    const { schedule } = await createSchedule();
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: cycleAt,
      now: dueNow,
    });
    if (!("operation" in prepared)) throw new Error("pre-provider crash cycle was not prepared");
    const abandoned = await acquirePaymentOperationLease({
      organizationId,
      operationId: prepared.operation.id,
      leaseOwner: "dead-before-provider-worker",
      leaseDurationMs: 1_000,
      now: dueNow,
    });
    if (!abandoned?.leaseExpiresAt) throw new Error("abandoned lease was not acquired");
    const clock = new Date(`${abandoned.leaseExpiresAt}Z`);
    const provider = new DeterministicSquareProvider(locationId);
    const executor = new ScheduledPaymentOperationExecutor({
      now: () => clock,
      leaseOwner: "restart-after-provider-worker-death",
      getProvider: async () => provider,
    });
    await executor.handleWake({
      kind: "operation",
      organizationId,
      operationId: abandoned.id,
      operationType: "scheduled_charge",
      status: abandoned.status,
      attemptCount: abandoned.attemptCount,
      dueAt: abandoned.leaseExpiresAt,
    });
    const completed = await getPaymentOperationForOrganization(organizationId, abandoned.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.leaseRecoveryCount).toBe(1);
    expect(provider.requests).toHaveLength(1);
  });

  it("does not wake archived legacy schedules after the roster cutover", async () => {
    const future = await createSchedule({ nextPaymentDate: "2033-01-01T00:00:00.000Z" });
    const wake = await getNextPaymentOperationWake();
    // This worker still wakes retained refund/interactive ledger operations
    // created by other suites sharing the disposable database.  The cutover
    // contract is specifically that an archived legacy schedule cannot be a
    // wake candidate; assert that boundary without masking unrelated ledger
    // work.
    if (wake) {
      expect(wake.kind).toBe("operation");
      if (wake.kind === "operation") {
        expect(wake.operationType).not.toBe("scheduled_charge");
      }
    }

    const planRows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN ${buildNextPaymentOperationWakeQuery()}`);
    });
    const plan = planRows.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    expect(plan).not.toContain("payment_schedules");
    expect(plan).toMatch(/payment_operations_(due_retry|expired_lease)_idx/);
    await db.update(paymentSchedules).set({ active: false })
      .where(eq(paymentSchedules.id, future.schedule.id));
  });
});
