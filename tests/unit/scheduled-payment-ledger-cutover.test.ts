import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  bowlers,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  payments,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { expectErrorLog } from "../helpers/expected-error-logs";
import { deleteOrganization } from "../../server/storage/organizations";
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
import {
  buildPaymentOperationIdentity,
  buildSquarePaymentRequestIdentity,
} from "../../server/services/payment-operation-idempotency";
import { ScheduledPaymentOperationExecutor } from "../../server/services/scheduled-payment-operation-executor";
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
} = {}) {
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
    organizationId,
    locationId,
  }).returning();
  if (!league) throw new Error("league fixture was not created");
  const [bowler] = await db.insert(bowlers).values({
    name: `Scheduled Ledger Bowler ${Math.random()}`,
    email: `scheduled-${Math.random()}@example.test`,
    paymentCustomerId: `customer-${Math.random()}`,
    organizationId,
  }).returning();
  if (!bowler) throw new Error("bowler fixture was not created");
  const [schedule] = await db.insert(paymentSchedules).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    frequency: input.frequency ?? "weekly",
    amount: 2_000,
    nextPaymentDate: input.nextPaymentDate ?? cycleAt,
    paymentCardId: "ccof:scheduled-ledger-test",
  }).returning();
  if (!schedule) throw new Error("schedule fixture was not created");
  return { schedule, league, bowler };
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
      accessToken: "deterministic-test-token",
      locationId: "SQUARE_LOCATION_TEST",
    },
  }).returning();
  if (!location) throw new Error("location fixture was not created");
  locationId = location.id;
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
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

  it("reuses the legacy Square effect after provider success and pre-finalization death", async () => {
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

  it("recovers an ambiguous provider result with the same keys", async () => {
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

  it("keeps the lease after local finalization failure and recovers without a second effect", async () => {
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

  it("recovers a worker death before provider dispatch after lease expiry", async () => {
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

  it("chooses schedule or operation work and uses both partial indexes", async () => {
    const future = await createSchedule({ nextPaymentDate: "2033-01-01T00:00:00.000Z" });
    const wake = await getNextPaymentOperationWake();
    expect(wake).toBeDefined();

    const planRows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN ${buildNextPaymentOperationWakeQuery()}`);
    });
    const plan = planRows.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    expect(plan).toContain("payment_schedules_active_next_payment_idx");
    expect(plan).toMatch(/payment_operations_(due_retry|expired_lease)_idx/);
    await db.update(paymentSchedules).set({ active: false })
      .where(eq(paymentSchedules.id, future.schedule.id));
  });
});
