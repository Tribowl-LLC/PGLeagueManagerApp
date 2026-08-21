import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { leagues } from "./leagues";
import { organizations } from "./organizations";
import { users } from "./users";
import { leagueOccurrences, leagueOccurrenceBillingTerms, leagueOccurrenceGenerationRuns, leagueScheduleCommands } from "./canonical-occurrences";

export const CANONICAL_COLLECTION_GROUP_KINDS = ["double_pay"] as const;
export type CanonicalCollectionGroupKind = (typeof CANONICAL_COLLECTION_GROUP_KINDS)[number];
export const CANONICAL_COLLECTION_GROUP_STATES = ["draft", "published", "revoked"] as const;
export type CanonicalCollectionGroupState = (typeof CANONICAL_COLLECTION_GROUP_STATES)[number];
export const CANONICAL_COLLECTION_GROUP_ROLES = ["trigger", "paired"] as const;
export type CanonicalCollectionGroupRole = (typeof CANONICAL_COLLECTION_GROUP_ROLES)[number];

const groupKinds = sql.raw(CANONICAL_COLLECTION_GROUP_KINDS.map((value) => `'${value}'`).join(", "));
const groupStates = sql.raw(CANONICAL_COLLECTION_GROUP_STATES.map((value) => `'${value}'`).join(", "));
const groupRoles = sql.raw(CANONICAL_COLLECTION_GROUP_ROLES.map((value) => `'${value}'`).join(", "));
const tenantColumns = (table: { organizationId: AnyPgColumn; leagueId: AnyPgColumn }): [AnyPgColumn, AnyPgColumn] => [table.leagueId, table.organizationId];

export const canonicalCollectionGroups = pgTable("canonical_collection_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  generationRunId: uuid("generation_run_id").notNull(),
  sourceScheduleRevision: integer("source_schedule_revision").notNull(),
  kind: text("kind", { enum: CANONICAL_COLLECTION_GROUP_KINDS }).notNull(),
  state: text("state", { enum: CANONICAL_COLLECTION_GROUP_STATES }).notNull().default("draft"),
  groupOrdinal: integer("group_ordinal").notNull(),
  triggerLocalDate: date("trigger_local_date", { mode: "string" }).notNull(),
  pairedLocalDate: date("paired_local_date", { mode: "string" }).notNull(),
  contractVersion: varchar("contract_version", { length: 128 }).notNull(),
  fingerprintVersion: varchar("fingerprint_version", { length: 128 }).notNull(),
  fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
  currentRevision: integer("current_revision").notNull().default(1),
  lastCommandId: uuid("last_command_id"),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  publishedByUserId: integer("published_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  publicationCommandId: uuid("publication_command_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  revokedByUserId: integer("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  revocationCommandId: uuid("revocation_command_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({ name: "collection_groups_league_tenant_fk", columns: tenantColumns(table), foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  generationRunFk: foreignKey({ name: "collection_groups_generation_run_fk", columns: [table.generationRunId, table.organizationId, table.leagueId], foreignColumns: [leagueOccurrenceGenerationRuns.id, leagueOccurrenceGenerationRuns.organizationId, leagueOccurrenceGenerationRuns.leagueId] }).onDelete("restrict"),
  lastCommandFk: foreignKey({ name: "collection_groups_last_command_fk", columns: [table.lastCommandId, table.organizationId, table.leagueId], foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId] }).onDelete("restrict"),
  publicationCommandFk: foreignKey({ name: "collection_groups_publication_command_fk", columns: [table.publicationCommandId, table.organizationId, table.leagueId], foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId] }).onDelete("restrict"),
  revocationCommandFk: foreignKey({ name: "collection_groups_revocation_command_fk", columns: [table.revocationCommandId, table.organizationId, table.leagueId], foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("collection_groups_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  runTenantIdentityUnique: uniqueIndex("collection_groups_run_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId, table.generationRunId),
  runOrdinalUnique: uniqueIndex("collection_groups_run_ordinal_unique").on(table.organizationId, table.leagueId, table.generationRunId, table.groupOrdinal).where(sql`${table.state} <> 'revoked'`),
  fingerprintUnique: uniqueIndex("collection_groups_fingerprint_unique").on(table.organizationId, table.leagueId, table.fingerprint).where(sql`${table.state} <> 'revoked'`),
  kindCheck: check("collection_groups_kind_check", sql`${table.kind} IN (${groupKinds})`),
  stateCheck: check("collection_groups_state_check", sql`${table.state} IN (${groupStates})`),
  revisionCheck: check("collection_groups_revision_check", sql`${table.currentRevision} > 0 AND ${table.sourceScheduleRevision} > 0 AND ${table.groupOrdinal} > 0`),
  dateCheck: check("collection_groups_date_check", sql`${table.triggerLocalDate} < ${table.pairedLocalDate}`),
  versionCheck: check("collection_groups_version_check", sql`length(btrim(${table.contractVersion})) > 0 AND length(btrim(${table.fingerprintVersion})) > 0 AND ${table.fingerprint} ~ '^lvcollectiongroup:v1:[0-9a-f]{64}$'`),
  lifecycleCheck: check("collection_groups_lifecycle_check", sql`(
    ${table.state} = 'draft' AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL AND ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationCommandId} IS NULL
  ) OR (
    ${table.state} = 'published' AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationCommandId} IS NULL
  ) OR (
    ${table.state} = 'revoked' AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL AND ${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL AND ${table.revocationCommandId} IS NOT NULL
  )`),
}));

export const canonicalCollectionGroupMembers = pgTable("canonical_collection_group_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  groupId: uuid("group_id").notNull(),
  generationRunId: uuid("generation_run_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  billingTermId: uuid("billing_term_id").notNull(),
  role: text("role", { enum: CANONICAL_COLLECTION_GROUP_ROLES }).notNull(),
  memberOrdinal: integer("member_ordinal").notNull(),
  localDate: date("local_date", { mode: "string" }).notNull(),
  billingOrdinal: integer("billing_ordinal").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  active: boolean("active").notNull().default(true),
  currentRevision: integer("current_revision").notNull().default(1),
  lastCommandId: uuid("last_command_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({ name: "collection_group_members_league_tenant_fk", columns: tenantColumns(table), foreignColumns: [leagues.id, leagues.organizationId] }).onDelete("restrict"),
  groupFk: foreignKey({ name: "collection_group_members_group_fk", columns: [table.groupId, table.organizationId, table.leagueId, table.generationRunId], foreignColumns: [canonicalCollectionGroups.id, canonicalCollectionGroups.organizationId, canonicalCollectionGroups.leagueId, canonicalCollectionGroups.generationRunId] }).onDelete("restrict"),
  occurrenceFk: foreignKey({ name: "collection_group_members_occurrence_fk", columns: [table.occurrenceId, table.organizationId, table.leagueId, table.generationRunId], foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId, leagueOccurrences.generationRunId] }).onDelete("restrict"),
  billingTermFk: foreignKey({ name: "collection_group_members_billing_term_fk", columns: [table.billingTermId, table.organizationId, table.leagueId, table.occurrenceId], foreignColumns: [leagueOccurrenceBillingTerms.id, leagueOccurrenceBillingTerms.organizationId, leagueOccurrenceBillingTerms.leagueId, leagueOccurrenceBillingTerms.occurrenceId] }).onDelete("restrict"),
  lastCommandFk: foreignKey({ name: "collection_group_members_last_command_fk", columns: [table.lastCommandId, table.organizationId, table.leagueId], foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId] }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("collection_group_members_tenant_identity_unique").on(table.id, table.organizationId, table.leagueId),
  groupRoleUnique: uniqueIndex("collection_group_members_group_role_unique").on(table.organizationId, table.leagueId, table.groupId, table.role).where(sql`${table.active} = TRUE`),
  groupOrdinalUnique: uniqueIndex("collection_group_members_group_ordinal_unique").on(table.organizationId, table.leagueId, table.groupId, table.memberOrdinal).where(sql`${table.active} = TRUE`),
  occurrenceCrossRoleUnique: uniqueIndex("collection_group_members_occurrence_cross_role_unique").on(table.organizationId, table.leagueId, table.occurrenceId).where(sql`${table.active} = TRUE`),
  termUnique: uniqueIndex("collection_group_members_term_unique").on(table.organizationId, table.leagueId, table.billingTermId).where(sql`${table.active} = TRUE`),
  roleCheck: check("collection_group_members_role_check", sql`${table.role} IN (${groupRoles}) AND ((${table.role} = 'trigger' AND ${table.memberOrdinal} = 1) OR (${table.role} = 'paired' AND ${table.memberOrdinal} = 2))`),
  amountCheck: check("collection_group_members_amount_check", sql`${table.amountMinor} > 0 AND ${table.billingOrdinal} > 0 AND ${table.currency} ~ '^[A-Z]{3}$'`),
  revisionCheck: check("collection_group_members_revision_check", sql`${table.currentRevision} > 0`),
}));

export const canonicalCollectionGroupRevisions = pgTable("canonical_collection_group_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  groupId: uuid("group_id").notNull(),
  commandId: uuid("command_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  groupFk: foreignKey({ name: "collection_group_revisions_group_fk", columns: [table.groupId, table.organizationId, table.leagueId], foreignColumns: [canonicalCollectionGroups.id, canonicalCollectionGroups.organizationId, canonicalCollectionGroups.leagueId] }).onDelete("restrict"),
  commandFk: foreignKey({ name: "collection_group_revisions_command_fk", columns: [table.commandId, table.organizationId, table.leagueId], foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId] }).onDelete("restrict"),
  revisionUnique: uniqueIndex("collection_group_revisions_unique").on(table.organizationId, table.leagueId, table.groupId, table.revisionNumber),
  revisionCheck: check("collection_group_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check("collection_group_revisions_snapshot_check", sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`),
}));

export const canonicalCollectionGroupMemberRevisions = pgTable("canonical_collection_group_member_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  memberId: uuid("member_id").notNull(),
  commandId: uuid("command_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  memberFk: foreignKey({ name: "collection_group_member_revisions_member_fk", columns: [table.memberId, table.organizationId, table.leagueId], foreignColumns: [canonicalCollectionGroupMembers.id, canonicalCollectionGroupMembers.organizationId, canonicalCollectionGroupMembers.leagueId] }).onDelete("restrict"),
  commandFk: foreignKey({ name: "collection_group_member_revisions_command_fk", columns: [table.commandId, table.organizationId, table.leagueId], foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId] }).onDelete("restrict"),
  revisionUnique: uniqueIndex("collection_group_member_revisions_unique").on(table.organizationId, table.leagueId, table.memberId, table.revisionNumber),
  revisionCheck: check("collection_group_member_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check("collection_group_member_revisions_snapshot_check", sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`),
}));

export type CanonicalCollectionGroup = typeof canonicalCollectionGroups.$inferSelect;
export type CanonicalCollectionGroupMember = typeof canonicalCollectionGroupMembers.$inferSelect;
export type CanonicalCollectionGroupRevision = typeof canonicalCollectionGroupRevisions.$inferSelect;
export type CanonicalCollectionGroupMemberRevision = typeof canonicalCollectionGroupMemberRevisions.$inferSelect;
