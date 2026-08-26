import { and, asc, eq, sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrences,
  leagueScheduleExceptions,
  type LeagueOccurrence,
  type LeagueOccurrenceBillingTerm,
  type LeagueOccurrenceGenerationRun,
  type LeagueOccurrenceRelationship,
  type LeagueScheduleException,
} from "@shared/schema/canonical-occurrences";
import {
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  type CanonicalCollectionGroup,
  type CanonicalCollectionGroupMember,
} from "@shared/schema/canonical-collection-groups";
import { leagues, type League } from "@shared/schema/leagues";
import {
  LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
  LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION,
  type LeagueOccurrenceEffectiveLockReason,
  type LeagueOccurrenceScheduleAdministratorEvidence,
  type LeagueOccurrenceScheduleOccurrence,
  type LeagueOccurrenceScheduleReadContract,
  type LeagueOccurrenceScheduleRelationship,
  type LeagueOccurrenceScheduleSkippedDate,
  type LeagueOccurrenceScheduleCollectionGroup,
} from "@shared/league-occurrence-schedule";
import { getProductSeasonFromDateOnly } from "@shared/season-utils";
import { db } from "../db.js";
import { hasLeagueOccurrenceEvidence } from "../storage/canonical-occurrence-evidence.js";
import type { LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";

export const LEAGUE_OCCURRENCE_SCHEDULE_IMPLEMENTATION_VERSION = "league-occurrence-schedule-read/1" as const;

export type LeagueOccurrenceScheduleErrorCode =
  | "invalid_scope"
  | "league_not_found"
  | "incompatible_canonical_state";

export class LeagueOccurrenceScheduleError extends Error {
  constructor(public readonly code: LeagueOccurrenceScheduleErrorCode, message: string) {
    super(message);
    this.name = "LeagueOccurrenceScheduleError";
  }
}

type ScheduleLeague = Pick<
  League,
  | "id"
  | "organizationId"
  | "active"
  | "seasonStart"
  | "seasonEnd"
  | "weekDay"
  | "competitionStartTime"
  | "timezone"
  | "totalBowlingWeeks"
>;

export interface LeagueOccurrenceScheduleCanonicalRows {
  generationRuns: LeagueOccurrenceGenerationRun[];
  occurrences: LeagueOccurrence[];
  billingTerms: LeagueOccurrenceBillingTerm[];
  scheduleExceptions: LeagueScheduleException[];
  relationships: LeagueOccurrenceRelationship[];
  linkedActivityOccurrenceIds: ReadonlySet<string>;
  collectionGroups?: CanonicalCollectionGroup[];
  collectionGroupMembers?: CanonicalCollectionGroupMember[];
  hasAnyCanonicalEvidence: boolean;
}

export interface BuildLeagueOccurrenceScheduleInput {
  organizationId: number;
  leagueId: number;
  league: ScheduleLeague;
  canonical: LeagueOccurrenceScheduleCanonicalRows;
  includeAdministratorEvidence: boolean;
  databaseNow: string;
}

const ORDERING_KEYS = [
  "authoritativeLocalDate",
  "authoritativeLocalStartTime",
  "plannedOrdinal",
  "competitionNumber",
  "kind",
  "stableIdentity",
] as const;

const KIND_ORDER = new Map([
  ["regular", 0],
  ["makeup", 1],
  ["position_round", 2],
  ["rolloff", 3],
  ["playoff", 4],
  ["extension", 5],
]);

const AUDITED_POST_SET_KINDS = new Set<LeagueOccurrence["kind"]>([
  "makeup",
  "position_round",
  "rolloff",
  "playoff",
  "extension",
]);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

export function compareLeagueScheduleOccurrences(
  left: LeagueOccurrenceScheduleOccurrence,
  right: LeagueOccurrenceScheduleOccurrence,
): number {
  return compareStrings(left.authoritativeLocalDate, right.authoritativeLocalDate)
    || compareStrings(left.authoritativeLocalStartTime ?? "", right.authoritativeLocalStartTime ?? "")
    || compareNullableNumbers(left.plannedOrdinal, right.plannedOrdinal)
    || compareNullableNumbers(left.competitionNumber, right.competitionNumber)
    || ((KIND_ORDER.get(left.kind) ?? 99) - (KIND_ORDER.get(right.kind) ?? 99))
    || compareStrings(left.occurrenceId, right.occurrenceId);
}

function dateOnly(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeUtcInstant(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", `${field} is not a valid UTC instant`);
  }
  return parsed.toISOString();
}

function assertScope(input: BuildLeagueOccurrenceScheduleInput): void {
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId <= 0
    || !Number.isSafeInteger(input.leagueId) || input.leagueId <= 0) {
    throw new LeagueOccurrenceScheduleError("invalid_scope", "organizationId and leagueId must be positive safe integers");
  }
  if (input.league.id !== input.leagueId || input.league.organizationId !== input.organizationId) {
    throw new LeagueOccurrenceScheduleError("league_not_found", "league was not found in the authorized organization");
  }
  for (const row of [
    ...input.canonical.generationRuns,
    ...input.canonical.occurrences,
    ...input.canonical.billingTerms,
    ...input.canonical.scheduleExceptions,
    ...input.canonical.relationships,
    ...(input.canonical.collectionGroups ?? []),
    ...(input.canonical.collectionGroupMembers ?? []),
  ]) {
    if (row.organizationId !== input.organizationId || row.leagueId !== input.leagueId) {
      throw new LeagueOccurrenceScheduleError(
        "incompatible_canonical_state",
        "canonical schedule evidence is outside the authorized tenant or league",
      );
    }
  }
}

function isFallDraftSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = (value as { snapshotContractVersion?: unknown }).snapshotContractVersion;
  return typeof version === "string" && /^fall-draft-generation-input-snapshot\/\d+$/.test(version);
}

function isFutureSeasonDraftSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { snapshotContractVersion?: unknown }).snapshotContractVersion
    === "future-season-draft-generation-input-snapshot/1";
}

function administratorEvidence(
  input: BuildLeagueOccurrenceScheduleInput,
): LeagueOccurrenceScheduleAdministratorEvidence | null {
  if (!input.includeAdministratorEvidence) return null;
  const { canonical } = input;
  const start = dateOnly(input.league.seasonStart);
  const c2Runs = canonical.generationRuns.filter((row) => isFallDraftSnapshot(row.normalizedInputSnapshot));
  const e4Runs = canonical.generationRuns.filter((row) => isFutureSeasonDraftSnapshot(row.normalizedInputSnapshot));
  // C2 controls are exposed only while an auditable draft is awaiting a
  // decision. Automatic v3 setup publishes inside its setup transaction and
  // therefore deliberately has no review panel, even though the retained
  // approval/publication commands remain available to recovery tooling.
  const reviewContractFamily = c2Runs.length === 1 && e4Runs.length === 0
    ? "fall" as const
    : e4Runs.length === 1 && c2Runs.length === 0 && e4Runs[0]?.state === "generated"
      ? "canonical" as const
      : null;
  return {
    hasDraftEvidence: canonical.generationRuns.some((row) => row.state === "generated")
      || canonical.occurrences.some((row) => row.lifecycle === "draft" && row.status !== "discarded")
      || canonical.scheduleExceptions.some((row) => row.lifecycle === "draft")
      || canonical.relationships.some((row) => row.state === "draft")
      || canonical.billingTerms.some((row) => row.state === "draft"),
    hasRejectedEvidence: canonical.generationRuns.some((row) => row.state === "rejected"),
    hasSupersededEvidence: canonical.generationRuns.some((row) => row.state === "superseded")
      || canonical.billingTerms.some((row) => row.state === "superseded"),
    hasRevokedEvidence: canonical.scheduleExceptions.some((row) => row.lifecycle === "revoked")
      || canonical.relationships.some((row) => row.state === "revoked")
      || (canonical.collectionGroups ?? []).some((row) => row.state === "revoked"),
    c2ReviewAvailable: reviewContractFamily !== null,
    reviewContractFamily,
    fallRecoveryEligible: !canonical.hasAnyCanonicalEvidence
      && input.league.active
      && start !== null
      && getProductSeasonFromDateOnly(start) === "Fall",
    counts: {
      generationRuns: canonical.generationRuns.length,
      draftOccurrences: canonical.occurrences.filter((row) => row.lifecycle === "draft" && row.status !== "discarded").length,
      discardedOccurrences: canonical.occurrences.filter((row) => row.status === "discarded").length,
      draftExceptions: canonical.scheduleExceptions.filter((row) => row.lifecycle === "draft").length,
      revokedExceptions: canonical.scheduleExceptions.filter((row) => row.lifecycle === "revoked").length,
      draftRelationships: canonical.relationships.filter((row) => row.state === "draft").length,
      revokedRelationships: canonical.relationships.filter((row) => row.state === "revoked").length,
      supersededBillingTerms: canonical.billingTerms.filter((row) => row.state === "superseded").length,
    },
  };
}

function scheduleBase(input: BuildLeagueOccurrenceScheduleInput) {
  return {
    contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
    ordering: { version: LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION, keys: ORDERING_KEYS },
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    administrator: administratorEvidence(input),
  } as const;
}

function relationshipEvidence(
  occurrenceId: string,
  relationships: LeagueOccurrenceRelationship[],
): LeagueOccurrenceScheduleRelationship[] {
  const result: LeagueOccurrenceScheduleRelationship[] = [];
  for (const relationship of relationships) {
    if (relationship.sourceOccurrenceId === occurrenceId) {
      result.push({
        relationshipId: relationship.id,
        kind: relationship.kind,
        role: "source",
        relatedOccurrenceId: relationship.targetOccurrenceId,
        currentRevision: relationship.currentRevision,
      });
    } else if (relationship.targetOccurrenceId === occurrenceId) {
      result.push({
        relationshipId: relationship.id,
        kind: relationship.kind,
        role: "target",
        relatedOccurrenceId: relationship.sourceOccurrenceId,
        currentRevision: relationship.currentRevision,
      });
    }
  }
  return result.sort((left, right) => compareStrings(left.relationshipId, right.relationshipId));
}

function collectionGroupEvidence(
  occurrenceId: string,
  groups: CanonicalCollectionGroup[],
  members: CanonicalCollectionGroupMember[],
): LeagueOccurrenceScheduleCollectionGroup[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  return members
    .filter((member) => member.occurrenceId === occurrenceId)
    .map((member) => {
      const group = groupById.get(member.groupId);
      const paired = members.find((candidate) => candidate.groupId === member.groupId && candidate.occurrenceId !== occurrenceId);
      if (!group || !paired) throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "a collection group member is incomplete");
      return {
        groupId: group.id,
        groupOrdinal: group.groupOrdinal,
        kind: group.kind,
        role: member.role,
        pairedOccurrenceId: paired.occurrenceId,
        pairedLocalDate: paired.localDate,
        state: group.state === "revoked" ? "revoked" as const : "published" as const,
        currentRevision: group.currentRevision,
      };
    })
    .sort((left, right) => left.groupOrdinal - right.groupOrdinal || compareStrings(left.groupId, right.groupId));
}

function hasPublicationAudit(row: LeagueOccurrence | LeagueScheduleException): boolean {
  return row.lastCommandId !== null
    && row.publicationCommandId !== null
    && row.publishedAt !== null
    && row.publishedByUserId !== null;
}

function assertOperationalSetIntegrity(
  input: BuildLeagueOccurrenceScheduleInput,
  operational: LeagueOccurrence[],
): void {
  const currentRuns = input.canonical.generationRuns.filter(
    (row) => row.state === "approved" || row.state === "applied",
  );
  if (currentRuns.length !== 1) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "operational canonical state must have exactly one current approved or applied generation run",
    );
  }
  const currentRun = currentRuns[0];
  if (currentRun.candidateOccurrenceCount
    !== currentRun.generatedOccurrenceCount + currentRun.skippedDateCount) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "the current canonical generation run has contradictory declared counts",
    );
  }
  const generatedOccurrences = input.canonical.occurrences.filter(
    (row) => row.generationRunId === currentRun.id,
  );
  if (generatedOccurrences.length !== currentRun.generatedOccurrenceCount
    || generatedOccurrences.some((row) => row.lifecycle !== "published" && row.lifecycle !== "locked")) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "the current canonical generation run has a partial or non-operational occurrence set",
    );
  }
  const generatedExceptions = input.canonical.scheduleExceptions.filter(
    (row) => row.generationRunId === currentRun.id,
  );
  if (generatedExceptions.length !== currentRun.skippedDateCount) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "the current canonical generation run has a partial schedule-exception set",
    );
  }

  const publishedRelationships = input.canonical.relationships.filter((row) => row.state === "published");
  const collectionGroups = input.canonical.collectionGroups ?? [];
  const collectionGroupMembers = input.canonical.collectionGroupMembers ?? [];
  for (const member of collectionGroupMembers) {
    const group = collectionGroups.find((candidate) => candidate.id === member.groupId);
    if (!group || group.organizationId !== input.organizationId || group.leagueId !== input.leagueId
      || group.generationRunId !== currentRun.id || !operational.some((row) => row.id === member.occurrenceId)) {
      throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "a collection group references non-operational evidence");
    }
  }
  for (const group of collectionGroups) {
    if (group.generationRunId !== currentRun.id || !["published", "revoked"].includes(group.state)) {
      throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "collection group evidence is not operational");
    }
    if (group.kind !== "double_pay" || group.triggerLocalDate >= group.pairedLocalDate
      || group.currentRevision < 1 || group.sourceScheduleRevision < 1) {
      throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "collection group has invalid kind, dates, or revision evidence");
    }
    const groupMembers = collectionGroupMembers.filter((member) => member.groupId === group.id);
    if (groupMembers.length !== 2 || new Set(groupMembers.map((member) => member.occurrenceId)).size !== 2
      || new Set(groupMembers.map((member) => member.billingTermId)).size !== 2
      || groupMembers.some((member) => member.organizationId !== input.organizationId
        || member.leagueId !== input.leagueId
        || member.generationRunId !== currentRun.id
        || member.amountMinor <= 0
        || member.billingOrdinal <= 0
        || !/^[A-Z]{3}$/.test(member.currency)
        || (member.role === "trigger" && member.memberOrdinal !== 1)
        || (member.role === "paired" && member.memberOrdinal !== 2)
        || !["trigger", "paired"].includes(member.role))) {
      throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "collection group must contain exactly one strict trigger and paired member");
    }
    const triggerMember = groupMembers.find((member) => member.role === "trigger");
    const pairedMember = groupMembers.find((member) => member.role === "paired");
    if (!triggerMember || !pairedMember
      || triggerMember.localDate !== group.triggerLocalDate
      || pairedMember.localDate !== group.pairedLocalDate
      || (group.state === "published" && groupMembers.some((member) => !member.active))
      || (group.state === "revoked" && groupMembers.some((member) => member.active))) {
      throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "collection group lifecycle and member activity are inconsistent");
    }
    if (group.state === "published") {
      const occurrenceById = new Map(operational.map((row) => [row.id, row]));
      const termById = new Map(input.canonical.billingTerms.map((term) => [term.id, term]));
      for (const member of [triggerMember, pairedMember]) {
        const occurrence = occurrenceById.get(member.occurrenceId);
        const term = termById.get(member.billingTermId);
        if (!occurrence || occurrence.authoritativeLocalDate !== member.localDate
          || !["published", "locked"].includes(occurrence.lifecycle)
          || !["scheduled", "completed"].includes(occurrence.status)
          || !term || term.occurrenceId !== member.occurrenceId
          || term.state !== "published"
          || term.obligationPolicy !== "eligible_bowlers"
          || term.billingOrdinal !== member.billingOrdinal
          || term.defaultAmountMinor !== member.amountMinor
          || term.currency !== member.currency) {
          throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "published collection group member does not match its current occurrence and billing term");
        }
      }
    }
  }
  for (const row of operational) {
    if (row.generationRunId === currentRun.id) continue;
    const auditedPostSetOccurrence = row.generationRunId === null
      && AUDITED_POST_SET_KINDS.has(row.kind)
      && hasPublicationAudit(row)
      && (row.kind !== "makeup" || publishedRelationships.some(
        (relationship) => relationship.kind === "makeup_for" && relationship.sourceOccurrenceId === row.id,
      ));
    if (!auditedPostSetOccurrence) {
      throw new LeagueOccurrenceScheduleError(
        "incompatible_canonical_state",
        "an operational occurrence is neither part of the current generation set nor an audited later special session",
      );
    }
  }

  for (const row of input.canonical.scheduleExceptions.filter((value) => value.lifecycle === "published")) {
    if (row.generationRunId === currentRun.id) continue;
    if (row.generationRunId !== null || !hasPublicationAudit(row)) {
      throw new LeagueOccurrenceScheduleError(
        "incompatible_canonical_state",
        "a published schedule exception is neither part of the current generation set nor an audited later exception",
      );
    }
  }
}

function buildCanonicalSchedule(
  input: BuildLeagueOccurrenceScheduleInput,
  operational: LeagueOccurrence[],
): LeagueOccurrenceScheduleReadContract {
  assertOperationalSetIntegrity(input, operational);
  const operationalIds = new Set(operational.map((row) => row.id));
  const collectionGroups = input.canonical.collectionGroups ?? [];
  const collectionGroupMembers = input.canonical.collectionGroupMembers ?? [];
  if ([...input.canonical.linkedActivityOccurrenceIds].some((id) => !operationalIds.has(id))) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "linked canonical activity references a non-operational occurrence",
    );
  }
  const liveDrafts = input.canonical.occurrences.filter(
    (row) => row.lifecycle === "draft" && row.status !== "discarded",
  );
  if (liveDrafts.length > 0) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "published canonical state is mixed with an active draft occurrence set",
    );
  }
  const publishedRelationships = input.canonical.relationships.filter((row) => row.state === "published");
  if (publishedRelationships.some((row) => (
    !operationalIds.has(row.sourceOccurrenceId) || !operationalIds.has(row.targetOccurrenceId)
  ))) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "an active canonical relationship references a non-operational occurrence",
    );
  }
  const publishedTerms = input.canonical.billingTerms.filter((row) => row.state === "published");
  if (publishedTerms.some((row) => !operationalIds.has(row.occurrenceId))) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "a published billing summary references a non-operational occurrence",
    );
  }
  const publishedExceptions = input.canonical.scheduleExceptions.filter((row) => row.lifecycle === "published");
  const operationalDates = new Set(operational.map((row) => row.authoritativeLocalDate));
  if (publishedExceptions.some((row) => operationalDates.has(row.localDate))) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "a published skipped date overlaps an operational occurrence",
    );
  }
  const now = Date.parse(normalizeUtcInstant(input.databaseNow, "databaseNow"));
  const occurrences = operational.map((row): LeagueOccurrenceScheduleOccurrence => {
    const matchingTerms = publishedTerms.filter((term) => term.occurrenceId === row.id);
    if (matchingTerms.length > 1) {
      throw new LeagueOccurrenceScheduleError(
        "incompatible_canonical_state",
        "an operational occurrence has multiple current published billing summaries",
      );
    }
    if (row.plannedOrdinal === null) {
      throw new LeagueOccurrenceScheduleError(
        "incompatible_canonical_state",
        "an operational occurrence is missing its planned ordinal",
      );
    }
    const startAt = normalizeUtcInstant(row.startAt, `occurrence ${row.id} startAt`);
    const effectiveLockReasons: LeagueOccurrenceEffectiveLockReason[] = [];
    if (row.lifecycle === "locked" || row.lockedAt !== null) effectiveLockReasons.push("canonical_lock");
    if (Date.parse(startAt) <= now) effectiveLockReasons.push("start_elapsed");
    if (input.canonical.linkedActivityOccurrenceIds.has(row.id)) effectiveLockReasons.push("linked_activity");
    const term = matchingTerms[0] ?? null;
    return {
      occurrenceId: row.id,
      identitySource: "canonical_uuid",
      kind: row.kind,
      status: row.status as "scheduled" | "cancelled" | "completed",
      lifecycle: row.lifecycle,
      authoritativeLocalDate: row.authoritativeLocalDate,
      authoritativeLocalStartTime: row.authoritativeLocalStartTime,
      timezone: row.timezone,
      startAt,
      selectedUtcOffsetMinutes: row.selectedUtcOffsetMinutes,
      foldResolution: row.foldResolution,
      resolverVersion: row.resolverVersion,
      plannedOrdinal: row.plannedOrdinal,
      competitionNumber: row.competitionNumber,
      competitive: row.competitive,
      countsInStandings: row.countsInStandings,
      currentRevision: row.currentRevision,
      effectivelyLocked: effectiveLockReasons.length > 0,
      effectiveLockReasons,
      billing: term ? {
        purpose: term.purpose,
        obligationPolicy: term.obligationPolicy,
        billingOrdinal: term.billingOrdinal,
        version: term.version,
        currentRevision: term.currentRevision,
      } : null,
      relationships: relationshipEvidence(row.id, publishedRelationships),
      collectionGroups: collectionGroupEvidence(row.id, collectionGroups, collectionGroupMembers),
    };
  }).sort(compareLeagueScheduleOccurrences);
  const skippedDates = publishedExceptions.map((row): LeagueOccurrenceScheduleSkippedDate => ({
    exceptionId: row.id,
    kind: row.kind,
    localDate: row.localDate,
    timezone: row.timezone,
    reason: row.reason,
    source: row.source,
    lifecycle: "published",
    durableCanonicalException: true,
    currentRevision: row.currentRevision,
  })).sort((left, right) => compareStrings(left.localDate, right.localDate)
    || compareStrings(left.kind, right.kind)
    || compareStrings(left.exceptionId, right.exceptionId));
  return {
    ...scheduleBase(input),
    authoritativeSource: "canonical",
    occurrences,
    skippedDates,
  };
}

export function buildLeagueOccurrenceSchedule(
  input: BuildLeagueOccurrenceScheduleInput,
): LeagueOccurrenceScheduleReadContract {
  assertScope(input);
  const operational = input.canonical.occurrences.filter(
    (row) => row.lifecycle === "published" || row.lifecycle === "locked",
  );
  if (operational.length === 0) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "operational canonical schedule evidence is missing or incomplete",
    );
  }
  return buildCanonicalSchedule(input, operational);
}

export type ScheduleExecutor = typeof db | LeagueScheduleTransaction;

async function databaseNow(executor: ScheduleExecutor): Promise<string> {
  const result = await executor.execute<{ database_now: string }>(sql`
    SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_now
  `);
  const value = result.rows[0]?.database_now;
  if (!value) throw new LeagueOccurrenceScheduleError("incompatible_canonical_state", "database time is unavailable");
  return value;
}

async function linkedActivityOccurrenceIds(
  executor: ScheduleExecutor,
  organizationId: number,
  leagueId: number,
  occurrenceIds: string[],
): Promise<ReadonlySet<string>> {
  if (occurrenceIds.length === 0) return new Set();
  const result = await executor.execute<{ occurrence_id: string; evidence_league_id: number }>(sql`
    SELECT evidence.occurrence_id, evidence.evidence_league_id
      FROM (
        SELECT g.occurrence_id, g.league_id AS evidence_league_id
          FROM games g
          JOIN leagues gl ON gl.id = g.league_id
         WHERE gl.organization_id = ${organizationId}
           AND g.league_id = ${leagueId}
           AND g.occurrence_id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
        UNION ALL
        SELECT po.trigger_occurrence_id AS occurrence_id, ps.league_id AS evidence_league_id
          FROM payment_operations po
          JOIN payment_schedules ps ON ps.id = po.payment_schedule_id
          JOIN leagues pl ON pl.id = ps.league_id
         WHERE po.organization_id = ${organizationId}
           AND pl.organization_id = ${organizationId}
           AND ps.league_id = ${leagueId}
           AND po.trigger_occurrence_id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
        UNION ALL
        SELECT occurrence_id, league_id FROM occurrence_payment_responsibilities
         WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
           AND occurrence_id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
        UNION ALL
        SELECT occurrence_id, league_id FROM payment_obligations
         WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
           AND occurrence_id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
        UNION ALL
        SELECT o.occurrence_id, o.league_id
          FROM payment_allocations a
          JOIN payment_obligations o ON o.id = a.obligation_id
         WHERE a.organization_id = ${organizationId} AND a.league_id = ${leagueId}
           AND o.occurrence_id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
        UNION ALL
        SELECT occurrence_id, league_id FROM canonical_collection_group_members
         WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
           AND occurrence_id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ) evidence
  `);
  if (result.rows.some((row) => row.evidence_league_id !== leagueId)) {
    throw new LeagueOccurrenceScheduleError(
      "incompatible_canonical_state",
      "linked canonical activity contradicts the authorized league",
    );
  }
  return new Set(result.rows.map((row) => row.occurrence_id));
}

export interface LoadLeagueOccurrenceScheduleInput {
  organizationId: number;
  leagueId: number;
  includeAdministratorEvidence: boolean;
}

export async function loadLeagueOccurrenceScheduleSnapshot(
  input: LoadLeagueOccurrenceScheduleInput,
  executor: ScheduleExecutor,
): Promise<LeagueOccurrenceScheduleReadContract> {
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId <= 0
    || !Number.isSafeInteger(input.leagueId) || input.leagueId <= 0) {
    throw new LeagueOccurrenceScheduleError("invalid_scope", "organizationId and leagueId must be positive safe integers");
  }
  const [league] = await executor.select({
    id: leagues.id,
    organizationId: leagues.organizationId,
    active: leagues.active,
    seasonStart: leagues.seasonStart,
    seasonEnd: leagues.seasonEnd,
    weekDay: leagues.weekDay,
    competitionStartTime: leagues.competitionStartTime,
    timezone: leagues.timezone,
    totalBowlingWeeks: leagues.totalBowlingWeeks,
  }).from(leagues).where(and(
    eq(leagues.id, input.leagueId),
    eq(leagues.organizationId, input.organizationId),
  )).limit(1);
  if (!league || league.organizationId !== input.organizationId) {
    throw new LeagueOccurrenceScheduleError("league_not_found", "league was not found in the authorized organization");
  }
  // A transaction uses one PostgreSQL client. Keep these reads sequential so
  // E2 mutation callers do not issue overlapping client.query calls while the
  // league advisory lock and one MVCC snapshot are active.
  const generationRuns = await executor.select().from(leagueOccurrenceGenerationRuns).where(and(
    eq(leagueOccurrenceGenerationRuns.organizationId, input.organizationId),
    eq(leagueOccurrenceGenerationRuns.leagueId, input.leagueId),
  )).orderBy(asc(leagueOccurrenceGenerationRuns.sourceScheduleRevision), asc(leagueOccurrenceGenerationRuns.id));
  const occurrences = await executor.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
  )).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(leagueOccurrences.id));
  const billingTerms = await executor.select().from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
  )).orderBy(asc(leagueOccurrenceBillingTerms.occurrenceId), asc(leagueOccurrenceBillingTerms.id));
  const scheduleExceptions = await executor.select().from(leagueScheduleExceptions).where(and(
    eq(leagueScheduleExceptions.organizationId, input.organizationId),
    eq(leagueScheduleExceptions.leagueId, input.leagueId),
  )).orderBy(asc(leagueScheduleExceptions.localDate), asc(leagueScheduleExceptions.id));
  const relationships = await executor.select().from(leagueOccurrenceRelationships).where(and(
    eq(leagueOccurrenceRelationships.organizationId, input.organizationId),
    eq(leagueOccurrenceRelationships.leagueId, input.leagueId),
  )).orderBy(asc(leagueOccurrenceRelationships.id));
  const collectionGroups = await executor.select().from(canonicalCollectionGroups).where(and(
    eq(canonicalCollectionGroups.organizationId, input.organizationId),
    eq(canonicalCollectionGroups.leagueId, input.leagueId),
  )).orderBy(asc(canonicalCollectionGroups.generationRunId), asc(canonicalCollectionGroups.groupOrdinal), asc(canonicalCollectionGroups.id));
  const collectionGroupMembers = await executor.select().from(canonicalCollectionGroupMembers).where(and(
    eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
    eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
  )).orderBy(asc(canonicalCollectionGroupMembers.groupId), asc(canonicalCollectionGroupMembers.memberOrdinal), asc(canonicalCollectionGroupMembers.id));
  const hasAnyEvidence = await hasLeagueOccurrenceEvidence(executor, input.organizationId, input.leagueId);
  const now = await databaseNow(executor);
  const linkedIds = await linkedActivityOccurrenceIds(
    executor,
    input.organizationId,
    input.leagueId,
    occurrences.map((row) => row.id),
  );
  return buildLeagueOccurrenceSchedule({
    ...input,
    league,
    databaseNow: now,
    canonical: {
      generationRuns,
      occurrences,
      billingTerms,
      scheduleExceptions,
      relationships,
      collectionGroups,
      collectionGroupMembers,
      linkedActivityOccurrenceIds: linkedIds,
      hasAnyCanonicalEvidence: hasAnyEvidence,
    },
  });
}

export async function loadLeagueOccurrenceSchedule(
  input: LoadLeagueOccurrenceScheduleInput,
  executor: typeof db = db,
): Promise<LeagueOccurrenceScheduleReadContract> {
  return executor.transaction(
    (tx) => loadLeagueOccurrenceScheduleSnapshot(input, tx),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Product-visible league surfaces use the same complete-state validator as
 * the schedule endpoint. A row in an occurrence table, or an approved run
 * by itself, is not sufficient: the current run, occurrence set, skips,
 * relationships, billing terms, collection groups, and tenant links must all
 * agree before a league is exposed.
 */
export async function hasCompleteOperationalLeagueSchedule(
  input: Omit<LoadLeagueOccurrenceScheduleInput, "includeAdministratorEvidence">,
  executor: typeof db = db,
): Promise<boolean> {
  try {
    await loadLeagueOccurrenceSchedule({ ...input, includeAdministratorEvidence: false }, executor);
    return true;
  } catch (caught) {
    if (caught instanceof LeagueOccurrenceScheduleError
      && (caught.code === "league_not_found" || caught.code === "incompatible_canonical_state")) {
      return false;
    }
    throw caught;
  }
}
