import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  autopaySetupRequests,
  bowlerLeagues,
  bowlers,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  payments,
  teams,
} from "@shared/schema";
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
import { deleteOrganization } from "../../server/storage/organizations";
import { PaymentProviderError } from "../../server/services/payment-errors";
import { getTestDb } from "../setup/test-db";

const { getPaymentProviderMock, rearmMock } = vi.hoisted(() => ({
  getPaymentProviderMock: vi.fn(),
  rearmMock: vi.fn(),
}));

vi.mock("../../server/services/payment-provider-factory", async () => {
  const actual = await vi.importActual<
    typeof import("../../server/services/payment-provider-factory")
  >("../../server/services/payment-provider-factory");
  return { ...actual, getPaymentProvider: getPaymentProviderMock };
});

vi.mock("../../server/services/scheduled-payment-operation-executor", () => ({
  scheduledPaymentOperationExecutor: { rearm: rearmMock },
}));

import {
  getWeeklyAutopaySetupQuote,
  setupWeeklyAutopay,
} from "../../server/services/autopay-setup";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = "autopay-setup-execution-" + suffix;
const beforeStart = new Date("2032-01-04T17:35:00.000Z");
const dueToday = new Date("2032-01-04T18:00:00.000Z");
let organizationId: number;
let locationId: number;

function identityKey(input?: PaymentIdempotencyInput): string {
  if (typeof input === "string") return input;
  if (!input) throw new Error("stable provider identity was omitted");
  return (input.orderKey ?? "direct") + ":" + input.paymentKey;
}

class IdempotentSetupProvider implements PaymentProvider {
  readonly providerName = "square";
  readonly effects = new Map<string, PaymentResult>();
  readonly calls: string[] = [];
  declinedSourceId: string | null = null;
  unknownAfterFirstEffect = false;

  constructor(readonly locationId: number) {}

  async processPayment(
    sourceId: string,
    _amount: number,
    _storeCard?: boolean,
    _customerId?: string,
    _buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    return this.effect(sourceId, identityKey(idempotencyKey));
  }

  async createOrderWithPayment(
    sourceId: string,
    _amount: number,
    _lineItems: OrderLineItem[],
    _storeCard?: boolean,
    _customerId?: string,
    _buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    return this.effect(sourceId, identityKey(idempotencyKey));
  }

  private effect(sourceId: string, key: string): PaymentResult {
    this.calls.push(key);
    if (sourceId === this.declinedSourceId) {
      throw new PaymentProviderError(
        "The card was declined.",
        "CARD_DECLINED",
        undefined,
        { disposition: "action_required", providerCode: "CARD_DECLINED" },
      );
    }
    const existing = this.effects.get(key);
    if (existing) return existing;
    const created: PaymentResult = {
      id: "setup-payment-" + (this.effects.size + 1),
      status: "COMPLETED",
      receiptUrl: "https://square.example.test/setup-receipt",
      receiptNumber: "SETUP-TEST",
    };
    this.effects.set(key, created);
    if (this.unknownAfterFirstEffect) {
      this.unknownAfterFirstEffect = false;
      throw new PaymentProviderError(
        "The payment outcome is unknown.",
        "PROVIDER_TIMEOUT",
        undefined,
        { disposition: "provider_unknown", providerCode: "PROVIDER_TIMEOUT" },
      );
    }
    return created;
  }

  async refundPayment(): Promise<RefundResult> {
    throw new Error("auto-pay setup recovery must never issue a compensation refund");
  }
  async saveCardOnFile(): Promise<SavedCard | null> { return null; }
  async listCardsOnFile(): Promise<SavedCard[]> {
    return [
      { id: "ccof:setup-test", last4: "4242", brand: "VISA" },
      { id: "ccof:declined", last4: "0002", brand: "VISA" },
    ];
  }
  async disableCard(): Promise<void> {}
  async createOrUpdateCustomer(): Promise<PaymentCustomer | null> { return null; }
  async getPayment(): Promise<PaymentVerification | null> { return null; }
  validateCardId(cardId: string | null): boolean {
    return cardId?.startsWith("ccof:") === true;
  }
}

async function createFixture(label: string) {
  const [league] = await db.insert(leagues).values({
    name: "Auto-pay setup " + label,
    seasonStart: "2032-01-04T00:00:00.000Z",
    seasonEnd: "2032-01-18T23:59:59.000Z",
    weekDay: "Sunday",
    competitionStartTime: "12:40",
    timezone: "America/New_York",
    weeklyFee: 100,
    totalBowlingWeeks: 3,
    paymentMode: "weekly",
    organizationId,
    locationId,
  }).returning();
  if (!league) throw new Error("league fixture was not created");
  const [team] = await db.insert(teams).values({
    name: "Setup Team " + label,
    number: 1,
    leagueId: league.id,
  }).returning();
  if (!team) throw new Error("team fixture was not created");
  const [bowler] = await db.insert(bowlers).values({
    name: "Setup Bowler " + label,
    email: label + "-" + Math.random() + "@example.test",
    paymentCustomerId: "customer-" + label,
    paymentProviderLocationId: locationId,
    organizationId,
  }).returning();
  if (!bowler) throw new Error("bowler fixture was not created");
  await db.insert(bowlerLeagues).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    teamId: team.id,
    active: true,
  });
  return { league, bowler };
}

async function quoteAndSetup(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  now: Date,
) {
  const quote = await getWeeklyAutopaySetupQuote({
    payerBowlerId: fixture.bowler.id,
    leagueId: fixture.league.id,
    now,
  });
  return {
    quote,
    input: {
      payerBowlerId: fixture.bowler.id,
      leagueId: fixture.league.id,
      quoteFingerprint: quote.quoteFingerprint,
      sourceId: "ccof:setup-test",
      now,
    },
  };
}

beforeAll(async () => {
  const [leftover] = await db.select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  if (leftover) await deleteOrganization(leftover.id);
  const [organization] = await db.insert(organizations).values({
    name: "Auto-pay Setup Execution",
    slug,
  }).returning();
  if (!organization) throw new Error("organization fixture was not created");
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({
    name: "Auto-pay Setup Location",
    organizationId,
    squareCredentials: {
      appId: "sandbox-app",
      accessToken: "test-only-token",
      locationId: "SETUP_LOCATION",
    },
  }).returning();
  if (!location) throw new Error("location fixture was not created");
  locationId = location.id;
});

beforeEach(() => {
  getPaymentProviderMock.mockReset();
  rearmMock.mockReset();
  rearmMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

describe("weekly auto-pay setup execution", () => {
  it("serializes transaction queries through the pinned PostgreSQL client", async () => {
    const fixture = await createFixture("transaction-query-serialization");
    const provider = new IdempotentSetupProvider(locationId);
    getPaymentProviderMock.mockResolvedValue(provider);
    const { input } = await quoteAndSetup(fixture, dueToday);
    const concurrentQueryWarnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (warning.message.includes("client.query() when the client is already executing")) {
        concurrentQueryWarnings.push(warning);
      }
    };
    process.on("warning", onWarning);
    try {
      await setupWeeklyAutopay(input);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }

    expect(concurrentQueryWarnings).toEqual([]);
  });

  it("creates a zero-dollar pre-start schedule without a provider effect", async () => {
    const fixture = await createFixture("pre-start");
    const provider = new IdempotentSetupProvider(locationId);
    getPaymentProviderMock.mockResolvedValue(provider);
    const { quote, input } = await quoteAndSetup(fixture, beforeStart);

    expect(quote.immediateAmountMinor).toBe(0);
    expect(quote.firstAutomaticAt).toBe("2032-01-04T17:40:00.000Z");
    const result = await setupWeeklyAutopay(input);

    expect(result.request.workflowStatus).toBe("completed");
    expect(result.request.paymentOperationId).toBeNull();
    expect(new Date((result.schedule?.nextPaymentDate ?? "") + "Z").toISOString())
      .toBe("2032-01-04T17:40:00.000Z");
    expect(result.schedule?.amount).toBe(100);
    expect(provider.effects.size).toBe(0);
    expect(await db.select().from(payments).where(and(
      eq(payments.bowlerId, fixture.bowler.id),
      eq(payments.leagueId, fixture.league.id),
    ))).toHaveLength(0);
  });

  it("charges exactly one due-today week and assigns it to that occurrence", async () => {
    const fixture = await createFixture("due-today");
    const provider = new IdempotentSetupProvider(locationId);
    getPaymentProviderMock.mockResolvedValue(provider);
    const { quote, input } = await quoteAndSetup(fixture, dueToday);

    expect(quote.immediateAmountMinor).toBe(100);
    const result = await setupWeeklyAutopay(input);
    const rows = await db.select().from(payments).where(and(
      eq(payments.bowlerId, fixture.bowler.id),
      eq(payments.leagueId, fixture.league.id),
    ));

    expect(result.request.workflowStatus).toBe("completed");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(100);
    expect(new Date(rows[0]?.weekOf ?? "").toISOString()).toBe(
      "2032-01-04T17:40:00.000Z",
    );
    expect(new Date((result.schedule?.nextPaymentDate ?? "") + "Z").toISOString())
      .toBe("2032-01-11T17:40:00.000Z");
    expect(provider.effects.size).toBe(1);
  });

  it("converges duplicate submissions on one provider effect and one allocation", async () => {
    const fixture = await createFixture("concurrent");
    const provider = new IdempotentSetupProvider(locationId);
    getPaymentProviderMock.mockResolvedValue(provider);
    const { input } = await quoteAndSetup(fixture, dueToday);

    const results = await Promise.allSettled([
      setupWeeklyAutopay(input),
      setupWeeklyAutopay(input),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(provider.effects.size).toBe(1);
    expect(await db.select().from(autopaySetupRequests).where(and(
      eq(autopaySetupRequests.payerBowlerId, fixture.bowler.id),
      eq(autopaySetupRequests.leagueId, fixture.league.id),
    ))).toHaveLength(1);
    expect(await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "interactive_charge"),
    )).then((rows) => rows.filter((row) => row.targetKey.includes(
      (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof setupWeeklyAutopay>>
      >).value.request.id,
    )))).toHaveLength(1);
    expect(await db.select().from(payments).where(and(
      eq(payments.bowlerId, fixture.bowler.id),
      eq(payments.leagueId, fixture.league.id),
    ))).toHaveLength(1);
  });

  it("requires a new card after a hard decline without bypassing the failed operation", async () => {
    const fixture = await createFixture("decline");
    const provider = new IdempotentSetupProvider(locationId);
    provider.declinedSourceId = "ccof:declined";
    getPaymentProviderMock.mockResolvedValue(provider);
    const quote = await getWeeklyAutopaySetupQuote({
      payerBowlerId: fixture.bowler.id,
      leagueId: fixture.league.id,
      now: dueToday,
    });
    await expect(setupWeeklyAutopay({
      payerBowlerId: fixture.bowler.id,
      leagueId: fixture.league.id,
      quoteFingerprint: quote.quoteFingerprint,
      sourceId: "ccof:declined",
      now: dueToday,
    })).rejects.toMatchObject({
      code: "PAYMENT_ACTION_REQUIRED",
      statusCode: 402,
    });
    const [declined] = await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.status, "action_required"),
    )).orderBy(sql`${paymentOperations.createdAt} DESC`).limit(1);
    expect(declined).toBeDefined();
    expect(await db.select().from(paymentSchedules).where(and(
      eq(paymentSchedules.bowlerId, fixture.bowler.id),
      eq(paymentSchedules.leagueId, fixture.league.id),
    ))).toHaveLength(0);

    const recovered = await setupWeeklyAutopay({
      payerBowlerId: fixture.bowler.id,
      leagueId: fixture.league.id,
      quoteFingerprint: quote.quoteFingerprint,
      sourceId: "ccof:setup-test",
      now: dueToday,
    });
    expect(recovered.request.workflowStatus).toBe("completed");
    expect(recovered.request.id).not.toBe(
      declined?.targetKey.replace("autopay-setup:", ""),
    );
    expect(provider.effects.size).toBe(1);
  });

  it("recovers an unknown provider outcome with the identical Square identity", async () => {
    const fixture = await createFixture("unknown");
    const provider = new IdempotentSetupProvider(locationId);
    provider.unknownAfterFirstEffect = true;
    getPaymentProviderMock.mockResolvedValue(provider);
    const { quote, input } = await quoteAndSetup(fixture, dueToday);
    await expect(setupWeeklyAutopay(input)).rejects.toMatchObject({
      code: "PAYMENT_OUTCOME_PENDING",
      statusCode: 503,
    });
    const [uncertain] = await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.status, "provider_unknown"),
    )).orderBy(sql`${paymentOperations.createdAt} DESC`).limit(1);
    expect(uncertain?.nextAttemptAt).toBeTruthy();
    expect(provider.effects.size).toBe(1);
    expect(await db.select().from(payments).where(and(
      eq(payments.bowlerId, fixture.bowler.id),
      eq(payments.leagueId, fixture.league.id),
    ))).toHaveLength(0);
    if (!uncertain?.nextAttemptAt) throw new Error("unknown outcome has no retry time");

    const recoveryNow = new Date(uncertain.nextAttemptAt + "Z");
    const recovered = await setupWeeklyAutopay({
      ...input,
      quoteFingerprint: quote.quoteFingerprint,
      now: recoveryNow,
    });
    expect(recovered.request.workflowStatus).toBe("completed");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toBe(provider.calls[0]);
    expect(provider.effects.size).toBe(1);
  });

  it("replays the same provider identity after atomic local finalization fails", async () => {
    const fixture = await createFixture("recovery");
    const provider = new IdempotentSetupProvider(locationId);
    getPaymentProviderMock.mockResolvedValue(provider);
    const { quote, input } = await quoteAndSetup(fixture, dueToday);
    await db.execute(sql.raw([
      "CREATE OR REPLACE FUNCTION fail_autopay_setup_schedule_insert()",
      "RETURNS trigger LANGUAGE plpgsql AS $$",
      "BEGIN",
      "  IF NEW.league_id = " + fixture.league.id + " THEN",
      "    RAISE EXCEPTION 'simulated schedule insert failure';",
      "  END IF;",
      "  RETURN NEW;",
      "END",
      "$$;",
      "CREATE TRIGGER fail_autopay_setup_schedule_insert_trigger",
      "BEFORE INSERT ON payment_schedules",
      "FOR EACH ROW EXECUTE FUNCTION fail_autopay_setup_schedule_insert();",
    ].join("\n")));
    try {
      await expect(setupWeeklyAutopay(input)).rejects.toThrow(/payment_schedules/);
      expect(rearmMock).toHaveBeenCalledTimes(1);
    } finally {
      await db.execute(sql.raw([
        "DROP TRIGGER IF EXISTS fail_autopay_setup_schedule_insert_trigger ON payment_schedules;",
        "DROP FUNCTION IF EXISTS fail_autopay_setup_schedule_insert();",
      ].join("\n")));
    }

    const [leased] = await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.status, "leased"),
    )).orderBy(sql`${paymentOperations.createdAt} DESC`).limit(1);
    expect(leased).toBeDefined();
    expect(provider.effects.size).toBe(1);
    expect(await db.select().from(payments).where(and(
      eq(payments.bowlerId, fixture.bowler.id),
      eq(payments.leagueId, fixture.league.id),
    ))).toHaveLength(0);
    if (!leased?.leaseExpiresAt) throw new Error("failed finalization did not retain its lease");

    const recoveryNow = new Date(new Date(leased.leaseExpiresAt + "Z").getTime() + 1);
    const recovered = await setupWeeklyAutopay({
      ...input,
      quoteFingerprint: quote.quoteFingerprint,
      now: recoveryNow,
    });
    expect(recovered.request.workflowStatus).toBe("completed");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toBe(provider.calls[0]);
    expect(provider.effects.size).toBe(1);
    expect(await db.select().from(payments).where(and(
      eq(payments.bowlerId, fixture.bowler.id),
      eq(payments.leagueId, fixture.league.id),
    ))).toHaveLength(1);
  });
});
