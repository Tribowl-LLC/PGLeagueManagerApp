import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  foreignKey,
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
import { payments, paymentSchedules } from "./payments";
import { users } from "./users";
import { leagueOccurrences } from "./canonical-occurrences";

export const PAYMENT_OPERATION_TYPES = [
  "scheduled_charge",
  "interactive_charge",
  "refund",
  "canonical_autopay_charge",
  "standing_autopay_charge",
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

export const INTERACTIVE_CARD_SAVE_STATUSES = [
  "pending",
  "saved",
  "failed",
  "not_available",
] as const;
export type InteractiveCardSaveStatus = (typeof INTERACTIVE_CARD_SAVE_STATUSES)[number];

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
  // Frozen actor evidence for interactive intent. Nullable preserves exact
  // recovery semantics for pre-F2 rows; new F2 preparation always supplies it.
  authorizingUserId: integer("authorizing_user_id")
    .references(() => users.id, { onDelete: "restrict" }),
  operationType: text("operation_type", { enum: PAYMENT_OPERATION_TYPES }).notNull(),
  targetKey: varchar("target_key", { length: 128 }).notNull(),
  paymentScheduleId: integer("payment_schedule_id")
    .references(() => paymentSchedules.id, { onDelete: "restrict" }),
  billingCycleAt: timestamp("billing_cycle_at", { mode: "string" }),
  triggerOccurrenceId: uuid("trigger_occurrence_id"),
  // F4 linkage is nullable for all pre-F4 operations.  The composite
  // references below make a canonical operation impossible to point at a
  // plan in another tenant or league.
  leagueId: integer("league_id"),
  canonicalPlanId: uuid("canonical_plan_id"),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 76 }).notNull(),
  providerIdempotencyKey: varchar("provider_idempotency_key", { length: 45 }).notNull(),
  providerName: varchar("provider_name", { length: 32 }).notNull(),
  providerObjectId: varchar("provider_object_id", { length: 255 }),
  providerOrderId: varchar("provider_order_id", { length: 255 }),
  // These fields record the optional pre-charge card-vault side effect for a
  // general interactive charge. They are deliberately on the sole provider
  // operation ledger rather than in a second vault ledger.
  cardSaveStatus: text("card_save_status", { enum: INTERACTIVE_CARD_SAVE_STATUSES }),
  cardSaveProviderIdempotencyKey: varchar("card_save_provider_idempotency_key", { length: 45 }),
  encryptedSavedCardId: text("encrypted_saved_card_id"),
  cardSaveErrorCode: varchar("card_save_error_code", { length: 128 }),
  cardSaveCompletedAt: timestamp("card_save_completed_at", { mode: "string" }),
  status: text("status", { enum: PAYMENT_OPERATION_STATUSES }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).defaultNow(),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "string" }),
  // Set atomically under the org/league serialization lock immediately
  // before provider dispatch.  A non-null value means revoke may not cancel
  // this exact in-flight attempt, but still blocks later plans.
  dispatchClaimedAt: timestamp("dispatch_claimed_at", { mode: "string" }),
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
  tenantCurrencyReferenceUnique: uniqueIndex("payment_operations_tenant_currency_reference_unique")
    .on(table.id, table.organizationId, table.currency),
  tenantIdentityUnique: uniqueIndex("payment_operations_tenant_identity_unique")
    .on(table.id, table.organizationId),
  providerIdempotencyUnique: uniqueIndex("payment_operations_provider_idempotency_key_unique")
    .on(table.providerIdempotencyKey),
  recurringCycleUnique: uniqueIndex("payment_operations_recurring_cycle_unique")
    .on(table.paymentScheduleId, table.billingCycleAt)
    .where(sql`${table.operationType} = 'scheduled_charge'`),
  interactiveTargetUnique: uniqueIndex("payment_operations_interactive_target_unique")
    .on(table.organizationId, table.targetKey)
    .where(sql`${table.operationType} = 'interactive_charge'`),
  standingAutopayTargetUnique: uniqueIndex("payment_operations_standing_autopay_target_unique")
    .on(table.organizationId, table.targetKey)
    .where(sql`${table.operationType} = 'standing_autopay_charge'`),
  tenantLeagueIdentityUnique: uniqueIndex("payment_operations_id_org_league_unique")
    .on(table.id, table.organizationId, table.leagueId),
  refundTargetUnique: uniqueIndex("payment_operations_refund_target_unique")
    .on(table.organizationId, table.targetKey)
    .where(sql`${table.operationType} = 'refund'`),
  tenantLookupIdx: index("payment_operations_tenant_created_idx")
    .on(table.organizationId, table.createdAt.desc()),
  authorizingUserIdx: index("payment_operations_authorizing_user_idx")
    .on(table.organizationId, table.authorizingUserId),
  providerObjectLookupIdx: index("payment_operations_provider_object_idx")
    .on(table.providerName, table.providerObjectId)
    .where(sql`${table.providerObjectId} IS NOT NULL`),
  dueRetryIdx: index("payment_operations_due_retry_idx")
    .on(table.nextAttemptAt)
    .where(sql`${table.status} IN (${dueStatuses})`),
  expiredLeaseIdx: index("payment_operations_expired_lease_idx")
    .on(table.leaseExpiresAt)
    .where(sql`${table.status} = 'leased'`),
  triggerOccurrenceIdx: index("payment_operations_trigger_occurrence_idx")
    .on(table.triggerOccurrenceId),
  leagueTenantFk: foreignKey({
    name: "payment_operations_league_tenant_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  triggerOccurrenceTenantFk: foreignKey({
    name: "payment_operations_trigger_occurrence_tenant_fk",
    columns: [table.triggerOccurrenceId, table.organizationId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId],
  }).onDelete("restrict"),
  triggerOccurrenceLeagueTenantFk: foreignKey({
    name: "payment_operations_trigger_occurrence_league_tenant_fk",
    columns: [table.triggerOccurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  operationTypeCheck: check(
    "payment_operations_operation_type_check",
    sql`${table.operationType} IN ('scheduled_charge', 'interactive_charge', 'refund', 'canonical_autopay_charge', 'standing_autopay_charge')`,
  ),
  statusCheck: check(
    "payment_operations_status_check",
    sql`${table.status} IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled')`,
  ),
  dispatchClaimStateCheck: check(
    "payment_operations_dispatch_claim_state_check",
    sql`(
      (${table.operationType} IN ('canonical_autopay_charge', 'standing_autopay_charge', 'scheduled_charge', 'interactive_charge')
        AND (
          (${table.status} IN ('pending', 'retry_scheduled') AND ${table.dispatchClaimedAt} IS NULL)
          OR ${table.status} IN ('leased', 'provider_unknown', 'reconciliation_required', 'succeeded', 'action_required', 'failed_terminal', 'canceled')
        ))
      OR (${table.operationType} NOT IN ('canonical_autopay_charge', 'standing_autopay_charge', 'scheduled_charge', 'interactive_charge') AND ${table.dispatchClaimedAt} IS NULL)
    )`,
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
  cardSaveStatusCheck: check(
    "payment_operations_card_save_status_check",
    sql`${table.cardSaveStatus} IS NULL OR ${table.cardSaveStatus} IN ('pending', 'saved', 'failed', 'not_available')`,
  ),
  cardSaveProviderKeyCheck: check(
    "payment_operations_card_save_provider_key_check",
    sql`${table.cardSaveProviderIdempotencyKey} IS NULL OR length(${table.cardSaveProviderIdempotencyKey}) BETWEEN 1 AND 45`,
  ),
  cardSaveStateCheck: check(
    "payment_operations_card_save_state_check",
    sql`(
      ${table.cardSaveStatus} IS NULL
      AND ${table.cardSaveProviderIdempotencyKey} IS NULL
      AND ${table.encryptedSavedCardId} IS NULL
      AND ${table.cardSaveErrorCode} IS NULL
      AND ${table.cardSaveCompletedAt} IS NULL
    ) OR (
      ${table.cardSaveStatus} = 'pending'
      AND ${table.cardSaveProviderIdempotencyKey} IS NOT NULL
      AND ${table.encryptedSavedCardId} IS NULL
      AND ${table.cardSaveCompletedAt} IS NULL
    ) OR (
      ${table.cardSaveStatus} = 'saved'
      AND ${table.cardSaveProviderIdempotencyKey} IS NOT NULL
      AND ${table.encryptedSavedCardId} IS NOT NULL
      AND ${table.cardSaveCompletedAt} IS NOT NULL
    ) OR (
      ${table.cardSaveStatus} IN ('failed', 'not_available')
      AND (
        (${table.cardSaveStatus} = 'failed' AND ${table.cardSaveProviderIdempotencyKey} IS NOT NULL)
        OR (${table.cardSaveStatus} = 'not_available' AND ${table.cardSaveProviderIdempotencyKey} IS NULL)
      )
      AND ${table.encryptedSavedCardId} IS NULL
      AND ${table.cardSaveCompletedAt} IS NOT NULL
    )`,
  ),
  cardSaveErrorCodeCheck: check(
    "payment_operations_card_save_error_code_check",
    sql`${table.cardSaveErrorCode} IS NULL OR ${table.cardSaveErrorCode} ~ '^[A-Z0-9][A-Z0-9_.:-]{0,127}$'`,
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
      ${table.operationType} = 'standing_autopay_charge'
      AND ${table.paymentScheduleId} IS NULL
      AND ${table.billingCycleAt} IS NULL
      AND ${table.leagueId} IS NOT NULL
      AND ${table.canonicalPlanId} IS NULL
      AND ${table.authorizingUserId} IS NOT NULL
    ) OR (
      ${table.operationType} = 'canonical_autopay_charge'
      AND ${table.paymentScheduleId} IS NULL
      AND ${table.billingCycleAt} IS NULL
      AND ${table.leagueId} IS NOT NULL
      AND ${table.canonicalPlanId} IS NOT NULL
      AND ${table.authorizingUserId} IS NOT NULL
    ) OR (
      ${table.operationType} IN ('interactive_charge', 'refund')
      AND ${table.paymentScheduleId} IS NULL
      AND ${table.billingCycleAt} IS NULL
      AND ${table.canonicalPlanId} IS NULL
    )`,
  ),
  triggerOccurrenceCheck: check(
    "payment_operations_trigger_occurrence_check",
    sql`(
      ${table.operationType} = 'scheduled_charge'
      AND (${table.triggerOccurrenceId} IS NULL OR (
        ${table.paymentScheduleId} IS NOT NULL AND ${table.billingCycleAt} IS NOT NULL
      ))
    ) OR (
      ${table.operationType} = 'standing_autopay_charge'
      AND ${table.triggerOccurrenceId} IS NULL
      AND ${table.leagueId} IS NOT NULL
    ) OR (
      ${table.operationType} = 'canonical_autopay_charge'
      AND ${table.triggerOccurrenceId} IS NOT NULL
      AND ${table.canonicalPlanId} IS NOT NULL
      AND ${table.leagueId} IS NOT NULL
    ) OR (
      ${table.operationType} IN ('interactive_charge', 'refund')
      AND ${table.triggerOccurrenceId} IS NULL
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

export const INTERACTIVE_PAYMENT_SNAPSHOT_VERSION = 2;
export const INTERACTIVE_PAYMENT_SNAPSHOT_LEGACY_VERSION = 1;
export const INTERACTIVE_PAYMENT_REQUEST_KINDS = ["direct", "order"] as const;
export type InteractivePaymentRequestKind = (typeof INTERACTIVE_PAYMENT_REQUEST_KINDS)[number];
export const INTERACTIVE_PAYMENT_SOURCE_KINDS = ["new_card", "saved_card", "wallet"] as const;
export type InteractivePaymentSourceKind = (typeof INTERACTIVE_PAYMENT_SOURCE_KINDS)[number];

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
  // Null is retained for v1 rows created before source-kind enforcement.
  sourceKind: text("source_kind", { enum: [...INTERACTIVE_PAYMENT_SOURCE_KINDS, "legacy"] as const }),
  weekOf: timestamp("week_of", { mode: "string" }).notNull(),
  combinedChargeGroupId: varchar("combined_charge_group_id", { length: 128 }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueIdx: index("interactive_payment_snapshots_league_idx").on(table.leagueId),
  payerIdx: index("interactive_payment_snapshots_payer_idx").on(table.payerBowlerId),
  snapshotVersionCheck: check(
    "interactive_payment_snapshots_version_check",
    sql`${table.snapshotVersion} IN (${sql.raw(String(INTERACTIVE_PAYMENT_SNAPSHOT_LEGACY_VERSION))}, ${sql.raw(String(INTERACTIVE_PAYMENT_SNAPSHOT_VERSION))})`,
  ),
  snapshotFingerprintCheck: check(
    "interactive_payment_snapshots_fingerprint_check",
    sql`${table.snapshotFingerprint} ~ '^lvpayexecic:v(1|2):[0-9a-f]{64}$'`,
  ),
  requestKindCheck: check(
    "interactive_payment_snapshots_request_kind_check",
    sql`${table.requestKind} IN ('direct', 'order')`,
  ),
  groupIdCheck: check(
    "interactive_payment_snapshots_group_id_check",
    sql`${table.combinedChargeGroupId} IS NULL OR length(${table.combinedChargeGroupId}) > 0`,
  ),
  sourceKindCheck: check(
    "interactive_payment_snapshots_source_kind_check",
    sql`${table.snapshotVersion} = ${sql.raw(String(INTERACTIVE_PAYMENT_SNAPSHOT_LEGACY_VERSION))} OR ${table.sourceKind} IN ('new_card', 'saved_card', 'wallet')`,
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

export const REFUND_PAYMENT_SNAPSHOT_VERSION = 1;

/** Immutable authorization and exact Square request for one full local-row refund. */
export const refundPaymentOperationSnapshots = pgTable("refund_payment_operation_snapshots", {
  operationId: uuid("operation_id")
    .primaryKey()
    .references(() => paymentOperations.id, { onDelete: "cascade" }),
  snapshotVersion: integer("snapshot_version").notNull().default(REFUND_PAYMENT_SNAPSHOT_VERSION),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 80 }).notNull(),
  paymentId: integer("payment_id")
    .notNull()
    .references(() => payments.id, { onDelete: "restrict" }),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id, { onDelete: "restrict" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  encryptedProviderPaymentId: text("encrypted_provider_payment_id").notNull(),
  reason: varchar("reason", { length: 192 }).notNull(),
  requestedReason: varchar("requested_reason", { length: 192 }),
  requestedByUserId: integer("requested_by_user_id").notNull(),
  requestedByRole: varchar("requested_by_role", { length: 32 }).notNull(),
  requestedByOrganizationId: integer("requested_by_organization_id"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  paymentUnique: uniqueIndex("refund_payment_operation_snapshots_payment_unique").on(table.paymentId),
  leagueIdx: index("refund_payment_operation_snapshots_league_idx").on(table.leagueId),
  versionCheck: check(
    "refund_payment_operation_snapshots_version_check",
    sql`${table.snapshotVersion} = ${sql.raw(String(REFUND_PAYMENT_SNAPSHOT_VERSION))}`,
  ),
  fingerprintCheck: check(
    "refund_payment_operation_snapshots_fingerprint_check",
    sql`${table.snapshotFingerprint} ~ '^lvpayexecrf:v1:[0-9a-f]{64}$'`,
  ),
  actorCheck: check(
    "refund_payment_operation_snapshots_actor_check",
    sql`${table.requestedByUserId} > 0
      AND ${table.requestedByRole} IN ('org_admin', 'system_admin')
      AND (${table.requestedByOrganizationId} IS NULL OR ${table.requestedByOrganizationId} > 0)`,
  ),
  reasonCheck: check(
    "refund_payment_operation_snapshots_reason_check",
    sql`length(${table.reason}) BETWEEN 1 AND 192 AND btrim(${table.reason}) = ${table.reason}`,
  ),
  requestedReasonCheck: check(
    "refund_payment_operation_snapshots_requested_reason_check",
    sql`${table.requestedReason} IS NULL OR (
      length(${table.requestedReason}) BETWEEN 1 AND 192
      AND btrim(${table.requestedReason}) = ${table.requestedReason}
    )`,
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
export type RefundPaymentOperationSnapshot = typeof refundPaymentOperationSnapshots.$inferSelect;
