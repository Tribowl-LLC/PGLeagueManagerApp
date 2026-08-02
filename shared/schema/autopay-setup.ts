import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { bowlers } from "./bowlers";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { paymentOperations } from "./payment-operations";
import { paymentSchedules } from "./payments";

export const AUTOPAY_SETUP_SNAPSHOT_VERSION = 1 as const;
export const AUTOPAY_SETUP_WORKFLOW_STATUSES = [
  "pending",
  "completed",
  "canceled",
] as const;
export type AutopaySetupWorkflowStatus =
  (typeof AUTOPAY_SETUP_WORKFLOW_STATUSES)[number];

export interface AutopaySetupSnapshotAllocation {
  allocationIndex: number;
  bowlerId: number;
  occurrenceAt: string;
  localDate: string;
  classification: "past_due" | "due_today";
  amountMinor: number;
  lineageAmountMinor: number | null;
  prizeFundAmountMinor: number | null;
  notes: string | null;
  paidByUserId: number | null;
}

export interface AutopaySetupSnapshot {
  snapshotVersion: typeof AUTOPAY_SETUP_SNAPSHOT_VERSION;
  organizationId: number;
  payerBowlerId: number;
  leagueId: number;
  locationId: number;
  providerName: "square";
  currency: "USD";
  sourceFingerprint: string;
  additionalBowlerIds: number[];
  immediateAmountMinor: number;
  allocations: AutopaySetupSnapshotAllocation[];
  firstAutomaticAt: string | null;
  firstAutomaticLocalDate: string | null;
  firstAutomaticAmountMinor: number;
  recurringAmountMinor: number;
  timezone: string;
  competitionStartTime: string;
  requestKind: "direct" | "order" | null;
  lineItems: Array<{ catalogObjectId: string; quantity: string }>;
}

/**
 * Durable workflow and immutable allocation snapshot for weekly auto-pay setup.
 *
 * This table does not own provider execution state. Positive immediate money
 * movement links to one `interactive_charge` payment operation; that ledger
 * remains the sole owner of leases, retries, provider uncertainty, provider
 * object IDs, and terminal outcomes. A zero-dollar setup has no operation.
 */
export const autopaySetupRequests = pgTable("autopay_setup_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  payerBowlerId: integer("payer_bowler_id")
    .notNull()
    .references(() => bowlers.id, { onDelete: "restrict" }),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id, { onDelete: "restrict" }),
  workflowStatus: text("workflow_status", {
    enum: AUTOPAY_SETUP_WORKFLOW_STATUSES,
  }).notNull().default("pending"),
  quoteFingerprint: varchar("quote_fingerprint", { length: 84 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 84 }).notNull(),
  paymentOperationId: uuid("payment_operation_id")
    .references(() => paymentOperations.id, { onDelete: "restrict" }),
  paymentScheduleId: integer("payment_schedule_id")
    .references(() => paymentSchedules.id, { onDelete: "restrict" }),
  encryptedSourceId: text("encrypted_source_id").notNull(),
  encryptedCustomerId: text("encrypted_customer_id"),
  encryptedBuyerEmail: text("encrypted_buyer_email"),
  snapshot: jsonb("snapshot").$type<AutopaySetupSnapshot>().notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { mode: "string" }),
  canceledAt: timestamp("canceled_at", { mode: "string" }),
}, (table) => ({
  activeSetupUnique: uniqueIndex("autopay_setup_requests_active_unique")
    .on(table.payerBowlerId, table.leagueId)
    .where(sql`${table.workflowStatus} = 'pending'`),
  requestFingerprintUnique: uniqueIndex("autopay_setup_requests_request_fingerprint_unique")
    .on(table.requestFingerprint),
  paymentOperationUnique: uniqueIndex("autopay_setup_requests_payment_operation_unique")
    .on(table.paymentOperationId)
    .where(sql`${table.paymentOperationId} IS NOT NULL`),
  tenantLookupIdx: index("autopay_setup_requests_tenant_created_idx")
    .on(table.organizationId, table.createdAt.desc()),
  workflowStatusCheck: check(
    "autopay_setup_requests_workflow_status_check",
    sql`${table.workflowStatus} IN ('pending', 'completed', 'canceled')`,
  ),
  quoteFingerprintCheck: check(
    "autopay_setup_requests_quote_fingerprint_check",
    sql`${table.quoteFingerprint} ~ '^lvautopayquote:v1:[0-9a-f]{64}$'`,
  ),
  requestFingerprintCheck: check(
    "autopay_setup_requests_request_fingerprint_check",
    sql`${table.requestFingerprint} ~ '^lvautopaysetup:v1:[0-9a-f]{64}$'`,
  ),
  snapshotShapeCheck: check(
    "autopay_setup_requests_snapshot_shape_check",
    sql`jsonb_typeof(${table.snapshot}) = 'object'
      AND ${table.snapshot}->>'snapshotVersion' = '1'
      AND (${table.snapshot}->>'immediateAmountMinor') ~ '^[0-9]+$'
      AND (${table.snapshot}->>'firstAutomaticAmountMinor') ~ '^[0-9]+$'
      AND (${table.snapshot}->>'recurringAmountMinor') ~ '^[1-9][0-9]*$'`,
  ),
  immediateOperationCheck: check(
    "autopay_setup_requests_immediate_operation_check",
    sql`CASE
      WHEN (${table.snapshot}->>'immediateAmountMinor') ~ '^[0-9]+$'
      THEN (
        ((${table.snapshot}->>'immediateAmountMinor')::integer = 0 AND ${table.paymentOperationId} IS NULL)
        OR ((${table.snapshot}->>'immediateAmountMinor')::integer > 0 AND ${table.paymentOperationId} IS NOT NULL)
      )
      ELSE false
    END`,
  ),
  workflowTimestampCheck: check(
    "autopay_setup_requests_workflow_timestamp_check",
    sql`(
      ${table.workflowStatus} = 'pending'
      AND ${table.completedAt} IS NULL
      AND ${table.canceledAt} IS NULL
    ) OR (
      ${table.workflowStatus} = 'completed'
      AND ${table.completedAt} IS NOT NULL
      AND ${table.canceledAt} IS NULL
    ) OR (
      ${table.workflowStatus} = 'canceled'
      AND ${table.completedAt} IS NULL
      AND ${table.canceledAt} IS NOT NULL
      AND ${table.paymentScheduleId} IS NULL
    )`,
  ),
  completionScheduleCheck: check(
    "autopay_setup_requests_completion_schedule_check",
    sql`${table.workflowStatus} <> 'completed'
      OR ${table.snapshot}->>'firstAutomaticAt' IS NULL
      OR ${table.paymentScheduleId} IS NOT NULL`,
  ),
  timestampOrderCheck: check(
    "autopay_setup_requests_timestamp_order_check",
    sql`${table.updatedAt} >= ${table.createdAt}
      AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
      AND (${table.canceledAt} IS NULL OR ${table.canceledAt} >= ${table.createdAt})`,
  ),
}));

export type AutopaySetupRequest = typeof autopaySetupRequests.$inferSelect;
