import { and, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import {
  PAYMENT_DISPUTE_REASONS,
  PAYMENT_DISPUTE_STATES,
  interactivePaymentOperationSnapshots,
  paymentDisputeNotifications,
  paymentDisputeReplayAudits,
  paymentDisputes,
  paymentOperations,
  payments,
  refundPaymentOperationSnapshots,
  scheduledPaymentOperationSnapshots,
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

export interface SquareWebhookProcessingResult {
  acknowledged: boolean;
  terminal: boolean;
  businessStateChanged: boolean;
  status: WebhookEvent["status"];
  code: string | null;
  scheduledPaymentWakeRequired?: boolean;
}

export interface SquareWebhookReplayActor {
  userId: number;
  role: "org_admin" | "system_admin";
}

async function recordReplayAudit(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  actor: SquareWebhookReplayActor | undefined,
  result: SquareWebhookProcessingResult,
  now: Date,
): Promise<SquareWebhookProcessingResult> {
  if (!actor) return result;
  await tx.insert(paymentDisputeReplayAudits).values({
    organizationId: row.organizationId,
    webhookEventId: row.id,
    actorUserId: actor.userId,
    actorRole: actor.role,
    initialStatus: row.status,
    resultStatus: result.status,
    resultCode: result.code,
    businessStateChanged: result.businessStateChanged,
    createdAt: now.toISOString(),
  });
  return result;
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
  input: {
    status: "processed" | "ignored" | "failed";
    code?: string;
    classification?: "mapping" | "processing";
    now: string;
  },
): Promise<void> {
  await tx.update(webhookEvents).set({
    status: input.status,
    attemptCount: Math.min(WEBHOOK_EVENT_MAX_ATTEMPTS, row.attemptCount + 1),
    nextAttemptAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    errorClassification: input.code ? (input.classification ?? "processing") : null,
    errorCode: input.code ?? null,
    processedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(webhookEvents.id, row.id),
    eq(webhookEvents.organizationId, row.organizationId),
  ));
}

async function freshness(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  equalIsAmbiguous = true,
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
      .where(and(
        common,
        isNotNull(webhookEvents.providerObjectVersion),
        equalIsAmbiguous
          ? or(
            gt(webhookEvents.providerObjectVersion, row.providerObjectVersion),
            eq(webhookEvents.providerObjectVersion, row.providerObjectVersion),
          )
          : gt(webhookEvents.providerObjectVersion, row.providerObjectVersion),
      )).limit(1);
    const version = peers[0]?.version;
    if (version === row.providerObjectVersion) return "ambiguous";
    if (version !== undefined) return "stale";
    return "current";
  }
  if (row.providerObjectUpdatedAt !== null) {
    const peers = await tx.select({ updatedAt: webhookEvents.providerObjectUpdatedAt })
      .from(webhookEvents)
      .where(and(
        common,
        isNotNull(webhookEvents.providerObjectUpdatedAt),
        equalIsAmbiguous
          ? or(
            gt(webhookEvents.providerObjectUpdatedAt, row.providerObjectUpdatedAt),
            eq(webhookEvents.providerObjectUpdatedAt, row.providerObjectUpdatedAt),
          )
          : gt(webhookEvents.providerObjectUpdatedAt, row.providerObjectUpdatedAt),
      )).limit(1);
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
): Promise<string | null | "ambiguous"> {
  const base = and(
    eq(paymentOperations.organizationId, row.organizationId),
    inArray(paymentOperations.operationType, ["scheduled_charge", "interactive_charge"]),
    eq(paymentOperations.providerName, "square"),
  );
  const referenceId = event.providerReferenceId;
  if (referenceId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(referenceId)) {
    return null;
  }
  const candidates = referenceId !== null
    ? await tx.select({ id: paymentOperations.id }).from(paymentOperations)
      .where(and(base, eq(paymentOperations.id, referenceId))).limit(2)
    : await tx.select({ id: paymentOperations.id }).from(paymentOperations)
      .where(and(base, eq(paymentOperations.providerObjectId, event.providerObjectId))).limit(2);
  if (candidates.length > 1) return "ambiguous";
  return candidates[0]?.id ?? null;
}

type DisputeOperationMapping =
  | { kind: "found"; operationId: string }
  | { kind: "not_owned" | "ambiguous" | "mismatch" };

async function findDisputeOperation(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  event: NormalizedSquareWebhookEvent,
): Promise<DisputeOperationMapping> {
  if (
    event.providerPaymentId === null
    || event.amountMinor === null
    || event.currency === null
  ) {
    return { kind: "mismatch" };
  }
  const candidates = await tx.select({
    id: paymentOperations.id,
    operationType: paymentOperations.operationType,
    status: paymentOperations.status,
    amountMinor: paymentOperations.amountMinor,
    currency: paymentOperations.currency,
    scheduledLocationId: scheduledPaymentOperationSnapshots.locationId,
    scheduledProviderLocationId: scheduledPaymentOperationSnapshots.providerLocationId,
    interactiveLocationId: interactivePaymentOperationSnapshots.locationId,
    interactiveProviderLocationId: interactivePaymentOperationSnapshots.providerLocationId,
  }).from(paymentOperations)
    .leftJoin(
      scheduledPaymentOperationSnapshots,
      eq(scheduledPaymentOperationSnapshots.operationId, paymentOperations.id),
    )
    .leftJoin(
      interactivePaymentOperationSnapshots,
      eq(interactivePaymentOperationSnapshots.operationId, paymentOperations.id),
    )
    .where(and(
      eq(paymentOperations.organizationId, row.organizationId),
      inArray(paymentOperations.operationType, ["scheduled_charge", "interactive_charge"]),
      eq(paymentOperations.providerName, "square"),
      eq(paymentOperations.providerObjectId, event.providerPaymentId),
    )).limit(2).for("update", { of: paymentOperations });
  if (candidates.length === 0) return { kind: "not_owned" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  const operation = candidates[0];
  if (!operation) return { kind: "not_owned" };
  const locationMatches = operation.operationType === "scheduled_charge"
    ? operation.scheduledLocationId === row.locationId
      && (
        operation.scheduledProviderLocationId === null
        || operation.scheduledProviderLocationId === row.providerLocationId
      )
    : operation.interactiveLocationId === row.locationId
      && (
        operation.interactiveProviderLocationId === null
        || operation.interactiveProviderLocationId === row.providerLocationId
      );
  if (
    operation.status !== "succeeded"
    || !locationMatches
    || operation.currency !== event.currency
    || event.amountMinor > operation.amountMinor
  ) {
    return { kind: "mismatch" };
  }
  const allocations = await tx.select({
    amount: payments.amount,
    providerPaymentId: payments.providerPaymentId,
  }).from(payments).where(eq(payments.paymentOperationId, operation.id)).limit(26);
  if (
    allocations.length === 0
    || allocations.length > 25
    || allocations.some((payment) => payment.providerPaymentId !== event.providerPaymentId)
    || allocations.reduce((sum, payment) => sum + payment.amount, 0) !== operation.amountMinor
  ) {
    return { kind: "mismatch" };
  }
  return { kind: "found", operationId: operation.id };
}

function timestampsMatch(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  return left !== null
    && right !== null
    && new Date(left).getTime() === new Date(right).getTime();
}

function isSupportedDisputeState(value: string | null): value is (typeof PAYMENT_DISPUTE_STATES)[number] {
  return value !== null && new Set<string>(PAYMENT_DISPUTE_STATES).has(value);
}

function isSupportedDisputeReason(value: string): value is (typeof PAYMENT_DISPUTE_REASONS)[number] {
  return new Set<string>(PAYMENT_DISPUTE_REASONS).has(value);
}

async function reconcileDispute(
  tx: PaymentOperationTransaction,
  row: WebhookEvent,
  event: NormalizedSquareWebhookEvent,
  now: Date,
): Promise<SquareWebhookProcessingResult> {
  if (
    event.dispute === null
    || event.providerPaymentId === null
    || event.providerObjectVersion === null
    || event.providerObjectUpdatedAt === null
    || event.amountMinor === null
    || event.currency === null
  ) {
    await finish(tx, row, {
      status: "failed",
      code: "DISPUTE_EVIDENCE_INCOMPLETE",
      now: now.toISOString(),
    });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "failed",
      code: "DISPUTE_EVIDENCE_INCOMPLETE",
    };
  }
  if (!isSupportedDisputeState(event.providerStatus)) {
    await finish(tx, row, {
      status: "failed",
      code: "DISPUTE_STATE_UNSUPPORTED",
      now: now.toISOString(),
    });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "failed",
      code: "DISPUTE_STATE_UNSUPPORTED",
    };
  }
  if (!isSupportedDisputeReason(event.dispute.reason)) {
    await finish(tx, row, {
      status: "failed",
      code: "DISPUTE_REASON_UNSUPPORTED",
      now: now.toISOString(),
    });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "failed",
      code: "DISPUTE_REASON_UNSUPPORTED",
    };
  }
  const eventFreshness = await freshness(tx, row, false);
  if (eventFreshness === "stale") {
    await finish(tx, row, { status: "ignored", code: "STALE_PROVIDER_EVENT", now: now.toISOString() });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "ignored",
      code: "STALE_PROVIDER_EVENT",
    };
  }
  const mapping = await findDisputeOperation(tx, row, event);
  if (mapping.kind === "not_owned") {
    await finish(tx, row, {
      status: "ignored",
      code: "DISPUTE_NOT_OWNED",
      classification: "mapping",
      now: now.toISOString(),
    });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "ignored",
      code: "DISPUTE_NOT_OWNED",
    };
  }
  if (mapping.kind !== "found") {
    const code = mapping.kind === "ambiguous"
      ? "DISPUTE_OPERATION_AMBIGUOUS"
      : "DISPUTE_OPERATION_MISMATCH";
    await finish(tx, row, {
      status: "failed",
      code,
      classification: "mapping",
      now: now.toISOString(),
    });
    return {
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "failed",
      code,
    };
  }

  const values = {
    organizationId: row.organizationId,
    locationId: row.locationId,
    paymentOperationId: mapping.operationId,
    provider: "square",
    providerApplicationId: row.providerApplicationId,
    providerMerchantId: row.providerMerchantId,
    providerLocationId: row.providerLocationId,
    providerDisputeId: event.providerObjectId,
    providerPaymentId: event.providerPaymentId,
    amountMinor: event.amountMinor,
    currency: event.currency,
    reason: event.dispute.reason,
    state: event.providerStatus,
    responseDueAt: event.dispute.dueAt,
    cardBrand: event.dispute.cardBrand,
    brandDisputeId: event.dispute.brandDisputeId,
    providerCreatedAt: event.dispute.createdAt,
    providerReportedAt: event.dispute.reportedAt,
    providerUpdatedAt: event.providerObjectUpdatedAt,
    providerVersion: event.providerObjectVersion,
    firstWebhookEventId: row.id,
    lastWebhookEventId: row.id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const [created] = await tx.insert(paymentDisputes).values(values)
    .onConflictDoNothing({
      target: [paymentDisputes.provider, paymentDisputes.providerDisputeId],
    }).returning();
  let notificationDisputeId = created?.id ?? null;
  const notificationKind = event.eventType === "dispute.created"
    ? "DISPUTE_CREATED"
    : "DISPUTE_STATE_UPDATED";
  if (!created) {
    const [existing] = await tx.select().from(paymentDisputes).where(and(
      eq(paymentDisputes.provider, "square"),
      eq(paymentDisputes.providerDisputeId, event.providerObjectId),
    )).limit(1).for("update");
    if (!existing) throw new Error("dispute upsert conflict did not converge");
    notificationDisputeId = existing.id;
    const immutableMatches = existing.organizationId === row.organizationId
      && existing.locationId === row.locationId
      && existing.paymentOperationId === mapping.operationId
      && existing.providerApplicationId === row.providerApplicationId
      && existing.providerMerchantId === row.providerMerchantId
      && existing.providerLocationId === row.providerLocationId
      && existing.providerPaymentId === event.providerPaymentId
      && existing.amountMinor === event.amountMinor
      && existing.currency === event.currency
      && existing.reason === event.dispute.reason
      && existing.cardBrand === event.dispute.cardBrand
      && existing.brandDisputeId === event.dispute.brandDisputeId
      && timestampsMatch(existing.providerCreatedAt, event.dispute.createdAt);
    if (!immutableMatches) {
      await finish(tx, row, {
        status: "failed",
        code: "DISPUTE_IDENTITY_MISMATCH",
        now: now.toISOString(),
      });
      return {
        acknowledged: true,
        terminal: true,
        businessStateChanged: false,
        status: "failed",
        code: "DISPUTE_IDENTITY_MISMATCH",
      };
    }
    if (existing.providerVersion > event.providerObjectVersion) {
      await finish(tx, row, {
        status: "ignored",
        code: "STALE_PROVIDER_EVENT",
        now: now.toISOString(),
      });
      return {
        acknowledged: true,
        terminal: true,
        businessStateChanged: false,
        status: "ignored",
        code: "STALE_PROVIDER_EVENT",
      };
    }
    if (existing.providerVersion === event.providerObjectVersion) {
      const sameVersionMatches = existing.state === event.providerStatus
        && timestampsMatch(existing.responseDueAt, event.dispute.dueAt)
        && timestampsMatch(existing.providerReportedAt, event.dispute.reportedAt)
        && timestampsMatch(existing.providerUpdatedAt, event.providerObjectUpdatedAt);
      const code = sameVersionMatches
        ? "DUPLICATE_DISPUTE_VERSION"
        : "AMBIGUOUS_PROVIDER_FRESHNESS";
      const status = sameVersionMatches ? "ignored" : "failed";
      await finish(tx, row, { status, code, now: now.toISOString() });
      return {
        acknowledged: true,
        terminal: true,
        businessStateChanged: false,
        status,
        code,
      };
    }
    await tx.update(paymentDisputes).set({
      state: event.providerStatus,
      responseDueAt: event.dispute.dueAt,
      providerReportedAt: event.dispute.reportedAt,
      providerUpdatedAt: event.providerObjectUpdatedAt,
      providerVersion: event.providerObjectVersion,
      lastWebhookEventId: row.id,
      updatedAt: now.toISOString(),
    }).where(and(
      eq(paymentDisputes.id, existing.id),
      eq(paymentDisputes.organizationId, row.organizationId),
      eq(paymentDisputes.providerVersion, existing.providerVersion),
    ));
  }
  if (!notificationDisputeId) throw new Error("dispute notification identity missing");
  await tx.insert(paymentDisputeNotifications).values({
    organizationId: row.organizationId,
    locationId: row.locationId,
    paymentDisputeId: notificationDisputeId,
    webhookEventId: row.id,
    kind: notificationKind,
    disputeState: event.providerStatus,
    providerVersion: event.providerObjectVersion,
    createdAt: now.toISOString(),
  }).onConflictDoNothing({
    target: [paymentDisputeNotifications.paymentDisputeId, paymentDisputeNotifications.providerVersion],
  });
  await finish(tx, row, { status: "processed", now: now.toISOString() });
  return {
    acknowledged: true,
    terminal: true,
    businessStateChanged: true,
    status: "processed",
    code: null,
    scheduledPaymentWakeRequired: false,
  };
}

/** Processes one already-ingested, signature-verified event without provider I/O. */
export async function processSquareWebhookEvent(input: {
  organizationId: number;
  eventId: string;
  event: NormalizedSquareWebhookEvent;
  processDisputes?: boolean;
  replayActor?: SquareWebhookReplayActor;
  now?: Date;
}): Promise<SquareWebhookProcessingResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(webhookEvents).where(and(
      eq(webhookEvents.id, input.eventId),
      eq(webhookEvents.organizationId, input.organizationId),
    )).limit(1).for("update");
    if (!row) {
      return { acknowledged: false, terminal: false, businessStateChanged: false, status: "pending", code: "EVENT_EVIDENCE_MISMATCH" };
    }
    if (!eventEvidenceMatches(row, input.event)) {
      return recordReplayAudit(tx, row, input.replayActor, {
        acknowledged: false,
        terminal: false,
        businessStateChanged: false,
        status: row.status,
        code: "EVENT_EVIDENCE_MISMATCH",
      }, now);
    }
    if (["processed", "ignored", "failed"].includes(row.status)) {
      return recordReplayAudit(tx, row, input.replayActor, {
        acknowledged: true,
        terminal: true,
        businessStateChanged: false,
        status: row.status,
        code: row.errorCode,
      }, now);
    }
    if (row.status === "processing") {
      return recordReplayAudit(tx, row, input.replayActor, {
        acknowledged: false,
        terminal: false,
        businessStateChanged: false,
        status: row.status,
        code: "EVENT_NOT_DUE",
      }, now);
    }
    if (input.event.eventType === "dispute.created" || input.event.eventType === "dispute.state.updated") {
      if (input.processDisputes) {
        const result = await reconcileDispute(tx, row, input.event, now);
        return recordReplayAudit(tx, row, input.replayActor, result, now);
      }
      return recordReplayAudit(tx, row, input.replayActor, {
        acknowledged: true,
        terminal: false,
        businessStateChanged: false,
        status: row.status,
        code: "DISPUTE_PROCESSING_DEFERRED",
      }, now);
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
    if (operationId === null) {
      await finish(tx, row, {
        status: "ignored",
        code: "OPERATION_NOT_OWNED",
        classification: "mapping",
        now: now.toISOString(),
      });
      return {
        acknowledged: true,
        terminal: true,
        businessStateChanged: false,
        status: "ignored",
        code: "OPERATION_NOT_OWNED",
      };
    }
    if (operationId === "ambiguous") {
      await finish(tx, row, { status: "failed", code: "OPERATION_AMBIGUOUS", now: now.toISOString() });
      return { acknowledged: true, terminal: true, businessStateChanged: false, status: "failed", code: "OPERATION_AMBIGUOUS" };
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
      // Finalization can fail with a bounded immutable-evidence error after
      // several ledger writes (for example a base-allocation mismatch). Keep
      // those writes inside a savepoint so the outer transaction can still
      // durably mark the inbox event failed without committing partial
      // operation/payment state.
      await tx.transaction(async (finalizerTx) => {
        if (input.event.eventType === "refund.updated") {
          await finalizeRefundFromWebhookEvidenceInTransaction(finalizerTx, evidence);
        } else {
          await finalizeChargeFromWebhookEvidenceInTransaction(finalizerTx, evidence);
        }
      });
      await finish(tx, row, { status: "processed", now: now.toISOString() });
      return {
        acknowledged: true,
        terminal: true,
        businessStateChanged: true,
        status: "processed",
        code: null,
        scheduledPaymentWakeRequired: true,
      };
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
