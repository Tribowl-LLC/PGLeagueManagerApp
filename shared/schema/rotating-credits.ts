import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  date,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { leagues } from "./leagues";
import { locations } from "./locations";
import { bowlers } from "./bowlers";
import { users } from "./users";
import { payments } from "./payments";
import { paymentOperations } from "./payment-operations";
import { paymentAllocations, paymentObligations } from "./roster-payments";

export const ROTATING_CREDIT_FUNDING_KINDS = ["provider", "cash", "check"] as const;
export type RotatingCreditFundingKind = (typeof ROTATING_CREDIT_FUNDING_KINDS)[number];

export const ROTATING_CREDIT_REFUND_KINDS = ["provider", "cash", "check"] as const;
export type RotatingCreditRefundKind = (typeof ROTATING_CREDIT_REFUND_KINDS)[number];

export const ROTATING_CREDIT_SOURCE_KINDS = ["new_card", "saved_card", "wallet"] as const;
export type RotatingCreditSourceKind = (typeof ROTATING_CREDIT_SOURCE_KINDS)[number];

const usdCheck = (name: string, currency: { name: string }) => check(name, sql`${sql.identifier(currency.name)} = 'USD'`);

/** One owned credit lot for one real tender. Lots are never transferred. */
export const rotatingCreditFundings = pgTable("rotating_credit_fundings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  fundingKind: text("funding_kind", { enum: ROTATING_CREDIT_FUNDING_KINDS }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 96 }).notNull(),
  quoteFingerprint: varchar("quote_fingerprint", { length: 96 }).notNull(),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({
    name: "rotating_credit_fundings_league_tenant_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({
    name: "rotating_credit_fundings_bowler_tenant_fk",
    columns: [table.bowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  paymentTenantFk: foreignKey({
    name: "rotating_credit_fundings_payment_tenant_fk",
    columns: [table.paymentId, table.organizationId, table.leagueId],
    foreignColumns: [payments.id, payments.organizationId, payments.leagueId],
  }).onDelete("restrict"),
  paymentUnique: uniqueIndex("rotating_credit_fundings_payment_unique").on(table.paymentId),
  tenantIdentityUnique: uniqueIndex("rotating_credit_fundings_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  paymentBowlerIdentityUnique: uniqueIndex("rotating_credit_fundings_payment_bowler_identity_unique").on(table.id, table.organizationId, table.leagueId, table.paymentId, table.bowlerId),
  requestIdentityUnique: uniqueIndex("rotating_credit_fundings_request_identity_unique").on(table.organizationId, table.leagueId, table.idempotencyKey),
  bowlerCreatedIdx: index("rotating_credit_fundings_bowler_created_idx").on(table.organizationId, table.leagueId, table.bowlerId, table.createdAt, table.id),
  amountCheck: check("rotating_credit_fundings_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: usdCheck("rotating_credit_fundings_currency_check", table.currency),
  kindCheck: check("rotating_credit_fundings_kind_check", sql`${table.fundingKind} IN ('provider', 'cash', 'check')`),
  idempotencyCheck: check("rotating_credit_fundings_idempotency_check", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$'`),
  requestFingerprintCheck: check("rotating_credit_fundings_request_fingerprint_check", sql`${table.requestFingerprint} ~ '^lvrotcrreq:v1:[0-9a-f]{64}$'`),
  quoteFingerprintCheck: check("rotating_credit_fundings_quote_fingerprint_check", sql`${table.quoteFingerprint} ~ '^lvrotcrquote:v1:[0-9a-f]{64}$'`),
}));

/** Immutable mapping from personal credit to one confirmed team obligation allocation. */
export const rotatingCreditApplications = pgTable("rotating_credit_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  fundingId: uuid("funding_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  responsibilityId: uuid("responsibility_id").notNull(),
  actualBowlerId: integer("actual_bowler_id").notNull(),
  teamId: integer("team_id").notNull(),
  slotIndex: integer("slot_index").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  occurrenceLocalDate: date("occurrence_local_date").notNull(),
  occurrenceStartAt: timestamp("occurrence_start_at", { withTimezone: true, mode: "string" }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  appliedByUserId: integer("applied_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
}, (table) => ({
  leagueTenantFk: foreignKey({
    name: "rotating_credit_applications_league_tenant_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  fundingFk: foreignKey({
    name: "rotating_credit_applications_funding_fk",
    columns: [table.fundingId, table.organizationId, table.leagueId, table.paymentId, table.actualBowlerId],
    foreignColumns: [rotatingCreditFundings.id, rotatingCreditFundings.organizationId, rotatingCreditFundings.leagueId, rotatingCreditFundings.paymentId, rotatingCreditFundings.bowlerId],
  }).onDelete("restrict"),
  paymentFk: foreignKey({
    name: "rotating_credit_applications_payment_fk",
    columns: [table.paymentId, table.organizationId, table.leagueId],
    foreignColumns: [payments.id, payments.organizationId, payments.leagueId],
  }).onDelete("restrict"),
  allocationFk: foreignKey({
    name: "rotating_credit_applications_allocation_fk",
    columns: [table.allocationId, table.organizationId, table.leagueId],
    foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId],
  }).onDelete("restrict"),
  obligationFk: foreignKey({
    name: "rotating_credit_applications_obligation_fk",
    columns: [table.obligationId, table.organizationId, table.leagueId],
    foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId],
  }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({
    name: "rotating_credit_applications_bowler_tenant_fk",
    columns: [table.actualBowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  fundingAllocationUnique: uniqueIndex("rotating_credit_applications_allocation_unique").on(table.allocationId),
  tenantIdentityUnique: uniqueIndex("rotating_credit_applications_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  paymentBowlerIdentityUnique: uniqueIndex("rotating_credit_applications_payment_bowler_identity_unique").on(table.id, table.organizationId, table.leagueId, table.paymentId, table.actualBowlerId),
  fundingIdx: index("rotating_credit_applications_funding_idx").on(table.organizationId, table.leagueId, table.fundingId, table.appliedAt),
  bowlerDateIdx: index("rotating_credit_applications_bowler_date_idx").on(table.organizationId, table.leagueId, table.actualBowlerId, table.occurrenceLocalDate, table.appliedAt),
  assignmentIdx: index("rotating_credit_applications_assignment_idx").on(table.organizationId, table.leagueId, table.assignmentId),
  amountCheck: check("rotating_credit_applications_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: usdCheck("rotating_credit_applications_currency_check", table.currency),
  slotCheck: check("rotating_credit_applications_slot_check", sql`${table.slotIndex} >= 0`),
}));

/** Append-only proof that a manager corrected a credited rotating assignment. */
export const rotatingCreditApplicationReversals = pgTable("rotating_credit_application_reversals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  applicationId: uuid("application_id").notNull(),
  fundingPaymentId: integer("funding_payment_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  reason: varchar("reason", { length: 500 }).notNull(),
  transactionId: text("transaction_id").notNull().default(sql`pg_current_xact_id()::text`),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({ name: "rotating_credit_application_reversals_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  applicationFk: foreignKey({ name: "rotating_credit_application_reversals_application_fk", columns: [table.applicationId, table.organizationId, table.leagueId], foreignColumns: [rotatingCreditApplications.id, rotatingCreditApplications.organizationId, rotatingCreditApplications.leagueId] }).onDelete("restrict"),
  applicationPaymentBowlerFk: foreignKey({ name: "rotating_credit_application_reversals_application_payment_bowler_fk", columns: [table.applicationId, table.organizationId, table.leagueId, table.fundingPaymentId, table.bowlerId], foreignColumns: [rotatingCreditApplications.id, rotatingCreditApplications.organizationId, rotatingCreditApplications.leagueId, rotatingCreditApplications.paymentId, rotatingCreditApplications.actualBowlerId] }).onDelete("restrict"),
  paymentFk: foreignKey({ name: "rotating_credit_application_reversals_payment_fk", columns: [table.fundingPaymentId, table.organizationId, table.leagueId], foreignColumns: [payments.id, payments.organizationId, payments.leagueId] }).onDelete("restrict"),
  allocationFk: foreignKey({ name: "rotating_credit_application_reversals_allocation_fk", columns: [table.allocationId, table.organizationId, table.leagueId], foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("rotating_credit_application_reversals_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  oneReversalPerApplication: uniqueIndex("rotating_credit_application_reversals_application_unique").on(table.applicationId),
  assignmentIdx: index("rotating_credit_application_reversals_assignment_idx").on(table.organizationId, table.leagueId, table.assignmentId),
  amountCheck: check("rotating_credit_application_reversals_amount_check", sql`${table.amountMinor} > 0`),
  transactionIdCheck: check("rotating_credit_application_reversals_transaction_id_check", sql`${table.transactionId} ~ '^[0-9]+$'`),
  reasonCheck: check("rotating_credit_application_reversals_reason_check", sql`length(btrim(${table.reason})) BETWEEN 1 AND 500`),
}));

/** A pending provider refund holds the lot's complete unused balance until recovered. */
export const rotatingCreditRefunds = pgTable("rotating_credit_refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  fundingId: uuid("funding_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  refundKind: text("refund_kind", { enum: ROTATING_CREDIT_REFUND_KINDS }).notNull(),
  refundOperationId: uuid("refund_operation_id"),
  reference: varchar("reference", { length: 255 }),
  reason: varchar("reason", { length: 500 }).notNull(),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 96 }).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({ name: "rotating_credit_refunds_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  fundingFk: foreignKey({ name: "rotating_credit_refunds_funding_fk", columns: [table.fundingId, table.organizationId, table.leagueId, table.paymentId, table.bowlerId], foreignColumns: [rotatingCreditFundings.id, rotatingCreditFundings.organizationId, rotatingCreditFundings.leagueId, rotatingCreditFundings.paymentId, rotatingCreditFundings.bowlerId] }).onDelete("restrict"),
  paymentFk: foreignKey({ name: "rotating_credit_refunds_payment_fk", columns: [table.paymentId, table.organizationId, table.leagueId], foreignColumns: [payments.id, payments.organizationId, payments.leagueId] }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({ name: "rotating_credit_refunds_bowler_tenant_fk", columns: [table.bowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  operationFk: foreignKey({ name: "rotating_credit_refunds_operation_fk", columns: [table.refundOperationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  requestUnique: uniqueIndex("rotating_credit_refunds_request_unique").on(table.organizationId, table.leagueId, table.idempotencyKey),
  tenantIdentityUnique: uniqueIndex("rotating_credit_refunds_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  fundingIdx: index("rotating_credit_refunds_funding_idx").on(table.organizationId, table.leagueId, table.fundingId, table.createdAt),
  amountCheck: check("rotating_credit_refunds_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: usdCheck("rotating_credit_refunds_currency_check", table.currency),
  kindCheck: check("rotating_credit_refunds_kind_check", sql`(
    (${table.refundKind} = 'provider' AND ${table.refundOperationId} IS NOT NULL AND ${table.reference} IS NULL AND ${table.issuedAt} IS NULL)
    OR (${table.refundKind} IN ('cash', 'check') AND ${table.refundOperationId} IS NULL AND ${table.issuedAt} IS NOT NULL AND ${table.reference} IS NOT NULL AND length(btrim(${table.reference})) BETWEEN 1 AND 255)
  )`),
  idempotencyCheck: check("rotating_credit_refunds_idempotency_check", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$'`),
  requestFingerprintCheck: check("rotating_credit_refunds_request_fingerprint_check", sql`${table.requestFingerprint} ~ '^lvrotcrrefund:v1:[0-9a-f]{64}$'`),
  reasonCheck: check("rotating_credit_refunds_reason_check", sql`length(btrim(${table.reason})) BETWEEN 1 AND 500`),
}));

/** Encrypted, immutable provider request data for one rotating credit charge. */
export const rotatingCreditPaymentOperationSnapshots = pgTable("rotating_credit_payment_operation_snapshots", {
  operationId: uuid("operation_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(1),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  shareCount: integer("share_count").notNull(),
  locationId: integer("location_id"),
  providerLocationId: varchar("provider_location_id", { length: 255 }),
  sourceKind: text("source_kind", { enum: ROTATING_CREDIT_SOURCE_KINDS }).notNull(),
  encryptedSourceId: text("encrypted_source_id").notNull(),
  encryptedCustomerId: text("encrypted_customer_id"),
  encryptedBuyerEmail: text("encrypted_buyer_email"),
  quoteFingerprint: varchar("quote_fingerprint", { length: 96 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 96 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationPk: uniqueIndex("rotating_credit_payment_operation_snapshots_operation_pk").on(table.operationId),
  leagueTenantFk: foreignKey({ name: "rotating_credit_payment_operation_snapshots_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  operationFk: foreignKey({ name: "rotating_credit_payment_operation_snapshots_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({ name: "rotating_credit_payment_operation_snapshots_bowler_tenant_fk", columns: [table.bowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  locationTenantFk: foreignKey({ name: "rotating_credit_payment_operation_snapshots_location_tenant_fk", columns: [table.locationId, table.organizationId], foreignColumns: [locations.id, locations.organizationId] }).onDelete("restrict"),
  amountCheck: check("rotating_credit_payment_operation_snapshots_amount_check", sql`${table.amountMinor} > 0 AND ${table.shareCount} > 0`),
  currencyCheck: usdCheck("rotating_credit_payment_operation_snapshots_currency_check", table.currency),
  versionCheck: check("rotating_credit_payment_operation_snapshots_version_check", sql`${table.snapshotVersion} = 1`),
  quoteFingerprintCheck: check("rotating_credit_payment_operation_snapshots_quote_fingerprint_check", sql`${table.quoteFingerprint} ~ '^lvrotcrquote:v1:[0-9a-f]{64}$'`),
  idempotencyCheck: check("rotating_credit_payment_operation_snapshots_idempotency_check", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$'`),
  snapshotFingerprintCheck: check("rotating_credit_payment_operation_snapshots_fingerprint_check", sql`${table.snapshotFingerprint} ~ '^lvrotcrexec:v1:[0-9a-f]{64}$'`),
}));

/** Immutable Square refund request; refunds remain in the shared operation ledger. */
export const rotatingCreditRefundOperationSnapshots = pgTable("rotating_credit_refund_operation_snapshots", {
  operationId: uuid("operation_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  fundingId: uuid("funding_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }).notNull(),
  locationId: integer("location_id"),
  reason: varchar("reason", { length: 500 }).notNull(),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 96 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationPk: uniqueIndex("rotating_credit_refund_operation_snapshots_operation_pk").on(table.operationId),
  leagueTenantFk: foreignKey({ name: "rotating_credit_refund_operation_snapshots_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  operationFk: foreignKey({ name: "rotating_credit_refund_operation_snapshots_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  fundingFk: foreignKey({ name: "rotating_credit_refund_operation_snapshots_funding_fk", columns: [table.fundingId, table.organizationId, table.leagueId, table.paymentId, table.bowlerId], foreignColumns: [rotatingCreditFundings.id, rotatingCreditFundings.organizationId, rotatingCreditFundings.leagueId, rotatingCreditFundings.paymentId, rotatingCreditFundings.bowlerId] }).onDelete("restrict"),
  paymentFk: foreignKey({ name: "rotating_credit_refund_operation_snapshots_payment_fk", columns: [table.paymentId, table.organizationId, table.leagueId], foreignColumns: [payments.id, payments.organizationId, payments.leagueId] }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({ name: "rotating_credit_refund_operation_snapshots_bowler_tenant_fk", columns: [table.bowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  locationTenantFk: foreignKey({ name: "rotating_credit_refund_operation_snapshots_location_tenant_fk", columns: [table.locationId, table.organizationId], foreignColumns: [locations.id, locations.organizationId] }).onDelete("restrict"),
  amountCheck: check("rotating_credit_refund_operation_snapshots_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: usdCheck("rotating_credit_refund_operation_snapshots_currency_check", table.currency),
  fingerprintCheck: check("rotating_credit_refund_operation_snapshots_fingerprint_check", sql`${table.snapshotFingerprint} ~ '^lvrotcrrefundexec:v1:[0-9a-f]{64}$'`),
  reasonCheck: check("rotating_credit_refund_operation_snapshots_reason_check", sql`length(btrim(${table.reason})) BETWEEN 1 AND 500`),
}));

export type RotatingCreditFunding = typeof rotatingCreditFundings.$inferSelect;
export type RotatingCreditApplication = typeof rotatingCreditApplications.$inferSelect;
export type RotatingCreditApplicationReversal = typeof rotatingCreditApplicationReversals.$inferSelect;
export type RotatingCreditRefund = typeof rotatingCreditRefunds.$inferSelect;
export type RotatingCreditPaymentOperationSnapshot = typeof rotatingCreditPaymentOperationSnapshots.$inferSelect;
export type RotatingCreditRefundOperationSnapshot = typeof rotatingCreditRefundOperationSnapshots.$inferSelect;
