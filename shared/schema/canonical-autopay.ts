import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar, text } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { leagues } from "./leagues";
import { locations } from "./locations";
import { bowlers } from "./bowlers";
import { leagueOccurrences } from "./canonical-occurrences";
import { occurrenceCollectionPlans } from "./occurrence-financials";
import { f3CollectionPolicies, f3PayerAuthorizations, f3AutopayPlanProvenance } from "./f3-autopay";
import { financialActivations } from "./financial-activation";
import { paymentOperations } from "./payment-operations";

export const CANONICAL_AUTOPAY_EXECUTION_SNAPSHOT_VERSION = 1;
export const CANONICAL_AUTOPAY_EXECUTION_SNAPSHOT_CONTRACT = "canonical-autopay-execution/1" as const;

/** Immutable, encrypted input for one exact D2 plan/collection point. */
export const canonicalAutopayExecutionSnapshots = pgTable("canonical_autopay_execution_snapshots", {
  operationId: uuid("operation_id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  d2PlanId: uuid("d2_plan_id").notNull(),
  collectionPointOccurrenceId: uuid("collection_point_occurrence_id").notNull(),
  payerBowlerId: integer("payer_bowler_id").notNull(),
  activationId: uuid("activation_id").notNull(),
  activationRevision: integer("activation_revision").notNull(),
  activationSourceFingerprint: varchar("activation_source_fingerprint", { length: 128 }).notNull(),
  policyId: uuid("policy_id").notNull(),
  policyVersion: integer("policy_version").notNull(),
  policyFingerprint: varchar("policy_fingerprint", { length: 80 }).notNull(),
  authorizationId: uuid("authorization_id").notNull(),
  authorizationVersion: integer("authorization_version").notNull(),
  authorizationFingerprint: varchar("authorization_fingerprint", { length: 80 }).notNull(),
  planVersion: integer("plan_version").notNull(),
  planFingerprint: varchar("plan_fingerprint", { length: 80 }).notNull(),
  triggerOccurrenceId: uuid("trigger_occurrence_id").notNull(),
  triggerStartAt: timestamp("trigger_start_at", { withTimezone: true, mode: "string" }).notNull(),
  locationId: integer("location_id").notNull(),
  providerLocationId: varchar("provider_location_id", { length: 255 }).notNull(),
  encryptedSourceId: text("encrypted_source_id").notNull(),
  encryptedCustomerId: text("encrypted_customer_id"),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  // Ordered plan items are duplicated as immutable evidence so execution does
  // not reconstruct financial identity from mutable D2 rows.
  items: jsonb("items").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(CANONICAL_AUTOPAY_EXECUTION_SNAPSHOT_VERSION),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 80 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationTenantFk: foreignKey({ name: "canonical_autopay_snapshots_operation_fk", columns: [table.operationId, table.organizationId], foreignColumns: [paymentOperations.id, paymentOperations.organizationId] }).onDelete("restrict"),
  leagueTenantFk: foreignKey({ name: "canonical_autopay_snapshots_league_fk", columns: [table.leagueId, table.organizationId], foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  planTenantFk: foreignKey({ name: "canonical_autopay_snapshots_plan_fk", columns: [table.d2PlanId, table.organizationId, table.leagueId], foreignColumns: [occurrenceCollectionPlans.id, occurrenceCollectionPlans.organizationId, occurrenceCollectionPlans.leagueId] }).onDelete("restrict"),
  provenanceFk: foreignKey({ name: "canonical_autopay_snapshots_provenance_fk", columns: [table.d2PlanId, table.organizationId, table.leagueId], foreignColumns: [f3AutopayPlanProvenance.d2PlanId, f3AutopayPlanProvenance.organizationId, f3AutopayPlanProvenance.leagueId] }).onDelete("restrict"),
  activationFk: foreignKey({ name: "canonical_autopay_snapshots_activation_fk", columns: [table.activationId, table.organizationId, table.leagueId], foreignColumns: [financialActivations.id, financialActivations.organizationId, financialActivations.leagueId] }).onDelete("restrict"),
  policyFk: foreignKey({ name: "canonical_autopay_snapshots_policy_fk", columns: [table.policyId, table.organizationId, table.leagueId], foreignColumns: [f3CollectionPolicies.id, f3CollectionPolicies.organizationId, f3CollectionPolicies.leagueId] }).onDelete("restrict"),
  authorizationFk: foreignKey({ name: "canonical_autopay_snapshots_authorization_fk", columns: [table.authorizationId, table.organizationId, table.leagueId], foreignColumns: [f3PayerAuthorizations.id, f3PayerAuthorizations.organizationId, f3PayerAuthorizations.leagueId] }).onDelete("restrict"),
  pointFk: foreignKey({ name: "canonical_autopay_snapshots_point_fk", columns: [table.collectionPointOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  triggerFk: foreignKey({ name: "canonical_autopay_snapshots_trigger_fk", columns: [table.triggerOccurrenceId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId] }).onDelete("restrict"),
  locationFk: foreignKey({ name: "canonical_autopay_snapshots_location_fk", columns: [table.locationId, table.organizationId], foreignColumns: [locations.id, locations.organizationId] }).onDelete("restrict"),
  payerFk: foreignKey({ name: "canonical_autopay_snapshots_payer_fk", columns: [table.payerBowlerId, table.organizationId], foreignColumns: [bowlers.id, bowlers.organizationId] }).onDelete("restrict"),
  identityUnique: uniqueIndex("canonical_autopay_snapshots_identity_unique").on(table.operationId, table.organizationId, table.leagueId, table.d2PlanId),
  planIdx: index("canonical_autopay_snapshots_plan_idx").on(table.organizationId, table.leagueId, table.d2PlanId),
  authorizationIdx: index("canonical_autopay_snapshots_authorization_idx").on(table.organizationId, table.leagueId, table.authorizationId),
  fingerprintCheck: check("canonical_autopay_snapshots_fingerprint_check", sql`${table.snapshotFingerprint} ~ '^lvf4exec:v1:[0-9a-f]{64}$' AND ${table.planFingerprint} ~ '^lvf3plan:v1:[0-9a-f]{64}$' AND ${table.policyFingerprint} ~ '^lvf3policy:v1:[0-9a-f]{64}$' AND ${table.authorizationFingerprint} ~ '^lvf3auth:v1:[0-9a-f]{64}$' AND ${table.activationSourceFingerprint} ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'`),
  versionCheck: check("canonical_autopay_snapshots_version_check", sql`${table.snapshotVersion} = ${sql.raw(String(CANONICAL_AUTOPAY_EXECUTION_SNAPSHOT_VERSION))} AND ${table.planVersion} > 0 AND ${table.policyVersion} > 0 AND ${table.authorizationVersion} > 0 AND ${table.activationRevision} > 0`),
  moneyCheck: check("canonical_autopay_snapshots_money_check", sql`${table.amountMinor} > 0 AND ${table.currency} ~ '^[A-Z]{3}$' AND jsonb_typeof(${table.items}) = 'array' AND jsonb_array_length(${table.items}) > 0`),
}));

export type CanonicalAutopayExecutionSnapshot = typeof canonicalAutopayExecutionSnapshots.$inferSelect;
