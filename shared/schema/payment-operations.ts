import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  index,
  integer,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { bowlers } from "./bowlers";
import { leagues } from "./leagues";
import { locations } from "./locations";
import { paymentSchedules } from "./payments";
import { users } from "./users";

export const PAYMENT_OPERATION_TYPES = [
  "scheduled_charge",
  "interactive_charge",
  "refund",
] as const;
export type PaymentOperationType = (typeof PAYMENT_OPERATION_TYPES)[number];

export const PAYMENT_OPERATION_STATUSES = [
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "succeeded",
  "action_required",
  "reconciliation_required",
  "failed_terminal",
  "canceled",
] as const;
export type PaymentOperationStatus = (typeof PAYMENT_OPERATION_STATUSES)[number];

export const PAYMENT_OPERATION_ERROR_CLASSIFICATIONS = [
  "provider_unknown",
  "transient",
  "hard_decline",
  "configuration",
  "invalid_request",
  "internal",
] as const;
export type PaymentOperationErrorClassification =
  (typeof PAYMENT_OPERATION_ERROR_CLASSIFICATIONS)[number];

export const PAYMENT_OPERATION_MAX_ATTEMPTS = 8;
export const PAYMENT_OPERATION_MAX_LEASE_MS = 15 * 60 * 1000;
export const PAYMENT_OPERATION_MAX_RETRY_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

const terminalStatuses = sql.raw("'succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled'");
const dueStatuses = sql.raw("'pending', 'provider_unknown', 'retry_scheduled'");
const errorStatuses = sql.raw("'provider_unknown', 'retry_scheduled', 'action_required', 'reconciliation_required', 'failed_terminal'");

/**
 * Durable identity and state for one logical provider-side money movement.
 *
 * Phase 2A intentionally leaves this table dormant. Existing charge and
 * refund paths continue writing only `payments`; later phases will create a
 * row here before any provider request and use its stable idempotency key on
 * every attempt.
 */
export const paymentOperations = pgTable("payment_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  operationType: text("operation_type", { enum: PAYMENT_OPERATION_TYPES }).notNull(),
  targetKey: varchar("target_key", { length: 128 }).notNull(),
  paymentScheduleId: integer("payment_schedule_id")
    .references(() => paymentSchedules.id, { onDelete: "restrict" }),
  billingCycleAt: timestamp("billing_cycle_at", { mode: "string" }),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 76 }).notNull(),
  providerIdempotencyKey: varchar("provider_idempotency_key", { length: 45 }).notNull(),
  providerName: varchar("provider_name", { length: 32 }).notNull(),
  providerObjectId: varchar("provider_object_id", { length: 255 }),
  providerOrderId: varchar("provider_order_id", { length: 255 }),
  status: text("status", { enum: PAYMENT_OPERATION_STATUSES }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).defaultNow(),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "string" }),
  leaseRecoveryCount: integer("lease_recovery_count").notNull().default(0),
  lastLeaseRecoveredAt: timestamp("last_lease_recovered_at", { mode: "string" }),
  errorClassification: text("error_classification", {
    enum: PAYMENT_OPERATION_ERROR_CLASSIFICATIONS,
  }),
  errorCode: varchar("error_code", { length: 128 }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { mode: "string" }),
  completedAt: timestamp("completed_at", { mode: "string" }),
}, (table) => ({
  providerIdempotencyUnique: uniqueIndex("payment_operations_provider_idempotency_key_unique")
    .on(table.providerIdempotencyKey),
  recurringCycleUnique: uniqueIndex("payment_operations_recurring_cycle_unique")
    .on(table.paymentScheduleId, table.billingCycleAt)
    .where(sql`${table.operationType} = 'scheduled_charge'`),
  interactiveTargetUnique: uniqueIndex("payment_operations_interactive_target_unique")
    .on(table.organizationId, table.targetKey)
    .where(sql`${table.operationType} = 'interactive_charge'`),
  tenantLookupIdx: index("payment_operations_tenant_created_idx")
    .on(table.organizationId, table.createdAt.desc()),
  providerObjectLookupIdx: index("payment_operations_provider_object_idx")
    .on(table.providerName, table.providerObjectId)
    .where(sql`${table.providerObjectId} IS NOT NULL`),
  dueRetryIdx: index("payment_operations_due_retry_idx")
    .on(table.nextAttemptAt)
    .where(sql`${table.status} IN (${dueStatuses})`),
  expiredLeaseIdx: index("payment_operations_expired_lease_idx")
    .on(table.leaseExpiresAt)
    .where(sql`${table.status} = 'leased'`),
  operationTypeCheck: check(
    "payment_operations_operation_type_check",
    sql`${table.operationType} IN ('scheduled_charge', 'interactive_charge', 'refund')`,
  ),
  statusCheck: check(
    "payment_operations_status_check",
    sql`${table.status} IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled')`,
  ),
  amountCheck: check("payment_operations_amount_minor_check", sql`${table.amountMinor} > 0`),
  currencyCheck: check("payment_operations_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  targetKeyCheck: check("payment_operations_target_key_check", sql`length(${table.targetKey}) > 0`),
  providerNameCheck: check(
    "payment_operations_provider_name_check",
    sql`${table.providerName} ~ '^[a-z0-9][a-z0-9_-]{0,31}$'`,
  ),
  requestFingerprintCheck: check(
    "payment_operations_request_fingerprint_check",
    sql`${table.requestFingerprint} ~ '^lvpayreq:v1:[0-9a-f]{64}$'`,
  ),
  providerKeyCheck: check(
    "payment_operations_provider_key_check",
    sql`length(${table.providerIdempotencyKey}) BETWEEN 1 AND 45`,
  ),
  attemptCountCheck: check(
    "payment_operations_attempt_count_check",
    sql`${table.attemptCount} BETWEEN 0 AND ${sql.raw(String(PAYMENT_OPERATION_MAX_ATTEMPTS))}`,
  ),
  leaseRecoveryCountCheck: check(
    "payment_operations_lease_recovery_count_check",
    sql`${table.leaseRecoveryCount} >= 0`,
  ),
  scheduledCycleCheck: check(
    "payment_operations_scheduled_cycle_check",
    sql`(
      ${table.operationType} = 'scheduled_charge'
      AND ${table.paymentScheduleId} IS NOT NULL
      AND ${table.billingCycleAt} IS NOT NULL
    ) OR (
      ${table.operationType} <> 'scheduled_charge'
      AND ${table.billingCycleAt} IS NULL
    )`,
  ),
  dueStateCheck: check(
    "payment_operations_due_state_check",
    sql`(${table.status} IN (${dueStatuses})) = (${table.nextAttemptAt} IS NOT NULL)`,
  ),
  leaseStateCheck: check(
    "payment_operations_lease_state_check",
    sql`(
      ${table.status} = 'leased'
      AND ${table.leaseOwner} IS NOT NULL
      AND ${table.leaseToken} IS NOT NULL
      AND ${table.leaseExpiresAt} IS NOT NULL
    ) OR (
      ${table.status} <> 'leased'
      AND ${table.leaseOwner} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
    )`,
  ),
  nonterminalLeaseTokenCheck: check(
    "payment_operations_nonterminal_lease_token_check",
    sql`${table.status} IN ('leased', 'succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled') OR ${table.leaseToken} IS NULL`,
  ),
  completionStateCheck: check(
    "payment_operations_completion_state_check",
    sql`(${table.status} IN (${terminalStatuses})) = (${table.completedAt} IS NOT NULL)`,
  ),
  errorStateCheck: check(
    "payment_operations_error_state_check",
    sql`(
      ${table.status} IN (${errorStatuses})
      AND ${table.errorClassification} IS NOT NULL
    ) OR (
      ${table.status} NOT IN (${errorStatuses})
      AND ${table.errorClassification} IS NULL
      AND ${table.errorCode} IS NULL
    )`,
  ),
  errorClassificationCheck: check(
    "payment_operations_error_classification_check",
    sql`${table.errorClassification} IS NULL OR ${table.errorClassification} IN ('provider_unknown', 'transient', 'hard_decline', 'configuration', 'invalid_request', 'internal')`,
  ),
  errorCodeCheck: check(
    "payment_operations_error_code_check",
    sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[A-Z0-9][A-Z0-9_.:-]{0,127}$'`,
  ),
  startedAttemptCheck: check(
    "payment_operations_started_attempt_check",
    sql`(${table.attemptCount} = 0 AND ${table.startedAt} IS NULL) OR (${table.attemptCount} > 0 AND ${table.startedAt} IS NOT NULL)`,
  ),
  successProviderObjectCheck: check(
    "payment_operations_success_provider_object_check",
    sql`${table.status} <> 'succeeded' OR ${table.providerObjectId} IS NOT NULL`,
  ),
  timestampOrderCheck: check(
    "payment_operations_timestamp_order_check",
    sql`${table.updatedAt} >= ${table.createdAt}
      AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})
      AND (${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})
      AND (${table.leaseExpiresAt} IS NULL OR ${table.leaseExpiresAt} > ${table.updatedAt})`,
  ),
}));

export const SCHEDULED_PAYMENT_SNAPSHOT_VERSION = 1;
export const SCHEDULED_PAYMENT_REQUEST_KINDS = ["direct", "order"] as const;
export type ScheduledPaymentRequestKind = (typeof SCHEDULED_PAYMENT_REQUEST_KINDS)[number];

/**
 * Immutable, encrypted execution material for a Phase 2B scheduled charge.
 * Provider source/customer/email references are ciphertext; credentials and
 * raw provider payloads never belong here.
 */
export const scheduledPaymentOperationSnapshots = pgTable("scheduled_payment_operation_snapshots", {
  operationId: uuid("operation_id")
    .primaryKey()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  snapshotVersion: integer("snapshot_version").notNull().default(SCHEDULED_PAYMENT_SNAPSHOT_VERSION),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 80 }).notNull(),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id, { onDelete: "restrict" }),
  locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
  providerLocationId: varchar("provider_location_id", { length: 255 }),
  requestKind: text("request_kind", { enum: SCHEDULED_PAYMENT_REQUEST_KINDS }).notNull(),
  encryptedSourceId: text("encrypted_source_id").notNull(),
  encryptedCustomerId: text("encrypted_customer_id"),
  encryptedBuyerEmail: text("encrypted_buyer_email"),
  isDoublePay: boolean("is_double_pay").notNull().default(false),
  deactivateScheduleOnPreparation: boolean("deactivate_schedule_on_preparation").notNull().default(false),
  paidInFullThresholdAmountMinor: integer("paid_in_full_threshold_amount_minor"),
  seasonStartAt: timestamp("season_start_at", { mode: "string" }),
  seasonEndAt: timestamp("season_end_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  tenantLocationIdx: index("scheduled_payment_snapshots_location_idx").on(table.locationId),
  leagueIdx: index("scheduled_payment_snapshots_league_idx").on(table.leagueId),
  snapshotVersionCheck: check(
    "scheduled_payment_snapshots_version_check",
    sql`${table.snapshotVersion} = ${sql.raw(String(SCHEDULED_PAYMENT_SNAPSHOT_VERSION))}`,
  ),
  snapshotFingerprintCheck: check(
    "scheduled_payment_snapshots_fingerprint_check",
    sql`${table.snapshotFingerprint} ~ '^lvpayexec:v1:[0-9a-f]{64}$'`,
  ),
  requestKindCheck: check(
    "scheduled_payment_snapshots_request_kind_check",
    sql`${table.requestKind} IN ('direct', 'order')`,
  ),
  paidInFullCheck: check(
    "scheduled_payment_snapshots_paid_in_full_check",
    sql`${table.paidInFullThresholdAmountMinor} IS NULL OR ${table.paidInFullThresholdAmountMinor} > 0`,
  ),
  seasonRangeCheck: check(
    "scheduled_payment_snapshots_season_range_check",
    sql`(${table.seasonStartAt} IS NULL AND ${table.seasonEndAt} IS NULL)
      OR (${table.seasonStartAt} IS NOT NULL AND ${table.seasonEndAt} IS NOT NULL AND ${table.seasonEndAt} > ${table.seasonStartAt})`,
  ),
}));

export const scheduledPaymentOperationAllocations = pgTable("scheduled_payment_operation_allocations", {
  operationId: uuid("operation_id")
    .notNull()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  allocationIndex: integer("allocation_index").notNull(),
  bowlerId: integer("bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: "restrict" }),
  amountMinor: integer("amount_minor").notNull(),
  lineageAmountMinor: integer("lineage_amount_minor"),
  prizeFundAmountMinor: integer("prize_fund_amount_minor"),
  notes: text("notes"),
  paidByUserId: integer("paid_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (table) => ({
  pk: primaryKey({
    name: "scheduled_payment_operation_allocations_pk",
    columns: [table.operationId, table.allocationIndex],
  }),
  operationBowlerUnique: uniqueIndex("scheduled_payment_operation_allocations_bowler_unique")
    .on(table.operationId, table.bowlerId),
  amountCheck: check(
    "scheduled_payment_operation_allocations_amount_check",
    sql`${table.allocationIndex} >= 0 AND ${table.amountMinor} > 0
      AND (${table.lineageAmountMinor} IS NULL OR ${table.lineageAmountMinor} >= 0)
      AND (${table.prizeFundAmountMinor} IS NULL OR ${table.prizeFundAmountMinor} >= 0)`,
  ),
}));

export const scheduledPaymentOperationLineItems = pgTable("scheduled_payment_operation_line_items", {
  operationId: uuid("operation_id")
    .notNull()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  lineItemIndex: integer("line_item_index").notNull(),
  catalogObjectId: varchar("catalog_object_id", { length: 255 }).notNull(),
  quantity: varchar("quantity", { length: 32 }).notNull(),
}, (table) => ({
  pk: primaryKey({
    name: "scheduled_payment_operation_line_items_pk",
    columns: [table.operationId, table.lineItemIndex],
  }),
  valueCheck: check(
    "scheduled_payment_operation_line_items_value_check",
    sql`${table.lineItemIndex} >= 0
      AND length(${table.catalogObjectId}) > 0
      AND ${table.quantity} ~ '^[1-9][0-9]*$'`,
  ),
}));

export const INTERACTIVE_PAYMENT_SNAPSHOT_VERSION = 1;
export const INTERACTIVE_PAYMENT_REQUEST_KINDS = ["direct", "order"] as const;
export type InteractivePaymentRequestKind = (typeof INTERACTIVE_PAYMENT_REQUEST_KINDS)[number];

/**
 * Immutable, encrypted execution material for a general interactive charge.
 * This is intentionally separate from scheduled snapshots and auto-pay setup
 * requests: an interactive charge has no schedule cursor or setup workflow.
 * The migration adds a deferred database constraint trigger so allocation
 * rows must sum to the parent payment operation amount at commit time.
 */
export const interactivePaymentOperationSnapshots = pgTable("interactive_payment_operation_snapshots", {
  operationId: uuid("operation_id")
    .primaryKey()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  snapshotVersion: integer("snapshot_version").notNull().default(INTERACTIVE_PAYMENT_SNAPSHOT_VERSION),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 80 }).notNull(),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id, { onDelete: "restrict" }),
  locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
  providerLocationId: varchar("provider_location_id", { length: 255 }),
  payerBowlerId: integer("payer_bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: "restrict" }),
  requestKind: text("request_kind", { enum: INTERACTIVE_PAYMENT_REQUEST_KINDS }).notNull(),
  encryptedSourceId: text("encrypted_source_id").notNull(),
  encryptedCustomerId: text("encrypted_customer_id"),
  encryptedBuyerEmail: text("encrypted_buyer_email"),
  storeCard: boolean("store_card").notNull().default(false),
  weekOf: timestamp("week_of", { mode: "string" }).notNull(),
  combinedChargeGroupId: varchar("combined_charge_group_id", { length: 128 }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueIdx: index("interactive_payment_snapshots_league_idx").on(table.leagueId),
  payerIdx: index("interactive_payment_snapshots_payer_idx").on(table.payerBowlerId),
  snapshotVersionCheck: check(
    "interactive_payment_snapshots_version_check",
    sql`${table.snapshotVersion} = ${sql.raw(String(INTERACTIVE_PAYMENT_SNAPSHOT_VERSION))}`,
  ),
  snapshotFingerprintCheck: check(
    "interactive_payment_snapshots_fingerprint_check",
    sql`${table.snapshotFingerprint} ~ '^lvpayexecic:v1:[0-9a-f]{64}$'`,
  ),
  requestKindCheck: check(
    "interactive_payment_snapshots_request_kind_check",
    sql`${table.requestKind} IN ('direct', 'order')`,
  ),
  groupIdCheck: check(
    "interactive_payment_snapshots_group_id_check",
    sql`${table.combinedChargeGroupId} IS NULL OR length(${table.combinedChargeGroupId}) > 0`,
  ),
}));

export const interactivePaymentOperationAllocations = pgTable("interactive_payment_operation_allocations", {
  operationId: uuid("operation_id")
    .notNull()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  allocationIndex: integer("allocation_index").notNull(),
  bowlerId: integer("bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: "restrict" }),
  amountMinor: integer("amount_minor").notNull(),
  lineageAmountMinor: integer("lineage_amount_minor"),
  prizeFundAmountMinor: integer("prize_fund_amount_minor"),
  weekOf: timestamp("week_of", { mode: "string" }).notNull(),
  notes: text("notes"),
  paidByUserId: integer("paid_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (table) => ({
  pk: primaryKey({
    name: "interactive_payment_operation_allocations_pk",
    columns: [table.operationId, table.allocationIndex],
  }),
  operationBowlerUnique: uniqueIndex("interactive_payment_operation_allocations_bowler_unique")
    .on(table.operationId, table.bowlerId),
  amountCheck: check(
    "interactive_payment_operation_allocations_amount_check",
    sql`${table.allocationIndex} >= 0 AND ${table.amountMinor} > 0
      AND (${table.lineageAmountMinor} IS NULL OR ${table.lineageAmountMinor} >= 0)
      AND (${table.prizeFundAmountMinor} IS NULL OR ${table.prizeFundAmountMinor} >= 0)`,
  ),
}));

export const interactivePaymentOperationLineItems = pgTable("interactive_payment_operation_line_items", {
  operationId: uuid("operation_id")
    .notNull()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  lineItemIndex: integer("line_item_index").notNull(),
  catalogObjectId: varchar("catalog_object_id", { length: 255 }).notNull(),
  quantity: varchar("quantity", { length: 32 }).notNull(),
}, (table) => ({
  pk: primaryKey({
    name: "interactive_payment_operation_line_items_pk",
    columns: [table.operationId, table.lineItemIndex],
  }),
  valueCheck: check(
    "interactive_payment_operation_line_items_value_check",
    sql`${table.lineItemIndex} >= 0
      AND length(${table.catalogObjectId}) > 0
      AND ${table.quantity} ~ '^[1-9][0-9]*$'`,
  ),
}));

export type PaymentOperation = typeof paymentOperations.$inferSelect;
export type InsertPaymentOperation = typeof paymentOperations.$inferInsert;
export type ScheduledPaymentOperationSnapshot = typeof scheduledPaymentOperationSnapshots.$inferSelect;
export type ScheduledPaymentOperationAllocation = typeof scheduledPaymentOperationAllocations.$inferSelect;
export type ScheduledPaymentOperationLineItem = typeof scheduledPaymentOperationLineItems.$inferSelect;
export type InteractivePaymentOperationSnapshot = typeof interactivePaymentOperationSnapshots.$inferSelect;
export type InteractivePaymentOperationAllocation = typeof interactivePaymentOperationAllocations.$inferSelect;
export type InteractivePaymentOperationLineItem = typeof interactivePaymentOperationLineItems.$inferSelect;
