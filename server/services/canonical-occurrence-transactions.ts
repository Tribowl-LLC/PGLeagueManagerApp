import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptions,
  games,
  paymentOperations,
  scheduledPaymentOperationSnapshots,
  leagues,
  users,
  canonicalCollectionGroups,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroupMemberRevisions,
  paymentObligations,
  paymentAllocations,
  occurrencePaymentResponsibilities,
  paymentOperationRosterSnapshotItems,
  type LeagueOccurrence,
  type LeagueOccurrenceBillingTerm,
  type LeagueScheduleCommand,
} from "@shared/schema";
import { CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION } from "@shared/canonical-collection-groups";
import {
  lockLeagueSchedule,
  type LeagueScheduleLockExecutor,
  type LeagueScheduleTransaction,
} from "../storage/league-schedule-lock.js";
import {
  canonicalizeTimezone,
  resolveCanonicalLocalDateTime,
  type AmbiguousFoldPolicy,
  type DstFoldResolution,
} from "@shared/canonical-dst-resolver";
import { materializeRosterPaymentOccurrenceInTransaction } from "./roster-payment-materializer.js";

export const CANONICAL_COMMAND_FINGERPRINT_VERSION = "canonical-occurrence-command/1";
export const CANONICAL_COMMAND_FINGERPRINT_PREFIX = "lvcanoncmd:v1:";

export type CanonicalOccurrenceTransactionErrorCode =
  | "invalid_scope"
  | "unauthorized_actor"
  | "invalid_idempotency"
  | "idempotency_conflict"
  | "league_not_found"
  | "same_day_collision"
  | "exact_start_collision"
  | "exception_collision"
  | "invalid_makeup_source"
  | "invalid_makeup_target"
  | "cancelled_target_required"
  | "occurrence_not_found"
  | "occurrence_not_draft"
  | "occurrence_effectively_locked"
  | "occurrence_terminal"
  | "activity_evidence"
  | "invalid_command"
  | "invalid_dst_input";

export class CanonicalOccurrenceTransactionError extends Error {
  readonly code: CanonicalOccurrenceTransactionErrorCode;

  constructor(code: CanonicalOccurrenceTransactionErrorCode, message: string) {
    super(message);
    this.name = "CanonicalOccurrenceTransactionError";
    this.code = code;
  }
}

export interface ScheduleCommandRequest {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  commandType: LeagueScheduleCommand["commandType"];
  idempotencyKey: string;
  requestFingerprint: string;
  sameDayOverride?: boolean;
  reason?: string;
}

export interface OccurrencePlacementRequest extends ScheduleCommandRequest {
  commandType: "generate" | "publish";
  authoritativeLocalDate: string;
  startAt: string;
  existingOccurrenceId?: string;
}

export interface ExceptionPlacementRequest extends ScheduleCommandRequest {
  commandType: "create_exception";
  authoritativeLocalDate: string;
  startAt: string;
}

export interface MakeupRelationshipRequest extends ScheduleCommandRequest {
  commandType: "create_makeup_relationship";
  sourceOccurrenceId: string;
  targetOccurrenceId: string;
}

export interface GenerationRevisionRequest extends ScheduleCommandRequest {
  commandType: "generate";
  generatorVersion: string;
  inputFingerprint: string;
  normalizedInputSnapshot: Record<string, unknown>;
  rangeStartDate: string;
  rangeEndDate: string;
  candidateOccurrenceCount: number;
  generatedOccurrenceCount: number;
  skippedDateCount: number;
  discrepancyCount: number;
}

export interface DraftDiscardRequest extends ScheduleCommandRequest {
  commandType: "discard_draft";
  occurrenceId: string;
  now: string;
  activityEvidence?: readonly string[];
}

export interface OccurrenceCancellationRequest extends ScheduleCommandRequest {
  commandType: "cancel";
  occurrenceId: string;
  now: string;
  activityEvidence?: readonly string[];
}

export interface OccurrenceRescheduleRequest extends ScheduleCommandRequest {
  commandType: "reschedule";
  occurrenceId: string;
  now: string;
  authoritativeLocalDate: string;
  authoritativeLocalStartTime: string;
  timezone: string;
  ambiguousFold: AmbiguousFoldPolicy;
  /** Optional compatibility assertions; the resolver remains authoritative. */
  startAt?: string;
  selectedUtcOffsetMinutes?: number;
  foldResolution?: DstFoldResolution;
  resolverVersion?: string;
}

/**
 * Narrow extension point for an atomic, versioned batch whose complete
 * semantic payload is supplied by a reviewed materialization contract.
 * The established lvcanoncmd:v1 envelope remains authoritative.
 */
export interface MaterializationScheduleCommandRequest extends ScheduleCommandRequest {
  commandType: "generate" | "approve_generation" | "publish" | "cancel" | "create_exception"
    | "reschedule" | "reject_generation" | "restore_cancelled_draft"
    | "publish_collection_group" | "revoke_collection_group" | "repair_collection_group" | "edit_schedule";
  materializationOperation?: "approved_completed_summer_materialization" | "fall_draft_generation"
    | "future_season_draft_generation" | "fall_draft_review" | "canonical_draft_review"
    | "canonical_collection_grouping" | "canonical_schedule_edit";
  materializationPayload: Record<string, unknown>;
}

export type CanonicalScheduleCommandFingerprintRequest =
  | OccurrencePlacementRequest
  | ExceptionPlacementRequest
  | MakeupRelationshipRequest
  | GenerationRevisionRequest
  | DraftDiscardRequest
  | OccurrenceCancellationRequest
  | OccurrenceRescheduleRequest
  | MaterializationScheduleCommandRequest;

async function withDefaultCanonicalTransaction<T>(
  transaction: (tx: LeagueScheduleTransaction) => Promise<T>,
): Promise<T> {
  const { db } = await import("../db.js");
  return db.transaction(transaction);
}

function assertPositiveScope(organizationId: number, leagueId: number): void {
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0 || !Number.isSafeInteger(leagueId) || leagueId <= 0) {
    throw new CanonicalOccurrenceTransactionError("invalid_scope", "organizationId and leagueId must be positive safe integers");
  }
}

function assertValidFingerprint(value: string): void {
  if (!new RegExp(`^${CANONICAL_COMMAND_FINGERPRINT_PREFIX}[0-9a-f]{64}$`).test(value)) {
    throw new CanonicalOccurrenceTransactionError(
      "invalid_idempotency",
      `requestFingerprint must be ${CANONICAL_COMMAND_FINGERPRINT_PREFIX}<lowercase SHA-256>`,
    );
  }
}

function assertValidInputFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CanonicalOccurrenceTransactionError("invalid_idempotency", "inputFingerprint must be lowercase hexadecimal SHA-256");
  }
}

function assertValidIdempotencyKey(value: string): void {
  if (!/^(?!\s)(?!.*\s$).{1,255}$/.test(value)) {
    throw new CanonicalOccurrenceTransactionError("invalid_idempotency", "idempotencyKey must be nonempty, trimmed, and at most 255 characters");
  }
}

function assertValidInstant(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CanonicalOccurrenceTransactionError("invalid_command", `${field} must be an explicit UTC ISO instant`);
  }
}

function assertValidReason(reason: string | undefined): string {
  if (!reason || reason.trim() !== reason || reason.length === 0) {
    throw new CanonicalOccurrenceTransactionError("invalid_command", "audited schedule mutation requires a nonempty trimmed reason");
  }
  return reason;
}

function canonicalizeCommandValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical command payload cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeCommandValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeCommandValue(entry)}`).join(",")}}`;
  }
  throw new Error("canonical command payload cannot contain an unsupported value");
}

function normalizeCommandTime(value: string): string {
  if (typeof value !== "string") {
    throw new CanonicalOccurrenceTransactionError("invalid_command", "authoritativeLocalStartTime is required for reschedule commands");
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return value;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}`;
}

function resolveRescheduleRequest(request: OccurrenceRescheduleRequest): OccurrenceRescheduleRequest & {
  startAt: string;
  selectedUtcOffsetMinutes: number;
  foldResolution: DstFoldResolution;
  resolverVersion: string;
} {
  const authoritativeLocalStartTime = normalizeCommandTime(request.authoritativeLocalStartTime);
  let resolution;
  try {
    resolution = resolveCanonicalLocalDateTime({
      localDate: request.authoritativeLocalDate,
      localTime: authoritativeLocalStartTime,
      timezone: request.timezone,
      ambiguousFold: request.ambiguousFold,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new CanonicalOccurrenceTransactionError("invalid_dst_input", message);
  }
  if (request.startAt !== undefined && request.startAt !== resolution.startAt) {
    throw new CanonicalOccurrenceTransactionError("invalid_dst_input", "caller-supplied startAt does not match canonical DST resolution");
  }
  if (request.selectedUtcOffsetMinutes !== undefined && request.selectedUtcOffsetMinutes !== resolution.selectedUtcOffsetMinutes) {
    throw new CanonicalOccurrenceTransactionError("invalid_dst_input", "caller-supplied UTC offset does not match canonical DST resolution");
  }
  if (request.foldResolution !== undefined && request.foldResolution !== resolution.foldResolution) {
    throw new CanonicalOccurrenceTransactionError("invalid_dst_input", "caller-supplied fold resolution does not match canonical DST resolution");
  }
  if (request.resolverVersion !== undefined && request.resolverVersion !== resolution.resolverVersion) {
    throw new CanonicalOccurrenceTransactionError("invalid_dst_input", "caller-supplied resolver version is not authoritative");
  }
  return {
    ...request,
    authoritativeLocalStartTime,
    timezone: resolution.canonicalTimezone,
    startAt: resolution.startAt,
    selectedUtcOffsetMinutes: resolution.selectedUtcOffsetMinutes,
    foldResolution: resolution.foldResolution,
    resolverVersion: resolution.resolverVersion,
  };
}

function canonicalCommandTimezone(value: string): string {
  if (typeof value !== "string") {
    throw new CanonicalOccurrenceTransactionError("invalid_command", "timezone is required for reschedule commands");
  }
  try {
    return canonicalizeTimezone(value);
  } catch {
    return value.trim();
  }
}

function commandFingerprintPayload(request: CanonicalScheduleCommandFingerprintRequest): Record<string, unknown> {
  const common = {
    organizationId: request.organizationId,
    leagueId: request.leagueId,
    actorUserId: request.actorUserId,
    commandType: request.commandType,
    sameDayOverride: request.sameDayOverride ?? false,
    reason: request.reason ?? null,
  };
  if ("materializationPayload" in request) {
    return {
      ...common,
      operation: request.materializationOperation ?? "approved_completed_summer_materialization",
      materializationPayload: request.materializationPayload,
    };
  }
  switch (request.commandType) {
    case "generate":
      if ("generatorVersion" in request) {
        return {
          ...common,
          operation: "generation_revision",
          generatorVersion: request.generatorVersion,
          inputFingerprint: request.inputFingerprint,
          normalizedInputSnapshot: request.normalizedInputSnapshot,
          rangeStartDate: request.rangeStartDate,
          rangeEndDate: request.rangeEndDate,
          candidateOccurrenceCount: request.candidateOccurrenceCount,
          generatedOccurrenceCount: request.generatedOccurrenceCount,
          skippedDateCount: request.skippedDateCount,
          discrepancyCount: request.discrepancyCount,
        };
      }
      return {
        ...common,
        operation: "occurrence_placement",
        authoritativeLocalDate: request.authoritativeLocalDate,
        startAt: request.startAt,
        existingOccurrenceId: request.existingOccurrenceId ?? null,
      };
    case "publish":
      return {
        ...common,
        operation: "occurrence_placement",
        authoritativeLocalDate: request.authoritativeLocalDate,
        startAt: request.startAt,
        existingOccurrenceId: request.existingOccurrenceId ?? null,
      };
    case "create_exception":
      return {
        ...common,
        operation: "exception_placement",
        authoritativeLocalDate: request.authoritativeLocalDate,
        startAt: request.startAt,
      };
    case "create_makeup_relationship":
      return {
        ...common,
        operation: "makeup_relationship",
        sourceOccurrenceId: request.sourceOccurrenceId,
        targetOccurrenceId: request.targetOccurrenceId,
      };
    case "discard_draft":
      return {
        ...common,
        operation: "discard_draft",
        occurrenceId: request.occurrenceId,
        now: request.now,
        activityEvidence: [...(request.activityEvidence ?? [])],
      };
    case "cancel":
      return {
        ...common,
        operation: "cancel",
        occurrenceId: request.occurrenceId,
        now: request.now,
        activityEvidence: [...(request.activityEvidence ?? [])],
      };
    case "reschedule": {
      return {
        ...common,
        operation: "reschedule",
        occurrenceId: request.occurrenceId,
        now: request.now,
        authoritativeLocalDate: request.authoritativeLocalDate,
        authoritativeLocalStartTime: normalizeCommandTime(request.authoritativeLocalStartTime),
        timezone: canonicalCommandTimezone(request.timezone),
        ambiguousFold: request.ambiguousFold,
      };
    }
    default:
      return { ...common, operation: "schedule_command" };
  }
}

/** Build the exact versioned fingerprint that the transaction service accepts. */
export function buildCanonicalScheduleCommandFingerprint(request: CanonicalScheduleCommandFingerprintRequest): string {
  const canonical = canonicalizeCommandValue({
    version: CANONICAL_COMMAND_FINGERPRINT_VERSION,
    payload: commandFingerprintPayload(request),
  });
  return `${CANONICAL_COMMAND_FINGERPRINT_PREFIX}${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function assertExpectedCommandType(
  request: ScheduleCommandRequest,
  allowedCommandTypes: readonly LeagueScheduleCommand["commandType"][],
): void {
  if (!allowedCommandTypes.includes(request.commandType)) {
    throw new CanonicalOccurrenceTransactionError("invalid_command", "command type is not valid for this schedule operation");
  }
}

export async function assertCanonicalScheduleTenantAndActor(
  tx: LeagueScheduleLockExecutor,
  request: ScheduleCommandRequest,
): Promise<void> {
  assertPositiveScope(request.organizationId, request.leagueId);
  if (!Number.isSafeInteger(request.actorUserId) || request.actorUserId <= 0) {
    throw new CanonicalOccurrenceTransactionError("unauthorized_actor", "actorUserId must be a positive safe integer");
  }
  const [league] = await tx
    .select({ id: leagues.id, organizationId: leagues.organizationId })
    .from(leagues)
    .where(and(eq(leagues.id, request.leagueId), eq(leagues.organizationId, request.organizationId)))
    .for("update");
  if (!league || league.organizationId !== request.organizationId) {
    throw new CanonicalOccurrenceTransactionError("league_not_found", "league is missing or outside the requested tenant");
  }
  const [actor] = await tx
    .select({ id: users.id, organizationId: users.organizationId, role: users.role })
    .from(users)
    .where(eq(users.id, request.actorUserId))
    .for("update");
  if (!actor || (actor.role !== "system_admin" && (actor.role !== "org_admin" || actor.organizationId !== request.organizationId))) {
    throw new CanonicalOccurrenceTransactionError("unauthorized_actor", "actor is not authorized for the requested tenant");
  }
}

function commandEquivalent(existing: LeagueScheduleCommand, request: ScheduleCommandRequest): boolean {
  return existing.leagueId === request.leagueId
    && existing.actorUserId === request.actorUserId
    && existing.commandType === request.commandType
    && existing.requestFingerprint === request.requestFingerprint
    && existing.sameDayOverride === (request.sameDayOverride ?? false)
    && existing.reason === (request.reason ?? null);
}

/** Must be called after the shared league lock has been acquired. */
export async function getOrCreateCanonicalScheduleCommandInTransaction(
  tx: LeagueScheduleLockExecutor,
  request: CanonicalScheduleCommandFingerprintRequest,
  allowedCommandTypes: readonly LeagueScheduleCommand["commandType"][],
): Promise<{ command: LeagueScheduleCommand; existing: boolean }> {
  assertExpectedCommandType(request, allowedCommandTypes);
  assertValidIdempotencyKey(request.idempotencyKey);
  assertValidFingerprint(request.requestFingerprint);
  if (request.requestFingerprint !== buildCanonicalScheduleCommandFingerprint(request)) {
    throw new CanonicalOccurrenceTransactionError("invalid_idempotency", "requestFingerprint does not match the canonical schedule operation payload");
  }
  if (request.sameDayOverride && !request.reason?.trim()) {
    throw new CanonicalOccurrenceTransactionError("invalid_command", "same-day override requires a nonempty reason");
  }
  await assertCanonicalScheduleTenantAndActor(tx, request);
  const [existing] = await tx
    .select()
    .from(leagueScheduleCommands)
    .where(and(
      eq(leagueScheduleCommands.organizationId, request.organizationId),
      eq(leagueScheduleCommands.idempotencyKey, request.idempotencyKey),
    ))
    .for("update");
  if (existing) {
    if (!commandEquivalent(existing, request)) {
      throw new CanonicalOccurrenceTransactionError("idempotency_conflict", "idempotency key is already bound to a different request");
    }
    return { command: existing, existing: true };
  }
  const [command] = await tx
    .insert(leagueScheduleCommands)
    .values({
      organizationId: request.organizationId,
      leagueId: request.leagueId,
      actorUserId: request.actorUserId,
      commandType: request.commandType,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: request.requestFingerprint,
      sameDayOverride: request.sameDayOverride ?? false,
      reason: request.reason,
    })
    .returning();
  if (!command) throw new CanonicalOccurrenceTransactionError("invalid_command", "schedule command was not created");
  return { command, existing: false };
}

export async function validateCanonicalOccurrencePlacementInTransaction(
  tx: LeagueScheduleLockExecutor,
  request: Pick<OccurrencePlacementRequest, "organizationId" | "leagueId" | "authoritativeLocalDate" | "startAt" | "existingOccurrenceId" | "sameDayOverride">,
  originatingCommandId?: string,
): Promise<LeagueOccurrence[]> {
  assertValidInstant(request.startAt, "startAt");
  const rows = await tx
    .select()
    .from(leagueOccurrences)
    .where(and(
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
      ne(leagueOccurrences.status, "discarded"),
      ne(leagueOccurrences.status, "cancelled"),
    ))
    .for("update");
  const collisions = rows.filter((row) =>
    row.id !== request.existingOccurrenceId
    && row.lastCommandId !== originatingCommandId
  );
  const requestStartMs = Date.parse(request.startAt);
  const exactStart = collisions.find((row) => Date.parse(row.startAt) === requestStartMs);
  if (exactStart) {
    throw new CanonicalOccurrenceTransactionError("exact_start_collision", "two active occurrences cannot share the same start instant");
  }
  const sameDayCollisions = collisions.filter((row) => row.authoritativeLocalDate === request.authoritativeLocalDate);
  if (sameDayCollisions.length > 0 && !request.sameDayOverride) {
    throw new CanonicalOccurrenceTransactionError("same_day_collision", "same-day occurrence requires an explicit audited override");
  }
  return collisions;
}

export interface LockedScheduleMutationContext {
  tx: LeagueScheduleLockExecutor;
  command: LeagueScheduleCommand;
  existing: boolean;
}

async function withLockedScheduleCommand<T>(
  request: CanonicalScheduleCommandFingerprintRequest,
  allowedCommandTypes: readonly LeagueScheduleCommand["commandType"][],
  mutation: (context: LockedScheduleMutationContext) => Promise<T>,
): Promise<T> {
  return withDefaultCanonicalTransaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const command = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, allowedCommandTypes);
    return mutation({ tx, ...command });
  });
}

export interface LockedOccurrencePlacementContext extends LockedScheduleMutationContext {
  collisions: LeagueOccurrence[];
}

/**
 * Keep the league lock through validation and the caller's eventual mutation.
 * Every retry revalidates current state, excluding only rows attributable to
 * this command. The callback is the B2 boundary; it must use the supplied
 * transaction and treat `existing` as an idempotent retry of its own mutation.
 */
export async function withLockedOccurrencePlacementMutation<T>(
  request: OccurrencePlacementRequest,
  mutation: (context: LockedOccurrencePlacementContext) => Promise<T>,
): Promise<T> {
  return withLockedScheduleCommand(request, ["generate", "publish"], async (context) => {
    const collisions = await validateCanonicalOccurrencePlacementInTransaction(context.tx, request, context.command.id);
    return mutation({ ...context, collisions });
  });
}

/** Preflight only: the lock ends when this function returns; no later independent write is protected. */
export async function validateOccurrencePlacement(request: OccurrencePlacementRequest): Promise<LeagueScheduleCommand> {
  return withLockedOccurrencePlacementMutation(request, async ({ command }) => command);
}

export async function validateCanonicalExceptionPlacementInTransaction(
  tx: LeagueScheduleLockExecutor,
  request: ExceptionPlacementRequest,
  originatingCommandId?: string,
): Promise<void> {
  const activeExceptions = await tx
    .select({ id: leagueScheduleExceptions.id, lastCommandId: leagueScheduleExceptions.lastCommandId })
    .from(leagueScheduleExceptions)
    .where(and(
      eq(leagueScheduleExceptions.organizationId, request.organizationId),
      eq(leagueScheduleExceptions.leagueId, request.leagueId),
      eq(leagueScheduleExceptions.localDate, request.authoritativeLocalDate),
      ne(leagueScheduleExceptions.lifecycle, "revoked"),
    ))
    .for("update");
  if (activeExceptions.some((row) => row.lastCommandId !== originatingCommandId)) {
    throw new CanonicalOccurrenceTransactionError("exception_collision", "an active exception already exists for this tenant and local date");
  }
  const [activeOccurrence] = await tx
    .select({ id: leagueOccurrences.id })
    .from(leagueOccurrences)
    .where(and(
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
      eq(leagueOccurrences.authoritativeLocalDate, request.authoritativeLocalDate),
      ne(leagueOccurrences.status, "discarded"),
    ))
    .for("update");
  if (activeOccurrence) throw new CanonicalOccurrenceTransactionError("exception_collision", "an active occurrence already exists for this exception date");
}

export async function withLockedExceptionPlacementMutation<T>(
  request: ExceptionPlacementRequest,
  mutation: (context: LockedScheduleMutationContext) => Promise<T>,
): Promise<T> {
  return withLockedScheduleCommand(request, ["create_exception"], async (context) => {
    await validateCanonicalExceptionPlacementInTransaction(context.tx, request, context.command.id);
    return mutation(context);
  });
}

/** Preflight only: the lock ends when this function returns; no later independent write is protected. */
export async function validateExceptionPlacement(
  request: ExceptionPlacementRequest,
): Promise<LeagueScheduleCommand> {
  return withLockedExceptionPlacementMutation(request, async ({ command }) => command);
}

async function validateMakeupRelationshipInTransaction(
  tx: LeagueScheduleLockExecutor,
  request: MakeupRelationshipRequest,
  originatingCommandId?: string,
): Promise<void> {
    const ids = [request.sourceOccurrenceId, request.targetOccurrenceId];
    const rows = await tx
      .select()
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.organizationId, request.organizationId),
        eq(leagueOccurrences.leagueId, request.leagueId),
      ))
      .for("update");
    const source = rows.find((row) => row.id === ids[0]);
    const target = rows.find((row) => row.id === ids[1]);
    if (!source || source.status === "discarded" || source.kind !== "makeup") {
      throw new CanonicalOccurrenceTransactionError("invalid_makeup_source", "makeup_for source must be a non-discarded makeup occurrence in the same tenant");
    }
    if (!target || target.status === "discarded" || target.kind !== "regular") {
      throw new CanonicalOccurrenceTransactionError("invalid_makeup_target", "makeup_for target must be a non-discarded regular occurrence in the same tenant");
    }
    if (target.status !== "cancelled") {
      throw new CanonicalOccurrenceTransactionError("cancelled_target_required", "makeup_for target must be explicitly cancelled");
    }
    const existingSources = await tx
      .select({ id: leagueOccurrenceRelationships.id, lastCommandId: leagueOccurrenceRelationships.lastCommandId })
      .from(leagueOccurrenceRelationships)
      .where(and(
        eq(leagueOccurrenceRelationships.organizationId, request.organizationId),
        eq(leagueOccurrenceRelationships.leagueId, request.leagueId),
        eq(leagueOccurrenceRelationships.sourceOccurrenceId, source.id),
        ne(leagueOccurrenceRelationships.state, "revoked"),
      ))
      .for("update");
    if (existingSources.some((row) => row.lastCommandId !== originatingCommandId)) {
      throw new CanonicalOccurrenceTransactionError("invalid_command", "source occurrence already has an active makeup relationship");
    }
}

export async function withLockedMakeupRelationshipMutation<T>(
  request: MakeupRelationshipRequest,
  mutation: (context: LockedScheduleMutationContext) => Promise<T>,
): Promise<T> {
  return withLockedScheduleCommand(request, ["create_makeup_relationship"], async (context) => {
    await validateMakeupRelationshipInTransaction(context.tx, request, context.command.id);
    return mutation(context);
  });
}

/** Preflight only: the lock ends when this function returns; no later independent write is protected. */
export async function validateMakeupRelationship(request: MakeupRelationshipRequest): Promise<LeagueScheduleCommand> {
  return withLockedMakeupRelationshipMutation(request, async ({ command }) => command);
}

export async function allocateCanonicalSourceScheduleRevisionInTransaction(
  tx: LeagueScheduleLockExecutor,
  organizationId: number,
  leagueId: number,
): Promise<number> {
  const [latest] = await tx
    .select({ sourceScheduleRevision: leagueOccurrenceGenerationRuns.sourceScheduleRevision })
    .from(leagueOccurrenceGenerationRuns)
    .where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, leagueId),
    ))
    .orderBy(desc(leagueOccurrenceGenerationRuns.sourceScheduleRevision))
    .limit(1)
    .for("update");
  return (latest?.sourceScheduleRevision ?? 0) + 1;
}

/** Allocate max(source_schedule_revision)+1 while holding the shared lock. */
export async function createGenerationRevision(request: GenerationRevisionRequest): Promise<{
  command: LeagueScheduleCommand;
  generationRun: typeof leagueOccurrenceGenerationRuns.$inferSelect;
}> {
  return withDefaultCanonicalTransaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, ["generate"]);
    const [existingRun] = await tx
      .select()
      .from(leagueOccurrenceGenerationRuns)
      .where(and(
        eq(leagueOccurrenceGenerationRuns.organizationId, request.organizationId),
        eq(leagueOccurrenceGenerationRuns.leagueId, request.leagueId),
        eq(leagueOccurrenceGenerationRuns.originatingCommandId, command.id),
      ));
    if (existing && existingRun) return { command, generationRun: existingRun };
    if (existing && !existingRun) throw new CanonicalOccurrenceTransactionError("idempotency_conflict", "generation command exists without its committed generation run");
    assertPositiveScope(request.organizationId, request.leagueId);
    assertValidInputFingerprint(request.inputFingerprint);
    if (!/^.{1,128}$/.test(request.generatorVersion) || request.generatorVersion.trim() !== request.generatorVersion) throw new CanonicalOccurrenceTransactionError("invalid_command", "generatorVersion must be nonempty and fit A1");
    const sourceScheduleRevision = await allocateCanonicalSourceScheduleRevisionInTransaction(tx, request.organizationId, request.leagueId);
    const [generationRun] = await tx
      .insert(leagueOccurrenceGenerationRuns)
      .values({
        organizationId: request.organizationId,
        leagueId: request.leagueId,
        originatingCommandId: command.id,
        generatorVersion: request.generatorVersion,
        inputFingerprint: request.inputFingerprint,
        sourceScheduleRevision,
        normalizedInputSnapshot: request.normalizedInputSnapshot,
        rangeStartDate: request.rangeStartDate,
        rangeEndDate: request.rangeEndDate,
        candidateOccurrenceCount: request.candidateOccurrenceCount,
        generatedOccurrenceCount: request.generatedOccurrenceCount,
        skippedDateCount: request.skippedDateCount,
        discrepancyCount: request.discrepancyCount,
      })
      .returning();
    if (!generationRun) throw new CanonicalOccurrenceTransactionError("invalid_command", "generation run was not created");
    return { command, generationRun };
  });
}

function occurrenceSnapshot(row: LeagueOccurrence): Record<string, unknown> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    locationId: row.locationId,
    generationKey: row.generationKey,
    generationRunId: row.generationRunId,
    kind: row.kind,
    status: row.status,
    lifecycle: row.lifecycle,
    authoritativeLocalDate: row.authoritativeLocalDate,
    authoritativeLocalStartTime: row.authoritativeLocalStartTime,
    timezone: row.timezone,
    startAt: row.startAt,
    selectedUtcOffsetMinutes: row.selectedUtcOffsetMinutes,
    foldResolution: row.foldResolution,
    resolverVersion: row.resolverVersion,
    plannedOrdinal: row.plannedOrdinal,
    competitionNumber: row.competitionNumber,
    competitive: row.competitive,
    countsInStandings: row.countsInStandings,
    currentRevision: row.currentRevision,
    lastCommandId: row.lastCommandId,
  };
}

function billingTermSnapshot(row: LeagueOccurrenceBillingTerm): Record<string, unknown> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    occurrenceId: row.occurrenceId,
    purpose: row.purpose,
    obligationPolicy: row.obligationPolicy,
    defaultAmountMinor: row.defaultAmountMinor,
    billingOrdinal: row.billingOrdinal,
    version: row.version,
    currency: row.currency,
  };
}

async function assertNotEffectivelyLocked(
  tx: LeagueScheduleLockExecutor,
  row: LeagueOccurrence,
  now: string,
): Promise<void> {
  assertValidInstant(now, "now");
  if (Date.parse(row.startAt) <= Date.parse(now) || row.lifecycle === "locked" || row.lockedAt !== null) {
    throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence is effectively locked at the supplied authoritative now");
  }
  const [linkedGame] = await tx.select({ id: games.id }).from(games).where(and(
    eq(games.leagueId, row.leagueId),
    eq(games.occurrenceId, row.id),
  )).limit(1);
  const [linkedOperation] = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, row.organizationId),
    eq(paymentOperations.triggerOccurrenceId, row.id),
  )).limit(1);
  const [obligation] = await tx.select({ id: paymentObligations.id })
    .from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, row.organizationId),
      eq(paymentObligations.leagueId, row.leagueId),
      eq(paymentObligations.occurrenceId, row.id),
    )).limit(1);
  const [allocation] = await tx.select({ id: paymentAllocations.id })
    .from(paymentAllocations)
    .innerJoin(paymentObligations, and(
      eq(paymentObligations.id, paymentAllocations.obligationId),
      eq(paymentObligations.organizationId, row.organizationId),
      eq(paymentObligations.leagueId, row.leagueId),
      eq(paymentObligations.occurrenceId, row.id),
    )).where(and(
      eq(paymentAllocations.organizationId, row.organizationId),
      eq(paymentAllocations.leagueId, row.leagueId),
      eq(paymentAllocations.state, "active"),
    )).limit(1);
  const [groupMember] = await tx.select({ id: canonicalCollectionGroupMembers.id })
    .from(canonicalCollectionGroupMembers).where(and(
      eq(canonicalCollectionGroupMembers.organizationId, row.organizationId),
      eq(canonicalCollectionGroupMembers.leagueId, row.leagueId),
      eq(canonicalCollectionGroupMembers.occurrenceId, row.id),
      eq(canonicalCollectionGroupMembers.active, true),
    )).limit(1);
  if (
    linkedGame
    || linkedOperation
    || obligation
    || allocation
    || groupMember
  ) {
    throw new CanonicalOccurrenceTransactionError(
      "occurrence_effectively_locked",
      "occurrence is effectively locked by linked schedule, participation, obligation, collection, or settlement evidence",
    );
  }
}

/**
 * Rescheduling is intentionally narrower than ordinary draft discard. A
 * roster-ready future occurrence already has open obligations, so their mere
 * existence is not a lock. They may be versioned only while every financial
 * row is still open, unallocated, and unclaimed. The league lock is held by
 * the caller; row locks here make the guard and the versioning operation one
 * atomic decision.
 */
async function assertRescheduleFinanciallyEditableInTransaction(
  tx: LeagueScheduleLockExecutor,
  row: LeagueOccurrence,
  now: string,
): Promise<void> {
  assertValidInstant(now, "now");
  if (Date.parse(row.startAt) <= Date.parse(now) || row.lifecycle !== "published" || row.lockedAt !== null) {
    throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "only a future published occurrence can be rescheduled");
  }
  const [linkedGame] = await tx.select({ id: games.id }).from(games).where(and(
    eq(games.leagueId, row.leagueId),
    eq(games.occurrenceId, row.id),
  )).limit(1);
  if (linkedGame) throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence has participation evidence");
  const [groupMember] = await tx.select({ id: canonicalCollectionGroupMembers.id }).from(canonicalCollectionGroupMembers).where(and(
    eq(canonicalCollectionGroupMembers.organizationId, row.organizationId),
    eq(canonicalCollectionGroupMembers.leagueId, row.leagueId),
    eq(canonicalCollectionGroupMembers.occurrenceId, row.id),
    eq(canonicalCollectionGroupMembers.active, true),
  )).limit(1);
  if (groupMember) throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence is in an active collection group");

  // trigger_occurrence_id is the retained ledger's canonical occurrence
  // identity. Do not require the optional operation league_id here: legacy
  // scheduled operations may intentionally leave it null, and they still
  // lock a physical occurrence for rescheduling.
  const linkedOperations = await tx.select({ id: paymentOperations.id, status: paymentOperations.status, dispatchClaimedAt: paymentOperations.dispatchClaimedAt }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, row.organizationId),
    eq(paymentOperations.triggerOccurrenceId, row.id),
  )).for("update");
  if (linkedOperations.length > 0) {
    throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence has payment-operation evidence");
  }

  const obligations = await tx.select({ id: paymentObligations.id, state: paymentObligations.state }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, row.organizationId),
    eq(paymentObligations.leagueId, row.leagueId),
    eq(paymentObligations.occurrenceId, row.id),
  )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.id)).for("update");
  if (obligations.some((obligation) => obligation.state !== "open")) {
    throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence has settled, voided, or review-required obligation evidence");
  }
  const obligationIds = obligations.map((obligation) => obligation.id);
  if (obligationIds.length === 0) return;
  const [allocation] = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, row.organizationId),
    eq(paymentAllocations.leagueId, row.leagueId),
    inArray(paymentAllocations.obligationId, obligationIds),
    eq(paymentAllocations.state, "active"),
  )).for("update");
  if (allocation) throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence has active allocation evidence");
  const rosterItems = await tx.select({ operationId: paymentOperationRosterSnapshotItems.operationId, state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, row.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, row.leagueId),
    inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
  )).for("update");
  const rosterOperationIds = [...new Set(rosterItems.map((item) => item.operationId))];
  if (rosterItems.some((item) => item.state === "reserved" || item.state === "finalized")) {
    throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence has reserved payment-operation evidence");
  }
  if (rosterOperationIds.length > 0) {
    const rosterOperations = await tx.select({ id: paymentOperations.id, status: paymentOperations.status, dispatchClaimedAt: paymentOperations.dispatchClaimedAt }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, row.organizationId),
      eq(paymentOperations.leagueId, row.leagueId),
      inArray(paymentOperations.id, rosterOperationIds),
    )).for("update");
    if (rosterOperations.some((operation) => operation.dispatchClaimedAt !== null || ["leased", "provider_unknown", "succeeded", "action_required", "failed_terminal", "reconciliation_required"].includes(operation.status))) {
      throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence has dispatched or provider payment-operation evidence");
    }
  }
}

/** Cancellation keeps UUID/identity but still refuses a past or explicitly
 * locked occurrence. Financial rows are handled by cancelOccurrence below so
 * open obligations/plans can be voided without touching settled allocations. */
async function assertCancellationWindow(row: LeagueOccurrence, now: string): Promise<void> {
  assertValidInstant(now, "now");
  if (Date.parse(row.startAt) <= Date.parse(now) || row.lifecycle === "locked" || row.lockedAt !== null) {
    throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "occurrence is effectively locked at the supplied authoritative now");
  }
}

/** Discard one draft atomically; no UUID or generation key is regenerated. */
export async function discardDraftOccurrence(request: DraftDiscardRequest): Promise<{
  command: LeagueScheduleCommand;
  occurrence: LeagueOccurrence;
  supersededBillingTermIds: string[];
}> {
  assertValidReason(request.reason);
  return withDefaultCanonicalTransaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, ["discard_draft"]);
    const [occurrence] = await tx
      .select()
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.id, request.occurrenceId),
        eq(leagueOccurrences.organizationId, request.organizationId),
        eq(leagueOccurrences.leagueId, request.leagueId),
      ))
      .for("update");
    if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
    if (existing && occurrence.discardCommandId === command.id) {
      const terms = await tx.select({ id: leagueOccurrenceBillingTerms.id }).from(leagueOccurrenceBillingTerms).where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, request.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, request.leagueId),
        eq(leagueOccurrenceBillingTerms.occurrenceId, request.occurrenceId),
        eq(leagueOccurrenceBillingTerms.state, "superseded"),
        eq(leagueOccurrenceBillingTerms.supersededByCommandId, command.id),
      ));
      return { command, occurrence, supersededBillingTermIds: terms.map((term) => term.id) };
    }
    if (occurrence.lifecycle !== "draft" || occurrence.status !== "scheduled") throw new CanonicalOccurrenceTransactionError("occurrence_not_draft", "only a scheduled draft occurrence can be discarded");
    if (request.activityEvidence && request.activityEvidence.length > 0) throw new CanonicalOccurrenceTransactionError("activity_evidence", "draft discard is refused when explicit activity evidence is present");
    await assertNotEffectivelyLocked(tx, occurrence, request.now);
    const terms = await tx
      .select()
      .from(leagueOccurrenceBillingTerms)
      .where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, request.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, request.leagueId),
        eq(leagueOccurrenceBillingTerms.occurrenceId, occurrence.id),
        eq(leagueOccurrenceBillingTerms.state, "draft"),
        isNull(leagueOccurrenceBillingTerms.supersededAt),
      ))
      .for("update");
    const beforeOccurrence = occurrenceSnapshot(occurrence);
    const nextOccurrenceRevision = occurrence.currentRevision + 1;
    const [discarded] = await tx
      .update(leagueOccurrences)
      .set({
        status: "discarded",
        plannedOrdinal: null,
        competitionNumber: null,
        currentRevision: nextOccurrenceRevision,
        lastCommandId: command.id,
        discardedAt: request.now,
        discardedByUserId: request.actorUserId,
        discardCommandId: command.id,
      })
      .where(and(
        eq(leagueOccurrences.id, occurrence.id),
        eq(leagueOccurrences.organizationId, request.organizationId),
        eq(leagueOccurrences.leagueId, request.leagueId),
      ))
      .returning();
    if (!discarded) throw new CanonicalOccurrenceTransactionError("invalid_command", "draft discard did not update its occurrence");
    await tx.insert(leagueOccurrenceRevisions).values({
      organizationId: request.organizationId,
      leagueId: request.leagueId,
      occurrenceId: occurrence.id,
      commandId: command.id,
      revisionNumber: nextOccurrenceRevision,
      snapshotSchemaVersion: 1,
      beforeSnapshot: beforeOccurrence,
      afterSnapshot: occurrenceSnapshot(discarded),
    });
    const supersededBillingTermIds: string[] = [];
    for (const term of terms) {
      const nextRevision = term.currentRevision + 1;
      const [superseded] = await tx
        .update(leagueOccurrenceBillingTerms)
        .set({
          state: "superseded",
          currentRevision: nextRevision,
          lastCommandId: command.id,
          supersededAt: request.now,
          supersededByCommandId: command.id,
        })
        .where(and(
          eq(leagueOccurrenceBillingTerms.id, term.id),
          eq(leagueOccurrenceBillingTerms.organizationId, request.organizationId),
          eq(leagueOccurrenceBillingTerms.leagueId, request.leagueId),
        ))
        .returning();
      if (!superseded) throw new CanonicalOccurrenceTransactionError("invalid_command", "billing term discard update failed");
      supersededBillingTermIds.push(term.id);
      await tx.insert(leagueOccurrenceBillingTermRevisions).values({
        organizationId: request.organizationId,
        leagueId: request.leagueId,
        billingTermId: term.id,
        commandId: command.id,
        revisionNumber: nextRevision,
        snapshotSchemaVersion: 1,
        beforeSnapshot: billingTermSnapshot(term),
        afterSnapshot: billingTermSnapshot(superseded),
      });
    }
    return { command, occurrence: discarded, supersededBillingTermIds };
  });
}

/** Cancel a published/locked occurrence while retaining its planned ordinal and revision history. */
export async function cancelOccurrenceInTransaction(tx: LeagueScheduleTransaction, request: OccurrenceCancellationRequest): Promise<LeagueOccurrence> {
  assertValidReason(request.reason);
  assertValidInstant(request.now, "now");
  await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, ["cancel"]);
    const [occurrence] = await tx.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, request.occurrenceId),
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
    )).for("update");
    if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
    if (existing && occurrence.cancellationCommandId === command.id) return occurrence;
    if (occurrence.lifecycle === "draft" || occurrence.status !== "scheduled") throw new CanonicalOccurrenceTransactionError("occurrence_terminal", "only a scheduled published or locked occurrence can be cancelled");
    if (request.activityEvidence && request.activityEvidence.length > 0) throw new CanonicalOccurrenceTransactionError("activity_evidence", "cancellation is refused when explicit activity evidence is present");
    await assertCancellationWindow(occurrence, request.now);
    const nextRevision = occurrence.currentRevision + 1;
    const [cancelled] = await tx.update(leagueOccurrences).set({
      status: "cancelled",
      competitive: false,
      countsInStandings: false,
      competitionNumber: null,
      currentRevision: nextRevision,
      lastCommandId: command.id,
      cancelledAt: request.now,
      cancelledByUserId: request.actorUserId,
      cancellationCommandId: command.id,
    }).where(and(
      eq(leagueOccurrences.id, occurrence.id),
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
    )).returning();
    if (!cancelled) throw new CanonicalOccurrenceTransactionError("invalid_command", "cancellation did not update its occurrence");
    await tx.insert(leagueOccurrenceRevisions).values({
      organizationId: request.organizationId,
      leagueId: request.leagueId,
      occurrenceId: occurrence.id,
      commandId: command.id,
      revisionNumber: nextRevision,
      snapshotSchemaVersion: 1,
      beforeSnapshot: occurrenceSnapshot(occurrence),
      afterSnapshot: occurrenceSnapshot(cancelled),
    });
    const terms = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, request.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, request.leagueId),
      eq(leagueOccurrenceBillingTerms.occurrenceId, occurrence.id),
      ne(leagueOccurrenceBillingTerms.state, "superseded"),
      isNull(leagueOccurrenceBillingTerms.supersededAt),
    )).for("update");
    for (const term of terms) {
      const nextTermRevision = term.currentRevision + 1;
      const [revised] = await tx.update(leagueOccurrenceBillingTerms).set({
        obligationPolicy: "none",
        defaultAmountMinor: 0,
        billingOrdinal: null,
        currentRevision: nextTermRevision,
        lastCommandId: command.id,
      }).where(and(
        eq(leagueOccurrenceBillingTerms.id, term.id),
        eq(leagueOccurrenceBillingTerms.organizationId, request.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, request.leagueId),
      )).returning();
      if (!revised) throw new CanonicalOccurrenceTransactionError("invalid_command", "cancellation billing update failed");
      await tx.insert(leagueOccurrenceBillingTermRevisions).values({
        organizationId: request.organizationId,
        leagueId: request.leagueId,
        billingTermId: term.id,
        commandId: command.id,
        revisionNumber: nextTermRevision,
        snapshotSchemaVersion: 1,
        beforeSnapshot: billingTermSnapshot(term),
        afterSnapshot: billingTermSnapshot(revised),
      });
    }

    // PR1 owns cancellation evidence.  The retired activation/F1 and D2
    // tables are intentionally absent after migration 0032, so cancellation
    // must resolve only the new obligation/allocation ledger and the retained
    // operation/group ledgers.  Open, unallocated obligations can be voided;
    // any paid or dispatched evidence is retained and marked for review.
    // Interactive roster reservations have no triggerOccurrenceId. Resolve and
    // lock them through their immutable snapshot items before locking
    // obligations so cancellation and provider finalization share the
    // league -> operation -> obligation lock order.
    const rosterReservationOperations = await tx.select({
      id: paymentOperations.id,
      status: paymentOperations.status,
      dispatchClaimedAt: paymentOperations.dispatchClaimedAt,
    }).from(paymentOperationRosterSnapshotItems)
      .innerJoin(paymentObligations, and(
        eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId),
        eq(paymentObligations.organizationId, request.organizationId),
        eq(paymentObligations.leagueId, request.leagueId),
        eq(paymentObligations.occurrenceId, occurrence.id),
      ))
      .innerJoin(paymentOperations, and(
        eq(paymentOperations.id, paymentOperationRosterSnapshotItems.operationId),
        eq(paymentOperations.organizationId, request.organizationId),
        eq(paymentOperations.leagueId, request.leagueId),
      ))
      .where(and(
        eq(paymentOperationRosterSnapshotItems.organizationId, request.organizationId),
        eq(paymentOperationRosterSnapshotItems.leagueId, request.leagueId),
        inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const),
      )).orderBy(asc(paymentOperations.id)).for("update");
    const lockedRosterOperationIds = [...new Set(rosterReservationOperations.map((operation) => operation.id))];
    for (const operation of rosterReservationOperations.filter((candidate, index, all) => all.findIndex((row) => row.id === candidate.id) === index)) {
      if (["pending", "retry_scheduled", "leased"].includes(operation.status) && operation.dispatchClaimedAt === null) {
        await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, completedAt: request.now, updatedAt: request.now }).where(and(
          eq(paymentOperations.organizationId, request.organizationId),
          eq(paymentOperations.id, operation.id),
          isNull(paymentOperations.dispatchClaimedAt),
        ));
        await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(
          eq(paymentOperationRosterSnapshotItems.organizationId, request.organizationId),
          eq(paymentOperationRosterSnapshotItems.leagueId, request.leagueId),
          eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
          eq(paymentOperationRosterSnapshotItems.state, "reserved"),
        ));
      } else {
        await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "provider_unknown", errorCode: "CANCELLATION_REVIEW", updatedAt: request.now }).where(and(
          eq(paymentOperations.organizationId, request.organizationId),
          eq(paymentOperations.id, operation.id),
          eq(paymentOperations.status, operation.status),
        ));
      }
    }
    const rosterObligations = await tx.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, request.organizationId),
      eq(paymentObligations.leagueId, request.leagueId),
      eq(paymentObligations.occurrenceId, occurrence.id),
    )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.id)).for("update");
    const rosterObligationIds = rosterObligations.map((obligation) => obligation.id);
    const rosterAllocations = rosterObligationIds.length === 0 ? [] : await tx.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, request.organizationId),
      eq(paymentAllocations.leagueId, request.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, rosterObligationIds),
    )).orderBy(asc(paymentAllocations.obligationId), asc(paymentAllocations.id)).for("update");
    const allocationsByObligation = new Map<string, typeof rosterAllocations>();
    for (const allocation of rosterAllocations) allocationsByObligation.set(allocation.obligationId, [...(allocationsByObligation.get(allocation.obligationId) ?? []), allocation]);
    for (const obligation of rosterObligations) {
      const allocations = allocationsByObligation.get(obligation.id) ?? [];
      if (obligation.state === "open" && allocations.length === 0) {
        await tx.update(paymentObligations).set({ state: "voided", voidedAt: request.now }).where(and(
          eq(paymentObligations.id, obligation.id),
          eq(paymentObligations.organizationId, request.organizationId),
          eq(paymentObligations.leagueId, request.leagueId),
          eq(paymentObligations.state, "open"),
        ));
      } else if (allocations.length > 0 || obligation.state === "partially_settled" || obligation.state === "settled") {
        if (allocations.length === 0) throw new CanonicalOccurrenceTransactionError("invalid_command", "cancelled occurrence has settled obligation without allocation evidence");
        await tx.update(paymentAllocations).set({ reviewRequired: true, reviewReason: "OCCURRENCE_CANCELLATION_REVIEW" }).where(and(
          eq(paymentAllocations.organizationId, request.organizationId),
          eq(paymentAllocations.leagueId, request.leagueId),
          eq(paymentAllocations.obligationId, obligation.id),
          eq(paymentAllocations.state, "active"),
        ));
      }
    }
    // Open roster responsibilities are retired together with their voided
    // obligations. A later safe restore creates a new append-only version;
    // settled responsibilities remain active evidence and are never erased.
    const rosterResponsibilities = await tx.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, request.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, request.leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).for("update");
    for (const responsibility of rosterResponsibilities) {
      const evidence = rosterObligations.filter((obligation) => obligation.responsibilityId === responsibility.id);
      if (evidence.length > 0 && evidence.every((obligation) => {
        // `rosterObligations` was locked before the state transition above;
        // an open row with no active allocation is the same row this
        // cancellation just voided. Do not let the pre-update snapshot keep
        // its responsibility active and block a later safe restore.
        return obligation.state === "voided"
          || (obligation.state === "open" && (allocationsByObligation.get(obligation.id)?.length ?? 0) === 0);
      })) {
        await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
          eq(occurrencePaymentResponsibilities.id, responsibility.id),
          eq(occurrencePaymentResponsibilities.organizationId, request.organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, request.leagueId),
          eq(occurrencePaymentResponsibilities.state, "active"),
        ));
      }
    }

    const affectedGroups = await tx.select({ group: canonicalCollectionGroups })
      .from(canonicalCollectionGroups)
      .innerJoin(canonicalCollectionGroupMembers, and(
        eq(canonicalCollectionGroupMembers.groupId, canonicalCollectionGroups.id),
        eq(canonicalCollectionGroupMembers.organizationId, request.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, request.leagueId),
        eq(canonicalCollectionGroupMembers.occurrenceId, occurrence.id),
        eq(canonicalCollectionGroupMembers.active, true),
      ))
      .where(and(
        eq(canonicalCollectionGroups.organizationId, request.organizationId),
        eq(canonicalCollectionGroups.leagueId, request.leagueId),
        eq(canonicalCollectionGroups.state, "published"),
      )).for("update");
    const affectedGroupIds = affectedGroups.map(({ group }) => group.id);
    const groupTriggerOccurrenceIds = affectedGroupIds.length === 0 ? [] : (await tx.select({ occurrenceId: canonicalCollectionGroupMembers.occurrenceId })
      .from(canonicalCollectionGroupMembers)
      .where(and(
        eq(canonicalCollectionGroupMembers.organizationId, request.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, request.leagueId),
        inArray(canonicalCollectionGroupMembers.groupId, affectedGroupIds),
        eq(canonicalCollectionGroupMembers.active, true),
      ))).map(({ occurrenceId }) => occurrenceId);
    const operationRows = await tx.select({
      id: paymentOperations.id,
      status: paymentOperations.status,
      dispatchClaimedAt: paymentOperations.dispatchClaimedAt,
    }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, request.organizationId),
      eq(paymentOperations.leagueId, request.leagueId),
      inArray(paymentOperations.triggerOccurrenceId, [...new Set([occurrence.id, ...groupTriggerOccurrenceIds])]),
    )).orderBy(asc(paymentOperations.id)).for("update");
    const allOperationRows = [...operationRows, ...rosterReservationOperations.filter((candidate) => !lockedRosterOperationIds.includes(candidate.id))];
    for (const operation of allOperationRows) {
      if (["pending", "retry_scheduled", "leased"].includes(operation.status) && operation.dispatchClaimedAt === null) {
        await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, completedAt: request.now, updatedAt: request.now }).where(and(
          eq(paymentOperations.organizationId, request.organizationId),
          eq(paymentOperations.id, operation.id),
          isNull(paymentOperations.dispatchClaimedAt),
        ));
      } else if (operation.status === "provider_unknown" || operation.status === "succeeded") {
        await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "provider_unknown", errorCode: "CANCELLATION_REVIEW", updatedAt: request.now }).where(and(
          eq(paymentOperations.organizationId, request.organizationId),
          eq(paymentOperations.id, operation.id),
          eq(paymentOperations.status, operation.status),
        ));
      }
    }
    for (const { group } of affectedGroups) {
      const revokeRequest: MaterializationScheduleCommandRequest = {
        organizationId: request.organizationId,
        leagueId: request.leagueId,
        actorUserId: request.actorUserId,
        commandType: "revoke_collection_group",
        idempotencyKey: `${request.idempotencyKey}:collection-group-revoke:${group.id}`,
        requestFingerprint: "",
        reason: request.reason,
        materializationOperation: "canonical_collection_grouping",
        materializationPayload: { contractVersion: "canonical-collection-group/1", action: "revoke", groupId: group.id, occurrenceId: occurrence.id, reviewRequired: rosterAllocations.length > 0 || operationRows.some((operation) => operation.status === "succeeded" || operation.status === "provider_unknown") },
      };
      revokeRequest.requestFingerprint = buildCanonicalScheduleCommandFingerprint(revokeRequest);
      const { command: revokeCommand } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, revokeRequest, ["revoke_collection_group"]);
      const [revoked] = await tx.update(canonicalCollectionGroups).set({ state: "revoked", currentRevision: group.currentRevision + 1, lastCommandId: revokeCommand.id, revokedAt: request.now, revokedByUserId: request.actorUserId, revocationCommandId: revokeCommand.id, updatedAt: request.now }).where(and(
        eq(canonicalCollectionGroups.id, group.id),
        eq(canonicalCollectionGroups.organizationId, request.organizationId),
        eq(canonicalCollectionGroups.leagueId, request.leagueId),
        eq(canonicalCollectionGroups.state, "published"),
        eq(canonicalCollectionGroups.currentRevision, group.currentRevision),
      )).returning();
      if (!revoked) throw new CanonicalOccurrenceTransactionError("invalid_command", "collection group revocation failed");
      const activeMembers = await tx.select().from(canonicalCollectionGroupMembers).where(and(
        eq(canonicalCollectionGroupMembers.groupId, group.id),
        eq(canonicalCollectionGroupMembers.organizationId, request.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, request.leagueId),
        eq(canonicalCollectionGroupMembers.active, true),
      )).for("update");
      const revokedMembers = await tx.update(canonicalCollectionGroupMembers).set({ active: false, currentRevision: sql`${canonicalCollectionGroupMembers.currentRevision} + 1`, lastCommandId: revokeCommand.id, updatedAt: request.now }).where(and(
        eq(canonicalCollectionGroupMembers.groupId, group.id),
        eq(canonicalCollectionGroupMembers.organizationId, request.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, request.leagueId),
        eq(canonicalCollectionGroupMembers.active, true),
      )).returning();
      for (const member of revokedMembers) {
        await tx.insert(canonicalCollectionGroupMemberRevisions).values({ organizationId: request.organizationId, leagueId: request.leagueId, memberId: member.id, commandId: revokeCommand.id, revisionNumber: member.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: activeMembers.find((candidate) => candidate.id === member.id) ?? null, afterSnapshot: member });
      }
      await tx.insert(canonicalCollectionGroupRevisions).values({ organizationId: request.organizationId, leagueId: request.leagueId, groupId: group.id, commandId: revokeCommand.id, revisionNumber: revoked.currentRevision, snapshotSchemaVersion: CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION, beforeSnapshot: group, afterSnapshot: { ...revoked, cancellationReviewRequired: rosterAllocations.length > 0 } });
    }
    return cancelled;

  // eslint-disable-next-line no-unreachable
  return cancelled;
}

export async function cancelOccurrence(request: OccurrenceCancellationRequest): Promise<LeagueOccurrence> {
  return withDefaultCanonicalTransaction((tx) => cancelOccurrenceInTransaction(tx, request));
}

/** Restore one future cancellation only when no effective financial/game
 * evidence exists. The original occurrence and term UUIDs remain intact and
 * every restoration is represented by a schedule-edit command/revision. */
export async function restoreCancelledOccurrenceInTransaction(tx: LeagueScheduleTransaction, input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  occurrenceId: string;
  idempotencyKey: string;
  reason: string;
  now: string;
}): Promise<LeagueOccurrence> {
  assertValidReason(input.reason);
  assertValidInstant(input.now, "now");
  await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
  const request: MaterializationScheduleCommandRequest = {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: "restore_cancelled_draft",
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: "",
    reason: input.reason,
    materializationOperation: "canonical_schedule_edit",
    materializationPayload: { contractVersion: "canonical-schedule-edit/1", action: "restore_cancelled_occurrence", occurrenceId: input.occurrenceId },
  };
  request.requestFingerprint = buildCanonicalScheduleCommandFingerprint(request);
  const { command, existing } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, ["restore_cancelled_draft"]);
  const [occurrence] = await tx.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.id, input.occurrenceId),
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
  )).for("update");
  if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
  if (existing && occurrence.lastCommandId === command.id) return occurrence;
  if (occurrence.status !== "cancelled" || occurrence.lifecycle === "draft") throw new CanonicalOccurrenceTransactionError("occurrence_terminal", "only a published cancelled occurrence can be restored");
  if (Date.parse(occurrence.startAt) <= Date.parse(input.now)) throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "only a future occurrence can be restored");
  const evidenceChecks = await Promise.all([
    tx.select({ id: games.id }).from(games).where(and(eq(games.occurrenceId, occurrence.id), eq(games.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentObligations.id }).from(paymentObligations).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), eq(paymentObligations.occurrenceId, occurrence.id), inArray(paymentObligations.state, ["partially_settled", "settled"] as const))).limit(1),
    tx.select({ id: paymentAllocations.id }).from(paymentAllocations).innerJoin(paymentObligations, and(eq(paymentAllocations.obligationId, paymentObligations.id), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId))).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.state, "active"), eq(paymentObligations.occurrenceId, occurrence.id))).limit(1),
    tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.triggerOccurrenceId, occurrence.id),
      or(
        inArray(paymentOperations.status, ["leased", "provider_unknown", "succeeded", "reconciliation_required"] as const),
        and(inArray(paymentOperations.status, ["pending", "retry_scheduled"] as const), sql`${paymentOperations.dispatchClaimedAt} IS NOT NULL`),
      ),
    )).limit(1),
    tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, and(eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), eq(paymentObligations.occurrenceId, occurrence.id))).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const))).limit(1),
    tx.select({ id: canonicalCollectionGroupMembers.id }).from(canonicalCollectionGroupMembers).where(and(eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.occurrenceId, occurrence.id), eq(canonicalCollectionGroupMembers.active, true))).limit(1),
  ]);
  if (evidenceChecks.some((rows) => rows.length > 0)) throw new CanonicalOccurrenceTransactionError("occurrence_effectively_locked", "cancelled occurrence has effective game, financial, collection, dispatch, or grouping evidence");
  const [term] = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
    eq(leagueOccurrenceBillingTerms.occurrenceId, occurrence.id),
    ne(leagueOccurrenceBillingTerms.state, "superseded"),
  )).for("update");
  if (!term) throw new CanonicalOccurrenceTransactionError("invalid_command", "cancelled occurrence billing term is missing");
  const [priorRevision] = await tx.select().from(leagueOccurrenceBillingTermRevisions).where(and(
    eq(leagueOccurrenceBillingTermRevisions.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTermRevisions.leagueId, input.leagueId),
    eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id),
  )).orderBy(desc(leagueOccurrenceBillingTermRevisions.revisionNumber)).limit(1);
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  // Cancellation writes the preserved published term to `beforeSnapshot` and
  // the zero-obligation term to `afterSnapshot`. A direct publication may not
  // have an earlier revision row, so restoration must use the latest
  // cancellation evidence rather than assuming revision N-1 exists.
  const latestAfter = isRecord(priorRevision?.afterSnapshot) ? priorRevision.afterSnapshot : null;
  const priorSnapshot = [latestAfter, priorRevision?.beforeSnapshot].find((candidate) => {
    if (!isRecord(candidate) || candidate.obligationPolicy === "none") return false;
    return typeof candidate.defaultAmountMinor === "number"
      && candidate.defaultAmountMinor > 0
      && typeof candidate.billingOrdinal === "number"
      && candidate.billingOrdinal > 0;
  });
  const restoredAmount = isRecord(priorSnapshot) && typeof priorSnapshot.defaultAmountMinor === "number" ? priorSnapshot.defaultAmountMinor : null;
  const restoredOrdinal = isRecord(priorSnapshot) && typeof priorSnapshot.billingOrdinal === "number" ? priorSnapshot.billingOrdinal : null;
  if (!restoredAmount || !restoredOrdinal || restoredAmount <= 0 || restoredOrdinal <= 0) throw new CanonicalOccurrenceTransactionError("invalid_command", "cancelled occurrence has no restorable published billing-term evidence");
  const nextRevision = occurrence.currentRevision + 1;
  const [restored] = await tx.update(leagueOccurrences).set({ status: "scheduled", competitive: true, countsInStandings: true, competitionNumber: occurrence.plannedOrdinal, currentRevision: nextRevision, lastCommandId: command.id, cancelledAt: null, cancelledByUserId: null, cancellationCommandId: null }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
  if (!restored) throw new CanonicalOccurrenceTransactionError("invalid_command", "occurrence restoration failed");
  await tx.insert(leagueOccurrenceRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: occurrence.id, commandId: command.id, revisionNumber: nextRevision, snapshotSchemaVersion: 1, beforeSnapshot: occurrenceSnapshot(occurrence), afterSnapshot: occurrenceSnapshot(restored) });
  const nextTermRevision = term.currentRevision + 1;
  const [restoredTerm] = await tx.update(leagueOccurrenceBillingTerms).set({ obligationPolicy: "eligible_bowlers", defaultAmountMinor: restoredAmount, billingOrdinal: restoredOrdinal, currentRevision: nextTermRevision, lastCommandId: command.id }).where(and(eq(leagueOccurrenceBillingTerms.id, term.id), eq(leagueOccurrenceBillingTerms.currentRevision, term.currentRevision))).returning();
  if (!restoredTerm) throw new CanonicalOccurrenceTransactionError("invalid_command", "billing-term restoration failed");
  await tx.insert(leagueOccurrenceBillingTermRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, billingTermId: term.id, commandId: command.id, revisionNumber: nextTermRevision, snapshotSchemaVersion: 1, beforeSnapshot: billingTermSnapshot(term), afterSnapshot: billingTermSnapshot(restoredTerm) });
  await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: restored.id, actorUserId: input.actorUserId });
  return restored;
}

/** Public transaction wrapper for callers that restore one occurrence without
 * a broader canonical schedule-edit batch. The schedule-edit service uses the
 * in-transaction variant so its league lock remains shared with the batch. */
export async function restoreCancelledOccurrence(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  occurrenceId: string;
  idempotencyKey: string;
  reason: string;
  now: string;
}): Promise<LeagueOccurrence> {
  return withDefaultCanonicalTransaction((tx) => restoreCancelledOccurrenceInTransaction(tx, input));
}

/** Reschedule an occurrence in place; UUID and generationKey are deliberately untouched. */
export async function rescheduleOccurrence(request: OccurrenceRescheduleRequest): Promise<LeagueOccurrence> {
  const canonicalRequest = resolveRescheduleRequest(request);
  assertValidReason(request.reason);
  assertValidInstant(request.now, "now");
  return withDefaultCanonicalTransaction(async (tx) => {
    await lockLeagueSchedule(tx, canonicalRequest.organizationId, canonicalRequest.leagueId);
    const { command, existing } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, canonicalRequest, ["reschedule"]);
    const [occurrence] = await tx.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, canonicalRequest.occurrenceId),
      eq(leagueOccurrences.organizationId, canonicalRequest.organizationId),
      eq(leagueOccurrences.leagueId, canonicalRequest.leagueId),
    )).for("update");
    if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
    if (existing && occurrence.lastCommandId === command.id) return occurrence;
    if (occurrence.status === "discarded" || occurrence.status === "cancelled") throw new CanonicalOccurrenceTransactionError("occurrence_terminal", "discarded or cancelled occurrences cannot be rescheduled");
    if (occurrence.lifecycle === "published") {
      await assertRescheduleFinanciallyEditableInTransaction(tx, occurrence, canonicalRequest.now);
    } else {
      // Draft schedule editing remains governed by the established physical
      // schedule lock checks. The roster-specific versioning guard applies
      // only after canonical publication has made payer evidence billable.
      await assertNotEffectivelyLocked(tx, occurrence, canonicalRequest.now);
    }
    await validateCanonicalOccurrencePlacementInTransaction(tx, {
      ...canonicalRequest,
      existingOccurrenceId: occurrence.id,
    });
    const nextRevision = occurrence.currentRevision + 1;
    const [rescheduled] = await tx.update(leagueOccurrences).set({
      authoritativeLocalDate: canonicalRequest.authoritativeLocalDate,
      authoritativeLocalStartTime: canonicalRequest.authoritativeLocalStartTime,
      timezone: canonicalRequest.timezone,
      startAt: canonicalRequest.startAt,
      selectedUtcOffsetMinutes: canonicalRequest.selectedUtcOffsetMinutes,
      foldResolution: canonicalRequest.foldResolution,
      resolverVersion: canonicalRequest.resolverVersion,
      currentRevision: nextRevision,
      lastCommandId: command.id,
    }).where(and(
      eq(leagueOccurrences.id, occurrence.id),
      eq(leagueOccurrences.organizationId, canonicalRequest.organizationId),
      eq(leagueOccurrences.leagueId, canonicalRequest.leagueId),
    )).returning();
    if (!rescheduled) throw new CanonicalOccurrenceTransactionError("invalid_command", "reschedule did not update its occurrence");
    await tx.insert(leagueOccurrenceRevisions).values({
      organizationId: canonicalRequest.organizationId,
      leagueId: canonicalRequest.leagueId,
      occurrenceId: occurrence.id,
      commandId: command.id,
      revisionNumber: nextRevision,
      snapshotSchemaVersion: 1,
      beforeSnapshot: occurrenceSnapshot(occurrence),
      afterSnapshot: occurrenceSnapshot(rescheduled),
    });
    await materializeRosterPaymentOccurrenceInTransaction(tx, {
      organizationId: canonicalRequest.organizationId,
      leagueId: canonicalRequest.leagueId,
      occurrenceId: rescheduled.id,
      actorUserId: canonicalRequest.actorUserId,
      reschedule: true,
    });
    return rescheduled;
  });
}
