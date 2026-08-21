import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  canonicalCollectionGroupMemberRevisions,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroups,
} from "@shared/schema";
import {
  canonicalCollectionGroupFingerprint as fingerprintForPair,
  CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
  CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION,
  CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION,
} from "@shared/canonical-collection-groups";
import {
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
} from "@shared/schema/canonical-occurrences";
import { leagues } from "@shared/schema";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  assertCanonicalScheduleTenantAndActor,
  buildCanonicalScheduleCommandFingerprint,
  getOrCreateCanonicalScheduleCommandInTransaction,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";

export interface ExplicitCanonicalCollectionGroupRepairPair {
  triggerOccurrenceId: string;
  pairedOccurrenceId: string;
  triggerLocalDate: string;
  pairedLocalDate: string;
}

export interface CanonicalCollectionGroupRepairInput {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  generationRunId: string;
  sourceScheduleRevision: number;
  idempotencyKey: string;
  reason: string;
  pairs: readonly ExplicitCanonicalCollectionGroupRepairPair[];
}

export interface CanonicalCollectionGroupRepairResult {
  mode: "applied" | "idempotent_retry";
  groupIds: string[];
  commandIds: string[];
  writesPerformed: boolean;
}

/**
 * Narrow administrative repair for a known historical league. Every pair and
 * date is supplied explicitly; this service never searches for candidates or
 * rewrites occurrence, term, obligation, allocation, plan, or provider rows.
 */
export async function repairCanonicalCollectionGroups(
  input: CanonicalCollectionGroupRepairInput,
): Promise<CanonicalCollectionGroupRepairResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [league] = await tx.select().from(leagues).where(and(
      eq(leagues.id, input.leagueId),
      eq(leagues.organizationId, input.organizationId),
    )).for("update");
    if (!league) throw new Error("repair league is outside the requested tenant");
    await assertCanonicalScheduleTenantAndActor(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: "repair_collection_group",
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: "lvcanoncmd:v1:" + "0".repeat(64),
      reason: input.reason,
    });
    if (!input.reason || input.reason.trim() !== input.reason) throw new Error("repair reason must be nonempty and trimmed");
    if (input.pairs.length === 0 || input.pairs.length > 2) throw new Error("repair requires one or two explicit pairs");
    if (!Number.isSafeInteger(input.sourceScheduleRevision) || input.sourceScheduleRevision <= 0) throw new Error("repair source schedule revision is invalid");
    const currentRuns = await tx.select().from(leagueOccurrenceGenerationRuns).where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, input.organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, input.leagueId),
      inArray(leagueOccurrenceGenerationRuns.state, ["approved", "applied"]),
    )).orderBy(desc(leagueOccurrenceGenerationRuns.sourceScheduleRevision), desc(leagueOccurrenceGenerationRuns.id)).limit(2).for("update");
    if (currentRuns.length !== 1) {
      throw new Error("repair requires exactly one current approved/applied operational run");
    }
    const [run] = currentRuns;
    if (!run || run.id !== input.generationRunId || run.sourceScheduleRevision !== input.sourceScheduleRevision) {
      throw new Error("repair generation run is not the current operational tenant run");
    }
    if (league.canonicalScheduleRevision !== 0 && league.canonicalScheduleRevision !== input.sourceScheduleRevision) {
      throw new Error("repair canonical schedule revision conflicts with the current league revision");
    }
    const configuredTriggerDates = [...league.doublePayDates].sort();
    if (configuredTriggerDates.length !== input.pairs.length) {
      throw new Error("repair pair count does not exactly match configured double-pay triggers");
    }
    const pairRows = [...input.pairs].sort((left, right) => left.triggerLocalDate.localeCompare(right.triggerLocalDate) || left.triggerOccurrenceId.localeCompare(right.triggerOccurrenceId));
    if (input.pairs.some((pair, index) => {
      const ordered = pairRows[index];
      return !ordered || pair.triggerOccurrenceId !== ordered.triggerOccurrenceId
        || pair.pairedOccurrenceId !== ordered.pairedOccurrenceId
        || pair.triggerLocalDate !== ordered.triggerLocalDate
        || pair.pairedLocalDate !== ordered.pairedLocalDate;
    })) {
      throw new Error("repair pairs must be supplied in deterministic chronological order");
    }
    if (pairRows.some((pair, index) => pair.triggerLocalDate !== configuredTriggerDates[index])) {
      throw new Error("repair trigger dates do not exactly match configured double-pay order");
    }
    const occurrenceIds = pairRows.flatMap((pair) => [pair.triggerOccurrenceId, pair.pairedOccurrenceId]);
    if (new Set(occurrenceIds).size !== occurrenceIds.length) throw new Error("repair pairs must not reuse an occurrence");
    const occurrences = await tx.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      eq(leagueOccurrences.generationRunId, input.generationRunId),
      inArray(leagueOccurrences.id, occurrenceIds),
    )).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(leagueOccurrences.id)).for("update");
    if (occurrences.length !== occurrenceIds.length) throw new Error("repair pair occurrence UUID is missing or outside the selected run");
    const terms = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
      inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
      eq(leagueOccurrenceBillingTerms.state, "published"),
    )).orderBy(asc(leagueOccurrenceBillingTerms.occurrenceId), asc(leagueOccurrenceBillingTerms.id)).for("update");
    const occurrenceById = new Map(occurrences.map((row) => [row.id, row]));
    const termByOccurrence = new Map(terms.map((row) => [row.occurrenceId, row]));
    const groupIds: string[] = [];
    const commandIds: string[] = [];
    let writesPerformed = false;
    const currentGroups = await tx.select().from(canonicalCollectionGroups).where(and(
      eq(canonicalCollectionGroups.organizationId, input.organizationId),
      eq(canonicalCollectionGroups.leagueId, input.leagueId),
      eq(canonicalCollectionGroups.generationRunId, input.generationRunId),
      eq(canonicalCollectionGroups.state, "published"),
    )).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id)).for("update");
    if (currentGroups.length > pairRows.length || currentGroups.some((group) => group.groupOrdinal < 1 || group.groupOrdinal > pairRows.length)) {
      throw new Error("repair found conflicting published collection-group evidence");
    }
    for (const [index, pair] of pairRows.entries()) {
      const trigger = occurrenceById.get(pair.triggerOccurrenceId);
      const paired = occurrenceById.get(pair.pairedOccurrenceId);
      const triggerTerm = termByOccurrence.get(pair.triggerOccurrenceId);
      const pairedTerm = termByOccurrence.get(pair.pairedOccurrenceId);
      if (!trigger || !paired || !triggerTerm || !pairedTerm
        || trigger.authoritativeLocalDate !== pair.triggerLocalDate
        || paired.authoritativeLocalDate !== pair.pairedLocalDate
        || pair.triggerLocalDate >= pair.pairedLocalDate
        || trigger.status !== "scheduled" || paired.status !== "scheduled"
        || !["published", "locked"].includes(trigger.lifecycle) || !["published", "locked"].includes(paired.lifecycle)
        || triggerTerm.obligationPolicy !== "eligible_bowlers" || pairedTerm.obligationPolicy !== "eligible_bowlers"
        || triggerTerm.billingOrdinal === null || pairedTerm.billingOrdinal === null
        || triggerTerm.defaultAmountMinor <= 0 || pairedTerm.defaultAmountMinor <= 0
        || triggerTerm.currency !== pairedTerm.currency) {
        throw new Error("repair pair failed explicit date, lifecycle, status, or billable-term preconditions");
      }
      const memberEvidence = {
        trigger: { occurrenceId: trigger.id, billingTermId: triggerTerm.id, role: "trigger" as const, memberOrdinal: 1 as const, localDate: pair.triggerLocalDate, billingOrdinal: triggerTerm.billingOrdinal, amountMinor: triggerTerm.defaultAmountMinor, currency: triggerTerm.currency },
        paired: { occurrenceId: paired.id, billingTermId: pairedTerm.id, role: "paired" as const, memberOrdinal: 2 as const, localDate: pair.pairedLocalDate, billingOrdinal: pairedTerm.billingOrdinal, amountMinor: pairedTerm.defaultAmountMinor, currency: pairedTerm.currency },
      };
      const fingerprint = fingerprintForPair({ groupOrdinal: index + 1, generationRunId: input.generationRunId, sourceScheduleRevision: input.sourceScheduleRevision, trigger: memberEvidence.trigger, paired: memberEvidence.paired });
      const commandInput: MaterializationScheduleCommandRequest = {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        actorUserId: input.actorUserId,
        commandType: "repair_collection_group",
        idempotencyKey: `${input.idempotencyKey}:pair:${index + 1}`,
        requestFingerprint: "",
        reason: input.reason,
        materializationOperation: "canonical_collection_grouping",
        materializationPayload: { contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION, action: "repair", generationRunId: input.generationRunId, sourceScheduleRevision: input.sourceScheduleRevision, groupOrdinal: index + 1, triggerOccurrenceId: trigger.id, pairedOccurrenceId: paired.id, fingerprint },
      };
      commandInput.requestFingerprint = buildCanonicalScheduleCommandFingerprint(commandInput);
      const command = await getOrCreateCanonicalScheduleCommandInTransaction(tx, commandInput, ["repair_collection_group"]);
      commandIds.push(command.command.id);
      const [existing] = await tx.select().from(canonicalCollectionGroups).where(and(
        eq(canonicalCollectionGroups.organizationId, input.organizationId),
        eq(canonicalCollectionGroups.leagueId, input.leagueId),
        eq(canonicalCollectionGroups.generationRunId, input.generationRunId),
        eq(canonicalCollectionGroups.groupOrdinal, index + 1),
      )).for("update");
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.publicationCommandId !== command.command.id || existing.state !== "published") throw new Error("repair idempotency evidence conflicts");
        const existingMembers = await tx.select().from(canonicalCollectionGroupMembers).where(and(
          eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
          eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
          eq(canonicalCollectionGroupMembers.groupId, existing.id),
        )).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal), asc(canonicalCollectionGroupMembers.id)).for("update");
        if (existingMembers.length !== 2 || existingMembers.some((member) => !member.active || member.currentRevision !== 1)
          || existingMembers[0]?.occurrenceId !== trigger.id
          || existingMembers[0]?.billingTermId !== triggerTerm.id
          || existingMembers[0]?.role !== "trigger"
          || existingMembers[0]?.memberOrdinal !== 1
          || existingMembers[0]?.localDate !== pair.triggerLocalDate
          || existingMembers[0]?.billingOrdinal !== triggerTerm.billingOrdinal
          || existingMembers[0]?.amountMinor !== triggerTerm.defaultAmountMinor
          || existingMembers[0]?.currency !== triggerTerm.currency
          || existingMembers[1]?.occurrenceId !== paired.id
          || existingMembers[1]?.billingTermId !== pairedTerm.id
          || existingMembers[1]?.role !== "paired"
          || existingMembers[1]?.memberOrdinal !== 2
          || existingMembers[1]?.localDate !== pair.pairedLocalDate
          || existingMembers[1]?.billingOrdinal !== pairedTerm.billingOrdinal
          || existingMembers[1]?.amountMinor !== pairedTerm.defaultAmountMinor
          || existingMembers[1]?.currency !== pairedTerm.currency) {
          throw new Error("repair retry evidence has incomplete or conflicting group membership");
        }
        const [groupRevision] = await tx.select({ revisionNumber: canonicalCollectionGroupRevisions.revisionNumber })
          .from(canonicalCollectionGroupRevisions).where(and(
            eq(canonicalCollectionGroupRevisions.organizationId, input.organizationId),
            eq(canonicalCollectionGroupRevisions.leagueId, input.leagueId),
            eq(canonicalCollectionGroupRevisions.groupId, existing.id),
            eq(canonicalCollectionGroupRevisions.revisionNumber, existing.currentRevision),
          )).limit(1);
        const memberRevisionRows = await tx.select({ memberId: canonicalCollectionGroupMemberRevisions.memberId, revisionNumber: canonicalCollectionGroupMemberRevisions.revisionNumber })
          .from(canonicalCollectionGroupMemberRevisions).where(and(
            eq(canonicalCollectionGroupMemberRevisions.organizationId, input.organizationId),
            eq(canonicalCollectionGroupMemberRevisions.leagueId, input.leagueId),
            inArray(canonicalCollectionGroupMemberRevisions.memberId, existingMembers.map((member) => member.id)),
          ));
        if (!groupRevision || memberRevisionRows.length !== 2 || memberRevisionRows.some((revision) => revision.revisionNumber !== 1)) {
          throw new Error("repair retry evidence is missing complete group revisions");
        }
        groupIds.push(existing.id);
        continue;
      }
      const [group] = await tx.insert(canonicalCollectionGroups).values({
        organizationId: input.organizationId, leagueId: input.leagueId, generationRunId: input.generationRunId, sourceScheduleRevision: input.sourceScheduleRevision, kind: "double_pay", state: "published", groupOrdinal: index + 1, triggerLocalDate: pair.triggerLocalDate, pairedLocalDate: pair.pairedLocalDate, contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION, fingerprintVersion: CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION, fingerprint, currentRevision: 1, lastCommandId: command.command.id, publishedAt: command.command.createdAt, publishedByUserId: input.actorUserId, publicationCommandId: command.command.id,
      }).returning();
      if (!group) throw new Error("repair group insert failed");
      const [triggerMember, pairedMember] = await tx.insert(canonicalCollectionGroupMembers).values([
        { organizationId: input.organizationId, leagueId: input.leagueId, groupId: group.id, generationRunId: input.generationRunId, occurrenceId: trigger.id, billingTermId: triggerTerm.id, role: "trigger", memberOrdinal: 1, localDate: pair.triggerLocalDate, billingOrdinal: triggerTerm.billingOrdinal, amountMinor: triggerTerm.defaultAmountMinor, currency: triggerTerm.currency, active: true, currentRevision: 1, lastCommandId: command.command.id },
        { organizationId: input.organizationId, leagueId: input.leagueId, groupId: group.id, generationRunId: input.generationRunId, occurrenceId: paired.id, billingTermId: pairedTerm.id, role: "paired", memberOrdinal: 2, localDate: pair.pairedLocalDate, billingOrdinal: pairedTerm.billingOrdinal, amountMinor: pairedTerm.defaultAmountMinor, currency: pairedTerm.currency, active: true, currentRevision: 1, lastCommandId: command.command.id },
      ]).returning();
      if (!triggerMember || !pairedMember) throw new Error("repair group membership insert failed");
      await tx.insert(canonicalCollectionGroupRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, groupId: group.id, commandId: command.command.id, revisionNumber: 1, snapshotSchemaVersion: CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION, beforeSnapshot: null, afterSnapshot: group });
      await tx.insert(canonicalCollectionGroupMemberRevisions).values([triggerMember, pairedMember].map((member) => ({ organizationId: input.organizationId, leagueId: input.leagueId, memberId: member.id, commandId: command.command.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: member })));
      groupIds.push(group.id);
      writesPerformed = true;
    }
    if (league.canonicalScheduleRevision === 0) {
      const [initialized] = await tx.update(leagues).set({ canonicalScheduleRevision: input.sourceScheduleRevision }).where(and(
        eq(leagues.id, input.leagueId),
        eq(leagues.organizationId, input.organizationId),
        eq(leagues.canonicalScheduleRevision, 0),
      )).returning({ canonicalScheduleRevision: leagues.canonicalScheduleRevision });
      if (!initialized) throw new Error("repair canonical schedule revision initialization raced");
      writesPerformed = true;
    }
    return { mode: writesPerformed ? "applied" : "idempotent_retry", groupIds, commandIds, writesPerformed };
  });
}
