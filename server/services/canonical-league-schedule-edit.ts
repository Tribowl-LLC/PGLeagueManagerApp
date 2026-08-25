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
  leagues,
  games,
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
  CanonicalOccurrenceTransactionError,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";
import { db } from "../db.js";
import { revokeStandingAutopayForArchivedLeagueInTransaction } from "./roster-standing-autopay.js";

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
  const obligations = await tx.select({ id: paymentObligations.id }).from(paymentObligations).where(and(
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
    eq(paymentAllocations.state, "active"),
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
  const rosterOperationRows = await tx.selectDistinct({ id: paymentOperations.id }).from(paymentOperations)
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
      inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const),
      inArray(paymentObligations.occurrenceId, occurrenceIds),
    )).orderBy(asc(paymentOperations.id));
  const operationIds = [...new Set([...triggerOperationRows, ...rosterOperationRows].map((row) => row.id))].sort();
  const operations = operationIds.length === 0 ? [] : await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    inArray(paymentOperations.id, operationIds),
  )).orderBy(asc(paymentOperations.id)).for("update");
  if (obligations.length > 0 || allocations.length > 0 || operations.length > 0) {
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
    if (league.scheduleAuthority !== "canonical") throw new CanonicalLeagueScheduleEditError("invalid_edit", "retired legacy leagues are not editable");
    if (!league.active) throw new CanonicalLeagueScheduleEditError("unsupported_edit", "inactive canonical leagues are read-only archives");
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
    const previousSkipDates = [...league.skipDates].sort();
    const previousCancelledDates = [...league.cancelledDates].sort();
    const doublePayChanged = JSON.stringify([...league.doublePayDates].sort()) !== JSON.stringify([...input.doublePayDates].sort());
    const dateScheduleChanged = JSON.stringify(previousSkipDates) !== JSON.stringify(nextSkipDates) || JSON.stringify(previousCancelledDates) !== JSON.stringify(nextCancelledDates);
    const sameDateOnly = (left: string, right: string): boolean => left.slice(0, 10) === right.slice(0, 10);
    const sameLocalTime = (left: string | null | undefined, right: string | null | undefined): boolean => {
      const normalize = (value: string | null | undefined): string | null => {
        if (value == null) return null;
        const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
        return match ? `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}` : value;
      };
      return normalize(left) === normalize(right);
    };
    const scalarScheduleChanged = (input.seasonStart !== undefined && !sameDateOnly(input.seasonStart, league.seasonStart))
      || (input.seasonEnd !== undefined && !sameDateOnly(input.seasonEnd, league.seasonEnd))
      || (input.weekDay !== undefined && input.weekDay !== league.weekDay)
      || (input.competitionStartTime !== undefined && !sameLocalTime(input.competitionStartTime, league.competitionStartTime))
      || (input.timezone !== undefined && (input.timezone ?? null) !== (league.timezone ?? null))
      || (input.totalBowlingWeeks !== undefined && (input.totalBowlingWeeks ?? null) !== (league.totalBowlingWeeks ?? null));
    if (scalarScheduleChanged || JSON.stringify(previousSkipDates) !== JSON.stringify(nextSkipDates)) {
      throw new CanonicalLeagueScheduleEditError(
        "unsupported_edit",
        "skip dates and physical canonical schedule inputs require an audited regeneration",
      );
    }
    const metadataChanged = Object.entries(input.metadata ?? {}).some(([field, value]) =>
      value !== undefined && value !== league[field as keyof League]);
    const scheduleChanged = doublePayChanged || dateScheduleChanged;
    if (!scheduleChanged && !metadataChanged) {
      const collectionGroups = await readCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: run.id });
      return { mode: "idempotent_retry", scheduleRevision: currentRevision, doublePayDates: league.doublePayDates, collectionGroups, commandId: command.command.id, writesPerformed: false, league };
    }
    if (input.metadata?.active === false) {
      await revokeStandingAutopayForArchivedLeagueInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
      });
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
      if (affectedOccurrences.length !== affectedDates.length
        || affectedOccurrences.some((occurrence) => affectedOccurrences.filter((candidate) => candidate.authoritativeLocalDate === occurrence.authoritativeLocalDate).length !== 1)) {
        throw new CanonicalLeagueScheduleEditError("financial_conflict", "cancellation date does not identify exactly one physical canonical occurrence");
      }
      for (const occurrence of affectedOccurrences) {
        if (addedCancelledDates.includes(occurrence.authoritativeLocalDate)) {
          const activityRows = await tx.select({ id: games.id }).from(games).where(and(
            eq(games.leagueId, input.leagueId),
            eq(games.occurrenceId, occurrence.id),
          )).orderBy(asc(games.id));
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
            activityEvidence: activityRows.map((row) => `game:${row.id}`),
          } as const;
          try {
            await cancelOccurrenceInTransaction(tx, { ...cancellationRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancellationRequest) });
          } catch (error) {
            if (error instanceof CanonicalOccurrenceTransactionError) {
              throw new CanonicalLeagueScheduleEditError("financial_conflict", error.message);
            }
            throw error;
          }
        } else if (removedCancelledDates.includes(occurrence.authoritativeLocalDate) && occurrence.status === "cancelled") {
          try {
            await restoreCancelledOccurrenceInTransaction(tx, {
              organizationId: input.organizationId,
              leagueId: input.leagueId,
              actorUserId: input.actorUserId,
              occurrenceId: occurrence.id,
              idempotencyKey: `${input.idempotencyKey}:restore:${occurrence.id}`,
              reason: input.reason,
              now,
            });
          } catch (error) {
            if (error instanceof CanonicalOccurrenceTransactionError) {
              throw new CanonicalLeagueScheduleEditError("financial_conflict", error.message);
            }
            throw error;
          }
        }
      }
    }
    if (doublePayChanged) {
      const groups = await tx.select().from(canonicalCollectionGroups).where(and(eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.generationRunId, run.id), eq(canonicalCollectionGroups.state, "published"))).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id)).for("update");
      for (const [index, group] of groups.entries()) await revokeGroupInTransaction(tx, input, group, `${input.idempotencyKey}:revoke:${index + 1}`);
    }
    const nextRevision = scheduleChanged ? currentRevision + 1 : currentRevision;
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
      ...(input.metadata ?? {}),
      canonicalScheduleRevision: nextRevision,
    }).where(and(
      eq(leagues.id, input.leagueId),
      eq(leagues.organizationId, input.organizationId),
      eq(leagues.canonicalScheduleRevision, league.canonicalScheduleRevision),
    )).returning();
    if (!updatedLeague) {
      throw new CanonicalLeagueScheduleEditError("stale_revision", "canonical schedule revision changed during edit");
    }
    let persisted: PersistCanonicalCollectionGroupsResult = { groups: [], groupIds: [], memberIds: [], revisionIds: [], commandIds: [], writesPerformed: false };
    if (!doublePayChanged) {
      const collectionGroups = await readCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: run.id });
      return { mode: "applied", scheduleRevision: nextRevision, doublePayDates: updatedLeague.doublePayDates, collectionGroups, commandId: command.command.id, writesPerformed: true, league: updatedLeague };
    }
    try {
      persisted = await persistCanonicalCollectionGroupsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, generationRunId: run.id, generationRunSourceScheduleRevision: run.sourceScheduleRevision, sourceScheduleRevision: nextRevision, doublePayDates: input.doublePayDates, idempotencyKey: input.idempotencyKey, reason: input.reason });
    } catch (error) {
      if (error instanceof CanonicalCollectionGroupingError) throw new CanonicalLeagueScheduleEditError("invalid_edit", error.message);
      throw error;
    }
    return { mode: "applied", scheduleRevision: nextRevision, doublePayDates: input.doublePayDates, collectionGroups: persisted.groups, commandId: command.command.id, writesPerformed: true, league: updatedLeague };
  });
}
