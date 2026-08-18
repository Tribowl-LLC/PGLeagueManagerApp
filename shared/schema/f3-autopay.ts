import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { bowlers } from "./bowlers";
import { financialActivations } from "./financial-activation";
import { leagueOccurrences } from "./canonical-occurrences";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { users } from "./users";
import { bowlerOccurrenceObligations } from "./occurrence-financials";
import { locations } from "./locations";

export const F3_POLICY_STATES = ["draft", "approved", "superseded"] as const;
export type F3PolicyState = (typeof F3_POLICY_STATES)[number];
export const F3_AUTHORIZATION_STATES = ["draft", "authorized", "revoked", "superseded"] as const;
export type F3AuthorizationState = (typeof F3_AUTHORIZATION_STATES)[number];
export const F3_PLAN_STATES = ["draft", "ready", "fulfilled", "cancelled", "superseded", "review_required"] as const;
export type F3PlanState = (typeof F3_PLAN_STATES)[number];

const policyStates = sql.raw(F3_POLICY_STATES.map((s) => `'${s}'`).join(","));
const authStates = sql.raw(F3_AUTHORIZATION_STATES.map((s) => `'${s}'`).join(","));
const planStates = sql.raw(F3_PLAN_STATES.map((s) => `'${s}'`).join(","));

/** Durable administrator-approved collection policy. Rows are immutable
 * versions; an approval never mutates a prior version. */
export const f3CollectionPolicies = pgTable("f3_collection_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  activationId: uuid("activation_id").notNull(),
  activationRevision: integer("activation_revision").notNull(),
  activationSourceFingerprint: varchar("activation_source_fingerprint", { length: 128 }).notNull(),
  policyVersion: integer("policy_version").notNull(),
  policyFingerprint: varchar("policy_fingerprint", { length: 80 }).notNull(),
  state: text("state", { enum: F3_POLICY_STATES }).notNull().default("draft"),
  collectionPoints: jsonb("collection_points").$type<Array<{ occurrenceId: string }>>().notNull(),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  approvedByUserId: integer("approved_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({ name: "f3_policies_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  activationFk: foreignKey({ name: "f3_policies_activation_fk", columns: [table.activationId, table.organizationId, table.leagueId], foreignColumns: [financialActivations.id, financialActivations.organizationId, financialActivations.leagueId] }).onDelete("restrict"),
  versionUnique: uniqueIndex("f3_policies_version_unique").on(table.organizationId, table.leagueId, table.policyVersion),
  tenantIdentityUnique: uniqueIndex("f3_policies_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  fingerprintUnique: uniqueIndex("f3_policies_fingerprint_unique").on(table.organizationId, table.policyFingerprint),
  leagueStateIdx: index("f3_policies_league_state_idx").on(table.organizationId, table.leagueId, table.state),
  versionCheck: check("f3_policies_version_check", sql`${table.policyVersion} > 0 AND ${table.activationRevision} > 0 AND ${table.activationSourceFingerprint} ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'`),
  fingerprintCheck: check("f3_policies_fingerprint_check", sql`${table.policyFingerprint} ~ '^lvf3policy:v1:[0-9a-f]{64}$'`),
  stateCheck: check("f3_policies_state_check", sql`${table.state} IN (${policyStates}) AND (${table.state} <> 'approved' OR (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL))`),
}));

export const f3CollectionPolicyOccurrences = pgTable("f3_collection_policy_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  policyId: uuid("policy_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  groupKey: varchar("group_key", { length: 128 }).notNull(),
  groupRole: text("group_role").notNull(),
  pairedOccurrenceId: uuid("paired_occurrence_id"),
  collectionPointOccurrenceId: uuid("collection_point_occurrence_id").notNull(),
  itemIndex: integer("item_index").notNull(),
}, (table) => ({
  policyFk: foreignKey({ name: "f3_policy_occurrences_policy_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"),
  occurrenceFk: foreignKey({ name: "f3_policy_occurrences_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  collectionPointFk: foreignKey({ name: "f3_policy_occurrences_point_fk", columns: [table.collectionPointOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  occurrenceUnique: uniqueIndex("f3_policy_occurrences_unique").on(table.policyId, table.occurrenceId),
  indexUnique: uniqueIndex("f3_policy_occurrences_index_unique").on(table.policyId, table.itemIndex),
  groupCheck: check("f3_policy_occurrences_group_check", sql`${table.groupRole} IN ('normal','trigger','paired') AND ${table.itemIndex} >= 0 AND ((${table.groupRole} = 'normal' AND ${table.pairedOccurrenceId} IS NULL) OR (${table.groupRole} <> 'normal' AND ${table.pairedOccurrenceId} IS NOT NULL AND ${table.pairedOccurrenceId} <> ${table.occurrenceId}))`),
}));

export const f3CollectionPolicyRevisions = pgTable("f3_collection_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), policyId: uuid("policy_id").notNull(), revisionNumber: integer("revision_number").notNull(), snapshotSchemaVersion: integer("snapshot_schema_version").notNull(), beforeSnapshot: jsonb("before_snapshot"), afterSnapshot: jsonb("after_snapshot").notNull(), recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({ policyFk: foreignKey({ name: "f3_policy_revisions_parent_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"), unique: uniqueIndex("f3_policy_revisions_unique").on(table.organizationId, table.leagueId, table.policyId, table.revisionNumber), shape: check("f3_policy_revisions_shape_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0 AND ((${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL))`) }));

/** Payer-owned authorization. Provider identifiers remain encrypted and are
 * never part of the browser contract or plan fingerprint. */
export const f3PayerAuthorizations = pgTable("f3_payer_autopay_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), payerBowlerId: integer("payer_bowler_id").notNull(), policyId: uuid("policy_id").notNull(), policyVersion: integer("policy_version").notNull(), authorizationVersion: integer("authorization_version").notNull(), authorizationFingerprint: varchar("authorization_fingerprint", { length: 80 }).notNull(), coveredBowlerIds: jsonb("covered_bowler_ids").$type<number[]>().notNull(), acceptedPartnerIds: jsonb("accepted_partner_ids").$type<number[]>().notNull(), collectionPointOccurrenceIds: jsonb("collection_point_occurrence_ids").$type<string[]>().notNull(), locationId: integer("location_id").notNull(), encryptedSourceId: text("encrypted_source_id").notNull(), encryptedCustomerId: text("encrypted_customer_id"), paymentMethodFingerprint: varchar("payment_method_fingerprint", { length: 64 }).notNull(), timing: text("timing").notNull().default("at_collection_point"), state: text("state", { enum: F3_AUTHORIZATION_STATES }).notNull().default("draft"), createdByUserId: integer("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }), authorizedAt: timestamp("authorized_at", { withTimezone: true, mode: "string" }), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({ leagueTenantFk: foreignKey({ name: "f3_auth_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"), payerFk: foreignKey({ name: "f3_auth_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"), locationFk: foreignKey({ name: "f3_auth_location_fk", columns: [table.locationId, table.organizationId], foreignColumns: [locations.id, locations.organizationId] }).onDelete("restrict"), policyFk: foreignKey({ name: "f3_auth_policy_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"), tenantIdentityUnique: uniqueIndex("f3_auth_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId), versionUnique: uniqueIndex("f3_auth_version_unique").on(table.organizationId, table.leagueId, table.payerBowlerId, table.authorizationVersion), activeIdx: index("f3_auth_active_idx").on(table.organizationId, table.leagueId, table.payerBowlerId, table.state), fingerprintCheck: check("f3_auth_fingerprint_check", sql`${table.authorizationFingerprint} ~ '^lvf3auth:v1:[0-9a-f]{64}$' AND ${table.paymentMethodFingerprint} ~ '^[0-9a-f]{64}$' AND ${table.timing} = 'at_collection_point' AND ${table.authorizationVersion} > 0 AND ${table.policyVersion} > 0`), stateCheck: check("f3_auth_state_check", sql`${table.state} IN (${authStates}) AND ((${table.state} = 'authorized' AND ${table.authorizedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.state} <> 'authorized'))`) }));

export const f3AutopayPlans = pgTable("f3_canonical_autopay_plans", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), payerBowlerId: integer("payer_bowler_id").notNull(), policyId: uuid("policy_id").notNull(), policyVersion: integer("policy_version").notNull(), authorizationId: uuid("authorization_id").notNull(), authorizationVersion: integer("authorization_version").notNull(), planVersion: integer("plan_version").notNull(), activationId: uuid("activation_id").notNull(), activationSourceFingerprint: varchar("activation_source_fingerprint", { length: 128 }).notNull(), planFingerprint: varchar("plan_fingerprint", { length: 80 }).notNull(), state: text("state", { enum: F3_PLAN_STATES }).notNull().default("draft"), collectionPoints: jsonb("collection_points").$type<string[]>().notNull(), totalAmountMinor: integer("total_amount_minor").notNull(), currency: varchar("currency", { length: 3 }).notNull().default("USD"), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(), readyAt: timestamp("ready_at", { withTimezone: true, mode: "string" }), cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "string" }),
}, (table) => ({ leagueTenantFk: foreignKey({ name: "f3_plans_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"), payerFk: foreignKey({ name: "f3_plans_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"), policyFk: foreignKey({ name: "f3_plans_policy_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"), authFk: foreignKey({ name: "f3_plans_auth_fk", columns: [table.authorizationId, table.organizationId, table.leagueId], foreignColumns: [f3PayerAuthorizations.id, f3PayerAuthorizations.organizationId, f3PayerAuthorizations.leagueId] }).onDelete("restrict"), activationFk: foreignKey({ name: "f3_plans_activation_fk", columns: [table.activationId, table.organizationId, table.leagueId], foreignColumns: [financialActivations.id, financialActivations.organizationId, financialActivations.leagueId] }).onDelete("restrict"), tenantIdentityUnique: uniqueIndex("f3_plans_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId), uniqueVersion: uniqueIndex("f3_plans_version_unique").on(table.organizationId, table.leagueId, table.payerBowlerId, table.planVersion), stateIdx: index("f3_plans_state_idx").on(table.organizationId, table.leagueId, table.state), fingerprintCheck: check("f3_plans_fingerprint_check", sql`${table.planFingerprint} ~ '^lvf3plan:v1:[0-9a-f]{64}$' AND ${table.totalAmountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.planVersion} > 0`), stateCheck: check("f3_plans_state_check", sql`${table.state} IN (${planStates}) AND ((${table.state} = 'ready' AND ${table.readyAt} IS NOT NULL) OR ${table.state} <> 'ready')`) }));

export const f3AutopayPlanItems = pgTable("f3_canonical_autopay_plan_items", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), planId: uuid("plan_id").notNull(), obligationId: uuid("obligation_id").notNull(), occurrenceId: uuid("occurrence_id").notNull(), bowlerId: integer("bowler_id").notNull(), collectionPointOccurrenceId: uuid("collection_point_occurrence_id").notNull(), amountMinor: integer("amount_minor").notNull(), currency: varchar("currency", { length: 3 }).notNull().default("USD"), itemIndex: integer("item_index").notNull(),
}, (table) => ({ planFk: foreignKey({ name: "f3_plan_items_plan_fk", columns: [table.planId, table.organizationId, table.leagueId], foreignColumns: [f3AutopayPlans.id, f3AutopayPlans.organizationId, f3AutopayPlans.leagueId] }).onDelete("restrict"), obligationFk: foreignKey({ name: "f3_plan_items_obligation_fk", columns: [table.obligationId, table.organizationId, table.leagueId, table.occurrenceId, table.bowlerId, table.currency], foreignColumns: [bowlerOccurrenceObligations.id, bowlerOccurrenceObligations.organizationId, bowlerOccurrenceObligations.leagueId, bowlerOccurrenceObligations.occurrenceId, bowlerOccurrenceObligations.bowlerId, bowlerOccurrenceObligations.currency] }).onDelete("restrict"), occurrenceFk: foreignKey({ name: "f3_plan_items_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"), pointFk: foreignKey({ name: "f3_plan_items_point_fk", columns: [table.collectionPointOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"), bowlerFk: foreignKey({ name: "f3_plan_items_bowler_fk", columns: [table.bowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"), uniqueObligation: uniqueIndex("f3_plan_items_obligation_unique").on(table.planId, table.obligationId), uniqueIndex: uniqueIndex("f3_plan_items_index_unique").on(table.planId, table.itemIndex), amountCheck: check("f3_plan_items_amount_check", sql`${table.amountMinor} > 0 AND ${table.itemIndex} >= 0 AND ${table.currency} = 'USD'`) }));

export type F3CollectionPolicy = typeof f3CollectionPolicies.$inferSelect;
export type F3CollectionPolicyOccurrence = typeof f3CollectionPolicyOccurrences.$inferSelect;
export type F3PayerAuthorization = typeof f3PayerAuthorizations.$inferSelect;
export type F3AutopayPlan = typeof f3AutopayPlans.$inferSelect;
export type F3AutopayPlanItem = typeof f3AutopayPlanItems.$inferSelect;
