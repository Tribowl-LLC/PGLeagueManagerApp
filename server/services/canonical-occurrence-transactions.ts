import { createHash } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptions,
  leagues,
  users,
  type LeagueOccurrence,
  type LeagueOccurrenceBillingTerm,
  type LeagueScheduleCommand,
} from "@shared/schema";
import { db } from "../db.js";
import { lockLeagueSchedule, type LeagueScheduleLockExecutor } from "../storage/league-schedule-lock.js";
import {
  canonicalizeTimezone,
  resolveCanonicalLocalDateTime,
  type AmbiguousFoldPolicy,
  type DstFoldResolution,
} from "@shared/canonical-dst-resolver";

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
  commandType: "generate" | "publish" | "reschedule";
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
  try {
    return canonicalizeTimezone(value);
  } catch {
    return value.trim();
  }
}

function commandFingerprintPayload(request: ScheduleCommandRequest): Record<string, unknown> {
  const common = {
    organizationId: request.organizationId,
    leagueId: request.leagueId,
    actorUserId: request.actorUserId,
    commandType: request.commandType,
    sameDayOverride: request.sameDayOverride ?? false,
    reason: request.reason ?? null,
  };
  switch (request.commandType) {
    case "generate":
      if ("generatorVersion" in request) {
        const generation = request as GenerationRevisionRequest;
        return {
          ...common,
          operation: "generation_revision",
          generatorVersion: generation.generatorVersion,
          inputFingerprint: generation.inputFingerprint,
          normalizedInputSnapshot: generation.normalizedInputSnapshot,
          rangeStartDate: generation.rangeStartDate,
          rangeEndDate: generation.rangeEndDate,
          candidateOccurrenceCount: generation.candidateOccurrenceCount,
          generatedOccurrenceCount: generation.generatedOccurrenceCount,
          skippedDateCount: generation.skippedDateCount,
          discrepancyCount: generation.discrepancyCount,
        };
      }
      return {
        ...common,
        operation: "occurrence_placement",
        authoritativeLocalDate: (request as OccurrencePlacementRequest).authoritativeLocalDate,
        startAt: (request as OccurrencePlacementRequest).startAt,
        existingOccurrenceId: (request as OccurrencePlacementRequest).existingOccurrenceId ?? null,
      };
    case "publish":
      return {
        ...common,
        operation: "occurrence_placement",
        authoritativeLocalDate: (request as OccurrencePlacementRequest).authoritativeLocalDate,
        startAt: (request as OccurrencePlacementRequest).startAt,
        existingOccurrenceId: (request as OccurrencePlacementRequest).existingOccurrenceId ?? null,
      };
    case "create_exception":
      return {
        ...common,
        operation: "exception_placement",
        authoritativeLocalDate: (request as ExceptionPlacementRequest).authoritativeLocalDate,
        startAt: (request as ExceptionPlacementRequest).startAt,
      };
    case "create_makeup_relationship":
      return {
        ...common,
        operation: "makeup_relationship",
        sourceOccurrenceId: (request as MakeupRelationshipRequest).sourceOccurrenceId,
        targetOccurrenceId: (request as MakeupRelationshipRequest).targetOccurrenceId,
      };
    case "discard_draft":
      return {
        ...common,
        operation: "discard_draft",
        occurrenceId: (request as DraftDiscardRequest).occurrenceId,
        now: (request as DraftDiscardRequest).now,
        activityEvidence: [...((request as DraftDiscardRequest).activityEvidence ?? [])],
      };
    case "cancel":
      return {
        ...common,
        operation: "cancel",
        occurrenceId: (request as OccurrenceCancellationRequest).occurrenceId,
        now: (request as OccurrenceCancellationRequest).now,
        activityEvidence: [...((request as OccurrenceCancellationRequest).activityEvidence ?? [])],
      };
    case "reschedule": {
      const reschedule = request as OccurrenceRescheduleRequest;
      return {
        ...common,
        operation: "reschedule",
        occurrenceId: reschedule.occurrenceId,
        now: reschedule.now,
        authoritativeLocalDate: reschedule.authoritativeLocalDate,
        authoritativeLocalStartTime: normalizeCommandTime(reschedule.authoritativeLocalStartTime),
        timezone: canonicalCommandTimezone(reschedule.timezone),
        ambiguousFold: reschedule.ambiguousFold,
      };
    }
    default:
      return { ...common, operation: "schedule_command" };
  }
}

/** Build the exact versioned fingerprint that the transaction service accepts. */
export function buildCanonicalScheduleCommandFingerprint(request: ScheduleCommandRequest): string {
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

async function assertTenantAndActor(
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
async function getOrCreateCommand(
  tx: LeagueScheduleLockExecutor,
  request: ScheduleCommandRequest,
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
  await assertTenantAndActor(tx, request);
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

async function validatePlacementInTransaction(
  tx: LeagueScheduleLockExecutor,
  request: OccurrencePlacementRequest,
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
  const collisions = rows.filter((row) => row.id !== request.existingOccurrenceId);
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
  request: ScheduleCommandRequest,
  allowedCommandTypes: readonly LeagueScheduleCommand["commandType"][],
  mutation: (context: LockedScheduleMutationContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const command = await getOrCreateCommand(tx, request, allowedCommandTypes);
    return mutation({ tx, ...command });
  });
}

export interface LockedOccurrencePlacementContext extends LockedScheduleMutationContext {
  collisions: LeagueOccurrence[];
}

/**
 * Keep the league lock through validation and the caller's eventual mutation.
 * The callback is the B2 boundary; it must use the supplied transaction and
 * treat `existing` as an idempotent retry of its own atomic mutation.
 */
export async function withLockedOccurrencePlacementMutation<T>(
  request: OccurrencePlacementRequest,
  mutation: (context: LockedOccurrencePlacementContext) => Promise<T>,
): Promise<T> {
  return withLockedScheduleCommand(request, ["generate", "publish", "reschedule"], async (context) => {
    const collisions = context.existing ? [] : await validatePlacementInTransaction(context.tx, request);
    return mutation({ ...context, collisions });
  });
}

/** Preflight only: the lock ends when this function returns; no later independent write is protected. */
export async function validateOccurrencePlacement(request: OccurrencePlacementRequest): Promise<LeagueScheduleCommand> {
  return withLockedOccurrencePlacementMutation(request, async ({ command }) => command);
}

async function validateExceptionPlacementInTransaction(
  tx: LeagueScheduleLockExecutor,
  request: ExceptionPlacementRequest,
): Promise<void> {
  const [activeException] = await tx
    .select({ id: leagueScheduleExceptions.id })
    .from(leagueScheduleExceptions)
    .where(and(
      eq(leagueScheduleExceptions.organizationId, request.organizationId),
      eq(leagueScheduleExceptions.leagueId, request.leagueId),
      eq(leagueScheduleExceptions.localDate, request.authoritativeLocalDate),
      ne(leagueScheduleExceptions.lifecycle, "revoked"),
    ))
    .for("update");
  if (activeException) throw new CanonicalOccurrenceTransactionError("exception_collision", "an active exception already exists for this tenant and local date");
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
    if (!context.existing) await validateExceptionPlacementInTransaction(context.tx, request);
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
    const [existingSource] = await tx
      .select({ id: leagueOccurrenceRelationships.id })
      .from(leagueOccurrenceRelationships)
      .where(and(
        eq(leagueOccurrenceRelationships.organizationId, request.organizationId),
        eq(leagueOccurrenceRelationships.leagueId, request.leagueId),
        eq(leagueOccurrenceRelationships.sourceOccurrenceId, source.id),
        ne(leagueOccurrenceRelationships.state, "revoked"),
      ))
      .for("update");
    if (existingSource) throw new CanonicalOccurrenceTransactionError("invalid_command", "source occurrence already has an active makeup relationship");
}

export async function withLockedMakeupRelationshipMutation<T>(
  request: MakeupRelationshipRequest,
  mutation: (context: LockedScheduleMutationContext) => Promise<T>,
): Promise<T> {
  return withLockedScheduleCommand(request, ["create_makeup_relationship"], async (context) => {
    if (!context.existing) await validateMakeupRelationshipInTransaction(context.tx, request);
    return mutation(context);
  });
}

/** Preflight only: the lock ends when this function returns; no later independent write is protected. */
export async function validateMakeupRelationship(request: MakeupRelationshipRequest): Promise<LeagueScheduleCommand> {
  return withLockedMakeupRelationshipMutation(request, async ({ command }) => command);
}

async function allocateSourceScheduleRevisionInTransaction(
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
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCommand(tx, request, ["generate"]);
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
    const sourceScheduleRevision = await allocateSourceScheduleRevisionInTransaction(tx, request.organizationId, request.leagueId);
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
    currency: row.currency,
    billingOrdinal: row.billingOrdinal,
    version: row.version,
    state: row.state,
    currentRevision: row.currentRevision,
    lastCommandId: row.lastCommandId,
  };
}

function assertNotEffectivelyLocked(row: LeagueOccurrence, now: string): void {
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
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCommand(tx, request, ["discard_draft"]);
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
    assertNotEffectivelyLocked(occurrence, request.now);
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
export async function cancelOccurrence(request: OccurrenceCancellationRequest): Promise<LeagueOccurrence> {
  assertValidReason(request.reason);
  assertValidInstant(request.now, "now");
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCommand(tx, request, ["cancel"]);
    const [occurrence] = await tx.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, request.occurrenceId),
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
    )).for("update");
    if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
    if (existing && occurrence.cancellationCommandId === command.id) return occurrence;
    if (occurrence.lifecycle === "draft" || occurrence.status !== "scheduled") throw new CanonicalOccurrenceTransactionError("occurrence_terminal", "only a scheduled published or locked occurrence can be cancelled");
    if (request.activityEvidence && request.activityEvidence.length > 0) throw new CanonicalOccurrenceTransactionError("activity_evidence", "cancellation is refused when explicit activity evidence is present");
    assertNotEffectivelyLocked(occurrence, request.now);
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
    return cancelled;
  });
}

/** Reschedule an occurrence in place; UUID and generationKey are deliberately untouched. */
export async function rescheduleOccurrence(request: OccurrenceRescheduleRequest): Promise<LeagueOccurrence> {
  const canonicalRequest = resolveRescheduleRequest(request);
  assertValidReason(request.reason);
  assertValidInstant(request.now, "now");
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, canonicalRequest.organizationId, canonicalRequest.leagueId);
    const { command, existing } = await getOrCreateCommand(tx, canonicalRequest, ["reschedule"]);
    const [occurrence] = await tx.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, canonicalRequest.occurrenceId),
      eq(leagueOccurrences.organizationId, canonicalRequest.organizationId),
      eq(leagueOccurrences.leagueId, canonicalRequest.leagueId),
    )).for("update");
    if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
    if (existing && occurrence.lastCommandId === command.id) return occurrence;
    if (occurrence.status === "discarded" || occurrence.status === "cancelled") throw new CanonicalOccurrenceTransactionError("occurrence_terminal", "discarded or cancelled occurrences cannot be rescheduled");
    assertNotEffectivelyLocked(occurrence, canonicalRequest.now);
    await validatePlacementInTransaction(tx, {
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
    return rescheduled;
  });
}
