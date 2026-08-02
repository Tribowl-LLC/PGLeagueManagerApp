import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  autopaySetupRequests,
  bowlerLeagues,
  bowlers,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  teams,
  type AutopaySetupSnapshot,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  AutopaySetupRequestImmutableMismatchError,
  AutopaySetupRequestInvalidTransitionError,
  AutopaySetupRequestValidationError,
  cancelAutopaySetupRequest,
  completeAutopaySetupRequest,
  createOrGetAutopaySetupRequest,
  getAutopaySetupRequestByOperationForOrganization,
  getAutopaySetupRequestForOrganization,
  type AutopaySetupSnapshotInput,
} from "../../server/storage/autopay-setup-requests";
import { getTestDb } from "../setup/test-db";
import { getPgErrorCode, getPgErrorConstraint } from "../../server/utils/db-errors";
import {
  acquirePaymentOperationLease,
  finalizePaymentOperationSuccess,
} from "../../server/storage/payment-operations";

const db = getTestDb();
const poolSuffix = process.env.VITEST_POOL_ID ?? "0";
const slugs = [
  `autopay-foundation-a-${poolSuffix}`,
  `autopay-foundation-b-${poolSuffix}`,
] as const;
const quoteFingerprint = `lvautopayquote:v1:${"a".repeat(64)}`;
const sourceId = "ccof:foundation-test";
let orgAId: number;
let orgBId: number;
let locationAId: number;

interface Fixture {
  leagueId: number;
  bowlerId: number;
}

async function createFixture(label: string): Promise<Fixture> {
  const [league] = await db.insert(leagues).values({
    name: `Auto-pay foundation ${label}`,
    seasonStart: "2032-01-04T00:00:00.000Z",
    seasonEnd: "2032-01-25T23:59:59.000Z",
    weekDay: "Sunday",
    competitionStartTime: "12:40",
    timezone: "America/New_York",
    weeklyFee: 100,
    totalBowlingWeeks: 4,
    paymentMode: "weekly",
    organizationId: orgAId,
    locationId: locationAId,
  }).returning({ id: leagues.id });
  if (!league) throw new Error("league fixture was not created");
  const [team] = await db.insert(teams).values({
    name: `Foundation Team ${label}`,
    number: 1,
    leagueId: league.id,
  }).returning({ id: teams.id });
  if (!team) throw new Error("team fixture was not created");
  const [bowler] = await db.insert(bowlers).values({
    name: `Foundation Bowler ${label}`,
    email: `${label}-${poolSuffix}@example.test`,
    organizationId: orgAId,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("bowler fixture was not created");
  await db.insert(bowlerLeagues).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    teamId: team.id,
    active: true,
  });
  return { leagueId: league.id, bowlerId: bowler.id };
}

function snapshot(
  fixture: Fixture,
  immediateAmountMinor: number,
): AutopaySetupSnapshotInput {
  const hasImmediateCharge = immediateAmountMinor > 0;
  const allocations = immediateAmountMinor === 200
    ? [{
      allocationIndex: 0,
      bowlerId: fixture.bowlerId,
      occurrenceAt: "2031-12-28T17:40:00.000Z",
      localDate: "2031-12-28",
      classification: "past_due" as const,
      amountMinor: 100,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      notes: null,
      paidByUserId: null,
    }, {
      allocationIndex: 1,
      bowlerId: fixture.bowlerId,
      occurrenceAt: "2032-01-04T17:40:00.000Z",
      localDate: "2032-01-04",
      classification: "due_today" as const,
      amountMinor: 100,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      notes: null,
      paidByUserId: null,
    }]
    : hasImmediateCharge ? [{
      allocationIndex: 0,
      bowlerId: fixture.bowlerId,
      occurrenceAt: "2032-01-04T17:40:00.000Z",
      localDate: "2032-01-04",
      classification: "due_today" as const,
      amountMinor: immediateAmountMinor,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      notes: null,
      paidByUserId: null,
    }] : [];
  return {
    locationId: locationAId,
    providerName: "square",
    currency: "USD",
    additionalBowlerIds: [],
    immediateAmountMinor,
    allocations,
    firstAutomaticAt: "2032-01-11T17:40:00.000Z",
    firstAutomaticLocalDate: "2032-01-11",
    firstAutomaticAmountMinor: 100,
    recurringAmountMinor: 100,
    timezone: "America/New_York",
    competitionStartTime: "12:40",
    requestKind: hasImmediateCharge ? "direct" : null,
    lineItems: [],
  };
}

function setupInput(
  fixture: Fixture,
  immediateAmountMinor: number,
  source = sourceId,
) {
  return {
    organizationId: orgAId,
    payerBowlerId: fixture.bowlerId,
    leagueId: fixture.leagueId,
    quoteFingerprint,
    sourceId: source,
    customerId: `customer-${fixture.bowlerId}`,
    buyerEmail: `bowler-${fixture.bowlerId}@example.test`,
    snapshot: snapshot(fixture, immediateAmountMinor),
    now: new Date("2032-01-04T17:40:00.000Z"),
  };
}

beforeAll(async () => {
  const leftovers = await db.select({
    id: organizations.id,
    slug: organizations.slug,
  }).from(organizations).where(inArray(organizations.slug, [...slugs]));
  for (const leftover of leftovers) {
    await deleteOrganization(leftover.id);
  }
  const [orgA, orgB] = await db.insert(organizations).values([
    { name: "Auto-pay Foundation A", slug: slugs[0] },
    { name: "Auto-pay Foundation B", slug: slugs[1] },
  ]).returning({ id: organizations.id });
  if (!orgA || !orgB) throw new Error("organization fixtures were not created");
  orgAId = orgA.id;
  orgBId = orgB.id;
  const [location] = await db.insert(locations).values({
    name: "Auto-pay Foundation Location",
    organizationId: orgAId,
  }).returning({ id: locations.id });
  if (!location) throw new Error("location fixture was not created");
  locationAId = location.id;
});

afterAll(async () => {
  if (orgAId) await deleteOrganization(orgAId);
  if (orgBId) await deleteOrganization(orgBId);
});

describe("dormant auto-pay setup request storage", () => {
  it("converges duplicate positive intents on one interactive operation", async () => {
    const fixture = await createFixture("positive-concurrency");
    const [left, right] = await Promise.all([
      createOrGetAutopaySetupRequest(setupInput(fixture, 100)),
      createOrGetAutopaySetupRequest(setupInput(fixture, 100)),
    ]);

    expect(left.request.id).toBe(right.request.id);
    expect(left.operation?.id).toBe(right.operation?.id);
    expect(left.operation).toMatchObject({
      organizationId: orgAId,
      operationType: "interactive_charge",
      amountMinor: 100,
      currency: "USD",
      providerName: "square",
      status: "pending",
      attemptCount: 0,
    });
    expect(left.operation?.targetKey).toBe(`autopay-setup:${left.request.id}`);
    expect(await db.select().from(autopaySetupRequests).where(eq(
      autopaySetupRequests.id,
      left.request.id,
    ))).toHaveLength(1);
    expect(await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, orgAId),
      eq(paymentOperations.targetKey, `autopay-setup:${left.request.id}`),
    ))).toHaveLength(1);

    const byOperation = await getAutopaySetupRequestByOperationForOrganization(
      orgAId,
      left.operation?.id ?? "00000000-0000-0000-0000-000000000000",
    );
    expect(byOperation?.id).toBe(left.request.id);
  });

  it("creates no payment operation for a zero-dollar setup", async () => {
    const fixture = await createFixture("zero-dollar");
    const created = await createOrGetAutopaySetupRequest(setupInput(fixture, 0));

    expect(created.operation).toBeNull();
    expect(created.request.paymentOperationId).toBeNull();
    expect(created.request.workflowStatus).toBe("pending");
    expect(await db.select().from(paymentOperations).where(eq(
      paymentOperations.targetKey,
      `autopay-setup:${created.request.id}`,
    ))).toHaveLength(0);
  });

  it("rolls back a different active intent and its operation", async () => {
    const fixture = await createFixture("immutable-conflict");
    const original = await createOrGetAutopaySetupRequest(setupInput(fixture, 100));
    const operationCountBefore = await db.select({ id: paymentOperations.id })
      .from(paymentOperations)
      .where(eq(paymentOperations.organizationId, orgAId));

    await expect(createOrGetAutopaySetupRequest(
      setupInput(fixture, 100, "ccof:different-foundation-card"),
    )).rejects.toBeInstanceOf(AutopaySetupRequestImmutableMismatchError);

    const operationCountAfter = await db.select({ id: paymentOperations.id })
      .from(paymentOperations)
      .where(eq(paymentOperations.organizationId, orgAId));
    expect(operationCountAfter).toHaveLength(operationCountBefore.length);
    const setupOperations = await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, orgAId),
      eq(paymentOperations.targetKey, `autopay-setup:${original.request.id}`),
    ));
    expect(setupOperations).toHaveLength(1);
  });

  it("fails closed for cross-tenant creation and lookup", async () => {
    const fixture = await createFixture("tenant-scope");
    const created = await createOrGetAutopaySetupRequest(setupInput(fixture, 0));

    await expect(createOrGetAutopaySetupRequest({
      ...setupInput(fixture, 0),
      organizationId: orgBId,
    })).rejects.toBeInstanceOf(AutopaySetupRequestValidationError);
    expect(await getAutopaySetupRequestForOrganization(
      orgBId,
      created.request.id,
    )).toBeUndefined();
  });

  it("does not let workflow cancellation bypass a live charge operation", async () => {
    const fixture = await createFixture("pending-cancel");
    const created = await createOrGetAutopaySetupRequest(setupInput(fixture, 200));

    await expect(cancelAutopaySetupRequest({
      organizationId: orgAId,
      requestId: created.request.id,
    })).rejects.toBeInstanceOf(AutopaySetupRequestInvalidTransitionError);
  });

  it("completes a zero-dollar workflow only with its exact future schedule", async () => {
    const fixture = await createFixture("zero-complete");
    const created = await createOrGetAutopaySetupRequest(setupInput(fixture, 0));
    const [schedule] = await db.insert(paymentSchedules).values({
      bowlerId: fixture.bowlerId,
      leagueId: fixture.leagueId,
      frequency: "weekly",
      amount: 100,
      nextPaymentDate: "2032-01-11T17:40:00.000Z",
      paymentCardId: sourceId,
    }).returning({ id: paymentSchedules.id });
    if (!schedule) throw new Error("payment schedule fixture was not created");

    const completed = await completeAutopaySetupRequest({
      organizationId: orgAId,
      requestId: created.request.id,
      paymentScheduleId: schedule.id,
      now: new Date("2032-01-04T17:41:00.000Z"),
    });
    expect(completed).toMatchObject({
      workflowStatus: "completed",
      paymentScheduleId: schedule.id,
    });
  });

  it("leaves provider success on the operation and completes the setup separately", async () => {
    const fixture = await createFixture("positive-complete");
    const created = await createOrGetAutopaySetupRequest(setupInput(fixture, 200));
    if (!created.operation) throw new Error("positive setup omitted its payment operation");
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: created.operation.id,
      leaseOwner: "autopay-foundation-test",
      leaseDurationMs: 60_000,
      now: new Date("2032-01-04T17:40:01.000Z"),
    });
    if (!leased?.leaseToken) throw new Error("interactive operation was not leased");
    const succeeded = await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: created.operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-foundation-test",
      paymentRows: [{
        allocationIndex: 0,
        values: {
          bowlerId: fixture.bowlerId,
          leagueId: fixture.leagueId,
          amount: 100,
          lineageAmount: null,
          prizeFundAmount: null,
          weekOf: "2031-12-28T17:40:00.000Z",
          status: "paid",
          type: "square",
          providerPaymentId: "square-payment-foundation-test",
          receiptEmailMissing: false,
          notes: null,
          paidByUserId: null,
        },
      }, {
        allocationIndex: 1,
        values: {
          bowlerId: fixture.bowlerId,
          leagueId: fixture.leagueId,
          amount: 100,
          lineageAmount: null,
          prizeFundAmount: null,
          weekOf: "2032-01-04T17:40:00.000Z",
          status: "paid",
          type: "square",
          providerPaymentId: "square-payment-foundation-test",
          receiptEmailMissing: false,
          notes: null,
          paidByUserId: null,
        },
      }],
      now: new Date("2032-01-04T17:40:02.000Z"),
    });
    expect(succeeded.status).toBe("succeeded");

    const beforeSchedule = await getAutopaySetupRequestForOrganization(
      orgAId,
      created.request.id,
    );
    expect(beforeSchedule?.request.workflowStatus).toBe("pending");
    expect(beforeSchedule?.operation?.providerObjectId).toBe("square-payment-foundation-test");

    const [schedule] = await db.insert(paymentSchedules).values({
      bowlerId: fixture.bowlerId,
      leagueId: fixture.leagueId,
      frequency: "weekly",
      amount: 100,
      nextPaymentDate: "2032-01-11T17:40:00.000Z",
      paymentCardId: sourceId,
    }).returning({ id: paymentSchedules.id });
    if (!schedule) throw new Error("payment schedule fixture was not created");
    const completed = await completeAutopaySetupRequest({
      organizationId: orgAId,
      requestId: created.request.id,
      paymentScheduleId: schedule.id,
      now: new Date("2032-01-04T17:40:03.000Z"),
    });
    expect(completed.workflowStatus).toBe("completed");
  });

  it("enforces one active schedule for concurrent legacy inserts", async () => {
    const fixture = await createFixture("active-schedule-unique");
    const schedule = {
      bowlerId: fixture.bowlerId,
      leagueId: fixture.leagueId,
      frequency: "weekly" as const,
      amount: 100,
      nextPaymentDate: "2032-01-11T17:40:00.000Z",
      paymentCardId: sourceId,
    };
    await db.insert(paymentSchedules).values(schedule);
    let caught: unknown;
    try {
      await db.insert(paymentSchedules).values(schedule);
    } catch (error) {
      caught = error;
    }
    expect(getPgErrorCode(caught)).toBe("23505");
    expect(getPgErrorConstraint(caught)).toBe("payment_schedules_active_bowler_league_unique");
  });
});
