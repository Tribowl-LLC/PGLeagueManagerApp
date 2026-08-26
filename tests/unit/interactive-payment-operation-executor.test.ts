import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  payments,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperations,
  occurrencePaymentResponsibilities,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { expectErrorLog } from "../helpers/expected-error-logs";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  acquirePaymentOperationLease,
  createOrGetGeneralInteractivePaymentOperation,
  finalizePaymentOperationSuccess,
  getPaymentOperationForOrganization,
  persistRosterOperationSnapshot,
  PaymentOperationInvalidTransitionError,
  recordPaymentOperationProviderUnknown,
} from "../../server/storage/payment-operations";
import {
  buildCanonicalScheduleCommandFingerprint,
  cancelOccurrence,
} from "../../server/services/canonical-occurrence-transactions";
import { InteractivePaymentOperationExecutor } from "../../server/services/interactive-payment-operation-executor";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
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
import { RosterOperationSnapshotValidationError, type RosterOperationSemanticSnapshot } from "../../server/services/roster-operation-snapshot";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const fixedNow = new Date("2032-02-01T00:00:00.000Z");

interface InteractiveFixture {
  organizationId: number;
  actorUserId: number;
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

interface CardSaveCall {
  sourceId: string;
  customerId: string;
  idempotencyKey?: string;
}

class ScriptedInteractiveProvider implements PaymentProvider {
  readonly providerName = "square";
  readonly processCalls: PaymentCall[] = [];
  readonly orderCalls: Array<PaymentCall & { lineItems: OrderLineItem[] }> = [];
  readonly cardSaveCalls: CardSaveCall[] = [];
  readonly cardOwnershipCalls: Array<{ customerId: string; cardId: string }> = [];
  cardsOnFile: SavedCard[] = [];
  cardOwnershipOutcome: boolean | Error | undefined;
  readonly refundCalls: string[] = [];
  outcome: PaymentResult | Error = {
    id: "square-payment-default",
    status: "COMPLETED",
    orderId: "square-order-default",
    receiptUrl: "https://square.example.test/receipt",
    receiptNumber: "LV-EXECUTOR-TEST",
  };
  cardSaveOutcome: SavedCard | null | Error = {
    id: "ccof:executor-saved-card",
    last4: "1111",
    brand: "VISA",
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

  async saveCardOnFile(
    sourceId: string,
    customerId: string,
    idempotencyKey?: string,
  ): Promise<SavedCard | null> {
    this.cardSaveCalls.push({ sourceId, customerId, idempotencyKey });
    await this.beforeCall?.();
    if (this.cardSaveOutcome instanceof Error) throw this.cardSaveOutcome;
    return this.cardSaveOutcome;
  }
  async listCardsOnFile(): Promise<SavedCard[]> { return this.cardsOnFile; }
  async hasCardOnFile(customerId: string, cardId: string): Promise<boolean> {
    this.cardOwnershipCalls.push({ customerId, cardId });
    if (this.cardOwnershipOutcome instanceof Error) throw this.cardOwnershipOutcome;
    return this.cardOwnershipOutcome ?? this.cardsOnFile.some(card => card.id === cardId);
  }
  async disableCard(): Promise<void> {}
  async createOrUpdateCustomer(): Promise<PaymentCustomer | null> { return null; }
  async getPayment(): Promise<PaymentVerification | null> { return null; }
  validateCardId(cardId: string | null): boolean { return cardId?.startsWith("ccof:") ?? false; }
}

const slugs = [
  `interactive-executor-a-${suffix}`,
  `interactive-executor-b-${suffix}`,
] as const;
let fixtures: [InteractiveFixture, InteractiveFixture];
let occurrenceSequence = 0;

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
      accessToken: ["fixture", "access", "value"].join("-"),
      locationId: `SQUARE_EXECUTOR_${index}`,
    },
  }).returning({ id: locations.id });
  if (!location) throw new Error("executor location was not created");
  const [actor] = await db.insert(users).values({
    email: `interactive-executor-${index}-${suffix}@example.test`,
    password: "interactive-executor-test-password-hash",
    name: `Interactive Executor Actor ${index}`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!actor) throw new Error("executor actor was not created");

  const [league] = await db.insert(leagues).values({
    name: `Interactive Executor League ${index}`,
    seasonStart: "2032-01-01T00:00:00.000Z",
    seasonEnd: "2032-12-31T23:59:59.000Z",
    weekDay: "Monday",
    weeklyFee: 2_000,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    timezone: "UTC",
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
  await db.insert(teamPaymentSlots).values([
    { organizationId: organization.id, leagueId: league.id, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowler.id, recordedByUserId: actor.id },
    { organizationId: organization.id, leagueId: league.id, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actor.id },
    { organizationId: organization.id, leagueId: league.id, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actor.id },
  ]);

  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    locationId: location.id,
    leagueId: league.id,
    bowlerId: bowler.id,
    providerLocationId: `SQUARE_EXECUTOR_${index}`,
  };
}

async function createObligation(fixture: InteractiveFixture): Promise<{
  obligation: typeof paymentObligations.$inferSelect;
  responsibility: typeof occurrencePaymentResponsibilities.$inferSelect;
}> {
  occurrenceSequence += 1;
  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    actorUserId: fixture.actorUserId,
    commandType: "publish",
    idempotencyKey: `interactive-executor-publish-${suffix}-${occurrenceSequence}`,
    requestFingerprint: `interactive-executor-fingerprint-${occurrenceSequence}`,
  });
  const startAt = new Date(Date.UTC(2032, 1, occurrenceSequence + 1, 19, 0, 0)).toISOString();
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    locationId: fixture.locationId,
    generationKey: `interactive-executor-occurrence-${suffix}-${occurrenceSequence}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: startAt.slice(0, 10),
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "interactive-executor-test",
    plannedOrdinal: occurrenceSequence,
    competitionNumber: occurrenceSequence,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: fixture.actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  if (!occurrence) throw new Error("executor occurrence was not created");
  await db.transaction((tx) => materializeRosterPaymentOccurrenceInTransaction(tx, {
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    occurrenceId: occurrence.id,
    actorUserId: fixture.actorUserId,
  }));
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, fixture.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, fixture.leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  if (!responsibility) throw new Error("executor responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(eq(paymentObligations.responsibilityId, responsibility.id));
  if (!obligation) throw new Error("executor obligation was not materialized");
  return { obligation, responsibility };
}

async function prepareOperation(
  fixture: InteractiveFixture,
  options: {
    requestKey?: string;
    requestKind?: "direct" | "order";
    storeCard?: boolean;
    sourceKind?: "new_card" | "saved_card" | "wallet";
    sourceId?: string;
    snapshotVersion?: 2;
    authorizingUserId?: number | null;
    amountMinor?: number;
    additionalEvidence?: Array<Awaited<ReturnType<typeof createObligation>>>;
  } = {},
): Promise<{
  operation: Awaited<ReturnType<typeof createOrGetGeneralInteractivePaymentOperation>>;
  snapshot: RosterOperationSemanticSnapshot;
}> {
  const requestKind = options.requestKind ?? "direct";
  const snapshotVersion = options.snapshotVersion ?? 2;
  const sourceKind = options.sourceKind ?? "new_card";
  const evidence = await createObligation(fixture);
  const evidenceRows = [evidence, ...(options.additionalEvidence ?? [])];
  const amountMinor = options.amountMinor ?? 2_000;
  const operation = await createOrGetGeneralInteractivePaymentOperation({
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    requestKey: options.requestKey ?? `executor-${randomUUID()}`,
    amountMinor,
    currency: "USD",
    providerName: "square",
    authorizingUserId: options.authorizingUserId ?? fixture.actorUserId,
    now: fixedNow,
  });
  const snapshot: RosterOperationSemanticSnapshot = {
    snapshotVersion,
    organizationId: fixture.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId: fixture.leagueId,
    locationId: fixture.locationId,
    providerLocationId: requestKind === "order" ? fixture.providerLocationId : null,
    payerBowlerId: fixture.bowlerId,
    requestKind,
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      operation.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: requestKind === "order"
      ? deriveSquareOperationIdempotencyKey(operation.providerIdempotencyKey, "order")
      : null,
    sourceId: options.sourceId ?? (sourceKind === "saved_card"
      ? "ccof:executor-existing-card"
      : `cnon:executor-${randomUUID()}`),
    customerId: "CUSTOMER_EXECUTOR_TEST",
    buyerEmail: "executor@example.test",
    storeCard: options.storeCard ?? false,
    sourceKind,
    quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
    allocations: evidenceRows.map((row, allocationIndex) => ({
      allocationIndex,
      bowlerId: fixture.bowlerId,
      amountMinor: row.obligation.amountMinor,
      notes: "interactive executor test",
      paidByUserId: null,
      obligationId: row.obligation.id,
      responsibilityId: row.responsibility.id,
      responsibilityVersion: row.responsibility.version,
    })),
    lineItems: requestKind === "order"
      ? [
        { lineItemIndex: 0, catalogObjectId: "LINEAGE_EXECUTOR", quantity: "1" },
        { lineItemIndex: 1, catalogObjectId: "PRIZE_EXECUTOR", quantity: "1" },
      ]
      : [],
  };
  await db.transaction(async (tx) => {
    await persistRosterOperationSnapshot(operation, snapshot, tx);
    await tx.insert(paymentOperationRosterSnapshotItems).values(evidenceRows.map((row, allocationIndex) => ({
      operationId: operation.id,
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      obligationId: row.obligation.id,
      allocationIndex,
      amountMinor: row.obligation.amountMinor,
      state: "reserved" as const,
    })));
  });
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
  it("fails closed for an interactive operation without its roster snapshot", async () => {
    const fixture = fixtures[0];
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      requestKey: `missing-roster-snapshot-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
      authorizingUserId: fixture.actorUserId,
    });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    expectErrorLog(/Interactive operation snapshot failed closed/);
    const result = await createExecutor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });
    expect(result?.status).toBe("failed_terminal");
    expect(result?.errorCode).toBe("SNAPSHOT_INVALID");
    expect(provider.processCalls).toHaveLength(0);
  });

  it("rejects direct snapshots carrying a provider location before provider I/O", async () => {
    const fixture = fixtures[0];
    const { operation, snapshot } = await prepareOperation(fixture);
    await expect(db.transaction((tx) => persistRosterOperationSnapshot(operation, {
      ...snapshot,
      providerLocationId: fixture.providerLocationId,
    }, tx))).rejects.toBeInstanceOf(RosterOperationSnapshotValidationError);
  });

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
      providerLocationId: undefined,
      referenceId: operation.id,
    });
    const [payment] = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(payment).toMatchObject({
      status: "paid",
      providerPaymentId: "square-payment-default",
      idempotencyKey: operation.id,
    });
  });

  it("charges two obligations for the same payer across different occurrences", async () => {
    const fixture = fixtures[0];
    const secondEvidence = await createObligation(fixture);
    const { operation, snapshot } = await prepareOperation(fixture, {
      amountMinor: 4_000,
      additionalEvidence: [secondEvidence],
    });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);

    await expect(createExecutor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    })).resolves.toMatchObject({ status: "succeeded" });

    expect(provider.processCalls).toHaveLength(1);
    expect(provider.processCalls[0]?.amount).toBe(4_000);
    const paymentsForOperation = await db.select({ bowlerId: payments.bowlerId, createdAt: payments.createdAt, amount: payments.amount })
      .from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(paymentsForOperation).toHaveLength(1);
    expect(paymentsForOperation[0]).toMatchObject({ bowlerId: fixture.bowlerId, amount: 4_000 });
    expect(snapshot.allocations).toHaveLength(2);
    expect(snapshot.allocations[0]?.bowlerId).toBe(snapshot.allocations[1]?.bowlerId);
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
      referenceId: operation.id,
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

  it("vaults a new card before charging and then charges the saved-card ID", async () => {
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
    expect(provider.cardSaveCalls).toHaveLength(1);
    expect(provider.cardSaveCalls[0]?.sourceId).toMatch(/^cnon:executor-/);
    expect(provider.cardSaveCalls[0]?.idempotencyKey).toMatch(/^lv-sq1-c-/);
    expect(provider.processCalls).toHaveLength(1);
    expect(provider.processCalls[0]?.sourceId).toBe("ccof:executor-saved-card");
    expect(provider.processCalls[0]?.storeCard).toBe(false);
    expect(provider.orderCalls).toHaveLength(0);
  });

  it("charges an owned saved card without calling CreateCard", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { sourceKind: "saved_card" });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    provider.cardsOnFile = [{ id: "ccof:executor-existing-card", last4: "4242", brand: "VISA" }];
    const result = await createExecutor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result?.status).toBe("succeeded");
    expect(provider.cardSaveCalls).toHaveLength(0);
    expect(provider.processCalls[0]?.sourceId).toBe("ccof:executor-existing-card");
  });

  it("treats a successful strict ownership miss as a genuine saved-card mismatch", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { sourceKind: "saved_card" });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);

    const result = await createExecutor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "failed_terminal",
      errorClassification: "invalid_request",
      errorCode: "SAVED_CARD_OWNERSHIP_MISMATCH",
    });
    expect(provider.cardOwnershipCalls).toEqual([{
      customerId: "CUSTOMER_EXECUTOR_TEST",
      cardId: "ccof:executor-existing-card",
    }]);
    expect(provider.processCalls).toHaveLength(0);
  });

  it.each([
    ["transient", new PaymentProviderError("temporary", "TEMPORARY_ERROR", undefined, {
      disposition: "transient",
      providerCode: "TEMPORARY_ERROR",
    }), "retry_scheduled", "transient"],
    ["ambiguous", new PaymentProviderError("unknown", "CARD_OWNERSHIP_CHECK_FAILED", undefined, {
      disposition: "provider_unknown",
      providerCode: "SQUARE_TRANSPORT_UNKNOWN",
    }), "provider_unknown", "provider_unknown"],
    ["configuration", new ProviderNotConfiguredError("not configured", 1), "failed_terminal", "configuration"],
  ] as const)(
    "preserves a strict saved-card ownership %s failure without charging",
    async (_label, error, expectedStatus, expectedClassification) => {
      const fixture = fixtures[0];
      const { operation } = await prepareOperation(fixture, { sourceKind: "saved_card" });
      const provider = new ScriptedInteractiveProvider(fixture.locationId);
      provider.cardOwnershipOutcome = error;

      const result = await createExecutor(fixture, provider).execute({
        organizationId: fixture.organizationId,
        operationId: operation.id,
        now: fixedNow,
      });

      expect(result).toMatchObject({
        status: expectedStatus,
        errorClassification: expectedClassification,
      });
      expect(result?.errorCode).not.toBe("SAVED_CARD_OWNERSHIP_MISMATCH");
      expect(provider.cardOwnershipCalls).toHaveLength(1);
      expect(provider.processCalls).toHaveLength(0);
      expect(provider.orderCalls).toHaveLength(0);
    },
  );

  it.each(["new_card", "wallet"] as const)(
    "rejects a saved-card ID labeled as %s before any provider money movement",
    async (sourceKind) => {
      const fixture = fixtures[0];
      const { operation } = await prepareOperation(fixture, {
        sourceKind,
        sourceId: "ccof:executor-cross-payer-card",
      });
      const provider = new ScriptedInteractiveProvider(fixture.locationId);
      provider.cardsOnFile = [{
        id: "ccof:executor-cross-payer-card",
        last4: "9999",
        brand: "VISA",
      }];

      const result = await createExecutor(fixture, provider).execute({
        organizationId: fixture.organizationId,
        operationId: operation.id,
        now: fixedNow,
      });

      expect(result).toMatchObject({
        status: "failed_terminal",
        errorClassification: "invalid_request",
        errorCode: "PAYMENT_SOURCE_KIND_MISMATCH",
      });
      expect(provider.cardSaveCalls).toHaveLength(0);
      expect(provider.processCalls).toHaveLength(0);
      expect(provider.orderCalls).toHaveLength(0);
    },
  );

  it("does not charge when card creation fails", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { storeCard: true });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    provider.cardSaveOutcome = new PaymentProviderError("declined", "CARD_DECLINED", undefined, {
      disposition: "action_required",
      providerCode: "CARD_DECLINED",
    });
    const result = await createExecutor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result?.status).toBe("action_required");
    expect(provider.processCalls).toHaveLength(0);
    expect(provider.cardSaveCalls).toHaveLength(1);
  });

  it.each([
    ["transient", new PaymentProviderError("temporary", "TEMPORARY_ERROR", undefined, {
      disposition: "transient",
      providerCode: "TEMPORARY_ERROR",
    }), "retry_scheduled"],
    ["ambiguous", new PaymentProviderError("unknown", "SAVE_CARD_FAILED", undefined, {
      disposition: "provider_unknown",
      providerCode: "SQUARE_TRANSPORT_UNKNOWN",
    }), "provider_unknown"],
  ] as const)(
    "keeps card creation %s outcomes recoverable without charging",
    async (_label, error, expectedStatus) => {
      const fixture = fixtures[0];
      const { operation } = await prepareOperation(fixture, { storeCard: true });
      const provider = new ScriptedInteractiveProvider(fixture.locationId);
      provider.cardSaveOutcome = error;

      const result = await createExecutor(fixture, provider).execute({
        organizationId: fixture.organizationId,
        operationId: operation.id,
        now: fixedNow,
      });

      expect(result?.status).toBe(expectedStatus);
      expect(result?.cardSaveStatus).toBe("pending");
      expect(provider.cardSaveCalls).toHaveLength(1);
      expect(provider.processCalls).toHaveLength(0);
    },
  );

  it("retries an ambiguous CreateCard outcome with the exact same key before charging", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { storeCard: true });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    provider.cardSaveOutcome = new PaymentProviderError(
      "unknown",
      "SAVE_CARD_FAILED",
      undefined,
      {
        disposition: "provider_unknown",
        providerCode: "SQUARE_TRANSPORT_UNKNOWN",
      },
    );
    let clock = fixedNow;
    const executor = createExecutor(fixture, provider, { now: () => clock });

    const first = await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: clock,
    });
    expect(first?.status).toBe("provider_unknown");
    if (!first?.nextAttemptAt) throw new Error("ambiguous card save did not schedule recovery");
    clock = new Date(parseStoredTimestamp(first.nextAttemptAt).getTime() + 1);
    provider.cardSaveOutcome = {
      id: "ccof:executor-card-after-unknown",
      last4: "1111",
      brand: "VISA",
    };

    await expect(executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: clock,
    })).resolves.toMatchObject({ status: "succeeded", cardSaveStatus: "saved" });
    expect(provider.cardSaveCalls).toHaveLength(2);
    expect(provider.cardSaveCalls[1]?.idempotencyKey)
      .toBe(provider.cardSaveCalls[0]?.idempotencyKey);
    expect(provider.processCalls).toHaveLength(1);
    expect(provider.processCalls[0]?.sourceId).toBe("ccof:executor-card-after-unknown");
  });

  it("retains a successfully-created card when the payment is declined", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { storeCard: true });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    provider.outcome = new PaymentProviderError("declined", "CARD_DECLINED", undefined, {
      disposition: "action_required",
      providerCode: "CARD_DECLINED",
    });
    const result = await createExecutor(fixture, provider).execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: fixedNow,
    });

    expect(result?.status).toBe("action_required");
    expect(provider.cardSaveCalls).toHaveLength(1);
    expect(provider.processCalls[0]?.sourceId).toBe("ccof:executor-saved-card");
    const saved = await getPaymentOperationForOrganization(fixture.organizationId, operation.id);
    expect(saved?.cardSaveStatus).toBe("saved");
  });

  it("recovers after a lost payment response without repeating CreateCard", async () => {
    const fixture = fixtures[0];
    const { operation } = await prepareOperation(fixture, { storeCard: true });
    const provider = new ScriptedInteractiveProvider(fixture.locationId);
    provider.outcome = new Error("payment response lost");
    let clock = fixedNow;
    const executor = createExecutor(fixture, provider, { now: () => clock });

    const first = await executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: clock,
    });
    expect(first?.status).toBe("provider_unknown");
    const retryAt = first?.nextAttemptAt;
    if (!retryAt) throw new Error("provider-unknown retry was not scheduled");
    clock = new Date(parseStoredTimestamp(retryAt).getTime() + 1);
    provider.outcome = {
      id: "square-payment-after-card-recovery",
      status: "COMPLETED",
    };

    await expect(executor.execute({
      organizationId: fixture.organizationId,
      operationId: operation.id,
      now: clock,
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(provider.cardSaveCalls).toHaveLength(1);
    expect(provider.processCalls).toHaveLength(2);
    expect(provider.processCalls[1]?.sourceId).toBe("ccof:executor-saved-card");
    expect(provider.processCalls[1]?.idempotencyKey)
      .toEqual(provider.processCalls[0]?.idempotencyKey);
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
