import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import {
  emailDeliveryAlerts,
  type EmailDeliveryAlert,
  type InsertEmailDeliveryAlert,
} from "@shared/schema";
import type { EmailDeliveryAlertDto } from "@shared/email-delivery-alerts";
import { db } from "../db.js";

export const EMAIL_DELIVERY_ALERT_LIST_LIMIT = 50;

export interface IngestEmailDeliveryAlertInput {
  providerEventId: string;
  providerMessageId: string | null;
  recipientEmail: string;
  eventType: InsertEmailDeliveryAlert["eventType"];
  failureType: InsertEmailDeliveryAlert["failureType"];
  reasonCode: InsertEmailDeliveryAlert["reasonCode"];
  bounceClassification: InsertEmailDeliveryAlert["bounceClassification"];
  smtpStatus: string | null;
  sendingIp: string | null;
  providerEventAt: string;
  receivedAt?: Date;
}

export interface IngestEmailDeliveryAlertResult {
  alert?: EmailDeliveryAlert;
  duplicate: boolean;
}

/**
 * Store one authenticated provider failure. The provider event ID is the
 * durable idempotency key; retries and concurrent webhook deliveries return
 * the row that won the unique constraint without changing its evidence.
 */
export async function ingestEmailDeliveryAlert(
  input: IngestEmailDeliveryAlertInput,
): Promise<IngestEmailDeliveryAlertResult> {
  const values = {
    providerEventId: input.providerEventId,
    providerMessageId: input.providerMessageId,
    recipientEmail: input.recipientEmail,
    eventType: input.eventType,
    failureType: input.failureType,
    reasonCode: input.reasonCode,
    bounceClassification: input.bounceClassification,
    smtpStatus: input.smtpStatus,
    sendingIp: input.sendingIp,
    providerEventAt: input.providerEventAt,
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
  } satisfies Omit<InsertEmailDeliveryAlert, "acknowledgedAt" | "acknowledgedByUserId">;

  const [created] = await db
    .insert(emailDeliveryAlerts)
    .values(values)
    .onConflictDoNothing({ target: emailDeliveryAlerts.providerEventId })
    .returning();
  if (created) return { alert: created, duplicate: false };

  const [existing] = await db
    .select()
    .from(emailDeliveryAlerts)
    .where(eq(emailDeliveryAlerts.providerEventId, input.providerEventId))
    .limit(1);
  // A successful INSERT ... ON CONFLICT statement makes the conflicting row
  // visible to this transaction. Throwing here is a retryable persistence
  // failure rather than pretending an event was accepted without evidence.
  if (!existing) throw new Error("email delivery alert conflict row was not found");
  return { alert: existing, duplicate: true };
}

export interface ListEmailDeliveryAlertsOptions {
  /** Defaults to false: the operational feed is pending alerts. */
  acknowledged?: boolean;
  limit?: number;
}

export function clampEmailDeliveryAlertLimit(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit) || (limit ?? 0) <= 0) return EMAIL_DELIVERY_ALERT_LIST_LIMIT;
  return Math.min(limit as number, EMAIL_DELIVERY_ALERT_LIST_LIMIT);
}

export async function listEmailDeliveryAlerts(
  options: ListEmailDeliveryAlertsOptions = {},
): Promise<EmailDeliveryAlert[]> {
  const limit = clampEmailDeliveryAlertLimit(options.limit);
  const acknowledged = options.acknowledged === true;
  return db
    .select()
    .from(emailDeliveryAlerts)
    .where(acknowledged ? isNotNull(emailDeliveryAlerts.acknowledgedAt) : isNull(emailDeliveryAlerts.acknowledgedAt))
    .orderBy(desc(emailDeliveryAlerts.receivedAt), desc(emailDeliveryAlerts.id))
    .limit(limit);
}

export async function countUnacknowledgedEmailDeliveryAlerts(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailDeliveryAlerts)
    .where(isNull(emailDeliveryAlerts.acknowledgedAt));
  return row?.count ?? 0;
}

/** Acknowledge an alert as the authenticated system-admin actor. */
export async function acknowledgeEmailDeliveryAlert(
  id: number,
  acknowledgedByUserId: number,
  acknowledgedAt = new Date(),
): Promise<EmailDeliveryAlert | undefined> {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  if (!Number.isSafeInteger(acknowledgedByUserId) || acknowledgedByUserId <= 0) return undefined;

  const [updated] = await db
    .update(emailDeliveryAlerts)
    .set({
      acknowledgedAt: acknowledgedAt.toISOString(),
      acknowledgedByUserId,
    })
    .where(and(
      eq(emailDeliveryAlerts.id, id),
      isNull(emailDeliveryAlerts.acknowledgedAt),
    ))
    .returning();
  if (updated) return updated;

  // The update is intentionally idempotent. A concurrent or earlier ack is
  // already the desired state, so return that row to the route caller.
  const [existing] = await db
    .select()
    .from(emailDeliveryAlerts)
    .where(eq(emailDeliveryAlerts.id, id))
    .limit(1);
  return existing;
}

function timestampToIso(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(withZone);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

/** Explicit allowlist projection for the system-admin wire contract. */
export function toEmailDeliveryAlertDto(row: EmailDeliveryAlert): EmailDeliveryAlertDto {
  return {
    id: row.id,
    recipientEmail: row.recipientEmail,
    eventType: row.eventType,
    failureType: row.failureType,
    reasonCode: row.reasonCode as EmailDeliveryAlertDto["reasonCode"],
    bounceClassification: row.bounceClassification as EmailDeliveryAlertDto["bounceClassification"],
    smtpStatus: row.smtpStatus,
    sendingIp: row.sendingIp,
    providerEventAt: timestampToIso(row.providerEventAt),
    receivedAt: timestampToIso(row.receivedAt),
    acknowledgedAt: row.acknowledgedAt ? timestampToIso(row.acknowledgedAt) : null,
  };
}
