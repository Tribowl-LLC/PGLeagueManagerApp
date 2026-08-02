import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import {
  bowlers,
  leagues,
  organizations,
  paymentOperations,
  paymentSchedules,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  PaymentOperationImmutableMismatchError,
  PaymentOperationInvalidTransitionError,
  PaymentOperationNotFoundError,
  acquirePaymentOperationLease,
  cancelPaymentOperation,
  createOrGetScheduledPaymentOperation,
  finalizePaymentOperationSuccess,
  getPaymentOperationForOrganization,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  schedulePaymentOperationRetry,
} from "../../server/storage/payment-operations";

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
