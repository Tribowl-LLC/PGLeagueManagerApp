import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  PAYMENT_DISPUTE_STATES,
  paymentDisputeNotifications,
  paymentDisputeReplayAudits,
  paymentDisputes,
  paymentOperations,
  payments,
  webhookEvents,
  type Payment,
  type PaymentRowDisputeSummary,
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
    createdAt: paymentDisputes.createdAt,
    updatedAt: paymentDisputes.updatedAt,
  }).from(paymentDisputes)
    .where(and(...filters))
    .orderBy(desc(paymentDisputes.updatedAt), desc(paymentDisputes.id))
    .limit(input.limit + 1);
  return page(rows, input.limit, (row) => row.updatedAt);
}

export async function listPaymentDisputeNotifications(input: TenantPageInput) {
  const cursor = decodeCursor(input.cursor);
  const rows = await db.select({
    id: paymentDisputeNotifications.id,
    locationId: paymentDisputeNotifications.locationId,
    paymentDisputeId: paymentDisputeNotifications.paymentDisputeId,
    webhookEventId: paymentDisputeNotifications.webhookEventId,
    kind: paymentDisputeNotifications.kind,
    disputeState: paymentDisputeNotifications.disputeState,
    providerVersion: paymentDisputeNotifications.providerVersion,
    createdAt: paymentDisputeNotifications.createdAt,
  }).from(paymentDisputeNotifications).where(and(
    eq(paymentDisputeNotifications.organizationId, input.organizationId),
    olderThan(paymentDisputeNotifications.createdAt, paymentDisputeNotifications.id, cursor),
  )).orderBy(desc(paymentDisputeNotifications.createdAt), desc(paymentDisputeNotifications.id))
    .limit(input.limit + 1);
  return page(rows, input.limit, (row) => row.createdAt);
}

/**
 * Batch-load current dispute state and immutable sanitized history for the
 * payment allocations already authorized by the Payments route. The joins
 * require payment, dispute, and immutable operation organization identities
 * to agree; stale or cross-tenant operation links therefore fail closed.
 * Location ownership was already validated against the operation snapshot
 * during reconciliation and is deliberately not compared with the mutable
 * current league location here.
 */
export async function listPaymentDisputeSummariesForPayments(input: {
  paymentRows: Array<Pick<Payment, "id" | "paymentOperationId">>;
  organizationId: number | null;
}): Promise<Map<number, PaymentRowDisputeSummary[]>> {
  const eligibleRows = input.paymentRows.filter((row) => row.paymentOperationId !== null);
  if (eligibleRows.length === 0) return new Map();

  const disputeRows = await db.select({
    paymentId: payments.id,
    organizationId: paymentDisputes.organizationId,
    id: paymentDisputes.id,
    providerDisputeId: paymentDisputes.providerDisputeId,
    amountMinor: paymentDisputes.amountMinor,
    currency: paymentDisputes.currency,
    reason: paymentDisputes.reason,
    state: paymentDisputes.state,
    responseDueAt: paymentDisputes.responseDueAt,
    providerUpdatedAt: paymentDisputes.providerUpdatedAt,
    providerVersion: paymentDisputes.providerVersion,
  }).from(payments)
    .innerJoin(paymentOperations, eq(paymentOperations.id, payments.paymentOperationId))
    .innerJoin(paymentDisputes, and(
      eq(paymentDisputes.paymentOperationId, paymentOperations.id),
      eq(paymentDisputes.organizationId, paymentOperations.organizationId),
    ))
    .where(and(
      inArray(payments.id, eligibleRows.map((row) => row.id)),
      input.organizationId === null
        ? undefined
        : eq(paymentOperations.organizationId, input.organizationId),
    ));

  if (disputeRows.length === 0) return new Map();
  const disputeOrganization = new Map(
    disputeRows.map((row) => [row.id, row.organizationId] as const),
  );
  const historyRows = await db.select({
    organizationId: paymentDisputeNotifications.organizationId,
    paymentDisputeId: paymentDisputeNotifications.paymentDisputeId,
    kind: paymentDisputeNotifications.kind,
    state: paymentDisputeNotifications.disputeState,
    providerVersion: paymentDisputeNotifications.providerVersion,
    recordedAt: paymentDisputeNotifications.createdAt,
  }).from(paymentDisputeNotifications).where(and(
    inArray(
      paymentDisputeNotifications.paymentDisputeId,
      Array.from(disputeOrganization.keys()),
    ),
    input.organizationId === null
      ? undefined
      : eq(paymentDisputeNotifications.organizationId, input.organizationId),
  )).orderBy(
    desc(paymentDisputeNotifications.providerVersion),
    desc(paymentDisputeNotifications.createdAt),
  );

  const historyByDispute = new Map<string, PaymentRowDisputeSummary["history"]>();
  for (const row of historyRows) {
    if (disputeOrganization.get(row.paymentDisputeId) !== row.organizationId) continue;
    const history = historyByDispute.get(row.paymentDisputeId) ?? [];
    history.push({
      kind: row.kind as PaymentRowDisputeSummary["history"][number]["kind"],
      state: row.state as PaymentRowDisputeSummary["history"][number]["state"],
      providerVersion: row.providerVersion,
      recordedAt: row.recordedAt,
    });
    historyByDispute.set(row.paymentDisputeId, history);
  }

  const result = new Map<number, PaymentRowDisputeSummary[]>();
  for (const row of disputeRows) {
    const summaries = result.get(row.paymentId) ?? [];
    summaries.push({
      id: row.id,
      providerDisputeId: row.providerDisputeId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      reason: row.reason as PaymentRowDisputeSummary["reason"],
      state: row.state as PaymentRowDisputeSummary["state"],
      responseDueAt: row.responseDueAt,
      providerUpdatedAt: row.providerUpdatedAt,
      providerVersion: row.providerVersion,
      sharedTransaction: false,
      history: historyByDispute.get(row.id) ?? [],
    });
    result.set(row.paymentId, summaries);
  }
  return result;
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
