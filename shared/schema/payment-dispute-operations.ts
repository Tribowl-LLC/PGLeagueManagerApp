import { sql } from "drizzle-orm";
import {
  boolean,
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
import { paymentDisputes, PAYMENT_DISPUTE_STATES } from "./payment-disputes";
import { users } from "./users";
import { webhookEvents, WEBHOOK_EVENT_STATUSES } from "./webhook-events";

export const PAYMENT_DISPUTE_NOTIFICATION_KINDS = [
  "DISPUTE_CREATED",
  "DISPUTE_STATE_UPDATED",
] as const;

const notificationKinds = sql.raw(
  PAYMENT_DISPUTE_NOTIFICATION_KINDS.map((value) => `'${value}'`).join(", "),
);
const disputeStates = sql.raw(PAYMENT_DISPUTE_STATES.map((value) => `'${value}'`).join(", "));
const webhookStatuses = sql.raw(WEBHOOK_EVENT_STATUSES.map((value) => `'${value}'`).join(", "));

/**
 * Durable, provider-effect-free operational notice for one accepted dispute
 * version. Delivery is the tenant-safe read API. Phase 4B-3A joins these
 * immutable history rows to separate tenant-wide acknowledgements.
 */
export const paymentDisputeNotifications = pgTable("payment_dispute_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  paymentDisputeId: uuid("payment_dispute_id")
    .notNull()
    .references(() => paymentDisputes.id, { onDelete: "restrict" }),
  webhookEventId: uuid("webhook_event_id")
    .notNull()
    .references(() => webhookEvents.id, { onDelete: "restrict" }),
  kind: varchar("kind", { length: 48 }).notNull(),
  disputeState: varchar("dispute_state", { length: 64 }).notNull(),
  providerVersion: integer("provider_version").notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  disputeVersionUnique: uniqueIndex("payment_dispute_notifications_dispute_version_unique")
    .on(table.paymentDisputeId, table.providerVersion),
  tenantCreatedIdx: index("payment_dispute_notifications_tenant_created_idx")
    .on(table.organizationId, table.createdAt.desc(), table.id.desc()),
  locationCreatedIdx: index("payment_dispute_notifications_location_created_idx")
    .on(table.locationId, table.createdAt.desc()),
  kindCheck: check("payment_dispute_notifications_kind_check", sql`${table.kind} IN (${notificationKinds})`),
  stateCheck: check("payment_dispute_notifications_state_check", sql`${table.disputeState} IN (${disputeStates})`),
  versionCheck: check("payment_dispute_notifications_version_check", sql`${table.providerVersion} > 0`),
}));

/**
 * Immutable, tenant-wide acknowledgement of one exact provider dispute
 * version. A later provider version does not match this row and therefore
 * becomes unacknowledged automatically. Acknowledgement is operational
 * awareness only; it never represents a provider-side dispute action.
 */
export const paymentDisputeAcknowledgements = pgTable("payment_dispute_acknowledgements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  paymentDisputeId: uuid("payment_dispute_id")
    .notNull()
    .references(() => paymentDisputes.id, { onDelete: "restrict" }),
  providerVersion: integer("provider_version").notNull(),
  actorUserId: integer("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  actorRole: varchar("actor_role", { length: 32 }).notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  disputeVersionUnique: uniqueIndex("payment_dispute_acknowledgements_dispute_version_unique")
    .on(table.paymentDisputeId, table.providerVersion),
  tenantAcknowledgedIdx: index("payment_dispute_acknowledgements_tenant_acknowledged_idx")
    .on(table.organizationId, table.acknowledgedAt.desc(), table.id.desc()),
  actorAcknowledgedIdx: index("payment_dispute_acknowledgements_actor_acknowledged_idx")
    .on(table.actorUserId, table.acknowledgedAt.desc()),
  versionCheck: check(
    "payment_dispute_acknowledgements_version_check",
    sql`${table.providerVersion} > 0`,
  ),
  actorRoleCheck: check(
    "payment_dispute_acknowledgements_actor_role_check",
    sql`${table.actorRole} IN ('org_admin', 'system_admin')`,
  ),
}));

/** One immutable audit row for each authorized explicit event-ID replay. */
export const paymentDisputeReplayAudits = pgTable("payment_dispute_replay_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  webhookEventId: uuid("webhook_event_id")
    .notNull()
    .references(() => webhookEvents.id, { onDelete: "restrict" }),
  actorUserId: integer("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  actorRole: varchar("actor_role", { length: 32 }).notNull(),
  initialStatus: varchar("initial_status", { length: 32 }).notNull(),
  resultStatus: varchar("result_status", { length: 32 }).notNull(),
  resultCode: varchar("result_code", { length: 96 }),
  businessStateChanged: boolean("business_state_changed").notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  tenantCreatedIdx: index("payment_dispute_replay_audits_tenant_created_idx")
    .on(table.organizationId, table.createdAt.desc()),
  eventCreatedIdx: index("payment_dispute_replay_audits_event_created_idx")
    .on(table.webhookEventId, table.createdAt.desc()),
  actorCreatedIdx: index("payment_dispute_replay_audits_actor_created_idx")
    .on(table.actorUserId, table.createdAt.desc()),
  actorRoleCheck: check(
    "payment_dispute_replay_audits_actor_role_check",
    sql`${table.actorRole} IN ('org_admin', 'system_admin')`,
  ),
  initialStatusCheck: check(
    "payment_dispute_replay_audits_initial_status_check",
    sql`${table.initialStatus} IN (${webhookStatuses})`,
  ),
  resultStatusCheck: check(
    "payment_dispute_replay_audits_result_status_check",
    sql`${table.resultStatus} IN (${webhookStatuses})`,
  ),
  resultCodeCheck: check(
    "payment_dispute_replay_audits_result_code_check",
    sql`${table.resultCode} IS NULL OR ${table.resultCode} ~ '^[A-Z][A-Z0-9_]{0,95}$'`,
  ),
}));

export type PaymentDisputeNotification = typeof paymentDisputeNotifications.$inferSelect;
export type PaymentDisputeAcknowledgement = typeof paymentDisputeAcknowledgements.$inferSelect;
export type PaymentDisputeReplayAudit = typeof paymentDisputeReplayAudits.$inferSelect;
export type PaymentDisputeNotificationKind = (typeof PAYMENT_DISPUTE_NOTIFICATION_KINDS)[number];
