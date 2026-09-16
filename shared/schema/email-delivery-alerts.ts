import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./users";
import { emailSchema } from "./constants";

/** SendGrid failure events that can be shown in the system-admin alert feed. */
export const EMAIL_DELIVERY_ALERT_EVENT_TYPES = ["bounce", "dropped"] as const;
export type EmailDeliveryAlertEventType = (typeof EMAIL_DELIVERY_ALERT_EVENT_TYPES)[number];

/** Failure classes are deliberately provider-neutral and small. */
export const EMAIL_DELIVERY_ALERT_FAILURE_TYPES = ["blocked", "bounce", "dropped"] as const;
export type EmailDeliveryAlertFailureType = (typeof EMAIL_DELIVERY_ALERT_FAILURE_TYPES)[number];

/** Safe reason identifiers exposed to the system-admin UI. */
export const EMAIL_DELIVERY_ALERT_REASON_CODES = [
  "sending_ip_blocklisted",
  "recipient_address_invalid",
  "mailbox_full",
  "policy_rejection",
  "temporary_failure",
  "provider_dropped",
  "unknown_failure",
] as const;
export type EmailDeliveryAlertReasonCode = (typeof EMAIL_DELIVERY_ALERT_REASON_CODES)[number];

/** SendGrid's documented bounce classifications, normalized to stable keys. */
export const EMAIL_DELIVERY_ALERT_BOUNCE_CLASSIFICATIONS = [
  "invalid_address",
  "technical",
  "content",
  "reputation",
  "mailbox_unavailable",
  "frequency_volume",
  "unclassified",
] as const;
export type EmailDeliveryAlertBounceClassification =
  (typeof EMAIL_DELIVERY_ALERT_BOUNCE_CLASSIFICATIONS)[number];

const eventTypeValues = sql.raw(EMAIL_DELIVERY_ALERT_EVENT_TYPES.map((value) => `'${value}'`).join(", "));
const failureTypeValues = sql.raw(EMAIL_DELIVERY_ALERT_FAILURE_TYPES.map((value) => `'${value}'`).join(", "));
const reasonCodeValues = sql.raw(EMAIL_DELIVERY_ALERT_REASON_CODES.map((value) => `'${value}'`).join(", "));
const classificationValues = sql.raw(
  EMAIL_DELIVERY_ALERT_BOUNCE_CLASSIFICATIONS.map((value) => `'${value}'`).join(", "),
);

/**
 * Minimal, provider-neutral operational evidence for a failed email.
 *
 * This table intentionally has no organization or user correlation. A
 * provider failure can occur before an application correlation exists, so
 * exposing it through a tenant-scoped path would invite incorrect mapping.
 * Provider reason text, request bodies, URLs, and credentials are never
 * persisted; `reasonCode` is derived from a small allowlist.
 */
export const emailDeliveryAlerts = pgTable("email_delivery_alerts", {
  id: serial("id").primaryKey(),
  providerEventId: varchar("provider_event_id", { length: 100 }).notNull(),
  providerMessageId: varchar("provider_message_id", { length: 255 }),
  recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
  eventType: text("event_type", { enum: EMAIL_DELIVERY_ALERT_EVENT_TYPES }).notNull(),
  failureType: text("failure_type", { enum: EMAIL_DELIVERY_ALERT_FAILURE_TYPES }).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }).notNull(),
  bounceClassification: varchar("bounce_classification", { length: 32 }),
  smtpStatus: varchar("smtp_status", { length: 32 }),
  sendingIp: varchar("sending_ip", { length: 45 }),
  providerEventAt: timestamp("provider_event_at", { mode: "string" }).notNull(),
  receivedAt: timestamp("received_at", { mode: "string" }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "string" }),
  acknowledgedByUserId: integer("acknowledged_by_user_id")
    .references(() => users.id, { onDelete: "set null" }),
}, (table) => ({
  providerEventUnique: uniqueIndex("email_delivery_alerts_provider_event_unique")
    .on(table.providerEventId),
  receivedAtIdx: index("email_delivery_alerts_received_at_idx")
    .on(table.receivedAt, table.id),
  acknowledgementIdx: index("email_delivery_alerts_acknowledgement_idx")
    .on(table.acknowledgedAt, table.receivedAt, table.id),
  providerEventIdCheck: check(
    "email_delivery_alerts_provider_event_id_check",
    sql`${table.providerEventId} <> ''`,
  ),
  recipientEmailCheck: check(
    "email_delivery_alerts_recipient_email_check",
    sql`${table.recipientEmail} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`,
  ),
  eventTypeCheck: check(
    "email_delivery_alerts_event_type_check",
    sql`${table.eventType} IN (${eventTypeValues})`,
  ),
  failureTypeCheck: check(
    "email_delivery_alerts_failure_type_check",
    sql`${table.failureType} IN (${failureTypeValues})`,
  ),
  reasonCodeCheck: check(
    "email_delivery_alerts_reason_code_check",
    sql`${table.reasonCode} IN (${reasonCodeValues})`,
  ),
  bounceClassificationCheck: check(
    "email_delivery_alerts_bounce_classification_check",
    sql`${table.bounceClassification} IS NULL OR ${table.bounceClassification} IN (${classificationValues})`,
  ),
  smtpStatusCheck: check(
    "email_delivery_alerts_smtp_status_check",
    sql`${table.smtpStatus} IS NULL OR ${table.smtpStatus} ~ '^([2-5][0-9]{2}|[2-5][.][0-9]{1,3}[.][0-9]{1,3})$'`,
  ),
  sendingIpCheck: check(
    "email_delivery_alerts_sending_ip_check",
    sql`${table.sendingIp} IS NULL OR length(${table.sendingIp}) BETWEEN 2 AND 45`,
  ),
}));

export const insertEmailDeliveryAlertSchema = createInsertSchema(emailDeliveryAlerts)
  .extend({
    providerEventId: z.string().trim().min(1).max(100),
    providerMessageId: z.string().trim().max(255).nullable().optional(),
    recipientEmail: emailSchema.trim().max(320),
    eventType: z.enum(EMAIL_DELIVERY_ALERT_EVENT_TYPES),
    failureType: z.enum(EMAIL_DELIVERY_ALERT_FAILURE_TYPES),
    reasonCode: z.enum(EMAIL_DELIVERY_ALERT_REASON_CODES),
    bounceClassification: z.enum(EMAIL_DELIVERY_ALERT_BOUNCE_CLASSIFICATIONS).nullable().optional(),
    smtpStatus: z.string().regex(/^(?:[2-5]\d{2}|[2-5][.]\d{1,3}[.]\d{1,3})$/).max(32).nullable().optional(),
    sendingIp: z.string().trim().max(45).nullable().optional(),
    providerEventAt: z.union([z.string(), z.date()]).transform((value) =>
      typeof value === "string" ? value : value.toISOString(),
    ),
    receivedAt: z.union([z.string(), z.date()]).optional().transform((value) =>
      value === undefined ? undefined : typeof value === "string" ? value : value.toISOString(),
    ),
    acknowledgedAt: z.union([z.string(), z.date()]).nullable().optional().transform((value) =>
      value === undefined || value === null ? value : typeof value === "string" ? value : value.toISOString(),
    ),
    acknowledgedByUserId: z.number().int().positive().nullable().optional(),
  })
  .omit({ id: true });

export type EmailDeliveryAlert = typeof emailDeliveryAlerts.$inferSelect;
export type InsertEmailDeliveryAlert = z.infer<typeof insertEmailDeliveryAlertSchema>;
