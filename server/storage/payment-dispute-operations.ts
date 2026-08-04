import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  PAYMENT_DISPUTE_STATES,
  paymentDisputeAcknowledgements,
  paymentDisputeNotifications,
  paymentDisputeReplayAudits,
  paymentDisputes,
  webhookEvents,
  type PaymentDisputeState,
} from "@shared/schema";
import { db } from "../db.js";
import { normalizeSquareWebhookEvent } from "../services/square-webhook-event.js";
import { decrypt } from "../utils/crypto.js";
import {
  processSquareWebhookEvent,
  type SquareWebhookProcessingResult,
  type SquareWebhookReplayActor,
} from "./square-webhook-processing.js";

const cursorSchema = z.object({
  at: z.string().datetime(),
  id: z.string().uuid(),
});

export interface DisputePageInput {
  organizationId: number;
  limit: number;
  cursor?: string;
  locationId?: number;
  state?: PaymentDisputeState;
}

export interface TenantPageInput {
  organizationId: number;
  limit: number;
  cursor?: string;
}

export interface DisputeNotificationPageInput extends TenantPageInput {
  paymentDisputeId?: string;
}

export class InvalidDisputeCursorError extends Error {
  constructor() {
    super("Invalid dispute pagination cursor");
    this.name = "InvalidDisputeCursorError";
  }
}

export class DisputeReplayError extends Error {
  constructor(
    readonly code:
      | "WEBHOOK_EVENT_NOT_FOUND"
      | "WEBHOOK_EVENT_NOT_REPLAYABLE"
      | "WEBHOOK_EVIDENCE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "DisputeReplayError";
  }
}

export class DisputeAcknowledgementError extends Error {
  constructor(
    readonly code: "PAYMENT_DISPUTE_NOT_FOUND" | "DISPUTE_VERSION_CHANGED",
  ) {
    super(code);
    this.name = "DisputeAcknowledgementError";
  }
}

function decodeCursor(value: string | undefined): { at: string; id: string } | null {
  if (!value) return null;
  if (value.length > 512) throw new InvalidDisputeCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const result = cursorSchema.safeParse(parsed);
    if (!result.success) throw new InvalidDisputeCursorError();
    return { at: new Date(result.data.at).toISOString(), id: result.data.id };
  } catch (error) {
    if (error instanceof InvalidDisputeCursorError) throw error;
    throw new InvalidDisputeCursorError();
  }
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at: new Date(at).toISOString(), id }), "utf8").toString("base64url");
}

function olderThan(
  column: typeof paymentDisputes.updatedAt | typeof paymentDisputeNotifications.createdAt
    | typeof paymentDisputeReplayAudits.createdAt | typeof webhookEvents.receivedAt,
  idColumn: typeof paymentDisputes.id | typeof paymentDisputeNotifications.id
    | typeof paymentDisputeReplayAudits.id | typeof webhookEvents.id,
  cursor: { at: string; id: string } | null,
): SQL | undefined {
  return cursor
    ? or(lt(column, cursor.at), and(eq(column, cursor.at), lt(idColumn, cursor.id)))
    : undefined;
}

function page<T extends { id: string }>(
  rows: T[],
  limit: number,
  timestamp: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const tail = rows.length > limit ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: tail ? encodeCursor(timestamp(tail), tail.id) : null,
  };
}

export async function listPaymentDisputes(input: DisputePageInput) {
  const cursor = decodeCursor(input.cursor);
  const filters: Array<SQL | undefined> = [
    eq(paymentDisputes.organizationId, input.organizationId),
    input.locationId ? eq(paymentDisputes.locationId, input.locationId) : undefined,
    input.state ? eq(paymentDisputes.state, input.state) : undefined,
    olderThan(paymentDisputes.updatedAt, paymentDisputes.id, cursor),
  ];
  const rows = await db.select({
    id: paymentDisputes.id,
    locationId: paymentDisputes.locationId,
    paymentOperationId: paymentDisputes.paymentOperationId,
    providerDisputeId: paymentDisputes.providerDisputeId,
    providerPaymentId: paymentDisputes.providerPaymentId,
    amountMinor: paymentDisputes.amountMinor,
    currency: paymentDisputes.currency,
    reason: paymentDisputes.reason,
    state: paymentDisputes.state,
    responseDueAt: paymentDisputes.responseDueAt,
    cardBrand: paymentDisputes.cardBrand,
    providerCreatedAt: paymentDisputes.providerCreatedAt,
    providerReportedAt: paymentDisputes.providerReportedAt,
    providerUpdatedAt: paymentDisputes.providerUpdatedAt,
    providerVersion: paymentDisputes.providerVersion,
    acknowledgementId: paymentDisputeAcknowledgements.id,
    acknowledgedProviderVersion: paymentDisputeAcknowledgements.providerVersion,
    acknowledgedByUserId: paymentDisputeAcknowledgements.actorUserId,
    acknowledgedByRole: paymentDisputeAcknowledgements.actorRole,
    acknowledgedAt: paymentDisputeAcknowledgements.acknowledgedAt,
    createdAt: paymentDisputes.createdAt,
    updatedAt: paymentDisputes.updatedAt,
  }).from(paymentDisputes)
    .leftJoin(paymentDisputeAcknowledgements, and(
      eq(paymentDisputeAcknowledgements.organizationId, paymentDisputes.organizationId),
      eq(paymentDisputeAcknowledgements.paymentDisputeId, paymentDisputes.id),
      eq(paymentDisputeAcknowledgements.providerVersion, paymentDisputes.providerVersion),
    ))
    .where(and(...filters))
    .orderBy(desc(paymentDisputes.updatedAt), desc(paymentDisputes.id))
    .limit(input.limit + 1);
  return page(rows, input.limit, (row) => row.updatedAt);
}

export async function listPaymentDisputeNotifications(input: DisputeNotificationPageInput) {
  const cursor = decodeCursor(input.cursor);
  const rows = await db.select({
    id: paymentDisputeNotifications.id,
    locationId: paymentDisputeNotifications.locationId,
    paymentDisputeId: paymentDisputeNotifications.paymentDisputeId,
    webhookEventId: paymentDisputeNotifications.webhookEventId,
    kind: paymentDisputeNotifications.kind,
    disputeState: paymentDisputeNotifications.disputeState,
    providerVersion: paymentDisputeNotifications.providerVersion,
    acknowledgementId: paymentDisputeAcknowledgements.id,
    acknowledgedByUserId: paymentDisputeAcknowledgements.actorUserId,
    acknowledgedByRole: paymentDisputeAcknowledgements.actorRole,
    acknowledgedAt: paymentDisputeAcknowledgements.acknowledgedAt,
    createdAt: paymentDisputeNotifications.createdAt,
  }).from(paymentDisputeNotifications)
    .leftJoin(paymentDisputeAcknowledgements, and(
      eq(paymentDisputeAcknowledgements.organizationId, paymentDisputeNotifications.organizationId),
      eq(paymentDisputeAcknowledgements.paymentDisputeId, paymentDisputeNotifications.paymentDisputeId),
      eq(paymentDisputeAcknowledgements.providerVersion, paymentDisputeNotifications.providerVersion),
    ))
    .where(and(
      eq(paymentDisputeNotifications.organizationId, input.organizationId),
      input.paymentDisputeId
        ? eq(paymentDisputeNotifications.paymentDisputeId, input.paymentDisputeId)
        : undefined,
      olderThan(paymentDisputeNotifications.createdAt, paymentDisputeNotifications.id, cursor),
    )).orderBy(desc(paymentDisputeNotifications.createdAt), desc(paymentDisputeNotifications.id))
    .limit(input.limit + 1);
  return page(rows, input.limit, (row) => row.createdAt);
}

/** Counts current dispute versions lacking a tenant-wide acknowledgement. */
export async function countUnacknowledgedPaymentDisputes(organizationId: number): Promise<number> {
  const [row] = await db.select({ value: count() }).from(paymentDisputes)
    .leftJoin(paymentDisputeAcknowledgements, and(
      eq(paymentDisputeAcknowledgements.organizationId, paymentDisputes.organizationId),
      eq(paymentDisputeAcknowledgements.paymentDisputeId, paymentDisputes.id),
      eq(paymentDisputeAcknowledgements.providerVersion, paymentDisputes.providerVersion),
    ))
    .where(and(
      eq(paymentDisputes.organizationId, organizationId),
      isNull(paymentDisputeAcknowledgements.id),
    ));
  return row?.value ?? 0;
}

/**
 * Acknowledges only the tenant-scoped current provider version. Locking the
 * dispute row serializes this action with webhook reconciliation, while the
 * unique dispute/version constraint makes client retries idempotent.
 */
export async function acknowledgePaymentDispute(input: {
  organizationId: number;
  paymentDisputeId: string;
  providerVersion: number;
  actor: { userId: number; role: "org_admin" | "system_admin" };
  now?: Date;
}) {
  return db.transaction(async (tx) => {
    const [dispute] = await tx.select({
      id: paymentDisputes.id,
      providerVersion: paymentDisputes.providerVersion,
    }).from(paymentDisputes).where(and(
      eq(paymentDisputes.id, input.paymentDisputeId),
      eq(paymentDisputes.organizationId, input.organizationId),
    )).limit(1).for("update");
    if (!dispute) throw new DisputeAcknowledgementError("PAYMENT_DISPUTE_NOT_FOUND");
    if (dispute.providerVersion !== input.providerVersion) {
      // Preserve HTTP idempotency across a later webhook update: a retry of
      // an acknowledgement that already committed returns that immutable old
      // version, but a stale request that never committed cannot create one.
      const [existing] = await tx.select().from(paymentDisputeAcknowledgements)
        .where(and(
          eq(paymentDisputeAcknowledgements.organizationId, input.organizationId),
          eq(paymentDisputeAcknowledgements.paymentDisputeId, dispute.id),
          eq(paymentDisputeAcknowledgements.providerVersion, input.providerVersion),
        )).limit(1);
      if (existing) {
        return {
          id: existing.id,
          paymentDisputeId: existing.paymentDisputeId,
          providerVersion: existing.providerVersion,
          acknowledgedByUserId: existing.actorUserId,
          acknowledgedByRole: existing.actorRole,
          acknowledgedAt: existing.acknowledgedAt,
          created: false,
        };
      }
      throw new DisputeAcknowledgementError("DISPUTE_VERSION_CHANGED");
    }

    const [created] = await tx.insert(paymentDisputeAcknowledgements).values({
      organizationId: input.organizationId,
      paymentDisputeId: dispute.id,
      providerVersion: dispute.providerVersion,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      acknowledgedAt: (input.now ?? new Date()).toISOString(),
    }).onConflictDoNothing({
      target: [
        paymentDisputeAcknowledgements.paymentDisputeId,
        paymentDisputeAcknowledgements.providerVersion,
      ],
    }).returning();

    const acknowledgement = created ?? (await tx.select().from(paymentDisputeAcknowledgements)
      .where(and(
        eq(paymentDisputeAcknowledgements.organizationId, input.organizationId),
        eq(paymentDisputeAcknowledgements.paymentDisputeId, dispute.id),
        eq(paymentDisputeAcknowledgements.providerVersion, dispute.providerVersion),
      )).limit(1))[0];
    if (!acknowledgement) throw new Error("dispute acknowledgement conflict did not converge");
    return {
      id: acknowledgement.id,
      paymentDisputeId: acknowledgement.paymentDisputeId,
      providerVersion: acknowledgement.providerVersion,
      acknowledgedByUserId: acknowledgement.actorUserId,
      acknowledgedByRole: acknowledgement.actorRole,
      acknowledgedAt: acknowledgement.acknowledgedAt,
      created: Boolean(created),
    };
  });
}

export async function listPendingPaymentDisputeEvents(input: TenantPageInput) {
  const cursor = decodeCursor(input.cursor);
  const rows = await db.select({
    id: webhookEvents.id,
    locationId: webhookEvents.locationId,
    eventType: webhookEvents.eventType,
    providerEventId: webhookEvents.providerEventId,
    providerDisputeId: webhookEvents.providerObjectId,
    providerPaymentId: webhookEvents.providerPaymentId,
    providerCreatedAt: webhookEvents.providerCreatedAt,
    providerVersion: webhookEvents.providerObjectVersion,
    receivedAt: webhookEvents.receivedAt,
    attemptCount: webhookEvents.attemptCount,
  }).from(webhookEvents).where(and(
    eq(webhookEvents.organizationId, input.organizationId),
    eq(webhookEvents.status, "pending"),
    inArray(webhookEvents.eventType, ["dispute.created", "dispute.state.updated"]),
    olderThan(webhookEvents.receivedAt, webhookEvents.id, cursor),
  )).orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
    .limit(input.limit + 1);
  return page(rows, input.limit, (row) => row.receivedAt);
}

export async function listPaymentDisputeReplayAudits(input: TenantPageInput) {
  const cursor = decodeCursor(input.cursor);
  const rows = await db.select({
    id: paymentDisputeReplayAudits.id,
    webhookEventId: paymentDisputeReplayAudits.webhookEventId,
    actorUserId: paymentDisputeReplayAudits.actorUserId,
    actorRole: paymentDisputeReplayAudits.actorRole,
    initialStatus: paymentDisputeReplayAudits.initialStatus,
    resultStatus: paymentDisputeReplayAudits.resultStatus,
    resultCode: paymentDisputeReplayAudits.resultCode,
    businessStateChanged: paymentDisputeReplayAudits.businessStateChanged,
    createdAt: paymentDisputeReplayAudits.createdAt,
  }).from(paymentDisputeReplayAudits).where(and(
    eq(paymentDisputeReplayAudits.organizationId, input.organizationId),
    olderThan(paymentDisputeReplayAudits.createdAt, paymentDisputeReplayAudits.id, cursor),
  )).orderBy(desc(paymentDisputeReplayAudits.createdAt), desc(paymentDisputeReplayAudits.id))
    .limit(input.limit + 1);
  return page(rows, input.limit, (row) => row.createdAt);
}

export async function replayPendingPaymentDisputeEvent(input: {
  organizationId: number;
  eventId: string;
  actor: SquareWebhookReplayActor;
  now?: Date;
}): Promise<SquareWebhookProcessingResult> {
  const [row] = await db.select().from(webhookEvents).where(and(
    eq(webhookEvents.id, input.eventId),
    eq(webhookEvents.organizationId, input.organizationId),
  )).limit(1);
  if (!row) throw new DisputeReplayError("WEBHOOK_EVENT_NOT_FOUND");
  if (
    row.status !== "pending"
    || (row.eventType !== "dispute.created" && row.eventType !== "dispute.state.updated")
  ) {
    throw new DisputeReplayError("WEBHOOK_EVENT_NOT_REPLAYABLE");
  }
  const rawBody = decrypt(row.encryptedPayload);
  if (
    rawBody === null
    || createHash("sha256").update(rawBody, "utf8").digest("hex") !== row.payloadHash
  ) {
    throw new DisputeReplayError("WEBHOOK_EVIDENCE_UNAVAILABLE");
  }
  let event;
  try {
    event = normalizeSquareWebhookEvent(rawBody);
  } catch {
    throw new DisputeReplayError("WEBHOOK_EVIDENCE_UNAVAILABLE");
  }
  return processSquareWebhookEvent({
    organizationId: input.organizationId,
    eventId: input.eventId,
    event,
    processDisputes: true,
    replayActor: input.actor,
    now: input.now,
  });
}

export function isPaymentDisputeState(value: string): value is PaymentDisputeState {
  return new Set<string>(PAYMENT_DISPUTE_STATES).has(value);
}
