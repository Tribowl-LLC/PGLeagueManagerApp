import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  boolean,
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
import { paymentOperations } from "./payment-operations";
import { payments } from "./payments";
import { teams } from "./teams";
import { users } from "./users";

/** The slot is deliberately not inferred from a roster membership. */
export const TEAM_PAYMENT_SLOT_OCCUPANTS = ["unassigned", "main", "vacant"] as const;
export type TeamPaymentSlotOccupant = (typeof TEAM_PAYMENT_SLOT_OCCUPANTS)[number];

export const TEAM_PAYMENT_POLICIES = ["main_pays_full", "sub_pays_full", "special_split"] as const;
export type TeamPaymentPolicy = (typeof TEAM_PAYMENT_POLICIES)[number];

export const RESPONSIBILITY_KINDS = ["main", "substitute", "split", "vacant"] as const;
export type ResponsibilityKind = (typeof RESPONSIBILITY_KINDS)[number];
export const OBLIGATION_COMPONENTS = ["full", "lineage", "prize"] as const;
export type ObligationComponent = (typeof OBLIGATION_COMPONENTS)[number];

export const RESPONSIBILITY_STATES = ["active", "voided"] as const;
export type ResponsibilityState = (typeof RESPONSIBILITY_STATES)[number];

export const OBLIGATION_STATES = ["open", "partially_settled", "settled", "voided"] as const;
export type PaymentObligationState = (typeof OBLIGATION_STATES)[number];

export const ALLOCATION_STATES = ["active", "voided"] as const;
export type PaymentAllocationState = (typeof ALLOCATION_STATES)[number];

export const AUTOPAY_CONSENT_STATES = ["pending", "active", "revoked", "expired"] as const;
export type AutopayConsentState = (typeof AUTOPAY_CONSENT_STATES)[number];

export const FINANCIAL_COMMAND_STATES = ["accepted", "rejected", "applied", "failed"] as const;
export type FinancialCommandState = (typeof FINANCIAL_COMMAND_STATES)[number];

const slotOccupants = sql.raw(TEAM_PAYMENT_SLOT_OCCUPANTS.map((value) => `'${value}'`).join(", "));
const policies = sql.raw(TEAM_PAYMENT_POLICIES.map((value) => `'${value}'`).join(", "));
const responsibilityKinds = sql.raw(RESPONSIBILITY_KINDS.map((value) => `'${value}'`).join(", "));
const responsibilityStates = sql.raw(RESPONSIBILITY_STATES.map((value) => `'${value}'`).join(", "));
const obligationStates = sql.raw(OBLIGATION_STATES.map((value) => `'${value}'`).join(", "));
const obligationComponents = sql.raw(OBLIGATION_COMPONENTS.map((value) => `'${value}'`).join(", "));
const allocationStates = sql.raw(ALLOCATION_STATES.map((value) => `'${value}'`).join(", "));
const consentStates = sql.raw(AUTOPAY_CONSENT_STATES.map((value) => `'${value}'`).join(", "));
const commandStates = sql.raw(FINANCIAL_COMMAND_STATES.map((value) => `'${value}'`).join(", "));

const leagueTenantFk = (table: { leagueId: AnyPgColumn; organizationId: AnyPgColumn }, name: string) =>
  foreignKey({ name, columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict");

/** Stable 0..lineupSize-1 slots. A slot can be explicitly VACANT. */
export const teamPaymentSlots = pgTable("team_payment_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  teamId: integer("team_id").notNull(),
  slotIndex: integer("slot_index").notNull(),
  lineupSize: integer("lineup_size").notNull(),
  occupant: text("occupant", { enum: TEAM_PAYMENT_SLOT_OCCUPANTS }).notNull().default("unassigned"),
  mainBowlerId: integer("main_bowler_id"),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "team_payment_slots_league_tenant_fk"),
  teamFk: foreignKey({ name: "team_payment_slots_team_fk", columns: [table.teamId, table.leagueId], foreignColumns: [teams.id, teams.leagueId] }).onDelete("restrict"),
  bowlerFk: foreignKey({ name: "team_payment_slots_bowler_fk", columns: [table.mainBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("team_payment_slots_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  slotIdentityUnique: uniqueIndex("team_payment_slots_slot_identity_unique").on(table.id, table.organizationId, table.leagueId, table.teamId, table.slotIndex),
  teamSlotUnique: uniqueIndex("team_payment_slots_team_slot_unique").on(table.organizationId, table.leagueId, table.teamId, table.slotIndex),
  mainBowlerUnique: uniqueIndex("team_payment_slots_main_bowler_unique").on(table.organizationId, table.leagueId, table.mainBowlerId).where(sql`${table.occupant} = 'main' AND ${table.mainBowlerId} IS NOT NULL`),
  slotCheck: check("team_payment_slots_slot_check", sql`${table.slotIndex} >= 0 AND ${table.slotIndex} < ${table.lineupSize} AND ${table.lineupSize} IN (3, 4)`),
  occupantCheck: check("team_payment_slots_occupant_check", sql`${table.occupant} IN (${slotOccupants}) AND ((${table.occupant} = 'main' AND ${table.mainBowlerId} IS NOT NULL) OR (${table.occupant} <> 'main' AND ${table.mainBowlerId} IS NULL))`),
  revisionCheck: check("team_payment_slots_revision_check", sql`${table.currentRevision} > 0`),
}));

export const teamPaymentSlotRevisions = pgTable("team_payment_slot_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  slotId: uuid("slot_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  parentFk: foreignKey({ name: "team_payment_slot_revisions_parent_fk", columns: [table.slotId, table.organizationId, table.leagueId], foreignColumns: [teamPaymentSlots.id, teamPaymentSlots.organizationId, teamPaymentSlots.leagueId] }).onDelete("restrict"),
  unique: uniqueIndex("team_payment_slot_revisions_unique").on(table.organizationId, table.leagueId, table.slotId, table.revisionNumber),
  revisionCheck: check("team_payment_slot_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ((${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL))`),
}));

export const teamPaymentPolicies = pgTable("team_payment_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  teamId: integer("team_id").notNull(),
  defaultPolicy: text("default_policy", { enum: TEAM_PAYMENT_POLICIES }).notNull().default("main_pays_full"),
  currentRevision: integer("current_revision").notNull().default(1),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "team_payment_policies_league_tenant_fk"),
  teamFk: foreignKey({ name: "team_payment_policies_team_fk", columns: [table.teamId, table.leagueId], foreignColumns: [teams.id, teams.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("team_payment_policies_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  teamUnique: uniqueIndex("team_payment_policies_team_unique").on(table.organizationId, table.leagueId, table.teamId),
  policyCheck: check("team_payment_policies_policy_check", sql`${table.defaultPolicy} IN (${policies}) AND ${table.currentRevision} > 0`),
}));

export const teamPaymentPolicyRevisions = pgTable("team_payment_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  policyId: uuid("policy_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  parentFk: foreignKey({ name: "team_payment_policy_revisions_parent_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [teamPaymentPolicies.id, teamPaymentPolicies.organizationId, teamPaymentPolicies.leagueId] }).onDelete("restrict"),
  unique: uniqueIndex("team_payment_policy_revisions_unique").on(table.organizationId, table.leagueId, table.policyId, table.revisionNumber),
  revisionCheck: check("team_payment_policy_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ((${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL))`),
}));

/** One resolved responsibility version; never mutate a financial identity. */
export const occurrencePaymentResponsibilities = pgTable("occurrence_payment_responsibilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  teamId: integer("team_id").notNull(),
  slotId: uuid("slot_id").notNull(),
  slotIndex: integer("slot_index").notNull(),
  positionIndex: integer("position_index").notNull(),
  responsibilityKey: uuid("responsibility_key").notNull().defaultRandom(),
  version: integer("version").notNull().default(1),
  state: text("state", { enum: RESPONSIBILITY_STATES }).notNull().default("active"),
  responsibilityKind: text("responsibility_kind", { enum: RESPONSIBILITY_KINDS }).notNull(),
  mainBowlerId: integer("main_bowler_id"),
  substituteBowlerId: integer("substitute_bowler_id"),
  payerBowlerId: integer("payer_bowler_id"),
  lineagePayerBowlerId: integer("lineage_payer_bowler_id"),
  prizePayerBowlerId: integer("prize_payer_bowler_id"),
  policy: text("policy", { enum: TEAM_PAYMENT_POLICIES }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  lineageAmountMinor: integer("lineage_amount_minor"),
  prizeFundAmountMinor: integer("prize_fund_amount_minor"),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }).notNull(),
  pastDueAt: timestamp("past_due_at", { withTimezone: true, mode: "string" }).notNull(),
  assignmentNote: text("assignment_note"),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "occurrence_payment_responsibilities_league_tenant_fk"),
  occurrenceFk: foreignKey({ name: "occurrence_payment_responsibilities_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  teamFk: foreignKey({ name: "occurrence_payment_responsibilities_team_fk", columns: [table.teamId, table.leagueId], foreignColumns: [teams.id, teams.leagueId] }).onDelete("restrict"),
  slotFk: foreignKey({ name: "occurrence_payment_responsibilities_slot_fk", columns: [table.slotId, table.organizationId, table.leagueId, table.teamId, table.slotIndex], foreignColumns: [teamPaymentSlots.id, teamPaymentSlots.organizationId, teamPaymentSlots.leagueId, teamPaymentSlots.teamId, teamPaymentSlots.slotIndex] }).onDelete("restrict"),
  mainFk: foreignKey({ name: "occurrence_payment_responsibilities_main_fk", columns: [table.mainBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  substituteFk: foreignKey({ name: "occurrence_payment_responsibilities_substitute_fk", columns: [table.substituteBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  payerFk: foreignKey({ name: "occurrence_payment_responsibilities_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  lineagePayerFk: foreignKey({ name: "occurrence_payment_responsibilities_lineage_payer_fk", columns: [table.lineagePayerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  prizePayerFk: foreignKey({ name: "occurrence_payment_responsibilities_prize_payer_fk", columns: [table.prizePayerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  versionUnique: uniqueIndex("occurrence_payment_responsibilities_version_unique").on(table.organizationId, table.leagueId, table.occurrenceId, table.teamId, table.slotIndex, table.positionIndex, table.version),
  slotIdentityUnique: uniqueIndex("occurrence_payment_responsibilities_slot_identity_unique").on(table.id, table.organizationId, table.leagueId, table.teamId, table.slotIndex),
  tenantIdentityUnique: uniqueIndex("occurrence_payment_responsibilities_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  currentUnique: uniqueIndex("occurrence_payment_responsibilities_current_unique").on(table.organizationId, table.leagueId, table.occurrenceId, table.teamId, table.slotIndex, table.positionIndex).where(sql`${table.state} = 'active'`),
  keyUnique: uniqueIndex("occurrence_payment_responsibilities_key_unique").on(table.organizationId, table.responsibilityKey, table.version),
  occurrenceIdx: index("occurrence_payment_responsibilities_occurrence_idx").on(table.organizationId, table.leagueId, table.occurrenceId),
  payerIdx: index("occurrence_payment_responsibilities_payer_idx").on(table.organizationId, table.leagueId, table.payerBowlerId),
  stateCheck: check("occurrence_payment_responsibilities_state_check", sql`${table.state} IN (${responsibilityStates}) AND ${table.version} > 0`),
  positionCheck: check("occurrence_payment_responsibilities_position_check", sql`${table.slotIndex} >= 0 AND ${table.positionIndex} >= 0 AND ${table.positionIndex} < 4`),
  kindCheck: check("occurrence_payment_responsibilities_kind_check", sql`${table.responsibilityKind} IN (${responsibilityKinds}) AND ((
    ${table.responsibilityKind} = 'vacant' AND ${table.mainBowlerId} IS NULL AND ${table.substituteBowlerId} IS NULL AND ${table.payerBowlerId} IS NULL AND ${table.amountMinor} = 0 AND ${table.lineageAmountMinor} IS NULL AND ${table.prizeFundAmountMinor} IS NULL
  ) OR (
    ${table.responsibilityKind} = 'main' AND ${table.mainBowlerId} IS NOT NULL AND ${table.substituteBowlerId} IS NULL AND ${table.payerBowlerId} = ${table.mainBowlerId} AND ${table.amountMinor} > 0
  ) OR (
    ${table.responsibilityKind} = 'substitute' AND ${table.mainBowlerId} IS NOT NULL AND ${table.substituteBowlerId} IS NOT NULL AND ${table.mainBowlerId} <> ${table.substituteBowlerId} AND ${table.payerBowlerId} IS NOT NULL AND ${table.amountMinor} > 0
  ) OR (
    ${table.responsibilityKind} = 'split' AND ${table.mainBowlerId} IS NOT NULL AND ${table.substituteBowlerId} IS NOT NULL AND ${table.mainBowlerId} <> ${table.substituteBowlerId} AND ${table.payerBowlerId} IS NOT NULL AND ${table.amountMinor} > 0
  )) AND ((${table.responsibilityKind} = 'split' AND ${table.lineagePayerBowlerId} IS NOT NULL AND ${table.prizePayerBowlerId} IS NOT NULL AND ${table.lineageAmountMinor} IS NOT NULL AND ${table.prizeFundAmountMinor} IS NOT NULL AND ${table.lineageAmountMinor} >= 0 AND ${table.prizeFundAmountMinor} >= 0 AND ${table.lineageAmountMinor} + ${table.prizeFundAmountMinor} = ${table.amountMinor} AND ${table.amountMinor} > 0) OR (${table.responsibilityKind} <> 'split' AND ${table.lineagePayerBowlerId} IS NULL AND ${table.prizePayerBowlerId} IS NULL AND ${table.lineageAmountMinor} IS NULL AND ${table.prizeFundAmountMinor} IS NULL))`),
  amountCheck: check("occurrence_payment_responsibilities_amount_check", sql`${table.amountMinor} >= 0 AND ${table.currency} = 'USD' AND ${table.pastDueAt} >= ${table.dueAt}`),
}));

export const paymentObligations = pgTable("payment_obligations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  responsibilityId: uuid("responsibility_id").notNull(),
  component: text("component", { enum: OBLIGATION_COMPONENTS }).notNull().default("full"),
  payerBowlerId: integer("payer_bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }).notNull(),
  pastDueAt: timestamp("past_due_at", { withTimezone: true, mode: "string" }).notNull(),
  state: text("state", { enum: OBLIGATION_STATES }).notNull().default("open"),
  voidedAt: timestamp("voided_at", { withTimezone: true, mode: "string" }),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "payment_obligations_league_tenant_fk"),
  occurrenceFk: foreignKey({ name: "payment_obligations_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  responsibilityFk: foreignKey({ name: "payment_obligations_responsibility_fk", columns: [table.responsibilityId, table.organizationId, table.leagueId], foreignColumns: [occurrencePaymentResponsibilities.id, occurrencePaymentResponsibilities.organizationId, occurrencePaymentResponsibilities.leagueId] }).onDelete("restrict"),
  payerFk: foreignKey({ name: "payment_obligations_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("payment_obligations_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  responsibilityUnique: uniqueIndex("payment_obligations_responsibility_unique").on(table.organizationId, table.leagueId, table.responsibilityId, table.component),
  openIdx: index("payment_obligations_open_idx").on(table.organizationId, table.leagueId, table.state, table.dueAt),
  payerIdx: index("payment_obligations_payer_idx").on(table.organizationId, table.leagueId, table.payerBowlerId, table.state),
  stateCheck: check("payment_obligations_state_check", sql`${table.state} IN (${obligationStates}) AND ${table.component} IN (${obligationComponents}) AND ((${table.state} = 'voided' AND ${table.voidedAt} IS NOT NULL) OR (${table.state} <> 'voided' AND ${table.voidedAt} IS NULL))`),
  amountCheck: check("payment_obligations_amount_check", sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.pastDueAt} >= ${table.dueAt}`),
}));

/** Allocation corrections are represented by new rows; provider/payment facts remain immutable. */
export const paymentAllocations = pgTable("payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  state: text("state", { enum: ALLOCATION_STATES }).notNull().default("active"),
  supersedesAllocationId: uuid("supersedes_allocation_id"),
  correctionReason: text("correction_reason"),
  reviewRequired: boolean("review_required").notNull().default(false),
  reviewReason: text("review_reason"),
  recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "payment_allocations_league_tenant_fk"),
  paymentFk: foreignKey({ name: "payment_allocations_payment_fk", columns: [table.paymentId, table.leagueId], foreignColumns: [payments.id, payments.leagueId] }).onDelete("restrict"),
  obligationFk: foreignKey({ name: "payment_allocations_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId] }).onDelete("restrict"),
  supersedesFk: foreignKey({ name: "payment_allocations_supersedes_fk", columns: [table.supersedesAllocationId, table.organizationId, table.leagueId], foreignColumns: [table.id, table.organizationId, table.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("payment_allocations_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  paymentIdx: index("payment_allocations_payment_idx").on(table.organizationId, table.leagueId, table.paymentId),
  obligationIdx: index("payment_allocations_obligation_idx").on(table.organizationId, table.leagueId, table.obligationId),
  amountCheck: check("payment_allocations_amount_check", sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD'`),
  stateCheck: check("payment_allocations_state_check", sql`${table.state} IN (${allocationStates}) AND (${table.state} = 'voided' OR ${table.supersedesAllocationId} IS NULL OR ${table.correctionReason} IS NOT NULL)`),
}));

/** Standing-consent evidence for PR2. This table is intentionally dormant in PR1. */
export const autopayConsents = pgTable("autopay_consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  payerBowlerId: integer("payer_bowler_id").notNull(),
  consentVersion: integer("consent_version").notNull().default(1),
  state: text("state", { enum: AUTOPAY_CONSENT_STATES }).notNull().default("pending"),
  providerName: varchar("provider_name", { length: 32 }),
  encryptedSourceId: text("encrypted_source_id"),
  encryptedCustomerId: text("encrypted_customer_id"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "autopay_consents_league_tenant_fk"),
  payerFk: foreignKey({ name: "autopay_consents_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  versionUnique: uniqueIndex("autopay_consents_version_unique").on(table.organizationId, table.leagueId, table.payerBowlerId, table.consentVersion),
  activeUnique: uniqueIndex("autopay_consents_active_unique").on(table.organizationId, table.leagueId, table.payerBowlerId).where(sql`${table.state} = 'active'`),
  stateCheck: check("autopay_consents_state_check", sql`${table.state} IN (${consentStates}) AND ${table.consentVersion} > 0`),
}));

/** Idempotent command/audit ledger. Commands never make provider calls in a transaction. */
export const financialCommands = pgTable("financial_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  commandType: varchar("command_type", { length: 96 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 128 }).notNull(),
  state: text("state", { enum: FINANCIAL_COMMAND_STATES }).notNull().default("accepted"),
  result: jsonb("result"),
  errorCode: varchar("error_code", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "financial_commands_league_tenant_fk"),
  idempotencyUnique: uniqueIndex("financial_commands_idempotency_unique").on(table.organizationId, table.leagueId, table.commandType, table.idempotencyKey),
  createdIdx: index("financial_commands_created_idx").on(table.organizationId, table.leagueId, table.createdAt.desc()),
  stateCheck: check("financial_commands_state_check", sql`${table.state} IN (${commandStates}) AND length(btrim(${table.commandType})) > 0 AND length(btrim(${table.idempotencyKey})) > 0 AND length(btrim(${table.requestFingerprint})) > 0`),
}));

// The operation ledger stays general-purpose. PR2 may attach immutable exact
// obligation snapshots without introducing another provider-side ledger.
export const paymentOperationRosterSnapshots = pgTable("payment_operation_roster_snapshots", {
  operationId: uuid("operation_id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(1),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  obligations: jsonb("obligations").notNull(),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationFk: foreignKey({ name: "payment_operation_roster_snapshots_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "payment_operation_roster_snapshots_league_tenant_fk"),
  tenantIdentityUnique: uniqueIndex("payment_operation_roster_snapshots_tenant_identity_unique").on(table.operationId, table.organizationId, table.leagueId),
  versionUnique: uniqueIndex("payment_operation_roster_snapshots_version_unique").on(table.operationId, table.organizationId, table.leagueId, table.snapshotVersion),
  amountCheck: check("payment_operation_roster_snapshots_amount_check", sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.snapshotVersion} > 0`),
}));

/** Exact obligation reservations made before provider I/O.  The partial
 * uniqueness rule is the concurrency boundary: an obligation can belong to
 * only one unresolved provider operation at a time. */
export const paymentOperationRosterSnapshotItems = pgTable("payment_operation_roster_snapshot_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  allocationIndex: integer("allocation_index").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  state: text("state", { enum: ["reserved", "finalized", "released"] as const }).notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationFk: foreignKey({ name: "payment_operation_roster_snapshot_items_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperationRosterSnapshots.operationId, paymentOperationRosterSnapshots.organizationId, paymentOperationRosterSnapshots.leagueId] }).onDelete("restrict"),
  obligationFk: foreignKey({ name: "payment_operation_roster_snapshot_items_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "payment_operation_roster_snapshot_items_league_tenant_fk"),
  operationItemUnique: uniqueIndex("payment_operation_roster_snapshot_items_operation_item_unique").on(table.operationId, table.organizationId, table.leagueId, table.obligationId),
  operationAllocationIndexUnique: uniqueIndex("payment_operation_roster_snapshot_items_operation_allocation_index_unique").on(table.operationId, table.organizationId, table.leagueId, table.allocationIndex),
  activeObligationUnique: uniqueIndex("payment_operation_roster_snapshot_items_active_obligation_unique").on(table.organizationId, table.leagueId, table.obligationId).where(sql`${table.state} IN ('reserved', 'finalized')`),
  index: index("payment_operation_roster_snapshot_items_obligation_idx").on(table.organizationId, table.leagueId, table.obligationId, table.state),
  amountCheck: check("payment_operation_roster_snapshot_items_amount_check", sql`${table.amountMinor} > 0 AND ${table.allocationIndex} >= 0 AND ${table.state} IN ('reserved', 'finalized', 'released')`),
}));

export type TeamPaymentSlot = typeof teamPaymentSlots.$inferSelect;
export type TeamPaymentSlotRevision = typeof teamPaymentSlotRevisions.$inferSelect;
export type TeamPaymentPolicyRow = typeof teamPaymentPolicies.$inferSelect;
export type TeamPaymentPolicyRevision = typeof teamPaymentPolicyRevisions.$inferSelect;
export type OccurrencePaymentResponsibility = typeof occurrencePaymentResponsibilities.$inferSelect;
export type PaymentObligation = typeof paymentObligations.$inferSelect;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type AutopayConsent = typeof autopayConsents.$inferSelect;
export type FinancialCommand = typeof financialCommands.$inferSelect;
export type PaymentOperationRosterSnapshot = typeof paymentOperationRosterSnapshots.$inferSelect;
export type PaymentOperationRosterSnapshotItem = typeof paymentOperationRosterSnapshotItems.$inferSelect;
