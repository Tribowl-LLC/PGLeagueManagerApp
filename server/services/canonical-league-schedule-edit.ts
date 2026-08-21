import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  canonicalCollectionGroupMemberRevisions,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroups,
  bowlerOccurrenceObligations,
  occurrenceCollectionPlanItems,
  occurrenceCollectionPlans,
  paymentOccurrenceAllocations,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperations,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagues,
  type League,
} from "@shared/schema";
import { CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION, CanonicalCollectionGroupingError } from "@shared/canonical-collection-groups";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";
import { persistCanonicalCollectionGroupsInTransaction, readCanonicalCollectionGroupsInTransaction, type PersistCanonicalCollectionGroupsResult } from "./canonical-collection-groups.js";
import { cancelOccurrenceInTransaction, restoreCancelledOccurrenceInTransaction } from "./canonical-occurrence-transactions.js";
import {
  assertCanonicalScheduleTenantAndActor,
  buildCanonicalScheduleCommandFingerprint,
  getOrCreateCanonicalScheduleCommandInTransaction,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";
import { db } from "../db.js";

export class CanonicalLeagueScheduleEditError extends Error {
  constructor(public readonly code: "stale_revision" | "financial_conflict" | "invalid_edit", message: string) {
    super(message);
    this.name = "CanonicalLeagueScheduleEditError";
  }
}

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
}

export interface CanonicalLeagueScheduleEditResult {
  mode: "applied" | "idempotent_retry";
  scheduleRevision: number;
  doublePayDates: string[];
  collectionGroups: PersistCanonicalCollectionGroupsResult["groups"];
  commandId: string;
  writesPerformed: boolean;
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
  const obligations = await tx.select({ id: bowlerOccurrenceObligations.id }).from(bowlerOccurrenceObligations).where(and(
    eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
    eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
    inArray(bowlerOccurrenceObligations.occurrenceId, occurrenceIds),
  )).orderBy(asc(bowlerOccurrenceObligations.id)).for("update");
  const allocations = await tx.select({ id: paymentOccurrenceAllocations.id }).from(paymentOccurrenceAllocations).where(and(
    eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
    eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
    inArray(paymentOccurrenceAllocations.occurrenceId, occurrenceIds),
  )).orderBy(asc(paymentOccurrenceAllocations.id)).for("update");
  const plans = await tx.select({ id: occurrenceCollectionPlans.id }).from(occurrenceCollectionPlans).where(and(
    eq(occurrenceCollectionPlans.organizationId, input.organizationId),
    eq(occurrenceCollectionPlans.leagueId, input.leagueId),
    eq(occurrenceCollectionPlans.state, "ready"),
    inArray(occurrenceCollectionPlans.triggerOccurrenceId, occurrenceIds),
  )).orderBy(asc(occurrenceCollectionPlans.id)).for("update");
  const planItems = await tx.select({ id: occurrenceCollectionPlanItems.id }).from(occurrenceCollectionPlanItems).where(and(
    eq(occurrenceCollectionPlanItems.organizationId, input.organizationId),
    eq(occurrenceCollectionPlanItems.leagueId, input.leagueId),
    inArray(occurrenceCollectionPlanItems.occurrenceId, occurrenceIds),
  )).orderBy(asc(occurrenceCollectionPlanItems.id)).for("update");
  const operations = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    inArray(paymentOperations.triggerOccurrenceId, occurrenceIds),
  )).orderBy(asc(paymentOperations.id)).for("update");
  const snapshotOperations = await tx.select({ operationId: paymentOperationOccurrenceSnapshotAllocations.operationId }).from(paymentOperationOccurrenceSnapshotAllocations).where(and(
    eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
    eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
    inArray(paymentOperationOccurrenceSnapshotAllocations.occurrenceId, occurrenceIds),
  )).orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.operationId)).for("update");
  if (obligations.length > 0 || allocations.length > 0 || plans.length > 0 || planItems.length > 0 || operations.length > 0 || snapshotOperations.length > 0) {
    throw new CanonicalLeagueScheduleEditError("financial_conflict", "double-pay collection group has financial or dispatch evidence and cannot be revised");
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

export async function editCanonicalLeagueSchedule(input: CanonicalLeagueScheduleEditInput): Promise<CanonicalLeagueScheduleEditResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    if (!input.reason || input.reason.trim() !== input.reason || !Number.isSafeInteger(input.expectedScheduleRevision) || input.expectedScheduleRevision < 0) throw new CanonicalLeagueScheduleEditError("invalid_edit", "schedule revision and reason are required");
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.organizationId, input.organizationId), eq(leagues.id, input.leagueId))).for("update");
    if (!league) throw new CanonicalLeagueScheduleEditError("invalid_edit", "league is outside the requested tenant");
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
        contractVersion: "canonical-schedule-edit/1",
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
      };
    }
    if (currentRevision !== input.expectedScheduleRevision) throw new CanonicalLeagueScheduleEditError("stale_revision", "canonical schedule revision is stale");
    const nextSkipDates = [...(input.skipDates ?? league.skipDates)].sort();
    const nextCancelledDates = [...(input.cancelledDates ?? league.cancelledDates)].sort();
    const previousSkipDates = [...league.skipDates].sort();
    const previousCancelledDates = [...league.cancelledDates].sort();
    const doublePayChanged = JSON.stringify([...league.doublePayDates].sort()) !== JSON.stringify([...input.doublePayDates].sort());
    const dateScheduleChanged = JSON.stringify(previousSkipDates) !== JSON.stringify(nextSkipDates) || JSON.stringify(previousCancelledDates) !== JSON.stringify(nextCancelledDates);
    const sameDateOnly = (left: string, right: string): boolean => left.slice(0, 10) === right.slice(0, 10);
    const scalarScheduleChanged = (input.seasonStart !== undefined && !sameDateOnly(input.seasonStart, league.seasonStart))
      || (input.seasonEnd !== undefined && !sameDateOnly(input.seasonEnd, league.seasonEnd))
      || (input.weekDay !== undefined && input.weekDay !== league.weekDay)
      || (input.competitionStartTime !== undefined && (input.competitionStartTime ?? null) !== (league.competitionStartTime ?? null))
      || (input.timezone !== undefined && (input.timezone ?? null) !== (league.timezone ?? null))
      || (input.totalBowlingWeeks !== undefined && (input.totalBowlingWeeks ?? null) !== (league.totalBowlingWeeks ?? null));
    if (!doublePayChanged && !dateScheduleChanged && !scalarScheduleChanged) {
      const collectionGroups = await readCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: run.id });
      return { mode: "idempotent_retry", scheduleRevision: currentRevision, doublePayDates: league.doublePayDates, collectionGroups, commandId: command.command.id, writesPerformed: false };
    }
    const now = new Date().toISOString();
    const addedCancelledDates = nextCancelledDates.filter((date) => !previousCancelledDates.includes(date));
    const removedCancelledDates = previousCancelledDates.filter((date) => !nextCancelledDates.includes(date));
    const affectedDates = [...new Set([...addedCancelledDates, ...removedCancelledDates])].sort();
    if (affectedDates.length > 0) {
      const affectedOccurrences = await tx.select().from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.authoritativeLocalDate, affectedDates),
      )).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(leagueOccurrences.id)).for("update");
      for (const occurrence of affectedOccurrences) {
        if (addedCancelledDates.includes(occurrence.authoritativeLocalDate) && occurrence.status === "scheduled") {
          const cancellationRequest = {
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            actorUserId: input.actorUserId,
            commandType: "cancel",
            idempotencyKey: `${input.idempotencyKey}:cancel:${occurrence.id}`,
            requestFingerprint: "",
            occurrenceId: occurrence.id,
            now,
            reason: input.reason,
          } as const;
          await cancelOccurrenceInTransaction(tx, { ...cancellationRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancellationRequest) });
        } else if (removedCancelledDates.includes(occurrence.authoritativeLocalDate) && occurrence.status === "cancelled") {
          await restoreCancelledOccurrenceInTransaction(tx, {
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            actorUserId: input.actorUserId,
            occurrenceId: occurrence.id,
            idempotencyKey: `${input.idempotencyKey}:restore:${occurrence.id}`,
            reason: input.reason,
            now,
          });
        }
      }
    }
    if (doublePayChanged) {
      const groups = await tx.select().from(canonicalCollectionGroups).where(and(eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.generationRunId, run.id), eq(canonicalCollectionGroups.state, "published"))).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id)).for("update");
      for (const [index, group] of groups.entries()) await revokeGroupInTransaction(tx, input, group, `${input.idempotencyKey}:revoke:${index + 1}`);
    }
    const nextRevision = currentRevision + 1;
    const [updatedLeague] = await tx.update(leagues).set({
      doublePayDates: input.doublePayDates,
      skipDates: nextSkipDates,
      cancelledDates: nextCancelledDates,
      ...(input.seasonStart === undefined ? {} : { seasonStart: input.seasonStart }),
      ...(input.seasonEnd === undefined ? {} : { seasonEnd: input.seasonEnd }),
      ...(input.weekDay === undefined ? {} : { weekDay: input.weekDay }),
      ...(input.competitionStartTime === undefined ? {} : { competitionStartTime: input.competitionStartTime }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.totalBowlingWeeks === undefined ? {} : { totalBowlingWeeks: input.totalBowlingWeeks }),
      canonicalScheduleRevision: nextRevision,
    }).where(and(
      eq(leagues.id, input.leagueId),
      eq(leagues.organizationId, input.organizationId),
      eq(leagues.canonicalScheduleRevision, league.canonicalScheduleRevision),
    )).returning({ id: leagues.id });
    if (!updatedLeague) {
      throw new CanonicalLeagueScheduleEditError("stale_revision", "canonical schedule revision changed during edit");
    }
    let persisted: PersistCanonicalCollectionGroupsResult = { groups: [], groupIds: [], memberIds: [], revisionIds: [], commandIds: [], writesPerformed: false };
    if (!doublePayChanged) {
      const collectionGroups = await readCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: run.id });
      return { mode: "applied", scheduleRevision: nextRevision, doublePayDates: league.doublePayDates, collectionGroups, commandId: command.command.id, writesPerformed: true };
    }
    try {
      persisted = await persistCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, generationRunId: run.id, generationRunSourceScheduleRevision: run.sourceScheduleRevision, sourceScheduleRevision: nextRevision, doublePayDates: input.doublePayDates, idempotencyKey: input.idempotencyKey, reason: input.reason });
    } catch (error) {
      if (error instanceof CanonicalCollectionGroupingError) throw new CanonicalLeagueScheduleEditError("invalid_edit", error.message);
      throw error;
    }
    return { mode: "applied", scheduleRevision: nextRevision, doublePayDates: input.doublePayDates, collectionGroups: persisted.groups, commandId: command.command.id, writesPerformed: true };
  });
}
