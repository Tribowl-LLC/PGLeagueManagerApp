import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationDiscrepancyRevisions,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  games,
  paymentOperations,
  paymentSchedules,
  paymentObligations,
  paymentAllocations,
  canonicalCollectionGroupMembers,
  leagues,
  type LeagueOccurrence,
  type LeagueOccurrenceBillingTerm,
  type LeagueOccurrenceGenerationDiscrepancy,
  type LeagueOccurrenceGenerationRun,
  type LeagueScheduleCommand,
  type LeagueScheduleException,
  type PaymentMode,
} from "@shared/schema";
import {
  generateCanonicalOccurrences,
  type CanonicalGenerationResult,
  type CanonicalNormalizedInput,
} from "@shared/canonical-occurrence-generator";
import {
  CanonicalDstResolutionError,
  resolveCanonicalLocalDateTime,
} from "@shared/canonical-dst-resolver";
import {
  FALL_DRAFT_DISCREPANCY_REVISION_SNAPSHOT_VERSION,
  FALL_DRAFT_MUTATION_RESULT_VERSION,
  FALL_DRAFT_REVIEW_CONTRACT_VERSION,
  FALL_DRAFT_REVIEW_FINGERPRINT_VERSION,
  fallDraftReviewFingerprint,
  type FallDraftApproveRequest,
  type FallDraftCancelRequest,
  type FallDraftMutationResult,
  type FallDraftRejectRequest,
  type FallDraftRescheduleRequest,
  type FallDraftRestoreRequest,
  type FallDraftReview,
} from "@shared/fall-draft-review";
import {
  CANONICAL_DRAFT_REVIEW_CONTRACT_VERSION,
  CANONICAL_DRAFT_REVIEW_FINGERPRINT_VERSION,
  toCanonicalDraftReview,
} from "@shared/canonical-draft-review";
import {
  FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
  FALL_DRAFT_BILLING_ORDINAL_POLICY,
  FALL_DRAFT_CURRENCY,
  fallDraftRegularSessionBillingPolicyForPaymentMode,
  fallDraftCandidateSetFingerprint,
  fallDraftCanonicalJson,
  fallDraftSha256,
} from "@shared/fall-draft-generation";
import { db } from "../db.js";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";
import { materializeRosterPaymentOccurrenceInTransaction } from "./roster-payment-materializer.js";
import {
  buildCanonicalScheduleCommandFingerprint,
  getOrCreateCanonicalScheduleCommandInTransaction,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";
import {
  FALL_DRAFT_INPUT_SNAPSHOT_VERSION,
  authorizeFallDraftScope,
  currentFallDraftInputEvidence,
  fallDraftDatabaseTransactionTime,
  isCanonicalDraftInputSnapshotFamily,
  resolveCanonicalDraftInputSnapshot,
  type ResolvedFallDraftInputSnapshot,
  type FallDraftScope,
} from "./fall-draft-generation.js";

export type FallDraftReviewErrorCode =
  | "invalid_scope"
  | "unauthorized_actor"
  | "league_not_found"
  | "c1_run_not_found"
  | "incompatible_canonical_state"
  | "stale_review"
  | "revision_conflict"
  | "idempotency_conflict"
  | "effective_lock"
  | "terminal_state"
  | "activity_evidence"
  | "invalid_dst_input"
  | "same_day_collision"
  | "exact_start_collision"
  | "exception_collision"
  | "legacy_input_stale"
  | "discrepancy_disposition_invalid"
  | "transaction_failure";

export class FallDraftReviewError extends Error {
  readonly code: FallDraftReviewErrorCode;

  constructor(code: FallDraftReviewErrorCode, message: string) {
    super(message);
    this.name = "FallDraftReviewError";
    this.code = code;
  }
}

export type FallDraftReviewFailureStage =
  | "after_commands"
  | "after_occurrences"
  | "after_billing_terms"
  | "after_exceptions"
  | "after_discrepancies"
  | "after_generation_run";

interface ReviewRows {
  run: LeagueOccurrenceGenerationRun;
  snapshot: ResolvedFallDraftInputSnapshot;
  generation: CanonicalGenerationResult;
  commands: LeagueScheduleCommand[];
  occurrences: LeagueOccurrence[];
  billingTerms: LeagueOccurrenceBillingTerm[];
  exceptions: LeagueScheduleException[];
  discrepancies: LeagueOccurrenceGenerationDiscrepancy[];
  occurrenceRevisions: Array<typeof leagueOccurrenceRevisions.$inferSelect>;
  billingTermRevisions: Array<typeof leagueOccurrenceBillingTermRevisions.$inferSelect>;
  exceptionRevisions: Array<typeof leagueScheduleExceptionRevisions.$inferSelect>;
  discrepancyRevisions: Array<typeof leagueOccurrenceGenerationDiscrepancyRevisions.$inferSelect>;
  activityOccurrenceIds: Set<string>;
}

type MutationRequest = FallDraftRescheduleRequest | FallDraftCancelRequest | FallDraftRestoreRequest
  | FallDraftApproveRequest | FallDraftRejectRequest;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeInstant(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function injectFailure(requested: FallDraftReviewFailureStage | undefined, stage: FallDraftReviewFailureStage): void {
  if (requested === stage) throw new FallDraftReviewError("transaction_failure", `injected C2 failure at ${stage}`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return fallDraftCanonicalJson(left) === fallDraftCanonicalJson(right);
}

function occurrenceSnapshot(row: LeagueOccurrence): Record<string, unknown> {
  return {
    snapshotContractVersion: "fall-draft-occurrence-revision/1",
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
    publishedAt: normalizeInstant(row.publishedAt),
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    lockedAt: normalizeInstant(row.lockedAt),
    lockedByUserId: row.lockedByUserId,
    lockReason: row.lockReason,
    lockCommandId: row.lockCommandId,
    cancelledAt: normalizeInstant(row.cancelledAt),
    cancelledByUserId: row.cancelledByUserId,
    cancellationCommandId: row.cancellationCommandId,
    completedAt: normalizeInstant(row.completedAt),
    completedByUserId: row.completedByUserId,
    completionCommandId: row.completionCommandId,
    discardedAt: normalizeInstant(row.discardedAt),
    discardedByUserId: row.discardedByUserId,
    discardCommandId: row.discardCommandId,
  };
}

function billingTermSnapshot(row: LeagueOccurrenceBillingTerm): Record<string, unknown> {
  return {
    snapshotContractVersion: "fall-draft-billing-term-revision/1",
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
    publishedAt: normalizeInstant(row.publishedAt),
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    supersededAt: normalizeInstant(row.supersededAt),
    supersededByCommandId: row.supersededByCommandId,
  };
}

function exceptionSnapshot(row: LeagueScheduleException): Record<string, unknown> {
  return {
    snapshotContractVersion: "fall-draft-exception-revision/1",
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
    publishedAt: normalizeInstant(row.publishedAt),
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    revokedAt: normalizeInstant(row.revokedAt),
    revokedByUserId: row.revokedByUserId,
    revocationCommandId: row.revocationCommandId,
  };
}

function discrepancySnapshot(row: LeagueOccurrenceGenerationDiscrepancy): Record<string, unknown> {
  return {
    snapshotContractVersion: "fall-draft-discrepancy-revision/1",
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    generationRunId: row.generationRunId,
    severity: row.severity,
    code: row.code,
    generationKey: row.generationKey,
    details: row.details,
    resolutionState: row.resolutionState,
    resolutionCommandId: row.resolutionCommandId,
    resolvedAt: normalizeInstant(row.resolvedAt),
  };
}

function assertRevisionChain<T extends { revisionNumber: number; beforeSnapshot: unknown; afterSnapshot: unknown }>(
  rows: T[],
  currentRevision: number,
  currentSnapshot: unknown,
  entity: string,
): void {
  const sorted = [...rows].sort((left, right) => left.revisionNumber - right.revisionNumber);
  if (sorted.length !== currentRevision || sorted.some((row, index) => row.revisionNumber !== index + 1)) {
    throw new FallDraftReviewError("incompatible_canonical_state", `${entity} has an incomplete revision chain`);
  }
  if (sorted[0]?.beforeSnapshot !== null) {
    throw new FallDraftReviewError("incompatible_canonical_state", `${entity} initial revision must have a null before snapshot`);
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (!sameValue(sorted[index]?.beforeSnapshot, sorted[index - 1]?.afterSnapshot)) {
      throw new FallDraftReviewError("incompatible_canonical_state", `${entity} revision snapshots do not form an append-only chain`);
    }
  }
  if (!sameValue(sorted.at(-1)?.afterSnapshot, currentSnapshot)) {
    throw new FallDraftReviewError("incompatible_canonical_state", `${entity} current row does not match its latest revision`);
  }
}

async function loadRows(tx: LeagueScheduleTransaction, scope: FallDraftScope, lock: boolean): Promise<ReviewRows> {
  const [league] = await tx.select({ paymentMode: leagues.paymentMode }).from(leagues).where(and(
    eq(leagues.id, scope.leagueId),
    eq(leagues.organizationId, scope.organizationId),
  )).limit(1);
  if (!league) throw new FallDraftReviewError("league_not_found", "league does not exist in the authorized organization");
  if (league.paymentMode !== "weekly" && league.paymentMode !== "upfront") {
    throw new FallDraftReviewError("incompatible_canonical_state", "league payment timing is unsupported");
  }
  const paymentMode: PaymentMode = league.paymentMode;
  const runsQuery = tx.select().from(leagueOccurrenceGenerationRuns).where(and(
    eq(leagueOccurrenceGenerationRuns.organizationId, scope.organizationId),
    eq(leagueOccurrenceGenerationRuns.leagueId, scope.leagueId),
  )).orderBy(asc(leagueOccurrenceGenerationRuns.sourceScheduleRevision));
  const runs = lock ? await runsQuery.for("update") : await runsQuery;
  const resolvedRuns = runs.map((run) => ({
    run,
    snapshot: resolveCanonicalDraftInputSnapshot(run.normalizedInputSnapshot, paymentMode),
  }));
  if (resolvedRuns.some(({ run, snapshot }) => isCanonicalDraftInputSnapshotFamily(run.normalizedInputSnapshot)
    && snapshot === null)) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the league contains an unsupported or semantically incompatible C1 input snapshot");
  }
  const expectedFamily = scope.draftContractFamily ?? "fall";
  const c1Runs = resolvedRuns.filter((entry): entry is {
    run: LeagueOccurrenceGenerationRun;
    snapshot: ResolvedFallDraftInputSnapshot;
  } => entry.snapshot !== null && entry.snapshot.draftContractFamily === expectedFamily);
  if (c1Runs.length === 0) throw new FallDraftReviewError("c1_run_not_found", "no C1 Fall generation run exists for this league");
  if (c1Runs.length !== 1) throw new FallDraftReviewError("incompatible_canonical_state", "multiple C1 Fall generation runs exist for this league");
  if (runs.length !== 1) throw new FallDraftReviewError("incompatible_canonical_state", "the C1 league contains a foreign or replacement generation run");
  const { run, snapshot } = c1Runs[0];
  if (snapshot.normalizedInput.ambiguousFold !== FALL_DRAFT_AMBIGUOUS_FOLD_POLICY
    || snapshot.normalizedInput.currency !== FALL_DRAFT_CURRENCY
    || snapshot.normalizedInput.regularSessionBillingPolicy
      !== fallDraftRegularSessionBillingPolicyForPaymentMode(snapshot.paymentMode)) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the C1 snapshot does not match the authoritative Fall system policy");
  }
  const generation = generateCanonicalOccurrences(snapshot.normalizedInput as Parameters<typeof generateCanonicalOccurrences>[0]);
  if (generation.fatalErrors.length > 0 || generation.inputFingerprint !== run.inputFingerprint
    || generation.generatorVersion !== run.generatorVersion
    || fallDraftCandidateSetFingerprint(generation) !== snapshot.candidateSetFingerprint) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the persisted C1 input no longer regenerates exactly");
  }

  const commandsQuery = tx.select().from(leagueScheduleCommands).where(and(
    eq(leagueScheduleCommands.organizationId, scope.organizationId), eq(leagueScheduleCommands.leagueId, scope.leagueId),
  )).orderBy(asc(leagueScheduleCommands.id));
  const occurrencesQuery = tx.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, scope.organizationId), eq(leagueOccurrences.leagueId, scope.leagueId),
    eq(leagueOccurrences.generationRunId, run.id),
  )).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(leagueOccurrences.id));
  const exceptionsQuery = tx.select().from(leagueScheduleExceptions).where(and(
    eq(leagueScheduleExceptions.organizationId, scope.organizationId), eq(leagueScheduleExceptions.leagueId, scope.leagueId),
    eq(leagueScheduleExceptions.generationRunId, run.id),
  )).orderBy(asc(leagueScheduleExceptions.localDate), asc(leagueScheduleExceptions.id));
  const discrepanciesQuery = tx.select().from(leagueOccurrenceGenerationDiscrepancies).where(and(
    eq(leagueOccurrenceGenerationDiscrepancies.organizationId, scope.organizationId),
    eq(leagueOccurrenceGenerationDiscrepancies.leagueId, scope.leagueId),
    eq(leagueOccurrenceGenerationDiscrepancies.generationRunId, run.id),
  )).orderBy(asc(leagueOccurrenceGenerationDiscrepancies.id));
  const commands = lock ? await commandsQuery.for("update") : await commandsQuery;
  const occurrences = lock ? await occurrencesQuery.for("update") : await occurrencesQuery;
  const exceptions = lock ? await exceptionsQuery.for("update") : await exceptionsQuery;
  const discrepancies = lock ? await discrepanciesQuery.for("update") : await discrepanciesQuery;
  if (occurrences.length !== generation.occurrenceCandidates.length || exceptions.length !== generation.exceptionCandidates.length
    || discrepancies.length !== generation.discrepancies.length) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the C1 run contains partial or extra durable entities");
  }
  const occurrenceIds = occurrences.map((row) => row.id);
  const billingTermsQuery = tx.select().from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, scope.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, scope.leagueId),
    inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
  )).orderBy(asc(leagueOccurrenceBillingTerms.id));
  const occurrenceRevisionsQuery = tx.select().from(leagueOccurrenceRevisions).where(and(
    eq(leagueOccurrenceRevisions.organizationId, scope.organizationId), eq(leagueOccurrenceRevisions.leagueId, scope.leagueId),
    inArray(leagueOccurrenceRevisions.occurrenceId, occurrenceIds),
  )).orderBy(asc(leagueOccurrenceRevisions.occurrenceId), asc(leagueOccurrenceRevisions.revisionNumber));
  const billingTerms = lock ? await billingTermsQuery.for("update") : await billingTermsQuery;
  const billingTermIds = billingTerms.map((row) => row.id);
  const exceptionIds = exceptions.map((row) => row.id);
  const discrepancyIds = discrepancies.map((row) => row.id);
  const billingTermRevisionsQuery = tx.select().from(leagueOccurrenceBillingTermRevisions).where(and(
    eq(leagueOccurrenceBillingTermRevisions.organizationId, scope.organizationId),
    eq(leagueOccurrenceBillingTermRevisions.leagueId, scope.leagueId),
    inArray(leagueOccurrenceBillingTermRevisions.billingTermId, billingTermIds),
  )).orderBy(asc(leagueOccurrenceBillingTermRevisions.billingTermId), asc(leagueOccurrenceBillingTermRevisions.revisionNumber));
  const exceptionRevisionsQuery = tx.select().from(leagueScheduleExceptionRevisions).where(and(
    eq(leagueScheduleExceptionRevisions.organizationId, scope.organizationId),
    eq(leagueScheduleExceptionRevisions.leagueId, scope.leagueId),
    inArray(leagueScheduleExceptionRevisions.exceptionId, exceptionIds),
  )).orderBy(asc(leagueScheduleExceptionRevisions.exceptionId), asc(leagueScheduleExceptionRevisions.revisionNumber));
  const discrepancyRevisionsQuery = discrepancyIds.length === 0 ? null : tx.select()
    .from(leagueOccurrenceGenerationDiscrepancyRevisions).where(and(
      eq(leagueOccurrenceGenerationDiscrepancyRevisions.organizationId, scope.organizationId),
      eq(leagueOccurrenceGenerationDiscrepancyRevisions.leagueId, scope.leagueId),
      inArray(leagueOccurrenceGenerationDiscrepancyRevisions.discrepancyId, discrepancyIds),
    )).orderBy(
      asc(leagueOccurrenceGenerationDiscrepancyRevisions.discrepancyId),
      asc(leagueOccurrenceGenerationDiscrepancyRevisions.revisionNumber),
    );
  const occurrenceRevisions = lock ? await occurrenceRevisionsQuery.for("update") : await occurrenceRevisionsQuery;
  const billingTermRevisions = lock ? await billingTermRevisionsQuery.for("update") : await billingTermRevisionsQuery;
  const exceptionRevisions = lock ? await exceptionRevisionsQuery.for("update") : await exceptionRevisionsQuery;
  const discrepancyRevisions = discrepancyRevisionsQuery
    ? lock ? await discrepancyRevisionsQuery.for("update") : await discrepancyRevisionsQuery
    : [];
  const relationshipsQuery = tx.select({ id: leagueOccurrenceRelationships.id }).from(leagueOccurrenceRelationships).where(and(
    eq(leagueOccurrenceRelationships.organizationId, scope.organizationId),
    eq(leagueOccurrenceRelationships.leagueId, scope.leagueId),
  ));
  const relationships = lock ? await relationshipsQuery.for("update") : await relationshipsQuery;
  const allOccurrenceIdsQuery = tx.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, scope.organizationId), eq(leagueOccurrences.leagueId, scope.leagueId),
  ));
  const allExceptionIdsQuery = tx.select({ id: leagueScheduleExceptions.id }).from(leagueScheduleExceptions).where(and(
    eq(leagueScheduleExceptions.organizationId, scope.organizationId), eq(leagueScheduleExceptions.leagueId, scope.leagueId),
  ));
  const allBillingTermIdsQuery = tx.select({ id: leagueOccurrenceBillingTerms.id }).from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, scope.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, scope.leagueId),
  ));
  const allOccurrenceIds = lock ? await allOccurrenceIdsQuery.for("update") : await allOccurrenceIdsQuery;
  const allExceptionIds = lock ? await allExceptionIdsQuery.for("update") : await allExceptionIdsQuery;
  const allBillingTermIds = lock ? await allBillingTermIdsQuery.for("update") : await allBillingTermIdsQuery;
  if (relationships.length > 0 || billingTerms.length !== occurrences.length
    || allOccurrenceIds.length !== occurrences.length || allExceptionIds.length !== exceptions.length
    || allBillingTermIds.length !== billingTerms.length) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the C1 run contains unsupported relationships or incomplete billing terms");
  }
  const linkedGames = occurrenceIds.length === 0 ? [] : await tx.select({ occurrenceId: games.occurrenceId })
    .from(games)
    .where(and(
      eq(games.leagueId, scope.leagueId),
      inArray(games.occurrenceId, occurrenceIds),
    ));
  const linkedOperations = occurrenceIds.length === 0 ? [] : await tx.select({
    occurrenceId: paymentOperations.triggerOccurrenceId,
    scheduleLeagueId: paymentSchedules.leagueId,
  }).from(paymentOperations).innerJoin(
    paymentSchedules,
    eq(paymentSchedules.id, paymentOperations.paymentScheduleId),
  ).where(and(
    eq(paymentOperations.organizationId, scope.organizationId),
    inArray(paymentOperations.triggerOccurrenceId, occurrenceIds),
  ));
  if (linkedOperations.some((row) => row.scheduleLeagueId !== scope.leagueId)) {
    throw new FallDraftReviewError(
      "incompatible_canonical_state",
      "a linked scheduled operation contradicts the occurrence league",
    );
  }
  const d2ActivityIds = occurrenceIds.length === 0 ? [] : [
    ...(await tx.select({ occurrenceId: paymentObligations.occurrenceId })
      .from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, scope.organizationId),
        eq(paymentObligations.leagueId, scope.leagueId),
        inArray(paymentObligations.occurrenceId, occurrenceIds),
      ))),
    ...(await tx.select({ occurrenceId: paymentObligations.occurrenceId })
      .from(paymentAllocations).innerJoin(paymentObligations, and(
        eq(paymentObligations.id, paymentAllocations.obligationId),
        eq(paymentObligations.organizationId, scope.organizationId),
        eq(paymentObligations.leagueId, scope.leagueId),
      )).where(and(
        eq(paymentAllocations.organizationId, scope.organizationId),
        eq(paymentAllocations.leagueId, scope.leagueId),
        eq(paymentAllocations.state, "active"),
        inArray(paymentObligations.occurrenceId, occurrenceIds),
      ))),
    ...(await tx.select({ occurrenceId: canonicalCollectionGroupMembers.occurrenceId })
      .from(canonicalCollectionGroupMembers).where(and(
        eq(canonicalCollectionGroupMembers.organizationId, scope.organizationId),
        eq(canonicalCollectionGroupMembers.leagueId, scope.leagueId),
        eq(canonicalCollectionGroupMembers.active, true),
        inArray(canonicalCollectionGroupMembers.occurrenceId, occurrenceIds),
      ))),
  ];
  const activityOccurrenceIds = new Set<string>([
    ...linkedGames.flatMap((row) => row.occurrenceId === null ? [] : [row.occurrenceId]),
    ...linkedOperations.flatMap((row) => row.occurrenceId === null ? [] : [row.occurrenceId]),
    ...d2ActivityIds.flatMap((row) => row.occurrenceId === null ? [] : [row.occurrenceId]),
  ]);
  const commandType = (commandId: string | null): string | null =>
    commandId === null ? null : commands.find((command) => command.id === commandId)?.commandType ?? null;
  if (commandType(run.originatingCommandId) !== "generate"
    || (run.approvalCommandId !== null && commandType(run.approvalCommandId) !== "approve_generation")
    || (run.rejectionCommandId !== null && commandType(run.rejectionCommandId) !== "reject_generation")) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the C1 generation lifecycle has untruthful command attribution");
  }
  const allRevisionCommandIds = [
    ...occurrenceRevisions.map((row) => row.commandId),
    ...billingTermRevisions.map((row) => row.commandId),
    ...exceptionRevisions.map((row) => row.commandId),
    ...discrepancyRevisions.map((row) => row.commandId),
  ];
  if (allRevisionCommandIds.some((commandId) => commandType(commandId) === null)) {
    throw new FallDraftReviewError("incompatible_canonical_state", "a C1/C2 revision has missing or foreign command attribution");
  }
  for (const row of occurrences) {
    if (!generation.occurrenceCandidates.some((candidate) => candidate.generationKey === row.generationKey)
      || row.generationRunId !== run.id) {
      throw new FallDraftReviewError("incompatible_canonical_state", "an occurrence is not proven to belong to the C1 generation set");
    }
    if (commandType(row.lastCommandId) === null
      || (row.publicationCommandId !== null && commandType(row.publicationCommandId) !== "publish")
      || (row.cancellationCommandId !== null && commandType(row.cancellationCommandId) !== "cancel")
      || (row.discardCommandId !== null && !["discard_draft", "reject_generation"].includes(commandType(row.discardCommandId) ?? ""))) {
      throw new FallDraftReviewError("incompatible_canonical_state", "an occurrence has untruthful lifecycle command attribution");
    }
    assertRevisionChain(
      occurrenceRevisions.filter((revision) => revision.occurrenceId === row.id),
      row.currentRevision,
      occurrenceSnapshot(row),
      `occurrence ${row.id}`,
    );
  }
  for (const row of billingTerms) {
    if (commandType(row.lastCommandId) === null
      || (row.publicationCommandId !== null && commandType(row.publicationCommandId) !== "publish")
      || (row.supersededByCommandId !== null && !["discard_draft", "reject_generation"].includes(commandType(row.supersededByCommandId) ?? ""))) {
      throw new FallDraftReviewError("incompatible_canonical_state", "a billing term has untruthful lifecycle command attribution");
    }
    assertRevisionChain(
      billingTermRevisions.filter((revision) => revision.billingTermId === row.id),
      row.currentRevision,
      billingTermSnapshot(row),
      `billing term ${row.id}`,
    );
  }
  for (const row of exceptions) {
    if (commandType(row.lastCommandId) === null
      || (row.publicationCommandId !== null && commandType(row.publicationCommandId) !== "publish")
      || (row.revocationCommandId !== null && !["revoke_exception", "reject_generation"].includes(commandType(row.revocationCommandId) ?? ""))) {
      throw new FallDraftReviewError("incompatible_canonical_state", "a schedule exception has untruthful lifecycle command attribution");
    }
    assertRevisionChain(
      exceptionRevisions.filter((revision) => revision.exceptionId === row.id),
      row.currentRevision,
      exceptionSnapshot(row),
      `schedule exception ${row.id}`,
    );
  }
  for (const row of discrepancies) {
    const revisions = discrepancyRevisions.filter((revision) => revision.discrepancyId === row.id);
    if (row.resolutionState === "open") {
      if (revisions.length !== 0 || row.resolutionCommandId !== null || row.resolvedAt !== null) {
        throw new FallDraftReviewError("incompatible_canonical_state", "an open discrepancy has unexpected resolution audit state");
      }
      continue;
    }
    if (revisions.length !== 1 || revisions[0]?.revisionNumber !== 1
      || !sameValue(revisions[0]?.afterSnapshot, discrepancySnapshot(row))
      || revisions[0]?.commandId !== row.resolutionCommandId
      || commandType(row.resolutionCommandId) !== "approve_generation") {
      throw new FallDraftReviewError("incompatible_canonical_state", "a discrepancy resolution has an incomplete append-only audit revision");
    }
  }
  return {
    run, snapshot, generation, commands, occurrences, billingTerms, exceptions, discrepancies,
    occurrenceRevisions, billingTermRevisions, exceptionRevisions, discrepancyRevisions,
    activityOccurrenceIds,
  };
}

function discrepancyEvidence(row: LeagueOccurrenceGenerationDiscrepancy, rows: ReviewRows): { evidence: unknown; canResolve: boolean } {
  const seasonEnd = rows.generation.normalizedInput.seasonEnd;
  const activeDates = rows.occurrences
    .filter((occurrence) => occurrence.status !== "discarded")
    .map((occurrence) => occurrence.authoritativeLocalDate)
    .sort(compareStrings);
  const finalDate = activeDates.at(-1) ?? null;
  if (row.code === "outside_season_occurrence") {
    const outsideDates = activeDates.filter((date) => date > seasonEnd);
    return { evidence: { expectedSeasonEnd: seasonEnd, outsideDates }, canResolve: outsideDates.length === 0 };
  }
  if (row.code === "total_week_mismatch") {
    return { evidence: { expectedSeasonEnd: seasonEnd, currentFinalDate: finalDate }, canResolve: finalDate === seasonEnd };
  }
  return { evidence: { unsupportedCode: row.code }, canResolve: false };
}

async function buildReview(
  tx: LeagueScheduleTransaction,
  scope: FallDraftScope,
  rows: ReviewRows,
  transactionTime: string,
): Promise<FallDraftReview> {
  const legacy = await currentFallDraftInputEvidence(
    tx,
    rows.snapshot.draftContractFamily === "future_season"
      ? { ...scope, draftContractFamily: "future_season", draftSeasonClassification: rows.snapshot.seasonClassification }
      : scope,
    rows.generation.normalizedInput,
    rows.snapshot.paymentMode,
  );
  const reviewWithoutFingerprint: Omit<FallDraftReview, "reviewFingerprint"> = {
    reviewContractVersion: FALL_DRAFT_REVIEW_CONTRACT_VERSION,
    reviewFingerprintVersion: FALL_DRAFT_REVIEW_FINGERPRINT_VERSION,
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    generationRun: {
      id: rows.run.id,
      state: rows.run.state,
      originatingCommandId: rows.run.originatingCommandId,
      generatorVersion: rows.run.generatorVersion,
      inputFingerprint: rows.run.inputFingerprint,
      sourceScheduleRevision: rows.run.sourceScheduleRevision,
      normalizedInputSnapshot: rows.run.normalizedInputSnapshot,
      rangeStartDate: rows.run.rangeStartDate,
      rangeEndDate: rows.run.rangeEndDate,
      candidateOccurrenceCount: rows.run.candidateOccurrenceCount,
      generatedOccurrenceCount: rows.run.generatedOccurrenceCount,
      skippedDateCount: rows.run.skippedDateCount,
      discrepancyCount: rows.run.discrepancyCount,
      approvedAt: normalizeInstant(rows.run.approvedAt),
      approvedByUserId: rows.run.approvedByUserId,
      approvalCommandId: rows.run.approvalCommandId,
      rejectedAt: normalizeInstant(rows.run.rejectedAt),
      rejectedByUserId: rows.run.rejectedByUserId,
      rejectionReason: rows.run.rejectionReason,
      rejectionCommandId: rows.run.rejectionCommandId,
      supersededAt: normalizeInstant(rows.run.supersededAt),
      supersededByCommandId: rows.run.supersededByCommandId,
    },
    c1: {
      inputSnapshotVersion: rows.snapshot.snapshotContractVersion,
      paymentMode: rows.snapshot.paymentMode,
      confirmedPreviewFingerprint: rows.snapshot.confirmedPreviewFingerprint,
      candidateSetFingerprint: rows.snapshot.candidateSetFingerprint,
      inputFingerprint: rows.generation.inputFingerprint,
      physicalScheduleFingerprint: rows.generation.physicalScheduleFingerprint,
      generatorVersion: rows.generation.generatorVersion,
      resultContractVersion: rows.generation.resultContractVersion,
      dstResolverVersion: rows.generation.resolverVersion,
    },
    currentLegacyInput: {
      matches: legacy.matches,
      currentInputFingerprint: legacy.currentInputFingerprint,
      generatedInputFingerprint: rows.generation.inputFingerprint,
    },
    occurrences: rows.occurrences.map((row) => ({
      id: row.id,
      generationKey: row.generationKey,
      generationRunId: row.generationRunId,
      locationId: row.locationId,
      kind: row.kind,
      status: row.status,
      lifecycle: row.lifecycle,
      authoritativeLocalDate: row.authoritativeLocalDate,
      authoritativeLocalStartTime: row.authoritativeLocalStartTime,
      timezone: row.timezone,
      startAt: normalizeInstant(row.startAt) as string,
      selectedUtcOffsetMinutes: row.selectedUtcOffsetMinutes,
      foldResolution: row.foldResolution,
      resolverVersion: row.resolverVersion,
      plannedOrdinal: row.plannedOrdinal,
      competitionNumber: row.competitionNumber,
      competitive: row.competitive,
      countsInStandings: row.countsInStandings,
      currentRevision: row.currentRevision,
      lastCommandId: row.lastCommandId,
      publishedAt: normalizeInstant(row.publishedAt),
      publishedByUserId: row.publishedByUserId,
      publicationCommandId: row.publicationCommandId,
      cancelledAt: normalizeInstant(row.cancelledAt),
      cancelledByUserId: row.cancelledByUserId,
      cancellationCommandId: row.cancellationCommandId,
      lockedAt: normalizeInstant(row.lockedAt),
      lockedByUserId: row.lockedByUserId,
      lockReason: row.lockReason,
      lockCommandId: row.lockCommandId,
      completedAt: normalizeInstant(row.completedAt),
      completedByUserId: row.completedByUserId,
      completionCommandId: row.completionCommandId,
      discardedAt: normalizeInstant(row.discardedAt),
      discardedByUserId: row.discardedByUserId,
      discardCommandId: row.discardCommandId,
      effectivelyLocked: row.lifecycle === "locked" || row.lockedAt !== null
        || Date.parse(row.startAt) <= Date.parse(transactionTime)
        || rows.activityOccurrenceIds.has(row.id),
      revisions: rows.occurrenceRevisions.filter((revision) => revision.occurrenceId === row.id).map((revision) => ({
        id: revision.id,
        occurrenceId: revision.occurrenceId,
        commandId: revision.commandId,
        revisionNumber: revision.revisionNumber,
        snapshotSchemaVersion: revision.snapshotSchemaVersion,
        beforeSnapshot: revision.beforeSnapshot,
        afterSnapshot: revision.afterSnapshot,
      })),
    })),
    billingTerms: rows.billingTerms.map((row) => ({
      id: row.id,
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
      publishedAt: normalizeInstant(row.publishedAt),
      publishedByUserId: row.publishedByUserId,
      publicationCommandId: row.publicationCommandId,
      supersededAt: normalizeInstant(row.supersededAt),
      supersededByCommandId: row.supersededByCommandId,
      revisions: rows.billingTermRevisions.filter((revision) => revision.billingTermId === row.id).map((revision) => ({
        id: revision.id,
        billingTermId: revision.billingTermId,
        commandId: revision.commandId,
        revisionNumber: revision.revisionNumber,
        snapshotSchemaVersion: revision.snapshotSchemaVersion,
        beforeSnapshot: revision.beforeSnapshot,
        afterSnapshot: revision.afterSnapshot,
      })),
    })),
    scheduleExceptions: rows.exceptions.map((row) => ({
      id: row.id,
      kind: row.kind,
      localDate: row.localDate,
      timezone: row.timezone,
      source: row.source,
      lifecycle: row.lifecycle,
      reason: row.reason,
      generationRunId: row.generationRunId,
      currentRevision: row.currentRevision,
      lastCommandId: row.lastCommandId,
      publishedAt: normalizeInstant(row.publishedAt),
      publishedByUserId: row.publishedByUserId,
      publicationCommandId: row.publicationCommandId,
      revokedAt: normalizeInstant(row.revokedAt),
      revokedByUserId: row.revokedByUserId,
      revocationCommandId: row.revocationCommandId,
      revisions: rows.exceptionRevisions.filter((revision) => revision.exceptionId === row.id).map((revision) => ({
        id: revision.id,
        exceptionId: revision.exceptionId,
        commandId: revision.commandId,
        revisionNumber: revision.revisionNumber,
        snapshotSchemaVersion: revision.snapshotSchemaVersion,
        beforeSnapshot: revision.beforeSnapshot,
        afterSnapshot: revision.afterSnapshot,
      })),
    })),
    discrepancies: rows.discrepancies.map((row) => {
      const current = discrepancyEvidence(row, rows);
      return {
        id: row.id,
        severity: row.severity,
        code: row.code,
        generationKey: row.generationKey,
        details: row.details,
        resolutionState: row.resolutionState,
        resolutionCommandId: row.resolutionCommandId,
        resolvedAt: normalizeInstant(row.resolvedAt),
        currentEvidence: current.evidence,
        canResolve: current.canResolve,
        revisions: rows.discrepancyRevisions.filter((revision) => revision.discrepancyId === row.id).map((revision) => ({
          id: revision.id,
          discrepancyId: revision.discrepancyId,
          commandId: revision.commandId,
          revisionNumber: revision.revisionNumber,
          snapshotSchemaVersion: revision.snapshotSchemaVersion,
          beforeSnapshot: revision.beforeSnapshot,
          afterSnapshot: revision.afterSnapshot,
        })),
      };
    }),
    commands: rows.commands.map((row) => ({
      id: row.id,
      commandType: row.commandType,
      actorUserId: row.actorUserId,
      reason: row.reason,
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
      sameDayOverride: row.sameDayOverride,
      outcome: row.outcome,
    })),
  };
  return { ...reviewWithoutFingerprint, reviewFingerprint: fallDraftReviewFingerprint(reviewWithoutFingerprint) };
}

function assertReview(scope: FallDraftScope, review: FallDraftReview, confirmed: string): void {
  const currentFingerprint = scope.draftContractFamily === "future_season"
    ? toCanonicalDraftReview(review, scope.draftSeasonClassification ?? "Fall").reviewFingerprint
    : review.reviewFingerprint;
  if (currentFingerprint !== confirmed) {
    throw new FallDraftReviewError("stale_review", "the confirmed C2 review fingerprint no longer matches durable state");
  }
}

function assertFuture(row: LeagueOccurrence, transactionTime: string, rows: ReviewRows): void {
  if (row.lifecycle === "locked" || row.lockedAt !== null
    || Date.parse(row.startAt) <= Date.parse(transactionTime)
    || rows.activityOccurrenceIds.has(row.id)) {
    throw new FallDraftReviewError("effective_lock", "the occurrence is locked as soon as its authoritative start instant is reached");
  }
}

function assertExpectedRevision(row: LeagueOccurrence, expected: number): void {
  if (row.currentRevision !== expected) {
    throw new FallDraftReviewError("revision_conflict", "the occurrence revision changed after review");
  }
}

function commandRequest(
  scope: FallDraftScope,
  request: MutationRequest,
  commandType: MaterializationScheduleCommandRequest["commandType"],
  idempotencyKey = request.idempotencyKey,
  role: string = commandType,
): MaterializationScheduleCommandRequest {
  const genericContext = scope.draftContractFamily === "future_season"
    ? scope.draftReviewRequestContext
    : undefined;
  if (scope.draftContractFamily === "future_season" && !genericContext) {
    throw new FallDraftReviewError("transaction_failure", "generic review request context is missing");
  }
  const requestWithContract = genericContext
    ? {
      ...request,
      contractVersion: genericContext.contractVersion,
      confirmedReviewFingerprint: genericContext.confirmedReviewFingerprint,
    }
    : request;
  const normalizedRequest = "discrepancyDispositions" in requestWithContract
    ? {
      ...requestWithContract,
      discrepancyDispositions: [...requestWithContract.discrepancyDispositions]
        .sort((left, right) => compareStrings(left.discrepancyId, right.discrepancyId)),
    }
    : requestWithContract;
  const materializationPayload = {
    reviewContractVersion: genericContext ? CANONICAL_DRAFT_REVIEW_CONTRACT_VERSION : FALL_DRAFT_REVIEW_CONTRACT_VERSION,
    reviewFingerprintVersion: genericContext ? CANONICAL_DRAFT_REVIEW_FINGERPRINT_VERSION : FALL_DRAFT_REVIEW_FINGERPRINT_VERSION,
    operation: role,
    request: normalizedRequest,
  };
  const base: MaterializationScheduleCommandRequest = {
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    actorUserId: scope.actorUserId,
    commandType,
    reason: request.reason,
    idempotencyKey,
    requestFingerprint: "",
    materializationOperation: genericContext ? "canonical_draft_review" : "fall_draft_review",
    materializationPayload,
  };
  return { ...base, requestFingerprint: buildCanonicalScheduleCommandFingerprint(base) };
}

function exactRevisionEntityIds(rows: ReviewRows, commandId: string): string[] {
  const occurrenceIds = [...new Set(rows.occurrenceRevisions
    .filter((row) => row.commandId === commandId).map((row) => row.occurrenceId))];
  const billingTermIds = [...new Set(rows.billingTermRevisions
    .filter((row) => row.commandId === commandId).map((row) => row.billingTermId))];
  const exceptionIds = [...new Set(rows.exceptionRevisions
    .filter((row) => row.commandId === commandId).map((row) => row.exceptionId))];
  const discrepancyIds = [...new Set(rows.discrepancyRevisions
    .filter((row) => row.commandId === commandId).map((row) => row.discrepancyId))];
  if (occurrenceIds.some((id) => rows.occurrences.find((row) => row.id === id)?.lastCommandId !== commandId)
    || billingTermIds.some((id) => rows.billingTerms.find((row) => row.id === id)?.lastCommandId !== commandId)
    || exceptionIds.some((id) => rows.exceptions.find((row) => row.id === id)?.lastCommandId !== commandId)
    || discrepancyIds.some((id) => rows.discrepancies.find((row) => row.id === id)?.resolutionCommandId !== commandId)) {
    throw new FallDraftReviewError("incompatible_canonical_state", "the committed C2 result was superseded");
  }
  return [...occurrenceIds, ...billingTermIds, ...exceptionIds, ...discrepancyIds];
}

function relatedIdempotencyKey(scope: FallDraftScope, key: string, role: string): string {
  const namespace = scope.draftContractFamily === "future_season" ? "lve4c2" : "lvc2";
  return `${namespace}:${fallDraftSha256({ organizationId: scope.organizationId, leagueId: scope.leagueId, key, role })}`;
}

function existingCommand(rows: ReviewRows, request: MaterializationScheduleCommandRequest): LeagueScheduleCommand | null {
  const existing = rows.commands.find((row) => row.idempotencyKey === request.idempotencyKey) ?? null;
  if (!existing) return null;
  if (existing.organizationId !== request.organizationId || existing.leagueId !== request.leagueId
    || existing.actorUserId !== request.actorUserId || existing.commandType !== request.commandType
    || existing.reason !== request.reason || existing.requestFingerprint !== request.requestFingerprint
    || existing.sameDayOverride || existing.outcome !== "applied") {
    throw new FallDraftReviewError("idempotency_conflict", "the idempotency key is bound to a different C2 request");
  }
  return existing;
}

function mutationResult(
  operation: FallDraftMutationResult["operation"],
  mode: FallDraftMutationResult["mode"],
  commandIds: string[],
  entityIds: string[],
  review: FallDraftReview,
): FallDraftMutationResult {
  return {
    resultContractVersion: FALL_DRAFT_MUTATION_RESULT_VERSION,
    operation,
    mode,
    commandIds: [...new Set(commandIds)].sort(compareStrings),
    durableEntityIds: [...new Set(entityIds)].sort(compareStrings),
    review,
    writesPerformed: mode === "applied",
    legacyWritesPerformed: false,
    paymentOrProviderWritesPerformed: false,
  };
}

async function appendOccurrenceRevision(
  tx: LeagueScheduleTransaction,
  before: LeagueOccurrence,
  after: LeagueOccurrence,
  commandId: string,
): Promise<void> {
  await tx.insert(leagueOccurrenceRevisions).values({
    organizationId: before.organizationId,
    leagueId: before.leagueId,
    occurrenceId: before.id,
    commandId,
    revisionNumber: after.currentRevision,
    snapshotSchemaVersion: 1,
    beforeSnapshot: occurrenceSnapshot(before),
    afterSnapshot: occurrenceSnapshot(after),
  });
}

async function updateBillingTerm(
  tx: LeagueScheduleTransaction,
  term: LeagueOccurrenceBillingTerm,
  values: Partial<typeof leagueOccurrenceBillingTerms.$inferInsert>,
  commandId: string,
): Promise<LeagueOccurrenceBillingTerm> {
  const [updated] = await tx.update(leagueOccurrenceBillingTerms).set({
    ...values,
    currentRevision: term.currentRevision + 1,
    lastCommandId: commandId,
  }).where(and(
    eq(leagueOccurrenceBillingTerms.id, term.id),
    eq(leagueOccurrenceBillingTerms.organizationId, term.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, term.leagueId),
    eq(leagueOccurrenceBillingTerms.currentRevision, term.currentRevision),
  )).returning();
  if (!updated) throw new FallDraftReviewError("revision_conflict", "a billing-term revision changed during mutation");
  await tx.insert(leagueOccurrenceBillingTermRevisions).values({
    organizationId: term.organizationId,
    leagueId: term.leagueId,
    billingTermId: term.id,
    commandId,
    revisionNumber: updated.currentRevision,
    snapshotSchemaVersion: 1,
    beforeSnapshot: billingTermSnapshot(term),
    afterSnapshot: billingTermSnapshot(updated),
  });
  return updated;
}

async function recomputeDraftBillingOrdinals(
  tx: LeagueScheduleTransaction,
  rows: ReviewRows,
  commandId: string,
  overrides: Map<string, LeagueOccurrenceBillingTerm>,
): Promise<string[]> {
  if (rows.generation.normalizedInput.billingOrdinalPolicy !== FALL_DRAFT_BILLING_ORDINAL_POLICY) return [];
  const occurrences = [...rows.occurrences].sort((left, right) => (left.plannedOrdinal ?? 0) - (right.plannedOrdinal ?? 0));
  let ordinal = 0;
  const changed: string[] = [];
  for (const occurrence of occurrences) {
    const term = overrides.get(occurrence.id) ?? rows.billingTerms.find((candidate) => candidate.occurrenceId === occurrence.id);
    if (!term || term.state !== "draft") continue;
    const billable = occurrence.status === "scheduled" && term.obligationPolicy === "eligible_bowlers";
    const desired = billable ? ++ordinal : null;
    if (term.billingOrdinal === desired) continue;
    const updated = await updateBillingTerm(tx, term, { billingOrdinal: desired }, commandId);
    overrides.set(occurrence.id, updated);
    changed.push(term.id);
  }
  return changed;
}

function findOccurrence(rows: ReviewRows, occurrenceId: string): LeagueOccurrence {
  const occurrence = rows.occurrences.find((row) => row.id === occurrenceId);
  if (!occurrence) throw new FallDraftReviewError("incompatible_canonical_state", "occurrence is foreign to the current C1 run");
  return occurrence;
}

async function assertPlacement(
  tx: LeagueScheduleTransaction,
  scope: FallDraftScope,
  rows: ReviewRows,
  occurrenceId: string,
  localDate: string,
  startAt: string,
): Promise<void> {
  const all = await tx.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, scope.organizationId),
    eq(leagueOccurrences.leagueId, scope.leagueId),
    ne(leagueOccurrences.status, "discarded"),
    ne(leagueOccurrences.status, "cancelled"),
  )).for("update");
  if (all.some((row) => row.id !== occurrenceId && Date.parse(row.startAt) === Date.parse(startAt))) {
    throw new FallDraftReviewError("exact_start_collision", "another active occurrence has the same UTC start instant");
  }
  if (all.some((row) => row.id !== occurrenceId && row.authoritativeLocalDate === localDate)) {
    throw new FallDraftReviewError("same_day_collision", "another active occurrence has the same authoritative local date");
  }
  if (rows.exceptions.some((row) => row.lifecycle !== "revoked" && row.localDate === localDate)) {
    throw new FallDraftReviewError("exception_collision", "an active schedule exception occupies the requested local date");
  }
}

async function refreshedReview(tx: LeagueScheduleTransaction, scope: FallDraftScope, transactionTime: string): Promise<FallDraftReview> {
  return buildReview(tx, scope, await loadRows(tx, scope, true), transactionTime);
}

export async function loadFallDraftReview(scope: FallDraftScope): Promise<FallDraftReview> {
  return db.transaction(async (tx) => {
    await authorizeFallDraftScope(tx, scope);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    return buildReview(tx, scope, await loadRows(tx, scope, false), transactionTime);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function rescheduleFallDraftOccurrence(input: FallDraftScope & {
  request: FallDraftRescheduleRequest;
  failureInjection?: FallDraftReviewFailureStage;
}): Promise<FallDraftMutationResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await authorizeFallDraftScope(tx, input);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const rows = await loadRows(tx, input, true);
    const commandRequestValue = commandRequest(input, input.request, "reschedule");
    const prior = existingCommand(rows, commandRequestValue);
    if (prior) {
      const occurrence = findOccurrence(rows, input.request.occurrenceId);
      if (occurrence.lastCommandId !== prior.id || occurrence.currentRevision !== input.request.expectedOccurrenceRevision + 1) {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed reschedule result is incomplete or was superseded");
      }
      return mutationResult("reschedule", "idempotent_retry", [prior.id], [occurrence.id], await buildReview(tx, input, rows, transactionTime));
    }
    const review = await buildReview(tx, input, rows, transactionTime);
    assertReview(input, review, input.request.confirmedReviewFingerprint);
    const occurrence = findOccurrence(rows, input.request.occurrenceId);
    assertExpectedRevision(occurrence, input.request.expectedOccurrenceRevision);
    if (occurrence.status !== "scheduled" || !["draft", "published"].includes(occurrence.lifecycle)) {
      throw new FallDraftReviewError("terminal_state", "only a scheduled C1 draft or published occurrence can be rescheduled");
    }
    assertFuture(occurrence, transactionTime, rows);
    let resolution;
    try {
      resolution = resolveCanonicalLocalDateTime({
        localDate: input.request.authoritativeLocalDate,
        localTime: input.request.authoritativeLocalStartTime,
        timezone: input.request.timezone,
        ambiguousFold: FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
      });
    } catch (caught) {
      const message = caught instanceof CanonicalDstResolutionError ? caught.message : "the requested local time could not be resolved";
      throw new FallDraftReviewError("invalid_dst_input", message);
    }
    if ((input.request.startAt !== undefined && input.request.startAt !== resolution.startAt)
      || (input.request.selectedUtcOffsetMinutes !== undefined
        && input.request.selectedUtcOffsetMinutes !== resolution.selectedUtcOffsetMinutes)
      || (input.request.foldResolution !== undefined && input.request.foldResolution !== resolution.foldResolution)
      || (input.request.resolverVersion !== undefined && input.request.resolverVersion !== resolution.resolverVersion)) {
      throw new FallDraftReviewError("invalid_dst_input", "caller DST assertions do not match the canonical resolver");
    }
    if (Date.parse(resolution.startAt) <= Date.parse(transactionTime)) {
      throw new FallDraftReviewError("effective_lock", "the requested start instant must remain strictly future-facing");
    }
    await assertPlacement(tx, input, rows, occurrence.id, input.request.authoritativeLocalDate, resolution.startAt);
    const { command } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, commandRequestValue, ["reschedule"]);
    injectFailure(input.failureInjection, "after_commands");
    const [updated] = await tx.update(leagueOccurrences).set({
      authoritativeLocalDate: input.request.authoritativeLocalDate,
      authoritativeLocalStartTime: input.request.authoritativeLocalStartTime.length === 5
        ? `${input.request.authoritativeLocalStartTime}:00` : input.request.authoritativeLocalStartTime,
      timezone: resolution.canonicalTimezone,
      startAt: resolution.startAt,
      selectedUtcOffsetMinutes: resolution.selectedUtcOffsetMinutes,
      foldResolution: resolution.foldResolution,
      resolverVersion: resolution.resolverVersion,
      currentRevision: occurrence.currentRevision + 1,
      lastCommandId: command.id,
      updatedAt: transactionTime,
    }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
    if (!updated) throw new FallDraftReviewError("revision_conflict", "the occurrence changed during reschedule");
    await appendOccurrenceRevision(tx, occurrence, updated, command.id);
    injectFailure(input.failureInjection, "after_occurrences");
    return mutationResult("reschedule", "applied", [command.id], [updated.id], await refreshedReview(tx, input, transactionTime));
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

export async function cancelFallDraftOccurrence(input: FallDraftScope & {
  request: FallDraftCancelRequest;
  failureInjection?: FallDraftReviewFailureStage;
}): Promise<FallDraftMutationResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await authorizeFallDraftScope(tx, input);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const rows = await loadRows(tx, input, true);
    const commandRequestValue = commandRequest(input, input.request, "cancel");
    const prior = existingCommand(rows, commandRequestValue);
    if (prior) {
      const occurrence = findOccurrence(rows, input.request.occurrenceId);
      if (occurrence.cancellationCommandId !== prior.id || occurrence.currentRevision !== input.request.expectedOccurrenceRevision + 1) {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed cancellation result is incomplete or was superseded");
      }
      const entityIds = exactRevisionEntityIds(rows, prior.id);
      if (!entityIds.includes(occurrence.id)) {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed cancellation revision is missing");
      }
      return mutationResult("cancel", "idempotent_retry", [prior.id], entityIds, await buildReview(tx, input, rows, transactionTime));
    }
    const review = await buildReview(tx, input, rows, transactionTime);
    assertReview(input, review, input.request.confirmedReviewFingerprint);
    const occurrence = findOccurrence(rows, input.request.occurrenceId);
    assertExpectedRevision(occurrence, input.request.expectedOccurrenceRevision);
    if (occurrence.status !== "scheduled" || !["draft", "published"].includes(occurrence.lifecycle)) {
      throw new FallDraftReviewError("terminal_state", "only a scheduled C1 draft or published occurrence can be cancelled");
    }
    if (occurrence.completedAt !== null || occurrence.lifecycle === "locked") {
      throw new FallDraftReviewError("activity_evidence", "canonical activity or lifecycle evidence blocks cancellation");
    }
    assertFuture(occurrence, transactionTime, rows);
    const { command } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, commandRequestValue, ["cancel"]);
    injectFailure(input.failureInjection, "after_commands");
    const [updated] = await tx.update(leagueOccurrences).set({
      status: "cancelled",
      competitionNumber: null,
      competitive: false,
      countsInStandings: false,
      currentRevision: occurrence.currentRevision + 1,
      lastCommandId: command.id,
      cancelledAt: transactionTime,
      cancelledByUserId: input.actorUserId,
      cancellationCommandId: command.id,
      updatedAt: transactionTime,
    }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
    if (!updated) throw new FallDraftReviewError("revision_conflict", "the occurrence changed during cancellation");
    await appendOccurrenceRevision(tx, occurrence, updated, command.id);
    injectFailure(input.failureInjection, "after_occurrences");
    const term = rows.billingTerms.find((row) => row.occurrenceId === occurrence.id);
    if (!term || !["draft", "published"].includes(term.state)) {
      throw new FallDraftReviewError("incompatible_canonical_state", "the occurrence has no current C1 billing term");
    }
    const updatedTerm = await updateBillingTerm(tx, term, {
      obligationPolicy: "none", defaultAmountMinor: 0, billingOrdinal: null,
    }, command.id);
    const overrides = new Map([[occurrence.id, updatedTerm]]);
    const renumberedTermIds = occurrence.lifecycle === "draft"
      ? await recomputeDraftBillingOrdinals(tx, { ...rows, occurrences: rows.occurrences.map((row) => row.id === updated.id ? updated : row) }, command.id, overrides)
      : [];
    injectFailure(input.failureInjection, "after_billing_terms");
    return mutationResult("cancel", "applied", [command.id], [updated.id, term.id, ...renumberedTermIds], await refreshedReview(tx, input, transactionTime));
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

export async function restoreFallDraftOccurrence(input: FallDraftScope & {
  request: FallDraftRestoreRequest;
  failureInjection?: FallDraftReviewFailureStage;
}): Promise<FallDraftMutationResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await authorizeFallDraftScope(tx, input);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const rows = await loadRows(tx, input, true);
    const commandRequestValue = commandRequest(input, input.request, "restore_cancelled_draft");
    const prior = existingCommand(rows, commandRequestValue);
    if (prior) {
      const occurrence = findOccurrence(rows, input.request.occurrenceId);
      if (occurrence.lastCommandId !== prior.id || occurrence.status !== "scheduled") {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed restoration result is incomplete or was superseded");
      }
      const entityIds = exactRevisionEntityIds(rows, prior.id);
      if (!entityIds.includes(occurrence.id)) {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed restoration revision is missing");
      }
      return mutationResult("restore", "idempotent_retry", [prior.id], entityIds, await buildReview(tx, input, rows, transactionTime));
    }
    const review = await buildReview(tx, input, rows, transactionTime);
    assertReview(input, review, input.request.confirmedReviewFingerprint);
    if (rows.run.state !== "generated") throw new FallDraftReviewError("terminal_state", "published cancellations cannot be restored");
    const occurrence = findOccurrence(rows, input.request.occurrenceId);
    assertExpectedRevision(occurrence, input.request.expectedOccurrenceRevision);
    if (occurrence.lifecycle !== "draft" || occurrence.status !== "cancelled") {
      throw new FallDraftReviewError("terminal_state", "only a cancelled draft in the editable C1 run can be restored");
    }
    assertFuture(occurrence, transactionTime, rows);
    await assertPlacement(tx, input, rows, occurrence.id, occurrence.authoritativeLocalDate, occurrence.startAt);
    const generated = rows.generation.occurrenceCandidates.find((candidate) => candidate.generationKey === occurrence.generationKey);
    const term = rows.billingTerms.find((row) => row.occurrenceId === occurrence.id);
    if (!generated || !term || term.state !== "draft" || occurrence.plannedOrdinal === null) {
      throw new FallDraftReviewError("incompatible_canonical_state", "C1 generation semantics cannot prove the cancelled draft restoration");
    }
    const { command } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, commandRequestValue, ["restore_cancelled_draft"]);
    injectFailure(input.failureInjection, "after_commands");
    const [updated] = await tx.update(leagueOccurrences).set({
      status: "scheduled",
      competitionNumber: occurrence.plannedOrdinal,
      competitive: true,
      countsInStandings: true,
      currentRevision: occurrence.currentRevision + 1,
      lastCommandId: command.id,
      cancelledAt: null,
      cancelledByUserId: null,
      cancellationCommandId: null,
      updatedAt: transactionTime,
    }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
    if (!updated) throw new FallDraftReviewError("revision_conflict", "the occurrence changed during restoration");
    await appendOccurrenceRevision(tx, occurrence, updated, command.id);
    injectFailure(input.failureInjection, "after_occurrences");
    const normalized = rows.generation.normalizedInput;
    const billable = normalized.regularSessionBillingPolicy === "eligible_bowlers";
    const restoredTerm = await updateBillingTerm(tx, term, {
      obligationPolicy: billable ? "eligible_bowlers" : "none",
      defaultAmountMinor: billable ? normalized.defaultWeeklyAmountMinor : 0,
      currency: normalized.currency,
      billingOrdinal: billable && normalized.billingOrdinalPolicy === "planned_slot" ? occurrence.plannedOrdinal : null,
    }, command.id);
    const overrides = new Map([[occurrence.id, restoredTerm]]);
    const renumberedTermIds = await recomputeDraftBillingOrdinals(
      tx,
      { ...rows, occurrences: rows.occurrences.map((row) => row.id === updated.id ? updated : row) },
      command.id,
      overrides,
    );
    injectFailure(input.failureInjection, "after_billing_terms");
    return mutationResult("restore", "applied", [command.id], [updated.id, term.id, ...renumberedTermIds], await refreshedReview(tx, input, transactionTime));
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

async function assertApprovalFutureAndCollisions(
  tx: LeagueScheduleTransaction,
  scope: FallDraftScope,
  rows: ReviewRows,
  transactionTime: string,
): Promise<void> {
  for (const occurrence of rows.occurrences) {
    if (occurrence.status === "discarded") throw new FallDraftReviewError("incompatible_canonical_state", "discarded rows cannot be published by C2");
    assertFuture(occurrence, transactionTime, rows);
    if (occurrence.status === "scheduled") {
      await assertPlacement(tx, scope, rows, occurrence.id, occurrence.authoritativeLocalDate, occurrence.startAt);
    }
  }
  for (const exception of rows.exceptions) {
    if (exception.lifecycle !== "draft") throw new FallDraftReviewError("incompatible_canonical_state", "approval requires current draft exceptions");
    let resolution;
    try {
      resolution = resolveCanonicalLocalDateTime({
        localDate: exception.localDate,
        localTime: rows.generation.normalizedInput.localCompetitionStartTime,
        timezone: exception.timezone,
        ambiguousFold: FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
      });
    } catch (caught) {
      throw new FallDraftReviewError("invalid_dst_input", caught instanceof Error ? caught.message : "skip time could not be resolved");
    }
    if (Date.parse(resolution.startAt) <= Date.parse(transactionTime)) {
      throw new FallDraftReviewError("effective_lock", "every skipped planned slot must remain strictly future-facing");
    }
    if (rows.occurrences.some((row) => row.status === "scheduled" && row.authoritativeLocalDate === exception.localDate)) {
      throw new FallDraftReviewError("exception_collision", "an active occurrence collides with a skip exception");
    }
  }
}

export interface AutomaticCanonicalPublicationInput extends FallDraftScope {
  idempotencyKey: string;
  reason: string;
}

export interface AutomaticCanonicalPublicationResult {
  approvalCommandId: string;
  publicationCommandId: string;
  writesPerformed: boolean;
}

/**
 * Guarded in-transaction publication primitive used by automatic setup. It
 * shares C2's complete row/revision validation and publication mapping but has
 * no HTTP/review dependency. Generator discrepancies remain durable audit
 * evidence; setup publishes the exact input atomically because there is no
 * separate draft-review step in the canonical-only setup contract.
 */
export async function publishCanonicalDraftInTransaction(
  tx: LeagueScheduleTransaction,
  input: AutomaticCanonicalPublicationInput,
): Promise<AutomaticCanonicalPublicationResult> {
  const transactionTime = await fallDraftDatabaseTransactionTime(tx);
  const rows = await loadRows(tx, input, true);
  const approvalKey = `${input.idempotencyKey}:automatic-approve`;
  const publicationKey = `${input.idempotencyKey}:automatic-publish`;
  const payload = {
    contractVersion: "automatic-canonical-schedule/1",
    generationRunId: rows.run.id,
    sourceScheduleRevision: rows.run.sourceScheduleRevision,
  };
  const approvalBase: MaterializationScheduleCommandRequest = {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: "approve_generation",
    reason: input.reason,
    idempotencyKey: approvalKey,
    requestFingerprint: "",
    materializationOperation: "canonical_draft_review",
    materializationPayload: { ...payload, action: "automatic_approve" },
  };
  const approvalRequest = { ...approvalBase, requestFingerprint: buildCanonicalScheduleCommandFingerprint(approvalBase) };
  const publicationBase: MaterializationScheduleCommandRequest = {
    ...approvalBase,
    commandType: "publish",
    idempotencyKey: publicationKey,
    requestFingerprint: "",
    materializationPayload: { ...payload, action: "automatic_publish", approvalIdempotencyKey: approvalKey },
  };
  const publicationRequest = { ...publicationBase, requestFingerprint: buildCanonicalScheduleCommandFingerprint(publicationBase) };
  const existingApproval = existingCommand(rows, approvalRequest);
  const existingPublication = existingCommand(rows, publicationRequest);
  if (rows.run.state === "applied") {
    if (!existingApproval || !existingPublication || rows.run.approvalCommandId !== existingApproval.id
      || rows.occurrences.some((row) => row.lifecycle !== "published" || row.publicationCommandId !== existingPublication.id)
      || rows.billingTerms.some((row) => row.state !== "published" || row.publicationCommandId !== existingPublication.id)
      || rows.exceptions.some((row) => row.lifecycle !== "published" || row.publicationCommandId !== existingPublication.id)) {
      throw new FallDraftReviewError("incompatible_canonical_state", "automatic canonical publication evidence is incomplete");
    }
    return { approvalCommandId: existingApproval.id, publicationCommandId: existingPublication.id, writesPerformed: false };
  }
  if (rows.run.state !== "generated") throw new FallDraftReviewError("terminal_state", "automatic setup requires one generated canonical run");
  if (existingApproval || existingPublication) throw new FallDraftReviewError("incompatible_canonical_state", "automatic publication command state is partial");
  await assertApprovalFutureAndCollisions(tx, input, rows, transactionTime);
  const approval = await getOrCreateCanonicalScheduleCommandInTransaction(tx, approvalRequest, ["approve_generation"]);
  const publication = await getOrCreateCanonicalScheduleCommandInTransaction(tx, publicationRequest, ["publish"]);
  if (approval.existing || publication.existing) throw new FallDraftReviewError("incompatible_canonical_state", "automatic publication command state is partial");
  for (const occurrence of rows.occurrences) {
    const [updated] = await tx.update(leagueOccurrences).set({
      lifecycle: "published",
      currentRevision: occurrence.currentRevision + 1,
      lastCommandId: publication.command.id,
      publishedAt: transactionTime,
      publishedByUserId: input.actorUserId,
      publicationCommandId: publication.command.id,
      updatedAt: transactionTime,
    }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
    if (!updated) throw new FallDraftReviewError("revision_conflict", "an occurrence changed during automatic publication");
    await appendOccurrenceRevision(tx, occurrence, updated, publication.command.id);
  }
  for (const term of rows.billingTerms) {
    if (term.state !== "draft") throw new FallDraftReviewError("incompatible_canonical_state", "automatic publication requires draft billing terms");
    await updateBillingTerm(tx, term, { state: "published", publishedAt: transactionTime, publishedByUserId: input.actorUserId, publicationCommandId: publication.command.id }, publication.command.id);
  }
  for (const occurrence of rows.occurrences) {
    await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: occurrence.id, actorUserId: input.actorUserId });
  }
  for (const exception of rows.exceptions) {
    if (exception.lifecycle !== "draft") throw new FallDraftReviewError("incompatible_canonical_state", "automatic publication requires draft skip exceptions");
    const [updated] = await tx.update(leagueScheduleExceptions).set({
      lifecycle: "published",
      currentRevision: exception.currentRevision + 1,
      lastCommandId: publication.command.id,
      publishedAt: transactionTime,
      publishedByUserId: input.actorUserId,
      publicationCommandId: publication.command.id,
      updatedAt: transactionTime,
    }).where(and(eq(leagueScheduleExceptions.id, exception.id), eq(leagueScheduleExceptions.currentRevision, exception.currentRevision))).returning();
    if (!updated) throw new FallDraftReviewError("revision_conflict", "a skip exception changed during automatic publication");
    await tx.insert(leagueScheduleExceptionRevisions).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      exceptionId: exception.id,
      commandId: publication.command.id,
      revisionNumber: updated.currentRevision,
      snapshotSchemaVersion: 1,
      beforeSnapshot: exceptionSnapshot(exception),
      afterSnapshot: exceptionSnapshot(updated),
    });
  }
  const [run] = await tx.update(leagueOccurrenceGenerationRuns).set({
    state: "applied",
    approvedAt: transactionTime,
    approvedByUserId: input.actorUserId,
    approvalCommandId: approval.command.id,
    updatedAt: transactionTime,
  }).where(and(eq(leagueOccurrenceGenerationRuns.id, rows.run.id), eq(leagueOccurrenceGenerationRuns.state, "generated"))).returning();
  if (!run) throw new FallDraftReviewError("terminal_state", "the generation run changed during automatic publication");
  return { approvalCommandId: approval.command.id, publicationCommandId: publication.command.id, writesPerformed: true };
}

function validateDispositions(request: FallDraftApproveRequest, review: FallDraftReview): Map<string, "resolved" | "waived"> {
  const open = review.discrepancies.filter((row) => row.resolutionState === "open");
  const ids = request.discrepancyDispositions.map((row) => row.discrepancyId);
  if (new Set(ids).size !== ids.length || ids.length !== open.length
    || [...ids].sort(compareStrings).some((id, index) => id !== open.map((row) => row.id).sort(compareStrings)[index])) {
    throw new FallDraftReviewError("discrepancy_disposition_invalid", "approval requires one exact disposition for every current open discrepancy");
  }
  const result = new Map<string, "resolved" | "waived">();
  for (const disposition of request.discrepancyDispositions) {
    const discrepancy = open.find((row) => row.id === disposition.discrepancyId);
    if (!discrepancy) throw new FallDraftReviewError("discrepancy_disposition_invalid", "approval contains an unknown discrepancy");
    if (disposition.disposition === "resolved" && !discrepancy.canResolve) {
      throw new FallDraftReviewError("discrepancy_disposition_invalid", "a discrepancy can be resolved only when current durable evidence proves correction");
    }
    result.set(disposition.discrepancyId, disposition.disposition);
  }
  return result;
}

export async function approveAndPublishFallDraft(input: FallDraftScope & {
  request: FallDraftApproveRequest;
  failureInjection?: FallDraftReviewFailureStage;
}): Promise<FallDraftMutationResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await authorizeFallDraftScope(tx, input);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const rows = await loadRows(tx, input, true);
    const approveRequest = commandRequest(input, input.request, "approve_generation");
    const publishRequest = commandRequest(
      input,
      input.request,
      "publish",
      relatedIdempotencyKey(input, input.request.idempotencyKey, "publish"),
      "publish",
    );
    const prior = existingCommand(rows, approveRequest);
    if (prior) {
      const publish = existingCommand(rows, publishRequest);
      if (!publish || rows.run.state !== "applied" || rows.run.approvalCommandId !== prior.id
        || rows.occurrences.some((row) => row.lifecycle !== "published" || row.publicationCommandId !== publish.id || row.lastCommandId !== publish.id)
        || rows.billingTerms.some((row) => row.state !== "published" || row.publicationCommandId !== publish.id || row.lastCommandId !== publish.id)
        || rows.exceptions.some((row) => row.lifecycle !== "published" || row.publicationCommandId !== publish.id || row.lastCommandId !== publish.id)
        || rows.discrepancies.some((row) => !["resolved", "waived"].includes(row.resolutionState) || row.resolutionCommandId !== prior.id)) {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed approval/publication result is incomplete or was superseded");
      }
      return mutationResult("approve_publish", "idempotent_retry", [prior.id, publish.id], [
        rows.run.id,
        ...exactRevisionEntityIds(rows, publish.id),
        ...exactRevisionEntityIds(rows, prior.id),
      ], await buildReview(tx, input, rows, transactionTime));
    }
    const review = await buildReview(tx, input, rows, transactionTime);
    assertReview(input, review, input.request.confirmedReviewFingerprint);
    if (rows.run.state !== "generated") throw new FallDraftReviewError("terminal_state", "only an editable generated C1 run can be approved");
    if (!review.currentLegacyInput.matches) throw new FallDraftReviewError("legacy_input_stale", "current authoritative legacy input no longer matches the C1 generation input");
    const dispositions = validateDispositions(input.request, review);
    await assertApprovalFutureAndCollisions(tx, input, rows, transactionTime);
    const approve = await getOrCreateCanonicalScheduleCommandInTransaction(tx, approveRequest, ["approve_generation"]);
    const publish = await getOrCreateCanonicalScheduleCommandInTransaction(tx, publishRequest, ["publish"]);
    if (approve.existing || publish.existing) throw new FallDraftReviewError("incompatible_canonical_state", "partial approval command state cannot be adopted");
    injectFailure(input.failureInjection, "after_commands");
    for (const occurrence of rows.occurrences) {
      const [updated] = await tx.update(leagueOccurrences).set({
        lifecycle: "published",
        currentRevision: occurrence.currentRevision + 1,
        lastCommandId: publish.command.id,
        publishedAt: transactionTime,
        publishedByUserId: input.actorUserId,
        publicationCommandId: publish.command.id,
        updatedAt: transactionTime,
      }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
      if (!updated) throw new FallDraftReviewError("revision_conflict", "an occurrence changed during approval");
      await appendOccurrenceRevision(tx, occurrence, updated, publish.command.id);
    }
    injectFailure(input.failureInjection, "after_occurrences");
    for (const term of rows.billingTerms) {
      if (term.state !== "draft") throw new FallDraftReviewError("incompatible_canonical_state", "approval requires current draft billing terms");
      await updateBillingTerm(tx, term, {
        state: "published", publishedAt: transactionTime, publishedByUserId: input.actorUserId,
        publicationCommandId: publish.command.id,
      }, publish.command.id);
    }
    for (const occurrence of rows.occurrences) {
      await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: occurrence.id, actorUserId: input.actorUserId });
    }
    injectFailure(input.failureInjection, "after_billing_terms");
    for (const exception of rows.exceptions) {
      const [updated] = await tx.update(leagueScheduleExceptions).set({
        lifecycle: "published",
        currentRevision: exception.currentRevision + 1,
        lastCommandId: publish.command.id,
        publishedAt: transactionTime,
        publishedByUserId: input.actorUserId,
        publicationCommandId: publish.command.id,
        updatedAt: transactionTime,
      }).where(and(eq(leagueScheduleExceptions.id, exception.id), eq(leagueScheduleExceptions.currentRevision, exception.currentRevision))).returning();
      if (!updated) throw new FallDraftReviewError("revision_conflict", "an exception changed during approval");
      await tx.insert(leagueScheduleExceptionRevisions).values({
        organizationId: input.organizationId, leagueId: input.leagueId, exceptionId: exception.id,
        commandId: publish.command.id, revisionNumber: updated.currentRevision, snapshotSchemaVersion: 1,
        beforeSnapshot: exceptionSnapshot(exception), afterSnapshot: exceptionSnapshot(updated),
      });
    }
    injectFailure(input.failureInjection, "after_exceptions");
    for (const discrepancy of rows.discrepancies.filter((row) => row.resolutionState === "open")) {
      const state = dispositions.get(discrepancy.id);
      if (!state) throw new FallDraftReviewError("discrepancy_disposition_invalid", "a current discrepancy disposition is missing");
      const [updated] = await tx.update(leagueOccurrenceGenerationDiscrepancies).set({
        resolutionState: state,
        resolutionCommandId: approve.command.id,
        resolvedAt: transactionTime,
        updatedAt: transactionTime,
      }).where(and(eq(leagueOccurrenceGenerationDiscrepancies.id, discrepancy.id), eq(leagueOccurrenceGenerationDiscrepancies.resolutionState, "open"))).returning();
      if (!updated) throw new FallDraftReviewError("stale_review", "a discrepancy changed during approval");
      await tx.insert(leagueOccurrenceGenerationDiscrepancyRevisions).values({
        organizationId: input.organizationId, leagueId: input.leagueId, discrepancyId: discrepancy.id,
        commandId: approve.command.id, revisionNumber: 1,
        snapshotSchemaVersion: FALL_DRAFT_DISCREPANCY_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: discrepancySnapshot(discrepancy), afterSnapshot: discrepancySnapshot(updated),
      });
    }
    injectFailure(input.failureInjection, "after_discrepancies");
    const [run] = await tx.update(leagueOccurrenceGenerationRuns).set({
      state: "applied",
      approvedAt: transactionTime,
      approvedByUserId: input.actorUserId,
      approvalCommandId: approve.command.id,
      updatedAt: transactionTime,
    }).where(and(eq(leagueOccurrenceGenerationRuns.id, rows.run.id), eq(leagueOccurrenceGenerationRuns.state, "generated"))).returning();
    if (!run) throw new FallDraftReviewError("terminal_state", "the generation run changed during approval");
    injectFailure(input.failureInjection, "after_generation_run");
    return mutationResult("approve_publish", "applied", [approve.command.id, publish.command.id], [
      run.id,
      ...rows.occurrences.map((row) => row.id),
      ...rows.billingTerms.map((row) => row.id),
      ...rows.exceptions.map((row) => row.id),
      ...rows.discrepancies.map((row) => row.id),
    ], await refreshedReview(tx, input, transactionTime));
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

export async function rejectFallDraft(input: FallDraftScope & {
  request: FallDraftRejectRequest;
  failureInjection?: FallDraftReviewFailureStage;
}): Promise<FallDraftMutationResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await authorizeFallDraftScope(tx, input);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const rows = await loadRows(tx, input, true);
    const commandRequestValue = commandRequest(input, input.request, "reject_generation");
    const prior = existingCommand(rows, commandRequestValue);
    if (prior) {
      if (rows.run.state !== "rejected" || rows.run.rejectionCommandId !== prior.id
        || rows.occurrences.some((row) => row.lifecycle !== "draft" || row.status !== "discarded" || row.discardCommandId !== prior.id || row.lastCommandId !== prior.id)
        || rows.billingTerms.some((row) => row.state !== "superseded" || row.supersededByCommandId !== prior.id || row.lastCommandId !== prior.id)
        || rows.exceptions.some((row) => row.lifecycle !== "revoked" || row.revocationCommandId !== prior.id || row.lastCommandId !== prior.id)) {
        throw new FallDraftReviewError("incompatible_canonical_state", "the committed rejection result is incomplete or was superseded");
      }
      return mutationResult("reject", "idempotent_retry", [prior.id], [rows.run.id, ...exactRevisionEntityIds(rows, prior.id)], await buildReview(tx, input, rows, transactionTime));
    }
    const review = await buildReview(tx, input, rows, transactionTime);
    assertReview(input, review, input.request.confirmedReviewFingerprint);
    if (rows.run.state !== "generated") throw new FallDraftReviewError("terminal_state", "only an editable generated C1 run can be rejected");
    const { command } = await getOrCreateCanonicalScheduleCommandInTransaction(tx, commandRequestValue, ["reject_generation"]);
    injectFailure(input.failureInjection, "after_commands");
    for (const occurrence of rows.occurrences) {
      if (occurrence.lifecycle !== "draft" || !["scheduled", "cancelled"].includes(occurrence.status)) {
        throw new FallDraftReviewError("incompatible_canonical_state", "rejection requires current generated draft occurrences");
      }
      const [updated] = await tx.update(leagueOccurrences).set({
        status: "discarded",
        plannedOrdinal: null,
        competitionNumber: null,
        competitive: false,
        countsInStandings: false,
        currentRevision: occurrence.currentRevision + 1,
        lastCommandId: command.id,
        cancelledAt: null,
        cancelledByUserId: null,
        cancellationCommandId: null,
        discardedAt: transactionTime,
        discardedByUserId: input.actorUserId,
        discardCommandId: command.id,
        updatedAt: transactionTime,
      }).where(and(eq(leagueOccurrences.id, occurrence.id), eq(leagueOccurrences.currentRevision, occurrence.currentRevision))).returning();
      if (!updated) throw new FallDraftReviewError("revision_conflict", "an occurrence changed during rejection");
      await appendOccurrenceRevision(tx, occurrence, updated, command.id);
    }
    injectFailure(input.failureInjection, "after_occurrences");
    for (const term of rows.billingTerms) {
      if (term.state !== "draft") throw new FallDraftReviewError("incompatible_canonical_state", "rejection requires current draft billing terms");
      await updateBillingTerm(tx, term, { state: "superseded", supersededAt: transactionTime, supersededByCommandId: command.id }, command.id);
    }
    injectFailure(input.failureInjection, "after_billing_terms");
    for (const exception of rows.exceptions) {
      if (exception.lifecycle !== "draft") throw new FallDraftReviewError("incompatible_canonical_state", "rejection requires current draft exceptions");
      const [updated] = await tx.update(leagueScheduleExceptions).set({
        lifecycle: "revoked",
        currentRevision: exception.currentRevision + 1,
        lastCommandId: command.id,
        revokedAt: transactionTime,
        revokedByUserId: input.actorUserId,
        revocationCommandId: command.id,
        updatedAt: transactionTime,
      }).where(and(eq(leagueScheduleExceptions.id, exception.id), eq(leagueScheduleExceptions.currentRevision, exception.currentRevision))).returning();
      if (!updated) throw new FallDraftReviewError("revision_conflict", "an exception changed during rejection");
      await tx.insert(leagueScheduleExceptionRevisions).values({
        organizationId: input.organizationId, leagueId: input.leagueId, exceptionId: exception.id,
        commandId: command.id, revisionNumber: updated.currentRevision, snapshotSchemaVersion: 1,
        beforeSnapshot: exceptionSnapshot(exception), afterSnapshot: exceptionSnapshot(updated),
      });
    }
    injectFailure(input.failureInjection, "after_exceptions");
    const [run] = await tx.update(leagueOccurrenceGenerationRuns).set({
      state: "rejected",
      rejectedAt: transactionTime,
      rejectedByUserId: input.actorUserId,
      rejectionReason: input.request.reason,
      rejectionCommandId: command.id,
      updatedAt: transactionTime,
    }).where(and(eq(leagueOccurrenceGenerationRuns.id, rows.run.id), eq(leagueOccurrenceGenerationRuns.state, "generated"))).returning();
    if (!run) throw new FallDraftReviewError("terminal_state", "the generation run changed during rejection");
    injectFailure(input.failureInjection, "after_generation_run");
    return mutationResult("reject", "applied", [command.id], [
      run.id,
      ...rows.occurrences.map((row) => row.id),
      ...rows.billingTerms.map((row) => row.id),
      ...rows.exceptions.map((row) => row.id),
    ], await refreshedReview(tx, input, transactionTime));
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

export const FALL_DRAFT_REVIEW_SUPPORTED_INPUT_SNAPSHOT_VERSION = FALL_DRAFT_INPUT_SNAPSHOT_VERSION;
export type FallDraftReviewNormalizedInput = CanonicalNormalizedInput;
