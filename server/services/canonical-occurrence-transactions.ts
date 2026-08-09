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
  | "invalid_command";

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
  authoritativeLocalDate: string;
  startAt: string;
  existingOccurrenceId?: string;
}

export interface MakeupRelationshipRequest extends ScheduleCommandRequest {
  sourceOccurrenceId: string;
  targetOccurrenceId: string;
}

export interface GenerationRevisionRequest extends ScheduleCommandRequest {
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
  startAt: string;
  selectedUtcOffsetMinutes: number;
  foldResolution: "unambiguous" | "earlier" | "later";
  resolverVersion: string;
}

function assertPositiveScope(organizationId: number, leagueId: number): void {
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0 || !Number.isSafeInteger(leagueId) || leagueId <= 0) {
    throw new CanonicalOccurrenceTransactionError("invalid_scope", "organizationId and leagueId must be positive safe integers");
  }
}

function assertValidFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CanonicalOccurrenceTransactionError("invalid_idempotency", "requestFingerprint must be lowercase hexadecimal SHA-256");
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
  if (!actor || (actor.role !== "system_admin" && actor.organizationId !== request.organizationId)) {
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
): Promise<{ command: LeagueScheduleCommand; existing: boolean }> {
  assertValidIdempotencyKey(request.idempotencyKey);
  assertValidFingerprint(request.requestFingerprint);
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
      eq(leagueOccurrences.authoritativeLocalDate, request.authoritativeLocalDate),
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
  if (collisions.length > 0 && !request.sameDayOverride) {
    throw new CanonicalOccurrenceTransactionError("same_day_collision", "same-day occurrence requires an explicit audited override");
  }
  return collisions;
}

/** Validate an occurrence placement and record the audited command, without materializing a B2 occurrence. */
export async function validateOccurrencePlacement(request: OccurrencePlacementRequest): Promise<LeagueScheduleCommand> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command } = await getOrCreateCommand(tx, request);
    await validatePlacementInTransaction(tx, request);
    return command;
  });
}

/** Validate an exception date against the tenant's active occurrence domain. */
export async function validateExceptionPlacement(
  request: OccurrencePlacementRequest,
): Promise<LeagueScheduleCommand> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command } = await getOrCreateCommand(tx, request);
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
    return command;
  });
}

/** Validate a makeup relationship; B2 owns any later row materialization. */
export async function validateMakeupRelationship(request: MakeupRelationshipRequest): Promise<LeagueScheduleCommand> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command } = await getOrCreateCommand(tx, request);
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
    return command;
  });
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
    const { command, existing } = await getOrCreateCommand(tx, request);
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
    assertValidFingerprint(request.inputFingerprint);
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
    const { command, existing } = await getOrCreateCommand(tx, request);
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
    const { command, existing } = await getOrCreateCommand(tx, request);
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
  assertValidReason(request.reason);
  assertValidInstant(request.now, "now");
  assertValidInstant(request.startAt, "startAt");
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
    const { command, existing } = await getOrCreateCommand(tx, request);
    const [occurrence] = await tx.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, request.occurrenceId),
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
    )).for("update");
    if (!occurrence) throw new CanonicalOccurrenceTransactionError("occurrence_not_found", "occurrence is missing or outside the requested tenant");
    if (existing && occurrence.lastCommandId === command.id) return occurrence;
    if (occurrence.status === "discarded" || occurrence.status === "cancelled") throw new CanonicalOccurrenceTransactionError("occurrence_terminal", "discarded or cancelled occurrences cannot be rescheduled");
    assertNotEffectivelyLocked(occurrence, request.now);
    await validatePlacementInTransaction(tx, request);
    const nextRevision = occurrence.currentRevision + 1;
    const [rescheduled] = await tx.update(leagueOccurrences).set({
      authoritativeLocalDate: request.authoritativeLocalDate,
      authoritativeLocalStartTime: request.authoritativeLocalStartTime,
      timezone: request.timezone,
      startAt: request.startAt,
      selectedUtcOffsetMinutes: request.selectedUtcOffsetMinutes,
      foldResolution: request.foldResolution,
      resolverVersion: request.resolverVersion,
      currentRevision: nextRevision,
      lastCommandId: command.id,
    }).where(and(
      eq(leagueOccurrences.id, occurrence.id),
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
    )).returning();
    if (!rescheduled) throw new CanonicalOccurrenceTransactionError("invalid_command", "reschedule did not update its occurrence");
    await tx.insert(leagueOccurrenceRevisions).values({
      organizationId: request.organizationId,
      leagueId: request.leagueId,
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
