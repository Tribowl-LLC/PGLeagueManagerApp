import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import {
  bowlers,
  bowlerLeagues,
  leagues,
  organizations,
  paymentOperations,
  paymentSchedules,
  payments,
  teams,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationSnapshots,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  PaymentOperationImmutableMismatchError,
  PaymentOperationInvalidTransitionError,
  PaymentOperationNotFoundError,
  PaymentOperationValidationError,
  GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH,
  acquirePaymentOperationLease,
  cancelPaymentOperation,
  createOrGetScheduledPaymentOperation,
  createOrGetGeneralInteractivePaymentOperation,
  finalizePaymentOperationSuccess,
  getPaymentOperationForOrganization,
  getScheduledPaymentOperationSnapshotForOrganization,
  hasNonterminalScheduledPaymentOperation,
  persistScheduledPaymentOperationSnapshot,
  persistInteractivePaymentOperationSnapshot,
  getInteractivePaymentOperationSnapshotForOrganization,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  recordExpiredPaymentOperationAttemptExhausted,
  reconcilePaymentOperationSuccess,
  schedulePaymentOperationRetry,
} from "../../server/storage/payment-operations";
import {
  deriveSquareOperationIdempotencyKey,
} from "../../server/services/payment-operation-idempotency";
import {
  bindInteractiveOccurrenceRequestFingerprint,
  buildPaymentOperationIdentity,
  fingerprintInteractiveOccurrenceIntent,
} from "../../server/services/payment-operation-idempotency";
import type { ScheduledPaymentSemanticSnapshot } from "../../server/services/scheduled-payment-operation-snapshot";
import type { InteractivePaymentSemanticSnapshot } from "../../server/services/interactive-payment-operation-snapshot";
import { encryptInteractivePaymentSnapshot } from "../../server/services/interactive-payment-operation-snapshot";

const db = getTestDb();
const poolSuffix = process.env.VITEST_POOL_ID ?? "0";
const orgSlugs = [
  `payment-operations-a-${poolSuffix}`,
  `payment-operations-b-${poolSuffix}`,
] as const;

let orgAId: number;
let orgBId: number;
let scheduleAId: number;
let scheduleBId: number;
let nextCycleOffset = 0;

function timestampToIso(value: string | null): string | null {
  if (value === null) return null;
  const includesZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  return new Date(includesZone ? value : `${value.replace(" ", "T")}Z`).toISOString();
}

function cycleAt(offset = nextCycleOffset++): Date {
  return new Date(Date.UTC(2032, 0, 1 + offset, 12, 0, 0));
}

async function createFixtureSchedule(organizationId: number, label: string): Promise<number> {
  const [league] = await db.insert(leagues).values({
    name: `Payment Operations ${label}`,
    seasonStart: "2032-01-01T00:00:00.000Z",
    seasonEnd: "2032-12-31T00:00:00.000Z",
    weekDay: "Monday",
    weeklyFee: 2_000,
    organizationId,
  }).returning({ id: leagues.id });
  if (!league) throw new Error("fixture league was not created");

  const [bowler] = await db.insert(bowlers).values({
    name: `Payment Operations Bowler ${label}`,
    organizationId,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("fixture bowler was not created");

  const [team] = await db.insert(teams).values({
    name: `Payment Operations Team ${label}`,
    number: 1,
    leagueId: league.id,
  }).returning({ id: teams.id });
  if (!team) throw new Error("fixture team was not created");
  await db.insert(bowlerLeagues).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    teamId: team.id,
  });

  const [schedule] = await db.insert(paymentSchedules).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    frequency: "weekly",
    amount: 2_000,
    nextPaymentDate: "2032-01-05T23:30:00.000Z",
    paymentCardId: `fake-card-${label.toLowerCase()}`,
  }).returning({ id: paymentSchedules.id });
  if (!schedule) throw new Error("fixture schedule was not created");
  return schedule.id;
}

async function createOperation(
  organizationId = orgAId,
  paymentScheduleId = scheduleAId,
  billingCycleAt = cycleAt(),
  amountMinor = 2_000,
) {
  return createOrGetScheduledPaymentOperation({
    organizationId,
    paymentScheduleId,
    billingCycleAt,
    amountMinor,
    currency: "USD",
    providerName: "square",
  });
}

async function getScheduleContext(scheduleId = scheduleAId): Promise<{
  bowlerId: number;
  leagueId: number;
}> {
  const [schedule] = await db
    .select({
      bowlerId: paymentSchedules.bowlerId,
      leagueId: paymentSchedules.leagueId,
    })
    .from(paymentSchedules)
    .where(eq(paymentSchedules.id, scheduleId))
    .limit(1);
  if (!schedule) throw new Error("fixture schedule was not found");
  return schedule;
}

async function buildDirectSnapshot(
  operation: Awaited<ReturnType<typeof createOperation>>,
  overrides: Partial<ScheduledPaymentSemanticSnapshot> = {},
): Promise<ScheduledPaymentSemanticSnapshot> {
  if (!operation.paymentScheduleId || !operation.billingCycleAt) {
    throw new Error("scheduled operation fixture is incomplete");
  }
  const { bowlerId, leagueId } = await getScheduleContext(operation.paymentScheduleId);
  return {
    snapshotVersion: 1,
    organizationId: operation.organizationId,
    paymentScheduleId: operation.paymentScheduleId,
    billingCycleAt: timestampToIso(operation.billingCycleAt) ?? operation.billingCycleAt,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId,
    locationId: null,
    providerLocationId: "L_IMMUTABLE_TEST",
    requestKind: "direct",
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      operation.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: null,
    autocomplete: true,
    storeCard: false,
    sourceId: "fake-encrypted-source-reference",
    customerId: "fake-customer-reference",
    buyerEmail: "fixture@example.test",
    isDoublePay: false,
    deactivateScheduleOnPreparation: false,
    paidInFullThresholdAmountMinor: null,
    seasonStartAt: null,
    seasonEndAt: null,
    allocations: [{
      allocationIndex: 0,
      bowlerId,
      amountMinor: operation.amountMinor,
      lineageAmountMinor: 0,
      prizeFundAmountMinor: 0,
      notes: null,
      paidByUserId: null,
    }],
    lineItems: [],
    ...overrides,
  };
}

async function linkedPaymentValues(input: {
  bowlerId: number;
  leagueId: number;
  amount?: number;
  status?: "paid" | "failed";
  providerPaymentId?: string;
  combinedChargeGroupId?: string | null;
  notes?: string | null;
}) {
  return {
    bowlerId: input.bowlerId,
    leagueId: input.leagueId,
    amount: input.amount ?? 2_000,
    lineageAmount: 0,
    prizeFundAmount: 0,
    weekOf: "2032-02-02T12:00:00.000Z",
    status: input.status ?? "paid",
    type: "square" as const,
    providerPaymentId: input.providerPaymentId,
    combinedChargeGroupId: input.combinedChargeGroupId,
    notes: input.notes,
  };
}

beforeAll(async () => {
  const leftovers = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.slug, orgSlugs));
  for (const leftover of leftovers) await deleteOrganization(leftover.id);

  const [orgA, orgB] = await db.insert(organizations).values([
    { name: "Payment Operations Tenant A", slug: orgSlugs[0] },
    { name: "Payment Operations Tenant B", slug: orgSlugs[1] },
  ]).returning({ id: organizations.id, slug: organizations.slug });
  if (!orgA || !orgB) throw new Error("fixture organizations were not created");
  const bySlug = new Map([orgA, orgB].map((row) => [row.slug, row.id]));
  const foundA = bySlug.get(orgSlugs[0]);
  const foundB = bySlug.get(orgSlugs[1]);
  if (foundA === undefined || foundB === undefined) throw new Error("fixture organizations are incomplete");
  orgAId = foundA;
  orgBId = foundB;
  scheduleAId = await createFixtureSchedule(orgAId, "A");
  scheduleBId = await createFixtureSchedule(orgBId, "B");
});

function buildInteractiveSnapshot(
  operation: Awaited<ReturnType<typeof createOrGetGeneralInteractivePaymentOperation>>,
  context: { bowlerId: number; leagueId: number },
  overrides: Partial<InteractivePaymentSemanticSnapshot> = {},
): InteractivePaymentSemanticSnapshot {
  const weekOf = "2032-02-02T00:00:00.000Z";
  return {
    snapshotVersion: 2,
    organizationId: operation.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId: context.leagueId,
    locationId: null,
    providerLocationId: null,
    payerBowlerId: context.bowlerId,
    requestKind: "direct",
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      operation.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: null,
    sourceId: "cnon-interactive-test-source",
    customerId: null,
    buyerEmail: "interactive@example.test",
    storeCard: false,
    sourceKind: "new_card",
    weekOf,
    combinedChargeGroupId: null,
    allocations: [{
      allocationIndex: 0,
      bowlerId: context.bowlerId,
      amountMinor: operation.amountMinor,
      lineageAmountMinor: 1_000,
      prizeFundAmountMinor: 1_000,
      weekOf,
      notes: "Interactive test payment",
      paidByUserId: null,
    }],
    lineItems: [],
    ...overrides,
  };
}

describe("general interactive payment operation foundation", () => {
  it("uses a reserved target namespace and converges concurrent identical preparation", async () => {
    const requestKey = `same-request-${randomUUID()}`;
    const input = {
      organizationId: orgAId,
      requestKey,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    };
    const [first, second] = await Promise.all([
      createOrGetGeneralInteractivePaymentOperation(input),
      createOrGetGeneralInteractivePaymentOperation(input),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.targetKey).toBe(`interactive-charge:${requestKey}`);

    const rows = await db.select({ id: paymentOperations.id })
      .from(paymentOperations)
      .where(eq(paymentOperations.targetKey, first.targetKey));
    expect(rows).toHaveLength(1);
  });

  it("keeps genuinely new request identities separate", async () => {
    const [first, second] = await Promise.all([
      createOrGetGeneralInteractivePaymentOperation({
        organizationId: orgAId,
        requestKey: `new-request-a-${randomUUID()}`,
        amountMinor: 2_000,
        currency: "USD",
        providerName: "square",
      }),
      createOrGetGeneralInteractivePaymentOperation({
        organizationId: orgAId,
        requestKey: `new-request-b-${randomUUID()}`,
        amountMinor: 2_000,
        currency: "USD",
        providerName: "square",
      }),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first.providerIdempotencyKey).not.toBe(second.providerIdempotencyKey);
  });

  it("bounds the request key so the namespaced target fits the ledger column", async () => {
    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: "a".repeat(GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH),
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).resolves.toMatchObject({
      targetKey: `interactive-charge:${"a".repeat(GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH)}`,
    });

    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: "b".repeat(GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH + 1),
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationValidationError);
  });

  it("fails closed when the same logical identity has different immutable contents", async () => {
    const requestKey = `mismatch-${randomUUID()}`;
    await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });

    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey,
      amountMinor: 2_500,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("binds canonical occurrence intent into immutable request identity and serializes distinct reservations", async () => {
    const requestKeyA = `f2-reservation-a-${randomUUID()}`;
    const requestKeyB = `f2-reservation-b-${randomUUID()}`;
    const selections = [{ obligationId: randomUUID(), amountMinor: 2_000 }];
    const intentA = fingerprintInteractiveOccurrenceIntent({ selections, quoteFingerprint: `lvpayquote:v1:${'a'.repeat(64)}` });
    const intentB = fingerprintInteractiveOccurrenceIntent({ selections, quoteFingerprint: `lvpayquote:v1:${'b'.repeat(64)}` });
    const [first, second] = await Promise.all([
      createOrGetGeneralInteractivePaymentOperation({ organizationId: orgAId, requestKey: requestKeyA, amountMinor: 2_000, currency: 'USD', providerName: 'square', immutableSemanticFingerprint: intentA }),
      createOrGetGeneralInteractivePaymentOperation({ organizationId: orgAId, requestKey: requestKeyB, amountMinor: 2_000, currency: 'USD', providerName: 'square', immutableSemanticFingerprint: intentB }),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first.requestFingerprint).not.toBe(second.requestFingerprint);
    const baseIdentity = buildPaymentOperationIdentity({
      organizationId: orgAId,
      operationType: 'interactive_charge',
      targetKey: first.targetKey,
      amountMinor: 2_000,
      currency: 'USD',
      providerName: 'square',
    });
    expect(first.requestFingerprint).toBe(bindInteractiveOccurrenceRequestFingerprint(baseIdentity.requestFingerprint, intentA));
    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: requestKeyA,
      amountMinor: 2_000,
      currency: 'USD',
      providerName: 'square',
      immutableSemanticFingerprint: intentB,
    })).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("normalizes selection order for the semantic fingerprint", () => {
    const first = { obligationId: '11111111-1111-4111-8111-111111111111', amountMinor: 500 };
    const second = { obligationId: '22222222-2222-4222-8222-222222222222', amountMinor: 1_500 };
    const quoteFingerprint = `lvpayquote:v1:${'c'.repeat(64)}`;
    expect(fingerprintInteractiveOccurrenceIntent({ selections: [first, second], quoteFingerprint }))
      .toBe(fingerprintInteractiveOccurrenceIntent({ selections: [second, first], quoteFingerprint }));
  });

  it("persists one encrypted, tenant-validated snapshot under concurrent duplicate preparation", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: `snapshot-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const context = await getScheduleContext(scheduleAId);
    const snapshot = buildInteractiveSnapshot(operation, context);

    const [first, second] = await Promise.all([
      db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, snapshot, tx)),
      db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, snapshot, tx)),
    ]);
    expect(first).toEqual(snapshot);
    expect(second).toEqual(snapshot);
    expect(await getInteractivePaymentOperationSnapshotForOrganization(orgAId, operation.id))
      .toEqual(snapshot);
    expect(await getInteractivePaymentOperationSnapshotForOrganization(orgBId, operation.id))
      .toBeUndefined();
  });

  it("rejects a changed snapshot fingerprint instead of converging silently", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: `snapshot-mismatch-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const snapshot = buildInteractiveSnapshot(operation, await getScheduleContext(scheduleAId));
    await db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, snapshot, tx));

    await expect(db.transaction((tx) => persistInteractivePaymentOperationSnapshot(
      operation,
      { ...snapshot, sourceId: "cnon-different-source" },
      tx,
    ))).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("returns a deterministic fingerprint mismatch to the losing concurrent preparer", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: `concurrent-mismatch-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const context = await getScheduleContext(scheduleAId);
    const firstSnapshot = buildInteractiveSnapshot(operation, context);
    const secondSnapshot = { ...firstSnapshot, buyerEmail: "different@example.test" };

    const results = await Promise.allSettled([
      db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, firstSnapshot, tx)),
      db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, secondSnapshot, tx)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason : undefined)
      .toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("rejects cross-tenant league, payer, and allocation references", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: `tenant-mismatch-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const tenantBContext = await getScheduleContext(scheduleBId);
    const snapshot = buildInteractiveSnapshot(operation, {
      bowlerId: tenantBContext.bowlerId,
      leagueId: tenantBContext.leagueId,
    });

    await expect(db.transaction((tx) => persistInteractivePaymentOperationSnapshot(
      operation,
      snapshot,
      tx,
    ))).rejects.toBeInstanceOf(PaymentOperationValidationError);
    expect(await getInteractivePaymentOperationSnapshotForOrganization(orgAId, operation.id))
      .toBeUndefined();
  });

  it("enforces the allocation total at the PostgreSQL transaction boundary", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      requestKey: `database-total-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const context = await getScheduleContext(scheduleAId);
    const snapshot = buildInteractiveSnapshot(operation, context);
    const stored = encryptInteractivePaymentSnapshot(snapshot);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(interactivePaymentOperationSnapshots).values({
          operationId: operation.id,
          ...stored,
        });
        await tx.insert(interactivePaymentOperationAllocations).values({
          operationId: operation.id,
          allocationIndex: 0,
          bowlerId: context.bowlerId,
          amountMinor: 1_999,
          lineageAmountMinor: 1_000,
          prizeFundAmountMinor: 999,
          weekOf: snapshot.weekOf,
          notes: null,
          paidByUserId: null,
        });
      });
      throw new Error("invalid allocation total was committed");
    } catch (error) {
      if (!(error instanceof Error) || !(error.cause instanceof Error)) throw error;
      expect(error.cause.message).toMatch(/allocation total must equal operation amount/i);
    }
  });
});

afterAll(async () => {
  if (orgAId) await deleteOrganization(orgAId);
  if (orgBId) await deleteOrganization(orgBId);
});

describe("payment operation ledger PostgreSQL invariants", () => {
  it("converges two schedule-cycle creates on one logical row", async () => {
    const billingCycleAt = cycleAt();
    const input = {
      organizationId: orgAId,
      paymentScheduleId: scheduleAId,
      billingCycleAt,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    };

    const [first, second] = await Promise.all([
      createOrGetScheduledPaymentOperation(input),
      createOrGetScheduledPaymentOperation(input),
    ]);
    expect(second.id).toBe(first.id);

    const rows = await db.select({ id: paymentOperations.id })
      .from(paymentOperations)
      .where(and(
        eq(paymentOperations.paymentScheduleId, scheduleAId),
        sql`${paymentOperations.billingCycleAt} = ${billingCycleAt.toISOString()}`,
      ));
    expect(rows).toHaveLength(1);
  });

  it("fails closed when an immutable recurring request changes", async () => {
    const billingCycleAt = cycleAt();
    await createOperation(orgAId, scheduleAId, billingCycleAt, 2_000);
    await expect(createOperation(orgAId, scheduleAId, billingCycleAt, 2_500))
      .rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("persists and verifies the encrypted execution snapshot in the caller transaction", async () => {
    const operation = await createOperation();
    const snapshot = await buildDirectSnapshot(operation);
    const persisted = await db.transaction(async (tx) =>
      persistScheduledPaymentOperationSnapshot(operation, snapshot, tx));
    expect(persisted).toEqual(snapshot);

    const loaded = await getScheduledPaymentOperationSnapshotForOrganization(orgAId, operation.id);
    expect(loaded).toEqual(snapshot);
    expect(await getScheduledPaymentOperationSnapshotForOrganization(orgBId, operation.id))
      .toBeUndefined();

    await expect(db.transaction(async (tx) =>
      persistScheduledPaymentOperationSnapshot(
        operation,
        { ...snapshot, sourceId: "changed-source-reference" },
        tx,
      )))
      .rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("rejects cross-tenant references before persisting an execution snapshot", async () => {
    const operation = await createOperation();
    const snapshot = await buildDirectSnapshot(operation);
    const tenantBSchedule = await getScheduleContext(scheduleBId);

    await expect(db.transaction(async (tx) =>
      persistScheduledPaymentOperationSnapshot(
        operation,
        {
          ...snapshot,
          allocations: [{
            ...snapshot.allocations[0],
            bowlerId: tenantBSchedule.bowlerId,
          }],
        },
        tx,
      )))
      .rejects.toBeInstanceOf(PaymentOperationValidationError);

    expect(await getScheduledPaymentOperationSnapshotForOrganization(orgAId, operation.id))
      .toBeUndefined();
  });

  it("allows exactly one active lease and will not steal it before expiry", async () => {
    const operation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const [workerA, workerB] = await Promise.all([
      acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: "worker-a",
        leaseDurationMs: 60_000,
        now,
      }),
      acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: "worker-b",
        leaseDurationMs: 60_000,
        now,
      }),
    ]);
    expect([workerA, workerB].filter(Boolean)).toHaveLength(1);
    const winner = workerA ?? workerB;
    if (!winner) throw new Error("expected a lease winner");
    expect(winner.status).toBe("leased");
    expect(winner.attemptCount).toBe(1);

    const stolen = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "worker-c",
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 59_999),
    });
    expect(stolen).toBeUndefined();
  });

  it("recovers an expired lease and fences the stale worker token", async () => {
    const operation = await createOperation();
    const firstNow = new Date(Date.now() + 2_000);
    const first = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "worker-old",
      leaseDurationMs: 10_000,
      now: firstNow,
    });
    if (!first?.leaseToken) throw new Error("first lease was not acquired");

    const second = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "worker-new",
      leaseDurationMs: 10_000,
      now: new Date(firstNow.getTime() + 10_001),
    });
    if (!second?.leaseToken) throw new Error("expired lease was not recovered");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.attemptCount).toBe(2);
    expect(second.leaseRecoveryCount).toBe(1);
    expect(second.lastLeaseRecoveredAt).not.toBeNull();

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: first.leaseToken,
      providerObjectId: "square-payment-stale",
      now: new Date(firstNow.getTime() + 10_002),
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);

    const completed = await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: second.leaseToken,
      providerObjectId: "square-payment-current",
      now: new Date(firstNow.getTime() + 10_003),
    });
    expect(completed.status).toBe("succeeded");
  });

  it("persists the exact retry due time and rejects a repeated transition", async () => {
    const operation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "retry-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("retry lease was not acquired");
    const nextAttemptAt = new Date(now.getTime() + 123_456);
    const retry = await schedulePaymentOperationRetry({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      nextAttemptAt,
      errorClassification: "transient",
      errorCode: "TEMPORARY_FAILURE",
      now,
    });
    expect(retry.status).toBe("retry_scheduled");
    expect(timestampToIso(retry.nextAttemptAt)).toBe(nextAttemptAt.toISOString());

    await expect(schedulePaymentOperationRetry({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      nextAttemptAt: new Date(nextAttemptAt.getTime() + 1_000),
      errorClassification: "transient",
      now,
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);
  });

  it("records provider-unknown recovery and action-required terminal state", async () => {
    const operation = await createOperation();
    const firstNow = new Date(Date.now() + 2_000);
    const first = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "unknown-worker",
      leaseDurationMs: 60_000,
      now: firstNow,
    });
    if (!first?.leaseToken) throw new Error("unknown-outcome lease was not acquired");
    const recoveryAt = new Date(firstNow.getTime() + 90_000);
    const unknown = await recordPaymentOperationProviderUnknown({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: first.leaseToken,
      recoveryAt,
      errorCode: "REQUEST_TIMEOUT",
      now: firstNow,
    });
    expect(unknown.status).toBe("provider_unknown");
    expect(timestampToIso(unknown.nextAttemptAt)).toBe(recoveryAt.toISOString());

    const recovered = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "reconcile-worker",
      leaseDurationMs: 60_000,
      now: recoveryAt,
    });
    if (!recovered?.leaseToken) throw new Error("provider-unknown operation was not reclaimed");
    const actionRequired = await recordPaymentOperationActionRequired({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: recovered.leaseToken,
      errorCode: "CARD_DECLINED",
      now: new Date(recoveryAt.getTime() + 1),
    });
    expect(actionRequired.status).toBe("action_required");
    expect(actionRequired.errorClassification).toBe("hard_decline");
    expect(actionRequired.completedAt).not.toBeNull();
  });

  it("finalizes success idempotently only for the completing lease token", async () => {
    const operation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "success-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("success lease was not acquired");
    const input = {
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-idempotent",
      now: new Date(now.getTime() + 1),
    };
    const first = await finalizePaymentOperationSuccess(input);
    const replay = await finalizePaymentOperationSuccess(input);
    expect(replay.id).toBe(first.id);
    expect(replay.providerObjectId).toBe("square-payment-idempotent");
  });

  it("atomically finalizes one provider success with legitimate combined split rows", async () => {
    const operation = await createOperation(undefined, undefined, undefined, 4_000);
    const { bowlerId, leagueId } = await getScheduleContext();
    const [partner] = await db.insert(bowlers).values({
      name: "Payment Operations Combined Partner",
      organizationId: orgAId,
    }).returning({ id: bowlers.id });
    if (!partner) throw new Error("combined partner was not created");
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "combined-success-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("combined success lease was not acquired");
    const combinedChargeGroupId = "combined-operation-fixture";
    const providerPaymentId = "square-payment-combined";
    const paymentRows = [
      {
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId,
          leagueId,
          providerPaymentId,
          combinedChargeGroupId,
        }),
      },
      {
        allocationIndex: 1,
        values: await linkedPaymentValues({
          bowlerId: partner.id,
          leagueId,
          providerPaymentId,
          combinedChargeGroupId,
        }),
      },
    ];

    await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: providerPaymentId,
      providerOrderId: "square-order-combined",
      paymentRows,
      now: new Date(now.getTime() + 1),
    });
    await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: providerPaymentId,
      providerOrderId: "square-order-combined",
      paymentRows,
      now: new Date(now.getTime() + 2),
    });

    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.paymentOperationAllocationIndex).sort()).toEqual([0, 1]);
    expect(new Set(rows.map((row) => row.providerPaymentId))).toEqual(new Set([providerPaymentId]));
    expect(new Set(rows.map((row) => row.combinedChargeGroupId))).toEqual(
      new Set([combinedChargeGroupId]),
    );
  });

  it("rolls back operation success when local payment persistence fails", async () => {
    const operation = await createOperation();
    const { bowlerId, leagueId } = await getScheduleContext();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "local-failure-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("local failure lease was not acquired");

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-local-failure",
      paymentRows: [{
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId: 2_147_483_647,
          leagueId,
          providerPaymentId: "square-payment-local-failure",
        }),
      }],
      now: new Date(now.getTime() + 1),
    })).rejects.toBeDefined();

    const afterFailure = await getPaymentOperationForOrganization(orgAId, operation.id);
    expect(afterFailure?.status).toBe("leased");
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id)))
      .toHaveLength(0);

    const recovered = await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-local-failure",
      paymentRows: [{
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId,
          leagueId,
          providerPaymentId: "square-payment-local-failure",
        }),
      }],
      now: new Date(now.getTime() + 2),
    });
    expect(recovered.status).toBe("succeeded");
  });

  it("creates one deliberate combined failed-history row at action-required transition", async () => {
    const operation = await createOperation(undefined, undefined, undefined, 4_000);
    const { bowlerId, leagueId } = await getScheduleContext();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "combined-decline-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("combined decline lease was not acquired");
    const failedPaymentRows = [{
      allocationIndex: 0,
      values: await linkedPaymentValues({
        bowlerId,
        leagueId,
        amount: 2_000,
        status: "failed",
        notes: "Failed scheduled payment: card action required",
      }),
    }];
    const transition = {
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      errorCode: "CARD_DECLINED",
      failedPaymentRows,
      now: new Date(now.getTime() + 1),
    };
    await recordPaymentOperationActionRequired(transition);
    await recordPaymentOperationActionRequired(transition);

    const rows = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.amount).toBe(2_000);
  });

  it("rejects per-payee failed-history fanout for a combined decline", async () => {
    const operation = await createOperation(undefined, undefined, undefined, 4_000);
    const { bowlerId, leagueId } = await getScheduleContext();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "combined-decline-fanout-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("combined fanout lease was not acquired");
    const failed = await linkedPaymentValues({
      bowlerId,
      leagueId,
      amount: 2_000,
      status: "failed",
    });

    await expect(recordPaymentOperationActionRequired({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      errorCode: "CARD_DECLINED",
      failedPaymentRows: [
        { allocationIndex: 0, values: failed },
        { allocationIndex: 1, values: failed },
      ],
      now: new Date(now.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationValidationError);

    expect((await getPaymentOperationForOrganization(orgAId, operation.id))?.status)
      .toBe("leased");
  });

  it("atomically terminates the eighth failed attempt and cannot be leased again", async () => {
    const operation = await createOperation();
    let cursor = new Date(Date.now() + 2_000);
    let finalStatus: Awaited<ReturnType<typeof recordPaymentOperationProviderUnknown>> | undefined;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const leased = await acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: `exhaustion-worker-${attempt}`,
        leaseDurationMs: 60_000,
        now: cursor,
      });
      if (!leased?.leaseToken) throw new Error(`attempt ${attempt} was not leased`);
      const recoveryAt = new Date(cursor.getTime() + 1_000);
      finalStatus = await recordPaymentOperationProviderUnknown({
        organizationId: orgAId,
        operationId: operation.id,
        leaseToken: leased.leaseToken,
        recoveryAt,
        errorCode: "REQUEST_TIMEOUT",
        now: cursor,
      });
      cursor = recoveryAt;
    }

    expect(finalStatus?.status).toBe("reconciliation_required");
    expect(finalStatus?.attemptCount).toBe(8);
    expect(finalStatus?.errorCode).toBe("PROVIDER_OUTCOME_UNCERTAIN");
    expect(finalStatus?.nextAttemptAt).toBeNull();
    expect(finalStatus?.completedAt).not.toBeNull();
    expect(await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
    expect(await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "ninth-worker",
      leaseDurationMs: 60_000,
      now: cursor,
    })).toBeUndefined();
  });

  it("atomically terminates an expired eighth lease and fences its stale worker", async () => {
    const operation = await createOperation();
    let cursor = new Date(Date.now() + 2_000);
    let eighthLease: Awaited<ReturnType<typeof acquirePaymentOperationLease>>;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const leased = await acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: `expired-exhaustion-worker-${attempt}`,
        leaseDurationMs: 1_000,
        now: cursor,
      });
      if (!leased?.leaseToken) throw new Error(`expired attempt ${attempt} was not leased`);
      if (attempt === 8) {
        eighthLease = leased;
        break;
      }
      const recoveryAt = new Date(cursor.getTime() + 1_000);
      await recordPaymentOperationProviderUnknown({
        organizationId: orgAId,
        operationId: operation.id,
        leaseToken: leased.leaseToken,
        recoveryAt,
        errorCode: "REQUEST_TIMEOUT",
        now: cursor,
      });
      cursor = recoveryAt;
    }
    if (!eighthLease?.leaseToken || !eighthLease.leaseExpiresAt) {
      throw new Error("eighth lease fixture was not created");
    }
    const expiryIso = timestampToIso(eighthLease.leaseExpiresAt);
    if (!expiryIso) throw new Error("eighth lease expiration was invalid");
    const afterExpiry = new Date(expiryIso);
    const terminal = await recordExpiredPaymentOperationAttemptExhausted({
      organizationId: orgAId,
      operationId: operation.id,
      now: afterExpiry,
    });
    expect(terminal?.status).toBe("reconciliation_required");
    expect(terminal?.errorCode).toBe("PROVIDER_OUTCOME_UNCERTAIN");

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: eighthLease.leaseToken,
      providerObjectId: "square-payment-after-expired-exhaustion",
      now: new Date(afterExpiry.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);

    await expect(reconcilePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: randomUUID(),
      providerObjectId: "square-payment-after-expired-exhaustion",
      now: new Date(afterExpiry.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);

    const reconciled = await reconcilePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: eighthLease.leaseToken,
      providerObjectId: "square-payment-after-expired-exhaustion",
      now: new Date(afterExpiry.getTime() + 2),
    });
    expect(reconciled.status).toBe("succeeded");
  });

  it("exposes the dormant legacy guard without connecting it to production", async () => {
    const operation = await createOperation();
    expect(await hasNonterminalScheduledPaymentOperation({
      organizationId: orgAId,
      paymentScheduleId: scheduleAId,
    })).toBe(true);
    expect(await hasNonterminalScheduledPaymentOperation({
      organizationId: orgBId,
      paymentScheduleId: scheduleAId,
    })).toBe(false);

    await cancelPaymentOperation({
      organizationId: orgAId,
      operationId: operation.id,
      now: new Date(Date.now() + 2_000),
    });
  });

  it("records terminal failure and deliberate cancellation without raw error detail", async () => {
    const failedOperation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: failedOperation.id,
      leaseOwner: "terminal-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("terminal lease was not acquired");
    const failed = await recordPaymentOperationFailedTerminal({
      organizationId: orgAId,
      operationId: failedOperation.id,
      leaseToken: leased.leaseToken,
      errorClassification: "configuration",
      errorCode: "LOCATION_NOT_CONFIGURED",
      now: new Date(now.getTime() + 1),
    });
    expect(failed.status).toBe("failed_terminal");
    expect(failed.errorCode).toBe("LOCATION_NOT_CONFIGURED");

    const pendingOperation = await createOperation();
    const canceled = await cancelPaymentOperation({
      organizationId: orgAId,
      operationId: pendingOperation.id,
      now: new Date(Date.now() + 2_000),
    });
    expect(canceled.status).toBe("canceled");
    expect(canceled.errorClassification).toBeNull();
    expect(canceled.errorCode).toBeNull();
  });

  it("does not allow one tenant to read or mutate another tenant's operation", async () => {
    const operationB = await createOperation(orgBId, scheduleBId);
    expect(await getPaymentOperationForOrganization(orgAId, operationB.id)).toBeUndefined();
    expect(await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operationB.id,
      leaseOwner: "tenant-a-worker",
      leaseDurationMs: 60_000,
      now: new Date(Date.now() + 2_000),
    })).toBeUndefined();

    const leasedB = await acquirePaymentOperationLease({
      organizationId: orgBId,
      operationId: operationB.id,
      leaseOwner: "tenant-b-worker",
      leaseDurationMs: 60_000,
      now: new Date(Date.now() + 2_000),
    });
    if (!leasedB?.leaseToken) throw new Error("tenant B lease was not acquired");
    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operationB.id,
      leaseToken: leasedB.leaseToken,
      providerObjectId: "square-payment-cross-tenant",
    })).rejects.toBeInstanceOf(PaymentOperationNotFoundError);
  });

  it("rolls back finalization when linked payment rows belong to another tenant", async () => {
    const operationA = await createOperation();
    const tenantBPayment = await getScheduleContext(scheduleBId);
    const now = new Date(Date.now() + 2_000);
    const leasedA = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operationA.id,
      leaseOwner: "tenant-row-guard-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leasedA?.leaseToken) throw new Error("tenant row guard lease was not acquired");

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operationA.id,
      leaseToken: leasedA.leaseToken,
      providerObjectId: "square-payment-cross-tenant-row",
      paymentRows: [{
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId: tenantBPayment.bowlerId,
          leagueId: tenantBPayment.leagueId,
          providerPaymentId: "square-payment-cross-tenant-row",
        }),
      }],
      now: new Date(now.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationValidationError);

    expect((await getPaymentOperationForOrganization(orgAId, operationA.id))?.status)
      .toBe("leased");
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operationA.id)))
      .toHaveLength(0);
  });

  it("rejects terminal finalization from pending without a lease", async () => {
    const operation = await createOperation();
    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: randomUUID(),
      providerObjectId: "square-payment-no-lease",
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);
  });
});
