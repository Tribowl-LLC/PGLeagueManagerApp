import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "./locations";
import { organizations } from "./organizations";
import { paymentOperations } from "./payment-operations";
import { webhookEvents } from "./webhook-events";

export const PAYMENT_DISPUTE_STATES = [
  "INQUIRY_EVIDENCE_REQUIRED",
  "INQUIRY_PROCESSING",
  "INQUIRY_CLOSED",
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "WON",
  "LOST",
  "ACCEPTED",
] as const;

export const PAYMENT_DISPUTE_REASONS = [
  "AMOUNT_DIFFERS",
  "CANCELLED",
  "DUPLICATE",
  "NO_KNOWLEDGE",
  "NOT_AS_DESCRIBED",
  "NOT_RECEIVED",
  "PAID_BY_OTHER_MEANS",
  "CUSTOMER_REQUESTS_CREDIT",
  "EMV_LIABILITY_SHIFT",
] as const;

const stateValues = sql.raw(PAYMENT_DISPUTE_STATES.map((value) => `'${value}'`).join(", "));
const reasonValues = sql.raw(PAYMENT_DISPUTE_REASONS.map((value) => `'${value}'`).join(", "));

/**
 * Provider-level dispute state for one charge operation. This remains
 * independent from local allocation payment/refund status because a combined
 * charge can own many payment rows and a refund can coexist with a dispute.
 */
export const paymentDisputes = pgTable("payment_disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  paymentOperationId: uuid("payment_operation_id")
    .notNull()
    .references(() => paymentOperations.id, { onDelete: "restrict" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  providerApplicationId: varchar("provider_application_id", { length: 255 }).notNull(),
  providerMerchantId: varchar("provider_merchant_id", { length: 255 }).notNull(),
  providerLocationId: varchar("provider_location_id", { length: 255 }).notNull(),
  providerDisputeId: varchar("provider_dispute_id", { length: 255 }).notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  reason: varchar("reason", { length: 64 }).notNull(),
  state: varchar("state", { length: 64 }).notNull(),
  responseDueAt: timestamp("response_due_at", { mode: "string" }),
  cardBrand: varchar("card_brand", { length: 32 }),
  brandDisputeId: varchar("brand_dispute_id", { length: 255 }),
  providerCreatedAt: timestamp("provider_created_at", { mode: "string" }).notNull(),
  providerReportedAt: timestamp("provider_reported_at", { mode: "string" }),
  providerUpdatedAt: timestamp("provider_updated_at", { mode: "string" }).notNull(),
  providerVersion: integer("provider_version").notNull(),
  firstWebhookEventId: uuid("first_webhook_event_id")
    .notNull()
    .references(() => webhookEvents.id, { onDelete: "restrict" }),
  lastWebhookEventId: uuid("last_webhook_event_id")
    .notNull()
    .references(() => webhookEvents.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  providerDisputeUnique: uniqueIndex("payment_disputes_provider_dispute_unique")
    .on(table.provider, table.providerDisputeId),
  tenantUpdatedIdx: index("payment_disputes_tenant_updated_idx")
    .on(table.organizationId, table.updatedAt.desc()),
  tenantStateDueIdx: index("payment_disputes_tenant_state_due_idx")
    .on(table.organizationId, table.state, table.responseDueAt),
  operationIdx: index("payment_disputes_operation_idx").on(table.paymentOperationId),
  providerPaymentIdx: index("payment_disputes_provider_payment_idx")
    .on(table.provider, table.providerPaymentId),
  providerCheck: check("payment_disputes_provider_check", sql`${table.provider} = 'square'`),
  amountCheck: check("payment_disputes_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: check("payment_disputes_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  versionCheck: check("payment_disputes_version_check", sql`${table.providerVersion} > 0`),
  stateCheck: check("payment_disputes_state_check", sql`${table.state} IN (${stateValues})`),
  reasonCheck: check("payment_disputes_reason_check", sql`${table.reason} IN (${reasonValues})`),
}));

export type PaymentDispute = typeof paymentDisputes.$inferSelect;
export type PaymentDisputeState = (typeof PAYMENT_DISPUTE_STATES)[number];
export type PaymentDisputeReason = (typeof PAYMENT_DISPUTE_REASONS)[number];
