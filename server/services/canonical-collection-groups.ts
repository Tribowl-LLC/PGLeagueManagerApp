import { and, asc, eq } from "drizzle-orm";
import {
  canonicalCollectionGroupMemberRevisions,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroupRevisions,
  canonicalCollectionGroups,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  type CanonicalCollectionGroup,
  type CanonicalCollectionGroupMember,
} from "@shared/schema";
import {
  CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
  CANONICAL_COLLECTION_GROUP_FINGERPRINT_PREFIX,
  CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION,
  CANONICAL_COLLECTION_GROUP_MEMBER_REVISION_SNAPSHOT_VERSION,
  CANONICAL_COLLECTION_GROUP_RESULT_VERSION,
  CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION,
  canonicalCollectionGroupFingerprint,
  deriveCanonicalCollectionPairs,
  type CanonicalCollectionGroupEvidence,
  type CanonicalCollectionGroupMemberEvidence,
} from "@shared/canonical-collection-groups";
import { buildCanonicalScheduleCommandFingerprint, getOrCreateCanonicalScheduleCommandInTransaction, type MaterializationScheduleCommandRequest } from "./canonical-occurrence-transactions.js";
import type { LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";

export interface PersistCanonicalCollectionGroupsInput {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  generationRunId: string;
  generationRunSourceScheduleRevision?: number;
  sourceScheduleRevision: number;
  doublePayDates: readonly string[];
  idempotencyKey: string;
  reason: string;
}

export interface PersistCanonicalCollectionGroupsResult {
  groups: CanonicalCollectionGroupEvidence[];
  groupIds: string[];
  memberIds: string[];
  revisionIds: string[];
  commandIds: string[];
  writesPerformed: boolean;
}

function snapshotGroup(row: CanonicalCollectionGroup): Record<string, unknown> {
  return {
    contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    generationRunId: row.generationRunId,
    sourceScheduleRevision: row.sourceScheduleRevision,
    kind: row.kind,
    state: row.state,
    groupOrdinal: row.groupOrdinal,
    triggerLocalDate: row.triggerLocalDate,
    pairedLocalDate: row.pairedLocalDate,
    contractVersionStored: row.contractVersion,
    fingerprintVersion: row.fingerprintVersion,
    fingerprint: row.fingerprint,
    currentRevision: row.currentRevision,
    lastCommandId: row.lastCommandId,
    publishedAt: row.publishedAt,
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
    revocationCommandId: row.revocationCommandId,
  };
}

function snapshotMember(row: CanonicalCollectionGroupMember): Record<string, unknown> {
  return {
    contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    groupId: row.groupId,
    generationRunId: row.generationRunId,
    occurrenceId: row.occurrenceId,
    billingTermId: row.billingTermId,
    role: row.role,
    memberOrdinal: row.memberOrdinal,
    localDate: row.localDate,
    billingOrdinal: row.billingOrdinal,
    amountMinor: row.amountMinor,
    currency: row.currency,
    active: row.active,
    currentRevision: row.currentRevision,
    lastCommandId: row.lastCommandId,
  };
}

function memberEvidence(input: CanonicalCollectionGroupMemberEvidence): CanonicalCollectionGroupMemberEvidence {
  return { ...input };
}

function commandRequest(input: PersistCanonicalCollectionGroupsInput, groupOrdinal: number, pairFingerprint: string): MaterializationScheduleCommandRequest {
  const request: MaterializationScheduleCommandRequest = {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: "publish_collection_group",
    idempotencyKey: `${input.idempotencyKey}:collection-group:${groupOrdinal}`,
    requestFingerprint: "",
    reason: input.reason,
    materializationOperation: "canonical_collection_grouping",
    materializationPayload: {
      contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
      fingerprintVersion: CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION,
      generationRunId: input.generationRunId,
      sourceScheduleRevision: input.sourceScheduleRevision,
      groupOrdinal,
      pairFingerprint,
    },
  };
  return { ...request, requestFingerprint: buildCanonicalScheduleCommandFingerprint(request) };
}

function resultEvidence(
  group: CanonicalCollectionGroup,
  members: CanonicalCollectionGroupMember[],
): CanonicalCollectionGroupEvidence {
  const trigger = members.find((member) => member.role === "trigger");
  const paired = members.find((member) => member.role === "paired");
  if (!trigger || !paired) throw new Error("canonical collection group is missing one role");
  return {
    contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
    resultVersion: CANONICAL_COLLECTION_GROUP_RESULT_VERSION,
    fingerprintVersion: CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION,
    fingerprint: group.fingerprint,
    groupOrdinal: group.groupOrdinal,
    kind: "double_pay",
    state: group.state === "revoked" ? "revoked" : "published",
    generationRunId: group.generationRunId,
    sourceScheduleRevision: group.sourceScheduleRevision,
    triggerLocalDate: group.triggerLocalDate,
    pairedLocalDate: group.pairedLocalDate,
    members: [memberEvidence({ occurrenceId: trigger.occurrenceId, billingTermId: trigger.billingTermId, role: "trigger", memberOrdinal: 1, localDate: trigger.localDate, billingOrdinal: trigger.billingOrdinal, amountMinor: trigger.amountMinor, currency: trigger.currency }), memberEvidence({ occurrenceId: paired.occurrenceId, billingTermId: paired.billingTermId, role: "paired", memberOrdinal: 2, localDate: paired.localDate, billingOrdinal: paired.billingOrdinal, amountMinor: paired.amountMinor, currency: paired.currency })],
  };
}

/** Read the currently published groups without deriving or mutating evidence. */
export async function readCanonicalCollectionGroupsInTransaction(
  tx: LeagueScheduleTransaction,
  input: { organizationId: number; leagueId: number; generationRunId: string },
): Promise<CanonicalCollectionGroupEvidence[]> {
  const groups = await tx.select().from(canonicalCollectionGroups).where(and(
    eq(canonicalCollectionGroups.organizationId, input.organizationId),
    eq(canonicalCollectionGroups.leagueId, input.leagueId),
    eq(canonicalCollectionGroups.generationRunId, input.generationRunId),
    eq(canonicalCollectionGroups.state, "published"),
  )).orderBy(asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id)).for("update");
  const result: CanonicalCollectionGroupEvidence[] = [];
  for (const group of groups) {
    const members = await tx.select().from(canonicalCollectionGroupMembers).where(and(
      eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
      eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
      eq(canonicalCollectionGroupMembers.groupId, group.id),
      eq(canonicalCollectionGroupMembers.active, true),
    )).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal), asc(canonicalCollectionGroupMembers.id)).for("update");
    if (members.length !== 2) throw new Error("published canonical collection group membership is incomplete");
    result.push(resultEvidence(group, members));
  }
  return result;
}

/** Insert immutable pair evidence after canonical rows have been published. */
export async function persistCanonicalCollectionGroupsInTransaction(
  tx: LeagueScheduleTransaction,
  input: PersistCanonicalCollectionGroupsInput,
): Promise<PersistCanonicalCollectionGroupsResult> {
  const [run] = await tx.select().from(leagueOccurrenceGenerationRuns).where(and(
    eq(leagueOccurrenceGenerationRuns.id, input.generationRunId),
    eq(leagueOccurrenceGenerationRuns.organizationId, input.organizationId),
    eq(leagueOccurrenceGenerationRuns.leagueId, input.leagueId),
  )).for("update");
  if (!run || run.sourceScheduleRevision !== (input.generationRunSourceScheduleRevision ?? input.sourceScheduleRevision)) throw new Error("canonical collection grouping run scope is invalid");
  const occurrences = await tx.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
    eq(leagueOccurrences.generationRunId, input.generationRunId),
  )).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(leagueOccurrences.id)).for("update");
  const terms = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
  )).orderBy(asc(leagueOccurrenceBillingTerms.billingOrdinal), asc(leagueOccurrenceBillingTerms.id)).for("update");
  const pairings = deriveCanonicalCollectionPairs({
    doublePayDates: input.doublePayDates,
    occurrences: occurrences.map((occurrence) => ({
      occurrenceId: occurrence.id,
      localDate: occurrence.authoritativeLocalDate,
      status: occurrence.status,
      lifecycle: occurrence.lifecycle,
      billingTerm: (() => {
        const term = terms.find((candidate) => candidate.occurrenceId === occurrence.id && candidate.state !== "superseded");
        return term ? { id: term.id, obligationPolicy: term.obligationPolicy, billingOrdinal: term.billingOrdinal, amountMinor: term.defaultAmountMinor, currency: term.currency } : null;
      })(),
    })),
  });
  const groups: CanonicalCollectionGroupEvidence[] = [];
  const groupIds: string[] = [];
  const memberIds: string[] = [];
  const revisionIds: string[] = [];
  const commandIds: string[] = [];
  let writesPerformed = false;
  for (const pairing of pairings) {
    if (pairing.paired.localDate <= pairing.trigger.localDate) throw new Error("double-pay trigger must precede its final-season paired occurrence");
    const fingerprint = canonicalCollectionGroupFingerprint({
      groupOrdinal: pairing.groupOrdinal,
      generationRunId: input.generationRunId,
      sourceScheduleRevision: input.sourceScheduleRevision,
      trigger: pairing.trigger,
      paired: pairing.paired,
    });
    if (!fingerprint.startsWith(CANONICAL_COLLECTION_GROUP_FINGERPRINT_PREFIX)) throw new Error("invalid canonical collection group fingerprint");
    const commandInput = commandRequest(input, pairing.groupOrdinal, fingerprint);
    const commandResult = await getOrCreateCanonicalScheduleCommandInTransaction(tx, commandInput, ["publish_collection_group"]);
    commandIds.push(commandResult.command.id);
    const [existing] = await tx.select().from(canonicalCollectionGroups).where(and(
      eq(canonicalCollectionGroups.organizationId, input.organizationId),
      eq(canonicalCollectionGroups.leagueId, input.leagueId),
      eq(canonicalCollectionGroups.generationRunId, input.generationRunId),
      eq(canonicalCollectionGroups.groupOrdinal, pairing.groupOrdinal),
      eq(canonicalCollectionGroups.state, "published"),
    )).for("update");
    if (commandResult.existing && !existing) throw new Error("collection group command exists without group evidence");
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.publicationCommandId !== commandResult.command.id) throw new Error("collection group idempotency evidence conflicts");
      const existingMembers = await tx.select().from(canonicalCollectionGroupMembers).where(and(
        eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
        eq(canonicalCollectionGroupMembers.groupId, existing.id),
      )).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal)).for("update");
      if (existingMembers.length !== 2) throw new Error("collection group membership evidence is incomplete");
      groups.push(resultEvidence(existing, existingMembers));
      groupIds.push(existing.id);
      memberIds.push(...existingMembers.map((member) => member.id));
      continue;
    }
    const [group] = await tx.insert(canonicalCollectionGroups).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      generationRunId: input.generationRunId,
      sourceScheduleRevision: input.sourceScheduleRevision,
      kind: "double_pay",
      state: "published",
      groupOrdinal: pairing.groupOrdinal,
      triggerLocalDate: pairing.trigger.localDate,
      pairedLocalDate: pairing.paired.localDate,
      contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
      fingerprintVersion: CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION,
      fingerprint,
      currentRevision: 1,
      lastCommandId: commandResult.command.id,
      publishedAt: commandResult.command.createdAt,
      publishedByUserId: input.actorUserId,
      publicationCommandId: commandResult.command.id,
    }).returning();
    if (!group) throw new Error("canonical collection group was not created");
    const members: CanonicalCollectionGroupMember[] = [];
    for (const member of [pairing.trigger, pairing.paired]) {
      const [row] = await tx.insert(canonicalCollectionGroupMembers).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        groupId: group.id,
        generationRunId: input.generationRunId,
        occurrenceId: member.occurrenceId,
        billingTermId: member.billingTermId,
        role: member.role,
        memberOrdinal: member.memberOrdinal,
        localDate: member.localDate,
        billingOrdinal: member.billingOrdinal,
        amountMinor: member.amountMinor,
        currency: member.currency,
        currentRevision: 1,
        lastCommandId: commandResult.command.id,
      }).returning();
      if (!row) throw new Error("canonical collection group member was not created");
      members.push(row);
      const [revision] = await tx.insert(canonicalCollectionGroupMemberRevisions).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        memberId: row.id,
        commandId: commandResult.command.id,
        revisionNumber: 1,
        snapshotSchemaVersion: CANONICAL_COLLECTION_GROUP_MEMBER_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null,
        afterSnapshot: snapshotMember(row),
      }).returning({ id: canonicalCollectionGroupMemberRevisions.id });
      if (!revision) throw new Error("canonical collection group member revision was not created");
      revisionIds.push(revision.id);
    }
    const [groupRevision] = await tx.insert(canonicalCollectionGroupRevisions).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      groupId: group.id,
      commandId: commandResult.command.id,
      revisionNumber: 1,
      snapshotSchemaVersion: CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION,
      beforeSnapshot: null,
      afterSnapshot: snapshotGroup(group),
    }).returning({ id: canonicalCollectionGroupRevisions.id });
    if (!groupRevision) throw new Error("canonical collection group revision was not created");
    revisionIds.push(groupRevision.id);
    groups.push(resultEvidence(group, members));
    groupIds.push(group.id);
    memberIds.push(...members.map((member) => member.id));
    writesPerformed = true;
  }
  return { groups, groupIds, memberIds, revisionIds, commandIds, writesPerformed };
}
