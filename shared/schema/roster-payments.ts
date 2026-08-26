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
import { canonicalCollectionGroupMembers, canonicalCollectionGroups } from "./canonical-collection-groups";
import { leagues } from "./leagues";
import { locations } from "./locations";
import { organizations } from "./organizations";
import { paymentOperations } from "./payment-operations";
import { payments } from "./payments";
import { teams } from "./teams";
import { users } from "./users";
import { bowlerPaymentLinks } from "./bowler-payment-links";

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
export const AUTOPAY_CONSENT_PAYMENT_MODES = ["weekly"] as const;
export type AutopayConsentPaymentMode = (typeof AUTOPAY_CONSENT_PAYMENT_MODES)[number];
export const ROSTER_OPERATION_SNAPSHOT_KINDS = ["interactive", "standing_autopay"] as const;
export type RosterOperationSnapshotKind = (typeof ROSTER_OPERATION_SNAPSHOT_KINDS)[number];
export const ROSTER_OPERATION_SNAPSHOT_VERSION = 2 as const;
export const ROSTER_OPERATION_REQUEST_KINDS = ["direct", "order"] as const;
export type RosterOperationRequestKind = (typeof ROSTER_OPERATION_REQUEST_KINDS)[number];
export const ROSTER_OPERATION_SOURCE_KINDS = ["new_card", "saved_card", "wallet"] as const;
export type RosterOperationSourceKind = (typeof ROSTER_OPERATION_SOURCE_KINDS)[number];
export const STANDING_COLLECTION_MODES = ["weekly", "double_pay"] as const;
export type StandingCollectionMode = (typeof STANDING_COLLECTION_MODES)[number];

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
const consentPaymentModes = sql.raw(AUTOPAY_CONSENT_PAYMENT_MODES.map((value) => `'${value}'`).join(", "));
const snapshotKinds = sql.raw(ROSTER_OPERATION_SNAPSHOT_KINDS.map((value) => `'${value}'`).join(", "));
const collectionModes = sql.raw(STANDING_COLLECTION_MODES.map((value) => `'${value}'`).join(", "));
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
  paymentMode: text("payment_mode", { enum: AUTOPAY_CONSENT_PAYMENT_MODES }).notNull().default("weekly"),
  consentFingerprint: varchar("consent_fingerprint", { length: 128 }).notNull(),
  providerName: varchar("provider_name", { length: 32 }),
  providerLocationId: varchar("provider_location_id", { length: 255 }),
  encryptedSourceId: text("encrypted_source_id"),
  encryptedCustomerId: text("encrypted_customer_id"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "autopay_consents_league_tenant_fk"),
  payerFk: foreignKey({ name: "autopay_consents_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  versionUnique: uniqueIndex("autopay_consents_version_unique").on(table.organizationId, table.leagueId, table.payerBowlerId, table.consentVersion),
  activeUnique: uniqueIndex("autopay_consents_active_unique").on(table.organizationId, table.leagueId, table.payerBowlerId).where(sql`${table.state} = 'active'`),
  tenantIdentityUnique: uniqueIndex("autopay_consents_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  identityUnique: uniqueIndex("autopay_consents_identity_unique").on(table.id, table.organizationId, table.leagueId, table.payerBowlerId, table.consentVersion),
  fingerprintUnique: uniqueIndex("autopay_consents_fingerprint_unique").on(table.organizationId, table.leagueId, table.payerBowlerId, table.consentFingerprint),
  stateCheck: check("autopay_consents_state_check", sql`${table.state} IN (${consentStates}) AND ${table.paymentMode} IN (${consentPaymentModes}) AND ${table.consentVersion} > 0 AND ${table.consentFingerprint} ~ '^lvstandingconsent:v1:[0-9a-f]{64}$'`),
  stateShapeCheck: check("autopay_consents_state_shape_check", sql`(
    (${table.state} = 'pending' AND ${table.revokedAt} IS NULL)
    OR (${table.state} = 'active' AND ${table.providerName} IS NOT NULL AND ${table.providerLocationId} IS NOT NULL AND ${table.encryptedSourceId} IS NOT NULL AND ${table.encryptedCustomerId} IS NOT NULL AND ${table.revokedAt} IS NULL)
    OR (${table.state} IN ('revoked', 'expired') AND ${table.providerName} IS NOT NULL AND ${table.providerLocationId} IS NOT NULL AND ${table.encryptedSourceId} IS NOT NULL AND ${table.encryptedCustomerId} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)
  )`),
  providerNameCheck: check("autopay_consents_provider_name_check", sql`${table.providerName} IS NULL OR ${table.providerName} ~ '^[a-z0-9][a-z0-9_-]{0,31}$'`),
  providerLocationCheck: check("autopay_consents_provider_location_check", sql`${table.providerLocationId} IS NULL OR length(btrim(${table.providerLocationId})) > 0`),
}));

/** Explicit same-tenant accepted-partner evidence captured by one standing consent version. */
export const autopayConsentPartners = pgTable("autopay_consent_partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  consentId: uuid("consent_id").notNull(),
  consentVersion: integer("consent_version").notNull(),
  partnerBowlerId: integer("partner_bowler_id").notNull(),
  paymentLinkId: integer("payment_link_id").notNull(),
  linkFingerprint: varchar("link_fingerprint", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: leagueTenantFk(table, "autopay_consent_partners_league_tenant_fk"),
  consentFk: foreignKey({ name: "autopay_consent_partners_consent_fk", columns: [table.consentId, table.organizationId, table.leagueId], foreignColumns: [autopayConsents.id, autopayConsents.organizationId, autopayConsents.leagueId] }).onDelete("restrict"),
  partnerFk: foreignKey({ name: "autopay_consent_partners_bowler_fk", columns: [table.partnerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  linkFk: foreignKey({ name: "autopay_consent_partners_link_fk", columns: [table.paymentLinkId, table.organizationId], foreignColumns: [bowlerPaymentLinks.id, bowlerPaymentLinks.organizationId] }).onDelete("restrict"),
  identityUnique: uniqueIndex("autopay_consent_partners_identity_unique").on(table.id, table.organizationId, table.leagueId),
  partnerUnique: uniqueIndex("autopay_consent_partners_partner_unique").on(table.organizationId, table.leagueId, table.consentId, table.consentVersion, table.partnerBowlerId),
  versionCheck: check("autopay_consent_partners_version_check", sql`${table.consentVersion} > 0 AND ${table.linkFingerprint} ~ '^lvpartnerlink:v1:[0-9a-f]{64}$'`),
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

export interface RosterOperationLineItem {
  lineItemIndex: number;
  catalogObjectId: string;
  quantity: string;
}

/** One immutable execution snapshot for either an interactive or standing operation. */
export const paymentOperationRosterSnapshots = pgTable("payment_operation_roster_snapshots", {
  operationId: uuid("operation_id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(ROSTER_OPERATION_SNAPSHOT_VERSION),
  snapshotKind: text("snapshot_kind", { enum: ROSTER_OPERATION_SNAPSHOT_KINDS }).notNull().default("interactive"),
  collectionMode: text("collection_mode", { enum: STANDING_COLLECTION_MODES }),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true, mode: "string" }),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  obligations: jsonb("obligations").notNull(),
  // Interactive provider request evidence. Standing operations keep these
  // fields NULL; their consent/binding tables own automatic-payment source
  // and provider-location authorization.
  locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
  providerLocationId: varchar("provider_location_id", { length: 255 }),
  payerBowlerId: integer("payer_bowler_id").references(() => bowlers.id, { onDelete: "restrict" }),
  requestKind: text("request_kind", { enum: ROSTER_OPERATION_REQUEST_KINDS }),
  encryptedSourceId: text("encrypted_source_id"),
  encryptedCustomerId: text("encrypted_customer_id"),
  encryptedBuyerEmail: text("encrypted_buyer_email"),
  storeCard: boolean("store_card").notNull().default(false),
  sourceKind: text("source_kind", { enum: ROSTER_OPERATION_SOURCE_KINDS }),
  weekOf: timestamp("week_of", { withTimezone: true, mode: "string" }),
  combinedChargeGroupId: varchar("combined_charge_group_id", { length: 128 }),
  quoteFingerprint: varchar("quote_fingerprint", { length: 84 }),
  lineItems: jsonb("line_items").$type<RosterOperationLineItem[]>().notNull().default(sql`'[]'::jsonb`),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationFk: foreignKey({ name: "payment_operation_roster_snapshots_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  leagueTenantFk: leagueTenantFk(table, "payment_operation_roster_snapshots_league_tenant_fk"),
  tenantIdentityUnique: uniqueIndex("payment_operation_roster_snapshots_tenant_identity_unique").on(table.operationId, table.organizationId, table.leagueId),
  versionUnique: uniqueIndex("payment_operation_roster_snapshots_version_unique").on(table.operationId, table.organizationId, table.leagueId, table.snapshotVersion),
  amountCheck: check("payment_operation_roster_snapshots_amount_check", sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.snapshotVersion} = ${sql.raw(String(ROSTER_OPERATION_SNAPSHOT_VERSION))} AND ${table.snapshotKind} IN (${snapshotKinds}) AND ((${table.snapshotKind} = 'interactive' AND ${table.collectionMode} IS NULL AND ${table.cutoffAt} IS NULL AND ${table.requestKind} IN ('direct', 'order') AND ${table.encryptedSourceId} IS NOT NULL AND ${table.payerBowlerId} IS NOT NULL AND ${table.weekOf} IS NOT NULL AND ${table.sourceKind} IN ('new_card', 'saved_card', 'wallet')) OR (${table.snapshotKind} = 'standing_autopay' AND ${table.collectionMode} IN (${collectionModes}) AND ${table.cutoffAt} IS NOT NULL AND ${table.requestKind} IS NULL AND ${table.encryptedSourceId} IS NULL AND ${table.payerBowlerId} IS NULL AND ${table.weekOf} IS NULL AND ${table.sourceKind} IS NULL))`),
  fingerprintCheck: check("payment_operation_roster_snapshots_fingerprint_check", sql`${table.snapshotFingerprint} ~ '^lv(rosterexec|standingcutoff):v1:[0-9a-f]{64}$'`),
  quoteFingerprintCheck: check("payment_operation_roster_snapshots_quote_fingerprint_check", sql`${table.quoteFingerprint} IS NULL OR ${table.quoteFingerprint} ~ '^lvrosterquote:v1:[0-9a-f]{64}$'`),
  requestShapeCheck: check("payment_operation_roster_snapshots_request_shape_check", sql`(${table.requestKind} = 'direct' AND ${table.lineItems} = '[]'::jsonb OR ${table.requestKind} = 'order' AND jsonb_array_length(${table.lineItems}) BETWEEN 1 AND 25 AND ${table.providerLocationId} IS NOT NULL OR ${table.requestKind} IS NULL AND ${table.lineItems} = '[]'::jsonb AND ${table.providerLocationId} IS NULL)`),
  groupIdCheck: check("payment_operation_roster_snapshots_group_id_check", sql`${table.combinedChargeGroupId} IS NULL OR length(${table.combinedChargeGroupId}) > 0`),
}));

/** Unambiguous operation-to-consent identity and cutoff evidence. */
export const paymentOperationStandingAutopayBindings = pgTable("payment_operation_standing_autopay_bindings", {
  operationId: uuid("operation_id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  consentId: uuid("consent_id").notNull(),
  consentVersion: integer("consent_version").notNull(),
  providerName: varchar("provider_name", { length: 32 }).notNull(),
  providerLocationId: varchar("provider_location_id", { length: 255 }).notNull(),
  triggerOccurrenceId: uuid("trigger_occurrence_id").notNull(),
  pairedOccurrenceId: uuid("paired_occurrence_id"),
  collectionGroupId: uuid("collection_group_id"),
  collectionGroupRevision: integer("collection_group_revision"),
  collectionGroupFingerprint: varchar("collection_group_fingerprint", { length: 128 }),
  triggerMemberId: uuid("trigger_member_id"),
  pairedMemberId: uuid("paired_member_id"),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true, mode: "string" }).notNull(),
  collectionMode: text("collection_mode", { enum: STANDING_COLLECTION_MODES }).notNull(),
  evidenceFingerprint: varchar("evidence_fingerprint", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId] }).onDelete("restrict"),
  consentFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_consent_fk", columns: [table.consentId, table.organizationId, table.leagueId], foreignColumns: [autopayConsents.id, autopayConsents.organizationId, autopayConsents.leagueId] }).onDelete("restrict"),
  triggerOccurrenceFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_trigger_occurrence_fk", columns: [table.triggerOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  pairedOccurrenceFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_paired_occurrence_fk", columns: [table.pairedOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  collectionGroupFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_group_fk", columns: [table.collectionGroupId, table.organizationId, table.leagueId], foreignColumns: [canonicalCollectionGroups.id, canonicalCollectionGroups.organizationId, canonicalCollectionGroups.leagueId] }).onDelete("restrict"),
  triggerMemberFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_trigger_member_fk", columns: [table.triggerMemberId, table.organizationId, table.leagueId], foreignColumns: [canonicalCollectionGroupMembers.id, canonicalCollectionGroupMembers.organizationId, canonicalCollectionGroupMembers.leagueId] }).onDelete("restrict"),
  pairedMemberFk: foreignKey({ name: "payment_operation_standing_autopay_bindings_paired_member_fk", columns: [table.pairedMemberId, table.organizationId, table.leagueId], foreignColumns: [canonicalCollectionGroupMembers.id, canonicalCollectionGroupMembers.organizationId, canonicalCollectionGroupMembers.leagueId] }).onDelete("restrict"),
  identityUnique: uniqueIndex("payment_operation_standing_autopay_bindings_identity_unique").on(table.operationId, table.organizationId, table.leagueId),
  versionCheck: check("payment_operation_standing_autopay_bindings_version_check", sql`${table.consentVersion} > 0 AND ${table.evidenceFingerprint} ~ '^lvstandingcutoff:v1:[0-9a-f]{64}$' AND ${table.providerName} ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND length(btrim(${table.providerLocationId})) > 0 AND ((${table.collectionGroupId} IS NULL AND ${table.collectionGroupRevision} IS NULL AND ${table.collectionGroupFingerprint} IS NULL AND ${table.pairedOccurrenceId} IS NULL AND ${table.triggerMemberId} IS NULL AND ${table.pairedMemberId} IS NULL) OR (${table.collectionGroupId} IS NOT NULL AND ${table.collectionGroupRevision} IS NOT NULL AND ${table.collectionGroupRevision} > 0 AND ${table.collectionGroupFingerprint} ~ '^lvcollectiongroup:v1:[0-9a-f]{64}$' AND ${table.pairedOccurrenceId} IS NOT NULL AND ${table.triggerMemberId} IS NOT NULL AND ${table.pairedMemberId} IS NOT NULL))`),
  collectionModeCheck: check("payment_operation_standing_autopay_bindings_collection_mode_check", sql`${table.collectionMode} IN ('weekly', 'double_pay')`),
}));

/** Participant/link evidence for each automatic operation. */
export const paymentOperationStandingAutopayParticipants = pgTable("payment_operation_standing_autopay_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  allocationIndex: integer("allocation_index").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  bowlerId: integer("bowler_id").notNull(),
  role: text("role", { enum: ["payer", "partner"] as const }).notNull(),
  paymentLinkId: integer("payment_link_id"),
  linkFingerprint: varchar("link_fingerprint", { length: 128 }),
  consentVersion: integer("consent_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationFk: foreignKey({ name: "payment_operation_standing_autopay_participants_operation_fk", columns: [table.operationId, table.organizationId, table.leagueId], foreignColumns: [paymentOperationStandingAutopayBindings.operationId, paymentOperationStandingAutopayBindings.organizationId, paymentOperationStandingAutopayBindings.leagueId] }).onDelete("restrict"),
  bowlerFk: foreignKey({ name: "payment_operation_standing_autopay_participants_bowler_fk", columns: [table.bowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  linkFk: foreignKey({ name: "payment_operation_standing_autopay_participants_link_fk", columns: [table.paymentLinkId, table.organizationId], foreignColumns: [bowlerPaymentLinks.id, bowlerPaymentLinks.organizationId] }).onDelete("restrict"),
  obligationFk: foreignKey({ name: "payment_operation_standing_autopay_participants_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId], foreignColumns: [paymentObligations.id, paymentObligations.organizationId, paymentObligations.leagueId] }).onDelete("restrict"),
  identityUnique: uniqueIndex("payment_operation_standing_autopay_participants_identity_unique").on(table.id, table.organizationId, table.leagueId),
  allocationUnique: uniqueIndex("payment_operation_standing_autopay_participants_allocation_unique").on(table.operationId, table.organizationId, table.leagueId, table.allocationIndex),
  roleCheck: check("payment_operation_standing_autopay_participants_role_check", sql`(${table.role} = 'payer' AND ${table.paymentLinkId} IS NULL AND ${table.linkFingerprint} IS NULL) OR (${table.role} = 'partner' AND ${table.paymentLinkId} IS NOT NULL AND ${table.linkFingerprint} ~ '^lvpartnerlink:v1:[0-9a-f]{64}$')`),
  versionCheck: check("payment_operation_standing_autopay_participants_version_check", sql`${table.consentVersion} > 0 AND ${table.allocationIndex} >= 0 AND ${table.obligationId} IS NOT NULL`),
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
  // Finalized items are immutable provider evidence, not live reservations.
  // They must not prevent a later exact operation from collecting a remaining
  // partial balance on the same obligation.
  activeObligationUnique: uniqueIndex("payment_operation_roster_snapshot_items_active_obligation_unique").on(table.organizationId, table.leagueId, table.obligationId).where(sql`${table.state} = 'reserved'`),
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
export type AutopayConsentPartner = typeof autopayConsentPartners.$inferSelect;
export type FinancialCommand = typeof financialCommands.$inferSelect;
export type PaymentOperationRosterSnapshot = typeof paymentOperationRosterSnapshots.$inferSelect;
export type PaymentOperationRosterSnapshotItem = typeof paymentOperationRosterSnapshotItems.$inferSelect;
export type PaymentOperationStandingAutopayBinding = typeof paymentOperationStandingAutopayBindings.$inferSelect;
export type PaymentOperationStandingAutopayParticipant = typeof paymentOperationStandingAutopayParticipants.$inferSelect;
