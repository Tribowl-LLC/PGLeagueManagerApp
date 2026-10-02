import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { bowlers } from "./bowlers";
import { leagueOccurrences } from "./canonical-occurrences";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { teams } from "./teams";
import {
  occurrencePaymentResponsibilities,
  paymentAllocationCorrections,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  rotatingOccurrenceAssignments,
} from "./roster-payments";
import { rotatingCreditApplications, rotatingCreditFundings } from "./rotating-credits";
import { paymentOperations } from "./payment-operations";
import { payments } from "./payments";
import { users } from "./users";

export const WEEKLY_PAYMENT_FUNDING_SOURCES = ["worksheet_manual", "provider", "legacy_adoption"] as const;
export type WeeklyPaymentFundingSource = (typeof WEEKLY_PAYMENT_FUNDING_SOURCES)[number];

export const WEEKLY_PAYMENT_FUNDING_AUTHORIZATION_KINDS = [
  "manual_receipt",
  "provider_snapshot",
  "legacy_payment",
  "legacy_provider_snapshot",
] as const;
export type WeeklyPaymentFundingAuthorizationKind = (typeof WEEKLY_PAYMENT_FUNDING_AUTHORIZATION_KINDS)[number];

export const WEEKLY_PAYMENT_APPLICATION_TARGETS = ["bowler_responsibility", "legacy_team_assignment"] as const;
export type WeeklyPaymentApplicationTarget = (typeof WEEKLY_PAYMENT_APPLICATION_TARGETS)[number];

export const WEEKLY_PAYMENT_OBLIGATION_OWNER_KINDS = ["bowler", "team"] as const;
export type WeeklyPaymentObligationOwnerKind = (typeof WEEKLY_PAYMENT_OBLIGATION_OWNER_KINDS)[number];

export const WEEKLY_PAYMENT_RECEIPT_KINDS = ["manual", "card"] as const;
export type WeeklyPaymentReceiptKind = (typeof WEEKLY_PAYMENT_RECEIPT_KINDS)[number];

export const WEEKLY_PAYMENT_RECEIPT_REVISION_KINDS = [
  "manual_record",
  "manual_edit",
  "manual_clear",
  "card_association",
] as const;
export type WeeklyPaymentReceiptRevisionKind = (typeof WEEKLY_PAYMENT_RECEIPT_REVISION_KINDS)[number];

export const WEEKLY_PAYMENT_ALLOCATION_RELEASE_REASONS = ["worksheet_correction", "ledger_adoption"] as const;
export type WeeklyPaymentAllocationReleaseReason = (typeof WEEKLY_PAYMENT_ALLOCATION_RELEASE_REASONS)[number];

export const WEEKLY_PAYMENT_ADOPTION_VERSION = 1 as const;

const fundingSources = sql.raw(WEEKLY_PAYMENT_FUNDING_SOURCES.map((value) => `'${value}'`).join(", "));
const fundingAuthorizationKinds = sql.raw(WEEKLY_PAYMENT_FUNDING_AUTHORIZATION_KINDS.map((value) => `'${value}'`).join(", "));
const applicationTargets = sql.raw(WEEKLY_PAYMENT_APPLICATION_TARGETS.map((value) => `'${value}'`).join(", "));
const obligationOwnerKinds = sql.raw(WEEKLY_PAYMENT_OBLIGATION_OWNER_KINDS.map((value) => `'${value}'`).join(", "));
const receiptKinds = sql.raw(WEEKLY_PAYMENT_RECEIPT_KINDS.map((value) => `'${value}'`).join(", "));
const receiptRevisionKinds = sql.raw(WEEKLY_PAYMENT_RECEIPT_REVISION_KINDS.map((value) => `'${value}'`).join(", "));
const allocationReleaseReasons = sql.raw(WEEKLY_PAYMENT_ALLOCATION_RELEASE_REASONS.map((value) => `'${value}'`).join(", "));

const leagueTenantFk = (table: { leagueId: AnyPgColumn; organizationId: AnyPgColumn }, name: string) =>
  foreignKey({
    name,
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict");

/** Immutable per-league marker written only by the later guarded adoption operation. */
export const weeklyPaymentLedgerAdoptions = pgTable("weekly_payment_ledger_adoptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  adoptionVersion: integer("adoption_version").notNull().default(WEEKLY_PAYMENT_ADOPTION_VERSION),
  adoptedThroughLocalDate: date("adopted_through_local_date", { mode: "string" }).notNull(),
  preflightFingerprint: varchar("preflight_fingerprint", { length: 96 }).notNull(),
  resultFingerprint: varchar("result_fingerprint", { length: 96 }).notNull(),
  grandfatheredAllocationCount: integer("grandfathered_allocation_count").notNull().default(0),
  recordedByUserId: integer("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_ledger_adoptions_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  actorFk: foreignKey({ name: "weekly_payment_ledger_adoptions_actor_fk", columns: [table.recordedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_ledger_adoptions_league_tenant_fk"),
  leagueUnique: uniqueIndex("weekly_payment_ledger_adoptions_league_unique").on(table.organizationId, table.leagueId),
  tenantIdentity: uniqueIndex("weekly_payment_ledger_adoptions_id_org_league_unique").on(table.id, table.organizationId, table.leagueId),
  versionCheck: check("weekly_payment_ledger_adoptions_version_check", sql`${table.adoptionVersion} = ${sql.raw(String(WEEKLY_PAYMENT_ADOPTION_VERSION))} AND ${table.grandfatheredAllocationCount} >= 0`),
  fingerprintCheck: check("weekly_payment_ledger_adoptions_fingerprint_check", sql`${table.preflightFingerprint} ~ '^lvweeklyadoptpre:v1:[0-9a-f]{64}$' AND ${table.resultFingerprint} ~ '^lvweeklyadopt:v1:[0-9a-f]{64}$'`),
}));

/** One immutable recipient-owned portion of a real tender. A combined tender
 * may have several rows; payment.bowlerId remains the original payer. */
export const weeklyPaymentFundings = pgTable("weekly_payment_fundings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  creditedBowlerId: integer("credited_bowler_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  portionIndex: integer("portion_index").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  source: text("source", { enum: WEEKLY_PAYMENT_FUNDING_SOURCES }).notNull(),
  authorizationKind: text("authorization_kind", { enum: WEEKLY_PAYMENT_FUNDING_AUTHORIZATION_KINDS }).notNull(),
  authorizationOperationId: uuid("authorization_operation_id"),
  authorizationItemCount: integer("authorization_item_count").notNull().default(0),
  authorizationFingerprint: varchar("authorization_fingerprint", { length: 96 }).notNull(),
  adoptionId: uuid("adoption_id"),
  provenanceFingerprint: varchar("provenance_fingerprint", { length: 96 }).notNull(),
  recordedByUserId: integer("recorded_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_fundings_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  actorFk: foreignKey({ name: "weekly_payment_fundings_actor_fk", columns: [table.recordedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_fundings_league_tenant_fk"),
  bowlerTenantFk: foreignKey({ name: "weekly_payment_fundings_owner_tenant_fk", columns: [table.creditedBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  paymentFk: foreignKey({ name: "weekly_payment_fundings_payment_fk", columns: [table.paymentId, table.organizationId, table.leagueId], foreignColumns: [payments.id, payments.organizationId, payments.leagueId] }).onDelete("restrict"),
  adoptionFk: foreignKey({ name: "weekly_payment_fundings_adoption_fk", columns: [table.adoptionId, table.organizationId, table.leagueId], foreignColumns: [weeklyPaymentLedgerAdoptions.id, weeklyPaymentLedgerAdoptions.organizationId, weeklyPaymentLedgerAdoptions.leagueId] }).onDelete("restrict"),
  authorizationOperationFk: foreignKey({ name: "weekly_payment_fundings_auth_op_fk", columns: [table.authorizationOperationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  leagueOwnerPaymentUnique: uniqueIndex("weekly_payment_fundings_payment_owner_uq").on(table.paymentId, table.creditedBowlerId),
  paymentPortionOrderUnique: uniqueIndex("weekly_payment_fundings_portion_order_uq").on(table.paymentId, table.portionIndex),
  sourceIdentity: uniqueIndex("weekly_payment_fundings_source_identity_uq").on(table.id, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.amountMinor, table.currency),
  authorizationIdentity: uniqueIndex("weekly_payment_fundings_auth_identity_uq").on(table.id, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.authorizationOperationId, table.authorizationFingerprint),
  ownerLedgerIdx: index("weekly_payment_fundings_owner_ledger_idx").on(table.organizationId, table.leagueId, table.creditedBowlerId, table.createdAt, table.id),
  amountCheck: check("weekly_payment_fundings_amount_check", sql`${table.amountMinor} > 0 AND ${table.portionIndex} >= 0 AND ${table.authorizationItemCount} >= 0 AND ${table.currency} = 'USD'`),
  sourceCheck: check("weekly_payment_fundings_source_check", sql`${table.source} IN (${fundingSources}) AND ${table.authorizationKind} IN (${fundingAuthorizationKinds}) AND ((${table.source} = 'legacy_adoption' AND ${table.adoptionId} IS NOT NULL AND ${table.authorizationKind} IN ('legacy_payment', 'legacy_provider_snapshot')) OR (${table.source} <> 'legacy_adoption' AND ${table.adoptionId} IS NULL AND ((${table.source} = 'worksheet_manual' AND ${table.authorizationKind} = 'manual_receipt') OR (${table.source} = 'provider' AND ${table.authorizationKind} = 'provider_snapshot')))) AND ((${table.authorizationKind} = 'provider_snapshot' AND ${table.authorizationOperationId} IS NOT NULL AND ${table.authorizationItemCount} = 0) OR (${table.authorizationKind} = 'legacy_provider_snapshot' AND ${table.authorizationOperationId} IS NOT NULL AND ${table.authorizationItemCount} > 0) OR (${table.authorizationKind} IN ('manual_receipt', 'legacy_payment') AND ${table.authorizationOperationId} IS NULL AND ${table.authorizationItemCount} = 0))`),
  authorizationFingerprintCheck: check("weekly_payment_fundings_auth_fp_check", sql`${table.authorizationFingerprint} ~ '^lv(?:accountfunding:v4|partnerexec:v3|rosterexec:v1|standingcutoff:v1|weeklyreceipt:v1|weeklyadopt:v1):[0-9a-f]{64}$'`),
  fingerprintCheck: check("weekly_payment_fundings_fingerprint_check", sql`${table.provenanceFingerprint} ~ '^lvweeklyfund:v1:[0-9a-f]{64}$'`),
}));

/** The exact immutable provider-operation allocation indexes that authorized
 * one recipient's funding portion. */
export const weeklyPaymentFundingAuthorizationItems = pgTable("weekly_payment_funding_authorization_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  fundingId: uuid("funding_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  creditedBowlerId: integer("credited_bowler_id").notNull(),
  sourceOperationId: uuid("source_operation_id").notNull(),
  sourceAllocationIndex: integer("source_allocation_index").notNull(),
  authorizedAmountMinor: integer("authorized_amount_minor").notNull(),
  sourceSnapshotFingerprint: varchar("source_snapshot_fingerprint", { length: 96 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_funding_auth_items_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_funding_auth_items_league_fk"),
  fundingFk: foreignKey({ name: "weekly_payment_funding_auth_items_funding_fk", columns: [table.fundingId, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.sourceOperationId, table.sourceSnapshotFingerprint], foreignColumns: [weeklyPaymentFundings.id, weeklyPaymentFundings.organizationId, weeklyPaymentFundings.leagueId, weeklyPaymentFundings.paymentId, weeklyPaymentFundings.creditedBowlerId, weeklyPaymentFundings.authorizationOperationId, weeklyPaymentFundings.authorizationFingerprint] }).onDelete("restrict"),
  operationItemFk: foreignKey({ name: "weekly_payment_funding_auth_items_item_fk", columns: [table.sourceOperationId, table.organizationId, table.leagueId, table.sourceAllocationIndex, table.authorizedAmountMinor], foreignColumns: [paymentOperationRosterSnapshotItems.operationId, paymentOperationRosterSnapshotItems.organizationId, paymentOperationRosterSnapshotItems.leagueId, paymentOperationRosterSnapshotItems.allocationIndex, paymentOperationRosterSnapshotItems.amountMinor] }).onDelete("restrict"),
  tenantIdentity: uniqueIndex("weekly_payment_funding_auth_items_tenant_uq").on(table.id, table.organizationId, table.leagueId),
  portionItemUnique: uniqueIndex("weekly_payment_funding_auth_items_portion_uq").on(table.organizationId, table.leagueId, table.fundingId, table.sourceAllocationIndex),
  operationItemUnique: uniqueIndex("weekly_payment_funding_auth_items_operation_uq").on(table.organizationId, table.leagueId, table.sourceOperationId, table.sourceAllocationIndex),
  amountCheck: check("weekly_payment_funding_auth_items_amount_check", sql`${table.sourceAllocationIndex} >= 0 AND ${table.authorizedAmountMinor} > 0 AND ${table.sourceSnapshotFingerprint} ~ '^lv(?:partnerexec:v3|rosterexec:v1|standingcutoff:v1):[0-9a-f]{64}$'`),
}));

/** One source link for one canonical allocation. Existing rotating-credit
 * application rows remain authoritative for their existing allocations; a
 * deferred cross-table guard will prevent an allocation from appearing in
 * both representations. */
export const paymentAllocationFundingApplications = pgTable("payment_allocation_funding_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  creditedBowlerId: integer("credited_bowler_id").notNull(),
  genericFundingId: uuid("generic_funding_id"),
  rotatingFundingId: uuid("rotating_funding_id"),
  sourceAmountMinor: integer("source_amount_minor").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  obligationId: uuid("obligation_id").notNull(),
  responsibilityId: uuid("responsibility_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  teamId: integer("team_id").notNull(),
  targetKind: text("target_kind", { enum: WEEKLY_PAYMENT_APPLICATION_TARGETS }).notNull(),
  targetPayerBowlerId: integer("target_payer_bowler_id"),
  assignmentId: uuid("assignment_id"),
  appliedByUserId: integer("applied_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "pay_alloc_fund_apps_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  actorFk: foreignKey({ name: "pay_alloc_fund_apps_actor_fk", columns: [table.appliedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "pay_alloc_fund_apps_league_fk"),
  creditedOwnerFk: foreignKey({ name: "pay_alloc_fund_apps_owner_fk", columns: [table.creditedBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  allocationFk: foreignKey({ name: "pay_alloc_fund_apps_allocation_fk", columns: [table.allocationId, table.organizationId, table.leagueId, table.paymentId, table.obligationId, table.amountMinor, table.currency], foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId, paymentAllocations.paymentId, paymentAllocations.obligationId, paymentAllocations.amountMinor, paymentAllocations.currency] }).onDelete("restrict"),
  genericFundingFk: foreignKey({ name: "pay_alloc_fund_apps_generic_fk", columns: [table.genericFundingId, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.sourceAmountMinor, table.currency], foreignColumns: [weeklyPaymentFundings.id, weeklyPaymentFundings.organizationId, weeklyPaymentFundings.leagueId, weeklyPaymentFundings.paymentId, weeklyPaymentFundings.creditedBowlerId, weeklyPaymentFundings.amountMinor, weeklyPaymentFundings.currency] }).onDelete("restrict"),
  rotatingFundingFk: foreignKey({ name: "pay_alloc_fund_apps_rotating_fk", columns: [table.rotatingFundingId, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.sourceAmountMinor, table.currency], foreignColumns: [rotatingCreditFundings.id, rotatingCreditFundings.organizationId, rotatingCreditFundings.leagueId, rotatingCreditFundings.paymentId, rotatingCreditFundings.bowlerId, rotatingCreditFundings.amountMinor, rotatingCreditFundings.currency] }).onDelete("restrict"),
  obligationIdentityFk: foreignKey({ name: "pay_alloc_fund_apps_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId, table.responsibilityId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId, paymentObligations.responsibilityId] }).onDelete("restrict"),
  obligationPayerFk: foreignKey({ name: "pay_alloc_fund_apps_payer_fk", columns: [table.obligationId, table.organizationId, table.leagueId, table.responsibilityId, table.targetPayerBowlerId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId, paymentObligations.responsibilityId, paymentObligations.payerBowlerId] }).onDelete("restrict"),
  responsibilityFk: foreignKey({ name: "pay_alloc_fund_apps_resp_fk", columns: [table.responsibilityId, table.organizationId, table.leagueId, table.occurrenceId, table.teamId], foreignColumns: [occurrencePaymentResponsibilities.id, occurrencePaymentResponsibilities.organizationId, occurrencePaymentResponsibilities.leagueId, occurrencePaymentResponsibilities.occurrenceId, occurrencePaymentResponsibilities.teamId] }).onDelete("restrict"),
  assignmentFk: foreignKey({ name: "pay_alloc_fund_apps_assign_fk", columns: [table.assignmentId, table.organizationId, table.leagueId, table.occurrenceId, table.teamId, table.responsibilityId, table.creditedBowlerId], foreignColumns: [rotatingOccurrenceAssignments.id, rotatingOccurrenceAssignments.organizationId, rotatingOccurrenceAssignments.leagueId, rotatingOccurrenceAssignments.occurrenceId, rotatingOccurrenceAssignments.teamId, rotatingOccurrenceAssignments.responsibilityId, rotatingOccurrenceAssignments.actualBowlerId] }).onDelete("restrict"),
  allocationUnique: uniqueIndex("pay_alloc_fund_apps_alloc_uq").on(table.allocationId),
  tenantIdentity: uniqueIndex("pay_alloc_fund_apps_tenant_uq").on(table.id, table.organizationId, table.leagueId),
  sourceIdentity: uniqueIndex("pay_alloc_fund_apps_source_identity_uq").on(table.id, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.allocationId, table.obligationId, table.amountMinor, table.currency),
  fundingIdx: index("pay_alloc_fund_apps_funding_idx").on(table.organizationId, table.leagueId, table.genericFundingId, table.rotatingFundingId, table.createdAt),
  targetIdx: index("pay_alloc_fund_apps_target_idx").on(table.organizationId, table.leagueId, table.creditedBowlerId, table.occurrenceId),
  identityCheck: check("pay_alloc_fund_apps_identity_check", sql`${table.targetKind} IN (${applicationTargets}) AND ${table.amountMinor} > 0 AND ${table.sourceAmountMinor} >= ${table.amountMinor} AND ${table.currency} = 'USD' AND ((${table.genericFundingId} IS NOT NULL AND ${table.rotatingFundingId} IS NULL) OR (${table.genericFundingId} IS NULL AND ${table.rotatingFundingId} IS NOT NULL)) AND ((${table.targetKind} = 'bowler_responsibility' AND ${table.targetPayerBowlerId} IS NOT NULL AND ${table.assignmentId} IS NULL) OR (${table.targetKind} = 'legacy_team_assignment' AND ${table.targetPayerBowlerId} IS NULL AND ${table.assignmentId} IS NOT NULL))`),
}));

/** Exact proof for adopted cross-owner or legacy team allocations. A proof
 * binds the credited recipient to one typed source application, the current
 * allocation, and its recorded correction chain. */
export const weeklyPaymentLedgerAdoptionAllocationProofs = pgTable("weekly_payment_ledger_adoption_allocation_proofs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  adoptionId: uuid("adoption_id").notNull(),
  fundingApplicationId: uuid("funding_application_id"),
  rotatingApplicationId: uuid("rotating_application_id"),
  paymentId: integer("payment_id").notNull(),
  creditedBowlerId: integer("credited_bowler_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  originalAllocationId: uuid("original_allocation_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  obligationOwnerKind: text("obligation_owner_kind", { enum: WEEKLY_PAYMENT_OBLIGATION_OWNER_KINDS }).notNull(),
  obligationOwnerBowlerId: integer("obligation_owner_bowler_id"),
  obligationOwnerTeamId: integer("obligation_owner_team_id"),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  correctionCount: integer("correction_count").notNull().default(0),
  correctionLineageFingerprint: varchar("correction_lineage_fingerprint", { length: 96 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_adopt_proofs_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_adopt_alloc_proofs_league_tenant_fk"),
  adoptionFk: foreignKey({ name: "weekly_payment_adopt_alloc_proofs_adoption_fk", columns: [table.adoptionId, table.organizationId, table.leagueId], foreignColumns: [weeklyPaymentLedgerAdoptions.id, weeklyPaymentLedgerAdoptions.organizationId, weeklyPaymentLedgerAdoptions.leagueId] }).onDelete("restrict"),
  fundingApplicationFk: foreignKey({ name: "weekly_payment_adopt_proofs_weekly_app_fk", columns: [table.fundingApplicationId, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.allocationId, table.obligationId, table.amountMinor, table.currency], foreignColumns: [paymentAllocationFundingApplications.id, paymentAllocationFundingApplications.organizationId, paymentAllocationFundingApplications.leagueId, paymentAllocationFundingApplications.paymentId, paymentAllocationFundingApplications.creditedBowlerId, paymentAllocationFundingApplications.allocationId, paymentAllocationFundingApplications.obligationId, paymentAllocationFundingApplications.amountMinor, paymentAllocationFundingApplications.currency] }).onDelete("restrict"),
  rotatingApplicationFk: foreignKey({ name: "weekly_payment_adopt_proofs_rot_app_fk", columns: [table.rotatingApplicationId, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.allocationId, table.obligationId, table.amountMinor], foreignColumns: [rotatingCreditApplications.id, rotatingCreditApplications.organizationId, rotatingCreditApplications.leagueId, rotatingCreditApplications.paymentId, rotatingCreditApplications.actualBowlerId, rotatingCreditApplications.allocationId, rotatingCreditApplications.obligationId, rotatingCreditApplications.amountMinor] }).onDelete("restrict"),
  allocationFk: foreignKey({ name: "weekly_payment_adopt_alloc_proofs_allocation_fk", columns: [table.allocationId, table.organizationId, table.leagueId], foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId] }).onDelete("restrict"),
  originalAllocationFk: foreignKey({ name: "weekly_payment_adopt_proofs_original_fk", columns: [table.originalAllocationId, table.organizationId, table.leagueId], foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId] }).onDelete("restrict"),
  obligationFk: foreignKey({ name: "weekly_payment_adopt_alloc_proofs_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId] }).onDelete("restrict"),
  ownerBowlerFk: foreignKey({ name: "weekly_payment_adopt_proofs_bowler_fk", columns: [table.obligationOwnerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  ownerTeamFk: foreignKey({ name: "weekly_payment_adopt_proofs_team_fk", columns: [table.obligationOwnerTeamId, table.leagueId], foreignColumns: [teams.id, teams.leagueId] }).onDelete("restrict"),
  tenantIdentity: uniqueIndex("weekly_payment_adopt_proofs_id_tenant_uq").on(table.id, table.organizationId, table.leagueId),
  adoptionAllocationUnique: uniqueIndex("weekly_payment_adopt_proofs_adoption_alloc_uq").on(table.organizationId, table.leagueId, table.adoptionId, table.allocationId),
  weeklyApplicationUnique: uniqueIndex("weekly_payment_adopt_proofs_week_app_uq").on(table.fundingApplicationId).where(sql`${table.fundingApplicationId} IS NOT NULL`),
  rotatingApplicationUnique: uniqueIndex("weekly_payment_adopt_proofs_rot_app_uq").on(table.rotatingApplicationId).where(sql`${table.rotatingApplicationId} IS NOT NULL`),
  allocationIdx: index("weekly_payment_adopt_proofs_alloc_idx").on(table.organizationId, table.leagueId, table.allocationId),
  identityCheck: check("weekly_payment_adopt_proofs_identity_check", sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.correctionCount} >= 0 AND ${table.correctionLineageFingerprint} ~ '^lvweeklyadoptcorr:v1:[0-9a-f]{64}$' AND ((${table.fundingApplicationId} IS NOT NULL AND ${table.rotatingApplicationId} IS NULL) OR (${table.fundingApplicationId} IS NULL AND ${table.rotatingApplicationId} IS NOT NULL)) AND ((${table.obligationOwnerKind} = 'bowler' AND ${table.obligationOwnerBowlerId} IS NOT NULL AND ${table.obligationOwnerTeamId} IS NULL AND ${table.creditedBowlerId} <> ${table.obligationOwnerBowlerId}) OR (${table.obligationOwnerKind} = 'team' AND ${table.obligationOwnerBowlerId} IS NULL AND ${table.obligationOwnerTeamId} IS NOT NULL))`),
}));

/** Each correction edge in an adopted allocation's exact original-to-current path. */
export const weeklyPaymentLedgerAdoptionAllocationProofSteps = pgTable("weekly_payment_ledger_adoption_allocation_proof_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  proofId: uuid("proof_id").notNull(),
  stepIndex: integer("step_index").notNull(),
  correctionId: uuid("correction_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  sourceAllocationId: uuid("source_allocation_id").notNull(),
  replacementAllocationId: uuid("replacement_allocation_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_adopt_steps_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_adopt_steps_league_fk"),
  proofFk: foreignKey({ name: "weekly_payment_adopt_steps_proof_fk", columns: [table.proofId, table.organizationId, table.leagueId], foreignColumns: [weeklyPaymentLedgerAdoptionAllocationProofs.id, weeklyPaymentLedgerAdoptionAllocationProofs.organizationId, weeklyPaymentLedgerAdoptionAllocationProofs.leagueId] }).onDelete("restrict"),
  correctionFk: foreignKey({ name: "weekly_payment_adopt_steps_correction_fk", columns: [table.correctionId, table.organizationId, table.leagueId, table.paymentId, table.sourceAllocationId, table.replacementAllocationId, table.amountMinor], foreignColumns: [paymentAllocationCorrections.id, paymentAllocationCorrections.organizationId, paymentAllocationCorrections.leagueId, paymentAllocationCorrections.paymentId, paymentAllocationCorrections.sourceAllocationId, paymentAllocationCorrections.replacementAllocationId, paymentAllocationCorrections.amountMinor] }).onDelete("restrict"),
  proofStepUnique: uniqueIndex("weekly_payment_adopt_steps_index_uq").on(table.organizationId, table.leagueId, table.proofId, table.stepIndex),
  proofCorrectionUnique: uniqueIndex("weekly_payment_adopt_steps_corr_uq").on(table.organizationId, table.leagueId, table.proofId, table.correctionId),
  stepCheck: check("weekly_payment_adopt_steps_check", sql`${table.stepIndex} >= 0 AND ${table.amountMinor} > 0 AND ${table.currency} = 'USD'`),
}));

/** A single append-only confirmation event per saved worksheet revision. An
 * absent confirmation is an unconfirmed forecast, not collectible debt. */
export const weeklyPaymentWeekConfirmations = pgTable("weekly_payment_week_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  revision: integer("revision").notNull(),
  stateFingerprint: varchar("state_fingerprint", { length: 96 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 96 }).notNull(),
  responsibilitySetFingerprint: varchar("responsibility_set_fingerprint", { length: 96 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestSnapshot: jsonb("request_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_week_confirmations_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  actorFk: foreignKey({ name: "weekly_payment_week_confirmations_actor_fk", columns: [table.recordedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_week_confirmations_league_tenant_fk"),
  occurrenceFk: foreignKey({ name: "weekly_payment_week_confirmations_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("weekly_payment_week_confirmations_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  revisionUnique: uniqueIndex("weekly_payment_week_confirmations_revision_unique").on(table.organizationId, table.leagueId, table.occurrenceId, table.revision),
  idempotencyUnique: uniqueIndex("weekly_payment_week_confirmations_idempotency_unique").on(table.organizationId, table.leagueId, table.idempotencyKey),
  occurrenceRevisionIdx: index("weekly_payment_week_confirmations_occurrence_revision_idx").on(table.organizationId, table.leagueId, table.occurrenceId, table.revision),
  revisionCheck: check("weekly_payment_week_confirmations_revision_check", sql`${table.revision} > 0 AND ${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$'`),
  fingerprintCheck: check("weekly_payment_week_confirmations_fingerprint_check", sql`${table.stateFingerprint} ~ '^lvmanagepayments:v1:[0-9a-f]{64}$' AND ${table.requestFingerprint} ~ '^lvmanagepaymentsrequest:v1:[0-9a-f]{64}$' AND ${table.responsibilitySetFingerprint} ~ '^lvmanagepaymentsrows:v1:[0-9a-f]{64}$'`),
}));

/** Stable UI identity for one exact receipt. Several historic cash/check
 * receipts may belong to the same payer and collection occurrence. */
export const weeklyPaymentWorksheetReceipts = pgTable("weekly_payment_worksheet_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  payerBowlerId: integer("payer_bowler_id").notNull(),
  receiptKind: text("receipt_kind", { enum: WEEKLY_PAYMENT_RECEIPT_KINDS }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_worksheet_receipts_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_worksheet_receipts_league_tenant_fk"),
  occurrenceFk: foreignKey({ name: "weekly_payment_worksheet_receipts_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  payerFk: foreignKey({ name: "weekly_payment_worksheet_receipts_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  tenantIdentity: uniqueIndex("weekly_payment_worksheet_receipts_id_org_league_unique").on(table.id, table.organizationId, table.leagueId),
  scopeIdentityUnique: uniqueIndex("weekly_payment_worksheet_receipts_scope_identity_unique").on(table.id, table.organizationId, table.leagueId, table.occurrenceId, table.payerBowlerId, table.receiptKind),
  payerOccurrenceIdx: index("weekly_payment_worksheet_receipts_payer_occurrence_idx").on(table.organizationId, table.leagueId, table.payerBowlerId, table.occurrenceId),
  kindCheck: check("weekly_payment_worksheet_receipts_kind_check", sql`${table.receiptKind} IN (${receiptKinds})`),
}));

/** Append-only changes to one manual receipt, or its immutable card association.
 * A replacement cash/check payment remains in the same receipt lineage. */
export const weeklyPaymentWorksheetReceiptRevisions = pgTable("weekly_payment_worksheet_receipt_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  receiptId: uuid("receipt_id").notNull(),
  receiptRevision: integer("receipt_revision").notNull(),
  paymentId: integer("payment_id"),
  revisionKind: text("revision_kind", { enum: WEEKLY_PAYMENT_RECEIPT_REVISION_KINDS }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  businessCollectionLocalDate: date("business_collection_local_date", { mode: "string" }).notNull(),
  recordedByUserId: integer("recorded_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_receipt_revisions_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  actorFk: foreignKey({ name: "weekly_payment_receipt_revisions_actor_fk", columns: [table.recordedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_worksheet_receipt_revisions_league_tenant_fk"),
  receiptFk: foreignKey({ name: "weekly_payment_worksheet_receipt_revisions_receipt_fk", columns: [table.receiptId, table.organizationId, table.leagueId], foreignColumns: [weeklyPaymentWorksheetReceipts.id, weeklyPaymentWorksheetReceipts.organizationId, weeklyPaymentWorksheetReceipts.leagueId] }).onDelete("restrict"),
  paymentFk: foreignKey({ name: "weekly_payment_worksheet_receipt_revisions_payment_fk", columns: [table.paymentId, table.organizationId, table.leagueId], foreignColumns: [payments.id, payments.organizationId, payments.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("weekly_payment_receipt_revisions_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  receiptRevisionUnique: uniqueIndex("weekly_payment_receipt_revisions_receipt_revision_unique").on(table.organizationId, table.leagueId, table.receiptId, table.receiptRevision),
  paymentReceiptUnique: uniqueIndex("weekly_payment_receipt_revisions_payment_receipt_uq").on(table.paymentId, table.receiptId).where(sql`${table.paymentId} IS NOT NULL`),
  receiptIdx: index("weekly_payment_worksheet_receipt_revisions_receipt_idx").on(table.organizationId, table.leagueId, table.receiptId, table.receiptRevision),
  revisionCheck: check("weekly_payment_worksheet_receipt_revisions_revision_check", sql`${table.receiptRevision} > 0 AND ${table.amountMinor} >= 0 AND ((${table.paymentId} IS NULL AND ${table.amountMinor} = 0 AND ${table.revisionKind} = 'manual_clear') OR (${table.paymentId} IS NOT NULL AND ${table.amountMinor} > 0 AND ${table.revisionKind} <> 'manual_clear')) AND ${table.revisionKind} IN (${receiptRevisionKinds})`),
  actorCheck: check("weekly_payment_worksheet_receipt_revisions_actor_check", sql`(${table.revisionKind} = 'card_association' AND ${table.recordedByUserId} IS NULL) OR (${table.revisionKind} <> 'card_association' AND ${table.recordedByUserId} IS NOT NULL)`),
}));

/** Append-only release of a new typed funding application back to its exact
 * credited recipient. Existing rotating applications retain their original
 * reversal table and do not write this release record. */
export const weeklyPaymentAllocationReleases = pgTable("weekly_payment_allocation_releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  fundingApplicationId: uuid("funding_application_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  creditedBowlerId: integer("credited_bowler_id").notNull(),
  sourceAllocationId: uuid("source_allocation_id").notNull(),
  sourceObligationId: uuid("source_obligation_id").notNull(),
  sourceApplicationAmountMinor: integer("source_application_amount_minor").notNull(),
  replacementAllocationId: uuid("replacement_allocation_id"),
  releasedAmountMinor: integer("released_amount_minor").notNull(),
  retainedAmountMinor: integer("retained_amount_minor").notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  reason: text("reason", { enum: WEEKLY_PAYMENT_ALLOCATION_RELEASE_REASONS }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull(),
  transactionId: text("transaction_id").notNull().default(sql`pg_current_xact_id()::text`),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationFk: foreignKey({ name: "weekly_payment_allocation_releases_org_fk", columns: [table.organizationId], foreignColumns: [organizations.id] }).onDelete("restrict"),
  actorFk: foreignKey({ name: "weekly_payment_allocation_releases_actor_fk", columns: [table.recordedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "weekly_payment_allocation_releases_league_tenant_fk"),
  fundingApplicationFk: foreignKey({ name: "weekly_payment_allocation_releases_app_fk", columns: [table.fundingApplicationId, table.organizationId, table.leagueId, table.paymentId, table.creditedBowlerId, table.sourceAllocationId, table.sourceObligationId, table.sourceApplicationAmountMinor, table.currency], foreignColumns: [paymentAllocationFundingApplications.id, paymentAllocationFundingApplications.organizationId, paymentAllocationFundingApplications.leagueId, paymentAllocationFundingApplications.paymentId, paymentAllocationFundingApplications.creditedBowlerId, paymentAllocationFundingApplications.allocationId, paymentAllocationFundingApplications.obligationId, paymentAllocationFundingApplications.amountMinor, paymentAllocationFundingApplications.currency] }).onDelete("restrict"),
  sourceAllocationFk: foreignKey({ name: "weekly_payment_allocation_releases_source_allocation_fk", columns: [table.sourceAllocationId, table.organizationId, table.leagueId], foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId] }).onDelete("restrict"),
  sourceObligationFk: foreignKey({ name: "weekly_payment_allocation_releases_source_obligation_fk", columns: [table.sourceObligationId, table.organizationId, table.leagueId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId] }).onDelete("restrict"),
  replacementAllocationFk: foreignKey({ name: "weekly_payment_allocation_releases_replacement_allocation_fk", columns: [table.replacementAllocationId, table.organizationId, table.leagueId], foreignColumns: [paymentAllocations.id, paymentAllocations.organizationId, paymentAllocations.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("weekly_payment_allocation_releases_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  sourceAllocationUnique: uniqueIndex("weekly_payment_allocation_releases_source_allocation_unique").on(table.sourceAllocationId),
  replacementAllocationUnique: uniqueIndex("weekly_payment_allocation_releases_replacement_unique").on(table.replacementAllocationId).where(sql`${table.replacementAllocationId} IS NOT NULL`),
  ownerLedgerIdx: index("weekly_payment_allocation_releases_owner_ledger_idx").on(table.organizationId, table.leagueId, table.creditedBowlerId, table.createdAt),
  idempotencyUnique: uniqueIndex("weekly_payment_allocation_releases_idempotency_unique").on(table.organizationId, table.leagueId, table.idempotencyKey),
  amountCheck: check("weekly_payment_allocation_releases_amount_check", sql`${table.releasedAmountMinor} > 0 AND ${table.retainedAmountMinor} >= 0 AND ${table.releasedAmountMinor} + ${table.retainedAmountMinor} = ${table.sourceApplicationAmountMinor} AND ${table.currency} = 'USD' AND ((${table.retainedAmountMinor} = 0 AND ${table.replacementAllocationId} IS NULL) OR (${table.retainedAmountMinor} > 0 AND ${table.replacementAllocationId} IS NOT NULL))`),
  evidenceCheck: check("weekly_payment_allocation_releases_evidence_check", sql`${table.reason} IN (${allocationReleaseReasons}) AND ${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$' AND ${table.transactionId} ~ '^[0-9]+$'`),
}));

export type WeeklyPaymentLedgerAdoption = typeof weeklyPaymentLedgerAdoptions.$inferSelect;
export type WeeklyPaymentFunding = typeof weeklyPaymentFundings.$inferSelect;
export type WeeklyPaymentFundingAuthorizationItem = typeof weeklyPaymentFundingAuthorizationItems.$inferSelect;
export type PaymentAllocationFundingApplication = typeof paymentAllocationFundingApplications.$inferSelect;
export type WeeklyPaymentLedgerAdoptionAllocationProof = typeof weeklyPaymentLedgerAdoptionAllocationProofs.$inferSelect;
export type WeeklyPaymentLedgerAdoptionAllocationProofStep = typeof weeklyPaymentLedgerAdoptionAllocationProofSteps.$inferSelect;
export type WeeklyPaymentWeekConfirmation = typeof weeklyPaymentWeekConfirmations.$inferSelect;
export type WeeklyPaymentWorksheetReceipt = typeof weeklyPaymentWorksheetReceipts.$inferSelect;
export type WeeklyPaymentWorksheetReceiptRevision = typeof weeklyPaymentWorksheetReceiptRevisions.$inferSelect;
export type WeeklyPaymentAllocationRelease = typeof weeklyPaymentAllocationReleases.$inferSelect;
