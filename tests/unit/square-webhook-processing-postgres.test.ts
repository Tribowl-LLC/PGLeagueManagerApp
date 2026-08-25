import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  bowlerOccurrenceObligations,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagues,
  locations,
  organizations,
  paymentDisputeNotifications,
  paymentDisputeReplayAudits,
  paymentDisputes,
  paymentOperations,
  paymentOperationOccurrenceSnapshots,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOccurrenceAllocations,
  paymentOccurrenceAllocationRevisions,
  payments,
  teams,
  users,
  webhookEvents,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { deleteUser } from "../../server/storage/users";
import {
  claimWebhookEvent,
  ingestSquareWebhookEvent,
} from "../../server/storage/webhook-events";
import { processSquareWebhookEvent } from "../../server/storage/square-webhook-processing";
import {
  DisputeReplayError,
  listPaymentDisputeSummariesForPayments,
  listPaymentDisputeNotifications,
  listPaymentDisputes,
  listPendingPaymentDisputeEvents,
  replayPendingPaymentDisputeEvent,
} from "../../server/storage/payment-dispute-operations";
import {
  deletePayment,
  PaymentDisputeEvidenceExistsError,
} from "../../server/storage/payments";
import { normalizeSquareWebhookEvent } from "../../server/services/square-webhook-event";
import { prepareRefundPaymentOperation } from "../../server/services/refund-payment-operation-preparation";
import {
  acquirePaymentOperationLease,
  createOrGetGeneralInteractivePaymentOperation,
  persistInteractivePaymentOperationSnapshot,
} from "../../server/storage/payment-operations";
import { deriveSquareOperationIdempotencyKey } from "../../server/services/payment-operation-idempotency";
import { fingerprintPaymentOperationOccurrenceSnapshot, PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT } from "../../server/services/payment-operation-occurrence-snapshot";
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
let secondBowlerId: number;
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
  const [secondBowler] = await db.insert(bowlers).values({
    name: "Webhook Processing Combined Bowler",
    organizationId,
  }).returning({ id: bowlers.id });
  secondBowlerId = secondBowler.id;
  await db.insert(bowlerLeagues).values({
    bowlerId: secondBowlerId,
    leagueId,
    teamId: team.id,
  });
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

async function preparedInteractiveCharge(options: { combined?: boolean } = {}) {
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
    combinedChargeGroupId: options.combined ? operation.id : null,
    allocations: options.combined ? [
      {
        allocationIndex: 0,
        bowlerId: secondBowlerId,
        amountMinor: 1_000,
        lineageAmountMinor: 500,
        prizeFundAmountMinor: 500,
        weekOf: "2034-03-05T00:00:00.000Z",
        notes: "Synthetic combined webhook allocation A",
        paidByUserId: null,
      },
      {
        allocationIndex: 1,
        bowlerId,
        amountMinor: 1_000,
        lineageAmountMinor: 500,
        prizeFundAmountMinor: 500,
        weekOf: "2034-03-05T00:00:00.000Z",
        notes: "Synthetic combined webhook allocation B",
        paidByUserId: null,
      },
    ] : [{
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

async function addF2OccurrenceSupplement(operation: { id: string; amountMinor: number }) {
  return db.transaction(async (tx) => {
    const [occurrence] = await tx.insert(leagueOccurrences).values({
      organizationId,
      leagueId,
      locationId,
      generationKey: `webhook-f2-occurrence-${randomUUID()}`,
      kind: "regular",
      status: "scheduled",
      lifecycle: "draft",
      authoritativeLocalDate: "2034-04-01",
      authoritativeLocalStartTime: "19:00:00",
      timezone: "UTC",
      startAt: "2034-04-01T19:00:00.000Z",
      selectedUtcOffsetMinutes: 0,
      foldResolution: "unambiguous",
      resolverVersion: "webhook-f2-fixture/1",
      plannedOrdinal: 1,
      competitionNumber: 1,
    }).returning({ id: leagueOccurrences.id });
    if (!occurrence) throw new Error("F2 webhook occurrence was not created");
    const [term] = await tx.insert(leagueOccurrenceBillingTerms).values({
      organizationId,
      leagueId,
      occurrenceId: occurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: operation.amountMinor,
      currency: "USD",
      billingOrdinal: 1,
      version: 1,
      state: "draft",
    }).returning({ id: leagueOccurrenceBillingTerms.id, version: leagueOccurrenceBillingTerms.version });
    if (!term) throw new Error("F2 webhook billing term was not created");
    const [obligation] = await tx.insert(bowlerOccurrenceObligations).values({
      organizationId,
      leagueId,
      occurrenceId: occurrence.id,
      bowlerId,
      purpose: "league_weekly_fee",
      amountMinor: operation.amountMinor,
      currency: "USD",
      billingTermId: term.id,
      billingTermVersion: term.version,
      recordedByUserId: actorUserId,
    }).returning({ id: bowlerOccurrenceObligations.id });
    if (!obligation) throw new Error("F2 webhook obligation was not created");
    const semantic = {
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: 1 as const,
      operationId: operation.id,
      operationType: "interactive_charge" as const,
      organizationId,
      leagueId,
      amountMinor: operation.amountMinor,
      currency: "USD",
      allocations: [{
        allocationIndex: 0,
        organizationId,
        leagueId,
        occurrenceId: occurrence.id,
        bowlerId,
        obligationId: obligation.id,
        amountMinor: operation.amountMinor,
        currency: "USD",
      }],
    };
    await tx.update(paymentOperations).set({ authorizingUserId: actorUserId }).where(eq(paymentOperations.id, operation.id));
    await tx.insert(paymentOperationOccurrenceSnapshots).values({
      operationId: operation.id,
      organizationId,
      leagueId,
      snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(semantic),
      amountMinor: operation.amountMinor,
      currency: "USD",
      allocationCount: 1,
    });
    await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values({
      operationId: operation.id,
      allocationIndex: 0,
      organizationId,
      leagueId,
      snapshotVersion: 1,
      obligationId: obligation.id,
      occurrenceId: occurrence.id,
      bowlerId,
      amountMinor: operation.amountMinor,
      currency: "USD",
    });
    return obligation.id;
  });
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

function disputeBody(input: {
  eventId: string;
  disputeId: string;
  paymentId: string;
  eventType?: "dispute.created" | "dispute.state.updated";
  amount?: number;
  state?: "EVIDENCE_REQUIRED" | "PROCESSING" | "WON" | "LOST" | "ACCEPTED";
  reason?: "DUPLICATE" | "NO_KNOWLEDGE";
  version?: number;
  updatedAt?: string;
  dueAt?: string | null;
}) {
  const updatedAt = input.updatedAt ?? "2034-03-06T00:01:00.000Z";
  return JSON.stringify({
    merchant_id: merchantId,
    type: input.eventType ?? "dispute.created",
    event_id: input.eventId,
    created_at: updatedAt,
    data: {
      type: "dispute",
      id: input.disputeId,
      object: { dispute: {
        id: input.disputeId,
        location_id: providerLocationId,
        state: input.state ?? "EVIDENCE_REQUIRED",
        reason: input.reason ?? "DUPLICATE",
        amount_money: { amount: input.amount ?? 2_000, currency: "USD" },
        disputed_payment: { payment_id: input.paymentId },
        due_at: input.dueAt === undefined ? "2034-03-20T00:00:00.000Z" : input.dueAt,
        card_brand: "VISA",
        brand_dispute_id: `brand-${input.disputeId}`,
        created_at: "2034-03-06T00:00:00.000Z",
        reported_at: "2034-03-06T00:00:30.000Z",
        updated_at: updatedAt,
        version: input.version ?? 1,
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

async function completedInteractiveCharge(options: { combined?: boolean } = {}) {
  const operation = await preparedInteractiveCharge(options);
  const providerPaymentId = `payment-${randomUUID()}`;
  const delivery = await ingest(paymentBody({
    eventId: `event-${randomUUID()}`,
    paymentId: providerPaymentId,
    operationId: operation.id,
  }));
  const result = await processSquareWebhookEvent({
    organizationId,
    eventId: delivery.recorded.event.id,
    event: delivery.event,
    now: new Date("2034-03-05T00:01:01.000Z"),
  });
  if (!result.businessStateChanged) throw new Error("charge fixture was not finalized");
  const [payment] = await db.select().from(payments)
    .where(eq(payments.paymentOperationId, operation.id));
  if (!payment) throw new Error("charge fixture payment was not created");
  return { operation, providerPaymentId, payment };
}

describe("Square webhook payment/refund PostgreSQL reconciliation", () => {
  it.skip("finalizes an interactive F2 supplement exactly once through payment.updated", async () => {
    const operation = await preparedInteractiveCharge();
    const obligationId = await addF2OccurrenceSupplement(operation);
    const revisionsBefore = await db.select().from(paymentOccurrenceAllocationRevisions)
      .where(eq(paymentOccurrenceAllocationRevisions.organizationId, organizationId));
    const providerPaymentId = `payment-${randomUUID()}`;
    const delivery = await ingest(paymentBody({
      eventId: `event-${randomUUID()}`,
      paymentId: providerPaymentId,
      operationId: operation.id,
    }));
    const first = await processSquareWebhookEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      now: new Date("2034-03-05T00:01:01.000Z"),
    });
    const duplicate = await processSquareWebhookEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      now: new Date("2034-03-05T00:01:02.000Z"),
    });
    expect(first).toMatchObject({ acknowledged: true, businessStateChanged: true, status: "processed" });
    expect(duplicate).toMatchObject({ acknowledged: true, businessStateChanged: false, status: "processed" });
    expect(await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.obligationId, obligationId))).toHaveLength(1);
    expect(await db.select().from(paymentOccurrenceAllocationRevisions).where(eq(paymentOccurrenceAllocationRevisions.organizationId, organizationId))).toHaveLength(revisionsBefore.length + 1);
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(1);
  });

  it.skip("fails a tampered F2 webhook supplement atomically before payment-occurrence evidence", async () => {
    const operation = await preparedInteractiveCharge();
    const obligationId = await addF2OccurrenceSupplement(operation);
    const revisionsBefore = await db.select().from(paymentOccurrenceAllocationRevisions)
      .where(eq(paymentOccurrenceAllocationRevisions.organizationId, organizationId));
    await db.update(paymentOperationOccurrenceSnapshots).set({
      snapshotFingerprint: `lvpayocc:v1:${"d".repeat(64)}`,
    }).where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id));
    const delivery = await ingest(paymentBody({
      eventId: `event-${randomUUID()}`,
      paymentId: `payment-${randomUUID()}`,
      operationId: operation.id,
    }));
    const result = await processSquareWebhookEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      now: new Date("2034-03-05T00:01:01.000Z"),
    });
    expect(result).toMatchObject({ acknowledged: true, businessStateChanged: false, status: "failed", code: "OPERATION_EVIDENCE_MISMATCH" });
    expect(await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.obligationId, obligationId))).toHaveLength(0);
    expect(await db.select().from(paymentOccurrenceAllocationRevisions).where(eq(paymentOccurrenceAllocationRevisions.organizationId, organizationId))).toHaveLength(revisionsBefore.length);
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
    const [storedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    expect(storedOperation?.status).toBe("leased");
  });

  it.skip("rolls back a non-fingerprint base-bowler mismatch in webhook finalization", async () => {
    const operation = await preparedInteractiveCharge();
    const obligationId = await addF2OccurrenceSupplement(operation);
    const revisionsBefore = await db.select().from(paymentOccurrenceAllocationRevisions)
      .where(eq(paymentOccurrenceAllocationRevisions.organizationId, organizationId));
    // Keep the occurrence supplement internally valid while making it
    // disagree with the immutable base allocation. This reaches the
    // post-payment bowler-total invariant instead of failing the earlier
    // interactive execution-snapshot fingerprint check.
    await db.transaction(async (tx) => {
      const [allocation] = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations)
        .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id))
        .limit(1);
      const [supplement] = await tx.select().from(paymentOperationOccurrenceSnapshots)
        .where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id))
        .limit(1);
      const [originalObligation] = await tx.select().from(bowlerOccurrenceObligations)
        .where(eq(bowlerOccurrenceObligations.id, obligationId))
        .limit(1);
      if (!allocation || !supplement || !originalObligation) throw new Error("F2 supplement fixture is incomplete");
      const [replacementObligation] = await tx.insert(bowlerOccurrenceObligations).values({
        organizationId: originalObligation.organizationId,
        leagueId: originalObligation.leagueId,
        occurrenceId: originalObligation.occurrenceId,
        bowlerId: secondBowlerId,
        purpose: originalObligation.purpose,
        amountMinor: originalObligation.amountMinor,
        currency: originalObligation.currency,
        dueAt: originalObligation.dueAt,
        pastDueAt: originalObligation.pastDueAt,
        billingTermId: originalObligation.billingTermId,
        billingTermVersion: originalObligation.billingTermVersion,
        recordedByUserId: originalObligation.recordedByUserId,
      }).returning({ id: bowlerOccurrenceObligations.id });
      if (!replacementObligation) throw new Error("replacement F2 obligation was not created");
      await tx.update(paymentOperationOccurrenceSnapshotAllocations).set({
        bowlerId: secondBowlerId,
        obligationId: replacementObligation.id,
      })
        .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id));
      const semantic = {
        contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
        snapshotVersion: 1 as const,
        operationId: operation.id,
        operationType: "interactive_charge" as const,
        organizationId,
        leagueId,
        amountMinor: operation.amountMinor,
        currency: "USD",
        allocations: [{
          allocationIndex: allocation.allocationIndex,
          organizationId: allocation.organizationId,
          leagueId: allocation.leagueId,
          occurrenceId: allocation.occurrenceId,
          bowlerId: secondBowlerId,
          obligationId: replacementObligation.id,
          amountMinor: allocation.amountMinor,
          currency: allocation.currency,
        }],
      };
      await tx.update(paymentOperationOccurrenceSnapshots).set({
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(semantic),
      }).where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id));
    });
    const delivery = await ingest(paymentBody({
      eventId: `event-${randomUUID()}`,
      paymentId: `payment-${randomUUID()}`,
      operationId: operation.id,
    }));
    const result = await processSquareWebhookEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      now: new Date("2034-03-05T00:01:01.000Z"),
    });
    expect(result).toMatchObject({ acknowledged: true, businessStateChanged: false, status: "failed", code: "OPERATION_EVIDENCE_MISMATCH" });
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
    expect(await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.obligationId, obligationId))).toHaveLength(0);
    expect(await db.select().from(paymentOccurrenceAllocationRevisions).where(eq(paymentOccurrenceAllocationRevisions.organizationId, organizationId))).toHaveLength(revisionsBefore.length);
    const [storedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    expect(storedOperation?.status).toBe("leased");
  });

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

  it("atomically records a partial dispute without changing payment or refund state", async () => {
    const charge = await completedInteractiveCharge();
    const disputeId = `dispute-${randomUUID()}`;
    const delivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      amount: 1_000,
    }));
    const denied = await processSquareWebhookEvent({
      organizationId: organizationId + 1_000_000,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      processDisputes: true,
    });
    expect(denied).toMatchObject({
      acknowledged: false,
      businessStateChanged: false,
      code: "EVENT_EVIDENCE_MISMATCH",
    });
    expect(await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId))).toHaveLength(0);

    const [left, right] = await Promise.all([
      processSquareWebhookEvent({
        organizationId,
        eventId: delivery.recorded.event.id,
        event: delivery.event,
        processDisputes: true,
        now: new Date("2034-03-06T00:01:01.000Z"),
      }),
      processSquareWebhookEvent({
        organizationId,
        eventId: delivery.recorded.event.id,
        event: delivery.event,
        processDisputes: true,
        now: new Date("2034-03-06T00:01:01.000Z"),
      }),
    ]);
    expect(left.acknowledged).toBe(true);
    expect(right.acknowledged).toBe(true);
    expect([left.businessStateChanged, right.businessStateChanged].sort()).toEqual([false, true]);
    expect([left.scheduledPaymentWakeRequired, right.scheduledPaymentWakeRequired])
      .not.toContain(true);

    const disputeRows = await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId));
    expect(disputeRows).toHaveLength(1);
    expect(disputeRows[0]).toMatchObject({
      organizationId,
      locationId,
      paymentOperationId: charge.operation.id,
      provider: "square",
      providerApplicationId: applicationId,
      providerMerchantId: merchantId,
      providerLocationId,
      providerDisputeId: disputeId,
      providerPaymentId: charge.providerPaymentId,
      amountMinor: 1_000,
      currency: "USD",
      reason: "DUPLICATE",
      state: "EVIDENCE_REQUIRED",
      providerVersion: 1,
      firstWebhookEventId: delivery.recorded.event.id,
      lastWebhookEventId: delivery.recorded.event.id,
    });
    const notices = await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.paymentDisputeId, disputeRows[0].id));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      organizationId,
      locationId,
      webhookEventId: delivery.recorded.event.id,
      kind: "DISPUTE_CREATED",
      disputeState: "EVIDENCE_REQUIRED",
      providerVersion: 1,
    });
    const [payment] = await db.select().from(payments).where(eq(payments.id, charge.payment.id));
    expect(payment).toMatchObject({ status: "paid", squareRefundId: null, refundedAt: null });
  });

  it("converges distinct concurrent provider events for the same dispute version", async () => {
    const charge = await completedInteractiveCharge();
    const disputeId = `dispute-${randomUUID()}`;
    const leftDelivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      version: 4,
    }));
    const rightDelivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      version: 4,
    }));

    const results = await Promise.all([
      processSquareWebhookEvent({
        organizationId,
        eventId: leftDelivery.recorded.event.id,
        event: leftDelivery.event,
        processDisputes: true,
      }),
      processSquareWebhookEvent({
        organizationId,
        eventId: rightDelivery.recorded.event.id,
        event: rightDelivery.event,
        processDisputes: true,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["ignored", "processed"]);
    expect(results.map((result) => result.businessStateChanged).sort()).toEqual([false, true]);
    expect(results.find((result) => result.status === "ignored")?.code)
      .toBe("DUPLICATE_DISPUTE_VERSION");
    expect(await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId))).toHaveLength(1);
  });

  it("does not regress dispute state when an older event is processed out of order", async () => {
    const charge = await completedInteractiveCharge();
    const disputeId = `dispute-${randomUUID()}`;
    const older = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      state: "EVIDENCE_REQUIRED",
      version: 2,
      updatedAt: "2034-03-06T00:02:00.000Z",
    }));
    const newer = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      eventType: "dispute.state.updated",
      state: "WON",
      version: 3,
      updatedAt: "2034-03-07T00:02:00.000Z",
      dueAt: null,
    }));

    const current = await processSquareWebhookEvent({
      organizationId,
      eventId: newer.recorded.event.id,
      event: newer.event,
      processDisputes: true,
    });
    const stale = await processSquareWebhookEvent({
      organizationId,
      eventId: older.recorded.event.id,
      event: older.event,
      processDisputes: true,
    });
    expect(current).toMatchObject({ status: "processed", businessStateChanged: true });
    expect(stale).toMatchObject({ status: "ignored", code: "STALE_PROVIDER_EVENT" });
    const [stored] = await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId));
    expect(stored).toMatchObject({
      state: "WON",
      providerVersion: 3,
      responseDueAt: null,
      lastWebhookEventId: newer.recorded.event.id,
    });
    const notices = await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.paymentDisputeId, stored.id));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      webhookEventId: newer.recorded.event.id,
      kind: "DISPUTE_STATE_UPDATED",
      disputeState: "WON",
      providerVersion: 3,
    });
  });

  it("emits exactly one durable notification for each accepted dispute version", async () => {
    const charge = await completedInteractiveCharge();
    const disputeId = `dispute-${randomUUID()}`;
    const created = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      version: 1,
      state: "EVIDENCE_REQUIRED",
      updatedAt: "2034-03-06T00:01:00.000Z",
    }));
    await processSquareWebhookEvent({
      organizationId,
      eventId: created.recorded.event.id,
      event: created.event,
      processDisputes: true,
    });
    const updated = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      eventType: "dispute.state.updated",
      version: 2,
      state: "PROCESSING",
      updatedAt: "2034-03-06T00:02:00.000Z",
    }));
    await processSquareWebhookEvent({
      organizationId,
      eventId: updated.recorded.event.id,
      event: updated.event,
      processDisputes: true,
    });

    const [dispute] = await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId));
    const notices = await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.paymentDisputeId, dispute.id));
    expect(notices.map((row) => ({
      kind: row.kind,
      state: row.disputeState,
      version: row.providerVersion,
    })).sort((left, right) => left.version - right.version)).toEqual([
      { kind: "DISPUTE_CREATED", state: "EVIDENCE_REQUIRED", version: 1 },
      { kind: "DISPUTE_STATE_UPDATED", state: "PROCESSING", version: 2 },
    ]);
  });

  it("keeps a pre-existing refund state independent from a later dispute", async () => {
    const charge = await completedInteractiveCharge();
    const refundedAt = "2034-03-06T12:00:00.000Z";
    await db.update(payments).set({
      status: "refunded",
      squareRefundId: `refund-${randomUUID()}`,
      refundedAt,
    }).where(eq(payments.id, charge.payment.id));
    const disputeId = `dispute-${randomUUID()}`;
    const delivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      amount: 500,
      reason: "NO_KNOWLEDGE",
    }));
    const result = await processSquareWebhookEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      processDisputes: true,
    });
    expect(result).toMatchObject({ status: "processed", businessStateChanged: true });
    const [payment] = await db.select().from(payments).where(eq(payments.id, charge.payment.id));
    expect(payment.status).toBe("refunded");
    expect(new Date(payment.refundedAt ?? "").getTime()).toBe(new Date(refundedAt).getTime());
    expect(payment.squareRefundId).not.toBeNull();
    const [dispute] = await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId));
    expect(dispute).toMatchObject({ state: "EVIDENCE_REQUIRED", reason: "NO_KNOWLEDGE" });
  });

  it("batch-projects sanitized dispute history onto every linked allocation with tenant isolation", async () => {
    const charge = await completedInteractiveCharge({ combined: true });
    const disputeId = `dispute-${randomUUID()}`;
    const created = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      version: 1,
      state: "EVIDENCE_REQUIRED",
      updatedAt: "2034-03-07T00:01:00.000Z",
    }));
    await processSquareWebhookEvent({
      organizationId,
      eventId: created.recorded.event.id,
      event: created.event,
      processDisputes: true,
    });
    const updated = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
      eventType: "dispute.state.updated",
      version: 2,
      state: "PROCESSING",
      updatedAt: "2034-03-07T00:02:00.000Z",
    }));
    await processSquareWebhookEvent({
      organizationId,
      eventId: updated.recorded.event.id,
      event: updated.event,
      processDisputes: true,
    });
    const allocations = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, charge.operation.id));
    expect(allocations).toHaveLength(2);

    const [relocated] = await db.insert(locations).values({
      organizationId,
      name: `Relocated Webhook Processing Location ${randomUUID()}`,
      squareCredentials: {
        appId: `${applicationId}-relocated`,
        locationId: `${providerLocationId}-relocated`,
      },
    }).returning({ id: locations.id });
    await db.update(leagues).set({ locationId: relocated.id }).where(eq(leagues.id, leagueId));

    try {
      const input = { paymentRows: allocations, organizationId };
      const [left, right] = await Promise.all([
        listPaymentDisputeSummariesForPayments(input),
        listPaymentDisputeSummariesForPayments(input),
      ]);
      for (const allocation of allocations) {
        expect(left.get(allocation.id)).toEqual(right.get(allocation.id));
        expect(left.get(allocation.id)?.[0]).toMatchObject({
          providerDisputeId: disputeId,
          state: "PROCESSING",
          providerVersion: 2,
          sharedTransaction: true,
        });
        expect(left.get(allocation.id)?.[0]?.history.map((row) => ({
          state: row.state,
          version: row.providerVersion,
        }))).toEqual([
          { state: "PROCESSING", version: 2 },
          { state: "EVIDENCE_REQUIRED", version: 1 },
        ]);
        expect(left.get(allocation.id)?.[0]).not.toHaveProperty("providerPaymentId");
        expect(left.get(allocation.id)?.[0]).not.toHaveProperty("encryptedPayload");
        expect(left.get(allocation.id)?.[0]).not.toHaveProperty("payloadHash");
      }

      const crossTenant = await listPaymentDisputeSummariesForPayments({
        paymentRows: allocations,
        organizationId: organizationId + 1_000_000,
      });
      expect(crossTenant.size).toBe(0);

      await expect(deletePayment(allocations[0].id))
        .rejects.toBeInstanceOf(PaymentDisputeEvidenceExistsError);
      expect(await db.select({ id: payments.id }).from(payments)
        .where(eq(payments.id, allocations[0].id))).toHaveLength(1);
    } finally {
      await db.update(leagues).set({ locationId }).where(eq(leagues.id, leagueId));
      await db.delete(locations).where(eq(locations.id, relocated.id));
    }
  });

  it("replays one retained pending dispute event with atomic notification and operator audit", async () => {
    const charge = await completedInteractiveCharge();
    const disputeId = `dispute-${randomUUID()}`;
    const delivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
    }));

    const pending = await listPendingPaymentDisputeEvents({ organizationId, limit: 100 });
    const pendingItem = pending.items.find((row) => row.id === delivery.recorded.event.id);
    expect(pendingItem).toBeDefined();
    expect(pendingItem).not.toHaveProperty("encryptedPayload");
    expect(pendingItem).not.toHaveProperty("payloadHash");
    expect(pendingItem).not.toHaveProperty("providerMerchantId");

    await expect(replayPendingPaymentDisputeEvent({
      organizationId: organizationId + 1_000_000,
      eventId: delivery.recorded.event.id,
      actor: { userId: actorUserId, role: "org_admin" },
    })).rejects.toMatchObject({ code: "WEBHOOK_EVENT_NOT_FOUND" });
    expect(await db.select().from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.webhookEventId, delivery.recorded.event.id))).toHaveLength(0);

    const [left, right] = await Promise.all([
      replayPendingPaymentDisputeEvent({
        organizationId,
        eventId: delivery.recorded.event.id,
        actor: { userId: actorUserId, role: "org_admin" },
      }),
      replayPendingPaymentDisputeEvent({
        organizationId,
        eventId: delivery.recorded.event.id,
        actor: { userId: actorUserId, role: "org_admin" },
      }),
    ]);
    expect([left.businessStateChanged, right.businessStateChanged].sort()).toEqual([false, true]);
    expect(left.acknowledged).toBe(true);
    expect(right.acknowledged).toBe(true);

    const [dispute] = await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId));
    expect(dispute).toBeDefined();
    expect(await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.paymentDisputeId, dispute.id))).toHaveLength(1);
    const audits = await db.select().from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.webhookEventId, delivery.recorded.event.id));
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.businessStateChanged).sort()).toEqual([false, true]);
    expect(audits.every((row) => row.actorUserId === actorUserId && row.organizationId === organizationId)).toBe(true);
    await expect(deleteUser(actorUserId)).rejects.toMatchObject({
      name: "UserHasAuditTrailError",
    });

    const visibleDisputes = await listPaymentDisputes({ organizationId, limit: 100 });
    expect(visibleDisputes.items.some((row) => row.id === dispute.id)).toBe(true);
    const visibleNotices = await listPaymentDisputeNotifications({ organizationId, limit: 100 });
    expect(visibleNotices.items.some((row) => row.paymentDisputeId === dispute.id)).toBe(true);
    expect((await listPaymentDisputes({ organizationId: organizationId + 1_000_000, limit: 100 })).items)
      .toHaveLength(0);
    expect((await listPaymentDisputeNotifications({
      organizationId: organizationId + 1_000_000,
      limit: 100,
    })).items).toHaveLength(0);
  });

  it("rolls back dispute, notification, inbox completion, and audit together", async () => {
    const charge = await completedInteractiveCharge();
    const disputeId = `dispute-${randomUUID()}`;
    const delivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId,
      paymentId: charge.providerPaymentId,
    }));

    await expect(replayPendingPaymentDisputeEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      actor: { userId: actorUserId + 1_000_000, role: "org_admin" },
    })).rejects.toBeDefined();

    expect(await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.providerDisputeId, disputeId))).toHaveLength(0);
    expect(await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.webhookEventId, delivery.recorded.event.id))).toHaveLength(0);
    expect(await db.select().from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.webhookEventId, delivery.recorded.event.id))).toHaveLength(0);
    const [inbox] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, delivery.recorded.event.id));
    expect(inbox).toMatchObject({ status: "pending", attemptCount: 0, completedAt: null });
  });

  it("fails closed when retained encrypted evidence does not match its immutable hash", async () => {
    const charge = await completedInteractiveCharge();
    const delivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId: `dispute-${randomUUID()}`,
      paymentId: charge.providerPaymentId,
    }));
    await db.update(webhookEvents).set({ payloadHash: "0".repeat(64) })
      .where(eq(webhookEvents.id, delivery.recorded.event.id));

    await expect(replayPendingPaymentDisputeEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      actor: { userId: actorUserId, role: "org_admin" },
    })).rejects.toBeInstanceOf(DisputeReplayError);
    const [stored] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, delivery.recorded.event.id));
    expect(stored).toMatchObject({ status: "pending", attemptCount: 0, completedAt: null });
    expect(await db.select().from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.webhookEventId, delivery.recorded.event.id))).toHaveLength(0);
  });

  it("terminally ignores a valid dispute unrelated to a LeagueVault charge", async () => {
    const delivery = await ingest(disputeBody({
      eventId: `event-${randomUUID()}`,
      disputeId: `dispute-${randomUUID()}`,
      paymentId: `unowned-payment-${randomUUID()}`,
    }));
    const result = await processSquareWebhookEvent({
      organizationId,
      eventId: delivery.recorded.event.id,
      event: delivery.event,
      processDisputes: true,
    });
    expect(result).toMatchObject({
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "ignored",
      code: "DISPUTE_NOT_OWNED",
    });
    const [stored] = await db.select().from(webhookEvents)
      .where(eq(webhookEvents.id, delivery.recorded.event.id));
    expect(stored).toMatchObject({
      status: "ignored",
      errorClassification: "mapping",
      errorCode: "DISPUTE_NOT_OWNED",
    });
  });

  it("removes disputes with their retained operation and webhook evidence during full tenant teardown", async () => {
    const existing = await db.select({ id: paymentDisputes.id }).from(paymentDisputes)
      .where(eq(paymentDisputes.organizationId, organizationId));
    expect(existing.length).toBeGreaterThan(0);

    const deletedOrganizationId = organizationId;
    expect((await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.organizationId, deletedOrganizationId))).length)
      .toBeGreaterThan(0);
    expect((await db.select().from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.organizationId, deletedOrganizationId))).length)
      .toBeGreaterThan(0);
    await deleteOrganization(deletedOrganizationId);
    organizationId = 0;

    expect(await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.organizationId, deletedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(webhookEvents)
      .where(eq(webhookEvents.organizationId, deletedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(paymentDisputeNotifications)
      .where(eq(paymentDisputeNotifications.organizationId, deletedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.organizationId, deletedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(organizations)
      .where(eq(organizations.id, deletedOrganizationId))).toHaveLength(0);
  });
});
