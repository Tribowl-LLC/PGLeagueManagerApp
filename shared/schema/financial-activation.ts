import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
} from "drizzle-orm/pg-core";
import { bowlers } from "./bowlers";
import { leagueOccurrences, leagueOccurrenceBillingTerms } from "./canonical-occurrences";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { teams } from "./teams";
import { users } from "./users";
import { bowlerOccurrenceEligibilities, bowlerOccurrenceObligations, bowlerOccurrenceTeamAssignments } from "./occurrence-financials";

export const FINANCIAL_ACTIVATION_VERSION = 1;
export { FINANCIAL_READ_CONTRACT_VERSION, FINANCIAL_READ_FINGERPRINT_PREFIX, FINANCIAL_ACTIVATION_FINGERPRINT_PREFIX, FINANCIAL_SOURCE_FINGERPRINT_PREFIX } from "../financial-contract";
export const FINANCIAL_ACTIVATION_POLICY_VERSION = "eligible-bowlers/1" as const;
export const FINANCIAL_ACTIVATION_ORDER_VERSION = "occurrence-team-slot-bowler/1" as const;
export const FINANCIAL_RESPONSIBILITY_ROLES = ["regular", "substitute"] as const;
export type FinancialResponsibilityRole = (typeof FINANCIAL_RESPONSIBILITY_ROLES)[number];
const roles = sql.raw(FINANCIAL_RESPONSIBILITY_ROLES.map((v) => `'${v}'`).join(", "));

export const financialActivations = pgTable("financial_activations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  activationVersion: integer("activation_version").notNull().default(FINANCIAL_ACTIVATION_VERSION),
  policyVersion: varchar("policy_version", { length: 64 }).notNull().default(FINANCIAL_ACTIVATION_POLICY_VERSION),
  orderVersion: varchar("order_version", { length: 64 }).notNull().default(FINANCIAL_ACTIVATION_ORDER_VERSION),
  commandKey: varchar("command_key", { length: 255 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 128 }).notNull(),
  sourceFingerprint: varchar("source_fingerprint", { length: 128 }).notNull(),
  paymentMode: text("payment_mode").notNull(),
  state: text("state").notNull().default("active"),
  completenessMarker: boolean("completeness_marker").notNull().default(false),
  payingLineupSize: integer("paying_lineup_size").notNull().default(0),
  expectedResponsibilityCount: integer("expected_responsibility_count").notNull().default(0),
  expectedGroupCount: integer("expected_group_count").notNull().default(0),
  currentRevision: integer("current_revision").notNull().default(1),
  upfrontDueAt: timestamp("upfront_due_at", { withTimezone: true, mode: "string" }),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({ name: "financial_activations_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  commandUnique: uniqueIndex("financial_activations_command_unique").on(table.organizationId, table.commandKey),
  tenantIdentityUnique: uniqueIndex("financial_activations_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  activeLeagueUnique: uniqueIndex("financial_activations_active_league_unique").on(table.organizationId, table.leagueId).where(sql`${table.state} = 'active' AND ${table.completenessMarker} = true`),
  tenantCreatedIdx: index("financial_activations_tenant_created_idx").on(table.organizationId, table.createdAt.desc()),
  versionCheck: check("financial_activations_version_check", sql`${table.activationVersion} = 1 AND ${table.currentRevision} = 1 AND ${table.payingLineupSize} IN (3, 4) AND ${table.expectedGroupCount} > 0 AND ${table.expectedResponsibilityCount} = ${table.expectedGroupCount} * ${table.payingLineupSize}`),
  policyCheck: check("financial_activations_policy_check", sql`${table.policyVersion} = 'eligible-bowlers/1' AND ${table.orderVersion} = 'occurrence-team-slot-bowler/1'`),
  keyCheck: check("financial_activations_key_check", sql`length(btrim(${table.commandKey})) > 0 AND ${table.requestFingerprint} ~ '^lvfinancialactivation:v1:[0-9a-f]{64}$' AND ${table.sourceFingerprint} ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'`),
  paymentModeCheck: check("financial_activations_payment_mode_check", sql`${table.paymentMode} IN ('weekly', 'upfront')`),
  stateCheck: check("financial_activations_state_check", sql`${table.state} = 'active'`),
  completenessCheck: check("financial_activations_completeness_check", sql`${table.state} <> 'active' OR ${table.completenessMarker} = true`),
  upfrontDueCheck: check("financial_activations_upfront_due_check", sql`${table.paymentMode} <> 'upfront' OR ${table.upfrontDueAt} IS NOT NULL`),
}));

export const financialActivationRevisions = pgTable("financial_activation_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  activationId: uuid("activation_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  activationTenantFk: foreignKey({ name: "financial_activation_revisions_parent_fk", columns: [table.activationId, table.organizationId, table.leagueId], foreignColumns: [financialActivations.id, financialActivations.organizationId, financialActivations.leagueId] }).onDelete("restrict"),
  uniqueRevision: uniqueIndex("financial_activation_revisions_unique").on(table.organizationId, table.leagueId, table.activationId, table.revisionNumber),
  revisionCheck: check("financial_activation_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check("financial_activation_revisions_snapshot_check", sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`),
}));

export const financialResponsibilities = pgTable("financial_responsibilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  activationId: uuid("activation_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  teamId: integer("team_id").notNull(),
  slotIndex: integer("slot_index").notNull(),
  payingLineupSize: integer("paying_lineup_size").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  billingTermId: uuid("billing_term_id").notNull(),
  purpose: text("purpose").notNull(),
  billingTermVersion: integer("billing_term_version").notNull(),
  eligibilityId: uuid("eligibility_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }).notNull(),
  pastDueAt: timestamp("past_due_at", { withTimezone: true, mode: "string" }).notNull(),
  role: text("role", { enum: FINANCIAL_RESPONSIBILITY_ROLES }).notNull(),
  provenance: varchar("provenance", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  activationTenantFk: foreignKey({ name: "financial_responsibilities_activation_fk", columns: [table.activationId, table.organizationId, table.leagueId], foreignColumns: [financialActivations.id, financialActivations.organizationId, financialActivations.leagueId] }).onDelete("restrict"),
  occurrenceTenantFk: foreignKey({ name: "financial_responsibilities_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  teamLeagueFk: foreignKey({ name: "financial_responsibilities_team_fk", columns: [table.teamId, table.leagueId], foreignColumns: [teams.id, teams.leagueId] }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({ name: "financial_responsibilities_bowler_fk", columns: [table.bowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  eligibilityFk: foreignKey({ name: "financial_responsibilities_eligibility_fk", columns: [table.eligibilityId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId], foreignColumns: [bowlerOccurrenceEligibilities.id, bowlerOccurrenceEligibilities.organizationId, bowlerOccurrenceEligibilities.leagueId, bowlerOccurrenceEligibilities.occurrenceId, bowlerOccurrenceEligibilities.bowlerId] }).onDelete("restrict"),
  assignmentFk: foreignKey({ name: "financial_responsibilities_assignment_fk", columns: [table.assignmentId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.teamId], foreignColumns: [bowlerOccurrenceTeamAssignments.id, bowlerOccurrenceTeamAssignments.organizationId, bowlerOccurrenceTeamAssignments.leagueId, bowlerOccurrenceTeamAssignments.occurrenceId, bowlerOccurrenceTeamAssignments.bowlerId, bowlerOccurrenceTeamAssignments.teamId] }).onDelete("restrict"),
  obligationFk: foreignKey({ name: "financial_responsibilities_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.purpose, table.amountMinor, table.currency, table.billingTermId, table.billingTermVersion, table.dueAt, table.pastDueAt], foreignColumns: [bowlerOccurrenceObligations.id, bowlerOccurrenceObligations.organizationId, bowlerOccurrenceObligations.leagueId, bowlerOccurrenceObligations.occurrenceId, bowlerOccurrenceObligations.bowlerId, bowlerOccurrenceObligations.purpose, bowlerOccurrenceObligations.amountMinor, bowlerOccurrenceObligations.currency, bowlerOccurrenceObligations.billingTermId, bowlerOccurrenceObligations.billingTermVersion, bowlerOccurrenceObligations.dueAt, bowlerOccurrenceObligations.pastDueAt] }).onDelete("restrict"),
  billingTermFk: foreignKey({ name: "financial_responsibilities_billing_term_fk", columns: [table.billingTermId, table.organizationId, table.leagueId, table.occurrenceId, table.purpose, table.billingTermVersion, table.currency], foreignColumns: [leagueOccurrenceBillingTerms.id, leagueOccurrenceBillingTerms.organizationId, leagueOccurrenceBillingTerms.leagueId, leagueOccurrenceBillingTerms.occurrenceId, leagueOccurrenceBillingTerms.purpose, leagueOccurrenceBillingTerms.version, leagueOccurrenceBillingTerms.currency] }).onDelete("restrict"),
  slotUnique: uniqueIndex("financial_responsibilities_slot_unique").on(table.organizationId, table.leagueId, table.activationId, table.occurrenceId, table.teamId, table.slotIndex),
  bowlerUnique: uniqueIndex("financial_responsibilities_bowler_unique").on(table.organizationId, table.leagueId, table.activationId, table.occurrenceId, table.teamId, table.bowlerId),
  occurrenceIdx: index("financial_responsibilities_occurrence_idx").on(table.organizationId, table.leagueId, table.occurrenceId),
  slotCheck: check("financial_responsibilities_slot_check", sql`${table.slotIndex} BETWEEN 0 AND 3`),
  lineupSizeCheck: check("financial_responsibilities_lineup_size_check", sql`${table.payingLineupSize} IN (3, 4)`),
  roleCheck: check("financial_responsibilities_role_check", sql`${table.role} IN (${roles})`),
  provenanceCheck: check("financial_responsibilities_provenance_check", sql`${table.provenance} = 'explicit_admin_selection'`),
  amountCheck: check("financial_responsibilities_amount_check", sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.billingTermVersion} > 0 AND ${table.purpose} = 'league_weekly_fee'`),
  timingCheck: check("financial_responsibilities_timing_check", sql`${table.pastDueAt} >= ${table.dueAt}`),
}));

export type FinancialActivation = typeof financialActivations.$inferSelect;
export type FinancialActivationRevision = typeof financialActivationRevisions.$inferSelect;
export type FinancialResponsibility = typeof financialResponsibilities.$inferSelect;
