import { and, asc, desc, eq, sql } from "drizzle-orm";
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
  leagues,
  locations,
  users,
  type LeagueOccurrence,
  type LeagueOccurrenceBillingTerm,
  type LeagueOccurrenceGenerationDiscrepancy,
  type LeagueOccurrenceGenerationRun,
  type LeagueScheduleCommand,
  type LeagueScheduleException,
  type PaymentMode,
} from "@shared/schema";
import {
  CANONICAL_OCCURRENCE_GENERATOR_VERSION,
  CANONICAL_OCCURRENCE_INPUT_CONTRACT_VERSION,
  CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION,
  generateCanonicalOccurrences,
  type CanonicalGenerationResult,
  type CanonicalNormalizedInput,
} from "@shared/canonical-occurrence-generator";
import {
  canonicalDstResolverVersion,
  resolveCanonicalLocalDateTime,
} from "@shared/canonical-dst-resolver";
import {
  buildLegacyDoublePayEvidence,
  createCanonicalGeneratorInputFromLegacyRow,
  type CanonicalLegacyLeagueRow,
} from "@shared/legacy-canonical-occurrence-input";
import { getProductSeasonFromDateOnly } from "@shared/season-utils";
import {
  FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
  FALL_DRAFT_APPLY_REQUEST_VERSION,
  FALL_DRAFT_APPLY_RESULT_VERSION,
  FALL_DRAFT_BILLING_TERM_REVISION_SNAPSHOT_VERSION,
  FALL_DRAFT_EXCEPTION_REVISION_SNAPSHOT_VERSION,
  FALL_DRAFT_CURRENCY,
  FALL_DRAFT_IMPLEMENTATION_VERSION,
  FALL_DRAFT_MAPPING_VERSION,
  FALL_DRAFT_OCCURRENCE_REVISION_SNAPSHOT_VERSION,
  FALL_DRAFT_PREVIEW_CONTRACT_VERSION,
  FALL_DRAFT_PREVIEW_REQUEST_VERSION,
  fallDraftRegularSessionBillingPolicyForPaymentMode,
  fallDraftCandidateSetFingerprint,
  fallDraftCanonicalJson,
  fallDraftPreviewFingerprint,
  fallDraftSha256,
  type FallDraftApplyRequest,
  type FallDraftApplyResult,
  type FallDraftExistingCanonicalState,
  type FallDraftGeneratorSemantics,
  type FallDraftPersistedView,
  type FallDraftPreview,
} from "@shared/fall-draft-generation";
import { db } from "../db.js";
import {
  allocateCanonicalSourceScheduleRevisionInTransaction,
  assertCanonicalScheduleTenantAndActor,
  buildCanonicalScheduleCommandFingerprint,
  getOrCreateCanonicalScheduleCommandInTransaction,
  validateCanonicalExceptionPlacementInTransaction,
  validateCanonicalOccurrencePlacementInTransaction,
  type MaterializationScheduleCommandRequest,
} from "./canonical-occurrence-transactions.js";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";

export const FALL_DRAFT_INPUT_SNAPSHOT_VERSION = "fall-draft-generation-input-snapshot/2";

export type FallDraftGenerationErrorCode =
  | "invalid_scope"
  | "unauthorized_actor"
  | "league_not_found"
  | "invalid_location"
  | "ineligible_league"
  | "incomplete_authoritative_input"
  | "generator_fatal_error"
  | "unsupported_discrepancy"
  | "not_wholly_future"
  | "stale_preview"
  | "idempotency_conflict"
  | "canonical_collision"
  | "incompatible_canonical_state"
  | "transaction_failure";

export class FallDraftGenerationError extends Error {
  readonly code: FallDraftGenerationErrorCode;

  constructor(code: FallDraftGenerationErrorCode, message: string) {
    super(message);
    this.name = "FallDraftGenerationError";
    this.code = code;
  }
}

export interface FallDraftScope {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
}

interface LoadedLeague {
  active: boolean;
  paymentMode: PaymentMode;
  row: CanonicalLegacyLeagueRow;
}

interface ExistingRows {
  commands: LeagueScheduleCommand[];
  runs: LeagueOccurrenceGenerationRun[];
  occurrences: LeagueOccurrence[];
  terms: LeagueOccurrenceBillingTerm[];
  exceptions: LeagueScheduleException[];
  relationships: Array<{ id: string }>;
  occurrenceRevisions: Array<typeof leagueOccurrenceRevisions.$inferSelect>;
  termRevisions: Array<typeof leagueOccurrenceBillingTermRevisions.$inferSelect>;
  exceptionRevisions: Array<typeof leagueScheduleExceptionRevisions.$inferSelect>;
  discrepancies: LeagueOccurrenceGenerationDiscrepancy[];
}

export interface FallDraftInputSnapshot {
  snapshotContractVersion: typeof FALL_DRAFT_INPUT_SNAPSHOT_VERSION;
  confirmedPreviewFingerprint: string;
  candidateSetFingerprint: string;
  paymentMode: PaymentMode;
  normalizedInput: CanonicalNormalizedInput;
}

interface ExpectedCommands {
  generate: MaterializationScheduleCommandRequest;
  cancel: MaterializationScheduleCommandRequest | null;
  createException: MaterializationScheduleCommandRequest | null;
  all: MaterializationScheduleCommandRequest[];
}

export type FallDraftFailureStage =
  | "after_commands"
  | "after_generation_run"
  | "after_occurrences"
  | "after_billing_terms"
  | "after_exceptions"
  | "after_revisions"
  | "after_discrepancies";

function injectFailure(requested: FallDraftFailureStage | undefined, stage: FallDraftFailureStage): void {
  if (requested === stage) throw new FallDraftGenerationError("transaction_failure", `injected C1 failure at ${stage}`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FallDraftGenerationError("invalid_scope", `${field} must be a positive safe integer`);
  }
}

function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(12, 0, 0, 0);
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export async function authorizeFallDraftScope(tx: LeagueScheduleTransaction, scope: FallDraftScope): Promise<void> {
  assertPositiveInteger(scope.organizationId, "organizationId");
  assertPositiveInteger(scope.leagueId, "leagueId");
  assertPositiveInteger(scope.actorUserId, "actorUserId");
  const [actor] = await tx.select({
    id: users.id,
    organizationId: users.organizationId,
    role: users.role,
  }).from(users).where(eq(users.id, scope.actorUserId));
  if (!actor || (actor.role !== "system_admin" && (actor.role !== "org_admin" || actor.organizationId !== scope.organizationId))) {
    throw new FallDraftGenerationError("unauthorized_actor", "the authenticated actor is not authorized for this organization");
  }
}

async function loadAuthoritativeLeague(tx: LeagueScheduleTransaction, scope: FallDraftScope): Promise<LoadedLeague> {
  const [league] = await tx.select({
    id: leagues.id,
    organizationId: leagues.organizationId,
    locationId: leagues.locationId,
    active: leagues.active,
    seasonStart: leagues.seasonStart,
    seasonEnd: leagues.seasonEnd,
    weekDay: leagues.weekDay,
    competitionStartTime: leagues.competitionStartTime,
    timezone: leagues.timezone,
    totalBowlingWeeks: leagues.totalBowlingWeeks,
    weeklyFee: leagues.weeklyFee,
    paymentMode: leagues.paymentMode,
    skipDates: leagues.skipDates,
    cancelledDates: leagues.cancelledDates,
    doublePayDates: leagues.doublePayDates,
  }).from(leagues).where(and(
    eq(leagues.id, scope.leagueId),
    eq(leagues.organizationId, scope.organizationId),
  ));
  if (!league || league.organizationId !== scope.organizationId) {
    throw new FallDraftGenerationError("league_not_found", "league was not found in the authorized organization");
  }
  if (league.paymentMode !== "weekly" && league.paymentMode !== "upfront") {
    throw new FallDraftGenerationError("incomplete_authoritative_input", "league payment mode must be weekly or upfront");
  }
  if (league.locationId === null) {
    throw new FallDraftGenerationError("invalid_location", "league has no tenant-proven location");
  }
  const [location] = await tx.select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(and(eq(locations.id, league.locationId), eq(locations.organizationId, scope.organizationId)));
  if (!location || location.organizationId !== scope.organizationId) {
    throw new FallDraftGenerationError("invalid_location", "league location is missing or outside the authorized organization");
  }
  return {
    active: league.active,
    paymentMode: league.paymentMode,
    row: {
      league_id: league.id,
      organization_id: league.organizationId,
      location_id: location.id,
      location_organization_id: location.organizationId,
      season_start: league.seasonStart,
      season_end: league.seasonEnd,
      week_day: league.weekDay,
      competition_start_time: league.competitionStartTime,
      timezone: league.timezone,
      total_bowling_weeks: league.totalBowlingWeeks,
      weekly_fee: league.weeklyFee,
      skip_dates: league.skipDates,
      cancelled_dates: league.cancelledDates,
      double_pay_dates: league.doublePayDates,
    },
  };
}

async function assertTenantLeagueExists(tx: LeagueScheduleTransaction, scope: FallDraftScope): Promise<void> {
  const [league] = await tx.select({ id: leagues.id }).from(leagues).where(and(
    eq(leagues.id, scope.leagueId),
    eq(leagues.organizationId, scope.organizationId),
  ));
  if (!league) {
    throw new FallDraftGenerationError("league_not_found", "league was not found in the authorized organization");
  }
}

function assertFallLeague(loaded: LoadedLeague): void {
  if (!loaded.active) {
    throw new FallDraftGenerationError("ineligible_league", "C1 requires an active, non-archived league");
  }
  const start = dateOnly(loaded.row.season_start);
  if (!start || getProductSeasonFromDateOnly(start) !== "Fall") {
    throw new FallDraftGenerationError("ineligible_league", "C1 requires a Fall league whose stored start month is August, September, or October");
  }
}

export async function fallDraftDatabaseTransactionTime(tx: LeagueScheduleTransaction): Promise<string> {
  const result = await tx.execute<{ transaction_time: string }>(sql`
    SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transaction_time
  `);
  const value = result.rows[0]?.transaction_time;
  if (!value) throw new FallDraftGenerationError("transaction_failure", "database transaction time could not be established");
  return value;
}

function assertWhollyFuture(generation: CanonicalGenerationResult, transactionTime: string): void {
  const now = Date.parse(transactionTime);
  const scheduleSlots: Array<{
    authoritativeLocalDate: string;
    startAt: string;
    kind: "occurrence" | "skip";
  }> = generation.occurrenceCandidates.map((candidate) => ({
    authoritativeLocalDate: candidate.authoritativeLocalDate,
    startAt: candidate.startAt,
    kind: "occurrence" as const,
  }));
  for (const candidate of generation.exceptionCandidates) {
    try {
      const resolution = resolveCanonicalLocalDateTime({
        localDate: candidate.authoritativeLocalDate,
        localTime: generation.normalizedInput.localCompetitionStartTime,
        timezone: candidate.timezone,
        ambiguousFold: FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
      });
      scheduleSlots.push({
        authoritativeLocalDate: candidate.authoritativeLocalDate,
        startAt: resolution.startAt,
        kind: "skip",
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new FallDraftGenerationError(
        "generator_fatal_error",
        `C1 could not resolve skipped slot ${candidate.authoritativeLocalDate}: ${message}`,
      );
    }
  }
  const started = scheduleSlots.find((candidate) => Date.parse(candidate.startAt) <= now);
  if (started) {
    throw new FallDraftGenerationError(
      "not_wholly_future",
      `C1 requires every occurrence and skipped slot to remain future-facing; ${started.kind} ${started.authoritativeLocalDate} has already started`,
    );
  }
}

async function loadExistingRows(tx: LeagueScheduleTransaction, scope: FallDraftScope, lock: boolean): Promise<ExistingRows> {
  const commandsQuery = tx.select().from(leagueScheduleCommands).where(and(eq(leagueScheduleCommands.organizationId, scope.organizationId), eq(leagueScheduleCommands.leagueId, scope.leagueId))).orderBy(asc(leagueScheduleCommands.id));
  const runsQuery = tx.select().from(leagueOccurrenceGenerationRuns).where(and(eq(leagueOccurrenceGenerationRuns.organizationId, scope.organizationId), eq(leagueOccurrenceGenerationRuns.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrenceGenerationRuns.sourceScheduleRevision), asc(leagueOccurrenceGenerationRuns.id));
  const occurrencesQuery = tx.select().from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, scope.organizationId), eq(leagueOccurrences.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrences.generationKey));
  const termsQuery = tx.select().from(leagueOccurrenceBillingTerms).where(and(eq(leagueOccurrenceBillingTerms.organizationId, scope.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrenceBillingTerms.id));
  const exceptionsQuery = tx.select().from(leagueScheduleExceptions).where(and(eq(leagueScheduleExceptions.organizationId, scope.organizationId), eq(leagueScheduleExceptions.leagueId, scope.leagueId))).orderBy(asc(leagueScheduleExceptions.localDate), asc(leagueScheduleExceptions.id));
  const relationshipsQuery = tx.select({ id: leagueOccurrenceRelationships.id }).from(leagueOccurrenceRelationships).where(and(eq(leagueOccurrenceRelationships.organizationId, scope.organizationId), eq(leagueOccurrenceRelationships.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrenceRelationships.id));
  const occurrenceRevisionsQuery = tx.select().from(leagueOccurrenceRevisions).where(and(eq(leagueOccurrenceRevisions.organizationId, scope.organizationId), eq(leagueOccurrenceRevisions.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrenceRevisions.id));
  const termRevisionsQuery = tx.select().from(leagueOccurrenceBillingTermRevisions).where(and(eq(leagueOccurrenceBillingTermRevisions.organizationId, scope.organizationId), eq(leagueOccurrenceBillingTermRevisions.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrenceBillingTermRevisions.id));
  const exceptionRevisionsQuery = tx.select().from(leagueScheduleExceptionRevisions).where(and(eq(leagueScheduleExceptionRevisions.organizationId, scope.organizationId), eq(leagueScheduleExceptionRevisions.leagueId, scope.leagueId))).orderBy(asc(leagueScheduleExceptionRevisions.id));
  const discrepanciesQuery = tx.select().from(leagueOccurrenceGenerationDiscrepancies).where(and(eq(leagueOccurrenceGenerationDiscrepancies.organizationId, scope.organizationId), eq(leagueOccurrenceGenerationDiscrepancies.leagueId, scope.leagueId))).orderBy(asc(leagueOccurrenceGenerationDiscrepancies.id));
  if (lock) {
    return {
      commands: await commandsQuery.for("update"),
      runs: await runsQuery.for("update"),
      occurrences: await occurrencesQuery.for("update"),
      terms: await termsQuery.for("update"),
      exceptions: await exceptionsQuery.for("update"),
      relationships: await relationshipsQuery.for("update"),
      occurrenceRevisions: await occurrenceRevisionsQuery.for("update"),
      termRevisions: await termRevisionsQuery.for("update"),
      exceptionRevisions: await exceptionRevisionsQuery.for("update"),
      discrepancies: await discrepanciesQuery.for("update"),
    };
  }
  return {
    commands: await commandsQuery,
    runs: await runsQuery,
    occurrences: await occurrencesQuery,
    terms: await termsQuery,
    exceptions: await exceptionsQuery,
    relationships: await relationshipsQuery,
    occurrenceRevisions: await occurrenceRevisionsQuery,
    termRevisions: await termRevisionsQuery,
    exceptionRevisions: await exceptionRevisionsQuery,
    discrepancies: await discrepanciesQuery,
  };
}

function existingCanonicalState(rows: ExistingRows): FallDraftExistingCanonicalState {
  return {
    commandCount: rows.commands.length,
    generationRunCount: rows.runs.length,
    occurrenceCount: rows.occurrences.length,
    billingTermCount: rows.terms.length,
    exceptionCount: rows.exceptions.length,
    relationshipCount: rows.relationships.length,
    occurrenceRevisionCount: rows.occurrenceRevisions.length,
    billingTermRevisionCount: rows.termRevisions.length,
    exceptionRevisionCount: rows.exceptionRevisions.length,
    discrepancyCount: rows.discrepancies.length,
    generationRuns: rows.runs.map((run) => ({
      generationRunId: run.id,
      originatingCommandId: run.originatingCommandId,
      state: run.state,
      generatorVersion: run.generatorVersion,
      inputFingerprint: run.inputFingerprint,
      sourceScheduleRevision: run.sourceScheduleRevision,
      occurrenceCount: rows.occurrences.filter((row) => row.generationRunId === run.id).length,
      billingTermCount: rows.terms.filter((term) => rows.occurrences.some((row) => row.id === term.occurrenceId && row.generationRunId === run.id)).length,
      exceptionCount: rows.exceptions.filter((row) => row.generationRunId === run.id).length,
      discrepancyCount: rows.discrepancies.filter((row) => row.generationRunId === run.id).length,
    })),
  };
}

function canonicalRowCount(state: FallDraftExistingCanonicalState): number {
  return state.commandCount + state.generationRunCount + state.occurrenceCount + state.billingTermCount
    + state.exceptionCount + state.relationshipCount + state.occurrenceRevisionCount
    + state.billingTermRevisionCount + state.exceptionRevisionCount + state.discrepancyCount;
}

function buildPreview(input: {
  scope: FallDraftScope;
  semantics: FallDraftGeneratorSemantics;
  loaded: LoadedLeague;
  sourceScheduleRevision: number;
  rows: ExistingRows;
}): FallDraftPreview {
  const semantics: FallDraftPreview["semantics"] = {
    paymentMode: input.loaded.paymentMode,
    ambiguousFold: FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
    currency: FALL_DRAFT_CURRENCY,
    regularSessionBillingPolicy: fallDraftRegularSessionBillingPolicyForPaymentMode(input.loaded.paymentMode),
    billingOrdinalPolicy: input.semantics.billingOrdinalPolicy,
  };
  const generatorInput = createCanonicalGeneratorInputFromLegacyRow(input.loaded.row, {
    organizationId: input.scope.organizationId,
    leagueId: input.scope.leagueId,
    sourceScheduleRevision: input.sourceScheduleRevision,
    ...semantics,
  });
  if ("failure" in generatorInput) {
    throw new FallDraftGenerationError("incomplete_authoritative_input", generatorInput.failure);
  }
  const generation = generateCanonicalOccurrences(generatorInput);
  const state = existingCanonicalState(input.rows);
  const blockers: string[] = [];
  if (generation.fatalErrors.length > 0) blockers.push("generator_fatal_error");
  if (generation.discrepancies.some((row) => row.code === "exception_collision")) blockers.push("unsupported_discrepancy");
  if (canonicalRowCount(state) > 0) blockers.push("incompatible_canonical_state");
  const doublePay = buildLegacyDoublePayEvidence(input.loaded.row) as { doublePayDates?: string[] };
  const previewWithoutFingerprint: Omit<FallDraftPreview, "previewFingerprint"> = {
    previewContractVersion: FALL_DRAFT_PREVIEW_CONTRACT_VERSION,
    previewRequestContractVersion: FALL_DRAFT_PREVIEW_REQUEST_VERSION,
    implementationVersion: FALL_DRAFT_IMPLEMENTATION_VERSION,
    mappingVersion: FALL_DRAFT_MAPPING_VERSION,
    generatorVersion: generation.generatorVersion,
    inputContractVersion: CANONICAL_OCCURRENCE_INPUT_CONTRACT_VERSION,
    resultContractVersion: generation.resultContractVersion,
    dstResolverVersion: generation.resolverVersion,
    operatorScope: {
      organizationId: input.scope.organizationId,
      leagueId: input.scope.leagueId,
      locationId: generatorInput.locationId,
    },
    semantics,
    eligibility: {
      active: true,
      archived: false,
      seasonClassification: "Fall",
      whollyFutureFacing: true,
      eligibleForApply: blockers.length === 0,
      blockers: [...blockers].sort(compareStrings),
    },
    normalizedInput: generation.normalizedInput,
    inputFingerprint: generation.inputFingerprint,
    physicalScheduleFingerprint: generation.physicalScheduleFingerprint,
    candidateSetFingerprint: fallDraftCandidateSetFingerprint(generation),
    proposedSourceScheduleRevision: { value: input.sourceScheduleRevision, reserved: false },
    generationRange: generation.generationRange,
    occurrenceCandidates: generation.occurrenceCandidates.map((candidate) => ({
      ...candidate,
      lifecycleIntent: "draft",
      cancellationMetadataIntent: candidate.status === "cancelled" ? "generation_action_time" : "none",
    })),
    billingTermCandidates: generation.billingTermCandidates.map((candidate) => ({
      ...candidate,
      stateIntent: "draft",
      policySnapshotOnly: true,
    })),
    exceptionCandidates: generation.exceptionCandidates.map((candidate) => ({ ...candidate, lifecycleIntent: "draft" })),
    fatalErrors: generation.fatalErrors,
    discrepancies: generation.discrepancies,
    counts: { ...generation.counts, existingCanonicalRows: canonicalRowCount(state) },
    existingCanonicalState: state,
    legacyCollectionEvidence: {
      source: "leagues.double_pay_dates",
      doublePayDates: [...(doublePay.doublePayDates ?? [])].sort(compareStrings),
      excludedFromCanonicalGeneration: true,
      excludedFromPhysicalScheduleFingerprint: true,
      excludedFromBillingTermsAndAmounts: true,
    },
    draftMapping: {
      occurrenceLifecycle: "draft",
      scheduledStatus: "scheduled",
      cancelledStatus: "cancelled",
      billingTermState: "draft",
      skipExceptionLifecycle: "draft",
      cancellationTimestamp: "generation_action_time",
      approvalMetadata: "none",
      publicationMetadata: "none",
      lockMetadata: "none",
      relationshipMaterialization: "none",
      paymentObligationOrCollectionMaterialization: "none",
      occurrenceRevisionSnapshotVersion: FALL_DRAFT_OCCURRENCE_REVISION_SNAPSHOT_VERSION,
      billingTermRevisionSnapshotVersion: FALL_DRAFT_BILLING_TERM_REVISION_SNAPSHOT_VERSION,
      exceptionRevisionSnapshotVersion: FALL_DRAFT_EXCEPTION_REVISION_SNAPSHOT_VERSION,
    },
  };
  return { ...previewWithoutFingerprint, previewFingerprint: fallDraftPreviewFingerprint(previewWithoutFingerprint) };
}

async function proposedRevision(tx: LeagueScheduleTransaction, scope: FallDraftScope): Promise<number> {
  const [latest] = await tx.select({ sourceScheduleRevision: leagueOccurrenceGenerationRuns.sourceScheduleRevision })
    .from(leagueOccurrenceGenerationRuns)
    .where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, scope.organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, scope.leagueId),
    ))
    .orderBy(desc(leagueOccurrenceGenerationRuns.sourceScheduleRevision))
    .limit(1);
  return (latest?.sourceScheduleRevision ?? 0) + 1;
}

export async function previewFallDraftGeneration(input: FallDraftScope & { semantics: FallDraftGeneratorSemantics }): Promise<FallDraftPreview> {
  return db.transaction(async (tx) => {
    await authorizeFallDraftScope(tx, input);
    const loaded = await loadAuthoritativeLeague(tx, input);
    assertFallLeague(loaded);
    const revision = await proposedRevision(tx, input);
    const rows = await loadExistingRows(tx, input, false);
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const preview = buildPreview({ scope: input, semantics: input.semantics, loaded, sourceScheduleRevision: revision, rows });
    if (preview.fatalErrors.length === 0) {
      assertWhollyFuture(generateCanonicalOccurrences(preview.normalizedInput as Parameters<typeof generateCanonicalOccurrences>[0]), transactionTime);
    }
    return preview;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

function relatedIdempotencyKey(scope: FallDraftScope, operatorKey: string, role: string): string {
  return `lvc1:${fallDraftSha256({ organizationId: scope.organizationId, leagueId: scope.leagueId, operatorKey, role })}`;
}

function commandRequest(input: {
  scope: FallDraftScope;
  apply: FallDraftApplyRequest;
  preview: FallDraftPreview;
  role: "generate" | "cancel" | "create_exception";
  idempotencyKey: string;
}): MaterializationScheduleCommandRequest {
  const request: MaterializationScheduleCommandRequest = {
    organizationId: input.scope.organizationId,
    leagueId: input.scope.leagueId,
    actorUserId: input.scope.actorUserId,
    commandType: input.role === "create_exception" ? "create_exception" : input.role,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: "",
    reason: input.apply.reason,
    materializationOperation: "fall_draft_generation",
    materializationPayload: input.role === "generate" ? {
      applyRequestContractVersion: input.apply.contractVersion,
      previewContractVersion: input.preview.previewContractVersion,
      implementationVersion: input.preview.implementationVersion,
      mappingVersion: input.preview.mappingVersion,
      idempotencyKey: input.apply.idempotencyKey,
      confirmedPreviewFingerprint: input.apply.confirmedPreviewFingerprint,
      inputFingerprint: input.preview.inputFingerprint,
      physicalScheduleFingerprint: input.preview.physicalScheduleFingerprint,
      candidateSetFingerprint: input.preview.candidateSetFingerprint,
      normalizedInput: input.preview.normalizedInput,
      sourceScheduleRevision: input.preview.proposedSourceScheduleRevision.value,
      semantics: input.preview.semantics,
      draftMapping: input.preview.draftMapping,
    } : {
      implementationVersion: input.preview.implementationVersion,
      mappingVersion: input.preview.mappingVersion,
      role: input.role,
      originatingIdempotencyKey: input.apply.idempotencyKey,
      confirmedPreviewFingerprint: input.apply.confirmedPreviewFingerprint,
      inputFingerprint: input.preview.inputFingerprint,
      candidateSetFingerprint: input.preview.candidateSetFingerprint,
      sourceScheduleRevision: input.preview.proposedSourceScheduleRevision.value,
      candidateReferences: input.role === "cancel"
        ? input.preview.occurrenceCandidates.filter((candidate) => candidate.status === "cancelled").map((candidate) => candidate.candidateReference).sort(compareStrings)
        : input.preview.exceptionCandidates.map((candidate) => candidate.candidateReference).sort(compareStrings),
    },
  };
  return { ...request, requestFingerprint: buildCanonicalScheduleCommandFingerprint(request) };
}

function expectedCommands(scope: FallDraftScope, apply: FallDraftApplyRequest, preview: FallDraftPreview): ExpectedCommands {
  const generate = commandRequest({ scope, apply, preview, role: "generate", idempotencyKey: apply.idempotencyKey });
  const cancel = preview.occurrenceCandidates.some((candidate) => candidate.status === "cancelled")
    ? commandRequest({ scope, apply, preview, role: "cancel", idempotencyKey: relatedIdempotencyKey(scope, apply.idempotencyKey, "cancel") })
    : null;
  const createException = preview.exceptionCandidates.length > 0
    ? commandRequest({ scope, apply, preview, role: "create_exception", idempotencyKey: relatedIdempotencyKey(scope, apply.idempotencyKey, "create_exception") })
    : null;
  return { generate, cancel, createException, all: [generate, cancel, createException].filter((value): value is MaterializationScheduleCommandRequest => value !== null) };
}

function normalizeInstant(value: string): string {
  return new Date(value).toISOString();
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
    publishedAt: row.publishedAt,
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

function termSnapshot(row: LeagueOccurrenceBillingTerm): Record<string, unknown> {
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
    publishedAt: row.publishedAt,
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    supersededAt: row.supersededAt,
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
    publishedAt: row.publishedAt,
    publishedByUserId: row.publishedByUserId,
    publicationCommandId: row.publicationCommandId,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
    revocationCommandId: row.revocationCommandId,
  };
}

function inputSnapshot(preview: FallDraftPreview): FallDraftInputSnapshot {
  return {
    snapshotContractVersion: FALL_DRAFT_INPUT_SNAPSHOT_VERSION,
    confirmedPreviewFingerprint: preview.previewFingerprint,
    candidateSetFingerprint: preview.candidateSetFingerprint,
    paymentMode: preview.semantics.paymentMode,
    normalizedInput: preview.normalizedInput,
  };
}

export function isFallDraftInputSnapshot(value: unknown): value is FallDraftInputSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<FallDraftInputSnapshot>;
  return snapshot.snapshotContractVersion === FALL_DRAFT_INPUT_SNAPSHOT_VERSION
    && typeof snapshot.confirmedPreviewFingerprint === "string"
    && typeof snapshot.candidateSetFingerprint === "string"
    && (snapshot.paymentMode === "weekly" || snapshot.paymentMode === "upfront")
    && !!snapshot.normalizedInput && typeof snapshot.normalizedInput === "object";
}

export function isFallDraftInputSnapshotFamily(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = (value as { snapshotContractVersion?: unknown }).snapshotContractVersion;
  return typeof version === "string" && version.startsWith("fall-draft-generation-input-snapshot/");
}

function commandMatches(row: LeagueScheduleCommand, request: MaterializationScheduleCommandRequest): boolean {
  return row.organizationId === request.organizationId && row.leagueId === request.leagueId
    && row.actorUserId === request.actorUserId && row.commandType === request.commandType
    && row.idempotencyKey === request.idempotencyKey && row.requestFingerprint === request.requestFingerprint
    && row.reason === request.reason && row.sameDayOverride === false && row.outcome === "applied";
}

function sameValue(left: unknown, right: unknown): boolean {
  return fallDraftCanonicalJson(left) === fallDraftCanonicalJson(right);
}

export async function currentFallDraftInputEvidence(
  tx: LeagueScheduleTransaction,
  scope: FallDraftScope,
  normalizedInput: CanonicalNormalizedInput,
  expectedPaymentMode: PaymentMode,
): Promise<{ matches: boolean; currentInputFingerprint: string | null }> {
  try {
    const loaded = await loadAuthoritativeLeague(tx, scope);
    if (!loaded.active || getProductSeasonFromDateOnly(dateOnly(loaded.row.season_start) ?? "") !== "Fall") {
      return { matches: false, currentInputFingerprint: null };
    }
    if (loaded.paymentMode !== expectedPaymentMode) {
      return { matches: false, currentInputFingerprint: null };
    }
    const candidate = createCanonicalGeneratorInputFromLegacyRow(loaded.row, {
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      sourceScheduleRevision: normalizedInput.sourceScheduleRevision,
      ambiguousFold: FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
      currency: FALL_DRAFT_CURRENCY,
      regularSessionBillingPolicy: fallDraftRegularSessionBillingPolicyForPaymentMode(loaded.paymentMode),
      billingOrdinalPolicy: normalizedInput.billingOrdinalPolicy as FallDraftGeneratorSemantics["billingOrdinalPolicy"],
    });
    if ("failure" in candidate) return { matches: false, currentInputFingerprint: null };
    const currentInputFingerprint = generateCanonicalOccurrences(candidate).inputFingerprint;
    return {
      matches: currentInputFingerprint === generateCanonicalOccurrences(normalizedInput as Parameters<typeof generateCanonicalOccurrences>[0]).inputFingerprint,
      currentInputFingerprint,
    };
  } catch {
    return { matches: false, currentInputFingerprint: null };
  }
}

async function currentInputMatches(
  tx: LeagueScheduleTransaction,
  scope: FallDraftScope,
  normalizedInput: CanonicalNormalizedInput,
  paymentMode: PaymentMode,
): Promise<boolean> {
  return (await currentFallDraftInputEvidence(tx, scope, normalizedInput, paymentMode)).matches;
}

function resultFromRows(input: {
  mode: "applied" | "idempotent_retry";
  preview: FallDraftPreview;
  expected: ExpectedCommands;
  commands: LeagueScheduleCommand[];
  run: LeagueOccurrenceGenerationRun;
  occurrences: LeagueOccurrence[];
  terms: LeagueOccurrenceBillingTerm[];
  exceptions: LeagueScheduleException[];
  occurrenceRevisionIds: string[];
  termRevisionIds: string[];
  exceptionRevisionIds: string[];
  discrepancies: LeagueOccurrenceGenerationDiscrepancy[];
  currentMatches: boolean;
}): FallDraftApplyResult {
  return {
    resultContractVersion: FALL_DRAFT_APPLY_RESULT_VERSION,
    previewContractVersion: FALL_DRAFT_PREVIEW_CONTRACT_VERSION,
    implementationVersion: FALL_DRAFT_IMPLEMENTATION_VERSION,
    mappingVersion: FALL_DRAFT_MAPPING_VERSION,
    mode: input.mode,
    organizationId: input.preview.operatorScope.organizationId,
    leagueId: input.preview.operatorScope.leagueId,
    confirmedPreviewFingerprint: input.preview.previewFingerprint,
    requestFingerprint: input.expected.generate.requestFingerprint,
    inputFingerprint: input.preview.inputFingerprint,
    physicalScheduleFingerprint: input.preview.physicalScheduleFingerprint,
    candidateSetFingerprint: input.preview.candidateSetFingerprint,
    sourceScheduleRevision: input.preview.proposedSourceScheduleRevision.value,
    durableIds: {
      commandIds: input.commands.map((row) => row.id).sort(compareStrings),
      generationRunId: input.run.id,
      occurrenceIds: input.occurrences.map((row) => row.id).sort(compareStrings),
      billingTermIds: input.terms.map((row) => row.id).sort(compareStrings),
      exceptionIds: input.exceptions.map((row) => row.id).sort(compareStrings),
      occurrenceRevisionIds: [...input.occurrenceRevisionIds].sort(compareStrings),
      billingTermRevisionIds: [...input.termRevisionIds].sort(compareStrings),
      exceptionRevisionIds: [...input.exceptionRevisionIds].sort(compareStrings),
      discrepancyIds: input.discrepancies.map((row) => row.id).sort(compareStrings),
    },
    counts: {
      commands: input.commands.length,
      occurrences: input.occurrences.length,
      scheduledOccurrences: input.occurrences.filter((row) => row.status === "scheduled").length,
      cancelledOccurrences: input.occurrences.filter((row) => row.status === "cancelled").length,
      billingTerms: input.terms.length,
      exceptions: input.exceptions.length,
      discrepancies: input.discrepancies.length,
    },
    writesPerformed: input.mode === "applied",
    legacyWritesPerformed: false,
    relationshipsCreated: false,
    paymentObligationOrCollectionRowsCreated: false,
    currentLegacyScheduleMatchesGenerationInput: input.currentMatches,
  };
}

function previewFromPersisted(scope: FallDraftScope, run: LeagueOccurrenceGenerationRun, generation: CanonicalGenerationResult, rows: ExistingRows): FallDraftPreview {
  const snapshot = run.normalizedInputSnapshot;
  if (!isFallDraftInputSnapshot(snapshot)) throw new FallDraftGenerationError("incompatible_canonical_state", "generation run is not a C1 input snapshot");
  const regularSessionBillingPolicy = fallDraftRegularSessionBillingPolicyForPaymentMode(snapshot.paymentMode);
  if (generation.normalizedInput.ambiguousFold !== FALL_DRAFT_AMBIGUOUS_FOLD_POLICY
    || generation.normalizedInput.currency !== FALL_DRAFT_CURRENCY
    || generation.normalizedInput.regularSessionBillingPolicy !== regularSessionBillingPolicy) {
    throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 system policy does not match the authoritative Fall contract");
  }
  const state = existingCanonicalState(rows);
  const semantics: FallDraftPreview["semantics"] = {
    paymentMode: snapshot.paymentMode,
    ambiguousFold: FALL_DRAFT_AMBIGUOUS_FOLD_POLICY,
    currency: FALL_DRAFT_CURRENCY,
    regularSessionBillingPolicy,
    billingOrdinalPolicy: generation.normalizedInput.billingOrdinalPolicy as FallDraftGeneratorSemantics["billingOrdinalPolicy"],
  };
  const without: Omit<FallDraftPreview, "previewFingerprint"> = {
    previewContractVersion: FALL_DRAFT_PREVIEW_CONTRACT_VERSION,
    previewRequestContractVersion: FALL_DRAFT_PREVIEW_REQUEST_VERSION,
    implementationVersion: FALL_DRAFT_IMPLEMENTATION_VERSION,
    mappingVersion: FALL_DRAFT_MAPPING_VERSION,
    generatorVersion: generation.generatorVersion,
    inputContractVersion: CANONICAL_OCCURRENCE_INPUT_CONTRACT_VERSION,
    resultContractVersion: generation.resultContractVersion,
    dstResolverVersion: generation.resolverVersion,
    operatorScope: { organizationId: scope.organizationId, leagueId: scope.leagueId, locationId: generation.normalizedInput.locationId },
    semantics,
    eligibility: { active: true, archived: false, seasonClassification: "Fall", whollyFutureFacing: true, eligibleForApply: false, blockers: ["incompatible_canonical_state"] },
    normalizedInput: generation.normalizedInput,
    inputFingerprint: generation.inputFingerprint,
    physicalScheduleFingerprint: generation.physicalScheduleFingerprint,
    candidateSetFingerprint: fallDraftCandidateSetFingerprint(generation),
    proposedSourceScheduleRevision: { value: run.sourceScheduleRevision, reserved: false },
    generationRange: generation.generationRange,
    occurrenceCandidates: generation.occurrenceCandidates.map((candidate) => ({ ...candidate, lifecycleIntent: "draft", cancellationMetadataIntent: candidate.status === "cancelled" ? "generation_action_time" : "none" })),
    billingTermCandidates: generation.billingTermCandidates.map((candidate) => ({ ...candidate, stateIntent: "draft", policySnapshotOnly: true })),
    exceptionCandidates: generation.exceptionCandidates.map((candidate) => ({ ...candidate, lifecycleIntent: "draft" })),
    fatalErrors: generation.fatalErrors,
    discrepancies: generation.discrepancies,
    counts: { ...generation.counts, existingCanonicalRows: canonicalRowCount(state) },
    existingCanonicalState: state,
    legacyCollectionEvidence: { source: "leagues.double_pay_dates", doublePayDates: [], excludedFromCanonicalGeneration: true, excludedFromPhysicalScheduleFingerprint: true, excludedFromBillingTermsAndAmounts: true },
    draftMapping: {
      occurrenceLifecycle: "draft", scheduledStatus: "scheduled", cancelledStatus: "cancelled", billingTermState: "draft", skipExceptionLifecycle: "draft",
      cancellationTimestamp: "generation_action_time", approvalMetadata: "none", publicationMetadata: "none", lockMetadata: "none", relationshipMaterialization: "none",
      paymentObligationOrCollectionMaterialization: "none", occurrenceRevisionSnapshotVersion: 1, billingTermRevisionSnapshotVersion: 1, exceptionRevisionSnapshotVersion: 1,
    },
  };
  return { ...without, previewFingerprint: snapshot.confirmedPreviewFingerprint };
}

async function verifyExactRetry(tx: LeagueScheduleTransaction, scope: FallDraftScope, apply: FallDraftApplyRequest, rows: ExistingRows): Promise<FallDraftApplyResult> {
  const primary = rows.commands.find((row) => row.idempotencyKey === apply.idempotencyKey);
  if (!primary) throw new FallDraftGenerationError("incompatible_canonical_state", "canonical state exists but is not owned by this idempotency key");
  const run = rows.runs.find((row) => row.originatingCommandId === primary.id);
  if (!run || !isFallDraftInputSnapshot(run.normalizedInputSnapshot)) {
    throw new FallDraftGenerationError("incompatible_canonical_state", "generation command exists without one complete C1 generation run");
  }
  const snapshot = run.normalizedInputSnapshot;
  const generation = generateCanonicalOccurrences(snapshot.normalizedInput as Parameters<typeof generateCanonicalOccurrences>[0]);
  if (generation.fatalErrors.length > 0 || generation.inputFingerprint !== run.inputFingerprint
    || generation.generatorVersion !== run.generatorVersion || snapshot.candidateSetFingerprint !== fallDraftCandidateSetFingerprint(generation)) {
    throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 generation input no longer regenerates exactly");
  }
  const persistedPreview = previewFromPersisted(scope, run, generation, rows);
  if (apply.confirmedPreviewFingerprint !== snapshot.confirmedPreviewFingerprint
    || apply.billingOrdinalPolicy !== persistedPreview.semantics.billingOrdinalPolicy) {
    throw new FallDraftGenerationError("idempotency_conflict", "idempotency key is bound to different preview or generator semantics");
  }
  const expected = expectedCommands(scope, apply, persistedPreview);
  if (rows.commands.length !== expected.all.length || rows.runs.length !== 1 || rows.relationships.length !== 0) {
    throw new FallDraftGenerationError("incompatible_canonical_state", "C1 retry found partial, foreign, or competing canonical state");
  }
  for (const request of expected.all) {
    const command = rows.commands.find((row) => row.idempotencyKey === request.idempotencyKey);
    if (!command || !commandMatches(command, request)) {
      throw new FallDraftGenerationError("idempotency_conflict", "idempotency key is bound to a different semantic C1 request");
    }
  }
  const commandByKey = new Map(rows.commands.map((row) => [row.idempotencyKey, row]));
  const generateCommand = commandByKey.get(expected.generate.idempotencyKey);
  const cancelCommand = expected.cancel ? commandByKey.get(expected.cancel.idempotencyKey) : null;
  const exceptionCommand = expected.createException ? commandByKey.get(expected.createException.idempotencyKey) : null;
  if (!generateCommand || (expected.cancel && !cancelCommand) || (expected.createException && !exceptionCommand)
    || run.state !== "generated" || run.approvedAt !== null || run.rejectedAt !== null || run.supersededAt !== null
    || run.sourceScheduleRevision !== generation.normalizedInput.sourceScheduleRevision
    || !sameValue(run.normalizedInputSnapshot, snapshot)
    || run.candidateOccurrenceCount !== generation.counts.candidateOccurrenceCount
    || run.generatedOccurrenceCount !== generation.counts.generatedOccurrenceCount
    || run.skippedDateCount !== generation.counts.skippedDateCount
    || run.discrepancyCount !== generation.discrepancies.length) {
    throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 generation run is not exact");
  }
  if (rows.occurrences.length !== generation.occurrenceCandidates.length || rows.terms.length !== generation.billingTermCandidates.length
    || rows.exceptions.length !== generation.exceptionCandidates.length || rows.discrepancies.length !== generation.discrepancies.length
    || rows.occurrenceRevisions.length !== rows.occurrences.length || rows.termRevisions.length !== rows.terms.length
    || rows.exceptionRevisions.length !== rows.exceptions.length) {
    throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 draft or revision set is partial");
  }
  for (const candidate of generation.occurrenceCandidates) {
    const row = rows.occurrences.find((value) => value.generationKey === candidate.generationKey);
    const responsible = candidate.status === "cancelled" ? cancelCommand : generateCommand;
    if (!row || !responsible || row.generationRunId !== run.id || row.locationId !== generation.normalizedInput.locationId
      || row.kind !== candidate.kind || row.status !== candidate.status || row.lifecycle !== "draft"
      || row.authoritativeLocalDate !== candidate.authoritativeLocalDate || row.authoritativeLocalStartTime !== candidate.authoritativeLocalStartTime
      || row.timezone !== candidate.timezone || normalizeInstant(row.startAt) !== candidate.startAt
      || row.selectedUtcOffsetMinutes !== candidate.selectedUtcOffsetMinutes || row.foldResolution !== candidate.foldResolution
      || row.resolverVersion !== candidate.resolverVersion || row.plannedOrdinal !== candidate.plannedOrdinal
      || row.competitionNumber !== candidate.competitionNumber || row.competitive !== candidate.competitive
      || row.countsInStandings !== candidate.countsInStandings || row.currentRevision !== 1 || row.lastCommandId !== responsible.id
      || row.publishedAt !== null || row.lockedAt !== null || row.completedAt !== null || row.discardedAt !== null
      || (candidate.status === "cancelled" && (row.cancelledAt === null || row.cancelledByUserId !== scope.actorUserId || row.cancellationCommandId !== cancelCommand?.id))
      || (candidate.status === "scheduled" && (row.cancelledAt !== null || row.cancelledByUserId !== null || row.cancellationCommandId !== null))) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 occurrence set is not exact");
    }
    const revision = rows.occurrenceRevisions.find((value) => value.occurrenceId === row.id);
    if (!revision || revision.revisionNumber !== 1 || revision.snapshotSchemaVersion !== FALL_DRAFT_OCCURRENCE_REVISION_SNAPSHOT_VERSION
      || revision.beforeSnapshot !== null || revision.commandId !== responsible.id || !sameValue(revision.afterSnapshot, occurrenceSnapshot(row))) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 occurrence revision is not exact");
    }
  }
  for (const candidate of generation.billingTermCandidates) {
    const occurrenceCandidate = generation.occurrenceCandidates.find((value) => value.candidateReference === candidate.occurrenceCandidateReference);
    const occurrence = rows.occurrences.find((value) => value.generationKey === occurrenceCandidate?.generationKey);
    const row = rows.terms.find((value) => value.occurrenceId === occurrence?.id);
    if (!row || row.purpose !== candidate.purpose || row.obligationPolicy !== candidate.obligationPolicy
      || row.defaultAmountMinor !== candidate.defaultAmountMinor || row.currency !== candidate.currency
      || row.billingOrdinal !== candidate.billingOrdinal || row.version !== 1 || row.state !== "draft"
      || row.currentRevision !== 1 || row.lastCommandId !== generateCommand.id || row.publishedAt !== null || row.supersededAt !== null) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 billing-term set is not exact");
    }
    const revision = rows.termRevisions.find((value) => value.billingTermId === row.id);
    if (!revision || revision.revisionNumber !== 1 || revision.snapshotSchemaVersion !== FALL_DRAFT_BILLING_TERM_REVISION_SNAPSHOT_VERSION
      || revision.beforeSnapshot !== null || revision.commandId !== generateCommand.id || !sameValue(revision.afterSnapshot, termSnapshot(row))) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 billing-term revision is not exact");
    }
  }
  for (const candidate of generation.exceptionCandidates) {
    const row = rows.exceptions.find((value) => value.localDate === candidate.authoritativeLocalDate);
    if (!row || !exceptionCommand || row.kind !== candidate.kind || row.timezone !== candidate.timezone || row.source !== candidate.source
      || row.lifecycle !== "draft" || row.reason !== candidate.reason || row.generationRunId !== run.id
      || row.currentRevision !== 1 || row.lastCommandId !== exceptionCommand.id || row.publishedAt !== null || row.revokedAt !== null) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 exception set is not exact");
    }
    const revision = rows.exceptionRevisions.find((value) => value.exceptionId === row.id);
    if (!revision || revision.revisionNumber !== 1 || revision.snapshotSchemaVersion !== FALL_DRAFT_EXCEPTION_REVISION_SNAPSHOT_VERSION
      || revision.beforeSnapshot !== null || revision.commandId !== exceptionCommand.id || !sameValue(revision.afterSnapshot, exceptionSnapshot(row))) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 exception revision is not exact");
    }
  }
  for (const discrepancy of generation.discrepancies) {
    const row = rows.discrepancies.find((value) => value.code === discrepancy.code && sameValue(value.details, { generatorDetails: discrepancy.details }));
    if (!row || row.generationRunId !== run.id || row.severity !== discrepancy.severity || row.generationKey !== null
      || row.resolutionState !== "open" || row.resolutionCommandId !== null || row.resolvedAt !== null) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "persisted C1 discrepancy set is not exact");
    }
  }
  const currentMatches = await currentInputMatches(tx, scope, generation.normalizedInput, snapshot.paymentMode);
  return resultFromRows({
    mode: "idempotent_retry", preview: persistedPreview, expected, commands: rows.commands, run,
    occurrences: rows.occurrences, terms: rows.terms, exceptions: rows.exceptions,
    occurrenceRevisionIds: rows.occurrenceRevisions.map((row) => row.id), termRevisionIds: rows.termRevisions.map((row) => row.id),
    exceptionRevisionIds: rows.exceptionRevisions.map((row) => row.id), discrepancies: rows.discrepancies, currentMatches,
  });
}

async function assertNoCollisions(tx: LeagueScheduleTransaction, scope: FallDraftScope, preview: FallDraftPreview, rows: ExistingRows): Promise<void> {
  for (const candidate of preview.occurrenceCandidates) {
    const exact = rows.occurrences.find((row) => row.status !== "discarded" && Date.parse(row.startAt) === Date.parse(candidate.startAt));
    const sameDay = rows.occurrences.find((row) => row.status !== "discarded" && row.authoritativeLocalDate === candidate.authoritativeLocalDate);
    if (exact) throw new FallDraftGenerationError("canonical_collision", "an existing occurrence has the same UTC start instant");
    if (sameDay) throw new FallDraftGenerationError("canonical_collision", "C1 does not permit a same-day occurrence override");
    await validateCanonicalOccurrencePlacementInTransaction(tx, {
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      authoritativeLocalDate: candidate.authoritativeLocalDate,
      startAt: candidate.startAt,
      sameDayOverride: false,
    });
  }
  for (const candidate of preview.exceptionCandidates) {
    await validateCanonicalExceptionPlacementInTransaction(tx, {
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      actorUserId: scope.actorUserId,
      commandType: "create_exception",
      idempotencyKey: "preflight-only",
      requestFingerprint: "preflight-only",
      authoritativeLocalDate: candidate.authoritativeLocalDate,
      startAt: candidate.authoritativeLocalDate,
    });
  }
}

export async function applyFallDraftGeneration(input: FallDraftScope & { apply: FallDraftApplyRequest; failureInjection?: FallDraftFailureStage }): Promise<FallDraftApplyResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const authRequest: MaterializationScheduleCommandRequest = {
      organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId,
      commandType: "generate", idempotencyKey: input.apply.idempotencyKey, requestFingerprint: `lvcanoncmd:v1:${"0".repeat(64)}`,
      reason: input.apply.reason, materializationOperation: "fall_draft_generation", materializationPayload: {},
    };
    try {
      await assertCanonicalScheduleTenantAndActor(tx, authRequest);
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      if (code === "unauthorized_actor") throw new FallDraftGenerationError("unauthorized_actor", "the authenticated actor is not authorized for this organization");
      if (code === "league_not_found") throw new FallDraftGenerationError("league_not_found", "league was not found in the authorized organization");
      throw caught;
    }
    const rows = await loadExistingRows(tx, input, true);
    const existingKey = rows.commands.find((row) => row.idempotencyKey === input.apply.idempotencyKey);
    if (existingKey) return verifyExactRetry(tx, input, input.apply, rows);
    const loaded = await loadAuthoritativeLeague(tx, input);
    assertFallLeague(loaded);
    const sourceScheduleRevision = await allocateCanonicalSourceScheduleRevisionInTransaction(tx, input.organizationId, input.leagueId);
    const preview = buildPreview({ scope: input, semantics: input.apply, loaded, sourceScheduleRevision, rows });
    if (preview.previewFingerprint !== input.apply.confirmedPreviewFingerprint) {
      throw new FallDraftGenerationError("stale_preview", "confirmed preview no longer matches the authoritative league schedule and canonical state");
    }
    if (preview.fatalErrors.length > 0) throw new FallDraftGenerationError("generator_fatal_error", "C1 cannot apply a preview with generator fatal errors");
    if (preview.discrepancies.some((row) => row.code === "exception_collision")) {
      throw new FallDraftGenerationError("unsupported_discrepancy", "exception-collision discrepancies cannot be materialized by C1");
    }
    const transactionTime = await fallDraftDatabaseTransactionTime(tx);
    const generation = generateCanonicalOccurrences(preview.normalizedInput as Parameters<typeof generateCanonicalOccurrences>[0]);
    assertWhollyFuture(generation, transactionTime);
    await assertNoCollisions(tx, input, preview, rows);
    if (canonicalRowCount(existingCanonicalState(rows)) !== 0) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "league contains partial, foreign, or competing canonical state");
    }
    const expected = expectedCommands(input, input.apply, preview);
    const commands = new Map<string, LeagueScheduleCommand>();
    for (const request of expected.all) {
      const created = await getOrCreateCanonicalScheduleCommandInTransaction(tx, request, [request.commandType]);
      if (created.existing) throw new FallDraftGenerationError("incompatible_canonical_state", "related C1 command exists without the originating generation command");
      commands.set(request.idempotencyKey, created.command);
    }
    injectFailure(input.failureInjection, "after_commands");
    const generateCommand = commands.get(expected.generate.idempotencyKey);
    const cancelCommand = expected.cancel ? commands.get(expected.cancel.idempotencyKey) : null;
    const exceptionCommand = expected.createException ? commands.get(expected.createException.idempotencyKey) : null;
    if (!generateCommand || (expected.cancel && !cancelCommand) || (expected.createException && !exceptionCommand)) {
      throw new FallDraftGenerationError("transaction_failure", "C1 command attribution could not be created");
    }
    if (!generation.generationRange.startDate || !generation.generationRange.endDate) {
      throw new FallDraftGenerationError("generator_fatal_error", "C1 requires a complete generation range");
    }
    const [run] = await tx.insert(leagueOccurrenceGenerationRuns).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      originatingCommandId: generateCommand.id,
      generatorVersion: generation.generatorVersion,
      inputFingerprint: generation.inputFingerprint,
      sourceScheduleRevision,
      normalizedInputSnapshot: inputSnapshot(preview),
      rangeStartDate: generation.generationRange.startDate,
      rangeEndDate: generation.generationRange.endDate,
      candidateOccurrenceCount: generation.counts.candidateOccurrenceCount,
      generatedOccurrenceCount: generation.counts.generatedOccurrenceCount,
      skippedDateCount: generation.counts.skippedDateCount,
      discrepancyCount: generation.discrepancies.length,
      state: "generated",
    }).returning();
    if (!run) throw new FallDraftGenerationError("transaction_failure", "C1 generation run was not created");
    injectFailure(input.failureInjection, "after_generation_run");
    const occurrences: LeagueOccurrence[] = [];
    const occurrenceByCandidate = new Map<string, LeagueOccurrence>();
    for (const candidate of generation.occurrenceCandidates) {
      const responsible = candidate.status === "cancelled" ? cancelCommand : generateCommand;
      if (!responsible) throw new FallDraftGenerationError("transaction_failure", "cancel command attribution is missing");
      const [row] = await tx.insert(leagueOccurrences).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        locationId: generation.normalizedInput.locationId,
        generationKey: candidate.generationKey,
        generationRunId: run.id,
        kind: candidate.kind,
        status: candidate.status,
        lifecycle: "draft",
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
        lastCommandId: responsible.id,
        cancelledAt: candidate.status === "cancelled" ? transactionTime : null,
        cancelledByUserId: candidate.status === "cancelled" ? input.actorUserId : null,
        cancellationCommandId: candidate.status === "cancelled" ? cancelCommand?.id : null,
      }).returning();
      if (!row) throw new FallDraftGenerationError("transaction_failure", "C1 occurrence was not created");
      occurrences.push(row);
      occurrenceByCandidate.set(candidate.candidateReference, row);
    }
    injectFailure(input.failureInjection, "after_occurrences");
    const terms: LeagueOccurrenceBillingTerm[] = [];
    for (const candidate of generation.billingTermCandidates) {
      const occurrence = occurrenceByCandidate.get(candidate.occurrenceCandidateReference);
      if (!occurrence) throw new FallDraftGenerationError("transaction_failure", "billing candidate has no occurrence");
      const [row] = await tx.insert(leagueOccurrenceBillingTerms).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: occurrence.id,
        purpose: candidate.purpose,
        obligationPolicy: candidate.obligationPolicy,
        defaultAmountMinor: candidate.defaultAmountMinor,
        currency: candidate.currency,
        billingOrdinal: candidate.billingOrdinal,
        version: candidate.version,
        state: "draft",
        currentRevision: 1,
        lastCommandId: generateCommand.id,
      }).returning();
      if (!row) throw new FallDraftGenerationError("transaction_failure", "C1 billing term was not created");
      terms.push(row);
    }
    injectFailure(input.failureInjection, "after_billing_terms");
    const exceptions: LeagueScheduleException[] = [];
    for (const candidate of generation.exceptionCandidates) {
      if (!exceptionCommand) throw new FallDraftGenerationError("transaction_failure", "exception command attribution is missing");
      const [row] = await tx.insert(leagueScheduleExceptions).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        kind: candidate.kind,
        localDate: candidate.authoritativeLocalDate,
        timezone: candidate.timezone,
        source: candidate.source,
        lifecycle: "draft",
        reason: candidate.reason,
        generationRunId: run.id,
        currentRevision: 1,
        lastCommandId: exceptionCommand.id,
      }).returning();
      if (!row) throw new FallDraftGenerationError("transaction_failure", "C1 exception was not created");
      exceptions.push(row);
    }
    injectFailure(input.failureInjection, "after_exceptions");
    const occurrenceRevisionIds: string[] = [];
    for (const row of occurrences) {
      const [revision] = await tx.insert(leagueOccurrenceRevisions).values({
        organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: row.id,
        commandId: row.lastCommandId as string, revisionNumber: 1,
        snapshotSchemaVersion: FALL_DRAFT_OCCURRENCE_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null, afterSnapshot: occurrenceSnapshot(row),
      }).returning({ id: leagueOccurrenceRevisions.id });
      if (!revision) throw new FallDraftGenerationError("transaction_failure", "C1 occurrence revision was not created");
      occurrenceRevisionIds.push(revision.id);
    }
    const termRevisionIds: string[] = [];
    for (const row of terms) {
      const [revision] = await tx.insert(leagueOccurrenceBillingTermRevisions).values({
        organizationId: input.organizationId, leagueId: input.leagueId, billingTermId: row.id,
        commandId: generateCommand.id, revisionNumber: 1,
        snapshotSchemaVersion: FALL_DRAFT_BILLING_TERM_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null, afterSnapshot: termSnapshot(row),
      }).returning({ id: leagueOccurrenceBillingTermRevisions.id });
      if (!revision) throw new FallDraftGenerationError("transaction_failure", "C1 billing-term revision was not created");
      termRevisionIds.push(revision.id);
    }
    const exceptionRevisionIds: string[] = [];
    for (const row of exceptions) {
      const [revision] = await tx.insert(leagueScheduleExceptionRevisions).values({
        organizationId: input.organizationId, leagueId: input.leagueId, exceptionId: row.id,
        commandId: row.lastCommandId as string, revisionNumber: 1,
        snapshotSchemaVersion: FALL_DRAFT_EXCEPTION_REVISION_SNAPSHOT_VERSION,
        beforeSnapshot: null, afterSnapshot: exceptionSnapshot(row),
      }).returning({ id: leagueScheduleExceptionRevisions.id });
      if (!revision) throw new FallDraftGenerationError("transaction_failure", "C1 exception revision was not created");
      exceptionRevisionIds.push(revision.id);
    }
    injectFailure(input.failureInjection, "after_revisions");
    const discrepancies: LeagueOccurrenceGenerationDiscrepancy[] = [];
    for (const discrepancy of generation.discrepancies) {
      if (discrepancy.code !== "outside_season_occurrence" && discrepancy.code !== "total_week_mismatch") {
        throw new FallDraftGenerationError("unsupported_discrepancy", `C1 cannot truthfully persist ${discrepancy.code}`);
      }
      const [row] = await tx.insert(leagueOccurrenceGenerationDiscrepancies).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        generationRunId: run.id,
        severity: discrepancy.severity,
        code: discrepancy.code,
        generationKey: null,
        details: { generatorDetails: discrepancy.details },
        resolutionState: "open",
      }).returning();
      if (!row) throw new FallDraftGenerationError("transaction_failure", "C1 discrepancy was not created");
      discrepancies.push(row);
    }
    injectFailure(input.failureInjection, "after_discrepancies");
    return resultFromRows({
      mode: "applied", preview, expected, commands: [...commands.values()], run, occurrences, terms, exceptions,
      occurrenceRevisionIds, termRevisionIds, exceptionRevisionIds, discrepancies, currentMatches: true,
    });
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

export async function loadFallDraftPersistedView(scope: FallDraftScope): Promise<FallDraftPersistedView> {
  return db.transaction(async (tx) => {
    await authorizeFallDraftScope(tx, scope);
    await assertTenantLeagueExists(tx, scope);
    const rows = await loadExistingRows(tx, scope, false);
    if (rows.runs.some((run) => isFallDraftInputSnapshotFamily(run.normalizedInputSnapshot)
      && !isFallDraftInputSnapshot(run.normalizedInputSnapshot))) {
      throw new FallDraftGenerationError("incompatible_canonical_state", "league contains an unsupported C1 input snapshot version");
    }
    const c1Runs = rows.runs.filter((run) => isFallDraftInputSnapshot(run.normalizedInputSnapshot));
    if (c1Runs.length === 0) return {
      found: false,
      result: null,
      currentLegacyScheduleMatchesGenerationInput: null,
    };
    if (c1Runs.length !== 1) throw new FallDraftGenerationError("incompatible_canonical_state", "multiple C1 generation runs exist for the league");
    const run = c1Runs[0];
    const snapshot = run.normalizedInputSnapshot;
    if (!isFallDraftInputSnapshot(snapshot)) throw new FallDraftGenerationError("incompatible_canonical_state", "C1 snapshot is invalid");
    const generation = generateCanonicalOccurrences(snapshot.normalizedInput as Parameters<typeof generateCanonicalOccurrences>[0]);
    const transitionedToC2 = run.state !== "generated"
      || rows.occurrences.some((row) => row.currentRevision > 1)
      || rows.terms.some((row) => row.currentRevision > 1)
      || rows.exceptions.some((row) => row.currentRevision > 1)
      || rows.discrepancies.some((row) => row.resolutionState !== "open");
    if (transitionedToC2) {
      const currentMatches = await currentInputMatches(tx, scope, generation.normalizedInput, snapshot.paymentMode);
      return {
        found: true,
        result: null,
        currentLegacyScheduleMatchesGenerationInput: currentMatches,
        transitionedToC2: true,
        generationRunId: run.id,
      };
    }
    const preview = previewFromPersisted(scope, run, generation, rows);
    const command = rows.commands.find((row) => row.id === run.originatingCommandId);
    if (!command) throw new FallDraftGenerationError("incompatible_canonical_state", "C1 run has no originating generation command");
    const apply: FallDraftApplyRequest = {
      contractVersion: FALL_DRAFT_APPLY_REQUEST_VERSION,
      confirmedPreviewFingerprint: snapshot.confirmedPreviewFingerprint,
      reason: command.reason ?? "",
      idempotencyKey: command.idempotencyKey,
      billingOrdinalPolicy: preview.semantics.billingOrdinalPolicy,
    };
    const result = await verifyExactRetry(tx, { ...scope, actorUserId: command.actorUserId }, apply, rows);
    return {
      found: true,
      result,
      currentLegacyScheduleMatchesGenerationInput: result.currentLegacyScheduleMatchesGenerationInput,
      transitionedToC2: false,
      generationRunId: run.id,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export const FALL_DRAFT_SUPPORTED_GENERATOR_VERSION = CANONICAL_OCCURRENCE_GENERATOR_VERSION;
export const FALL_DRAFT_SUPPORTED_RESULT_VERSION = CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION;
export const FALL_DRAFT_SUPPORTED_DST_RESOLVER_VERSION = canonicalDstResolverVersion();
