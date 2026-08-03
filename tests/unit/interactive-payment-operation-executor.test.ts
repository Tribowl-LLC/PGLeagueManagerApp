import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagues,
  locations,
  organizations,
  payments,
  teams,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { expectErrorLog } from "../helpers/expected-error-logs";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  createOrGetGeneralInteractivePaymentOperation,
  finalizePaymentOperationSuccess,
  getPaymentOperationForOrganization,
  persistInteractivePaymentOperationSnapshot,
  PaymentOperationInvalidTransitionError,
} from "../../server/storage/payment-operations";
import { InteractivePaymentOperationExecutor } from "../../server/services/interactive-payment-operation-executor";
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
} from "../../server/services/payment-errors";
import {
  deriveSquareOperationIdempotencyKey,
} from "../../server/services/payment-operation-idempotency";
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
import type { InteractivePaymentSemanticSnapshot } from "../../server/services/interactive-payment-operation-snapshot";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const fixedNow = new Date("2032-02-01T00:00:00.000Z");

interface InteractiveFixture {
  organizationId: number;
  locationId: number;
  leagueId: number;
  bowlerId: number;
  providerLocationId: string;
}

interface PaymentCall {
  sourceId: string;
  amount: number;
  storeCard?: boolean;
  customerId?: string;
  buyerEmail?: string;
  idempotencyKey?: PaymentIdempotencyInput;
}

class ScriptedInteractiveProvider implements PaymentProvider {
  readonly providerName = "square";
  readonly processCalls: PaymentCall[] = [];
  readonly orderCalls: Array<PaymentCall & { lineItems: OrderLineItem[] }> = [];
  readonly refundCalls: string[] = [];
  outcome: PaymentResult | Error = {
    id: "square-payment-default",
    status: "COMPLETED",
    orderId: "square-order-default",
    receiptUrl: "https://square.example.test/receipt",
    receiptNumber: "LV-EXECUTOR-TEST",
  };
  beforeCall: (() => Promise<void>) | undefined;

  constructor(readonly locationId: number) {}

  async processPayment(
    sourceId: string,
    amount: number,
    storeCard?: boolean,
    customerId?: string,
    buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    this.processCalls.push({ sourceId, amount, storeCard, customerId, buyerEmail, idempotencyKey });
    return this.resolveOutcome();
  }

  async createOrderWithPayment(
    sourceId: string,
    amount: number,
    lineItems: OrderLineItem[],
    storeCard?: boolean,
    customerId?: string,
    buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    this.orderCalls.push({
      sourceId,
      amount,
      lineItems,
      storeCard,
      customerId,
      buyerEmail,
      idempotencyKey,
    });
    return this.resolveOutcome();
  }

  private async resolveOutcome(): Promise<PaymentResult> {
    await this.beforeCall?.();
    if (this.outcome instanceof Error) throw this.outcome;
    return { ...this.outcome };
  }

  async refundPayment(paymentId: string): Promise<RefundResult> {
    this.refundCalls.push(paymentId);
    return { refundId: `refund-${paymentId}`, status: "COMPLETED" };
  }

  async saveCardOnFile(): Promise<SavedCard | null> { return null; }
  async listCardsOnFile(): Promise<SavedCard[]> { return []; }
  async disableCard(): Promise<void> {}
  async createOrUpdateCustomer(): Promise<PaymentCustomer | null> { return null; }
  async getPayment(): Promise<PaymentVerification | null> { return null; }
  validateCardId(): boolean { return false; }
}

const slugs = [
  `interactive-executor-a-${suffix}`,
  `interactive-executor-b-${suffix}`,
] as const;
let fixtures: [InteractiveFixture, InteractiveFixture];

async function createFixture(index: 0 | 1): Promise<InteractiveFixture> {
  const [organization] = await db.insert(organizations).values({
    name: `Interactive Executor Organization ${index}`,
    slug: slugs[index],
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("executor organization was not created");

  const [location] = await db.insert(locations).values({
    name: `Interactive Executor Location ${index}`,
    organizationId: organization.id,
    squareCredentials: {
      appId: "sandbox-app",
      accessToken: "deterministic-test-token",
      locationId: `SQUARE_EXECUTOR_${index}`,
    },
  }).returning({ id: locations.id });
  if (!location) throw new Error("executor location was not created");

  const [league] = await db.insert(leagues).values({
    name: `Interactive Executor League ${index}`,
    seasonStart: "2032-01-01T00:00:00.000Z",
    seasonEnd: "2032-12-31T23:59:59.000Z",
    weekDay: "Monday",
    weeklyFee: 2_000,
    organizationId: organization.id,
    locationId: location.id,
  }).returning({ id: leagues.id });
  if (!league) throw new Error("executor league was not created");

  const [bowler] = await db.insert(bowlers).values({
    name: `Interactive Executor Bowler ${index}`,
    organizationId: organization.id,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("executor bowler was not created");

  const [team] = await db.insert(teams).values({
    name: `Interactive Executor Team ${index}`,
    number: 1,
    leagueId: league.id,
  }).returning({ id: teams.id });
  if (!team) throw new Error("executor team was not created");
  await db.insert(bowlerLeagues).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    teamId: team.id,
  });

  return {
    organizationId: organization.id,
    locationId: location.id,
    leagueId: league.id,
    bowlerId: bowler.id,
    providerLocationId: `SQUARE_EXECUTOR_${index}`,
  };
}

async function prepareOperation(
  fixture: InteractiveFixture,
  options: {
    requestKey?: string;
    requestKind?: "direct" | "order";
    storeCard?: boolean;
  } = {},
): Promise<{
  operation: Awaited<ReturnType<typeof createOrGetGeneralInteractivePaymentOperation>>;
  snapshot: InteractivePaymentSemanticSnapshot;
}> {
  const requestKind = options.requestKind ?? "direct";
  const operation = await createOrGetGeneralInteractivePaymentOperation({
    organizationId: fixture.organizationId,
    requestKey: options.requestKey ?? `executor-${randomUUID()}`,
    amountMinor: 2_000,
    currency: "USD",
    providerName: "square",
    now: fixedNow,
  });
  const snapshot: InteractivePaymentSemanticSnapshot = {
    snapshotVersion: 1,
    organizationId: fixture.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId: fixture.leagueId,
    locationId: fixture.locationId,
    providerLocationId: fixture.providerLocationId,
    payerBowlerId: fixture.bowlerId,
    requestKind,
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      operation.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: requestKind === "order"
      ? deriveSquareOperationIdempotencyKey(operation.providerIdempotencyKey, "order")
      : null,
    sourceId: `cnon:executor-${randomUUID()}`,
    customerId: "CUSTOMER_EXECUTOR_TEST",
    buyerEmail: "executor@example.test",
    storeCard: options.storeCard ?? false,
    weekOf: "2032-02-02T00:00:00.000Z",
    combinedChargeGroupId: null,
    allocations: [{
      allocationIndex: 0,
      bowlerId: fixture.bowlerId,
      amountMinor: operation.amountMinor,
      lineageAmountMinor: 1_000,
      prizeFundAmountMinor: 1_000,
      weekOf: "2032-02-02T00:00:00.000Z",
      notes: "interactive executor test",
      paidByUserId: null,
    }],
    lineItems: requestKind === "order"
      ? [
        { lineItemIndex: 0, catalogObjectId: "LINEAGE_EXECUTOR", quantity: "1" },
        { lineItemIndex: 1, catalogObjectId: "PRIZE_EXECUTOR", quantity: "1" },
      ]
      : [],
  };
  await db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, snapshot, tx));
  return { operation, snapshot };
}

function createExecutor(
  fixture: InteractiveFixture,
  provider: ScriptedInteractiveProvider,
  overrides: {
    finalizeSuccess?: typeof finalizePaymentOperationSuccess;
    getProvider?: (locationId: number | null) => Promise<PaymentProvider>;
    now?: () => Date;
  } = {},
): InteractivePaymentOperationExecutor {
  return new InteractivePaymentOperationExecutor({
    now: overrides.now ?? (() => fixedNow),
    leaseOwner: `interactive-executor-test-${randomUUID()}`,
    getProvider: overrides.getProvider ?? (async (locationId) => {
      if (locationId !== fixture.locationId) throw new Error("unexpected provider location");
      return provider;
    }),
    finalizeSuccess: overrides.finalizeSuccess,
  });
}

function parseStoredTimestamp(value: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
}

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.slug, slugs));
  for (const leftover of leftovers) await deleteOrganization(leftover.id);
  fixtures = [await createFixture(0), await createFixture(1)];
});

afterAll(async () => {
  for (const fixture of fixtures ?? []) {
    await deleteOrganization(fixture.organizationId);
  }
});

describe("interactive payment operation executor", () => {
  it("dispatches direct requests with the exact retained payment key", async () => {
    const fixture = fixtures[0];
    const { operation, snapshot } = await prepareOperation(fixture);
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    const executor = createExecutor(fixture, provider);

    const result = await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result?.status).toBe("succeeded");
    expect(provider.processCalls).toHaveLength(1);
    const call = provider.processCalls[0];
    expect(call?.sourceId).toMatch(/^cnon:executor-/);
    expect(call?.amount).toBe(2_000);
    expect(call?.idempotencyKey).toEqual({
      paymentKey: snapshot.squarePaymentIdempotencyKey,
      orderKey: undefined,
      providerLocationId: snapshot.providerLocationId,
    });
    const [payment] = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(payment).toMatchObject({
      status: "paid",
      providerPaymentId: "square-payment-default",
      idempotencyKey: operation.id,
    });
  });

  it("dispatches order requests with exact ordered line items and both retained keys", async () => {
    const fixture = fixtures[0];
    const { operation, snapshot } = await prepareOperation(fixture, { requestKind: "order" });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    const executor = createExecutor(fixture, provider);

    await expect(executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    })).resolves.toMatchObject({ status: "succeeded" });

    expect(provider.orderCalls).toHaveLength(1);
    const call = provider.orderCalls[0];
    expect(call?.lineItems).toEqual([
      { catalogObjectId: "LINEAGE_EXECUTOR", quantity: "1" },
      { catalogObjectId: "PRIZE_EXECUTOR", quantity: "1" },
    ]);
    expect(call?.idempotencyKey).toEqual({
      paymentKey: snapshot.squarePaymentIdempotencyKey,
      orderKey: snapshot.squareOrderIdempotencyKey,
      providerLocationId: snapshot.providerLocationId,
    });
  });

  it.each([
    ["APPROVED", "provider_unknown"],
    ["PENDING", "provider_unknown"],
    ["FAILED", "action_required"],
    ["CANCELED", "action_required"],
    [undefined, "provider_unknown"],
  ] as const)("does not finalize a %s provider result as paid", async (status, expectedStatus) => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture);
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    provider.outcome = { id: `non-completed-${status ?? "missing"}`, status };
    const executor = createExecutor(fixture, provider);

    const result = await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result?.status).toBe(expectedStatus);
    expect(await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
  });

  it.each([
    ["transient", new PaymentProviderError("temporary", "TEMPORARY_ERROR", undefined, {
      disposition: "transient",
      providerCode: "TEMPORARY_ERROR",
    }), "retry_scheduled", "transient"],
    ["decline", new PaymentProviderError("declined", "CARD_DECLINED", undefined, {
      disposition: "action_required",
      providerCode: "CARD_DECLINED",
    }), "action_required", "hard_decline"],
    ["configuration", new ProviderNotConfiguredError("not configured", 1), "failed_terminal", "configuration"],
    ["invalid request", new PaymentProviderError("invalid", "INVALID_REQUEST", undefined, {
      disposition: "invalid_request",
      providerCode: "INVALID_REQUEST",
    }), "failed_terminal", "invalid_request"],
    ["ambiguous", new Error("transport timeout"), "provider_unknown", "provider_unknown"],
  ] as const)("classifies %s outcomes without local paid rows", async (_label, error, expectedStatus, expectedClassification) => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture);
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    const getProvider = _label === "configuration"
      ? async () => { throw error; }
      : async () => {
        provider.outcome = error;
        return provider;
      };
    const executor = createExecutor(fixture, provider, { getProvider });

    const result = await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result?.status).toBe(expectedStatus);
    expect(result?.errorClassification).toBe(expectedClassification);
    expect(await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
  });

  it("calls the provider after the lease transaction is committed", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture);
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    let observedStatus: string | undefined;
    provider.beforeCall = async () => {
      observedStatus = (await getPaymentOperationForOrganization(
        fixture.organizationId,
        operation.id,
      ))?.status;
    };
    const executor = createExecutor(fixture, provider);

    await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(observedStatus).toBe("leased");
  });

  it("rejects stale-token finalization and creates no local payment", async () => {
    expectErrorLog(/Interactive operation local finalization failed/);
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture);
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    const executor = createExecutor(fixture, provider, {
      finalizeSuccess: async (input) => finalizePaymentOperationSuccess({
        ...input,
        leaseToken: randomUUID(),
      }),
    });

    await expect(executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);
    expect((await getPaymentOperationForOrganization(fixture.organizationId, operation.id))?.status)
      .toBe("leased");
    expect(await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
  });

  it("recovers local-finalization failure by replaying the same key without refund compensation", async () => {
    expectErrorLog(/Interactive operation local finalization failed/);
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture);
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    let finalizeCalls = 0;
    let clock = fixedNow;
    const executor = createExecutor(fixture, provider, {
      now: () => clock,
      finalizeSuccess: async (input) => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error("deterministic local finalization failure");
        return finalizePaymentOperationSuccess(input);
      },
    });

    await expect(executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: clock,
    })).rejects.toThrow("deterministic local finalization failure");
    const leased = await getPaymentOperationForOrganization(fixture.organizationId, operation.id);
    if (!leased?.leaseExpiresAt) throw new Error("failed finalization did not retain its lease");
    clock = new Date(parseStoredTimestamp(leased.leaseExpiresAt).getTime() + 1);

    await expect(executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: clock,
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(provider.processCalls).toHaveLength(2);
    expect(provider.processCalls[1]?.idempotencyKey)
      .toEqual(provider.processCalls[0]?.idempotencyKey);
    expect(provider.refundCalls).toHaveLength(0);
    expect(await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id))).toHaveLength(1);
  });

  it("charges store-card intents while leaving vault persistence to the route side effect", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { storeCard: true });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    const executor = createExecutor(fixture, provider);

    const result = await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(provider.processCalls).toHaveLength(1);
    expect(provider.orderCalls).toHaveLength(0);
  });

  it("uses globally safe operation UUIDs for local payment idempotency across tenants", async () => {
    const [fixtureA, fixtureB] = fixtures;
    const requestKey = `same-cross-tenant-${randomUUID()}`;
    const preparedA = await prepareOperation(fixtureA, { requestKey });
    const preparedB = await prepareOperation(fixtureB, { requestKey });
    const providerA = new ScriptedInteractiveProvider(fixtureA.locationId);
    const providerB = new ScriptedInteractiveProvider(fixtureB.locationId);

    await createExecutor(fixtureA, providerA).execute({
      organizationId: fixtureA.organizationId,
      operationId: preparedA.operation.id,
      now: fixedNow,
    });
    await createExecutor(fixtureB, providerB).execute({
      organizationId: fixtureB.organizationId,
      operationId: preparedB.operation.id,
      now: fixedNow,
    });

    const rows = await db.select({
      operationId: payments.paymentOperationId,
      idempotencyKey: payments.idempotencyKey,
    }).from(payments).where(inArray(payments.paymentOperationId, [
      preparedA.operation.id,
      preparedB.operation.id,
    ]));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.idempotencyKey))).toEqual(new Set([
      preparedA.operation.id,
      preparedB.operation.id,
    ]));
  });
});
