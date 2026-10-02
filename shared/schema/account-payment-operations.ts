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
import { leagues } from "./leagues";
import { locations } from "./locations";
import { paymentOperations } from "./payment-operations";
import { users } from "./users";

export const ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION = 4 as const;
export const ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS = ["interactive_funding"] as const;
export type AccountPaymentOperationSnapshotKind = (typeof ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS)[number];

export const ACCOUNT_PAYMENT_OPERATION_SOURCE_KINDS = ["new_card", "saved_card", "wallet"] as const;
export type AccountPaymentOperationSourceKind = (typeof ACCOUNT_PAYMENT_OPERATION_SOURCE_KINDS)[number];

export interface AccountPaymentFundingPortionV4 {
  portionIndex: number;
  creditedBowlerId: number;
  amountMinor: number;
}

export interface AccountPaymentRecipientAuthorizationEvidenceV4 {
  recipientBowlerId: number;
  role: "self" | "partner";
  paymentLinkId: number | null;
  linkFingerprint: string | null;
  /** User-selected amount target, retained so request-key replay can verify
   * the original intent without reserving any future obligation identities. */
  selection: {
    kind: "explicit_amount";
    amountMinor: number;
  } | {
    kind: "confirmed_debt_balance";
  } | {
    kind: "forecast_collection_target";
    scope: "current_collection" | "selected_weeks" | "full_season";
    weeks?: number;
  };
}

/**
 * Immutable provider request evidence for an adopted-mode account funding
 * charge. One provider operation and tender may have multiple independently
 * credited recipients; portions are frozen here and contain no obligation
 * or future-week allocation rows.
 */
export const accountPaymentOperationSnapshots = pgTable("account_payment_operation_snapshots", {
  operationId: uuid("operation_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  leagueId: integer("league_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION),
  snapshotKind: text("snapshot_kind", { enum: ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS }).notNull().default("interactive_funding"),
  payerBowlerId: integer("payer_bowler_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  fundingPortions: jsonb("funding_portions").$type<AccountPaymentFundingPortionV4[]>().notNull(),
  recipientEvidence: jsonb("recipient_evidence").$type<AccountPaymentRecipientAuthorizationEvidenceV4[]>().notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  providerName: varchar("provider_name", { length: 32 }).notNull(),
  locationId: integer("location_id"),
  providerLocationId: varchar("provider_location_id", { length: 255 }),
  authorizingUserId: integer("authorizing_user_id").notNull(),
  requestKind: text("request_kind", { enum: ["direct"] }).notNull().default("direct"),
  sourceKind: text("source_kind", { enum: ACCOUNT_PAYMENT_OPERATION_SOURCE_KINDS }).notNull(),
  encryptedSourceId: text("encrypted_source_id").notNull(),
  encryptedCustomerId: text("encrypted_customer_id"),
  encryptedBuyerEmail: text("encrypted_buyer_email"),
  storeCard: boolean("store_card").notNull().default(false),
  quoteFingerprint: varchar("quote_fingerprint", { length: 96 }).notNull(),
  snapshotFingerprint: varchar("snapshot_fingerprint", { length: 96 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  operationPk: uniqueIndex("account_payment_operation_snapshots_operation_pk").on(table.operationId),
  tenantIdentityUnique: uniqueIndex("account_payment_operation_snapshots_tenant_identity_unique").on(table.operationId, table.organizationId, table.leagueId),
  operationFk: foreignKey({
    name: "account_payment_operation_snapshots_operation_fk",
    columns: [table.operationId, table.organizationId, table.leagueId],
    foreignColumns: [paymentOperations.id, paymentOperations.organizationId, paymentOperations.leagueId],
  }).onDelete("restrict"),
  leagueTenantFk: foreignKey({
    name: "account_payment_operation_snapshots_league_tenant_fk",
    columns: [table.leagueId, table.organizationId],
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  payerTenantFk: foreignKey({
    name: "account_payment_operation_snapshots_payer_tenant_fk",
    columns: [table.payerBowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
  }).onDelete("restrict"),
  locationTenantFk: foreignKey({
    name: "account_payment_operation_snapshots_location_tenant_fk",
    columns: [table.locationId, table.organizationId],
    foreignColumns: [locations.id, locations.organizationId],
  }).onDelete("restrict"),
  authorizingUserFk: foreignKey({
    name: "account_payment_operation_snapshots_authorizing_user_fk",
    columns: [table.authorizingUserId],
    foreignColumns: [users.id],
  }).onDelete("restrict"),
  amountCheck: check(
    "account_payment_operation_snapshots_amount_check",
    sql`${table.amountMinor} > 0 AND ${table.currency} = 'USD' AND ${table.snapshotVersion} = ${sql.raw(String(ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION))} AND ${table.snapshotKind} = 'interactive_funding' AND ${table.requestKind} = 'direct' AND jsonb_typeof(${table.fundingPortions}) = 'array' AND jsonb_array_length(${table.fundingPortions}) > 0 AND jsonb_typeof(${table.recipientEvidence}) = 'array' AND jsonb_array_length(${table.recipientEvidence}) > 0`,
  ),
  provenanceCheck: check(
    "account_payment_operation_snapshots_provenance_check",
    sql`${table.payerBowlerId} > 0 AND ${table.authorizingUserId} > 0 AND ${table.providerName} ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND (${table.providerLocationId} IS NULL OR length(btrim(${table.providerLocationId})) BETWEEN 1 AND 255)`,
  ),
  sourceCheck: check(
    "account_payment_operation_snapshots_source_check",
    sql`length(btrim(${table.encryptedSourceId})) > 0 AND (${table.sourceKind} <> 'wallet' OR ${table.storeCard} = false)`,
  ),
  quoteFingerprintCheck: check(
    "account_payment_operation_snapshots_quote_fingerprint_check",
    sql`${table.quoteFingerprint} ~ '^lvaccountfundquote:v4:[0-9a-f]{64}$'`,
  ),
  snapshotFingerprintCheck: check(
    "account_payment_operation_snapshots_fingerprint_check",
    sql`${table.snapshotFingerprint} ~ '^lvaccountfunding:v4:[0-9a-f]{64}$'`,
  ),
  leagueLookupIdx: index("account_payment_operation_snapshots_league_idx").on(table.organizationId, table.leagueId, table.createdAt.desc()),
}));

export type AccountPaymentOperationSnapshot = typeof accountPaymentOperationSnapshots.$inferSelect;
export type InsertAccountPaymentOperationSnapshot = typeof accountPaymentOperationSnapshots.$inferInsert;
