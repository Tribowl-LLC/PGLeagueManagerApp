import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { leagues } from "./leagues";
import { locations } from "./locations";
import { organizations } from "./organizations";
import { users } from "./users";

export const LEAGUE_SCHEDULE_COMMAND_TYPES = [
  "generate",
  "compare",
  "approve_generation",
  "publish",
  "reschedule",
  "cancel",
  "discard_draft",
  "create_exception",
  "revoke_exception",
  "create_makeup_relationship",
  "revoke_makeup_relationship",
  "revise_billing_terms",
  "repair",
] as const;
export type LeagueScheduleCommandType = (typeof LEAGUE_SCHEDULE_COMMAND_TYPES)[number];

export const LEAGUE_SCHEDULE_COMMAND_OUTCOMES = ["applied", "rejected", "no_change"] as const;
export type LeagueScheduleCommandOutcome = (typeof LEAGUE_SCHEDULE_COMMAND_OUTCOMES)[number];

export const LEAGUE_GENERATION_RUN_STATES = [
  "generated",
  "approved",
  "applied",
  "rejected",
  "superseded",
] as const;
export type LeagueGenerationRunState = (typeof LEAGUE_GENERATION_RUN_STATES)[number];

export const LEAGUE_SCHEDULE_EXCEPTION_KINDS = ["skip"] as const;
export type LeagueScheduleExceptionKind = (typeof LEAGUE_SCHEDULE_EXCEPTION_KINDS)[number];

export const LEAGUE_SCHEDULE_EXCEPTION_SOURCES = ["manual", "legacy_import", "generator"] as const;
export type LeagueScheduleExceptionSource = (typeof LEAGUE_SCHEDULE_EXCEPTION_SOURCES)[number];

export const LEAGUE_SCHEDULE_EXCEPTION_LIFECYCLES = ["draft", "published", "revoked"] as const;
export type LeagueScheduleExceptionLifecycle = (typeof LEAGUE_SCHEDULE_EXCEPTION_LIFECYCLES)[number];

export const LEAGUE_OCCURRENCE_KINDS = [
  "regular",
  "makeup",
  "position_round",
  "rolloff",
  "playoff",
  "extension",
] as const;
export type LeagueOccurrenceKind = (typeof LEAGUE_OCCURRENCE_KINDS)[number];

export const LEAGUE_OCCURRENCE_STATUSES = ["scheduled", "cancelled", "completed", "discarded"] as const;
export type LeagueOccurrenceStatus = (typeof LEAGUE_OCCURRENCE_STATUSES)[number];

export const LEAGUE_OCCURRENCE_LIFECYCLES = ["draft", "published", "locked"] as const;
export type LeagueOccurrenceLifecycle = (typeof LEAGUE_OCCURRENCE_LIFECYCLES)[number];

export const LEAGUE_OCCURRENCE_FOLD_RESOLUTIONS = ["unambiguous", "earlier", "later"] as const;
export type LeagueOccurrenceFoldResolution = (typeof LEAGUE_OCCURRENCE_FOLD_RESOLUTIONS)[number];

export const LEAGUE_OCCURRENCE_BILLING_PURPOSES = ["league_weekly_fee"] as const;
export type LeagueOccurrenceBillingPurpose = (typeof LEAGUE_OCCURRENCE_BILLING_PURPOSES)[number];

export const LEAGUE_OCCURRENCE_BILLING_POLICIES = ["none", "eligible_bowlers"] as const;
export type LeagueOccurrenceBillingPolicy = (typeof LEAGUE_OCCURRENCE_BILLING_POLICIES)[number];

export const LEAGUE_OCCURRENCE_BILLING_STATES = ["draft", "published", "superseded"] as const;
export type LeagueOccurrenceBillingState = (typeof LEAGUE_OCCURRENCE_BILLING_STATES)[number];

export const LEAGUE_OCCURRENCE_RELATIONSHIP_KINDS = ["makeup_for"] as const;
export type LeagueOccurrenceRelationshipKind = (typeof LEAGUE_OCCURRENCE_RELATIONSHIP_KINDS)[number];

export const LEAGUE_OCCURRENCE_RELATIONSHIP_STATES = ["draft", "published", "revoked"] as const;
export type LeagueOccurrenceRelationshipState = (typeof LEAGUE_OCCURRENCE_RELATIONSHIP_STATES)[number];

export const LEAGUE_GENERATION_DISCREPANCY_SEVERITIES = ["info", "warning", "error"] as const;
export type LeagueGenerationDiscrepancySeverity = (typeof LEAGUE_GENERATION_DISCREPANCY_SEVERITIES)[number];

export const LEAGUE_GENERATION_DISCREPANCY_CODES = [
  "ambiguous_historical_payment",
  "duplicate_historical_game_key",
  "outside_season_occurrence",
  "weekday_mismatch",
  "exception_collision",
  "invalid_dst_input",
  "total_week_mismatch",
] as const;
export type LeagueGenerationDiscrepancyCode = (typeof LEAGUE_GENERATION_DISCREPANCY_CODES)[number];

export const LEAGUE_GENERATION_DISCREPANCY_RESOLUTION_STATES = ["open", "resolved", "waived"] as const;
export type LeagueGenerationDiscrepancyResolutionState =
  (typeof LEAGUE_GENERATION_DISCREPANCY_RESOLUTION_STATES)[number];

const commandTypes = sql.raw(LEAGUE_SCHEDULE_COMMAND_TYPES.map((value) => `'${value}'`).join(", "));
const commandOutcomes = sql.raw(LEAGUE_SCHEDULE_COMMAND_OUTCOMES.map((value) => `'${value}'`).join(", "));
const generationRunStates = sql.raw(LEAGUE_GENERATION_RUN_STATES.map((value) => `'${value}'`).join(", "));
const exceptionKinds = sql.raw(LEAGUE_SCHEDULE_EXCEPTION_KINDS.map((value) => `'${value}'`).join(", "));
const exceptionSources = sql.raw(LEAGUE_SCHEDULE_EXCEPTION_SOURCES.map((value) => `'${value}'`).join(", "));
const exceptionLifecycles = sql.raw(LEAGUE_SCHEDULE_EXCEPTION_LIFECYCLES.map((value) => `'${value}'`).join(", "));
const occurrenceKinds = sql.raw(LEAGUE_OCCURRENCE_KINDS.map((value) => `'${value}'`).join(", "));
const occurrenceStatuses = sql.raw(LEAGUE_OCCURRENCE_STATUSES.map((value) => `'${value}'`).join(", "));
const occurrenceLifecycles = sql.raw(LEAGUE_OCCURRENCE_LIFECYCLES.map((value) => `'${value}'`).join(", "));
const foldResolutions = sql.raw(LEAGUE_OCCURRENCE_FOLD_RESOLUTIONS.map((value) => `'${value}'`).join(", "));
const billingPurposes = sql.raw(LEAGUE_OCCURRENCE_BILLING_PURPOSES.map((value) => `'${value}'`).join(", "));
const billingPolicies = sql.raw(LEAGUE_OCCURRENCE_BILLING_POLICIES.map((value) => `'${value}'`).join(", "));
const billingStates = sql.raw(LEAGUE_OCCURRENCE_BILLING_STATES.map((value) => `'${value}'`).join(", "));
const relationshipKinds = sql.raw(LEAGUE_OCCURRENCE_RELATIONSHIP_KINDS.map((value) => `'${value}'`).join(", "));
const relationshipStates = sql.raw(LEAGUE_OCCURRENCE_RELATIONSHIP_STATES.map((value) => `'${value}'`).join(", "));
const discrepancySeverities = sql.raw(LEAGUE_GENERATION_DISCREPANCY_SEVERITIES.map((value) => `'${value}'`).join(", "));
const discrepancyCodes = sql.raw(LEAGUE_GENERATION_DISCREPANCY_CODES.map((value) => `'${value}'`).join(", "));
const discrepancyResolutionStates = sql.raw(
  LEAGUE_GENERATION_DISCREPANCY_RESOLUTION_STATES.map((value) => `'${value}'`).join(", "),
);

const tenantColumns = (table: { organizationId: AnyPgColumn; leagueId: AnyPgColumn }): [AnyPgColumn, AnyPgColumn] => [
  table.leagueId,
  table.organizationId,
];

export const leagueScheduleCommands = pgTable("league_schedule_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  commandType: text("command_type", { enum: LEAGUE_SCHEDULE_COMMAND_TYPES }).notNull(),
  reason: text("reason"),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 128 }).notNull(),
  sameDayOverride: boolean("same_day_override").notNull().default(false),
  outcome: text("outcome", { enum: LEAGUE_SCHEDULE_COMMAND_OUTCOMES }).notNull().default("applied"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({
    name: "schedule_commands_league_tenant_fk",
    columns: tenantColumns(table),
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("schedule_commands_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  idempotencyUnique: uniqueIndex("schedule_commands_org_idempotency_unique")
    .on(table.organizationId, table.idempotencyKey),
  tenantCreatedIdx: index("schedule_commands_tenant_created_idx").on(table.organizationId, table.createdAt.desc()),
  leagueCreatedIdx: index("schedule_commands_league_created_idx").on(table.leagueId, table.createdAt.desc()),
  commandTypeCheck: check("schedule_commands_type_check", sql`${table.commandType} IN (${commandTypes})`),
  outcomeCheck: check("schedule_commands_outcome_check", sql`${table.outcome} IN (${commandOutcomes})`),
  idempotencyKeyCheck: check(
    "schedule_commands_idempotency_key_check",
    sql`length(${table.idempotencyKey}) > 0 AND btrim(${table.idempotencyKey}) = ${table.idempotencyKey}`,
  ),
  fingerprintCheck: check(
    "schedule_commands_fingerprint_check",
    sql`length(${table.requestFingerprint}) > 0 AND btrim(${table.requestFingerprint}) = ${table.requestFingerprint}`,
  ),
  reasonCheck: check(
    "schedule_commands_reason_check",
    sql`${table.commandType} NOT IN ('cancel', 'reschedule', 'discard_draft', 'revoke_exception', 'revoke_makeup_relationship', 'repair')
      OR (${table.reason} IS NOT NULL AND length(${table.reason}) > 0 AND btrim(${table.reason}) = ${table.reason})`,
  ),
}));

export const leagueOccurrenceGenerationRuns = pgTable("league_occurrence_generation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  originatingCommandId: uuid("originating_command_id").notNull(),
  generatorVersion: varchar("generator_version", { length: 128 }).notNull(),
  inputFingerprint: varchar("input_fingerprint", { length: 128 }).notNull(),
  sourceScheduleRevision: integer("source_schedule_revision").notNull(),
  normalizedInputSnapshot: jsonb("normalized_input_snapshot").notNull(),
  rangeStartDate: date("range_start_date", { mode: "string" }).notNull(),
  rangeEndDate: date("range_end_date", { mode: "string" }).notNull(),
  candidateOccurrenceCount: integer("candidate_occurrence_count").notNull().default(0),
  generatedOccurrenceCount: integer("generated_occurrence_count").notNull().default(0),
  skippedDateCount: integer("skipped_date_count").notNull().default(0),
  discrepancyCount: integer("discrepancy_count").notNull().default(0),
  state: text("state", { enum: LEAGUE_GENERATION_RUN_STATES }).notNull().default("generated"),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
  approvedByUserId: integer("approved_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  approvalCommandId: uuid("approval_command_id"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
  rejectedByUserId: integer("rejected_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  rejectionReason: text("rejection_reason"),
  rejectionCommandId: uuid("rejection_command_id"),
  supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
  supersededByCommandId: uuid("superseded_by_command_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({
    name: "generation_runs_league_tenant_fk",
    columns: tenantColumns(table),
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("generation_runs_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  originatingCommandFk: foreignKey({
    name: "generation_runs_originating_command_fk",
    columns: [table.originatingCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  approvalCommandFk: foreignKey({
    name: "generation_runs_approval_command_fk",
    columns: [table.approvalCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  rejectionCommandFk: foreignKey({
    name: "generation_runs_rejection_command_fk",
    columns: [table.rejectionCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  supersededCommandFk: foreignKey({
    name: "generation_runs_superseded_command_fk",
    columns: [table.supersededByCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  stateCheck: check("generation_runs_state_check", sql`${table.state} IN (${generationRunStates})`),
  revisionCheck: check("generation_runs_revision_check", sql`${table.sourceScheduleRevision} > 0`),
  rangeCheck: check("generation_runs_range_check", sql`${table.rangeEndDate} >= ${table.rangeStartDate}`),
  countsCheck: check(
    "generation_runs_counts_check",
    sql`${table.candidateOccurrenceCount} >= 0 AND ${table.generatedOccurrenceCount} >= 0
      AND ${table.skippedDateCount} >= 0 AND ${table.discrepancyCount} >= 0`,
  ),
  versionCheck: check(
    "generation_runs_version_check",
    sql`length(${table.generatorVersion}) > 0 AND btrim(${table.generatorVersion}) = ${table.generatorVersion}
      AND length(${table.inputFingerprint}) > 0 AND btrim(${table.inputFingerprint}) = ${table.inputFingerprint}`,
  ),
  approvalMetadataCheck: check(
    "generation_runs_approval_metadata_check",
    sql`(${table.approvedAt} IS NULL AND ${table.approvedByUserId} IS NULL AND ${table.approvalCommandId} IS NULL)
      OR (${table.approvedAt} IS NOT NULL AND ${table.approvedByUserId} IS NOT NULL AND ${table.approvalCommandId} IS NOT NULL)`,
  ),
  metadataCheck: check(
    "generation_runs_metadata_check",
    sql`(
      ${table.state} = 'generated'
      AND ${table.approvedAt} IS NULL AND ${table.approvedByUserId} IS NULL AND ${table.approvalCommandId} IS NULL
      AND ${table.rejectedAt} IS NULL AND ${table.rejectedByUserId} IS NULL AND ${table.rejectionReason} IS NULL AND ${table.rejectionCommandId} IS NULL
      AND ${table.supersededAt} IS NULL AND ${table.supersededByCommandId} IS NULL
    ) OR (
      ${table.state} IN ('approved', 'applied')
      AND ${table.approvedAt} IS NOT NULL AND ${table.approvedByUserId} IS NOT NULL AND ${table.approvalCommandId} IS NOT NULL
      AND ${table.rejectedAt} IS NULL AND ${table.rejectedByUserId} IS NULL AND ${table.rejectionReason} IS NULL AND ${table.rejectionCommandId} IS NULL
      AND ${table.supersededAt} IS NULL AND ${table.supersededByCommandId} IS NULL
    ) OR (
      ${table.state} = 'rejected'
      AND ${table.rejectedAt} IS NOT NULL AND ${table.rejectedByUserId} IS NOT NULL
      AND ${table.rejectionReason} IS NOT NULL AND length(${table.rejectionReason}) > 0
      AND ${table.rejectionCommandId} IS NOT NULL
      AND ${table.approvedAt} IS NULL AND ${table.approvedByUserId} IS NULL AND ${table.approvalCommandId} IS NULL
      AND ${table.supersededAt} IS NULL AND ${table.supersededByCommandId} IS NULL
    ) OR (
      ${table.state} = 'superseded'
      AND ${table.supersededAt} IS NOT NULL AND ${table.supersededByCommandId} IS NOT NULL
      AND ${table.rejectedAt} IS NULL AND ${table.rejectedByUserId} IS NULL AND ${table.rejectionReason} IS NULL AND ${table.rejectionCommandId} IS NULL
    )
    AND (${table.rejectedAt} IS NULL OR ${table.rejectedByUserId} IS NOT NULL)
    AND (${table.supersededAt} IS NULL OR ${table.supersededByCommandId} IS NOT NULL)`,
  ),
  generationUnique: uniqueIndex("generation_runs_revision_unique")
    .on(table.organizationId, table.leagueId, table.generatorVersion, table.inputFingerprint, table.sourceScheduleRevision),
  tenantCreatedIdx: index("generation_runs_tenant_created_idx").on(table.organizationId, table.createdAt.desc()),
}));

export const leagueScheduleExceptions = pgTable("league_schedule_exceptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  kind: text("kind", { enum: LEAGUE_SCHEDULE_EXCEPTION_KINDS }).notNull(),
  localDate: date("local_date", { mode: "string" }).notNull(),
  timezone: varchar("timezone", { length: 128 }).notNull(),
  source: text("source", { enum: LEAGUE_SCHEDULE_EXCEPTION_SOURCES }).notNull(),
  lifecycle: text("lifecycle", { enum: LEAGUE_SCHEDULE_EXCEPTION_LIFECYCLES }).notNull().default("draft"),
  reason: text("reason").notNull(),
  generationRunId: uuid("generation_run_id"),
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
  leagueTenantFk: foreignKey({
    name: "schedule_exceptions_league_tenant_fk",
    columns: tenantColumns(table),
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("schedule_exceptions_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  generationRunFk: foreignKey({
    name: "schedule_exceptions_generation_run_fk",
    columns: [table.generationRunId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrenceGenerationRuns.id, leagueOccurrenceGenerationRuns.organizationId, leagueOccurrenceGenerationRuns.leagueId],
  }).onDelete("restrict"),
  lastCommandFk: foreignKey({
    name: "schedule_exceptions_last_command_fk",
    columns: [table.lastCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  publicationCommandFk: foreignKey({
    name: "schedule_exceptions_publication_command_fk",
    columns: [table.publicationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  revocationCommandFk: foreignKey({
    name: "schedule_exceptions_revocation_command_fk",
    columns: [table.revocationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  kindCheck: check("schedule_exceptions_kind_check", sql`${table.kind} IN (${exceptionKinds})`),
  sourceCheck: check("schedule_exceptions_source_check", sql`${table.source} IN (${exceptionSources})`),
  revisionCheck: check("schedule_exceptions_revision_check", sql`${table.currentRevision} > 0`),
  reasonCheck: check(
    "schedule_exceptions_reason_check",
    sql`length(${table.reason}) > 0 AND btrim(${table.reason}) = ${table.reason}`,
  ),
  timezoneCheck: check(
    "schedule_exceptions_timezone_check",
    sql`length(btrim(${table.timezone})) > 0 AND (${table.timezone} ~ '^[A-Za-z][A-Za-z0-9._+~-]*(/[A-Za-z0-9._+~-]+)+$' OR ${table.timezone} IN ('UTC', 'GMT'))`,
  ),
  lifecycleCheck: check(
    "schedule_exceptions_lifecycle_check",
    sql`(
      ${table.lifecycle} = 'draft'
      AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL
      AND ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationCommandId} IS NULL
    ) OR (
      ${table.lifecycle} = 'published'
      AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL
      AND ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationCommandId} IS NULL
    ) OR (
      ${table.lifecycle} = 'revoked'
      AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL
      AND ${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL AND ${table.revocationCommandId} IS NOT NULL
    )`,
  ),
  nonRevokedUnique: uniqueIndex("schedule_exceptions_active_unique")
    .on(table.organizationId, table.leagueId, table.kind, table.localDate)
    .where(sql`${table.lifecycle} <> 'revoked'`),
  tenantDateIdx: index("schedule_exceptions_tenant_date_idx").on(table.organizationId, table.localDate),
}));

export const leagueOccurrences = pgTable("league_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  locationId: integer("location_id").notNull(),
  generationKey: varchar("generation_key", { length: 255 }).notNull(),
  generationRunId: uuid("generation_run_id"),
  kind: text("kind", { enum: LEAGUE_OCCURRENCE_KINDS }).notNull(),
  status: text("status", { enum: LEAGUE_OCCURRENCE_STATUSES }).notNull().default("scheduled"),
  lifecycle: text("lifecycle", { enum: LEAGUE_OCCURRENCE_LIFECYCLES }).notNull().default("draft"),
  authoritativeLocalDate: date("authoritative_local_date", { mode: "string" }).notNull(),
  authoritativeLocalStartTime: time("authoritative_local_start_time", { withTimezone: false }).notNull(),
  timezone: varchar("timezone", { length: 128 }).notNull(),
  startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
  selectedUtcOffsetMinutes: integer("selected_utc_offset_minutes").notNull(),
  foldResolution: text("fold_resolution", { enum: LEAGUE_OCCURRENCE_FOLD_RESOLUTIONS }).notNull(),
  resolverVersion: varchar("resolver_version", { length: 128 }).notNull(),
  plannedOrdinal: integer("planned_ordinal"),
  competitionNumber: integer("competition_number"),
  competitive: boolean("competitive").notNull().default(true),
  countsInStandings: boolean("counts_in_standings").notNull().default(true),
  currentRevision: integer("current_revision").notNull().default(1),
  lastCommandId: uuid("last_command_id"),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  publishedByUserId: integer("published_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  publicationCommandId: uuid("publication_command_id"),
  lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
  lockedByUserId: integer("locked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  lockReason: text("lock_reason"),
  lockCommandId: uuid("lock_command_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "string" }),
  cancelledByUserId: integer("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  cancellationCommandId: uuid("cancellation_command_id"),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  completedByUserId: integer("completed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  completionCommandId: uuid("completion_command_id"),
  discardedAt: timestamp("discarded_at", { withTimezone: true, mode: "string" }),
  discardedByUserId: integer("discarded_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  discardCommandId: uuid("discard_command_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  leagueTenantFk: foreignKey({
    name: "occurrences_league_tenant_fk",
    columns: tenantColumns(table),
    foreignColumns: [leagues.id, leagues.organizationId],
  }).onDelete("restrict"),
  locationTenantFk: foreignKey({
    name: "occurrences_location_tenant_fk",
    columns: [table.locationId, table.organizationId],
    foreignColumns: [locations.id, locations.organizationId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("occurrences_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  generationRunFk: foreignKey({
    name: "occurrences_generation_run_fk",
    columns: [table.generationRunId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrenceGenerationRuns.id, leagueOccurrenceGenerationRuns.organizationId, leagueOccurrenceGenerationRuns.leagueId],
  }).onDelete("restrict"),
  lastCommandFk: foreignKey({
    name: "occurrences_last_command_fk",
    columns: [table.lastCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  publicationCommandFk: foreignKey({
    name: "occurrences_publication_command_fk",
    columns: [table.publicationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  lockCommandFk: foreignKey({
    name: "occurrences_lock_command_fk",
    columns: [table.lockCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  cancellationCommandFk: foreignKey({
    name: "occurrences_cancellation_command_fk",
    columns: [table.cancellationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  completionCommandFk: foreignKey({
    name: "occurrences_completion_command_fk",
    columns: [table.completionCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  discardCommandFk: foreignKey({
    name: "occurrences_discard_command_fk",
    columns: [table.discardCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  generationKeyUnique: uniqueIndex("occurrences_generation_key_unique")
    .on(table.organizationId, table.leagueId, table.generationKey),
  activeStartUnique: uniqueIndex("occurrences_active_start_unique")
    .on(table.organizationId, table.leagueId, table.startAt)
    .where(sql`${table.lifecycle} IN ('published', 'locked') AND ${table.status} <> 'cancelled'`),
  publishedOrdinalUnique: uniqueIndex("occurrences_published_ordinal_unique")
    .on(table.organizationId, table.leagueId, table.plannedOrdinal)
    .where(sql`${table.lifecycle} IN ('published', 'locked') AND ${table.plannedOrdinal} IS NOT NULL`),
  publishedCompetitionUnique: uniqueIndex("occurrences_published_competition_unique")
    .on(table.organizationId, table.leagueId, table.competitionNumber)
    .where(sql`${table.lifecycle} IN ('published', 'locked') AND ${table.competitionNumber} IS NOT NULL`),
  tenantDateIdx: index("occurrences_tenant_date_idx").on(table.organizationId, table.authoritativeLocalDate),
  generationRunIdx: index("occurrences_generation_run_idx").on(table.generationRunId),
  kindCheck: check("occurrences_kind_check", sql`${table.kind} IN (${occurrenceKinds})`),
  statusCheck: check("occurrences_status_check", sql`${table.status} IN (${occurrenceStatuses})`),
  lifecycleCheck: check("occurrences_lifecycle_check", sql`${table.lifecycle} IN (${occurrenceLifecycles})`),
  foldCheck: check("occurrences_fold_check", sql`${table.foldResolution} IN (${foldResolutions})`),
  offsetCheck: check("occurrences_offset_check", sql`${table.selectedUtcOffsetMinutes} BETWEEN -840 AND 840`),
  timezoneCheck: check(
    "occurrences_timezone_check",
    sql`length(btrim(${table.timezone})) > 0 AND (${table.timezone} ~ '^[A-Za-z][A-Za-z0-9._+~-]*(/[A-Za-z0-9._+~-]+)+$' OR ${table.timezone} IN ('UTC', 'GMT'))`,
  ),
  resolverCheck: check(
    "occurrences_resolver_check",
    sql`length(${table.resolverVersion}) > 0 AND btrim(${table.resolverVersion}) = ${table.resolverVersion}`,
  ),
  revisionCheck: check("occurrences_revision_check", sql`${table.currentRevision} > 0`),
  ordinalCheck: check(
    "occurrences_ordinal_check",
    sql`(${table.plannedOrdinal} IS NULL OR ${table.plannedOrdinal} > 0)
      AND (${table.competitionNumber} IS NULL OR ${table.competitionNumber} > 0)
      AND (${table.lifecycle} NOT IN ('published', 'locked') OR ${table.plannedOrdinal} IS NOT NULL)
      AND (${table.lifecycle} NOT IN ('published', 'locked') OR NOT ${table.competitive} OR ${table.competitionNumber} IS NOT NULL)
      AND (${table.competitive} OR ${table.competitionNumber} IS NULL)`,
  ),
  standingsCheck: check("occurrences_standings_check", sql`NOT ${table.countsInStandings} OR ${table.competitive}`),
  lifecycleStatusCheck: check(
    "occurrences_lifecycle_status_check",
    sql`(${table.lifecycle} = 'draft' AND ${table.status} IN ('scheduled', 'cancelled', 'discarded'))
      OR (${table.lifecycle} = 'published' AND ${table.status} IN ('scheduled', 'cancelled'))
      OR (${table.lifecycle} = 'locked' AND ${table.status} IN ('scheduled', 'cancelled', 'completed'))`,
  ),
  metadataCheck: check(
    "occurrences_metadata_check",
    sql`(
      ${table.lifecycle} = 'draft' AND ${table.status} = 'scheduled'
      AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL
      AND ${table.lockedAt} IS NULL AND ${table.lockedByUserId} IS NULL AND ${table.lockReason} IS NULL AND ${table.lockCommandId} IS NULL
      AND ${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL AND ${table.cancellationCommandId} IS NULL
      AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL AND ${table.completionCommandId} IS NULL
      AND ${table.discardedAt} IS NULL AND ${table.discardedByUserId} IS NULL AND ${table.discardCommandId} IS NULL
    ) OR (
      ${table.lifecycle} = 'draft' AND ${table.status} = 'cancelled'
      AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL
      AND ${table.lockedAt} IS NULL AND ${table.lockedByUserId} IS NULL AND ${table.lockReason} IS NULL AND ${table.lockCommandId} IS NULL
      AND ${table.cancelledAt} IS NOT NULL AND ${table.cancelledByUserId} IS NOT NULL AND ${table.cancellationCommandId} IS NOT NULL
      AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL AND ${table.completionCommandId} IS NULL
      AND ${table.discardedAt} IS NULL AND ${table.discardedByUserId} IS NULL AND ${table.discardCommandId} IS NULL
      AND ${table.plannedOrdinal} IS NOT NULL AND ${table.competitionNumber} IS NULL
      AND NOT ${table.competitive} AND NOT ${table.countsInStandings}
    ) OR (
      ${table.lifecycle} = 'draft' AND ${table.status} = 'discarded'
      AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL
      AND ${table.lockedAt} IS NULL AND ${table.lockedByUserId} IS NULL AND ${table.lockReason} IS NULL AND ${table.lockCommandId} IS NULL
      AND ${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL AND ${table.cancellationCommandId} IS NULL
      AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL AND ${table.completionCommandId} IS NULL
      AND ${table.discardedAt} IS NOT NULL AND ${table.discardedByUserId} IS NOT NULL AND ${table.discardCommandId} IS NOT NULL
      AND ${table.plannedOrdinal} IS NULL AND ${table.competitionNumber} IS NULL
    ) OR (
      ${table.lifecycle} = 'published'
      AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL
      AND ${table.lockedAt} IS NULL AND ${table.lockedByUserId} IS NULL AND ${table.lockReason} IS NULL AND ${table.lockCommandId} IS NULL
      AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL AND ${table.completionCommandId} IS NULL
      AND ${table.discardedAt} IS NULL AND ${table.discardedByUserId} IS NULL AND ${table.discardCommandId} IS NULL
      AND ((${table.status} = 'scheduled' AND ${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL AND ${table.cancellationCommandId} IS NULL)
        OR (${table.status} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL AND ${table.cancelledByUserId} IS NOT NULL AND ${table.cancellationCommandId} IS NOT NULL))
    ) OR (
      ${table.lifecycle} = 'locked'
      AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL
      AND ${table.lockedAt} IS NOT NULL AND ${table.lockReason} IS NOT NULL AND length(${table.lockReason}) > 0 AND ${table.lockCommandId} IS NOT NULL
      AND ${table.discardedAt} IS NULL AND ${table.discardedByUserId} IS NULL AND ${table.discardCommandId} IS NULL
      AND ((${table.status} = 'scheduled' AND ${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL AND ${table.cancellationCommandId} IS NULL AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL AND ${table.completionCommandId} IS NULL)
        OR (${table.status} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL AND ${table.cancelledByUserId} IS NOT NULL AND ${table.cancellationCommandId} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.completedByUserId} IS NULL AND ${table.completionCommandId} IS NULL)
        OR (${table.status} = 'completed' AND ${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL AND ${table.cancellationCommandId} IS NULL AND ${table.completedAt} IS NOT NULL AND ${table.completedByUserId} IS NOT NULL AND ${table.completionCommandId} IS NOT NULL))
    )`,
  ),
}));

export const leagueOccurrenceBillingTerms = pgTable("league_occurrence_billing_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  purpose: text("purpose", { enum: LEAGUE_OCCURRENCE_BILLING_PURPOSES }).notNull(),
  obligationPolicy: text("obligation_policy", { enum: LEAGUE_OCCURRENCE_BILLING_POLICIES }).notNull(),
  defaultAmountMinor: integer("default_amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  billingOrdinal: integer("billing_ordinal"),
  version: integer("version").notNull(),
  state: text("state", { enum: LEAGUE_OCCURRENCE_BILLING_STATES }).notNull().default("draft"),
  currentRevision: integer("current_revision").notNull().default(1),
  lastCommandId: uuid("last_command_id"),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  publishedByUserId: integer("published_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  publicationCommandId: uuid("publication_command_id"),
  supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
  supersededByCommandId: uuid("superseded_by_command_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  occurrenceTenantFk: foreignKey({
    name: "billing_terms_occurrence_tenant_fk",
    columns: [table.occurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("billing_terms_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  publicationCommandFk: foreignKey({
    name: "billing_terms_publication_command_fk",
    columns: [table.publicationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  lastCommandFk: foreignKey({
    name: "billing_terms_last_command_fk",
    columns: [table.lastCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  supersededCommandFk: foreignKey({
    name: "billing_terms_superseded_command_fk",
    columns: [table.supersededByCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  purposeCheck: check("billing_terms_purpose_check", sql`${table.purpose} IN (${billingPurposes})`),
  policyCheck: check("billing_terms_policy_check", sql`${table.obligationPolicy} IN (${billingPolicies})`),
  stateCheck: check("billing_terms_state_check", sql`${table.state} IN (${billingStates})`),
  amountPolicyCheck: check(
    "billing_terms_amount_policy_check",
    sql`(${table.obligationPolicy} = 'none' AND ${table.defaultAmountMinor} = 0 AND ${table.billingOrdinal} IS NULL)
      OR (${table.obligationPolicy} = 'eligible_bowlers' AND ${table.defaultAmountMinor} > 0 AND ${table.billingOrdinal} > 0)`,
  ),
  currencyCheck: check("billing_terms_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  versionCheck: check("billing_terms_version_check", sql`${table.version} > 0`),
  revisionCheck: check("billing_terms_revision_check", sql`${table.currentRevision} > 0`),
  lifecycleMetadataCheck: check(
    "billing_terms_lifecycle_metadata_check",
    sql`(
      ${table.state} = 'draft'
      AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL
      AND ${table.supersededAt} IS NULL AND ${table.supersededByCommandId} IS NULL
    ) OR (
      ${table.state} = 'published'
      AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL
      AND ${table.supersededAt} IS NULL AND ${table.supersededByCommandId} IS NULL
    ) OR (
      ${table.state} = 'superseded'
      AND ${table.supersededAt} IS NOT NULL AND ${table.supersededByCommandId} IS NOT NULL
      AND (${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL
        OR ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL)
    )`,
  ),
  currentTermUnique: uniqueIndex("billing_terms_current_unique")
    .on(table.organizationId, table.leagueId, table.occurrenceId, table.purpose)
    .where(sql`${table.state} <> 'superseded' AND ${table.supersededAt} IS NULL`),
  publishedOrdinalUnique: uniqueIndex("billing_terms_published_ordinal_unique")
    .on(table.organizationId, table.leagueId, table.purpose, table.billingOrdinal)
    .where(sql`${table.state} = 'published' AND ${table.supersededAt} IS NULL AND ${table.billingOrdinal} IS NOT NULL`),
  occurrenceIdx: index("billing_terms_occurrence_idx").on(table.organizationId, table.leagueId, table.occurrenceId),
}));

export const leagueOccurrenceRelationships = pgTable("league_occurrence_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  kind: text("kind", { enum: LEAGUE_OCCURRENCE_RELATIONSHIP_KINDS }).notNull(),
  sourceOccurrenceId: uuid("source_occurrence_id").notNull(),
  targetOccurrenceId: uuid("target_occurrence_id").notNull(),
  state: text("state", { enum: LEAGUE_OCCURRENCE_RELATIONSHIP_STATES }).notNull().default("draft"),
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
  sourceTenantFk: foreignKey({
    name: "relationships_source_occurrence_fk",
    columns: [table.sourceOccurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  targetTenantFk: foreignKey({
    name: "relationships_target_occurrence_fk",
    columns: [table.targetOccurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  publicationCommandFk: foreignKey({
    name: "relationships_publication_command_fk",
    columns: [table.publicationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  revocationCommandFk: foreignKey({
    name: "relationships_revocation_command_fk",
    columns: [table.revocationCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  lastCommandFk: foreignKey({
    name: "relationships_last_command_fk",
    columns: [table.lastCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  tenantIdentityUnique: uniqueIndex("relationships_tenant_identity_unique")
    .on(table.id, table.organizationId, table.leagueId),
  kindCheck: check("relationships_kind_check", sql`${table.kind} IN (${relationshipKinds})`),
  differentOccurrencesCheck: check("relationships_different_occurrences_check", sql`${table.sourceOccurrenceId} <> ${table.targetOccurrenceId}`),
  revisionCheck: check("relationships_revision_check", sql`${table.currentRevision} > 0`),
  stateCheck: check(
    "relationships_state_check",
    sql`(${table.state} = 'draft' AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL AND ${table.publicationCommandId} IS NULL AND ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationCommandId} IS NULL)
      OR (${table.state} = 'published' AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationCommandId} IS NULL)
      OR (${table.state} = 'revoked' AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL AND ${table.publicationCommandId} IS NOT NULL AND ${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL AND ${table.revocationCommandId} IS NOT NULL)`,
  ),
  activeSourceUnique: uniqueIndex("relationships_active_source_unique")
    .on(table.organizationId, table.leagueId, table.sourceOccurrenceId)
    .where(sql`${table.state} <> 'revoked'`),
  activeTargetUnique: uniqueIndex("relationships_active_target_unique")
    .on(table.organizationId, table.leagueId, table.targetOccurrenceId)
    .where(sql`${table.state} <> 'revoked'`),
  tenantCreatedIdx: index("relationships_tenant_created_idx").on(table.organizationId, table.createdAt.desc()),
}));

export const leagueOccurrenceRevisions = pgTable("league_occurrence_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  commandId: uuid("command_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  occurrenceTenantFk: foreignKey({
    name: "occurrence_revisions_occurrence_fk",
    columns: [table.occurrenceId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrences.id, leagueOccurrences.organizationId, leagueOccurrences.leagueId],
  }).onDelete("restrict"),
  commandTenantFk: foreignKey({
    name: "occurrence_revisions_command_fk",
    columns: [table.commandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("occurrence_revisions_entity_revision_unique")
    .on(table.organizationId, table.leagueId, table.occurrenceId, table.revisionNumber),
  revisionCheck: check("occurrence_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check(
    "occurrence_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const leagueScheduleExceptionRevisions = pgTable("league_schedule_exception_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  exceptionId: uuid("exception_id").notNull(),
  commandId: uuid("command_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  exceptionTenantFk: foreignKey({
    name: "exception_revisions_exception_fk",
    columns: [table.exceptionId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleExceptions.id, leagueScheduleExceptions.organizationId, leagueScheduleExceptions.leagueId],
  }).onDelete("restrict"),
  commandTenantFk: foreignKey({
    name: "exception_revisions_command_fk",
    columns: [table.commandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("exception_revisions_entity_revision_unique")
    .on(table.organizationId, table.leagueId, table.exceptionId, table.revisionNumber),
  revisionCheck: check("exception_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check(
    "exception_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const leagueOccurrenceRelationshipRevisions = pgTable("league_occurrence_relationship_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  relationshipId: uuid("relationship_id").notNull(),
  commandId: uuid("command_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  relationshipTenantFk: foreignKey({
    name: "relationship_revisions_relationship_fk",
    columns: [table.relationshipId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrenceRelationships.id, leagueOccurrenceRelationships.organizationId, leagueOccurrenceRelationships.leagueId],
  }).onDelete("restrict"),
  commandTenantFk: foreignKey({
    name: "relationship_revisions_command_fk",
    columns: [table.commandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("relationship_revisions_entity_revision_unique")
    .on(table.organizationId, table.leagueId, table.relationshipId, table.revisionNumber),
  revisionCheck: check("relationship_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check(
    "relationship_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const leagueOccurrenceBillingTermRevisions = pgTable("league_occurrence_billing_term_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  billingTermId: uuid("billing_term_id").notNull(),
  commandId: uuid("command_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  billingTermTenantFk: foreignKey({
    name: "billing_term_revisions_billing_term_fk",
    columns: [table.billingTermId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrenceBillingTerms.id, leagueOccurrenceBillingTerms.organizationId, leagueOccurrenceBillingTerms.leagueId],
  }).onDelete("restrict"),
  commandTenantFk: foreignKey({
    name: "billing_term_revisions_command_fk",
    columns: [table.commandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  revisionUnique: uniqueIndex("billing_term_revisions_entity_revision_unique")
    .on(table.organizationId, table.leagueId, table.billingTermId, table.revisionNumber),
  revisionCheck: check("billing_term_revisions_revision_check", sql`${table.revisionNumber} > 0 AND ${table.snapshotSchemaVersion} > 0`),
  snapshotCheck: check(
    "billing_term_revisions_snapshot_check",
    sql`(${table.revisionNumber} = 1 AND ${table.beforeSnapshot} IS NULL) OR (${table.revisionNumber} > 1 AND ${table.beforeSnapshot} IS NOT NULL)`,
  ),
}));

export const leagueOccurrenceGenerationDiscrepancies = pgTable("league_occurrence_generation_discrepancies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  leagueId: integer("league_id").notNull(),
  generationRunId: uuid("generation_run_id").notNull(),
  severity: text("severity", { enum: LEAGUE_GENERATION_DISCREPANCY_SEVERITIES }).notNull(),
  code: text("code", { enum: LEAGUE_GENERATION_DISCREPANCY_CODES }).notNull(),
  generationKey: varchar("generation_key", { length: 255 }),
  details: jsonb("details").notNull(),
  resolutionState: text("resolution_state", { enum: LEAGUE_GENERATION_DISCREPANCY_RESOLUTION_STATES }).notNull().default("open"),
  resolutionCommandId: uuid("resolution_command_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  generationRunFk: foreignKey({
    name: "generation_discrepancies_generation_run_fk",
    columns: [table.generationRunId, table.organizationId, table.leagueId],
    foreignColumns: [leagueOccurrenceGenerationRuns.id, leagueOccurrenceGenerationRuns.organizationId, leagueOccurrenceGenerationRuns.leagueId],
  }).onDelete("restrict"),
  resolutionCommandFk: foreignKey({
    name: "generation_discrepancies_resolution_command_fk",
    columns: [table.resolutionCommandId, table.organizationId, table.leagueId],
    foreignColumns: [leagueScheduleCommands.id, leagueScheduleCommands.organizationId, leagueScheduleCommands.leagueId],
  }).onDelete("restrict"),
  severityCheck: check("generation_discrepancies_severity_check", sql`${table.severity} IN (${discrepancySeverities})`),
  codeCheck: check("generation_discrepancies_code_check", sql`${table.code} IN (${discrepancyCodes})`),
  resolutionCheck: check(
    "generation_discrepancies_resolution_check",
    sql`(${table.resolutionState} = 'open' AND ${table.resolutionCommandId} IS NULL AND ${table.resolvedAt} IS NULL)
      OR (${table.resolutionState} IN ('resolved', 'waived') AND ${table.resolutionCommandId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)`,
  ),
  tenantCreatedIdx: index("generation_discrepancies_tenant_created_idx").on(table.organizationId, table.createdAt.desc()),
  runIdx: index("generation_discrepancies_run_idx").on(table.generationRunId),
}));

export type LeagueScheduleCommand = typeof leagueScheduleCommands.$inferSelect;
export type LeagueOccurrenceGenerationRun = typeof leagueOccurrenceGenerationRuns.$inferSelect;
export type LeagueScheduleException = typeof leagueScheduleExceptions.$inferSelect;
export type LeagueOccurrence = typeof leagueOccurrences.$inferSelect;
export type LeagueOccurrenceBillingTerm = typeof leagueOccurrenceBillingTerms.$inferSelect;
export type LeagueOccurrenceRelationship = typeof leagueOccurrenceRelationships.$inferSelect;
export type LeagueOccurrenceRevision = typeof leagueOccurrenceRevisions.$inferSelect;
export type LeagueScheduleExceptionRevision = typeof leagueScheduleExceptionRevisions.$inferSelect;
export type LeagueOccurrenceRelationshipRevision = typeof leagueOccurrenceRelationshipRevisions.$inferSelect;
export type LeagueOccurrenceBillingTermRevision = typeof leagueOccurrenceBillingTermRevisions.$inferSelect;
export type LeagueOccurrenceGenerationDiscrepancy = typeof leagueOccurrenceGenerationDiscrepancies.$inferSelect;
