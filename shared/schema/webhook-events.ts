import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "./locations";
import { organizations } from "./organizations";

export const WEBHOOK_EVENT_STATUSES = [
  "pending",
  "processing",
  "retry_scheduled",
  "processed",
  "ignored",
  "failed",
] as const;

export const WEBHOOK_EVENT_ERROR_CLASSIFICATIONS = [
  "configuration",
  "mapping",
  "payload",
  "processing",
] as const;

export const WEBHOOK_EVENT_PAYLOAD_SCHEMA_VERSION = 1;
export const WEBHOOK_EVENT_MAX_ATTEMPTS = 20;
export const WEBHOOK_EVENT_MAX_LEASE_MS = 15 * 60_000;

const statusValues = sql.raw(WEBHOOK_EVENT_STATUSES.map((value) => `'${value}'`).join(", "));
const errorClassificationValues = sql.raw(
  WEBHOOK_EVENT_ERROR_CLASSIFICATIONS.map((value) => `'${value}'`).join(", "),
);

/**
 * Provider notifications are encrypted durable evidence, not a business-state
 * projection. Phase 4A-1 writes this table only after signature verification
 * and unique tenant/location resolution. No application worker claims rows in
 * this phase; the claim fields establish the fenced processing contract for a
 * later explicitly activated processor.
 */
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: varchar("provider", { length: 32 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
  eventType: varchar("event_type", { length: 128 }).notNull(),
  providerCreatedAt: timestamp("provider_created_at", { mode: "string" }).notNull(),
  receivedAt: timestamp("received_at", { mode: "string" }).notNull().defaultNow(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  providerApplicationId: varchar("provider_application_id", { length: 255 }).notNull(),
  providerMerchantId: varchar("provider_merchant_id", { length: 255 }).notNull(),
  providerLocationId: varchar("provider_location_id", { length: 255 }).notNull(),
  providerObjectType: varchar("provider_object_type", { length: 64 }).notNull(),
  providerObjectId: varchar("provider_object_id", { length: 255 }).notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }),
  providerObjectVersion: integer("provider_object_version"),
  providerObjectUpdatedAt: timestamp("provider_object_updated_at", { mode: "string" }),
  providerApiVersion: varchar("provider_api_version", { length: 10 }).notNull(),
  payloadSchemaVersion: integer("payload_schema_version")
    .notNull()
    .default(WEBHOOK_EVENT_PAYLOAD_SCHEMA_VERSION),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "string" }),
  errorClassification: varchar("error_classification", { length: 32 }),
  errorCode: varchar("error_code", { length: 96 }),
  processedAt: timestamp("processed_at", { mode: "string" }),
  completedAt: timestamp("completed_at", { mode: "string" }),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  providerEventUnique: uniqueIndex("webhook_events_provider_event_unique")
    .on(table.provider, table.providerEventId),
  organizationReceivedIdx: index("webhook_events_organization_received_idx")
    .on(table.organizationId, table.receivedAt),
  locationReceivedIdx: index("webhook_events_location_received_idx")
    .on(table.locationId, table.receivedAt),
  statusCheck: check(
    "webhook_events_status_check",
    sql`${table.status} IN (${statusValues})`,
  ),
  providerCheck: check(
    "webhook_events_provider_check",
    sql`${table.provider} = 'square'`,
  ),
  payloadVersionCheck: check(
    "webhook_events_payload_version_check",
    sql`${table.payloadSchemaVersion} = ${sql.raw(String(WEBHOOK_EVENT_PAYLOAD_SCHEMA_VERSION))}`,
  ),
  payloadHashCheck: check(
    "webhook_events_payload_hash_check",
    sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
  ),
  attemptsCheck: check(
    "webhook_events_attempts_check",
    sql`${table.attemptCount} BETWEEN 0 AND ${sql.raw(String(WEBHOOK_EVENT_MAX_ATTEMPTS))}`,
  ),
  objectVersionCheck: check(
    "webhook_events_object_version_check",
    sql`${table.providerObjectVersion} IS NULL OR ${table.providerObjectVersion} > 0`,
  ),
  leaseCheck: check(
    "webhook_events_lease_check",
    sql`(
      ${table.status} = 'processing'
      AND ${table.leaseOwner} IS NOT NULL
      AND ${table.leaseToken} IS NOT NULL
      AND ${table.leaseExpiresAt} IS NOT NULL
      AND ${table.nextAttemptAt} IS NULL
      AND ${table.completedAt} IS NULL
    ) OR (
      ${table.status} <> 'processing'
      AND ${table.leaseOwner} IS NULL
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
    )`,
  ),
  dueCheck: check(
    "webhook_events_due_check",
    sql`(
      ${table.status} = 'retry_scheduled'
      AND ${table.nextAttemptAt} IS NOT NULL
      AND ${table.completedAt} IS NULL
    ) OR (
      ${table.status} <> 'retry_scheduled'
      AND ${table.nextAttemptAt} IS NULL
    )`,
  ),
  terminalCheck: check(
    "webhook_events_terminal_check",
    sql`(
      ${table.status} IN ('processed', 'ignored', 'failed')
      AND ${table.processedAt} IS NOT NULL
      AND ${table.completedAt} IS NOT NULL
    ) OR (
      ${table.status} NOT IN ('processed', 'ignored', 'failed')
      AND ${table.completedAt} IS NULL
    )`,
  ),
  errorCheck: check(
    "webhook_events_error_check",
    sql`(
      ${table.errorClassification} IS NULL
      AND ${table.errorCode} IS NULL
    ) OR (
      ${table.errorClassification} IN (${errorClassificationValues})
      AND ${table.errorCode} ~ '^[A-Z][A-Z0-9_]{0,95}$'
    )`,
  ),
}));

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];
export type WebhookEventErrorClassification =
  (typeof WEBHOOK_EVENT_ERROR_CLASSIFICATIONS)[number];
