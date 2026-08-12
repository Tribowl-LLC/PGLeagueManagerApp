import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { bowlers } from "./bowlers";
import {
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
} from "./canonical-occurrences";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { paymentOperations } from "./payment-operations";
import { payments } from "./payments";
import { teams } from "./teams";
import { users } from "./users";

export const BOWLER_OCCURRENCE_ELIGIBILITY_STATES = ["eligible", "ineligible"] as const;
export type BowlerOccurrenceEligibilityState =
  (typeof BOWLER_OCCURRENCE_ELIGIBILITY_STATES)[number];

export const BOWLER_OCCURRENCE_TEAM_ASSIGNMENT_STATES = ["assigned", "released"] as const;
export type BowlerOccurrenceTeamAssignmentState =
  (typeof BOWLER_OCCURRENCE_TEAM_ASSIGNMENT_STATES)[number];

export const BOWLER_OCCURRENCE_OBLIGATION_STATES = [
  "open",
  "partially_settled",
  "settled",
  "voided",
] as const;
export type BowlerOccurrenceObligationState =
  (typeof BOWLER_OCCURRENCE_OBLIGATION_STATES)[number];

export const OCCURRENCE_COLLECTION_PLAN_STATES = [
  "draft",
  "ready",
  "fulfilled",
  "cancelled",
  "superseded",
] as const;
export type OccurrenceCollectionPlanState =
  (typeof OCCURRENCE_COLLECTION_PLAN_STATES)[number];

export const PAYMENT_OCCURRENCE_ALLOCATION_STATES = ["active", "voided"] as const;
export type PaymentOccurrenceAllocationState =
  (typeof PAYMENT_OCCURRENCE_ALLOCATION_STATES)[number];

export const PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_VERSION = 1;

const eligibilityStates = sql.raw(
  BOWLER_OCCURRENCE_ELIGIBILITY_STATES.map((value) => `'${value}'`).join(", "),
);
const assignmentStates = sql.raw(
  BOWLER_OCCURRENCE_TEAM_ASSIGNMENT_STATES.map((value) => `'${value}'`).join(", "),
);
const obligationStates = sql.raw(
  BOWLER_OCCURRENCE_OBLIGATION_STATES.map((value) => `'${value}'`).join(", "),
);
const planStates = sql.raw(
  OCCURRENCE_COLLECTION_PLAN_STATES.map((value) => `'${value}'`).join(", "),
);
const allocationStates = sql.raw(
  PAYMENT_OCCURRENCE_ALLOCATION_STATES.map((value) => `'${value}'`).join(", "),
);

export const bowlerOccurrenceEligibilities = pgTable("bowler_occurrence_eligibilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  state: text("state", { enum: BOWLER_OCCURRENCE_ELIGIBILITY_STATES }).notNull(),
  reason: text("reason").notNull(),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  occurrenceTenantFk: foreignKey({
    name: "bowler_eligibilities_occurrence_tenant_fk",
    columns: [table.occurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({
    name: "bowler_eligibilities_bowler_tenant_fk",
    columns: [table.bowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("bowler_eligibilities_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  logicalUnique: uniqueIndex("bowler_eligibilities_logical_unique")
    .on(table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId),
  leagueStateIdx: index("bowler_eligibilities_league_state_idx")
    .on(table.organizationId, table.leagueId, table.state),
  occurrenceIdx: index("bowler_eligibilities_occurrence_idx")
    .on(table.organizationId, table.leagueId, table.occurrenceId),
  bowlerIdx: index("bowler_eligibilities_bowler_idx")
    .on(table.organizationId, table.bowlerId),
  stateCheck: check("bowler_eligibilities_state_check", sql`${table.state} IN (${eligibilityStates})`),
  reasonCheck: check(
    "bowler_eligibilities_reason_check",
    sql`length(${table.reason}) > 0 AND btrim(${table.reason}) = ${table.reason}`,
  ),
  revisionCheck: check("bowler_eligibilities_revision_check", sql`${table.currentRevision} > 0`),
}));

export const bowlerOccurrenceEligibilityRevisions = pgTable("bowler_occurrence_eligibility_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  eligibilityId: uuid("eligibility_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  eligibilityTenantFk: foreignKey({
    name: "bowler_eligibility_revisions_parent_fk",
    columns: [table.eligibilityId, table.organizationId, table.leagueId],
    foreignColumns: [bowlerOccurrenceEligibilities.id, bowlerOccurrenceEligibilities.organizationId, bowlerOccurrenceEligibilities.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("bowler_eligibility_revisions_unique")
    .on(table.organizationId, table.leagueId, table.eligibilityId, table.revisionNumber),
  parentIdx: index("bowler_eligibility_revisions_parent_idx").on(table.eligibilityId),
  revisionCheck: check(
    "bowler_eligibility_revisions_revision_check",
    sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`,
  ),
  snapshotCheck: check(
    "bowler_eligibility_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL)
      OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const bowlerOccurrenceTeamAssignments = pgTable("bowler_occurrence_team_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  teamId: integer("team_id").notNull(),
  state: text("state", { enum: BOWLER_OCCURRENCE_TEAM_ASSIGNMENT_STATES }).notNull().default("assigned"),
  reason: text("reason").notNull(),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  occurrenceTenantFk: foreignKey({
    name: "bowler_team_assignments_occurrence_tenant_fk",
    columns: [table.occurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({
    name: "bowler_team_assignments_bowler_tenant_fk",
    columns: [table.bowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  teamLeagueFk: foreignKey({
    name: "bowler_team_assignments_team_league_fk",
    columns: [table.teamId, table.leagueId],
    foreignColumns: [teams.id, teams.leagueId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("bowler_team_assignments_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  logicalUnique: uniqueIndex("bowler_team_assignments_logical_unique")
    .on(table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId),
  leagueStateIdx: index("bowler_team_assignments_league_state_idx")
    .on(table.organizationId, table.leagueId, table.state),
  occurrenceIdx: index("bowler_team_assignments_occurrence_idx")
    .on(table.organizationId, table.leagueId, table.occurrenceId),
  bowlerIdx: index("bowler_team_assignments_bowler_idx")
    .on(table.organizationId, table.bowlerId),
  teamIdx: index("bowler_team_assignments_team_idx").on(table.leagueId, table.teamId),
  stateCheck: check("bowler_team_assignments_state_check", sql`${table.state} IN (${assignmentStates})`),
  reasonCheck: check(
    "bowler_team_assignments_reason_check",
    sql`length(${table.reason}) > 0 AND btrim(${table.reason}) = ${table.reason}`,
  ),
  revisionCheck: check("bowler_team_assignments_revision_check", sql`${table.currentRevision} > 0`),
}));

export const bowlerOccurrenceTeamAssignmentRevisions = pgTable("bowler_occurrence_team_assignment_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  assignmentTenantFk: foreignKey({
    name: "bowler_team_assignment_revisions_parent_fk",
    columns: [table.assignmentId, table.organizationId, table.leagueId],
    foreignColumns: [bowlerOccurrenceTeamAssignments.id, bowlerOccurrenceTeamAssignments.organizationId, bowlerOccurrenceTeamAssignments.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("bowler_team_assignment_revisions_unique")
    .on(table.organizationId, table.leagueId, table.assignmentId, table.revisionNumber),
  parentIdx: index("bowler_team_assignment_revisions_parent_idx").on(table.assignmentId),
  revisionCheck: check(
    "bowler_team_assignment_revisions_revision_check",
    sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`,
  ),
  snapshotCheck: check(
    "bowler_team_assignment_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL)
      OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const bowlerOccurrenceObligations = pgTable("bowler_occurrence_obligations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  purpose: text("purpose").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  state: text("state", { enum: BOWLER_OCCURRENCE_OBLIGATION_STATES }).notNull().default("open"),
  billingTermId: uuid("billing_term_id"),
  billingTermVersion: integer("billing_term_version"),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  occurrenceTenantFk: foreignKey({
    name: "bowler_obligations_occurrence_tenant_fk",
    columns: [table.occurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  bowlerTenantFk: foreignKey({
    name: "bowler_obligations_bowler_tenant_fk",
    columns: [table.bowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  billingTermTenantFk: foreignKey({
    name: "bowler_obligations_billing_term_tenant_fk",
    columns: [
      table.billingTermId,
      table.organizationId,
      table.leagueId,
      table.occurrenceId,
      table.purpose,
      table.billingTermVersion,
      table.currency,
    ],
    foreignColumns: [
      leagueOccurrenceBillingTerms.id,
      leagueOccurrenceBillingTerms.organizationId,
      leagueOccurrenceBillingTerms.leagueId,
      leagueOccurrenceBillingTerms.occurrenceId,
      leagueOccurrenceBillingTerms.purpose,
      leagueOccurrenceBillingTerms.version,
      leagueOccurrenceBillingTerms.currency,
    ],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("bowler_obligations_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  settlementReferenceUnique: uniqueIndex("bowler_obligations_settlement_reference_unique")
    .on(table.id, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.currency),
  logicalCurrentUnique: uniqueIndex("bowler_obligations_logical_current_unique")
    .on(table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.purpose),
  leagueStateIdx: index("bowler_obligations_league_state_idx")
    .on(table.organizationId, table.leagueId, table.state),
  occurrenceIdx: index("bowler_obligations_occurrence_idx")
    .on(table.organizationId, table.leagueId, table.occurrenceId),
  bowlerIdx: index("bowler_obligations_bowler_idx").on(table.organizationId, table.bowlerId),
  billingTermIdx: index("bowler_obligations_billing_term_idx").on(table.billingTermId),
  amountCheck: check("bowler_obligations_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: check("bowler_obligations_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  purposeCheck: check(
    "bowler_obligations_purpose_check",
    sql`${table.purpose} = 'league_weekly_fee'`,
  ),
  stateCheck: check("bowler_obligations_state_check", sql`${table.state} IN (${obligationStates})`),
  billingTermCheck: check(
    "bowler_obligations_billing_term_check",
    sql`(${table.billingTermId} IS NULL) = (${table.billingTermVersion} IS NULL)
      AND (${table.billingTermVersion} IS NULL OR ${table.billingTermVersion} > 0)`,
  ),
  revisionCheck: check("bowler_obligations_revision_check", sql`${table.currentRevision} > 0`),
}));

export const bowlerOccurrenceObligationRevisions = pgTable("bowler_occurrence_obligation_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  obligationTenantFk: foreignKey({
    name: "bowler_obligation_revisions_parent_fk",
    columns: [table.obligationId, table.organizationId, table.leagueId],
    foreignColumns: [bowlerOccurrenceObligations.id, bowlerOccurrenceObligations.organizationId, bowlerOccurrenceObligations.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("bowler_obligation_revisions_unique")
    .on(table.organizationId, table.leagueId, table.obligationId, table.revisionNumber),
  parentIdx: index("bowler_obligation_revisions_parent_idx").on(table.obligationId),
  revisionCheck: check(
    "bowler_obligation_revisions_revision_check",
    sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`,
  ),
  snapshotCheck: check(
    "bowler_obligation_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL)
      OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const occurrenceCollectionPlans = pgTable("occurrence_collection_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  planKey: varchar("plan_key", { length: 128 }).notNull(),
  triggerOccurrenceId: uuid("trigger_occurrence_id"),
  collectAt: timestamp("collect_at", { withTimezone: true, mode: "string" }),
  currency: varchar("currency", { length: 3 }).notNull(),
  state: text("state", { enum: OCCURRENCE_COLLECTION_PLAN_STATES }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({
    name: "collection_plans_league_tenant_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  triggerOccurrenceTenantFk: foreignKey({
    name: "collection_plans_trigger_occurrence_tenant_fk",
    columns: [table.triggerOccurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("collection_plans_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId, table.currency),
  tenantReferenceUnique: uniqueIndex("collection_plans_tenant_reference_unique")
    .on(table.id, table.organizationId, table.leagueId),
  versionUnique: uniqueIndex("collection_plans_key_version_unique")
    .on(table.organizationId, table.leagueId, table.planKey, table.version),
  currentKeyUnique: uniqueIndex("collection_plans_current_key_unique")
    .on(table.organizationId, table.leagueId, table.planKey)
    .where(sql`${table.state} <> 'superseded'`),
  leagueStateIdx: index("collection_plans_league_state_idx")
    .on(table.organizationId, table.leagueId, table.state),
  triggerIdx: index("collection_plans_trigger_idx").on(table.triggerOccurrenceId),
  collectAtIdx: index("collection_plans_collect_at_idx")
    .on(table.organizationId, table.leagueId, table.collectAt),
  collectionPointCheck: check(
    "collection_plans_collection_point_check",
    sql`(${table.triggerOccurrenceId} IS NULL) <> (${table.collectAt} IS NULL)`,
  ),
  currencyCheck: check("collection_plans_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  stateCheck: check("collection_plans_state_check", sql`${table.state} IN (${planStates})`),
  versionCheck: check(
    "collection_plans_version_check",
    sql`${table.version} > 0 AND ${table.currentRevision} > 0`,
  ),
  keyCheck: check(
    "collection_plans_key_check",
    sql`length(${table.planKey}) > 0 AND btrim(${table.planKey}) = ${table.planKey}`,
  ),
}));

export const occurrenceCollectionPlanItems = pgTable("occurrence_collection_plan_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  planId: uuid("plan_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  itemIndex: integer("item_index").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  planTenantFk: foreignKey({
    name: "collection_plan_items_plan_tenant_fk",
    columns: [table.planId, table.organizationId, table.leagueId, table.currency],
    foreignColumns: [occurrenceCollectionPlans.id, occurrenceCollectionPlans.organizationId, occurrenceCollectionPlans.leagueId, occurrenceCollectionPlans.currency],
  }).onDelete("restrict"),
  obligationTenantFk: foreignKey({
    name: "collection_plan_items_obligation_tenant_fk",
    columns: [table.obligationId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.currency],
    foreignColumns: [bowlerOccurrenceObligations.id, bowlerOccurrenceObligations.organizationId, bowlerOccurrenceObligations.leagueId, bowlerOccurrenceObligations.occurrenceId, bowlerOccurrenceObligations.bowlerId, bowlerOccurrenceObligations.currency],
  }).onDelete("restrict"),
  planItemIndexUnique: uniqueIndex("collection_plan_items_index_unique").on(table.planId, table.itemIndex),
  planObligationUnique: uniqueIndex("collection_plan_items_obligation_unique")
    .on(table.planId, table.obligationId),
  planIdx: index("collection_plan_items_plan_idx").on(table.organizationId, table.leagueId, table.planId),
  obligationIdx: index("collection_plan_items_obligation_idx").on(table.obligationId),
  occurrenceIdx: index("collection_plan_items_occurrence_idx").on(table.occurrenceId),
  bowlerIdx: index("collection_plan_items_bowler_idx").on(table.organizationId, table.bowlerId),
  amountCheck: check(
    "collection_plan_items_amount_check",
    sql`${table.amountMinor} > 0 AND ${table.itemIndex} >= 0`,
  ),
  currencyCheck: check("collection_plan_items_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
}));

export const occurrenceCollectionPlanRevisions = pgTable("occurrence_collection_plan_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  planId: uuid("plan_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  planTenantFk: foreignKey({
    name: "collection_plan_revisions_parent_fk",
    columns: [table.planId, table.organizationId, table.leagueId],
    foreignColumns: [occurrenceCollectionPlans.id, occurrenceCollectionPlans.organizationId, occurrenceCollectionPlans.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("collection_plan_revisions_unique")
    .on(table.organizationId, table.leagueId, table.planId, table.revisionNumber),
  parentIdx: index("collection_plan_revisions_parent_idx").on(table.planId),
  revisionCheck: check(
    "collection_plan_revisions_revision_check",
    sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`,
  ),
  snapshotCheck: check(
    "collection_plan_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL)
      OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const paymentOccurrenceAllocations = pgTable("payment_occurrence_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  state: text("state", { enum: PAYMENT_OCCURRENCE_ALLOCATION_STATES }).notNull().default("active"),
  allocationKey: varchar("allocation_key", { length: 128 }).notNull(),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  paymentBowlerLeagueFk: foreignKey({
    name: "payment_occurrence_allocations_payment_fk",
    columns: [table.paymentId, table.bowlerId, table.leagueId],
    foreignColumns: [payments.id, payments.bowlerId, payments.leagueId],
  }).onDelete("restrict"),
  obligationTenantFk: foreignKey({
    name: "payment_occurrence_allocations_obligation_fk",
    columns: [table.obligationId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.currency],
    foreignColumns: [bowlerOccurrenceObligations.id, bowlerOccurrenceObligations.organizationId, bowlerOccurrenceObligations.leagueId, bowlerOccurrenceObligations.occurrenceId, bowlerOccurrenceObligations.bowlerId, bowlerOccurrenceObligations.currency],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("payment_occurrence_allocations_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  logicalUnique: uniqueIndex("payment_occurrence_allocations_logical_unique")
    .on(table.paymentId, table.obligationId),
  tenantKeyUnique: uniqueIndex("payment_occurrence_allocations_key_unique")
    .on(table.organizationId, table.allocationKey),
  leagueStateIdx: index("payment_occurrence_allocations_league_state_idx")
    .on(table.organizationId, table.leagueId, table.state),
  paymentIdx: index("payment_occurrence_allocations_payment_idx").on(table.paymentId),
  obligationIdx: index("payment_occurrence_allocations_obligation_idx").on(table.obligationId),
  occurrenceIdx: index("payment_occurrence_allocations_occurrence_idx").on(table.occurrenceId),
  bowlerIdx: index("payment_occurrence_allocations_bowler_idx").on(table.organizationId, table.bowlerId),
  amountCheck: check("payment_occurrence_allocations_amount_check", sql`${table.amountMinor} > 0`),
  currencyCheck: check("payment_occurrence_allocations_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  stateCheck: check("payment_occurrence_allocations_state_check", sql`${table.state} IN (${allocationStates})`),
  keyCheck: check(
    "payment_occurrence_allocations_key_check",
    sql`length(${table.allocationKey}) > 0 AND btrim(${table.allocationKey}) = ${table.allocationKey}`,
  ),
  revisionCheck: check("payment_occurrence_allocations_revision_check", sql`${table.currentRevision} > 0`),
}));

export const paymentOccurrenceAllocationRevisions = pgTable("payment_occurrence_allocation_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  allocationTenantFk: foreignKey({
    name: "payment_occurrence_allocation_revisions_parent_fk",
    columns: [table.allocationId, table.organizationId, table.leagueId],
    foreignColumns: [paymentOccurrenceAllocations.id, paymentOccurrenceAllocations.organizationId, paymentOccurrenceAllocations.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("payment_occurrence_allocation_revisions_unique")
    .on(table.organizationId, table.leagueId, table.allocationId, table.revisionNumber),
  parentIdx: index("payment_occurrence_allocation_revisions_parent_idx").on(table.allocationId),
  revisionCheck: check(
    "payment_occurrence_allocation_revisions_revision_check",
    sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`,
  ),
  snapshotCheck: check(
    "payment_occurrence_allocation_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL)
      OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const paymentOperationOccurrenceSnapshots = pgTable("payment_operation_occurrence_snapshots", {
  operationId: uuid("operation_id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_VERSION),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 80 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  allocationCount: integer("allocation_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationTenantCurrencyFk: foreignKey({
    name: "payment_occurrence_snapshots_operation_fk",
    columns: [table.operationId, table.organizationId, table.currency],
    foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.currency],
  }).onDelete("restrict"),
  leagueTenantFk: foreignKey({
    name: "payment_occurrence_snapshots_league_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  tenantVersionUnique: uniqueIndex("payment_occurrence_snapshots_tenant_version_unique")
    .on(table.operationId, table.organizationId, table.leagueId, table.snapshotVersion, table.currency),
  leagueIdx: index("payment_occurrence_snapshots_league_idx")
    .on(table.organizationId, table.leagueId, table.createdAt.desc()),
  versionCheck: check(
    "payment_occurrence_snapshots_version_check",
    sql`${table.snapshotVersion} = ${sql.raw(String(PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_VERSION))}`,
  ),
  fingerprintCheck: check(
    "payment_occurrence_snapshots_fingerprint_check",
    sql`${table.snapshotFingerprint} ~ '^lvpayocc:v1:[0-9a-f]{64}$'`,
  ),
  amountCheck: check(
    "payment_occurrence_snapshots_amount_check",
    sql`${table.amountMinor} > 0 AND ${table.allocationCount} > 0`,
  ),
  currencyCheck: check("payment_occurrence_snapshots_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
}));

export const paymentOperationOccurrenceSnapshotAllocations = pgTable("payment_operation_occurrence_snapshot_allocations", {
  operationId: uuid("operation_id").notNull(),
  allocationIndex: integer("allocation_index").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
}, (table) => ({
  pk: primaryKey({
    name: "payment_occurrence_snapshot_allocations_pk",
    columns: [table.operationId, table.allocationIndex],
  }),
  snapshotTenantFk: foreignKey({
    name: "payment_occurrence_snapshot_allocations_snapshot_fk",
    columns: [table.operationId, table.organizationId, table.leagueId, table.snapshotVersion, table.currency],
    foreignColumns: [paymentOperationOccurrenceSnapshots.operationId, paymentOperationOccurrenceSnapshots.organizationId, paymentOperationOccurrenceSnapshots.leagueId, paymentOperationOccurrenceSnapshots.snapshotVersion, paymentOperationOccurrenceSnapshots.currency],
  }).onDelete("restrict"),
  obligationTenantFk: foreignKey({
    name: "payment_occurrence_snapshot_allocations_obligation_fk",
    columns: [table.obligationId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.currency],
    foreignColumns: [bowlerOccurrenceObligations.id, bowlerOccurrenceObligations.organizationId, bowlerOccurrenceObligations.leagueId, bowlerOccurrenceObligations.occurrenceId, bowlerOccurrenceObligations.bowlerId, bowlerOccurrenceObligations.currency],
  }).onDelete("restrict"),
  operationObligationUnique: uniqueIndex("payment_occurrence_snapshot_allocations_obligation_unique")
    .on(table.operationId, table.obligationId),
  occurrenceIdx: index("payment_occurrence_snapshot_allocations_occurrence_idx").on(table.occurrenceId),
  bowlerIdx: index("payment_occurrence_snapshot_allocations_bowler_idx")
    .on(table.organizationId, table.bowlerId),
  obligationIdx: index("payment_occurrence_snapshot_allocations_obligation_idx").on(table.obligationId),
  amountCheck: check(
    "payment_occurrence_snapshot_allocations_amount_check",
    sql`${table.allocationIndex} >= 0 AND ${table.amountMinor} > 0`,
  ),
  currencyCheck: check(
    "payment_occurrence_snapshot_allocations_currency_check",
    sql`${table.currency} ~ '^[A-Z]{3}$'`,
  ),
}));

export type BowlerOccurrenceEligibility = typeof bowlerOccurrenceEligibilities.$inferSelect;
export type BowlerOccurrenceEligibilityRevision = typeof bowlerOccurrenceEligibilityRevisions.$inferSelect;
export type BowlerOccurrenceTeamAssignment = typeof bowlerOccurrenceTeamAssignments.$inferSelect;
export type BowlerOccurrenceTeamAssignmentRevision = typeof bowlerOccurrenceTeamAssignmentRevisions.$inferSelect;
export type BowlerOccurrenceObligation = typeof bowlerOccurrenceObligations.$inferSelect;
export type BowlerOccurrenceObligationRevision = typeof bowlerOccurrenceObligationRevisions.$inferSelect;
export type OccurrenceCollectionPlan = typeof occurrenceCollectionPlans.$inferSelect;
export type OccurrenceCollectionPlanItem = typeof occurrenceCollectionPlanItems.$inferSelect;
export type OccurrenceCollectionPlanRevision = typeof occurrenceCollectionPlanRevisions.$inferSelect;
export type PaymentOccurrenceAllocation = typeof paymentOccurrenceAllocations.$inferSelect;
export type PaymentOccurrenceAllocationRevision = typeof paymentOccurrenceAllocationRevisions.$inferSelect;
export type PaymentOperationOccurrenceSnapshot = typeof paymentOperationOccurrenceSnapshots.$inferSelect;
export type PaymentOperationOccurrenceSnapshotAllocation =
  typeof paymentOperationOccurrenceSnapshotAllocations.$inferSelect;
