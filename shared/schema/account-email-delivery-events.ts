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
import { accountActionRequests } from "./account-action-requests";
import { accountActionDeliveryJobs } from "./account-action-delivery-jobs";

/**
 * SendGrid events that are useful for the account-action delivery lifecycle.
 * Engagement and subscription events deliberately do not enter this table.
 */
export const ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES = [
  "processed",
  "delivered",
  "deferred",
  "bounce",
  "dropped",
] as const;
export type AccountEmailDeliveryEventType =
  (typeof ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES)[number];

const eventTypeValues = sql.raw(
  ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES.map((value) => `'${value}'`).join(", "),
);

/**
 * Minimal, provider-neutral evidence for one accepted SendGrid delivery
 * event. The event payload, recipient address, token, and provider reason
 * text are intentionally not persisted. `sg_event_id` is the deduplication
 * key supplied by SendGrid; the action/job pair is the only application
 * correlation retained.
 */
export const accountEmailDeliveryEvents = pgTable("account_email_delivery_events", {
  id: serial("id").primaryKey(),
  providerEventId: varchar("provider_event_id", { length: 100 }).notNull(),
  providerMessageId: varchar("provider_message_id", { length: 255 }),
  accountActionId: integer("account_action_id")
    .notNull()
    .references(() => accountActionRequests.id, { onDelete: "cascade" }),
  accountDeliveryJobId: integer("account_delivery_job_id")
    .notNull()
    .references(() => accountActionDeliveryJobs.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES }).notNull(),
  providerEventAt: timestamp("provider_event_at", { mode: "string" }).notNull(),
  receivedAt: timestamp("received_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  providerEventUnique: uniqueIndex("account_email_delivery_events_provider_event_unique")
    .on(table.providerEventId),
  actionJobEventIdx: index("account_email_delivery_events_action_job_event_idx")
    .on(table.accountActionId, table.accountDeliveryJobId, table.providerEventAt),
  eventTypeCheck: check(
    "account_email_delivery_events_event_type_check",
    sql`${table.eventType} IN (${eventTypeValues})`,
  ),
  eventIdCheck: check(
    "account_email_delivery_events_provider_event_id_check",
    sql`${table.providerEventId} <> ''`,
  ),
}));

export const insertAccountEmailDeliveryEventSchema = createInsertSchema(accountEmailDeliveryEvents)
  .extend({
    providerEventId: z.string().min(1).max(100),
    providerMessageId: z.string().max(255).nullable().optional(),
    accountActionId: z.number().int().positive(),
    accountDeliveryJobId: z.number().int().positive(),
    eventType: z.enum(ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES),
    providerEventAt: z.union([z.string(), z.date()]).transform((value) =>
      typeof value === "string" ? value : value.toISOString(),
    ),
    receivedAt: z.union([z.string(), z.date()]).optional().transform((value) =>
      value === undefined ? undefined : typeof value === "string" ? value : value.toISOString(),
    ),
  })
  .omit({ id: true });

export type AccountEmailDeliveryEvent = typeof accountEmailDeliveryEvents.$inferSelect;
export type InsertAccountEmailDeliveryEvent = z.infer<typeof insertAccountEmailDeliveryEventSchema>;
