import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "@shared/schema";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  type LeagueOccurrence,
  type LeagueOccurrenceBillingTerm,
  type LeagueOccurrenceGenerationDiscrepancy,
  type LeagueOccurrenceGenerationRun,
  type LeagueScheduleCommand,
  type LeagueScheduleException,
} from "@shared/schema";
import {
  COMPLETED_SUMMER_BILLING_TERM_REVISION_SNAPSHOT_VERSION,
  COMPLETED_SUMMER_EXCEPTION_REVISION_SNAPSHOT_VERSION,
  COMPLETED_SUMMER_MATERIALIZATION_RESULT_VERSION,
  COMPLETED_SUMMER_OCCURRENCE_REVISION_SNAPSHOT_VERSION,
  CompletedSummerMaterializationError,
  completedSummerMaterializationApprovalFingerprintPayload,
  completedSummerRelatedCommandPayload,
  completedSummerReportsAreSemanticallyEqual,
  type CompletedSummerMaterializationPlan,
} from "@shared/completed-summer-materialization";
import { canonicalJsonStringify, sha256CanonicalJson } from "@shared/completed-summer-comparator";
import {
  loadCompletedSummerComparisonReport,
  type CompletedSummerReportQueryExecutor,
} from "../../scripts/compare-completed-summer-occurrences.js";
import {
  allocateCanonicalSourceScheduleRevisionInTransaction,
  assertCanonicalScheduleTenantAndActor,
  buildCanonicalScheduleCommandFingerprint,
  getOrCreateCanonicalScheduleCommandInTransaction,
  validateCanonicalExceptionPlacementInTransaction,
  validateCanonicalOccurrencePlacementInTransaction,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";
import {
  lockLeagueSchedule,
  lockLeagueScheduleSession,
  unlockLeagueScheduleSession,
  type LeagueScheduleTransaction,
} from "../storage/league-schedule-lock.js";

export type CompletedSummerMaterializationFailureStage =
  | "after_commands"
  | "after_generation_run"
  | "after_occurrences"
  | "after_billing_terms"
  | "after_exceptions"
  | "after_revisions"
  | "after_discrepancies";

export interface CompletedSummerMaterializationDurableIds {
  commandIds: string[];
  generationRunId: string;
  occurrenceIds: string[];
  billingTermIds: string[];
  exceptionIds: string[];
  occurrenceRevisionIds: string[];
  billingTermRevisionIds: string[];
  exceptionRevisionIds: string[];
  discrepancyIds: string[];
}

export interface CompletedSummerMaterializationResult {
  resultContractVersion: typeof COMPLETED_SUMMER_MATERIALIZATION_RESULT_VERSION;
  materializationContractVersion: CompletedSummerMaterializationPlan["materializationContractVersion"];
  materializationSemanticsVersion: CompletedSummerMaterializationPlan["materializationSemanticsVersion"];
  mode: "plan" | "applied" | "idempotent_retry";
  organizationId: number;
  leagueId: number;
  reportFingerprint: string;
  requestFingerprint: string;
  inputFingerprint: string;
  physicalScheduleFingerprint: string;
  candidateSetFingerprint: string;
  sourceScheduleRevision: number;
  acknowledgedFindingReferences: string[];
  counts: CompletedSummerMaterializationPlan["counts"];
  durableIds: CompletedSummerMaterializationDurableIds | null;
  writesPerformed: boolean;
  legacyWritesPerformed: false;
  paymentOrObligationLinksCreated: false;
}

interface ExpectedCommands {
  approval: MaterializationScheduleCommandRequest;
  generate: MaterializationScheduleCommandRequest;
  publish: MaterializationScheduleCommandRequest;
  cancel: MaterializationScheduleCommandRequest | null;
  createException: MaterializationScheduleCommandRequest | null;
  all: MaterializationScheduleCommandRequest[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeInstant(value: string): string {
  return new Date(value).toISOString();
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function serializedReportQueryExecutor(client: pg.Client): CompletedSummerReportQueryExecutor {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    query<Row extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<Row>> {
      const result = tail.then(() => client.query<Row>(text, values));
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

function relatedIdempotencyKey(plan: CompletedSummerMaterializationPlan, role: string): string {
  return `lvb2:${sha256CanonicalJson({
    organizationId: plan.approval.organizationId,
    leagueId: plan.approval.leagueId,
    operatorIdempotencyKey: plan.approval.idempotencyKey,
    role,
  })}`;
}

function commandRequest(
  plan: CompletedSummerMaterializationPlan,
  commandType: MaterializationScheduleCommandRequest["commandType"],
  idempotencyKey: string,
  materializationPayload: Record<string, unknown>,
): MaterializationScheduleCommandRequest {
  const request: MaterializationScheduleCommandRequest = {
    organizationId: plan.approval.organizationId,
    leagueId: plan.approval.leagueId,
    actorUserId: plan.approval.actorUserId,
    commandType,
    idempotencyKey,
    requestFingerprint: "",
    reason: plan.approval.reason,
    materializationPayload,
  };
  return { ...request, requestFingerprint: buildCanonicalScheduleCommandFingerprint(request) };
}

export function buildCompletedSummerMaterializationCommandRequests(
  plan: CompletedSummerMaterializationPlan,
): ExpectedCommands {
  const approval = commandRequest(
    plan,
    "approve_generation",
    plan.approval.idempotencyKey,
    completedSummerMaterializationApprovalFingerprintPayload(plan),
  );
  const generate = commandRequest(
    plan,
    "generate",
    relatedIdempotencyKey(plan, "generate"),
    completedSummerRelatedCommandPayload(plan, "generate"),
  );
  const publish = commandRequest(
    plan,
    "publish",
    relatedIdempotencyKey(plan, "publish"),
    completedSummerRelatedCommandPayload(plan, "publish"),
  );
  const cancel = plan.counts.cancelledOccurrences === 0 ? null : commandRequest(
    plan,
    "cancel",
    relatedIdempotencyKey(plan, "cancel"),
    completedSummerRelatedCommandPayload(plan, "cancel"),
  );
  const createException = plan.counts.exceptions === 0 ? null : commandRequest(
    plan,
    "create_exception",
    relatedIdempotencyKey(plan, "create_exception"),
    completedSummerRelatedCommandPayload(plan, "create_exception"),
  );
  return {
    approval,
    generate,
    publish,
    cancel,
    createException,
    all: [approval, generate, publish, cancel, createException].filter((request): request is MaterializationScheduleCommandRequest => request !== null),
  };
}

export function buildCompletedSummerMaterializationPlanResult(
  plan: CompletedSummerMaterializationPlan,
): CompletedSummerMaterializationResult {
  const commands = buildCompletedSummerMaterializationCommandRequests(plan);
  return {
    resultContractVersion: COMPLETED_SUMMER_MATERIALIZATION_RESULT_VERSION,
    materializationContractVersion: plan.materializationContractVersion,
    materializationSemanticsVersion: plan.materializationSemanticsVersion,
    mode: "plan",
    organizationId: plan.approval.organizationId,
    leagueId: plan.approval.leagueId,
    reportFingerprint: plan.approval.reportFingerprint,
    requestFingerprint: commands.approval.requestFingerprint,
    inputFingerprint: plan.approval.inputFingerprint,
    physicalScheduleFingerprint: plan.approval.physicalScheduleFingerprint,
    candidateSetFingerprint: plan.candidateSetFingerprint,
    sourceScheduleRevision: plan.approval.expectedSourceScheduleRevision,
    acknowledgedFindingReferences: [...plan.requiredAcknowledgementReferences],
    counts: plan.counts,
    durableIds: null,
    writesPerformed: false,
    legacyWritesPerformed: false,
    paymentOrObligationLinksCreated: false,
  };
}

function commandMatches(existing: LeagueScheduleCommand, request: MaterializationScheduleCommandRequest): boolean {
  return existing.organizationId === request.organizationId
    && existing.leagueId === request.leagueId
    && existing.actorUserId === request.actorUserId
    && existing.commandType === request.commandType
    && existing.idempotencyKey === request.idempotencyKey
    && existing.requestFingerprint === request.requestFingerprint
    && existing.reason === (request.reason ?? null)
    && existing.sameDayOverride === false
    && existing.outcome === "applied";
}

function occurrenceSnapshot(row: LeagueOccurrence): Record<string, unknown> {
  return {
    snapshotContractVersion: "completed-summer-occurrence-revision/1",
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
    startAt: normalizeInstant(row.startAt),
    selectedUtcOffsetMinutes: row.selectedUtcOffsetMinutes,
    foldResolution: row.foldResolution,
    resolverVersion: row.resolverVersion,
    plannedOrdinal: row.plannedOrdinal,
    competitionNumber: row.competitionNumber,
    competitive: row.competitive,
    countsInStandings: row.countsInStandings,
    currentRevision: row.currentRevision,
    lastCommandId: row.lastCommandId,
    publishedAt: row.publishedAt === null ? null : normalizeInstant(row.publishedAt),
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    lockedAt: row.lockedAt,
    lockedByUserId: row.lockedByUserId,
    lockReason: row.lockReason,
    lockCommandId: row.lockCommandId,
    cancelledAt: row.cancelledAt === null ? null : normalizeInstant(row.cancelledAt),
    cancelledByUserId: row.cancelledByUserId,
    cancellationCommandId: row.cancellationCommandId,
    completedAt: row.completedAt,
    completedByUserId: row.completedByUserId,
    completionCommandId: row.completionCommandId,
    discardedAt: row.discardedAt,
    discardedByUserId: row.discardedByUserId,
    discardCommandId: row.discardCommandId,
  };
}

function billingTermSnapshot(row: LeagueOccurrenceBillingTerm): Record<string, unknown> {
  return {
    snapshotContractVersion: "completed-summer-billing-term-revision/1",
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
    publishedAt: row.publishedAt === null ? null : normalizeInstant(row.publishedAt),
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    supersededAt: row.supersededAt,
    supersededByCommandId: row.supersededByCommandId,
  };
}

function exceptionSnapshot(row: LeagueScheduleException): Record<string, unknown> {
  return {
    snapshotContractVersion: "completed-summer-exception-revision/1",
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    kind: row.kind,
    localDate: row.localDate,
    timezone: row.timezone,
    source: row.source,
    lifecycle: row.lifecycle,
    reason: row.reason,
    generationRunId: row.generationRunId,
    currentRevision: row.currentRevision,
    lastCommandId: row.lastCommandId,
    publishedAt: row.publishedAt === null ? null : normalizeInstant(row.publishedAt),
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
    revocationCommandId: row.revocationCommandId,
  };
}

function assertGenerationRunMatches(
  run: LeagueOccurrenceGenerationRun,
  plan: CompletedSummerMaterializationPlan,
  commands: { approval: LeagueScheduleCommand; generate: LeagueScheduleCommand },
): void {
  const generation = plan.generationResult;
  if (run.organizationId !== plan.approval.organizationId
    || run.leagueId !== plan.approval.leagueId
    || run.originatingCommandId !== commands.generate.id
    || run.generatorVersion !== generation.generatorVersion
    || run.inputFingerprint !== generation.inputFingerprint
    || run.sourceScheduleRevision !== plan.approval.expectedSourceScheduleRevision
    || !sameCanonicalValue(run.normalizedInputSnapshot, generation.normalizedInput)
    || run.rangeStartDate !== generation.generationRange.startDate
    || run.rangeEndDate !== generation.generationRange.endDate
    || run.candidateOccurrenceCount !== generation.counts.candidateOccurrenceCount
    || run.generatedOccurrenceCount !== generation.counts.generatedOccurrenceCount
    || run.skippedDateCount !== generation.counts.skippedDateCount
    || run.discrepancyCount !== generation.counts.discrepancyCount
    || run.state !== "applied"
    || run.approvedByUserId !== plan.approval.actorUserId
    || run.approvalCommandId !== commands.approval.id
    || run.approvedAt === null) {
    throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the existing generation run is not the exact B2 result");
  }
}

function resultFromRows(input: {
  plan: CompletedSummerMaterializationPlan;
  mode: "applied" | "idempotent_retry";
  commands: LeagueScheduleCommand[];
  run: LeagueOccurrenceGenerationRun;
  occurrences: LeagueOccurrence[];
  terms: LeagueOccurrenceBillingTerm[];
  exceptions: LeagueScheduleException[];
  occurrenceRevisionIds: string[];
  billingTermRevisionIds: string[];
  exceptionRevisionIds: string[];
  discrepancies: LeagueOccurrenceGenerationDiscrepancy[];
}): CompletedSummerMaterializationResult {
  const planResult = buildCompletedSummerMaterializationPlanResult(input.plan);
  return {
    ...planResult,
    mode: input.mode,
    durableIds: {
      commandIds: input.commands.map((row) => row.id).sort(compareStrings),
      generationRunId: input.run.id,
      occurrenceIds: input.occurrences.map((row) => row.id).sort(compareStrings),
      billingTermIds: input.terms.map((row) => row.id).sort(compareStrings),
      exceptionIds: input.exceptions.map((row) => row.id).sort(compareStrings),
      occurrenceRevisionIds: [...input.occurrenceRevisionIds].sort(compareStrings),
      billingTermRevisionIds: [...input.billingTermRevisionIds].sort(compareStrings),
      exceptionRevisionIds: [...input.exceptionRevisionIds].sort(compareStrings),
      discrepancyIds: input.discrepancies.map((row) => row.id).sort(compareStrings),
    },
    writesPerformed: input.mode === "applied",
  };
}

async function verifyExactRetry(
  tx: LeagueScheduleTransaction,
  plan: CompletedSummerMaterializationPlan,
  expected: ExpectedCommands,
): Promise<CompletedSummerMaterializationResult> {
  const commands = await tx.select().from(leagueScheduleCommands).where(and(
    eq(leagueScheduleCommands.organizationId, plan.approval.organizationId),
    eq(leagueScheduleCommands.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueScheduleCommands.id)).for("update");
  if (commands.length !== expected.all.length) {
    throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the league contains partial, foreign, or competing command state");
  }
  const commandByKey = new Map(commands.map((row) => [row.idempotencyKey, row]));
  for (const request of expected.all) {
    const row = commandByKey.get(request.idempotencyKey);
    if (!row || !commandMatches(row, request)) {
      throw new CompletedSummerMaterializationError("idempotency_conflict", "the existing command set does not match this exact materialization request");
    }
  }
  const approval = commandByKey.get(expected.approval.idempotencyKey);
  const generate = commandByKey.get(expected.generate.idempotencyKey);
  const publish = commandByKey.get(expected.publish.idempotencyKey);
  const cancel = expected.cancel ? commandByKey.get(expected.cancel.idempotencyKey) : null;
  const createException = expected.createException ? commandByKey.get(expected.createException.idempotencyKey) : null;
  if (!approval || !generate || !publish || (expected.cancel && !cancel) || (expected.createException && !createException)) {
    throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the exact B2 command attribution is incomplete");
  }
  const runs = await tx.select().from(leagueOccurrenceGenerationRuns).where(and(
    eq(leagueOccurrenceGenerationRuns.organizationId, plan.approval.organizationId),
    eq(leagueOccurrenceGenerationRuns.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueOccurrenceGenerationRuns.id)).for("update");
  if (runs.length !== 1) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the retry does not own exactly one generation run");
  const run = runs[0];
  assertGenerationRunMatches(run, plan, { approval, generate });
  const actionTime = normalizeInstant(run.approvedAt as string);

  const occurrences = await tx.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, plan.approval.organizationId),
    eq(leagueOccurrences.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueOccurrences.generationKey)).for("update");
  if (occurrences.length !== plan.counts.occurrences) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the retry occurrence count is not exact");
  const occurrenceByGenerationKey = new Map(occurrences.map((row) => [row.generationKey, row]));
  for (const candidate of plan.generationResult.occurrenceCandidates) {
    const row = occurrenceByGenerationKey.get(candidate.generationKey);
    const responsible = candidate.status === "cancelled" ? cancel : publish;
    if (!row || !responsible
      || row.generationRunId !== run.id
      || row.locationId !== plan.league.identity.locationId
      || row.kind !== candidate.kind || row.status !== candidate.status || row.lifecycle !== "published"
      || row.authoritativeLocalDate !== candidate.authoritativeLocalDate
      || row.authoritativeLocalStartTime !== candidate.authoritativeLocalStartTime
      || row.timezone !== candidate.timezone || normalizeInstant(row.startAt) !== candidate.startAt
      || row.selectedUtcOffsetMinutes !== candidate.selectedUtcOffsetMinutes
      || row.foldResolution !== candidate.foldResolution || row.resolverVersion !== candidate.resolverVersion
      || row.plannedOrdinal !== candidate.plannedOrdinal || row.competitionNumber !== candidate.competitionNumber
      || row.competitive !== candidate.competitive || row.countsInStandings !== candidate.countsInStandings
      || row.currentRevision !== 1 || row.lastCommandId !== responsible.id
      || row.publicationCommandId !== publish.id || row.publishedByUserId !== plan.approval.actorUserId
      || row.publishedAt === null || normalizeInstant(row.publishedAt) !== actionTime
      || row.lockedAt !== null || row.lockedByUserId !== null || row.lockCommandId !== null
      || (candidate.status === "cancelled" && (row.cancellationCommandId !== cancel?.id
        || row.cancelledByUserId !== plan.approval.actorUserId || row.cancelledAt === null
        || normalizeInstant(row.cancelledAt) !== actionTime))
      || (candidate.status === "scheduled" && (row.cancellationCommandId !== null || row.cancelledAt !== null))) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "an existing occurrence is not the exact B2 candidate mapping");
    }
  }

  const terms = await tx.select().from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, plan.approval.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueOccurrenceBillingTerms.id)).for("update");
  if (terms.length !== plan.counts.billingTerms) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the retry billing-term count is not exact");
  const occurrenceByCandidate = new Map(plan.generationResult.occurrenceCandidates.map((candidate) => [
    candidate.candidateReference,
    occurrenceByGenerationKey.get(candidate.generationKey) as LeagueOccurrence,
  ]));
  for (const candidate of plan.generationResult.billingTermCandidates) {
    const occurrence = occurrenceByCandidate.get(candidate.occurrenceCandidateReference);
    const row = terms.find((term) => term.occurrenceId === occurrence?.id && term.purpose === candidate.purpose);
    if (!row || row.obligationPolicy !== candidate.obligationPolicy
      || row.defaultAmountMinor !== candidate.defaultAmountMinor || row.currency !== candidate.currency
      || row.billingOrdinal !== candidate.billingOrdinal || row.version !== candidate.version
      || row.state !== "published" || row.currentRevision !== 1 || row.lastCommandId !== publish.id
      || row.publicationCommandId !== publish.id || row.publishedByUserId !== plan.approval.actorUserId
      || row.publishedAt === null || normalizeInstant(row.publishedAt) !== actionTime) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "an existing billing term is not the exact B2 candidate mapping");
    }
  }

  const exceptions = await tx.select().from(leagueScheduleExceptions).where(and(
    eq(leagueScheduleExceptions.organizationId, plan.approval.organizationId),
    eq(leagueScheduleExceptions.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueScheduleExceptions.localDate)).for("update");
  if (exceptions.length !== plan.counts.exceptions) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the retry exception count is not exact");
  for (const candidate of plan.generationResult.exceptionCandidates) {
    const row = exceptions.find((exception) => exception.localDate === candidate.authoritativeLocalDate && exception.kind === candidate.kind);
    const responsible = candidate.lifecycleIntent === "published" ? publish : createException;
    if (!row || !responsible || row.timezone !== candidate.timezone || row.reason !== candidate.reason
      || row.source !== candidate.source || row.lifecycle !== candidate.lifecycleIntent
      || row.generationRunId !== (candidate.generationRunAssociationIntent === "associate" ? run.id : null)
      || row.currentRevision !== 1 || row.lastCommandId !== responsible.id
      || (candidate.lifecycleIntent === "published" && (row.publicationCommandId !== publish.id
        || row.publishedByUserId !== plan.approval.actorUserId || row.publishedAt === null
        || normalizeInstant(row.publishedAt) !== actionTime))
      || (candidate.lifecycleIntent === "draft" && (row.publicationCommandId !== null || row.publishedAt !== null))) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "an existing exception is not the exact B2 candidate mapping");
    }
  }

  const occurrenceRevisions = await tx.select().from(leagueOccurrenceRevisions).where(and(
    eq(leagueOccurrenceRevisions.organizationId, plan.approval.organizationId),
    eq(leagueOccurrenceRevisions.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueOccurrenceRevisions.id)).for("update");
  const termRevisions = await tx.select().from(leagueOccurrenceBillingTermRevisions).where(and(
    eq(leagueOccurrenceBillingTermRevisions.organizationId, plan.approval.organizationId),
    eq(leagueOccurrenceBillingTermRevisions.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueOccurrenceBillingTermRevisions.id)).for("update");
  const exceptionRevisions = await tx.select().from(leagueScheduleExceptionRevisions).where(and(
    eq(leagueScheduleExceptionRevisions.organizationId, plan.approval.organizationId),
    eq(leagueScheduleExceptionRevisions.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueScheduleExceptionRevisions.id)).for("update");
  if (occurrenceRevisions.length !== occurrences.length || termRevisions.length !== terms.length || exceptionRevisions.length !== exceptions.length) {
    throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the retry revision set is partial or unexpected");
  }
  for (const row of occurrences) {
    const revision = occurrenceRevisions.find((candidate) => candidate.occurrenceId === row.id);
    if (!revision || revision.revisionNumber !== 1 || revision.snapshotSchemaVersion !== COMPLETED_SUMMER_OCCURRENCE_REVISION_SNAPSHOT_VERSION
      || revision.beforeSnapshot !== null || !sameCanonicalValue(revision.afterSnapshot, occurrenceSnapshot(row))
      || revision.commandId !== row.lastCommandId) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "an occurrence initial revision is not exact");
    }
  }
  for (const row of terms) {
    const revision = termRevisions.find((candidate) => candidate.billingTermId === row.id);
    if (!revision || revision.revisionNumber !== 1 || revision.snapshotSchemaVersion !== COMPLETED_SUMMER_BILLING_TERM_REVISION_SNAPSHOT_VERSION
      || revision.beforeSnapshot !== null || !sameCanonicalValue(revision.afterSnapshot, billingTermSnapshot(row))
      || revision.commandId !== row.lastCommandId) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "a billing-term initial revision is not exact");
    }
  }
  for (const row of exceptions) {
    const revision = exceptionRevisions.find((candidate) => candidate.exceptionId === row.id);
    if (!revision || revision.revisionNumber !== 1 || revision.snapshotSchemaVersion !== COMPLETED_SUMMER_EXCEPTION_REVISION_SNAPSHOT_VERSION
      || revision.beforeSnapshot !== null || !sameCanonicalValue(revision.afterSnapshot, exceptionSnapshot(row))
      || revision.commandId !== row.lastCommandId) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "an exception initial revision is not exact");
    }
  }

  const discrepancies = await tx.select().from(leagueOccurrenceGenerationDiscrepancies).where(and(
    eq(leagueOccurrenceGenerationDiscrepancies.organizationId, plan.approval.organizationId),
    eq(leagueOccurrenceGenerationDiscrepancies.leagueId, plan.approval.leagueId),
  )).orderBy(asc(leagueOccurrenceGenerationDiscrepancies.id)).for("update");
  if (discrepancies.length !== plan.persistedFindings.length) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "the retry discrepancy set is not exact");
  for (const finding of plan.persistedFindings) {
    const row = discrepancies.find((candidate) => (candidate.details as { stableReference?: string }).stableReference === finding.stableReference);
    if (!row || row.generationRunId !== run.id || row.severity !== finding.severity || row.code !== finding.code
      || row.generationKey !== finding.generationKey || !sameCanonicalValue(row.details, finding.details)
      || row.resolutionState !== "open" || row.resolutionCommandId !== null || row.resolvedAt !== null) {
      throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "an existing discrepancy is not the exact B2 review-evidence mapping");
    }
  }
  const relationships = await tx.select({ id: leagueOccurrenceRelationships.id }).from(leagueOccurrenceRelationships).where(and(
    eq(leagueOccurrenceRelationships.organizationId, plan.approval.organizationId),
    eq(leagueOccurrenceRelationships.leagueId, plan.approval.leagueId),
  )).for("update");
  if (relationships.length !== 0) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "B2 never owns occurrence relationships");
  return resultFromRows({
    plan,
    mode: "idempotent_retry",
    commands,
    run,
    occurrences,
    terms,
    exceptions,
    occurrenceRevisionIds: occurrenceRevisions.map((row) => row.id),
    billingTermRevisionIds: termRevisions.map((row) => row.id),
    exceptionRevisionIds: exceptionRevisions.map((row) => row.id),
    discrepancies,
  });
}

function injectFailure(requested: CompletedSummerMaterializationFailureStage | undefined, stage: CompletedSummerMaterializationFailureStage): void {
  if (requested === stage) throw new CompletedSummerMaterializationError("transaction_failure", `injected B2 failure at ${stage}`);
}

export async function executeCompletedSummerMaterialization(input: {
  client: pg.Client;
  plan: CompletedSummerMaterializationPlan;
  apply: boolean;
  failureInjection?: CompletedSummerMaterializationFailureStage;
}): Promise<CompletedSummerMaterializationResult> {
  const { plan } = input;
  const expected = buildCompletedSummerMaterializationCommandRequests(plan);
  const db = drizzle({ client: input.client, schema });
  await lockLeagueScheduleSession(input.client, plan.approval.organizationId, plan.approval.leagueId);
  try {
    return await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, plan.approval.organizationId, plan.approval.leagueId);
    await assertCanonicalScheduleTenantAndActor(tx, expected.approval);
    const [existingApproval] = await tx.select().from(leagueScheduleCommands).where(and(
      eq(leagueScheduleCommands.organizationId, plan.approval.organizationId),
      eq(leagueScheduleCommands.idempotencyKey, plan.approval.idempotencyKey),
    )).for("update");
    if (existingApproval) {
      if (!commandMatches(existingApproval, expected.approval)) {
        throw new CompletedSummerMaterializationError("idempotency_conflict", "the idempotency key is bound to a different semantic materialization request");
      }
      return verifyExactRetry(tx, plan, expected);
    }

    const currentReport = await loadCompletedSummerComparisonReport(
      serializedReportQueryExecutor(input.client),
      plan.approval.requestedScope,
    );
    if (!completedSummerReportsAreSemanticallyEqual(currentReport, plan.report)) {
      throw new CompletedSummerMaterializationError("stale_report", "current tenant evidence no longer equals the approved B1 report");
    }
    const sourceScheduleRevision = await allocateCanonicalSourceScheduleRevisionInTransaction(
      tx,
      plan.approval.organizationId,
      plan.approval.leagueId,
    );
    if (sourceScheduleRevision !== plan.approval.expectedSourceScheduleRevision) {
      throw new CompletedSummerMaterializationError("source_revision_mismatch", "the locked source schedule revision does not equal the approved report revision");
    }
    for (const candidate of plan.generationResult.occurrenceCandidates) {
      await validateCanonicalOccurrencePlacementInTransaction(tx, {
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        authoritativeLocalDate: candidate.authoritativeLocalDate,
        startAt: candidate.startAt,
        sameDayOverride: false,
      });
    }
    for (const candidate of plan.generationResult.exceptionCandidates) {
      await validateCanonicalExceptionPlacementInTransaction(tx, {
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        authoritativeLocalDate: candidate.authoritativeLocalDate,
        startAt: candidate.authoritativeLocalDate,
        actorUserId: plan.approval.actorUserId,
        commandType: "create_exception",
        idempotencyKey: expected.createException?.idempotencyKey ?? "unused",
        requestFingerprint: expected.createException?.requestFingerprint ?? "unused",
      });
    }
    if (!input.apply) return buildCompletedSummerMaterializationPlanResult(plan);

    const commandRows = new Map<string, LeagueScheduleCommand>();
    for (const request of expected.all) {
      const { command, existing } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, [request.commandType]);
      if (existing) throw new CompletedSummerMaterializationError("unexpected_existing_a1_state", "a related B2 command exists without the approval command");
      commandRows.set(request.idempotencyKey, command);
    }
    injectFailure(input.failureInjection, "after_commands");
    const approvalCommand = commandRows.get(expected.approval.idempotencyKey);
    const generateCommand = commandRows.get(expected.generate.idempotencyKey);
    const publishCommand = commandRows.get(expected.publish.idempotencyKey);
    const cancelCommand = expected.cancel ? commandRows.get(expected.cancel.idempotencyKey) : null;
    const exceptionCommand = expected.createException ? commandRows.get(expected.createException.idempotencyKey) : null;
    if (!approvalCommand || !generateCommand || !publishCommand || (expected.cancel && !cancelCommand) || (expected.createException && !exceptionCommand)) {
      throw new CompletedSummerMaterializationError("transaction_failure", "B2 command attribution could not be created");
    }
    const actionTimeQuery = await input.client.query<{ action_time: string }>(`
      SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS action_time
    `);
    const actionTime = actionTimeQuery.rows[0]?.action_time;
    if (!actionTime) throw new CompletedSummerMaterializationError("transaction_failure", "the transaction action time could not be established");
    const generation = plan.generationResult;
    if (!generation.generationRange.startDate || !generation.generationRange.endDate) {
      throw new CompletedSummerMaterializationError("generator_result_mismatch", "a usable generation range is required for materialization");
    }
    const [run] = await tx.insert(leagueOccurrenceGenerationRuns).values({
      organizationId: plan.approval.organizationId,
      leagueId: plan.approval.leagueId,
      originatingCommandId: generateCommand.id,
      generatorVersion: generation.generatorVersion,
      inputFingerprint: generation.inputFingerprint,
      sourceScheduleRevision,
      normalizedInputSnapshot: generation.normalizedInput,
      rangeStartDate: generation.generationRange.startDate,
      rangeEndDate: generation.generationRange.endDate,
      candidateOccurrenceCount: generation.counts.candidateOccurrenceCount,
      generatedOccurrenceCount: generation.counts.generatedOccurrenceCount,
      skippedDateCount: generation.counts.skippedDateCount,
      discrepancyCount: generation.counts.discrepancyCount,
      state: "applied",
      approvedAt: actionTime,
      approvedByUserId: plan.approval.actorUserId,
      approvalCommandId: approvalCommand.id,
    }).returning();
    if (!run) throw new CompletedSummerMaterializationError("transaction_failure", "the B2 generation run was not created");
    injectFailure(input.failureInjection, "after_generation_run");

    const occurrences: LeagueOccurrence[] = [];
    const occurrenceByCandidate = new Map<string, LeagueOccurrence>();
    for (const candidate of generation.occurrenceCandidates) {
      const responsibleCommand = candidate.status === "cancelled" ? cancelCommand : publishCommand;
      if (!responsibleCommand) throw new CompletedSummerMaterializationError("transaction_failure", "cancelled occurrence command attribution is missing");
      const [row] = await tx.insert(leagueOccurrences).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        locationId: plan.league.identity.locationId,
        generationKey: candidate.generationKey,
        generationRunId: run.id,
        kind: candidate.kind,
        status: candidate.status,
        lifecycle: "published",
        authoritativeLocalDate: candidate.authoritativeLocalDate,
        authoritativeLocalStartTime: candidate.authoritativeLocalStartTime,
        timezone: candidate.timezone,
        startAt: candidate.startAt,
        selectedUtcOffsetMinutes: candidate.selectedUtcOffsetMinutes,
        foldResolution: candidate.foldResolution,
        resolverVersion: candidate.resolverVersion,
        plannedOrdinal: candidate.plannedOrdinal,
        competitionNumber: candidate.competitionNumber,
        competitive: candidate.competitive,
        countsInStandings: candidate.countsInStandings,
        currentRevision: 1,
        lastCommandId: responsibleCommand.id,
        publishedAt: actionTime,
        publishedByUserId: plan.approval.actorUserId,
        publicationCommandId: publishCommand.id,
        cancelledAt: candidate.status === "cancelled" ? actionTime : null,
        cancelledByUserId: candidate.status === "cancelled" ? plan.approval.actorUserId : null,
        cancellationCommandId: candidate.status === "cancelled" ? cancelCommand?.id : null,
      }).returning();
      if (!row) throw new CompletedSummerMaterializationError("transaction_failure", "a B2 occurrence was not created");
      occurrences.push(row);
      occurrenceByCandidate.set(candidate.candidateReference, row);
    }
    injectFailure(input.failureInjection, "after_occurrences");

    const terms: LeagueOccurrenceBillingTerm[] = [];
    for (const candidate of generation.billingTermCandidates) {
      const occurrence = occurrenceByCandidate.get(candidate.occurrenceCandidateReference);
      if (!occurrence) throw new CompletedSummerMaterializationError("generator_result_mismatch", "a billing-term candidate has no occurrence candidate");
      const [row] = await tx.insert(leagueOccurrenceBillingTerms).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        occurrenceId: occurrence.id,
        purpose: candidate.purpose,
        obligationPolicy: candidate.obligationPolicy,
        defaultAmountMinor: candidate.defaultAmountMinor,
        currency: candidate.currency,
        billingOrdinal: candidate.billingOrdinal,
        version: candidate.version,
        state: "published",
        currentRevision: 1,
        lastCommandId: publishCommand.id,
        publishedAt: actionTime,
        publishedByUserId: plan.approval.actorUserId,
        publicationCommandId: publishCommand.id,
      }).returning();
      if (!row) throw new CompletedSummerMaterializationError("transaction_failure", "a B2 billing term was not created");
      terms.push(row);
    }
    injectFailure(input.failureInjection, "after_billing_terms");

    const exceptions: LeagueScheduleException[] = [];
    for (const candidate of generation.exceptionCandidates) {
      const responsibleCommand = candidate.lifecycleIntent === "published" ? publishCommand : exceptionCommand;
      if (!responsibleCommand) throw new CompletedSummerMaterializationError("transaction_failure", "exception command attribution is missing");
      const [row] = await tx.insert(leagueScheduleExceptions).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        kind: candidate.kind,
        localDate: candidate.authoritativeLocalDate,
        timezone: candidate.timezone,
        source: candidate.source,
        lifecycle: candidate.lifecycleIntent,
        reason: candidate.reason,
        generationRunId: candidate.generationRunAssociationIntent === "associate" ? run.id : null,
        currentRevision: 1,
        lastCommandId: responsibleCommand.id,
        publishedAt: candidate.lifecycleIntent === "published" ? actionTime : null,
        publishedByUserId: candidate.lifecycleIntent === "published" ? plan.approval.actorUserId : null,
        publicationCommandId: candidate.lifecycleIntent === "published" ? publishCommand.id : null,
      }).returning();
      if (!row) throw new CompletedSummerMaterializationError("transaction_failure", "a B2 exception was not created");
      exceptions.push(row);
    }
    injectFailure(input.failureInjection, "after_exceptions");

    const occurrenceRevisions = [];
    for (const row of occurrences) {
      const [revision] = await tx.insert(leagueOccurrenceRevisions).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        occurrenceId: row.id,
        commandId: row.lastCommandId as string,
        revisionNumber: 1,
        snapshotSchemaVersion: COMPLETED_SUMMER_OCCURRENCE_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null,
        afterSnapshot: occurrenceSnapshot(row),
      }).returning({ id: leagueOccurrenceRevisions.id });
      if (!revision) throw new CompletedSummerMaterializationError("transaction_failure", "an occurrence initial revision was not created");
      occurrenceRevisions.push(revision.id);
    }
    const termRevisions = [];
    for (const row of terms) {
      const [revision] = await tx.insert(leagueOccurrenceBillingTermRevisions).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        billingTermId: row.id,
        commandId: row.lastCommandId as string,
        revisionNumber: 1,
        snapshotSchemaVersion: COMPLETED_SUMMER_BILLING_TERM_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null,
        afterSnapshot: billingTermSnapshot(row),
      }).returning({ id: leagueOccurrenceBillingTermRevisions.id });
      if (!revision) throw new CompletedSummerMaterializationError("transaction_failure", "a billing-term initial revision was not created");
      termRevisions.push(revision.id);
    }
    const exceptionRevisions = [];
    for (const row of exceptions) {
      const [revision] = await tx.insert(leagueScheduleExceptionRevisions).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        exceptionId: row.id,
        commandId: row.lastCommandId as string,
        revisionNumber: 1,
        snapshotSchemaVersion: COMPLETED_SUMMER_EXCEPTION_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null,
        afterSnapshot: exceptionSnapshot(row),
      }).returning({ id: leagueScheduleExceptionRevisions.id });
      if (!revision) throw new CompletedSummerMaterializationError("transaction_failure", "an exception initial revision was not created");
      exceptionRevisions.push(revision.id);
    }
    injectFailure(input.failureInjection, "after_revisions");

    const discrepancies: LeagueOccurrenceGenerationDiscrepancy[] = [];
    for (const finding of plan.persistedFindings) {
      const [row] = await tx.insert(leagueOccurrenceGenerationDiscrepancies).values({
        organizationId: plan.approval.organizationId,
        leagueId: plan.approval.leagueId,
        generationRunId: run.id,
        severity: finding.severity,
        code: finding.code,
        generationKey: finding.generationKey,
        details: finding.details,
        resolutionState: "open",
      }).returning();
      if (!row) throw new CompletedSummerMaterializationError("transaction_failure", "a B2 discrepancy was not created");
      discrepancies.push(row);
    }
    injectFailure(input.failureInjection, "after_discrepancies");
    return resultFromRows({
      plan,
      mode: "applied",
      commands: [...commandRows.values()],
      run,
      occurrences,
      terms,
      exceptions,
      occurrenceRevisionIds: occurrenceRevisions,
      billingTermRevisionIds: termRevisions,
      exceptionRevisionIds: exceptionRevisions,
      discrepancies,
    });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  } finally {
    await unlockLeagueScheduleSession(input.client, plan.approval.organizationId, plan.approval.leagueId);
  }
}
