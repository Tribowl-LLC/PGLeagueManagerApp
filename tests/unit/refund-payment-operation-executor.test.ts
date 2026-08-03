import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  bowlers,
  leagues,
  locations,
  organizations,
  paymentOperations,
  payments,
  refundPaymentOperationSnapshots,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { expectErrorLog } from "../helpers/expected-error-logs";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  acquirePaymentOperationLease,
  finalizeRefundPaymentOperationSuccess,
  getPaymentOperationForOrganization,
  PaymentOperationImmutableMismatchError,
  PaymentOperationInvalidTransitionError,
  REFUND_TARGET_PREFIX,
} from "../../server/storage/payment-operations";
import {
  prepareRefundPaymentOperation,
} from "../../server/services/refund-payment-operation-preparation";
import { RefundPaymentOperationExecutor } from "../../server/services/refund-payment-operation-executor";
import { PaymentProviderError, ProviderNotConfiguredError } from "../../server/services/payment-errors";
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
const fixedNow = new Date("2033-03-01T00:00:00.000Z");
const suffix = process.env.VITEST_POOL_ID ?? "0";

interface Fixture {
  organizationId: number;
  locationId: number;
  leagueId: number;
  bowlerId: number;
  actorUserId: number;
}

interface RefundCall {
  paymentId: string;
  amount: number;
  reason?: string;
  idempotencyKey?: string;
}

class ScriptedRefundProvider implements PaymentProvider {
  readonly providerName = "square";
  readonly refundCalls: RefundCall[] = [];
  readonly getRefundCalls: string[] = [];
  readonly effectsByKey = new Map<string, RefundResult>();
  refundOutcomes: Array<RefundResult | Error | "lost_completed"> = [];
  getOutcomes: Array<RefundResult | Error> = [];
  beforeRefund: (() => Promise<void>) | undefined;

  constructor(readonly locationId: number) {}

  async refundPayment(paymentId: string, amount: number, reason?: string, idempotencyKey?: string): Promise<RefundResult> {
    this.refundCalls.push({ paymentId, amount, reason, idempotencyKey });
    await this.beforeRefund?.();
    if (!idempotencyKey) throw new Error("durable refund key was not supplied");
    const replay = this.effectsByKey.get(idempotencyKey);
    if (replay) return { ...replay };
    const outcome = this.refundOutcomes.shift() ?? { refundId: `square-refund-${randomUUID()}`, status: "COMPLETED" };
    if (outcome instanceof Error) throw outcome;
    if (outcome === "lost_completed") {
      const completed = { refundId: `square-refund-${randomUUID()}`, status: "COMPLETED" };
      this.effectsByKey.set(idempotencyKey, completed);
      throw new PaymentProviderError("outcome unknown", "TRANSPORT_UNKNOWN", undefined, {
        disposition: "provider_unknown",
        providerCode: "TRANSPORT_UNKNOWN",
      });
    }
    this.effectsByKey.set(idempotencyKey, outcome);
    return { ...outcome };
  }

  async getRefund(refundId: string): Promise<RefundResult> {
    this.getRefundCalls.push(refundId);
    const outcome = this.getOutcomes.shift() ?? { refundId, status: "COMPLETED" };
    if (outcome instanceof Error) throw outcome;
    return { ...outcome };
  }

  async processPayment(): Promise<PaymentResult> { throw new Error("unexpected charge"); }
  async createOrderWithPayment(_sourceId: string, _amount: number, _lineItems: OrderLineItem[], _storeCard?: boolean, _customerId?: string, _buyerEmail?: string, _identity?: PaymentIdempotencyInput): Promise<PaymentResult> { throw new Error("unexpected charge"); }
  async saveCardOnFile(): Promise<SavedCard | null> { throw new Error("unexpected card save"); }
  async listCardsOnFile(): Promise<SavedCard[]> { return []; }
  async disableCard(): Promise<void> {}
  async createOrUpdateCustomer(): Promise<PaymentCustomer | null> { return null; }
  async getPayment(): Promise<PaymentVerification | null> { return null; }
  validateCardId(): boolean { return false; }
}

const slugs = [`refund-operation-a-${suffix}`, `refund-operation-b-${suffix}`] as const;
let fixtures: [Fixture, Fixture];

async function createFixture(index: 0 | 1): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `Refund Operation Organization ${index}`,
    slug: slugs[index],
  }).returning({ id: organizations.id });
  const [location] = await db.insert(locations).values({
    organizationId: organization.id,
    name: `Refund Operation Location ${index}`,
  }).returning({ id: locations.id });
  const [league] = await db.insert(leagues).values({
    name: `Refund Operation League ${index}`,
    seasonStart: "2033-01-01T00:00:00.000Z",
    seasonEnd: "2033-12-31T23:59:59.000Z",
    weekDay: "Monday",
    weeklyFee: 2_000,
    organizationId: organization.id,
    locationId: location.id,
  }).returning({ id: leagues.id });
  const [bowler] = await db.insert(bowlers).values({
    name: `Refund Operation Bowler ${index}`,
    organizationId: organization.id,
  }).returning({ id: bowlers.id });
  const [actor] = await db.insert(users).values({
    email: `refund-operation-admin-${index}-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: `Refund Operation Admin ${index}`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  return {
    organizationId: organization.id,
    locationId: location.id,
    leagueId: league.id,
    bowlerId: bowler.id,
    actorUserId: actor.id,
  };
}

async function createPaidPayment(fixture: Fixture, overrides: Partial<typeof payments.$inferInsert> = {}) {
  const [payment] = await db.insert(payments).values({
    bowlerId: fixture.bowlerId,
    leagueId: fixture.leagueId,
    amount: 2_000,
    lineageAmount: 1_000,
    prizeFundAmount: 1_000,
    weekOf: "2033-03-01T00:00:00.000Z",
    status: "paid",
    type: "square",
    providerPaymentId: `square-payment-${randomUUID()}`,
    ...overrides,
  }).returning();
  return payment;
}

async function prepare(fixture: Fixture, paymentId: number, reason: string | undefined = "Customer request") {
  return prepareRefundPaymentOperation({
    paymentId,
    reason,
    requestedByUserId: fixture.actorUserId,
    requestedByRole: "org_admin",
    requestedByOrganizationId: fixture.organizationId,
    now: fixedNow,
  });
}

function executor(fixture: Fixture, provider: ScriptedRefundProvider, overrides: {
  now?: () => Date;
  getProvider?: (locationId: number | null) => Promise<PaymentProvider>;
  finalizeSuccess?: typeof finalizeRefundPaymentOperationSuccess;
} = {}) {
  return new RefundPaymentOperationExecutor({
    now: overrides.now ?? (() => fixedNow),
    leaseOwner: `refund-test-${randomUUID()}`,
    getProvider: overrides.getProvider ?? (async (locationId) => {
      if (locationId !== fixture.locationId) throw new Error("wrong provider location");
      return provider;
    }),
    finalizeSuccess: overrides.finalizeSuccess,
  });
}

function storedDate(value: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
}

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.slug, slugs));
  for (const row of leftovers) await deleteOrganization(row.id);
  fixtures = [await createFixture(0), await createFixture(1)];
});

afterAll(async () => {
  for (const fixture of fixtures ?? []) await deleteOrganization(fixture.organizationId);
});

describe("durable refund payment operations", () => {
  it("prepares one encrypted tenant-scoped operation and rejects changed immutable semantics", async () => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const [first, duplicate] = await Promise.all([
      prepare(fixture, payment.id),
      prepare(fixture, payment.id),
    ]);

    expect(duplicate.operation.id).toBe(first.operation.id);
    expect(first.operation.targetKey).toBe(`payment-refund:${payment.id}`);
    expect(first.operation.providerIdempotencyKey).toMatch(/^lv-op1-rf-/);
    expect(first.operation.providerIdempotencyKey.length).toBeLessThanOrEqual(45);
    const [stored] = await db.select().from(refundPaymentOperationSnapshots)
      .where(eq(refundPaymentOperationSnapshots.operationId, first.operation.id));
    expect(stored.encryptedProviderPaymentId).not.toContain(payment.providerPaymentId ?? "missing");

    await expect(prepare(fixture, payment.id, "Different request"))
      .rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("rejects a league without a location before creating an immutable refund operation", async () => {
    const fixture = fixtures[0];
    const [league] = await db.insert(leagues).values({
      name: "Refund Operation League Without Location",
      seasonStart: "2033-01-01T00:00:00.000Z",
      seasonEnd: "2033-12-31T23:59:59.000Z",
      weekDay: "Monday",
      weeklyFee: 2_000,
      organizationId: fixture.organizationId,
      locationId: null,
    }).returning({ id: leagues.id });
    const payment = await createPaidPayment(fixture, { leagueId: league.id });

    await expect(prepare(fixture, payment.id)).rejects.toMatchObject({
      statusCode: 422,
      code: "PROVIDER_NOT_CONFIGURED",
    });

    const operations = await db.select().from(paymentOperations)
      .where(eq(paymentOperations.targetKey, `${REFUND_TARGET_PREFIX}${payment.id}`));
    const snapshots = await db.select().from(refundPaymentOperationSnapshots)
      .where(eq(refundPaymentOperationSnapshots.paymentId, payment.id));
    expect(operations).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it("fails closed for cross-tenant preparation and operation execution", async () => {
    const owner = fixtures[0];
    const other = fixtures[1];
    const payment = await createPaidPayment(owner);
    await expect(prepareRefundPaymentOperation({
      paymentId: payment.id,
      reason: "No access",
      requestedByUserId: other.actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: other.organizationId,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const { operation } = await prepare(owner, payment.id);
    const provider = new ScriptedRefundProvider(owner.locationId);
    await expect(executor(owner, provider).execute({
      organizationId: other.organizationId,
      operationId: operation.id,
      now: fixedNow,
    })).resolves.toBeUndefined();
    expect(provider.refundCalls).toHaveLength(0);
  });

  it("calls Square after claim commit with the exact retained key and atomically finalizes the payment", async () => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const { operation } = await prepare(fixture, payment.id);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    let observedStatus: string | undefined;
    provider.beforeRefund = async () => {
      observedStatus = (await getPaymentOperationForOrganization(fixture.organizationId, operation.id))?.status;
    };

    const result = await executor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(observedStatus).toBe("leased");
    expect(result).toMatchObject({ status: "succeeded", providerObjectId: expect.stringMatching(/^square-refund-/) });
    expect(provider.refundCalls).toEqual([{
      paymentId: payment.providerPaymentId,
      amount: payment.amount,
      reason: "Customer request",
      idempotencyKey: operation.providerIdempotencyKey,
    }]);
    const [refunded] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(refunded).toMatchObject({
      status: "refunded",
      squareRefundId: result?.providerObjectId,
      refundReason: "Customer request",
    });
  });

  it("concurrent workers converge on one lease and one provider effect", async () => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const { operation } = await prepare(fixture, payment.id);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    const first = executor(fixture, provider);
    const second = executor(fixture, provider);

    const results = await Promise.all([
      first.execute({ organizationId: fixture.organizationId, operationId: operation.id, now: fixedNow }),
      second.execute({ organizationId: fixture.organizationId, operationId: operation.id, now: fixedNow }),
    ]);
    expect(results.every(result => result?.status === "succeeded" || result?.status === "leased")).toBe(true);
    expect(provider.refundCalls).toHaveLength(1);
    expect(provider.effectsByKey).toHaveLength(1);
  });

  it("recovers a lost Square response and a local-finalization failure with the same key", async () => {
    expectErrorLog(/Refund local finalization failed/);
    const fixture = fixtures[0];
    const lostPayment = await createPaidPayment(fixture);
    const lost = await prepare(fixture, lostPayment.id);
    const lostProvider = new ScriptedRefundProvider(fixture.locationId);
    lostProvider.refundOutcomes.push("lost_completed");
    let clock = fixedNow;
    const lostExecutor = executor(fixture, lostProvider, { now: () => clock });
    const unknown = await lostExecutor.execute({ organizationId: fixture.organizationId, operationId: lost.operation.id, now: clock });
    expect(unknown?.status).toBe("provider_unknown");
    if (!unknown?.nextAttemptAt) throw new Error("unknown refund was not scheduled");
    clock = new Date(storedDate(unknown.nextAttemptAt).getTime() + 1);
    const recovered = await lostExecutor.execute({ organizationId: fixture.organizationId, operationId: lost.operation.id, now: clock });
    expect(recovered?.status).toBe("succeeded");
    expect(lostProvider.refundCalls.map(call => call.idempotencyKey)).toEqual([
      lost.operation.providerIdempotencyKey,
      lost.operation.providerIdempotencyKey,
    ]);
    expect(lostProvider.effectsByKey).toHaveLength(1);

    const localPayment = await createPaidPayment(fixture);
    const local = await prepare(fixture, localPayment.id);
    const localProvider = new ScriptedRefundProvider(fixture.locationId);
    let finalizeCalls = 0;
    clock = fixedNow;
    const localExecutor = executor(fixture, localProvider, {
      now: () => clock,
      finalizeSuccess: async input => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error("deterministic local failure");
        return finalizeRefundPaymentOperationSuccess(input);
      },
    });
    await expect(localExecutor.execute({ organizationId: fixture.organizationId, operationId: local.operation.id, now: clock }))
      .rejects.toThrow("deterministic local failure");
    const leased = await getPaymentOperationForOrganization(fixture.organizationId, local.operation.id);
    if (!leased?.leaseExpiresAt) throw new Error("refund lease was not retained");
    clock = new Date(storedDate(leased.leaseExpiresAt).getTime() + 1);
    await expect(localExecutor.execute({ organizationId: fixture.organizationId, operationId: local.operation.id, now: clock }))
      .resolves.toMatchObject({ status: "succeeded" });
    expect(localProvider.refundCalls.map(call => call.idempotencyKey)).toEqual([
      local.operation.providerIdempotencyKey,
      local.operation.providerIdempotencyKey,
    ]);
    expect(localProvider.effectsByKey).toHaveLength(1);
  });

  it("checks a known PENDING refund by ID and never terminalizes lookup uncertainty", async () => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const { operation } = await prepare(fixture, payment.id);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    provider.refundOutcomes.push({ refundId: "square-refund-pending", status: "PENDING" });
    let clock = fixedNow;
    const firstExecutor = executor(fixture, provider, { now: () => clock });
    const pending = await firstExecutor.execute({ organizationId: fixture.organizationId, operationId: operation.id, now: clock });
    expect(pending).toMatchObject({ status: "retry_scheduled", providerObjectId: "square-refund-pending" });
    if (!pending?.nextAttemptAt) throw new Error("pending refund was not scheduled");
    clock = new Date(storedDate(pending.nextAttemptAt).getTime() + 1);
    provider.getOutcomes.push(new ProviderNotConfiguredError("temporarily unavailable", fixture.locationId));
    const unresolved = await firstExecutor.execute({ organizationId: fixture.organizationId, operationId: operation.id, now: clock });
    expect(unresolved).toMatchObject({ status: "provider_unknown", providerObjectId: "square-refund-pending" });
    expect(provider.refundCalls).toHaveLength(1);
    expect(provider.getRefundCalls).toEqual(["square-refund-pending"]);

    if (!unresolved?.nextAttemptAt) throw new Error("known refund lookup was not rescheduled");
    clock = new Date(storedDate(unresolved.nextAttemptAt).getTime() + 1);
    const completed = await firstExecutor.execute({ organizationId: fixture.organizationId, operationId: operation.id, now: clock });
    expect(completed?.status).toBe("succeeded");
    expect(provider.getRefundCalls).toEqual(["square-refund-pending", "square-refund-pending"]);
  });

  it.each([
    ["REJECTED", "REFUND_REJECTED"],
    ["FAILED", "REFUND_FAILED"],
  ] as const)("treats Square %s as terminal without updating the payment", async (status, code) => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const { operation } = await prepare(fixture, payment.id);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    provider.refundOutcomes.push({ refundId: `square-refund-${status}`, status });
    const result = await executor(fixture, provider).execute({ organizationId: fixture.organizationId, operationId: operation.id, now: fixedNow });
    expect(result).toMatchObject({ status: "failed_terminal", errorCode: code });
    expect((await db.select().from(payments).where(eq(payments.id, payment.id)))[0]?.status).toBe("paid");
  });

  it.each([
    ["transient", new PaymentProviderError("temporary", "RATE_LIMITED", undefined, {
      disposition: "transient",
      providerCode: "RATE_LIMITED",
    }), "retry_scheduled", "transient"],
    ["configuration", new PaymentProviderError("temporarily unavailable", "SYSTEM_ERROR", undefined, {
      disposition: "configuration",
      providerCode: "UNAUTHORIZED",
    }), "retry_scheduled", "configuration"],
    ["decline", new PaymentProviderError("declined", "REFUND_DECLINED", undefined, {
      disposition: "action_required",
      providerCode: "REFUND_DECLINED",
    }), "action_required", "hard_decline"],
    ["invalid", new PaymentProviderError("invalid", "INVALID_REQUEST", undefined, {
      disposition: "invalid_request",
      providerCode: "INVALID_REQUEST",
    }), "failed_terminal", "invalid_request"],
  ] as const)("classifies a definite %s outcome without changing the payment", async (_label, error, status, classification) => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const { operation } = await prepare(fixture, payment.id);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    provider.refundOutcomes.push(error);
    const result = await executor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });
    expect(result).toMatchObject({ status, errorClassification: classification });
    expect((await db.select().from(payments).where(eq(payments.id, payment.id)))[0]?.status).toBe("paid");
  });

  it("keeps a missing provider configuration resumable and retries the same key after repair", async () => {
    const fixture = fixtures[0];
    const payment = await createPaidPayment(fixture);
    const { operation } = await prepare(fixture, payment.id);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    let configured = false;
    const first = await executor(fixture, provider, {
      getProvider: async () => {
        if (!configured) throw new ProviderNotConfiguredError("not configured", fixture.locationId);
        return provider;
      },
    }).execute({ organizationId: fixture.organizationId, operationId: operation.id, now: fixedNow });
    expect(first).toMatchObject({ status: "retry_scheduled", errorClassification: "configuration" });
    expect(provider.refundCalls).toHaveLength(0);

    configured = true;
    if (!first?.nextAttemptAt) throw new Error("configuration retry was not scheduled");
    const recovered = await executor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: new Date(storedDate(first.nextAttemptAt).getTime() + 1),
    });
    expect(recovered).toMatchObject({ status: "succeeded" });
    expect(provider.refundCalls.map(call => call.idempotencyKey)).toEqual([
      operation.providerIdempotencyKey,
    ]);
    expect((await db.select().from(payments).where(eq(payments.id, payment.id)))[0]?.status).toBe("refunded");
  });

  it("rejects stale fencing and preserves distinct combined-payment allocations", async () => {
    const fixture = fixtures[0];
    const sharedProviderId = `square-combined-${randomUUID()}`;
    const group = `combined-${randomUUID()}`;
    const firstPayment = await createPaidPayment(fixture, {
      amount: 700,
      lineageAmount: 500,
      prizeFundAmount: 200,
      providerPaymentId: sharedProviderId,
      combinedChargeGroupId: group,
    });
    const secondPayment = await createPaidPayment(fixture, {
      amount: 1_300,
      lineageAmount: 500,
      prizeFundAmount: 800,
      providerPaymentId: sharedProviderId,
      combinedChargeGroupId: group,
    });
    const first = await prepare(fixture, firstPayment.id);
    const second = await prepare(fixture, secondPayment.id);
    expect(first.operation.id).not.toBe(second.operation.id);
    expect(first.operation.providerIdempotencyKey).not.toBe(second.operation.providerIdempotencyKey);

    const leased = await acquirePaymentOperationLease({
      organizationId: fixture.organizationId,
      operationId: first.operation.id,
      leaseOwner: `stale-${randomUUID()}`,
      leaseDurationMs: 60_000,
      now: fixedNow,
    });
    if (!leased?.leaseToken) throw new Error("refund lease not acquired");
    await expect(finalizeRefundPaymentOperationSuccess({
      organizationId: fixture.organizationId,
      operationId: first.operation.id,
      leaseToken: randomUUID(),
      providerObjectId: "square-refund-stale",
      now: fixedNow,
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);
    expect((await db.select().from(payments).where(eq(payments.id, firstPayment.id)))[0]?.status).toBe("paid");

    if (!leased.leaseExpiresAt) throw new Error("refund lease expiry missing");
    const recoveryNow = new Date(storedDate(leased.leaseExpiresAt).getTime() + 1);
    const provider = new ScriptedRefundProvider(fixture.locationId);
    await executor(fixture, provider).execute({ organizationId: fixture.organizationId, operationId: first.operation.id, now: recoveryNow });
    await executor(fixture, provider).execute({ organizationId: fixture.organizationId, operationId: second.operation.id, now: fixedNow });
    expect(provider.refundCalls.map(call => call.amount)).toEqual([700, 1_300]);
    const rows = await db.select().from(payments).where(inArray(payments.id, [firstPayment.id, secondPayment.id]));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.status === "refunded" && row.combinedChargeGroupId === group)).toBe(true);
  });
});
