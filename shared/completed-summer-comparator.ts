import { createHash } from "node:crypto";
import {
  CANONICAL_OCCURRENCE_GENERATOR_VERSION,
  CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION,
  type CanonicalGenerationResult,
  type CanonicalOccurrenceCandidate,
} from "./canonical-occurrence-generator";

export const COMPLETED_SUMMER_SELECTION_CONTRACT_VERSION = "completed-summer-selection/1";
export const CANONICAL_OCCURRENCE_COMPARISON_REPORT_VERSION = "canonical-occurrence-comparison-report/1";
export const COMPLETED_SUMMER_COMPARATOR_VERSION = "completed-summer-comparator/3";

export interface CompletedSummerOperatorInputs {
  organizationId: number;
  seasonYear: number;
  asOfDate: string;
  leagueId: number | null;
  sourceScheduleRevision: number;
  ambiguousFold: "reject" | "earlier" | "later";
  currency: string;
  regularSessionBillingPolicy: "none" | "eligible_bowlers";
  billingOrdinalPolicy: "planned_slot" | "dense_billable";
}

export interface CompletedSummerSelectionCandidate {
  leagueId: number;
  organizationId: number | null;
  locationId: number | null;
  locationOrganizationId: number | null;
  active: boolean;
  seasonStartRaw: string | null;
  seasonEndRaw: string | null;
}

export interface CompletedSummerSelectionEvidence {
  seasonStartDate: string | null;
  seasonEndDate: string | null;
  sameCalendarYear: boolean;
  summerStartMonth: boolean;
  requestedSeasonYear: boolean;
  completedBeforeAsOfDate: boolean;
  activeArchiveState: boolean;
  eligible: boolean;
}

export interface LegacyScheduleConfiguration {
  leagueId: number;
  locationId: number;
  organizationId: number;
  active: boolean;
  seasonNumber: number;
  previousSeasonId: number | null;
  seasonStart: { raw: string; dateOnly: string };
  seasonEnd: { raw: string; dateOnly: string };
  weekday: string;
  totalBowlingWeeks: number;
  competitionStartTime: string;
  timezone: string;
  skipDates: string[];
  cancelledDates: string[];
  weeklyFeeMinor: number;
  paymentMode: string;
}

export interface LegacyCollectionEvidence {
  source: "leagues.double_pay_dates";
  doublePayDates: string[];
  excludedFromGeneratorInput: true;
  excludedFromPhysicalComparison: true;
  excludedFromA2InputFingerprint: true;
  excludedFromA2PhysicalScheduleFingerprint: true;
  excludedFromBillingTermAmounts: true;
}

export interface LegacyGameRowEvidence {
  gameId: number;
  leagueId: number;
  weekNumber: number;
  gameNumber: number;
  rawTimestamp: string;
  mechanicalDate: string | null;
  provenStartAt: string | null;
  scoreIds: number[];
}

export interface LegacyHistoricalGameGroup {
  historicalKey: string;
  leagueId: number;
  weekNumber: number;
  gameNumber: number;
  gameIds: number[];
  rawTimestamps: string[];
  mechanicalDates: string[];
  scoreIds: number[];
  scoreCount: number;
  duplicate: boolean;
}

export interface LegacySessionEvidence {
  sessionReference: string;
  leagueId: number;
  weekNumber: number;
  gameNumbers: number[];
  missingGameNumbers: number[];
  gameIds: number[];
  rawTimestamps: string[];
  mechanicalDates: string[];
  mechanicalLocalDate: string | null;
  provenStartAt: string | null;
  physicalTimeConfidence: "proven" | "mechanical_date_only" | "conflicting";
  scoreIds: number[];
  scoreCount: number;
  hasGameActivity: boolean;
  hasScoreActivity: boolean;
  duplicateHistoricalKeys: string[];
}

export interface LegacyPaymentEvidence {
  paymentId: number;
  amountMinor: number;
  status: string;
  type: string;
  weekOfRaw: string;
  mechanicalWeekOfDate: string | null;
  operationId: string | null;
  allocationIndex: number | null;
  operationLinkProof: "tenant_and_immutable_tuple" | null;
  refunded: boolean;
  disputed: boolean;
}

export interface PaymentOperationAllocationEvidence {
  allocationIndex: number;
  amountMinor: number;
  lineageAmountMinor: number | null;
  prizeFundAmountMinor: number | null;
  weekOfRaw: string | null;
  mechanicalWeekOfDate: string | null;
}

export interface PaymentOperationEvidence {
  operationId: string;
  operationType: "scheduled_charge" | "interactive_charge" | "refund";
  status: string;
  amountMinor: number;
  currency: string;
  billingCycleAtRaw: string | null;
  mechanicalBillingCycleDate: string | null;
  snapshotKind: "scheduled" | "interactive" | "refund";
  snapshotVersion: number;
  snapshotLocationProof: "tenant_location" | "organization_league_only";
  snapshotWeekOfRaw: string | null;
  mechanicalSnapshotWeekOfDate: string | null;
  paymentId: number | null;
  refunded: boolean;
  disputed: boolean;
  disputeEvidence: Array<{
    disputeId: string;
    state: string;
    reason: string;
    amountMinor: number;
    currency: string;
    providerVersion: number;
  }>;
  allocations: PaymentOperationAllocationEvidence[];
}

export interface ExistingA1EvidenceCounts {
  commands: number;
  generationRuns: number;
  exceptions: number;
  occurrences: number;
  billingTerms: number;
  relationships: number;
  discrepancies: number;
}

export type ComparisonCode =
  | "exact_match"
  | "missing_expected_session"
  | "unexpected_legacy_session"
  | "local_date_mismatch"
  | "start_instant_mismatch"
  | "legacy_start_time_unproven"
  | "competition_number_mismatch"
  | "duplicate_historical_game_key"
  | "legacy_game_number_missing"
  | "legacy_session_date_conflict"
  | "skip_exception_conflict"
  | "cancelled_session_activity"
  | "same_day_collision"
  | "exact_start_collision"
  | "generator_fatal_error"
  | "generator_discrepancy"
  | "ambiguous_historical_payment"
  | "proven_payment_operation_evidence"
  | "invalid_or_cross_tenant_evidence";

export interface ComparisonFinding {
  stableReference: string;
  severity: "info" | "warning" | "error" | "fatal";
  code: ComparisonCode;
  canonicalCandidateReference: string | null;
  legacySessionReferences: string[];
  legacyGameIds: number[];
  legacyPaymentIds: number[];
  paymentOperationIds: string[];
  evidence: Record<string, unknown>;
  explanation: string;
}

export interface CompletedSummerLeagueComparisonInput {
  identity: { organizationId: number; leagueId: number; locationId: number };
  selectionEvidence: CompletedSummerSelectionEvidence;
  legacyScheduleConfiguration: LegacyScheduleConfiguration;
  legacyCollectionEvidence: LegacyCollectionEvidence;
  generationResult: CanonicalGenerationResult;
  legacyGameRows: LegacyGameRowEvidence[];
  legacyPayments: LegacyPaymentEvidence[];
  paymentOperations: PaymentOperationEvidence[];
  existingA1EvidenceCounts: ExistingA1EvidenceCounts;
  tenantEvidenceValid: boolean;
}

export interface CompletedSummerLeagueReport {
  identity: { organizationId: number; leagueId: number; locationId: number };
  selectionEvidence: CompletedSummerSelectionEvidence;
  legacyScheduleConfiguration: LegacyScheduleConfiguration;
  legacyCollectionEvidence: LegacyCollectionEvidence;
  canonicalGeneration: CanonicalGenerationResult;
  legacyGameGroups: LegacyHistoricalGameGroup[];
  legacySessions: LegacySessionEvidence[];
  scoreActivityEvidence: {
    scoreCount: number;
    scoredGameCount: number;
    scoreIds: number[];
  };
  paymentEvidence: {
    confidence: "absent" | "ambiguous_legacy_only" | "proven_operation" | "mixed";
    legacyPayments: LegacyPaymentEvidence[];
    operations: PaymentOperationEvidence[];
  };
  existingA1EvidenceCounts: ExistingA1EvidenceCounts;
  unexpectedExistingA1Evidence: boolean;
  matchResults: ComparisonFinding[];
  discrepancies: ComparisonFinding[];
  summary: {
    matchCount: number;
    discrepancyCount: number;
    severityCounts: Record<string, number>;
    classificationCounts: Record<string, number>;
  };
}

export interface ReportFatalError {
  stableReference: string;
  severity: "fatal";
  code: string;
  leagueId: number | null;
  message: string;
}

export interface CompletedSummerComparisonReport {
  reportContractVersion: typeof CANONICAL_OCCURRENCE_COMPARISON_REPORT_VERSION;
  comparatorImplementationVersion: typeof COMPLETED_SUMMER_COMPARATOR_VERSION;
  selectionContractVersion: typeof COMPLETED_SUMMER_SELECTION_CONTRACT_VERSION;
  normalizedOperatorInputs: CompletedSummerOperatorInputs;
  generatorContract: {
    generatorVersion: string;
    resultContractVersion: string;
    resolverVersions: string[];
  };
  reportFingerprint: string;
  selectionSummary: {
    inspectedLeagueCount: number;
    eligibleLeagueCount: number;
    selectedLeagueCount: number;
    activeSelectedLeagueCount: number;
    archivedSelectedLeagueCount: number;
    selectedLeagueIds: number[];
  };
  aggregateCounts: {
    leagueCount: number;
    matchCount: number;
    discrepancyCount: number;
    fatalErrorCount: number;
    severityCounts: Record<string, number>;
    classificationCounts: Record<string, number>;
  };
  leagues: CompletedSummerLeagueReport[];
  fatalErrors: ReportFatalError[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareStrings).map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON cannot contain undefined or unsupported values");
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
}

export function extractStoredDateOnly(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(12, 0, 0, 0);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function evaluateCompletedSummerSelection(
  candidate: CompletedSummerSelectionCandidate,
  inputs: Pick<CompletedSummerOperatorInputs, "organizationId" | "seasonYear" | "asOfDate">,
): CompletedSummerSelectionEvidence {
  const seasonStartDate = extractStoredDateOnly(candidate.seasonStartRaw);
  const seasonEndDate = extractStoredDateOnly(candidate.seasonEndRaw);
  const startYear = seasonStartDate === null ? null : Number(seasonStartDate.slice(0, 4));
  const endYear = seasonEndDate === null ? null : Number(seasonEndDate.slice(0, 4));
  const startMonth = seasonStartDate === null ? null : Number(seasonStartDate.slice(5, 7));
  const sameCalendarYear = startYear !== null && startYear === endYear;
  const summerStartMonth = startMonth !== null && startMonth >= 6 && startMonth <= 8;
  const requestedSeasonYear = startYear === inputs.seasonYear;
  const completedBeforeAsOfDate = seasonEndDate !== null && seasonEndDate < inputs.asOfDate;
  const tenantAndLocationProven = candidate.organizationId === inputs.organizationId
    && candidate.locationId !== null
    && candidate.locationOrganizationId === inputs.organizationId;
  return {
    seasonStartDate,
    seasonEndDate,
    sameCalendarYear,
    summerStartMonth,
    requestedSeasonYear,
    completedBeforeAsOfDate,
    activeArchiveState: candidate.active,
    eligible: tenantAndLocationProven
      && sameCalendarYear
      && summerStartMonth
      && requestedSeasonYear
      && completedBeforeAsOfDate,
  };
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort(compareNumbers);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function groupLegacyGameEvidence(rows: readonly LegacyGameRowEvidence[]): {
  groups: LegacyHistoricalGameGroup[];
  sessions: LegacySessionEvidence[];
} {
  const sortedRows = [...rows].sort((left, right) => left.leagueId - right.leagueId
    || left.weekNumber - right.weekNumber
    || left.gameNumber - right.gameNumber
    || left.gameId - right.gameId);
  const byHistoricalKey = new Map<string, LegacyGameRowEvidence[]>();
  for (const row of sortedRows) {
    const key = `${row.leagueId}:${row.weekNumber}:${row.gameNumber}`;
    const values = byHistoricalKey.get(key) ?? [];
    values.push(row);
    byHistoricalKey.set(key, values);
  }
  const groups = [...byHistoricalKey.entries()].map(([historicalKey, members]) => ({
    historicalKey,
    leagueId: members[0].leagueId,
    weekNumber: members[0].weekNumber,
    gameNumber: members[0].gameNumber,
    gameIds: members.map((row) => row.gameId).sort(compareNumbers),
    rawTimestamps: uniqueSortedStrings(members.map((row) => row.rawTimestamp)),
    mechanicalDates: uniqueSortedStrings(members.flatMap((row) => row.mechanicalDate === null ? [] : [row.mechanicalDate])),
    scoreIds: uniqueSortedNumbers(members.flatMap((row) => row.scoreIds)),
    scoreCount: members.reduce((total, row) => total + row.scoreIds.length, 0),
    duplicate: members.length > 1,
  })).sort((left, right) => left.leagueId - right.leagueId
    || left.weekNumber - right.weekNumber
    || left.gameNumber - right.gameNumber
    || compareStrings(left.historicalKey, right.historicalKey));

  const bySession = new Map<string, LegacyGameRowEvidence[]>();
  for (const row of sortedRows) {
    const key = `${row.leagueId}:${row.weekNumber}`;
    const values = bySession.get(key) ?? [];
    values.push(row);
    bySession.set(key, values);
  }
  const sessions = [...bySession.entries()].map(([key, members]) => {
    const dates = uniqueSortedStrings(members.flatMap((row) => row.mechanicalDate === null ? [] : [row.mechanicalDate]));
    const provenStarts = uniqueSortedStrings(members.flatMap((row) => row.provenStartAt === null ? [] : [row.provenStartAt]));
    const leagueId = members[0].leagueId;
    const weekNumber = members[0].weekNumber;
    const gameNumbers = uniqueSortedNumbers(members.map((row) => row.gameNumber));
    const missingGameNumbers = [1, 2, 3].filter((number) => !gameNumbers.includes(number));
    const duplicateHistoricalKeys = groups
      .filter((group) => group.leagueId === leagueId && group.weekNumber === weekNumber && group.duplicate)
      .map((group) => group.historicalKey)
      .sort(compareStrings);
    const mechanicalLocalDate = dates.length === 1 ? dates[0] : null;
    const provenStartAt = provenStarts.length === 1 && dates.length === 1 ? provenStarts[0] : null;
    return {
      sessionReference: `legacy-session:${key}`,
      leagueId,
      weekNumber,
      gameNumbers,
      missingGameNumbers,
      gameIds: members.map((row) => row.gameId).sort(compareNumbers),
      rawTimestamps: uniqueSortedStrings(members.map((row) => row.rawTimestamp)),
      mechanicalDates: dates,
      mechanicalLocalDate,
      provenStartAt,
      physicalTimeConfidence: dates.length !== 1
        ? "conflicting" as const
        : provenStartAt === null ? "mechanical_date_only" as const : "proven" as const,
      scoreIds: uniqueSortedNumbers(members.flatMap((row) => row.scoreIds)),
      scoreCount: members.reduce((total, row) => total + row.scoreIds.length, 0),
      hasGameActivity: members.length > 0,
      hasScoreActivity: members.some((row) => row.scoreIds.length > 0),
      duplicateHistoricalKeys,
    };
  }).sort((left, right) => left.leagueId - right.leagueId
    || left.weekNumber - right.weekNumber
    || compareStrings(left.sessionReference, right.sessionReference));
  return { groups, sessions };
}

function finding(input: Omit<ComparisonFinding, "stableReference"> & { referenceSeed: unknown }): ComparisonFinding {
  const { referenceSeed, ...semantic } = input;
  return {
    stableReference: `b1:${semantic.code}:${sha256CanonicalJson(referenceSeed).slice(0, 24)}`,
    ...semantic,
  };
}

function findingOrder(left: ComparisonFinding, right: ComparisonFinding): number {
  return compareStrings(left.code, right.code)
    || compareStrings(left.canonicalCandidateReference ?? "", right.canonicalCandidateReference ?? "")
    || compareStrings(left.stableReference, right.stableReference);
}

function commonFindingEvidence(session: LegacySessionEvidence | null): Pick<ComparisonFinding, "legacySessionReferences" | "legacyGameIds"> {
  return {
    legacySessionReferences: session === null ? [] : [session.sessionReference],
    legacyGameIds: session === null ? [] : session.gameIds,
  };
}

function candidateCollisions(candidates: readonly CanonicalOccurrenceCandidate[]): ComparisonFinding[] {
  const findings: ComparisonFinding[] = [];
  for (const [field, code] of [
    ["authoritativeLocalDate", "same_day_collision"],
    ["startAt", "exact_start_collision"],
  ] as const) {
    const byValue = new Map<string, CanonicalOccurrenceCandidate[]>();
    for (const candidate of candidates) {
      const value = candidate[field];
      const members = byValue.get(value) ?? [];
      members.push(candidate);
      byValue.set(value, members);
    }
    for (const [value, members] of [...byValue.entries()].sort(([left], [right]) => compareStrings(left, right))) {
      if (members.length < 2) continue;
      const references = members.map((candidate) => candidate.candidateReference).sort(compareStrings);
      findings.push(finding({
        referenceSeed: { code, value, references },
        severity: "error",
        code,
        canonicalCandidateReference: references[0],
        legacySessionReferences: [],
        legacyGameIds: [],
        legacyPaymentIds: [],
        paymentOperationIds: [],
        evidence: { value, canonicalCandidateReferences: references },
        explanation: code === "same_day_collision"
          ? "Multiple canonical candidates share one authoritative local date."
          : "Multiple canonical candidates share one exact canonical UTC start instant.",
      }));
    }
  }
  return findings;
}

function countsFor(findings: readonly ComparisonFinding[]): {
  severityCounts: Record<string, number>;
  classificationCounts: Record<string, number>;
} {
  const severityCounts: Record<string, number> = {};
  const classificationCounts: Record<string, number> = {};
  for (const item of findings) {
    severityCounts[item.severity] = (severityCounts[item.severity] ?? 0) + 1;
    classificationCounts[item.code] = (classificationCounts[item.code] ?? 0) + 1;
  }
  return {
    severityCounts: Object.fromEntries(Object.entries(severityCounts).sort(([left], [right]) => compareStrings(left, right))),
    classificationCounts: Object.fromEntries(Object.entries(classificationCounts).sort(([left], [right]) => compareStrings(left, right))),
  };
}

export function compareCompletedSummerLeague(input: CompletedSummerLeagueComparisonInput): CompletedSummerLeagueReport {
  const { groups, sessions } = groupLegacyGameEvidence(input.legacyGameRows);
  const matches: ComparisonFinding[] = [];
  const discrepancies: ComparisonFinding[] = [];
  const matchedSessions = new Set<string>();

  if (!input.tenantEvidenceValid) {
    discrepancies.push(finding({
      referenceSeed: { code: "invalid_or_cross_tenant_evidence", leagueId: input.identity.leagueId },
      severity: "fatal",
      code: "invalid_or_cross_tenant_evidence",
      canonicalCandidateReference: null,
      legacySessionReferences: [],
      legacyGameIds: [],
      legacyPaymentIds: [],
      paymentOperationIds: [],
      evidence: { leagueId: input.identity.leagueId, detailsSuppressed: true },
      explanation: "Related evidence could not be proven to belong to the selected tenant; foreign row details are suppressed.",
    }));
  }

  for (const group of groups.filter((candidate) => candidate.duplicate)) {
    discrepancies.push(finding({
      referenceSeed: { code: "duplicate_historical_game_key", historicalKey: group.historicalKey, gameIds: group.gameIds },
      severity: "error",
      code: "duplicate_historical_game_key",
      canonicalCandidateReference: null,
      legacySessionReferences: [`legacy-session:${group.leagueId}:${group.weekNumber}`],
      legacyGameIds: group.gameIds,
      legacyPaymentIds: [],
      paymentOperationIds: [],
      evidence: { historicalKey: group.historicalKey, scoreCount: group.scoreCount },
      explanation: "The historical logical game key is not unique; every row is retained and none is chosen as authoritative.",
    }));
  }
  for (const session of sessions) {
    if (session.missingGameNumbers.length > 0) {
      discrepancies.push(finding({
        referenceSeed: { code: "legacy_game_number_missing", session: session.sessionReference, missing: session.missingGameNumbers },
        severity: "warning",
        code: "legacy_game_number_missing",
        canonicalCandidateReference: null,
        ...commonFindingEvidence(session),
        legacyPaymentIds: [],
        paymentOperationIds: [],
        evidence: { observedGameNumbers: session.gameNumbers, missingGameNumbers: session.missingGameNumbers },
        explanation: "The legacy session does not contain all UI-supported game numbers 1 through 3; missing games were not manufactured.",
      }));
    }
    if (session.mechanicalDates.length !== 1) {
      discrepancies.push(finding({
        referenceSeed: { code: "legacy_session_date_conflict", session: session.sessionReference, dates: session.mechanicalDates },
        severity: "error",
        code: "legacy_session_date_conflict",
        canonicalCandidateReference: null,
        ...commonFindingEvidence(session),
        legacyPaymentIds: [],
        paymentOperationIds: [],
        evidence: { mechanicalDates: session.mechanicalDates, rawTimestamps: session.rawTimestamps },
        explanation: "Games sharing a legacy week number contain inconsistent stored dates, so the session cannot be matched uniquely.",
      }));
    }
  }

  discrepancies.push(...candidateCollisions(input.generationResult.occurrenceCandidates));
  for (const generatorError of input.generationResult.fatalErrors) {
    discrepancies.push(finding({
      referenceSeed: { code: "generator_fatal_error", generatorError },
      severity: "fatal",
      code: "generator_fatal_error",
      canonicalCandidateReference: null,
      legacySessionReferences: [],
      legacyGameIds: [],
      legacyPaymentIds: [],
      paymentOperationIds: [],
      evidence: { generatorCode: generatorError.code, path: generatorError.path, inputIndex: generatorError.inputIndex },
      explanation: generatorError.message,
    }));
  }
  for (const generatorDiscrepancy of input.generationResult.discrepancies) {
    discrepancies.push(finding({
      referenceSeed: { code: "generator_discrepancy", generatorDiscrepancy },
      severity: generatorDiscrepancy.severity,
      code: "generator_discrepancy",
      canonicalCandidateReference: null,
      legacySessionReferences: [],
      legacyGameIds: [],
      legacyPaymentIds: [],
      paymentOperationIds: [],
      evidence: { generatorCode: generatorDiscrepancy.code, details: generatorDiscrepancy.details },
      explanation: `The A2 generator reported ${generatorDiscrepancy.code}; it remains distinct evidence.`,
    }));
  }

  if (input.generationResult.fatalErrors.length === 0) {
    const comparableSessions = sessions.filter((session) => session.mechanicalLocalDate !== null);
    const sessionsByDate = new Map<string, LegacySessionEvidence[]>();
    const activitySessionsByDate = new Map<string, LegacySessionEvidence[]>();
    const candidatesByDate = new Map<string, CanonicalOccurrenceCandidate[]>();
    const candidatesByStart = new Map<string, CanonicalOccurrenceCandidate[]>();
    for (const session of comparableSessions) {
      const date = session.mechanicalLocalDate as string;
      const values = sessionsByDate.get(date) ?? [];
      values.push(session);
      sessionsByDate.set(date, values);
    }
    for (const session of sessions) {
      for (const date of session.mechanicalDates) {
        const values = activitySessionsByDate.get(date) ?? [];
        values.push(session);
        activitySessionsByDate.set(date, values);
      }
    }
    for (const candidate of input.generationResult.occurrenceCandidates) {
      const dateMembers = candidatesByDate.get(candidate.authoritativeLocalDate) ?? [];
      dateMembers.push(candidate);
      candidatesByDate.set(candidate.authoritativeLocalDate, dateMembers);
      const startMembers = candidatesByStart.get(candidate.startAt) ?? [];
      startMembers.push(candidate);
      candidatesByStart.set(candidate.startAt, startMembers);
    }
    for (const exception of input.generationResult.exceptionCandidates) {
      const conflicts = activitySessionsByDate.get(exception.authoritativeLocalDate) ?? [];
      for (const session of conflicts) {
        matchedSessions.add(session.sessionReference);
        discrepancies.push(finding({
          referenceSeed: { code: "skip_exception_conflict", exception: exception.candidateReference, session: session.sessionReference },
          severity: "error",
          code: "skip_exception_conflict",
          canonicalCandidateReference: exception.candidateReference,
          ...commonFindingEvidence(session),
          legacyPaymentIds: [],
          paymentOperationIds: [],
          evidence: { localDate: exception.authoritativeLocalDate, scoreCount: session.scoreCount },
          explanation: "A skip exception creates no canonical occurrence, but legacy game or score activity exists on that date.",
        }));
      }
    }
    for (const candidate of input.generationResult.occurrenceCandidates) {
      if (candidate.status === "cancelled") {
        for (const session of activitySessionsByDate.get(candidate.authoritativeLocalDate) ?? []) {
          matchedSessions.add(session.sessionReference);
          discrepancies.push(finding({
            referenceSeed: { code: "cancelled_session_activity", candidate: candidate.candidateReference, session: session.sessionReference },
            severity: "error",
            code: "cancelled_session_activity",
            canonicalCandidateReference: candidate.candidateReference,
            ...commonFindingEvidence(session),
            legacyPaymentIds: [],
            paymentOperationIds: [],
            evidence: { localDate: candidate.authoritativeLocalDate, gameCount: session.gameIds.length, scoreCount: session.scoreCount },
            explanation: "The canonical planned slot is cancelled and expects no competitive activity, but legacy games or scores are present.",
          }));
        }
        continue;
      }
      const exactDateSessions = sessionsByDate.get(candidate.authoritativeLocalDate) ?? [];
      const canonicalDateCandidates = candidatesByDate.get(candidate.authoritativeLocalDate) ?? [];
      const canonicalStartCandidates = candidatesByStart.get(candidate.startAt) ?? [];
      const uniqueCanonicalPhysicalCandidate = canonicalDateCandidates.length === 1
        && canonicalStartCandidates.length === 1;
      if (exactDateSessions.length === 1 && uniqueCanonicalPhysicalCandidate) {
        const session = exactDateSessions[0];
        matchedSessions.add(session.sessionReference);
        if (session.weekNumber === candidate.competitionNumber) {
          if (session.provenStartAt === candidate.startAt) {
            matches.push(finding({
              referenceSeed: { code: "exact_match", candidate: candidate.candidateReference, session: session.sessionReference },
              severity: "info",
              code: "exact_match",
              canonicalCandidateReference: candidate.candidateReference,
              ...commonFindingEvidence(session),
              legacyPaymentIds: [],
              paymentOperationIds: [],
              evidence: { localDate: candidate.authoritativeLocalDate, competitionNumber: candidate.competitionNumber },
              explanation: "One legacy session uniquely matches the canonical local date, competition number, and proven UTC start instant.",
            }));
          }
        } else {
          discrepancies.push(finding({
            referenceSeed: { code: "competition_number_mismatch", candidate: candidate.candidateReference, session: session.sessionReference },
            severity: "error",
            code: "competition_number_mismatch",
            canonicalCandidateReference: candidate.candidateReference,
            ...commonFindingEvidence(session),
            legacyPaymentIds: [],
            paymentOperationIds: [],
            evidence: { canonicalCompetitionNumber: candidate.competitionNumber, legacyWeekNumber: session.weekNumber },
            explanation: "After a unique date match, the legacy week number differs from the canonical competition number.",
          }));
        }
        if (session.provenStartAt === null) {
          discrepancies.push(finding({
            referenceSeed: { code: "legacy_start_time_unproven", candidate: candidate.candidateReference, session: session.sessionReference },
            severity: "warning",
            code: "legacy_start_time_unproven",
            canonicalCandidateReference: candidate.candidateReference,
            ...commonFindingEvidence(session),
            legacyPaymentIds: [],
            paymentOperationIds: [],
            evidence: { canonicalStartAt: candidate.startAt, rawLegacyTimestamps: session.rawTimestamps },
            explanation: "Legacy game timestamps have no reviewed canonical timezone contract, so their exact physical start instant is unproven.",
          }));
        } else if (session.provenStartAt !== candidate.startAt) {
          discrepancies.push(finding({
            referenceSeed: { code: "start_instant_mismatch", candidate: candidate.candidateReference, session: session.sessionReference },
            severity: "error",
            code: "start_instant_mismatch",
            canonicalCandidateReference: candidate.candidateReference,
            ...commonFindingEvidence(session),
            legacyPaymentIds: [],
            paymentOperationIds: [],
            evidence: { canonicalStartAt: candidate.startAt, provenLegacyStartAt: session.provenStartAt },
            explanation: "The uniquely proven legacy start instant differs from the A2 canonical start instant.",
          }));
        }
        continue;
      }
      const weekHints = sessions.filter((session) => session.weekNumber === candidate.competitionNumber
        && !matchedSessions.has(session.sessionReference));
      if (weekHints.length === 1) {
        const hint = weekHints[0];
        discrepancies.push(finding({
          referenceSeed: { code: "local_date_mismatch", candidate: candidate.candidateReference, session: hint.sessionReference },
          severity: "warning",
          code: "local_date_mismatch",
          canonicalCandidateReference: candidate.candidateReference,
          ...commonFindingEvidence(hint),
          legacyPaymentIds: [],
          paymentOperationIds: [],
          evidence: { canonicalLocalDate: candidate.authoritativeLocalDate, legacyMechanicalDates: hint.mechanicalDates, weekNumberHintOnly: true },
          explanation: "A unique week-number similarity suggests a date mismatch, but it is only a hint and is not promoted to an exact match.",
        }));
      }
      discrepancies.push(finding({
        referenceSeed: { code: "missing_expected_session", candidate: candidate.candidateReference },
        severity: "error",
        code: "missing_expected_session",
        canonicalCandidateReference: candidate.candidateReference,
        legacySessionReferences: [],
        legacyGameIds: [],
        legacyPaymentIds: [],
        paymentOperationIds: [],
        evidence: { canonicalLocalDate: candidate.authoritativeLocalDate, competitionNumber: candidate.competitionNumber },
        explanation: exactDateSessions.length > 1
          ? "Multiple legacy sessions share the canonical date, so no arbitrary match was selected."
          : !uniqueCanonicalPhysicalCandidate
            ? "The canonical date or start instant collides with another canonical candidate, so no one-to-one match was selected."
          : "No uniquely date-matched legacy session proves the expected canonical competition activity.",
      }));
    }
    for (const session of sessions.filter((candidate) => !matchedSessions.has(candidate.sessionReference))) {
      discrepancies.push(finding({
        referenceSeed: { code: "unexpected_legacy_session", session: session.sessionReference },
        severity: "error",
        code: "unexpected_legacy_session",
        canonicalCandidateReference: null,
        ...commonFindingEvidence(session),
        legacyPaymentIds: [],
        paymentOperationIds: [],
        evidence: { weekNumber: session.weekNumber, mechanicalDates: session.mechanicalDates, scoreCount: session.scoreCount },
        explanation: "The legacy session has no unique canonical counterpart and remains unmatched.",
      }));
    }
  }

  const sortedLegacyPayments = [...input.legacyPayments].sort((left, right) => left.paymentId - right.paymentId);
  const sortedOperations = [...input.paymentOperations].map((operation) => ({
    ...operation,
    allocations: [...operation.allocations].sort((left, right) => left.allocationIndex - right.allocationIndex),
    disputeEvidence: [...operation.disputeEvidence].sort((left, right) => compareStrings(left.disputeId, right.disputeId)),
  })).sort((left, right) => compareStrings(left.operationId, right.operationId));
  const operationAllocationKeys = new Set(sortedOperations.flatMap((operation) => operation.allocations
    .map((allocation) => `${operation.operationId}:${allocation.allocationIndex}`)));
  for (const payment of sortedLegacyPayments) {
    const proven = payment.operationLinkProof === "tenant_and_immutable_tuple"
      && payment.operationId !== null
      && payment.allocationIndex !== null
      && operationAllocationKeys.has(`${payment.operationId}:${payment.allocationIndex}`);
    if (proven) continue;
    discrepancies.push(finding({
      referenceSeed: { code: "ambiguous_historical_payment", paymentId: payment.paymentId },
      severity: "warning",
      code: "ambiguous_historical_payment",
      canonicalCandidateReference: null,
      legacySessionReferences: [],
      legacyGameIds: [],
      legacyPaymentIds: [payment.paymentId],
      paymentOperationIds: [],
      evidence: { weekOfRaw: payment.weekOfRaw, amountMinor: payment.amountMinor, status: payment.status },
      explanation: "Legacy payment week proximity does not prove a canonical occurrence obligation or allocation.",
    }));
  }
  for (const operation of sortedOperations) {
    const linkedPayments = sortedLegacyPayments.filter((payment) => payment.operationId === operation.operationId
      && payment.operationLinkProof === "tenant_and_immutable_tuple");
    matches.push(finding({
      referenceSeed: { code: "proven_payment_operation_evidence", operationId: operation.operationId },
      severity: operation.refunded || operation.disputed ? "warning" : "info",
      code: "proven_payment_operation_evidence",
      canonicalCandidateReference: null,
      legacySessionReferences: [],
      legacyGameIds: [],
      legacyPaymentIds: linkedPayments.map((payment) => payment.paymentId),
      paymentOperationIds: [operation.operationId],
      evidence: {
        operationType: operation.operationType,
        status: operation.status,
        billingCycleAtRaw: operation.billingCycleAtRaw,
        snapshotLocationProof: operation.snapshotLocationProof,
        snapshotWeekOfRaw: operation.snapshotWeekOfRaw,
        allocationIndexes: operation.allocations.map((allocation) => allocation.allocationIndex),
        refunded: operation.refunded,
        disputed: operation.disputed,
      },
      explanation: operation.snapshotLocationProof === "tenant_location"
        ? "An immutable tenant-location-proven payment-operation path is retained as cycle/allocation evidence, without linking it to a canonical occurrence."
        : "An immutable organization/league-proven payment-operation path has no snapshot location; its weaker location proof is explicit and it is not linked to a canonical occurrence.",
    }));
  }

  matches.sort(findingOrder);
  discrepancies.sort(findingOrder);
  const allFindings = [...matches, ...discrepancies];
  const summaryCounts = countsFor(allFindings);
  const scoreIds = uniqueSortedNumbers(input.legacyGameRows.flatMap((row) => row.scoreIds));
  const scoredGameCount = input.legacyGameRows.filter((row) => row.scoreIds.length > 0).length;
  const hasLegacy = sortedLegacyPayments.length > 0;
  const hasOperations = sortedOperations.length > 0;
  const a1Counts = Object.values(input.existingA1EvidenceCounts);
  return {
    identity: input.identity,
    selectionEvidence: input.selectionEvidence,
    legacyScheduleConfiguration: {
      ...input.legacyScheduleConfiguration,
      skipDates: [...input.legacyScheduleConfiguration.skipDates].sort(compareStrings),
      cancelledDates: [...input.legacyScheduleConfiguration.cancelledDates].sort(compareStrings),
    },
    legacyCollectionEvidence: {
      ...input.legacyCollectionEvidence,
      doublePayDates: [...input.legacyCollectionEvidence.doublePayDates].sort(compareStrings),
    },
    canonicalGeneration: input.generationResult,
    legacyGameGroups: groups,
    legacySessions: sessions,
    scoreActivityEvidence: { scoreCount: scoreIds.length, scoredGameCount, scoreIds },
    paymentEvidence: {
      confidence: hasLegacy && hasOperations ? "mixed" : hasOperations ? "proven_operation" : hasLegacy ? "ambiguous_legacy_only" : "absent",
      legacyPayments: sortedLegacyPayments,
      operations: sortedOperations,
    },
    existingA1EvidenceCounts: input.existingA1EvidenceCounts,
    unexpectedExistingA1Evidence: a1Counts.some((count) => count > 0),
    matchResults: matches,
    discrepancies,
    summary: {
      matchCount: matches.filter((item) => item.code === "exact_match").length,
      discrepancyCount: discrepancies.length,
      ...summaryCounts,
    },
  };
}

function mergeCounts(records: readonly Record<string, number>[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) result[key] = (result[key] ?? 0) + value;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareStrings(left, right)));
}

export function buildCompletedSummerComparisonReport(input: {
  normalizedOperatorInputs: CompletedSummerOperatorInputs;
  inspectedLeagueCount: number;
  eligibleLeagueCount: number;
  leagues: CompletedSummerLeagueReport[];
  fatalErrors: Array<Omit<ReportFatalError, "stableReference" | "severity">>;
}): CompletedSummerComparisonReport {
  const leagues = [...input.leagues].sort((left, right) => left.identity.leagueId - right.identity.leagueId);
  const leagueFatalErrors = leagues.flatMap((league) => league.discrepancies
    .filter((finding) => finding.severity === "fatal")
    .map((finding) => ({
      code: finding.code,
      leagueId: league.identity.leagueId,
      message: finding.explanation,
    })));
  const uniqueFatalErrors = new Map<string, Omit<ReportFatalError, "stableReference" | "severity">>();
  for (const fatal of [...input.fatalErrors, ...leagueFatalErrors]) {
    uniqueFatalErrors.set(canonicalJsonStringify(fatal), fatal);
  }
  const fatalErrors = [...uniqueFatalErrors.values()].map((fatal) => ({
    stableReference: `b1:fatal:${sha256CanonicalJson(fatal).slice(0, 24)}`,
    severity: "fatal" as const,
    ...fatal,
  })).sort((left, right) => (left.leagueId ?? -1) - (right.leagueId ?? -1)
    || compareStrings(left.code, right.code)
    || compareStrings(left.stableReference, right.stableReference));
  const selectedLeagueIds = leagues.map((league) => league.identity.leagueId);
  const resolverVersions = uniqueSortedStrings(leagues.map((league) => league.canonicalGeneration.resolverVersion));
  const reportWithoutFingerprint = {
    reportContractVersion: CANONICAL_OCCURRENCE_COMPARISON_REPORT_VERSION,
    comparatorImplementationVersion: COMPLETED_SUMMER_COMPARATOR_VERSION,
    selectionContractVersion: COMPLETED_SUMMER_SELECTION_CONTRACT_VERSION,
    normalizedOperatorInputs: input.normalizedOperatorInputs,
    generatorContract: {
      generatorVersion: CANONICAL_OCCURRENCE_GENERATOR_VERSION,
      resultContractVersion: CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION,
      resolverVersions,
    },
    selectionSummary: {
      inspectedLeagueCount: input.inspectedLeagueCount,
      eligibleLeagueCount: input.eligibleLeagueCount,
      selectedLeagueCount: leagues.length,
      activeSelectedLeagueCount: leagues.filter((league) => league.selectionEvidence.activeArchiveState).length,
      archivedSelectedLeagueCount: leagues.filter((league) => !league.selectionEvidence.activeArchiveState).length,
      selectedLeagueIds,
    },
    aggregateCounts: {
      leagueCount: leagues.length,
      matchCount: leagues.reduce((total, league) => total + league.summary.matchCount, 0),
      discrepancyCount: leagues.reduce((total, league) => total + league.summary.discrepancyCount, 0),
      fatalErrorCount: fatalErrors.length,
      severityCounts: mergeCounts(leagues.map((league) => league.summary.severityCounts)),
      classificationCounts: mergeCounts(leagues.map((league) => league.summary.classificationCounts)),
    },
    leagues,
    fatalErrors,
  } satisfies Omit<CompletedSummerComparisonReport, "reportFingerprint">;
  return {
    ...reportWithoutFingerprint,
    reportFingerprint: sha256CanonicalJson(reportWithoutFingerprint),
  };
}
