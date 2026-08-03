import { and, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import {
  paymentOperations,
  payments,
  refundPaymentOperationSnapshots,
  webhookEvents,
  WEBHOOK_EVENT_MAX_ATTEMPTS,
  type WebhookEvent,
} from "@shared/schema";
import { db } from "../db.js";
import type { NormalizedSquareWebhookEvent } from "../services/square-webhook-event.js";
import {
  finalizeChargeFromWebhookEvidenceInTransaction,
  finalizeRefundFromWebhookEvidenceInTransaction,
  PaymentOperationImmutableMismatchError,
  PaymentOperationInvalidTransitionError,
  PaymentOperationNotFoundError,
  type PaymentOperationTransaction,
} from "./payment-operations.js";

const RETRY_DELAY_MS = 30_000;

export interface SquareWebhookProcessingResult {
  acknowledged: boolean;
  terminal: boolean;
  businessStateChanged: boolean;
  status: WebhookEvent["status"];
  code: string | null;
}

function eventEvidenceMatches(row: WebhookEvent, event: NormalizedSquareWebhookEvent): boolean {
  return row.provider === "square"
    && row.providerEventId === event.providerEventId
    && row.eventType === event.eventType
    && row.providerMerchantId === event.providerMerchantId
    && row.providerLocationId === event.providerLocationId
    && row.providerObjectType === event.providerObjectType
    && row.providerObjectId === event.providerObjectId
    && row.providerPaymentId === event.providerPaymentId
    && row.providerObjectVersion === event.providerObjectVersion
    && (
      row.providerObjectUpdatedAt === event.providerObjectUpdatedAt
      || (
        row.providerObjectUpdatedAt !== null
        && event.providerObjectUpdatedAt !== null
        && new Date(row.providerObjectUpdatedAt).getTime()
          === new Date(event.providerObjectUpdatedAt).getTime()
      )
    );
}

async function finish(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  input: { status: "processed" | "ignored" | "failed"; code?: string; now: string },
): Promise<void> {
  await tx.update(webhookEvents).set({
    status: input.status,
    attemptCount: Math.min(WEBHOOK_EVENT_MAX_ATTEMPTS, row.attemptCount + 1),
    nextAttemptAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    errorClassification: input.code ? "processing" : null,
    errorCode: input.code ?? null,
    processedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(webhookEvents.id, row.id),
    eq(webhookEvents.organizationId, row.organizationId),
  ));
}

async function retry(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  code: string,
  now: Date,
): Promise<SquareWebhookProcessingResult> {
  const attemptCount = row.attemptCount + 1;
  if (attemptCount >= WEBHOOK_EVENT_MAX_ATTEMPTS) {
    await finish(tx, row, { status: "failed", code: "ATTEMPTS_EXHAUSTED", now: now.toISOString() });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "failed",
      code: "ATTEMPTS_EXHAUSTED",
    };
  }
  await tx.update(webhookEvents).set({
    status: "retry_scheduled",
    attemptCount,
    nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    errorClassification: "mapping",
    errorCode: code,
    processedAt: now.toISOString(),
    completedAt: null,
    updatedAt: now.toISOString(),
  }).where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.organizationId, row.organizationId)));
  return {
    acknowledged: false,
    terminal: false,
    businessStateChanged: false,
    status: "retry_scheduled",
    code,
  };
}

async function freshness(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
): Promise<"current" | "stale" | "ambiguous"> {
  const common = and(
    eq(webhookEvents.provider, row.provider),
    eq(webhookEvents.providerApplicationId, row.providerApplicationId),
    eq(webhookEvents.providerMerchantId, row.providerMerchantId),
    eq(webhookEvents.providerLocationId, row.providerLocationId),
    eq(webhookEvents.providerObjectType, row.providerObjectType),
    eq(webhookEvents.providerObjectId, row.providerObjectId),
    ne(webhookEvents.id, row.id),
  );
  if (row.providerObjectVersion !== null) {
    const peers = await tx.select({ version: webhookEvents.providerObjectVersion })
      .from(webhookEvents)
      .where(and(common, isNotNull(webhookEvents.providerObjectVersion), or(
        gt(webhookEvents.providerObjectVersion, row.providerObjectVersion),
        eq(webhookEvents.providerObjectVersion, row.providerObjectVersion),
      ))).limit(1);
    const version = peers[0]?.version;
    if (version === row.providerObjectVersion) return "ambiguous";
    if (version !== undefined) return "stale";
    return "current";
  }
  if (row.providerObjectUpdatedAt !== null) {
    const peers = await tx.select({ updatedAt: webhookEvents.providerObjectUpdatedAt })
      .from(webhookEvents)
      .where(and(common, isNotNull(webhookEvents.providerObjectUpdatedAt), or(
        gt(webhookEvents.providerObjectUpdatedAt, row.providerObjectUpdatedAt),
        eq(webhookEvents.providerObjectUpdatedAt, row.providerObjectUpdatedAt),
      ))).limit(1);
    const updatedAt = peers[0]?.updatedAt;
    if (updatedAt !== undefined && updatedAt !== null) {
      const peerTime = new Date(updatedAt).getTime();
      const currentTime = new Date(row.providerObjectUpdatedAt).getTime();
      if (peerTime === currentTime) return "ambiguous";
      if (peerTime > currentTime) return "stale";
    }
  }
  return "current";
}

async function findRefundOperationId(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  event: NormalizedSquareWebhookEvent,
): Promise<string | null | "ambiguous"> {
  const byRefundId = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, row.organizationId),
    eq(paymentOperations.operationType, "refund"),
    eq(paymentOperations.providerName, "square"),
    eq(paymentOperations.providerObjectId, event.providerObjectId),
  )).limit(2);
  if (byRefundId.length > 1) return "ambiguous";
  if (byRefundId[0]) return byRefundId[0].id;
  if (event.providerPaymentId === null || event.amountMinor === null || event.currency === null) return null;
  const candidates = await tx.select({ id: paymentOperations.id })
    .from(paymentOperations)
    .innerJoin(
      refundPaymentOperationSnapshots,
      eq(refundPaymentOperationSnapshots.operationId, paymentOperations.id),
    )
    .innerJoin(payments, eq(payments.id, refundPaymentOperationSnapshots.paymentId))
    .where(and(
      eq(paymentOperations.organizationId, row.organizationId),
      eq(paymentOperations.operationType, "refund"),
      eq(paymentOperations.providerName, "square"),
      eq(paymentOperations.amountMinor, event.amountMinor),
      eq(paymentOperations.currency, event.currency),
      eq(refundPaymentOperationSnapshots.locationId, row.locationId),
      eq(payments.providerPaymentId, event.providerPaymentId),
    )).limit(2);
  if (candidates.length > 1) return "ambiguous";
  return candidates[0]?.id ?? null;
}

async function findChargeOperationId(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  event: NormalizedSquareWebhookEvent,
): Promise<string | null | "ambiguous" | "invalid"> {
  const base = and(
    eq(paymentOperations.organizationId, row.organizationId),
    inArray(paymentOperations.operationType, ["scheduled_charge", "interactive_charge"]),
    eq(paymentOperations.providerName, "square"),
  );
  if (event.providerReferenceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.providerReferenceId)) {
    return "invalid";
  }
  const candidates = event.providerReferenceId
    ? await tx.select({ id: paymentOperations.id }).from(paymentOperations)
      .where(and(base, eq(paymentOperations.id, event.providerReferenceId))).limit(2)
    : await tx.select({ id: paymentOperations.id }).from(paymentOperations)
      .where(and(base, eq(paymentOperations.providerObjectId, event.providerObjectId))).limit(2);
  if (candidates.length > 1) return "ambiguous";
  return candidates[0]?.id ?? null;
}

/** Processes one already-ingested, signature-verified event without provider I/O. */
export async function processSquareWebhookEvent(input: {
  organizationId: number;
  eventId: string;
  event: NormalizedSquareWebhookEvent;
  now?: Date;
}): Promise<SquareWebhookProcessingResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(webhookEvents).where(and(
      eq(webhookEvents.id, input.eventId),
      eq(webhookEvents.organizationId, input.organizationId),
    )).limit(1).for("update");
    if (!row || !eventEvidenceMatches(row, input.event)) {
      return { acknowledged: false, terminal: false, businessStateChanged: false, status: "pending", code: "EVENT_EVIDENCE_MISMATCH" };
    }
    if (["processed", "ignored", "failed"].includes(row.status)) {
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: row.status, code: row.errorCode };
    }
    if (row.status === "processing" || (
      row.status === "retry_scheduled"
      && row.nextAttemptAt !== null
      && new Date(row.nextAttemptAt).getTime() > now.getTime()
    )) {
      return { acknowledged: false, terminal: false, businessStateChanged: false, status: row.status, code: "EVENT_NOT_DUE" };
    }
    if (input.event.eventType === "dispute.created" || input.event.eventType === "dispute.state.updated") {
      await finish(tx, row, { status: "ignored", code: "DISPUTE_PROCESSING_DEFERRED", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "ignored", code: "DISPUTE_PROCESSING_DEFERRED" };
    }
    if (input.event.providerStatus !== "COMPLETED") {
      const code = input.event.eventType === "refund.updated"
        ? "REFUND_NOT_COMPLETED"
        : "PAYMENT_NOT_COMPLETED";
      await finish(tx, row, { status: "ignored", code, now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "ignored", code };
    }
    if (input.event.providerObjectVersion === null && input.event.providerObjectUpdatedAt === null) {
      await finish(tx, row, { status: "failed", code: "PROVIDER_FRESHNESS_MISSING", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "failed", code: "PROVIDER_FRESHNESS_MISSING" };
    }
    const eventFreshness = await freshness(tx, row);
    if (eventFreshness !== "current") {
      const code = eventFreshness === "stale" ? "STALE_PROVIDER_EVENT" : "AMBIGUOUS_PROVIDER_FRESHNESS";
      await finish(tx, row, { status: "ignored", code, now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "ignored", code };
    }
    if (input.event.amountMinor === null || input.event.currency === null || input.event.providerPaymentId === null) {
      await finish(tx, row, { status: "failed", code: "EVENT_EVIDENCE_INCOMPLETE", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "failed", code: "EVENT_EVIDENCE_INCOMPLETE" };
    }

    const operationId = input.event.eventType === "refund.updated"
      ? await findRefundOperationId(tx, row, input.event)
      : await findChargeOperationId(tx, row, input.event);
    if (operationId === null) return retry(tx, row, "OPERATION_NOT_FOUND", now);
    if (operationId === "ambiguous") {
      await finish(tx, row, { status: "failed", code: "OPERATION_AMBIGUOUS", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "failed", code: "OPERATION_AMBIGUOUS" };
    }
    if (operationId === "invalid") {
      await finish(tx, row, { status: "failed", code: "OPERATION_REFERENCE_INVALID", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "failed", code: "OPERATION_REFERENCE_INVALID" };
    }

    try {
      const evidence = {
        organizationId: row.organizationId,
        operationId,
        locationId: row.locationId,
        providerLocationId: row.providerLocationId,
        providerObjectId: input.event.providerObjectId,
        providerPaymentId: input.event.providerPaymentId,
        providerOrderId: input.event.providerOrderId,
        amountMinor: input.event.amountMinor,
        currency: input.event.currency,
        receiptUrl: input.event.receiptUrl,
        receiptNumber: input.event.receiptNumber,
        now,
      };
      if (input.event.eventType === "refund.updated") {
        await finalizeRefundFromWebhookEvidenceInTransaction(tx, evidence);
      } else {
        await finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence);
      }
      await finish(tx, row, { status: "processed", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: true, status: "processed", code: null };
    } catch (error) {
      if (
        error instanceof PaymentOperationImmutableMismatchError
        || error instanceof PaymentOperationInvalidTransitionError
        || error instanceof PaymentOperationNotFoundError
      ) {
        await finish(tx, row, { status: "failed", code: "OPERATION_EVIDENCE_MISMATCH", now: now.toISOString() });
        return { acknowledged: true, terminal: true, businessStateChanged: false, status: "failed", code: "OPERATION_EVIDENCE_MISMATCH" };
      }
      throw error;
    }
  });
}
