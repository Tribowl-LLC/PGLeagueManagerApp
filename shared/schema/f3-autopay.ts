import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { bowlers } from "./bowlers";
import { financialActivations } from "./financial-activation";
import { leagueOccurrences } from "./canonical-occurrences";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { users } from "./users";
import { bowlerOccurrenceObligations, occurrenceCollectionPlans } from "./occurrence-financials";
import { locations } from "./locations";

export const F3_POLICY_STATES = ["draft", "approved", "superseded"] as const;
export type F3PolicyState = (typeof F3_POLICY_STATES)[number];
export const F3_AUTHORIZATION_STATES = ["draft", "authorized", "revoked", "superseded"] as const;
export type F3AuthorizationState = (typeof F3_AUTHORIZATION_STATES)[number];

const policyStates = sql.raw(F3_POLICY_STATES.map((s) => `'${s}'`).join(","));
const authStates = sql.raw(F3_AUTHORIZATION_STATES.map((s) => `'${s}'`).join(","));

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
  commandKey: varchar("command_key", { length: 255 }).notNull(),
  state: text("state", { enum: F3_POLICY_STATES }).notNull().default("draft"),
  currentRevision: integer("current_revision").notNull().default(1),
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
  commandUnique: uniqueIndex("f3_policies_command_unique").on(table.organizationId, table.leagueId, table.commandKey),
  currentApprovedUnique: uniqueIndex("f3_policies_current_approved_unique").on(table.organizationId, table.leagueId).where(sql`${table.state} = 'approved'`),
  leagueStateIdx: index("f3_policies_league_state_idx").on(table.organizationId, table.leagueId, table.state),
  versionCheck: check("f3_policies_version_check", sql`${table.policyVersion} > 0 AND ${table.activationRevision} > 0 AND ${table.activationSourceFingerprint} ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'`),
  fingerprintCheck: check("f3_policies_fingerprint_check", sql`${table.policyFingerprint} ~ '^lvf3policy:v1:[0-9a-f]{64}$' AND length(btrim(${table.commandKey})) > 0`),
  stateCheck: check("f3_policies_state_check", sql`${table.state} IN (${policyStates}) AND ${table.currentRevision} > 0 AND f3_json_array_shape(${table.collectionPoints}, 'occurrence-object') AND ((${table.state} = 'draft' AND ${table.approvedByUserId} IS NULL AND ${table.approvedAt} IS NULL) OR (${table.state} IN ('approved','superseded') AND ${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL))`),
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
  pairedOccurrenceFk: foreignKey({ name: "f3_policy_occurrences_pair_fk", columns: [table.pairedOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  occurrenceUnique: uniqueIndex("f3_policy_occurrences_unique").on(table.policyId, table.occurrenceId),
  indexUnique: uniqueIndex("f3_policy_occurrences_index_unique").on(table.policyId, table.itemIndex),
  groupCheck: check("f3_policy_occurrences_group_check", sql`length(btrim(${table.groupKey})) > 0 AND ${table.groupRole} IN ('normal','trigger','paired') AND ${table.itemIndex} >= 0 AND ((${table.groupRole} = 'normal' AND ${table.pairedOccurrenceId} IS NULL) OR (${table.groupRole} <> 'normal' AND ${table.pairedOccurrenceId} IS NOT NULL AND ${table.pairedOccurrenceId} <> ${table.occurrenceId}))`),
}));

export const f3CollectionPolicyRevisions = pgTable("f3_collection_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), policyId: uuid("policy_id").notNull(), revisionNumber: integer("revision_number").notNull(), snapshotSchemaVersion: integer("snapshot_schema_version").notNull(), beforeSnapshot: jsonb("before_snapshot"), afterSnapshot: jsonb("after_snapshot").notNull(), recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({ policyFk: foreignKey({ name: "f3_policy_revisions_parent_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"), unique: uniqueIndex("f3_policy_revisions_unique").on(table.organizationId, table.leagueId, table.policyId, table.revisionNumber), shape: check("f3_policy_revisions_shape_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0 AND ((${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL))`) }));

/** Payer-owned authorization. Provider identifiers remain encrypted and are
 * never part of the browser contract or plan fingerprint. */
export const f3PayerAuthorizations = pgTable("f3_payer_autopay_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), payerBowlerId: integer("payer_bowler_id").notNull(), policyId: uuid("policy_id").notNull(), policyVersion: integer("policy_version").notNull(), authorizationVersion: integer("authorization_version").notNull(), authorizationFingerprint: varchar("authorization_fingerprint", { length: 80 }).notNull(), preauthorizationQuoteFingerprint: varchar("preauthorization_quote_fingerprint", { length: 80 }).notNull(), authorizedItems: jsonb("authorized_items").$type<Array<{ obligationId: string; occurrenceId: string; bowlerId: number; collectionPointOccurrenceId: string; amountMinor: number; itemIndex: number }>>().notNull(), commandKey: varchar("command_key", { length: 255 }).notNull(), coveredBowlerIds: jsonb("covered_bowler_ids").$type<number[]>().notNull(), acceptedPartnerIds: jsonb("accepted_partner_ids").$type<number[]>().notNull(), collectionPointOccurrenceIds: jsonb("collection_point_occurrence_ids").$type<string[]>().notNull(), locationId: integer("location_id").notNull(), encryptedSourceId: text("encrypted_source_id").notNull(), encryptedCustomerId: text("encrypted_customer_id"), paymentMethodFingerprint: varchar("payment_method_fingerprint", { length: 64 }).notNull(), timing: text("timing").notNull().default("at_collection_point"), state: text("state", { enum: F3_AUTHORIZATION_STATES }).notNull().default("draft"), currentRevision: integer("current_revision").notNull().default(1), createdByUserId: integer("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }), authorizedAt: timestamp("authorized_at", { withTimezone: true, mode: "string" }), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({ leagueTenantFk: foreignKey({ name: "f3_auth_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"), payerFk: foreignKey({ name: "f3_auth_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"), locationFk: foreignKey({ name: "f3_auth_location_fk", columns: [table.locationId, table.organizationId], foreignColumns: [locations.id, locations.organizationId] }).onDelete("restrict"), policyFk: foreignKey({ name: "f3_auth_policy_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"), tenantIdentityUnique: uniqueIndex("f3_auth_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId), versionUnique: uniqueIndex("f3_auth_version_unique").on(table.organizationId, table.leagueId, table.payerBowlerId, table.authorizationVersion), commandUnique: uniqueIndex("f3_auth_command_unique").on(table.organizationId, table.leagueId, table.commandKey), currentAuthorizedUnique: uniqueIndex("f3_auth_current_authorized_unique").on(table.organizationId, table.leagueId, table.payerBowlerId).where(sql`${table.state} = 'authorized'`), activeIdx: index("f3_auth_active_idx").on(table.organizationId, table.leagueId, table.payerBowlerId, table.state), fingerprintCheck: check("f3_auth_fingerprint_check", sql`${table.authorizationFingerprint} ~ '^lvf3auth:v1:[0-9a-f]{64}$' AND ${table.preauthorizationQuoteFingerprint} ~ '^lvf3quote:v1:[0-9a-f]{64}$' AND f3_json_array_shape(${table.authorizedItems}, 'quote-item') AND ${table.paymentMethodFingerprint} ~ '^[0-9a-f]{64}$' AND ${table.timing} = 'at_collection_point' AND ${table.authorizationVersion} > 0 AND ${table.policyVersion} > 0 AND ${table.currentRevision} > 0 AND length(btrim(${table.commandKey})) > 0 AND f3_json_array_shape(${table.coveredBowlerIds}, 'positive-id-array') AND (${table.acceptedPartnerIds} = '[]'::jsonb OR f3_json_array_shape(${table.acceptedPartnerIds}, 'positive-id-array')) AND f3_json_array_shape(${table.collectionPointOccurrenceIds}, 'uuid-array')`) , stateCheck: check("f3_auth_state_check", sql`${table.state} IN (${authStates}) AND ((${table.state} = 'draft' AND ${table.authorizedAt} IS NULL AND ${table.revokedAt} IS NULL) OR (${table.state} IN ('authorized','superseded') AND ${table.authorizedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.state} = 'revoked' AND ${table.authorizedAt} IS NULL AND ${table.revokedAt} IS NOT NULL))`) }));

export const f3PayerAuthorizationRevisions = pgTable("f3_payer_authorization_revisions", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), authorizationId: uuid("authorization_id").notNull(), revisionNumber: integer("revision_number").notNull(), snapshotSchemaVersion: integer("snapshot_schema_version").notNull(), beforeSnapshot: jsonb("before_snapshot"), afterSnapshot: jsonb("after_snapshot").notNull(), recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({ parentFk: foreignKey({ name: "f3_auth_revisions_parent_fk", columns: [table.authorizationId, table.organizationId, table.leagueId], foreignColumns: [f3PayerAuthorizations.id, f3PayerAuthorizations.organizationId, f3PayerAuthorizations.leagueId] }).onDelete("restrict"), unique: uniqueIndex("f3_auth_revisions_unique").on(table.organizationId, table.leagueId, table.authorizationId, table.revisionNumber), shape: check("f3_auth_revisions_shape_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0 AND ((${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL))`) }));

/** Provenance only: D2 occurrence_collection_plans/items remain the sole
 * authoritative lifecycle and conservation owner for F3 ready items. */
export const f3AutopayPlanProvenance = pgTable("f3_autopay_plan_provenance", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), leagueId: integer("league_id").notNull(), d2PlanId: uuid("d2_plan_id").notNull(), payerBowlerId: integer("payer_bowler_id").notNull(), policyId: uuid("policy_id").notNull(), policyVersion: integer("policy_version").notNull(), authorizationId: uuid("authorization_id").notNull(), authorizationVersion: integer("authorization_version").notNull(), activationId: uuid("activation_id").notNull(), activationRevision: integer("activation_revision").notNull(), activationSourceFingerprint: varchar("activation_source_fingerprint", { length: 128 }).notNull(), planVersion: integer("plan_version").notNull(), planFingerprint: varchar("plan_fingerprint", { length: 80 }).notNull(), collectionPointOccurrenceId: uuid("collection_point_occurrence_id").notNull(), timing: text("timing").notNull().default("at_collection_point"), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({ leagueTenantFk: foreignKey({ name: "f3_provenance_league_tenant_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"), planFk: foreignKey({ name: "f3_provenance_d2_plan_fk", columns: [table.d2PlanId, table.organizationId, table.leagueId], foreignColumns: [occurrenceCollectionPlans.id, occurrenceCollectionPlans.organizationId, occurrenceCollectionPlans.leagueId] }).onDelete("restrict"), payerFk: foreignKey({ name: "f3_provenance_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"), policyFk: foreignKey({ name: "f3_provenance_policy_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"), authorizationFk: foreignKey({ name: "f3_provenance_auth_fk", columns: [table.authorizationId, table.organizationId, table.leagueId], foreignColumns: [f3PayerAuthorizations.id, f3PayerAuthorizations.organizationId, f3PayerAuthorizations.leagueId] }).onDelete("restrict"), activationFk: foreignKey({ name: "f3_provenance_activation_fk", columns: [table.activationId, table.organizationId, table.leagueId], foreignColumns: [financialActivations.id, financialActivations.organizationId, financialActivations.leagueId] }).onDelete("restrict"), pointFk: foreignKey({ name: "f3_provenance_point_fk", columns: [table.collectionPointOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"), d2PlanUnique: uniqueIndex("f3_provenance_d2_plan_unique").on(table.d2PlanId), d2PlanTenantUnique: uniqueIndex("f3_provenance_d2_plan_tenant_unique").on(table.d2PlanId, table.organizationId, table.leagueId), fingerprintUnique: uniqueIndex("f3_provenance_fingerprint_unique").on(table.organizationId, table.planFingerprint), immutableIdentity: check("f3_provenance_identity_check", sql`${table.planVersion} > 0 AND ${table.activationRevision} > 0 AND ${table.policyVersion} > 0 AND ${table.authorizationVersion} > 0 AND ${table.activationSourceFingerprint} ~ '^lvfinancialsource:v1:[0-9a-f]{64}$' AND ${table.planFingerprint} ~ '^lvf3plan:v1:[0-9a-f]{64}$' AND ${table.timing} = 'at_collection_point'`) }));

export type F3CollectionPolicy = typeof f3CollectionPolicies.$inferSelect;
export type F3CollectionPolicyOccurrence = typeof f3CollectionPolicyOccurrences.$inferSelect;
export type F3PayerAuthorization = typeof f3PayerAuthorizations.$inferSelect;
export type F3PayerAuthorizationRevision = typeof f3PayerAuthorizationRevisions.$inferSelect;
export type F3AutopayPlanProvenance = typeof f3AutopayPlanProvenance.$inferSelect;
