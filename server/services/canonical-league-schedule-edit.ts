import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  canonicalCollectionGroupMemberRevisions,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroups,
  paymentObligations,
  paymentAllocations,
  paymentOperations,
  paymentOperationRosterSnapshotItems,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueOccurrenceRevisions,
  leagueOccurrenceBillingTerms,
  leagueScheduleExceptions,
  leagueScheduleExceptionRevisions,
  leagues,
  games,
  payments,
  standingAutopayPreparationAttempts,
  occurrencePaymentResponsibilities,
  type League,
} from "@shared/schema";
import { CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION, CanonicalCollectionGroupingError, deriveCanonicalCollectionPairs } from "@shared/canonical-collection-groups";
import { generateCanonicalOccurrences, type CanonicalSkipExceptionInput } from "@shared/canonical-occurrence-generator";
import { resolveCanonicalDraftInputSnapshot } from "./fall-draft-generation.js";
import { exceptionSnapshot, occurrenceSnapshot } from "./fall-draft-review.js";
import { LeagueOccurrenceScheduleError, loadLeagueOccurrenceScheduleSnapshot } from "./league-occurrence-schedule.js";
import { materializeRosterPaymentOccurrencesInTransaction } from "./roster-payment-materializer.js";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";
import { canonicalCollectionGroupMembersMatchPair, persistCanonicalCollectionGroupsInTransaction, readCanonicalCollectionGroupsInTransaction, type PersistCanonicalCollectionGroupsResult } from "./canonical-collection-groups.js";
import { cancelOccurrenceInTransaction, restoreCancelledOccurrenceInTransaction } from "./canonical-occurrence-transactions.js";
import {
  assertCanonicalScheduleTenantAndActor,
  buildCanonicalScheduleCommandFingerprint,
  getOrCreateCanonicalScheduleCommandInTransaction,
  assertRescheduleFinanciallyEditableInTransaction,
  CanonicalOccurrenceTransactionError,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";
import { db } from "../db.js";

export class CanonicalLeagueScheduleEditError extends Error {
  constructor(public readonly code: "stale_revision" | "financial_conflict" | "invalid_edit" | "unsupported_edit", message: string) {
    super(message);
    this.name = "CanonicalLeagueScheduleEditError";
  }
}

/** Ordinary builder fields that may accompany a canonical schedule edit. */
export type CanonicalLeagueMetadataPatch = Partial<Pick<League,
  "name" | "description" | "payingLineupSize" | "active" | "allowPublicSignup" | "practiceStartTime"
  | "lineageFee" | "prizeFundFee" | "squareLineageItemId" | "lineageItemVariationId"
  | "squareLineageItemName" | "squarePrizeFundItemId" | "prizeFundItemVariationId"
  | "squarePrizeFundItemName" | "squareCategoryId"
>>;

export interface CanonicalLeagueScheduleEditInput {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  expectedScheduleRevision: number;
  idempotencyKey: string;
  reason: string;
  doublePayDates: string[];
  skipDates?: string[];
  cancelledDates?: string[];
  seasonStart?: string;
  seasonEnd?: string;
  weekDay?: League["weekDay"];
  competitionStartTime?: string | null;
  timezone?: string | null;
  totalBowlingWeeks?: number | null;
  metadata?: CanonicalLeagueMetadataPatch;
}

export interface CanonicalLeagueScheduleEditResult {
  mode: "applied" | "idempotent_retry";
  scheduleRevision: number;
  doublePayDates: string[];
  collectionGroups: PersistCanonicalCollectionGroupsResult["groups"];
  commandId: string;
  writesPerformed: boolean;
  league: League;
}

/** Read the optimistic revision exposed to the builder and ETag layer. */
export async function readCanonicalLeagueScheduleRevision(input: {
  organizationId: number;
  leagueId: number;
}): Promise<number | null> {
  const [run] = await db.select({ sourceScheduleRevision: leagueOccurrenceGenerationRuns.sourceScheduleRevision })
    .from(leagueOccurrenceGenerationRuns)
    .where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, input.organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, input.leagueId),
      inArray(leagueOccurrenceGenerationRuns.state, ["approved", "applied"]),
    ))
    .orderBy(desc(leagueOccurrenceGenerationRuns.sourceScheduleRevision), desc(leagueOccurrenceGenerationRuns.id))
    .limit(1);
  if (!run) return null;
  const [league] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision })
    .from(leagues)
    .where(and(eq(leagues.organizationId, input.organizationId), eq(leagues.id, input.leagueId)));
  return league && league.canonicalScheduleRevision > 0
    ? league.canonicalScheduleRevision
    : run.sourceScheduleRevision;
}

async function revokeGroupInTransaction(tx: LeagueScheduleTransaction, input: CanonicalLeagueScheduleEditInput, group: typeof canonicalCollectionGroups.$inferSelect, commandIdempotencyKey: string): Promise<void> {
  if (group.state !== "published") return;
  const members = await tx.select().from(canonicalCollectionGroupMembers).where(and(
    eq(canonicalCollectionGroupMembers.groupId, group.id),
    eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
    eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
    eq(canonicalCollectionGroupMembers.active, true),
  )).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal), asc(canonicalCollectionGroupMembers.id)).for("update");
  const occurrenceIds = members.map((member) => member.occurrenceId);
  if (occurrenceIds.length !== 2) throw new CanonicalLeagueScheduleEditError("financial_conflict", "collection group membership is incomplete");
  const obligations = await tx.select({ id: paymentObligations.id, state: paymentObligations.state, responsibilityState: occurrencePaymentResponsibilities.state }).from(paymentObligations)
    .innerJoin(occurrencePaymentResponsibilities, and(
      eq(occurrencePaymentResponsibilities.id, paymentObligations.responsibilityId),
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    )).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.occurrenceId, occurrenceIds),
  )).orderBy(asc(paymentObligations.id)).for("update");
  const allocations = obligations.length === 0 ? [] : await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).innerJoin(paymentObligations, and(
    eq(paymentAllocations.obligationId, paymentObligations.id),
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
  )).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    inArray(paymentObligations.occurrenceId, occurrenceIds),
  )).orderBy(asc(paymentAllocations.id)).for("update");
  // Standing operations have no triggerOccurrenceId, so collect their IDs
  // through the immutable snapshot before taking the final operation locks.
  // Keeping the final lock query on one base table also avoids PostgreSQL's
  // prohibition on FOR UPDATE over the nullable side of an outer join.
  const triggerOperationRows = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    inArray(paymentOperations.triggerOccurrenceId, occurrenceIds),
  )).orderBy(asc(paymentOperations.id));
  const rosterItemRows = await tx.select({ operationId: paymentOperationRosterSnapshotItems.operationId, state: paymentOperationRosterSnapshotItems.state }).from(paymentOperations)
    .innerJoin(paymentOperationRosterSnapshotItems, and(
      eq(paymentOperationRosterSnapshotItems.operationId, paymentOperations.id),
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    ))
    .innerJoin(paymentObligations, and(
      eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
    ))
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      inArray(paymentObligations.occurrenceId, occurrenceIds),
    )).orderBy(asc(paymentOperations.id));
  if (rosterItemRows.some((item) => item.state === "reserved" || item.state === "finalized")) {
    throw new CanonicalLeagueScheduleEditError("financial_conflict", "double-pay collection group has reserved or finalized payment-operation evidence and cannot be revised");
  }
  const rosterOperationRows = [...new Set(rosterItemRows.map((row) => row.operationId))].map((id) => ({ id }));
  const operationIds = [...new Set([...triggerOperationRows, ...rosterOperationRows].map((row) => row.id))].sort();
  const providerOperationRows = operationIds.length === 0 ? [] : await tx.select({
    id: paymentOperations.id,
    status: paymentOperations.status,
    dispatchClaimedAt: paymentOperations.dispatchClaimedAt,
    providerObjectId: paymentOperations.providerObjectId,
  }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    inArray(paymentOperations.id, operationIds),
  )).for("update");
  const blockingOperations = providerOperationRows.filter((operation) =>
    operation.dispatchClaimedAt !== null
      || operation.providerObjectId !== null
      || ["pending", "leased", "provider_unknown", "retry_scheduled", "succeeded", "action_required", "reconciliation_required"].includes(operation.status),
  );
  if (obligations.some((obligation) => obligation.responsibilityState === "active" && obligation.state !== "open") || allocations.length > 0 || blockingOperations.length > 0) {
    throw new CanonicalLeagueScheduleEditError("financial_conflict", "double-pay collection group has settled, allocated, reserved, or dispatch evidence and cannot be revised");
  }
  const request: MaterializationScheduleCommandRequest = {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: "revoke_collection_group",
    idempotencyKey: commandIdempotencyKey,
    requestFingerprint: "",
    reason: input.reason,
    materializationOperation: "canonical_collection_grouping",
    materializationPayload: { action: "revoke_for_schedule_edit", groupId: group.id, expectedScheduleRevision: input.expectedScheduleRevision },
  };
  request.requestFingerprint = buildCanonicalScheduleCommandFingerprint(request);
  const command = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, ["revoke_collection_group"]);
  const [revoked] = await tx.update(canonicalCollectionGroups).set({ state: "revoked", currentRevision: group.currentRevision + 1, lastCommandId: command.command.id, revokedAt: command.command.createdAt, revokedByUserId: input.actorUserId, revocationCommandId: command.command.id }).where(and(eq(canonicalCollectionGroups.id, group.id), eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.state, "published"), eq(canonicalCollectionGroups.currentRevision, group.currentRevision))).returning();
  if (!revoked) throw new CanonicalLeagueScheduleEditError("financial_conflict", "collection group changed during schedule edit");
  const deactivated = await tx.update(canonicalCollectionGroupMembers).set({ active: false, currentRevision: sql`${canonicalCollectionGroupMembers.currentRevision} + 1`, lastCommandId: command.command.id }).where(and(eq(canonicalCollectionGroupMembers.groupId, group.id), eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.active, true))).returning();
  await tx.insert(canonicalCollectionGroupRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, groupId: group.id, commandId: command.command.id, revisionNumber: revoked.currentRevision, snapshotSchemaVersion: CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION, beforeSnapshot: group, afterSnapshot: revoked });
  await tx.insert(canonicalCollectionGroupMemberRevisions).values(deactivated.map((member) => ({ organizationId: input.organizationId, leagueId: input.leagueId, memberId: member.id, commandId: command.command.id, revisionNumber: member.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: members.find((row) => row.id === member.id) ?? null, afterSnapshot: member })));
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function normalizedLocalTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}` : value;
}

function sameDateOnly(left: string, right: string): boolean {
  return dateOnly(left) === dateOnly(right);
}

function sameLocalTime(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizedLocalTime(left) === normalizedLocalTime(right);
}

function instantKey(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function setEquals(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function changedScheduleFields(input: CanonicalLeagueScheduleEditInput, league: League, nextSkipDates: string[]): {
  physical: boolean;
  cancellation: boolean;
} {
  const previousSkipDates = [...league.skipDates].sort();
  const previousCancelledDates = [...league.cancelledDates].sort();
  const cancellation = !setEquals(previousCancelledDates, input.cancelledDates ?? previousCancelledDates);
  const scalar = (input.seasonStart !== undefined && !sameDateOnly(input.seasonStart, league.seasonStart))
    || (input.seasonEnd !== undefined && !sameDateOnly(input.seasonEnd, league.seasonEnd))
    || (input.weekDay !== undefined && input.weekDay !== league.weekDay)
    || (input.competitionStartTime !== undefined && !sameLocalTime(input.competitionStartTime, league.competitionStartTime))
    || (input.timezone !== undefined && (input.timezone ?? null) !== (league.timezone ?? null))
    || (input.totalBowlingWeeks !== undefined && (input.totalBowlingWeeks ?? null) !== (league.totalBowlingWeeks ?? null));
  return {
    physical: scalar || !setEquals(previousSkipDates, nextSkipDates),
    cancellation,
  };
}

function orderOccurrenceUpdates<T extends { id: string; currentStartAt: string; targetStartAt: string; targetActive: boolean }>(updates: T[]): T[] {
  const byCurrentStart = new Map(updates.filter((row) => row.targetActive).map((row) => [instantKey(row.currentStartAt), row]));
  const state = new Map<string, "visiting" | "done">();
  const ordered: T[] = [];
  const visit = (row: T): void => {
    if (state.get(row.id) === "done") return;
    if (state.get(row.id) === "visiting") throw new CanonicalLeagueScheduleEditError("unsupported_edit", "the proposed schedule contains a cyclic start-time move");
    state.set(row.id, "visiting");
    if (row.targetActive) {
      const occupant = byCurrentStart.get(instantKey(row.targetStartAt));
      if (occupant && occupant.id !== row.id) {
        visit(occupant);
      }
    }
    state.set(row.id, "done");
    ordered.push(row);
  };
  for (const row of updates) visit(row);
  return ordered;
}

export async function editCanonicalLeagueSchedule(input: CanonicalLeagueScheduleEditInput): Promise<CanonicalLeagueScheduleEditResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    if (!input.reason || input.reason.trim() !== input.reason || !Number.isSafeInteger(input.expectedScheduleRevision) || input.expectedScheduleRevision < 0) throw new CanonicalLeagueScheduleEditError("invalid_edit", "schedule revision and reason are required");
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.organizationId, input.organizationId), eq(leagues.id, input.leagueId))).for("update");
    if (!league) throw new CanonicalLeagueScheduleEditError("invalid_edit", "league is outside the requested tenant");
    // The new roster schema owns lineup locking; the old activation relation
    // is deliberately absent after migration 0032.  League setup performs
    // the same canonical-evidence check under this advisory lock.
    const request: MaterializationScheduleCommandRequest = {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "edit_schedule",
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: "",
      reason: input.reason,
      materializationOperation: "canonical_schedule_edit",
      // Keep the complete submitted schedule in the command fingerprint. A
      // reused idempotency key with only skip/cancellation/timezone/scalar
      // changes must be rejected as a changed payload, even when the
      // double-pay selection itself is unchanged.
      materializationPayload: {
        contractVersion: "canonical-schedule-edit/2",
        action: "edit_schedule",
        expectedScheduleRevision: input.expectedScheduleRevision,
        doublePayDates: [...input.doublePayDates].sort(),
        skipDates: input.skipDates === undefined ? undefined : [...input.skipDates].sort(),
        cancelledDates: input.cancelledDates === undefined ? undefined : [...input.cancelledDates].sort(),
        seasonStart: input.seasonStart,
        seasonEnd: input.seasonEnd,
        weekDay: input.weekDay,
        competitionStartTime: input.competitionStartTime,
        timezone: input.timezone,
        totalBowlingWeeks: input.totalBowlingWeeks,
        metadata: input.metadata,
      },
    };
    request.requestFingerprint = buildCanonicalScheduleCommandFingerprint(request);
    const command = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, ["edit_schedule"]);
    const [run] = await tx.select().from(leagueOccurrenceGenerationRuns).where(and(eq(leagueOccurrenceGenerationRuns.organizationId, input.organizationId), eq(leagueOccurrenceGenerationRuns.leagueId, input.leagueId), inArray(leagueOccurrenceGenerationRuns.state, ["approved", "applied"]))).orderBy(desc(leagueOccurrenceGenerationRuns.sourceScheduleRevision), desc(leagueOccurrenceGenerationRuns.id)).for("update");
    if (!run) throw new CanonicalLeagueScheduleEditError("invalid_edit", "canonical schedule generation run is missing");
    await assertCanonicalScheduleTenantAndActor(tx, request);
    const currentRevision = league.canonicalScheduleRevision > 0
      ? league.canonicalScheduleRevision
      : run.sourceScheduleRevision;
    if (command.existing) {
      const collectionGroups = await readCanonicalCollectionGroupsInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        generationRunId: run.id,
      });
      return {
        mode: "idempotent_retry",
        scheduleRevision: currentRevision,
        doublePayDates: league.doublePayDates,
        collectionGroups,
        commandId: command.command.id,
        writesPerformed: false,
        league,
      };
    }
    if (currentRevision !== input.expectedScheduleRevision) throw new CanonicalLeagueScheduleEditError("stale_revision", "canonical schedule revision is stale");
    const nextSkipDates = [...(input.skipDates ?? league.skipDates)].sort();
    const nextCancelledDates = [...(input.cancelledDates ?? league.cancelledDates)].sort();
    const previousCancelledDates = [...league.cancelledDates].sort();
    const nextDoublePayDates = [...input.doublePayDates].sort();
    const doublePayChanged = !setEquals(league.doublePayDates, nextDoublePayDates);
    const fields = changedScheduleFields(input, league, nextSkipDates);
    if (fields.cancellation && (fields.physical || doublePayChanged)) {
      throw new CanonicalLeagueScheduleEditError("unsupported_edit", "cancellation changes cannot be combined with a physical schedule regeneration");
    }
    const metadataChanged = Object.entries(input.metadata ?? {}).some(([field, value]) =>
      value !== undefined && value !== league[field as keyof League]);
    const scheduleChanged = doublePayChanged || fields.physical || fields.cancellation;
    if (!scheduleChanged && !metadataChanged) {
      const collectionGroups = await readCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: run.id });
      return { mode: "idempotent_retry", scheduleRevision: currentRevision, doublePayDates: league.doublePayDates, collectionGroups, commandId: command.command.id, writesPerformed: false, league };
    }
    const transactionTimeResult = await tx.execute<{ transaction_time: string }>(sql`
      SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transaction_time
    `);
    const now = transactionTimeResult.rows[0]?.transaction_time;
    if (!now) throw new CanonicalLeagueScheduleEditError("invalid_edit", "authoritative database time is unavailable");
    const nextRevision = scheduleChanged ? currentRevision + 1 : currentRevision;
    if (fields.physical) {
      if (input.totalBowlingWeeks !== undefined && input.totalBowlingWeeks !== league.totalBowlingWeeks) {
        throw new CanonicalLeagueScheduleEditError("unsupported_edit", "changing the physical occurrence count is not supported by a same-count canonical edit");
      }
      const snapshot = resolveCanonicalDraftInputSnapshot(run.normalizedInputSnapshot, league.paymentMode);
      if (!snapshot) throw new CanonicalLeagueScheduleEditError("invalid_edit", "canonical generation input is not compatible with the schedule editor");
      const oldInput = snapshot.normalizedInput;
      const plannedSlotCount = oldInput.plannedSlotCount;
      if (!Number.isSafeInteger(plannedSlotCount) || plannedSlotCount <= 0) throw new CanonicalLeagueScheduleEditError("invalid_edit", "canonical occurrence count is unavailable");
      const existingExceptions = await tx.select().from(leagueScheduleExceptions).where(and(
        eq(leagueScheduleExceptions.organizationId, input.organizationId),
        eq(leagueScheduleExceptions.leagueId, input.leagueId),
      )).orderBy(asc(leagueScheduleExceptions.localDate), asc(leagueScheduleExceptions.id)).for("update");
      const oldExceptionByDate = new Map(existingExceptions.filter((exception) => exception.lifecycle !== "revoked").map((exception) => [exception.localDate, exception]));
      const skipExceptions: CanonicalSkipExceptionInput[] = nextSkipDates.map((localDate) => {
        const existing = oldExceptionByDate.get(localDate);
        return {
          kind: "skip",
          localDate,
          reason: existing?.reason ?? input.reason,
          source: existing?.source ?? "manual",
          lifecycleIntent: "published",
          generationRunAssociationIntent: existing ? "associate" : "do_not_associate",
          candidateReference: existing ? `retained-skip-${existing.id}` : `schedule-edit-skip-${localDate}`,
        };
      });
      const generationInput = {
        ...oldInput,
        ambiguousFold: oldInput.ambiguousFold as "earlier" | "later" | "reject",
        regularSessionBillingPolicy: oldInput.regularSessionBillingPolicy as "none" | "eligible_bowlers",
        billingOrdinalPolicy: oldInput.billingOrdinalPolicy as "planned_slot" | "dense_billable",
        specialSessionBehavior: oldInput.specialSessionBehavior as { mode: "regular_only"; version: "1" },
        sourceScheduleRevision: nextRevision,
        seasonStart: dateOnly(input.seasonStart ?? league.seasonStart),
        seasonEnd: dateOnly(input.seasonEnd ?? league.seasonEnd),
        weekday: input.weekDay ?? league.weekDay,
        localCompetitionStartTime: normalizedLocalTime(input.competitionStartTime ?? league.competitionStartTime) ?? oldInput.localCompetitionStartTime,
        timezone: input.timezone ?? league.timezone ?? oldInput.timezone,
        plannedSlotCount,
        skipExceptions,
        cancelledDates: [...nextCancelledDates],
      };
      const generation = generateCanonicalOccurrences(generationInput);
      if (generation.fatalErrors.length > 0 || generation.occurrenceCandidates.length !== plannedSlotCount) {
        throw new CanonicalLeagueScheduleEditError("invalid_edit", generation.fatalErrors[0]?.message ?? "the proposed schedule did not preserve the physical occurrence count");
      }
      if (generation.occurrenceCandidates.length !== run.generatedOccurrenceCount) {
        throw new CanonicalLeagueScheduleEditError("unsupported_edit", "the proposed schedule must preserve the canonical physical occurrence count");
      }
      const occurrenceCandidatesByOrdinal = new Map(generation.occurrenceCandidates.map((candidate) => [candidate.plannedOrdinal, candidate]));
      const currentOccurrences = await tx.select().from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        eq(leagueOccurrences.generationRunId, run.id),
      )).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(leagueOccurrences.id)).for("update");
      if (currentOccurrences.length !== run.generatedOccurrenceCount || currentOccurrences.some((row) => row.plannedOrdinal === null)) {
        throw new CanonicalLeagueScheduleEditError("invalid_edit", "canonical occurrence evidence is incomplete");
      }
      const terms = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
        inArray(leagueOccurrenceBillingTerms.occurrenceId, currentOccurrences.map((row) => row.id)),
      )).orderBy(asc(leagueOccurrenceBillingTerms.id)).for("update");
      const termByOccurrence = new Map(terms.filter((term) => term.state !== "superseded").map((term) => [term.occurrenceId, term]));
      const changedOccurrenceIds = new Set<string>();
      for (const occurrence of currentOccurrences) {
        const candidate = occurrenceCandidatesByOrdinal.get(occurrence.plannedOrdinal as number);
        const term = termByOccurrence.get(occurrence.id);
        if (!candidate || !term || candidate.competitionNumber !== occurrence.competitionNumber
          || candidate.status !== occurrence.status) {
          throw new CanonicalLeagueScheduleEditError("unsupported_edit", "the proposed schedule would change cancellation or competition identity");
        }
        const candidateTerm = generation.billingTermCandidates.find((value) => value.occurrenceCandidateReference === candidate.candidateReference);
        if (!candidateTerm || candidateTerm.billingOrdinal !== term.billingOrdinal
          || candidateTerm.defaultAmountMinor !== term.defaultAmountMinor
          || candidateTerm.currency !== term.currency
          || candidateTerm.obligationPolicy !== term.obligationPolicy) {
          throw new CanonicalLeagueScheduleEditError("unsupported_edit", "the proposed schedule would change billing ordinal or amount semantics");
        }
        const changed = occurrence.authoritativeLocalDate !== candidate.authoritativeLocalDate
          || normalizedLocalTime(occurrence.authoritativeLocalStartTime) !== normalizedLocalTime(candidate.authoritativeLocalStartTime)
          || occurrence.timezone !== candidate.timezone
          || instantKey(occurrence.startAt) !== instantKey(candidate.startAt)
          || occurrence.selectedUtcOffsetMinutes !== candidate.selectedUtcOffsetMinutes
          || occurrence.foldResolution !== candidate.foldResolution
          || occurrence.resolverVersion !== candidate.resolverVersion;
        if (changed) changedOccurrenceIds.add(occurrence.id);
      }
      if (generation.occurrenceCandidates.some((candidate, index) => generation.occurrenceCandidates.slice(0, index).some((prior) => prior.status !== "cancelled" && candidate.status !== "cancelled" && instantKey(prior.startAt) === instantKey(candidate.startAt)))) {
        throw new CanonicalLeagueScheduleEditError("invalid_edit", "the proposed schedule contains duplicate active start instants");
      }
      const proposedSlots = generation.occurrenceCandidates.map((candidate) => candidate.startAt);
      const wholeFutureCorrection = [...proposedSlots].every((startAt) => Date.parse(startAt) > Date.parse(now))
        && currentOccurrences.some((occurrence) => changedOccurrenceIds.has(occurrence.id) && Date.parse(occurrence.startAt) <= Date.parse(now));
      if (wholeFutureCorrection) {
        const [game] = await tx.select({ id: games.id }).from(games).where(eq(games.leagueId, input.leagueId)).limit(1);
        const [operation] = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.leagueId, input.leagueId),
        )).limit(1);
        const [payment] = await tx.select({ id: payments.id }).from(payments).where(and(
          eq(payments.organizationId, input.organizationId),
          eq(payments.leagueId, input.leagueId),
        )).limit(1);
        const [allocation] = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
          eq(paymentAllocations.organizationId, input.organizationId),
          eq(paymentAllocations.leagueId, input.leagueId),
        )).limit(1);
        const [preparation] = await tx.select({ id: standingAutopayPreparationAttempts.id }).from(standingAutopayPreparationAttempts).where(and(
          eq(standingAutopayPreparationAttempts.organizationId, input.organizationId),
          eq(standingAutopayPreparationAttempts.leagueId, input.leagueId),
        )).limit(1);
        const locked = currentOccurrences.some((occurrence) => occurrence.lifecycle === "locked" || occurrence.lockedAt !== null);
        if (game || operation || payment || allocation || preparation || locked) throw new CanonicalLeagueScheduleEditError("financial_conflict", "an elapsed-start correction requires an entirely future, unplayed, unpaid league with no payment operations or explicit locks");
      } else if (currentOccurrences.some((occurrence) => changedOccurrenceIds.has(occurrence.id) && Date.parse(occurrence.startAt) <= Date.parse(now))) {
        throw new CanonicalLeagueScheduleEditError("financial_conflict", "an elapsed occurrence cannot be moved by a mid-season schedule edit");
      }
      if (currentOccurrences.some((occurrence) => {
        if (!changedOccurrenceIds.has(occurrence.id)) return false;
        const candidate = occurrenceCandidatesByOrdinal.get(occurrence.plannedOrdinal as number);
        return candidate !== undefined && Date.parse(candidate.startAt) <= Date.parse(now);
      })) {
        throw new CanonicalLeagueScheduleEditError("financial_conflict", "a changed occurrence must remain strictly future-facing");
      }
      const currentActiveStarts = new Map(currentOccurrences.filter((occurrence) => occurrence.status !== "cancelled").map((occurrence) => [instantKey(occurrence.startAt), occurrence.id]));
      const updates = currentOccurrences.filter((occurrence) => changedOccurrenceIds.has(occurrence.id)).map((occurrence) => {
        const candidate = occurrenceCandidatesByOrdinal.get(occurrence.plannedOrdinal as number);
        if (!candidate) throw new CanonicalLeagueScheduleEditError("invalid_edit", "occurrence candidate mapping is incomplete");
        const occupant = candidate.status === "cancelled" ? undefined : currentActiveStarts.get(instantKey(candidate.startAt));
        if (occupant && occupant !== occurrence.id && !changedOccurrenceIds.has(occupant)) throw new CanonicalLeagueScheduleEditError("invalid_edit", "the proposed schedule collides with an unchanged occurrence");
        return { id: occurrence.id, currentStartAt: occurrence.startAt, targetStartAt: candidate.startAt, targetActive: candidate.status !== "cancelled", occurrence, candidate };
      });
      const orderedUpdates = orderOccurrenceUpdates(updates);
      let desiredPairings;
      try {
        desiredPairings = deriveCanonicalCollectionPairs({
          doublePayDates: nextDoublePayDates,
          occurrences: currentOccurrences.map((occurrence) => {
            const candidate = occurrenceCandidatesByOrdinal.get(occurrence.plannedOrdinal as number);
            const term = terms.find((value) => value.occurrenceId === occurrence.id && value.state !== "superseded");
            if (!candidate || !term) throw new CanonicalCollectionGroupingError("incompatible_occurrence", "collection grouping evidence is incomplete");
            return {
              occurrenceId: occurrence.id,
              localDate: candidate.authoritativeLocalDate,
              status: candidate.status,
              lifecycle: occurrence.lifecycle,
              billingTerm: {
                id: term.id,
                obligationPolicy: term.obligationPolicy,
                billingOrdinal: term.billingOrdinal,
                amountMinor: term.defaultAmountMinor,
                currency: term.currency,
              },
            };
          }),
        });
      } catch (error) {
        if (error instanceof CanonicalCollectionGroupingError) throw new CanonicalLeagueScheduleEditError("invalid_edit", error.message);
        throw error;
      }
      // Revoke only groups whose durable members or selected trigger changed.
      const groups = await tx.select().from(canonicalCollectionGroups).where(and(
        eq(canonicalCollectionGroups.organizationId, input.organizationId),
        eq(canonicalCollectionGroups.leagueId, input.leagueId),
        eq(canonicalCollectionGroups.generationRunId, run.id),
        eq(canonicalCollectionGroups.state, "published"),
      )).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id)).for("update");
      // Member occurrence IDs, rather than dates, are the identity test for
      // group changes. Load the members once so changed date/start evidence
      // cannot be mistaken for date-proximity identity.
      const groupMembers = groups.length === 0 ? [] : await tx.select().from(canonicalCollectionGroupMembers).where(and(
        eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
        inArray(canonicalCollectionGroupMembers.groupId, groups.map((group) => group.id)),
        eq(canonicalCollectionGroupMembers.active, true),
      )).orderBy(asc(canonicalCollectionGroupMembers.groupId), asc(canonicalCollectionGroupMembers.memberOrdinal)).for("update");
      const finalGroupsToRevoke = groups.filter((group) => {
        const desired = desiredPairings.find((pairing) => pairing.groupOrdinal === group.groupOrdinal);
        const members = groupMembers.filter((member) => member.groupId === group.id);
        if (members.some((member) => changedOccurrenceIds.has(member.occurrenceId))) return true;
        return !desired || !canonicalCollectionGroupMembersMatchPair(members, desired);
      });
      for (const group of finalGroupsToRevoke) await revokeGroupInTransaction(tx, input, group, `${input.idempotencyKey}:revoke:${group.groupOrdinal}`);
      for (const update of orderedUpdates) {
        try {
          await assertRescheduleFinanciallyEditableInTransaction(tx, update.occurrence, now, { allowElapsed: wholeFutureCorrection });
        } catch (error) {
          if (error instanceof CanonicalOccurrenceTransactionError) throw new CanonicalLeagueScheduleEditError("financial_conflict", error.message);
          throw error;
        }
      }
      for (const update of orderedUpdates) {
        const { occurrence, candidate } = update;
        const [updatedOccurrence] = await tx.update(leagueOccurrences).set({
          authoritativeLocalDate: candidate.authoritativeLocalDate,
          authoritativeLocalStartTime: candidate.authoritativeLocalStartTime,
          timezone: candidate.timezone,
          startAt: candidate.startAt,
          selectedUtcOffsetMinutes: candidate.selectedUtcOffsetMinutes,
          foldResolution: candidate.foldResolution,
          resolverVersion: candidate.resolverVersion,
          currentRevision: occurrence.currentRevision + 1,
          lastCommandId: command.command.id,
          updatedAt: now,
        }).where(and(
          eq(leagueOccurrences.id, occurrence.id),
          eq(leagueOccurrences.currentRevision, occurrence.currentRevision),
        )).returning();
        if (!updatedOccurrence) throw new CanonicalLeagueScheduleEditError("stale_revision", "an occurrence changed during schedule edit");
        await tx.insert(leagueOccurrenceRevisions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceId: occurrence.id,
          commandId: command.command.id,
          revisionNumber: updatedOccurrence.currentRevision,
          snapshotSchemaVersion: 1,
          beforeSnapshot: occurrenceSnapshot(occurrence),
          afterSnapshot: occurrenceSnapshot(updatedOccurrence),
        });
      }
      if (orderedUpdates.length > 0) {
        // Read and guard all affected roster evidence once. The materializer
        // preserves each occurrence's payer/component facts while batching
        // the replacement writes under this transaction's league lock.
        await materializeRosterPaymentOccurrencesInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceIds: orderedUpdates.map((update) => update.id),
          actorUserId: input.actorUserId,
        });
      }
      const activeExceptionDates = new Set(existingExceptions.filter((exception) => exception.lifecycle === "published").map((exception) => exception.localDate));
      const retainedExceptionDates = new Set(nextSkipDates);
      for (const exception of existingExceptions.filter((value) => value.lifecycle === "published" && retainedExceptionDates.has(value.localDate))) {
        const candidate = generation.exceptionCandidates.find((value) => value.authoritativeLocalDate === exception.localDate);
        if (!candidate || candidate.timezone === exception.timezone) continue;
        const [updatedException] = await tx.update(leagueScheduleExceptions).set({
          timezone: candidate.timezone,
          currentRevision: exception.currentRevision + 1,
          lastCommandId: command.command.id,
          updatedAt: now,
        }).where(and(eq(leagueScheduleExceptions.id, exception.id), eq(leagueScheduleExceptions.currentRevision, exception.currentRevision), eq(leagueScheduleExceptions.lifecycle, "published"))).returning();
        if (!updatedException) throw new CanonicalLeagueScheduleEditError("stale_revision", "a retained schedule exception changed during schedule edit");
        await tx.insert(leagueScheduleExceptionRevisions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          exceptionId: exception.id,
          commandId: command.command.id,
          revisionNumber: updatedException.currentRevision,
          snapshotSchemaVersion: 1,
          beforeSnapshot: exceptionSnapshot(exception),
          afterSnapshot: exceptionSnapshot(updatedException),
        });
      }
      for (const exception of existingExceptions.filter((value) => value.lifecycle === "published" && !retainedExceptionDates.has(value.localDate))) {
        const [revoked] = await tx.update(leagueScheduleExceptions).set({
          lifecycle: "revoked",
          currentRevision: exception.currentRevision + 1,
          lastCommandId: command.command.id,
          revokedAt: now,
          revokedByUserId: input.actorUserId,
          revocationCommandId: command.command.id,
          updatedAt: now,
        }).where(and(eq(leagueScheduleExceptions.id, exception.id), eq(leagueScheduleExceptions.currentRevision, exception.currentRevision), eq(leagueScheduleExceptions.lifecycle, "published"))).returning();
        if (!revoked) throw new CanonicalLeagueScheduleEditError("stale_revision", "a schedule exception changed during schedule edit");
        await tx.insert(leagueScheduleExceptionRevisions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          exceptionId: exception.id,
          commandId: command.command.id,
          revisionNumber: revoked.currentRevision,
          snapshotSchemaVersion: 1,
          beforeSnapshot: exceptionSnapshot(exception),
          afterSnapshot: exceptionSnapshot(revoked),
        });
      }
      for (const candidate of generation.exceptionCandidates.filter((value) => !activeExceptionDates.has(value.authoritativeLocalDate))) {
        const [created] = await tx.insert(leagueScheduleExceptions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          kind: candidate.kind,
          localDate: candidate.authoritativeLocalDate,
          timezone: candidate.timezone,
          source: "manual",
          lifecycle: "published",
          reason: candidate.reason,
          generationRunId: null,
          currentRevision: 1,
          lastCommandId: command.command.id,
          publishedAt: now,
          publishedByUserId: input.actorUserId,
          publicationCommandId: command.command.id,
          updatedAt: now,
        }).returning();
        if (!created) throw new CanonicalLeagueScheduleEditError("invalid_edit", "new schedule exception could not be recorded");
        await tx.insert(leagueScheduleExceptionRevisions).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          exceptionId: created.id,
          commandId: command.command.id,
          revisionNumber: 1,
          snapshotSchemaVersion: 1,
          beforeSnapshot: null,
          afterSnapshot: exceptionSnapshot(created),
        });
      }
    }
    const addedCancelledDates = nextCancelledDates.filter((date) => !previousCancelledDates.includes(date));
    const removedCancelledDates = previousCancelledDates.filter((date) => !nextCancelledDates.includes(date));
    const affectedDates = [...new Set([...addedCancelledDates, ...removedCancelledDates])].sort();
    if (affectedDates.length > 0) {
      const affectedOccurrences = await tx.select().from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.authoritativeLocalDate, affectedDates),
      )).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(leagueOccurrences.id)).for("update");
      if (affectedOccurrences.length !== affectedDates.length
        || affectedOccurrences.some((occurrence) => affectedOccurrences.filter((candidate) => candidate.authoritativeLocalDate === occurrence.authoritativeLocalDate).length !== 1)) {
        throw new CanonicalLeagueScheduleEditError("financial_conflict", "cancellation date does not identify exactly one physical canonical occurrence");
      }
      for (const occurrence of affectedOccurrences) {
        if (addedCancelledDates.includes(occurrence.authoritativeLocalDate)) {
          const activityRows = await tx.select({ id: games.id }).from(games).where(and(eq(games.leagueId, input.leagueId), eq(games.occurrenceId, occurrence.id))).orderBy(asc(games.id));
          const cancellationRequest = {
            organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId,
            commandType: "cancel", idempotencyKey: `${input.idempotencyKey}:cancel:${occurrence.id}`, requestFingerprint: "",
            occurrenceId: occurrence.id, now, reason: input.reason, activityEvidence: activityRows.map((row) => `game:${row.id}`),
          } as const;
          try { await cancelOccurrenceInTransaction(tx, { ...cancellationRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancellationRequest) }); }
          catch (error) { if (error instanceof CanonicalOccurrenceTransactionError) throw new CanonicalLeagueScheduleEditError("financial_conflict", error.message); throw error; }
        } else if (removedCancelledDates.includes(occurrence.authoritativeLocalDate) && occurrence.status === "cancelled") {
          try { await restoreCancelledOccurrenceInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, occurrenceId: occurrence.id, idempotencyKey: `${input.idempotencyKey}:restore:${occurrence.id}`, reason: input.reason, now }); }
          catch (error) { if (error instanceof CanonicalOccurrenceTransactionError) throw new CanonicalLeagueScheduleEditError("financial_conflict", error.message); throw error; }
        }
      }
    }
    if (doublePayChanged && !fields.physical) {
      const groups = await tx.select().from(canonicalCollectionGroups).where(and(eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.generationRunId, run.id), eq(canonicalCollectionGroups.state, "published"))).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id)).for("update");
      const occurrences = await tx.select().from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        eq(leagueOccurrences.generationRunId, run.id),
      )).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(leagueOccurrences.id)).for("update");
      const terms = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
        inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrences.map((occurrence) => occurrence.id)),
      )).for("update");
      let desiredPairings;
      try {
        desiredPairings = deriveCanonicalCollectionPairs({
          doublePayDates: nextDoublePayDates,
          occurrences: occurrences.map((occurrence) => {
            const term = terms.find((value) => value.occurrenceId === occurrence.id && value.state !== "superseded");
            if (!term) throw new CanonicalCollectionGroupingError("incompatible_occurrence", "collection grouping evidence is incomplete");
            return { occurrenceId: occurrence.id, localDate: occurrence.authoritativeLocalDate, status: occurrence.status, lifecycle: occurrence.lifecycle, billingTerm: { id: term.id, obligationPolicy: term.obligationPolicy, billingOrdinal: term.billingOrdinal, amountMinor: term.defaultAmountMinor, currency: term.currency } };
          }),
        });
      } catch (error) {
        if (error instanceof CanonicalCollectionGroupingError) throw new CanonicalLeagueScheduleEditError("invalid_edit", error.message);
        throw error;
      }
      const members = groups.length === 0 ? [] : await tx.select().from(canonicalCollectionGroupMembers).where(and(
        eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
        inArray(canonicalCollectionGroupMembers.groupId, groups.map((group) => group.id)),
        eq(canonicalCollectionGroupMembers.active, true),
      )).orderBy(asc(canonicalCollectionGroupMembers.groupId), asc(canonicalCollectionGroupMembers.memberOrdinal)).for("update");
      for (const group of groups) {
        const desired = desiredPairings.find((pairing) => pairing.groupOrdinal === group.groupOrdinal);
        const current = members.filter((member) => member.groupId === group.id);
        const unchanged = desired && canonicalCollectionGroupMembersMatchPair(current, desired);
        if (!unchanged) await revokeGroupInTransaction(tx, input, group, `${input.idempotencyKey}:revoke:${group.groupOrdinal}`);
      }
    }
    const [updatedLeague] = await tx.update(leagues).set({
      doublePayDates: nextDoublePayDates,
      skipDates: nextSkipDates,
      cancelledDates: nextCancelledDates,
      ...(input.seasonStart === undefined ? {} : { seasonStart: input.seasonStart }),
      ...(input.seasonEnd === undefined ? {} : { seasonEnd: input.seasonEnd }),
      ...(input.weekDay === undefined ? {} : { weekDay: input.weekDay }),
      ...(input.competitionStartTime === undefined ? {} : { competitionStartTime: input.competitionStartTime }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.totalBowlingWeeks === undefined ? {} : { totalBowlingWeeks: input.totalBowlingWeeks }),
      ...(input.metadata ?? {}),
      canonicalScheduleRevision: nextRevision,
    }).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId), eq(leagues.canonicalScheduleRevision, league.canonicalScheduleRevision))).returning();
    if (!updatedLeague) throw new CanonicalLeagueScheduleEditError("stale_revision", "canonical schedule revision changed during edit");
    let persisted: PersistCanonicalCollectionGroupsResult = { groups: [], groupIds: [], memberIds: [], revisionIds: [], commandIds: [], writesPerformed: false };
    if (nextDoublePayDates.length > 0 && (doublePayChanged || fields.physical)) {
      try {
        persisted = await persistCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, generationRunId: run.id, generationRunSourceScheduleRevision: run.sourceScheduleRevision, sourceScheduleRevision: nextRevision, doublePayDates: nextDoublePayDates, idempotencyKey: input.idempotencyKey, reason: input.reason });
      } catch (error) {
        if (error instanceof CanonicalCollectionGroupingError) throw new CanonicalLeagueScheduleEditError("invalid_edit", error.message);
        throw error;
      }
    }
    const collectionGroups = persisted.groups.length > 0 ? persisted.groups : await readCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: run.id });
    try {
      await loadLeagueOccurrenceScheduleSnapshot({ organizationId: input.organizationId, leagueId: input.leagueId, includeAdministratorEvidence: false }, tx);
    } catch (error) {
      if (error instanceof LeagueOccurrenceScheduleError) {
        throw new CanonicalLeagueScheduleEditError("invalid_edit", error.message);
      }
      throw error;
    }
    return { mode: "applied", scheduleRevision: nextRevision, doublePayDates: updatedLeague.doublePayDates, collectionGroups, commandId: command.command.id, writesPerformed: true, league: updatedLeague };
  });
}
