import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagues,
  locations,
  organizations,
  paymentOperations,
  payments,
  teams,
  users,
  webhookEvents,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  claimWebhookEvent,
  ingestSquareWebhookEvent,
} from "../../server/storage/webhook-events";
import { processSquareWebhookEvent } from "../../server/storage/square-webhook-processing";
import { normalizeSquareWebhookEvent } from "../../server/services/square-webhook-event";
import { prepareRefundPaymentOperation } from "../../server/services/refund-payment-operation-preparation";
import {
  acquirePaymentOperationLease,
  createOrGetGeneralInteractivePaymentOperation,
  persistInteractivePaymentOperationSnapshot,
} from "../../server/storage/payment-operations";
import { deriveSquareOperationIdempotencyKey } from "../../server/services/payment-operation-idempotency";
import type { InteractivePaymentSemanticSnapshot } from "../../server/services/interactive-payment-operation-snapshot";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `square-webhook-processing-${suffix}`;
const applicationId = "app-webhook-processing-fixture";
const merchantId = "merchant-webhook-processing-fixture";
const providerLocationId = "location-webhook-processing-fixture";
let organizationId: number;
let locationId: number;
let leagueId: number;
let bowlerId: number;
let actorUserId: number;

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations)
    .where(inArray(organizations.slug, [slug]));
  for (const row of leftovers) await deleteOrganization(row.id);
  const [organization] = await db.insert(organizations).values({
    name: "Square Webhook Processing Fixture",
    slug,
  }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({
    organizationId,
    name: "Webhook Processing Location",
    squareCredentials: { appId: applicationId, locationId: providerLocationId },
  }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Webhook Processing League",
    seasonStart: "2034-01-01T00:00:00.000Z",
    seasonEnd: "2034-12-31T23:59:59.000Z",
    weekDay: "Monday",
    weeklyFee: 2_000,
    organizationId,
    locationId,
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [bowler] = await db.insert(bowlers).values({
    name: "Webhook Processing Bowler",
    organizationId,
  }).returning({ id: bowlers.id });
  bowlerId = bowler.id;
  const [team] = await db.insert(teams).values({
    name: "Webhook Processing Team",
    number: 1,
    leagueId,
  }).returning({ id: teams.id });
  await db.insert(bowlerLeagues).values({ bowlerId, leagueId, teamId: team.id });
  const [actor] = await db.insert(users).values({
    email: `webhook-processing-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Webhook Processing Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

async function preparedRefund(amount = 2_000) {
  const providerPaymentId = `payment-${randomUUID()}`;
  const [payment] = await db.insert(payments).values({
    bowlerId,
    leagueId,
    amount,
    weekOf: "2034-03-01T00:00:00.000Z",
    status: "paid",
    type: "square",
    providerPaymentId,
  }).returning();
  const prepared = await prepareRefundPaymentOperation({
    paymentId: payment.id,
    reason: "Synthetic webhook fixture",
    requestedByUserId: actorUserId,
    requestedByRole: "org_admin",
    requestedByOrganizationId: organizationId,
    now: new Date("2034-03-02T00:00:00.000Z"),
  });
  const leased = await acquirePaymentOperationLease({
    organizationId,
    operationId: prepared.operation.id,
    leaseOwner: `webhook-processing-${randomUUID()}`,
    leaseDurationMs: 15 * 60_000,
    now: new Date("2034-03-02T00:00:01.000Z"),
  });
  if (!leased) throw new Error("refund operation was not leased");
  return { payment, operation: leased, providerPaymentId };
}

async function preparedInteractiveCharge() {
  const operation = await createOrGetGeneralInteractivePaymentOperation({
    organizationId,
    requestKey: `webhook-${randomUUID()}`,
    amountMinor: 2_000,
    currency: "USD",
    providerName: "square",
    now: new Date("2034-03-05T00:00:00.000Z"),
  });
  const snapshot: InteractivePaymentSemanticSnapshot = {
    snapshotVersion: 2,
    organizationId,
    amountMinor: 2_000,
    currency: "USD",
    providerName: "square",
    leagueId,
    locationId,
    providerLocationId,
    payerBowlerId: bowlerId,
    requestKind: "direct",
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      operation.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: null,
    sourceId: `cnon:webhook-${randomUUID()}`,
    customerId: "CUSTOMER_WEBHOOK_FIXTURE",
    buyerEmail: "webhook@example.test",
    storeCard: false,
    sourceKind: "new_card",
    weekOf: "2034-03-05T00:00:00.000Z",
    combinedChargeGroupId: null,
    allocations: [{
      allocationIndex: 0,
      bowlerId,
      amountMinor: 2_000,
      lineageAmountMinor: 1_000,
      prizeFundAmountMinor: 1_000,
      weekOf: "2034-03-05T00:00:00.000Z",
      notes: "Synthetic webhook charge fixture",
      paidByUserId: null,
    }],
    lineItems: [],
  };
  await db.transaction((tx) => persistInteractivePaymentOperationSnapshot(operation, snapshot, tx));
  const leased = await acquirePaymentOperationLease({
    organizationId,
    operationId: operation.id,
    leaseOwner: `webhook-charge-${randomUUID()}`,
    leaseDurationMs: 15 * 60_000,
    now: new Date("2034-03-05T00:00:01.000Z"),
  });
  if (!leased) throw new Error("charge operation was not leased");
  return leased;
}

function refundBody(input: {
  eventId: string;
  refundId: string;
  paymentId: string;
  amount: number;
  status: "PENDING" | "COMPLETED" | "FAILED" | "REJECTED";
  version: number;
  updatedAt: string;
}) {
  return JSON.stringify({
    merchant_id: merchantId,
    type: "refund.updated",
    event_id: input.eventId,
    created_at: input.updatedAt,
    data: {
      type: "refund",
      id: input.refundId,
      object: { refund: {
        id: input.refundId,
        payment_id: input.paymentId,
        location_id: providerLocationId,
        status: input.status,
        amount_money: { amount: input.amount, currency: "USD" },
        updated_at: input.updatedAt,
        version: input.version,
      } },
    },
  });
}

function paymentBody(input: { eventId: string; paymentId: string; operationId?: string }) {
  return JSON.stringify({
    merchant_id: merchantId,
    type: "payment.updated",
    event_id: input.eventId,
    created_at: "2034-03-05T00:01:00.000Z",
    data: {
      type: "payment",
      id: input.paymentId,
      object: { payment: {
        id: input.paymentId,
        location_id: providerLocationId,
        status: "COMPLETED",
        amount_money: { amount: 2_000, currency: "USD" },
        updated_at: "2034-03-05T00:01:00.000Z",
        ...(input.operationId ? { reference_id: input.operationId } : {}),
        receipt_url: "https://squareup.com/receipt/preview/synthetic-fixture",
        receipt_number: "FIX1",
      } },
    },
  });
}

function disputeBody(input: { eventId: string; disputeId: string; paymentId: string }) {
  return JSON.stringify({
    merchant_id: merchantId,
    type: "dispute.created",
    event_id: input.eventId,
    created_at: "2034-03-06T00:01:00.000Z",
    data: {
      type: "dispute",
      id: input.disputeId,
      object: { dispute: {
        id: input.disputeId,
        location_id: providerLocationId,
        state: "EVIDENCE_REQUIRED",
        amount_money: { amount: 2_000, currency: "USD" },
        disputed_payment: { payment_id: input.paymentId },
        updated_at: "2034-03-06T00:01:00.000Z",
        version: 1,
      } },
    },
  });
}

async function ingest(body: string) {
  const event = normalizeSquareWebhookEvent(body);
  const recorded = await ingestSquareWebhookEvent({
    ...event,
    providerApplicationId: applicationId,
    providerApiVersion: "2026-05-20",
    payloadHash: createHash("sha256").update(body).digest("hex"),
    rawPayload: body,
    now: new Date("2034-03-02T00:00:02.000Z"),
  });
  return { event, recorded };
}

describe("Square webhook payment/refund PostgreSQL reconciliation", () => {
  it("finalizes one known charge from signed reference evidence without duplicate payment rows", async () => {
    const operation = await preparedInteractiveCharge();
    const providerPaymentId = `payment-${randomUUID()}`;
    const { event, recorded } = await ingest(paymentBody({
      eventId: `event-${randomUUID()}`,
      paymentId: providerPaymentId,
      operationId: operation.id,
    }));
    const [first, duplicate] = await Promise.all([
      processSquareWebhookEvent({
        organizationId,
        eventId: recorded.event.id,
        event,
        now: new Date("2034-03-05T00:01:01.000Z"),
      }),
      processSquareWebhookEvent({
        organizationId,
        eventId: recorded.event.id,
        event,
        now: new Date("2034-03-05T00:01:01.000Z"),
      }),
    ]);
    expect(first.acknowledged).toBe(true);
    expect(duplicate.acknowledged).toBe(true);
    const rows = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerPaymentId,
      receiptNumber: "FIX1",
      status: "paid",
    });
  });

  it("atomically converges concurrent COMPLETED refund delivery with an active recovery lease", async () => {
    const fixture = await preparedRefund();
    const { event, recorded } = await ingest(refundBody({
      eventId: `event-${randomUUID()}`,
      refundId: `refund-${randomUUID()}`,
      paymentId: fixture.providerPaymentId,
      amount: fixture.payment.amount,
      status: "COMPLETED",
      version: 4,
      updatedAt: "2034-03-02T00:01:00.000Z",
    }));

    // This is the durable-ingestion crash window: no process-local task is
    // required to preserve the event, and no business state changed yet.
    const [beforeReplayEvent] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, recorded.event.id));
    const [beforeReplayPayment] = await db.select().from(payments)
      .where(eq(payments.id, fixture.payment.id));
    expect(beforeReplayEvent.status).toBe("pending");
    expect(beforeReplayPayment.status).toBe("paid");

    const [left, right] = await Promise.all([
      processSquareWebhookEvent({
        organizationId,
        eventId: recorded.event.id,
        event,
        now: new Date("2034-03-02T00:01:01.000Z"),
      }),
      processSquareWebhookEvent({
        organizationId,
        eventId: recorded.event.id,
        event,
        now: new Date("2034-03-02T00:01:01.000Z"),
      }),
    ]);
    expect(left.acknowledged).toBe(true);
    expect(right.acknowledged).toBe(true);
    expect([left.businessStateChanged, right.businessStateChanged].sort()).toEqual([false, true]);

    const [operation] = await db.select().from(paymentOperations)
      .where(eq(paymentOperations.id, fixture.operation.id));
    const [payment] = await db.select().from(payments).where(eq(payments.id, fixture.payment.id));
    const [storedEvent] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, recorded.event.id));
    expect(operation).toMatchObject({
      status: "succeeded",
      providerObjectId: event.providerObjectId,
    });
    expect(payment).toMatchObject({
      status: "refunded",
      squareRefundId: event.providerObjectId,
    });
    expect(storedEvent).toMatchObject({ status: "processed", attemptCount: 1 });
  });

  it("ignores stale COMPLETED evidence when a newer provider version is already durable", async () => {
    const fixture = await preparedRefund(2_100);
    const refundId = `refund-${randomUUID()}`;
    const newer = await ingest(refundBody({
      eventId: `event-${randomUUID()}`,
      refundId,
      paymentId: fixture.providerPaymentId,
      amount: fixture.payment.amount,
      status: "FAILED",
      version: 8,
      updatedAt: "2034-03-03T00:02:00.000Z",
    }));
    const older = await ingest(refundBody({
      eventId: `event-${randomUUID()}`,
      refundId,
      paymentId: fixture.providerPaymentId,
      amount: fixture.payment.amount,
      status: "COMPLETED",
      version: 7,
      updatedAt: "2034-03-03T00:01:00.000Z",
    }));

    const stale = await processSquareWebhookEvent({
      organizationId,
      eventId: older.recorded.event.id,
      event: older.event,
    });
    const failed = await processSquareWebhookEvent({
      organizationId,
      eventId: newer.recorded.event.id,
      event: newer.event,
    });
    expect(stale).toMatchObject({ status: "ignored", code: "STALE_PROVIDER_EVENT" });
    expect(failed).toMatchObject({ status: "ignored", code: "REFUND_NOT_COMPLETED" });
    const [payment] = await db.select().from(payments).where(eq(payments.id, fixture.payment.id));
    const [operation] = await db.select().from(paymentOperations)
      .where(eq(paymentOperations.id, fixture.operation.id));
    expect(payment.status).toBe("paid");
    expect(operation.status).toBe("leased");
  });

  it("retains a valid Square payment unrelated to any LeagueVault operation without retrying it", async () => {
    const { event, recorded } = await ingest(paymentBody({
      eventId: `event-${randomUUID()}`,
      paymentId: `unowned-payment-${randomUUID()}`,
    }));
    const result = await processSquareWebhookEvent({
      organizationId,
      eventId: recorded.event.id,
      event,
      now: new Date("2034-03-04T00:01:01.000Z"),
    });
    expect(result).toMatchObject({
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "ignored",
      code: "OPERATION_NOT_OWNED",
    });
    const [stored] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, recorded.event.id));
    expect(stored).toMatchObject({
      status: "ignored",
      attemptCount: 1,
      nextAttemptAt: null,
      errorClassification: "mapping",
      errorCode: "OPERATION_NOT_OWNED",
    });

    const duplicate = await processSquareWebhookEvent({
      organizationId,
      eventId: recorded.event.id,
      event,
      now: new Date("2034-03-04T00:02:01.000Z"),
    });
    expect(duplicate).toMatchObject({
      acknowledged: true,
      terminal: true,
      status: "ignored",
      code: "OPERATION_NOT_OWNED",
    });
    const [afterDuplicate] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, recorded.event.id));
    expect(afterDuplicate.attemptCount).toBe(1);
  });

  it("acknowledges a dispute while keeping it nonterminal and claimable for Phase 4B", async () => {
    const { event, recorded } = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId: `dispute-${randomUUID()}`,
      paymentId: `payment-${randomUUID()}`,
    }));
    const first = await processSquareWebhookEvent({
      organizationId,
      eventId: recorded.event.id,
      event,
      now: new Date("2034-03-06T00:01:01.000Z"),
    });
    const duplicate = await processSquareWebhookEvent({
      organizationId,
      eventId: recorded.event.id,
      event,
      now: new Date("2034-03-06T00:01:02.000Z"),
    });
    expect(first).toMatchObject({
      acknowledged: true,
      terminal: false,
      businessStateChanged: false,
      status: "pending",
      code: "DISPUTE_PROCESSING_DEFERRED",
    });
    expect(duplicate).toMatchObject(first);

    const [stored] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, recorded.event.id));
    expect(stored).toMatchObject({
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      errorClassification: null,
      errorCode: null,
      processedAt: null,
      completedAt: null,
    });

    const claim = await claimWebhookEvent({
      organizationId,
      eventId: recorded.event.id,
      leaseOwner: "phase-4b-eligibility-fixture",
      leaseDurationMs: 60_000,
      now: new Date("2034-03-06T00:01:03.000Z"),
    });
    expect(claim).toMatchObject({ status: "processing", attemptCount: 1 });
  });
});
