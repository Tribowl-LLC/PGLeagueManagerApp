import {
  CANONICAL_OCCURRENCE_GENERATOR_VERSION,
  CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION,
  generateCanonicalOccurrences,
  type CanonicalGenerationResult,
  type CanonicalOccurrenceGeneratorInput,
} from "./canonical-occurrence-generator";
import { canonicalDstResolverVersion } from "./canonical-dst-resolver";
import {
  CANONICAL_OCCURRENCE_COMPARISON_REPORT_VERSION,
  COMPLETED_SUMMER_COMPARATOR_VERSION,
  COMPLETED_SUMMER_SELECTION_CONTRACT_VERSION,
  canonicalJsonStringify,
  sha256CanonicalJson,
  type ComparisonFinding,
  type CompletedSummerComparisonReport,
  type CompletedSummerLeagueReport,
  type CompletedSummerOperatorInputs,
} from "./completed-summer-comparator";

export const COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION = "completed-summer-materialization/1";
export const COMPLETED_SUMMER_MATERIALIZATION_SEMANTICS_VERSION = "completed-summer-materialization-semantics/1";
export const COMPLETED_SUMMER_MATERIALIZATION_RESULT_VERSION = "completed-summer-materialization-result/1";
export const COMPLETED_SUMMER_OCCURRENCE_REVISION_SNAPSHOT_VERSION = 1;
export const COMPLETED_SUMMER_BILLING_TERM_REVISION_SNAPSHOT_VERSION = 1;
export const COMPLETED_SUMMER_EXCEPTION_REVISION_SNAPSHOT_VERSION = 1;

export const COMPLETED_SUMMER_HARD_BLOCKER_CODES = [
  "invalid_or_cross_tenant_evidence",
  "same_day_collision",
  "exact_start_collision",
  "skip_exception_conflict",
  "cancelled_session_activity",
  "legacy_session_date_conflict",
  "start_instant_mismatch",
] as const;

export const COMPLETED_SUMMER_PERSISTED_B1_DISCREPANCY_CODES = [
  "duplicate_historical_game_key",
  "ambiguous_historical_payment",
] as const;

export const COMPLETED_SUMMER_PERSISTED_GENERATOR_DISCREPANCY_CODES = [
  "outside_season_occurrence",
  "total_week_mismatch",
] as const;

export type CompletedSummerMaterializationErrorCode =
  | "invalid_request"
  | "invalid_report_json"
  | "noncanonical_report_json"
  | "unsupported_contract"
  | "report_fingerprint_mismatch"
  | "report_scope_mismatch"
  | "report_not_single_league"
  | "report_fatal_error"
  | "generator_fatal_error"
  | "generator_result_mismatch"
  | "source_revision_mismatch"
  | "unexpected_existing_a1_evidence"
  | "hard_blocker"
  | "acknowledgement_mismatch"
  | "stale_report"
  | "idempotency_conflict"
  | "unexpected_existing_a1_state"
  | "materialization_collision"
  | "transaction_failure";

export class CompletedSummerMaterializationError extends Error {
  readonly code: CompletedSummerMaterializationErrorCode;

  constructor(code: CompletedSummerMaterializationErrorCode, message: string) {
    super(message);
    this.name = "CompletedSummerMaterializationError";
    this.code = code;
  }
}

export interface CompletedSummerMaterializationRequestedScope extends CompletedSummerOperatorInputs {
  leagueId: number;
}

export interface CompletedSummerMaterializationApprovalInput {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  reason: string;
  idempotencyKey: string;
  reportFingerprint: string;
  inputFingerprint: string;
  physicalScheduleFingerprint: string;
  expectedSourceScheduleRevision: number;
  materializationContractVersion: typeof COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION;
  acknowledgedFindingReferences: readonly string[];
  requestedScope: CompletedSummerMaterializationRequestedScope;
}

export interface CompletedSummerPersistedFindingPlan {
  stableReference: string;
  severity: "info" | "warning" | "error";
  code:
    | "ambiguous_historical_payment"
    | "duplicate_historical_game_key"
    | "outside_season_occurrence"
    | "total_week_mismatch";
  generationKey: string | null;
  details: Record<string, unknown>;
}

export interface CompletedSummerMaterializationPlan {
  materializationContractVersion: typeof COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION;
  materializationSemanticsVersion: typeof COMPLETED_SUMMER_MATERIALIZATION_SEMANTICS_VERSION;
  report: CompletedSummerComparisonReport;
  league: CompletedSummerLeagueReport;
  generationResult: CanonicalGenerationResult;
  approval: CompletedSummerMaterializationApprovalInput;
  requiredAcknowledgementReferences: string[];
  persistedFindings: CompletedSummerPersistedFindingPlan[];
  candidateSetFingerprint: string;
  materializationSemantics: {
    occurrenceLifecycle: "published";
    scheduledStatus: "scheduled";
    cancelledStatus: "cancelled";
    billingTermState: "published";
    skipExceptionLifecycle: "generator_intent";
    historicalLockTimestamp: "not_invented";
    cancellationTimestamp: "materialization_action_time";
    paymentLinking: "none";
    relationshipMaterialization: "none";
    occurrenceRevisionSnapshotVersion: 1;
    billingTermRevisionSnapshotVersion: 1;
    exceptionRevisionSnapshotVersion: 1;
  };
  counts: {
    occurrences: number;
    scheduledOccurrences: number;
    cancelledOccurrences: number;
    billingTerms: number;
    exceptions: number;
    persistedDiscrepancies: number;
  };
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompletedSummerMaterializationError("invalid_report_json", message);
  }
}

function assertCompletedSummerReportShape(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & CompletedSummerComparisonReport {
  const generatorContract = value.generatorContract;
  const normalizedOperatorInputs = value.normalizedOperatorInputs;
  const selectionSummary = value.selectionSummary;
  const aggregateCounts = value.aggregateCounts;
  if (typeof value.reportContractVersion !== "string"
    || typeof value.comparatorImplementationVersion !== "string"
    || typeof value.selectionContractVersion !== "string"
    || typeof value.reportFingerprint !== "string"
    || generatorContract === null || typeof generatorContract !== "object" || Array.isArray(generatorContract)
    || normalizedOperatorInputs === null || typeof normalizedOperatorInputs !== "object" || Array.isArray(normalizedOperatorInputs)
    || selectionSummary === null || typeof selectionSummary !== "object" || Array.isArray(selectionSummary)
    || aggregateCounts === null || typeof aggregateCounts !== "object" || Array.isArray(aggregateCounts)
    || !Array.isArray(value.leagues) || !Array.isArray(value.fatalErrors)) {
    throw new CompletedSummerMaterializationError("invalid_report_json", "the B1 report artifact is missing required top-level fields");
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CompletedSummerMaterializationError("invalid_request", `${name} must be a positive safe integer`);
  }
}

function assertLowerSha256(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CompletedSummerMaterializationError("invalid_request", `${name} must be lowercase hexadecimal SHA-256`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function reportWithoutFingerprint(report: CompletedSummerComparisonReport): Omit<CompletedSummerComparisonReport, "reportFingerprint"> {
  const { reportFingerprint: _fingerprint, ...semantic } = report;
  return semantic;
}

export function recomputeCompletedSummerReportFingerprint(report: CompletedSummerComparisonReport): string {
  return sha256CanonicalJson(reportWithoutFingerprint(report));
}

export function completedSummerReportsAreSemanticallyEqual(
  left: CompletedSummerComparisonReport,
  right: CompletedSummerComparisonReport,
): boolean {
  return sameCanonicalValue(left, right);
}

function assertSupportedVersions(report: CompletedSummerComparisonReport): void {
  if (report.reportContractVersion !== CANONICAL_OCCURRENCE_COMPARISON_REPORT_VERSION
    || report.comparatorImplementationVersion !== COMPLETED_SUMMER_COMPARATOR_VERSION
    || report.selectionContractVersion !== COMPLETED_SUMMER_SELECTION_CONTRACT_VERSION
    || report.generatorContract.generatorVersion !== CANONICAL_OCCURRENCE_GENERATOR_VERSION
    || report.generatorContract.resultContractVersion !== CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION
    || report.generatorContract.resolverVersions.length !== 1
    || report.generatorContract.resolverVersions[0] !== canonicalDstResolverVersion()) {
    throw new CompletedSummerMaterializationError("unsupported_contract", "the B1 report contains an unsupported contract, comparator, generator, or resolver version");
  }
}

function validateApprovalInput(input: CompletedSummerMaterializationApprovalInput): void {
  assertPositiveInteger(input.organizationId, "organizationId");
  assertPositiveInteger(input.leagueId, "leagueId");
  assertPositiveInteger(input.actorUserId, "actorUserId");
  assertPositiveInteger(input.expectedSourceScheduleRevision, "expectedSourceScheduleRevision");
  if (input.reason.length === 0 || input.reason.trim() !== input.reason) {
    throw new CompletedSummerMaterializationError("invalid_request", "reason must be nonempty and trimmed");
  }
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 255 || input.idempotencyKey.trim() !== input.idempotencyKey) {
    throw new CompletedSummerMaterializationError("invalid_request", "idempotencyKey must be nonempty, trimmed, and at most 255 characters");
  }
  assertLowerSha256(input.reportFingerprint, "reportFingerprint");
  assertLowerSha256(input.inputFingerprint, "inputFingerprint");
  assertLowerSha256(input.physicalScheduleFingerprint, "physicalScheduleFingerprint");
  if (input.materializationContractVersion !== COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION) {
    throw new CompletedSummerMaterializationError("unsupported_contract", "the materialization contract version is unsupported");
  }
  if (input.requestedScope.organizationId !== input.organizationId || input.requestedScope.leagueId !== input.leagueId) {
    throw new CompletedSummerMaterializationError("report_scope_mismatch", "requested scope does not match the approval tenant and league");
  }
}

function isHardBlocker(finding: ComparisonFinding): boolean {
  if ((COMPLETED_SUMMER_HARD_BLOCKER_CODES as readonly string[]).includes(finding.code)) return true;
  return finding.code === "generator_discrepancy" && finding.evidence.generatorCode === "exception_collision";
}

function persistedFindings(league: CompletedSummerLeagueReport): CompletedSummerPersistedFindingPlan[] {
  const result: CompletedSummerPersistedFindingPlan[] = [];
  for (const finding of league.discrepancies) {
    if ((COMPLETED_SUMMER_PERSISTED_B1_DISCREPANCY_CODES as readonly string[]).includes(finding.code)) {
      result.push({
        stableReference: finding.stableReference,
        severity: finding.severity as "info" | "warning" | "error",
        code: finding.code as "ambiguous_historical_payment" | "duplicate_historical_game_key",
        generationKey: null,
        details: {
          stableReference: finding.stableReference,
          canonicalCandidateReference: finding.canonicalCandidateReference,
          legacySessionReferences: [...finding.legacySessionReferences],
          legacyGameIds: [...finding.legacyGameIds],
          legacyPaymentIds: [...finding.legacyPaymentIds],
          evidence: finding.evidence,
        },
      });
    }
  }
  for (const discrepancy of league.canonicalGeneration.discrepancies) {
    if (!(COMPLETED_SUMMER_PERSISTED_GENERATOR_DISCREPANCY_CODES as readonly string[]).includes(discrepancy.code)) continue;
    const stableReference = league.discrepancies.find((finding) =>
      finding.code === "generator_discrepancy" && finding.evidence.generatorCode === discrepancy.code
      && sameCanonicalValue(finding.evidence.details, discrepancy.details))?.stableReference;
    if (!stableReference) {
      throw new CompletedSummerMaterializationError("generator_result_mismatch", "a generator discrepancy is missing its stable B1 finding reference");
    }
    result.push({
      stableReference,
      severity: discrepancy.severity,
      code: discrepancy.code as "outside_season_occurrence" | "total_week_mismatch",
      generationKey: null,
      details: { stableReference, generatorDetails: discrepancy.details },
    });
  }
  return result.sort((left, right) => compareStrings(left.stableReference, right.stableReference));
}

function assertAcknowledgements(
  acknowledgements: readonly string[],
  league: CompletedSummerLeagueReport,
): string[] {
  const supplied = [...acknowledgements];
  if (new Set(supplied).size !== supplied.length) {
    throw new CompletedSummerMaterializationError("acknowledgement_mismatch", "finding acknowledgements must not contain duplicates");
  }
  const hardBlockers = league.discrepancies.filter(isHardBlocker);
  if (hardBlockers.length > 0) {
    throw new CompletedSummerMaterializationError(
      "hard_blocker",
      `B2 cannot waive hard-blocking finding ${hardBlockers.map((finding) => finding.stableReference).sort(compareStrings)[0]}`,
    );
  }
  const required = [...league.matchResults, ...league.discrepancies]
    .filter((finding) => finding.severity !== "info" && finding.severity !== "fatal")
    .map((finding) => finding.stableReference)
    .sort(compareStrings);
  const normalizedSupplied = supplied.sort(compareStrings);
  if (!sameCanonicalValue(normalizedSupplied, required)) {
    throw new CompletedSummerMaterializationError(
      "acknowledgement_mismatch",
      "acknowledgements must equal the sorted stable references of every waivable non-info B1 finding",
    );
  }
  return required;
}

function assertNoExistingA1Evidence(league: CompletedSummerLeagueReport): void {
  if (league.unexpectedExistingA1Evidence
    || Object.values(league.existingA1EvidenceCounts).some((count) => count !== 0)) {
    throw new CompletedSummerMaterializationError(
      "unexpected_existing_a1_evidence",
      "initial B2 approval requires zero pre-existing A1 evidence for the league",
    );
  }
}

function assertGenerationResult(report: CompletedSummerComparisonReport, league: CompletedSummerLeagueReport): void {
  const result = league.canonicalGeneration;
  if (result.resultContractVersion !== CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION
    || result.generatorVersion !== CANONICAL_OCCURRENCE_GENERATOR_VERSION
    || result.resolverVersion !== canonicalDstResolverVersion()) {
    throw new CompletedSummerMaterializationError("unsupported_contract", "the embedded A2 result uses an unsupported version");
  }
  if (result.fatalErrorCount !== 0 || result.fatalErrors.length !== 0 || result.counts.fatalErrorCount !== 0) {
    throw new CompletedSummerMaterializationError("generator_fatal_error", "B2 cannot materialize a generator result containing fatal errors");
  }
  const regenerated = generateCanonicalOccurrences(result.normalizedInput as CanonicalOccurrenceGeneratorInput);
  if (!sameCanonicalValue(regenerated, result)) {
    throw new CompletedSummerMaterializationError("generator_result_mismatch", "the embedded A2 result does not equal canonical regeneration");
  }
  if (report.generatorContract.resolverVersions[0] !== result.resolverVersion) {
    throw new CompletedSummerMaterializationError("generator_result_mismatch", "the report resolver summary does not match the embedded result");
  }
}

export function validateCompletedSummerMaterializationArtifact(input: {
  reportArtifact: string;
  approval: CompletedSummerMaterializationApprovalInput;
}): CompletedSummerMaterializationPlan {
  validateApprovalInput(input.approval);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.reportArtifact);
  } catch {
    throw new CompletedSummerMaterializationError("invalid_report_json", "the B1 report artifact is not valid JSON");
  }
  assertRecord(parsed, "the B1 report artifact must be a JSON object");
  assertCompletedSummerReportShape(parsed);
  const report = parsed;
  let canonicalArtifact: string;
  try {
    canonicalArtifact = canonicalJsonStringify(report);
  } catch {
    throw new CompletedSummerMaterializationError("invalid_report_json", "the B1 report artifact contains unsupported JSON values");
  }
  if (input.reportArtifact.trim() !== canonicalArtifact) {
    throw new CompletedSummerMaterializationError("noncanonical_report_json", "the B1 report artifact must be canonical stable JSON");
  }
  assertSupportedVersions(report);
  const recomputedFingerprint = recomputeCompletedSummerReportFingerprint(report);
  if (report.reportFingerprint !== recomputedFingerprint || input.approval.reportFingerprint !== recomputedFingerprint) {
    throw new CompletedSummerMaterializationError("report_fingerprint_mismatch", "the B1 report fingerprint does not recompute exactly or match approval");
  }
  if (report.fatalErrors.length !== 0 || report.aggregateCounts.fatalErrorCount !== 0) {
    throw new CompletedSummerMaterializationError("report_fatal_error", "B2 cannot materialize a report containing fatal errors");
  }
  if (report.leagues.length !== 1 || report.selectionSummary.selectedLeagueCount !== 1
    || report.selectionSummary.selectedLeagueIds.length !== 1) {
    throw new CompletedSummerMaterializationError("report_not_single_league", "B2 requires a B1 report for exactly one explicit league");
  }
  const league = report.leagues[0];
  if (report.normalizedOperatorInputs.leagueId === null
    || report.normalizedOperatorInputs.organizationId !== input.approval.organizationId
    || report.normalizedOperatorInputs.leagueId !== input.approval.leagueId
    || league.identity.organizationId !== input.approval.organizationId
    || league.identity.leagueId !== input.approval.leagueId
    || report.selectionSummary.selectedLeagueIds[0] !== input.approval.leagueId
    || !league.selectionEvidence.eligible) {
    throw new CompletedSummerMaterializationError("report_scope_mismatch", "the B1 report is not the requested explicit tenant-proven Completed-Summer league");
  }
  if (!sameCanonicalValue(report.normalizedOperatorInputs, input.approval.requestedScope)) {
    throw new CompletedSummerMaterializationError("report_scope_mismatch", "the B1 normalized operator inputs do not match the approval request");
  }
  if (input.approval.expectedSourceScheduleRevision !== report.normalizedOperatorInputs.sourceScheduleRevision
    || input.approval.expectedSourceScheduleRevision !== league.canonicalGeneration.normalizedInput.sourceScheduleRevision) {
    throw new CompletedSummerMaterializationError("source_revision_mismatch", "the approved source schedule revision is inconsistent");
  }
  assertGenerationResult(report, league);
  if (input.approval.inputFingerprint !== league.canonicalGeneration.inputFingerprint
    || input.approval.physicalScheduleFingerprint !== league.canonicalGeneration.physicalScheduleFingerprint) {
    throw new CompletedSummerMaterializationError("generator_result_mismatch", "the approved A2 fingerprints do not match the embedded generation result");
  }
  assertNoExistingA1Evidence(league);
  const requiredAcknowledgementReferences = assertAcknowledgements(input.approval.acknowledgedFindingReferences, league);
  const findings = persistedFindings(league);
  const generationResult = league.canonicalGeneration;
  return {
    materializationContractVersion: COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
    materializationSemanticsVersion: COMPLETED_SUMMER_MATERIALIZATION_SEMANTICS_VERSION,
    report,
    league,
    generationResult,
    approval: {
      ...input.approval,
      acknowledgedFindingReferences: requiredAcknowledgementReferences,
    },
    requiredAcknowledgementReferences,
    persistedFindings: findings,
    candidateSetFingerprint: sha256CanonicalJson({
      occurrenceCandidates: generationResult.occurrenceCandidates,
      exceptionCandidates: generationResult.exceptionCandidates,
      billingTermCandidates: generationResult.billingTermCandidates,
    }),
    materializationSemantics: {
      occurrenceLifecycle: "published",
      scheduledStatus: "scheduled",
      cancelledStatus: "cancelled",
      billingTermState: "published",
      skipExceptionLifecycle: "generator_intent",
      historicalLockTimestamp: "not_invented",
      cancellationTimestamp: "materialization_action_time",
      paymentLinking: "none",
      relationshipMaterialization: "none",
      occurrenceRevisionSnapshotVersion: COMPLETED_SUMMER_OCCURRENCE_REVISION_SNAPSHOT_VERSION,
      billingTermRevisionSnapshotVersion: COMPLETED_SUMMER_BILLING_TERM_REVISION_SNAPSHOT_VERSION,
      exceptionRevisionSnapshotVersion: COMPLETED_SUMMER_EXCEPTION_REVISION_SNAPSHOT_VERSION,
    },
    counts: {
      occurrences: generationResult.occurrenceCandidates.length,
      scheduledOccurrences: generationResult.occurrenceCandidates.filter((candidate) => candidate.status === "scheduled").length,
      cancelledOccurrences: generationResult.occurrenceCandidates.filter((candidate) => candidate.status === "cancelled").length,
      billingTerms: generationResult.billingTermCandidates.length,
      exceptions: generationResult.exceptionCandidates.length,
      persistedDiscrepancies: findings.length,
    },
  };
}

export function completedSummerMaterializationApprovalFingerprintPayload(plan: CompletedSummerMaterializationPlan): Record<string, unknown> {
  const { approval } = plan;
  return {
    materializationContractVersion: plan.materializationContractVersion,
    materializationSemanticsVersion: plan.materializationSemanticsVersion,
    organizationId: approval.organizationId,
    leagueId: approval.leagueId,
    reportFingerprint: approval.reportFingerprint,
    inputFingerprint: approval.inputFingerprint,
    physicalScheduleFingerprint: approval.physicalScheduleFingerprint,
    candidateSetFingerprint: plan.candidateSetFingerprint,
    expectedSourceScheduleRevision: approval.expectedSourceScheduleRevision,
    requestedScope: approval.requestedScope,
    acknowledgedFindingReferences: plan.requiredAcknowledgementReferences,
    materializationSemantics: plan.materializationSemantics,
  };
}

export function completedSummerRelatedCommandPayload(
  plan: CompletedSummerMaterializationPlan,
  role: "generate" | "publish" | "cancel" | "create_exception",
): Record<string, unknown> {
  return {
    materializationContractVersion: plan.materializationContractVersion,
    role,
    approvalReportFingerprint: plan.approval.reportFingerprint,
    approvalInputFingerprint: plan.approval.inputFingerprint,
    approvalPhysicalScheduleFingerprint: plan.approval.physicalScheduleFingerprint,
    candidateSetFingerprint: plan.candidateSetFingerprint,
    expectedSourceScheduleRevision: plan.approval.expectedSourceScheduleRevision,
    occurrenceCandidateReferences: plan.generationResult.occurrenceCandidates.map((candidate) => candidate.candidateReference).sort(compareStrings),
    exceptionCandidateReferences: plan.generationResult.exceptionCandidates.map((candidate) => candidate.candidateReference).sort(compareStrings),
    billingTermCandidateReferences: plan.generationResult.billingTermCandidates.map((candidate) => candidate.candidateReference).sort(compareStrings),
  };
}
