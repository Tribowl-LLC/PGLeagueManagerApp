import { describe, expect, it } from "vitest";
import { generateCanonicalOccurrences, type CanonicalOccurrenceGeneratorInput } from "@shared/canonical-occurrence-generator";
import {
  buildCompletedSummerComparisonReport,
  canonicalJsonStringify,
  compareCompletedSummerLeague,
  evaluateCompletedSummerSelection,
  sha256CanonicalJson,
  type CompletedSummerLeagueComparisonInput,
  type CompletedSummerOperatorInputs,
  type LegacyGameRowEvidence,
} from "@shared/completed-summer-comparator";

const operatorInputs: CompletedSummerOperatorInputs = {
  organizationId: 11,
  seasonYear: 2025,
  asOfDate: "2026-01-01",
  leagueId: null,
  sourceScheduleRevision: 7,
  ambiguousFold: "reject",
  currency: "USD",
  regularSessionBillingPolicy: "eligible_bowlers",
  billingOrdinalPolicy: "planned_slot",
};

function generatorInput(overrides: Partial<CanonicalOccurrenceGeneratorInput> = {}): CanonicalOccurrenceGeneratorInput {
  return {
    organizationId: 11,
    leagueId: 22,
    locationId: 33,
    sourceScheduleRevision: 7,
    seasonStart: "2025-06-01",
    seasonEnd: "2025-06-15",
    weekday: "Sunday",
    localCompetitionStartTime: "19:00",
    timezone: "America/New_York",
    plannedSlotCount: 3,
    skipExceptions: [],
    cancelledDates: [],
    ambiguousFold: "reject",
    defaultWeeklyAmountMinor: 2_000,
    currency: "USD",
    regularSessionBillingPolicy: "eligible_bowlers",
    billingOrdinalPolicy: "planned_slot",
    specialSessionBehavior: { mode: "regular_only", version: "1" },
    ...overrides,
  };
}

function game(weekNumber: number, gameNumber: number, date: string, id = weekNumber * 10 + gameNumber, scoreIds: number[] = []): LegacyGameRowEvidence {
  return {
    gameId: id,
    leagueId: 22,
    weekNumber,
    gameNumber,
    rawTimestamp: `${date}T19:00:00.000000`,
    mechanicalDate: date,
    provenStartAt: null,
    scoreIds,
  };
}

function session(weekNumber: number, date: string): LegacyGameRowEvidence[] {
  return [1, 2, 3].map((gameNumber) => game(weekNumber, gameNumber, date));
}

function comparison(overrides: Partial<CompletedSummerLeagueComparisonInput> = {}) {
  const generationResult = generateCanonicalOccurrences(generatorInput());
  return compareCompletedSummerLeague({
    identity: { organizationId: 11, leagueId: 22, locationId: 33 },
    selectionEvidence: evaluateCompletedSummerSelection({
      leagueId: 22,
      organizationId: 11,
      locationId: 33,
      locationOrganizationId: 11,
      active: true,
      seasonStartRaw: "2025-06-01 00:00:00",
      seasonEndRaw: "2025-06-15 00:00:00",
    }, operatorInputs),
    legacyScheduleConfiguration: {
      leagueId: 22,
      locationId: 33,
      organizationId: 11,
      active: true,
      seasonNumber: 2,
      previousSeasonId: 21,
      seasonStart: { raw: "2025-06-01 00:00:00", dateOnly: "2025-06-01" },
      seasonEnd: { raw: "2025-06-15 00:00:00", dateOnly: "2025-06-15" },
      weekday: "Sunday",
      totalBowlingWeeks: 3,
      competitionStartTime: "19:00",
      timezone: "America/New_York",
      skipDates: [],
      cancelledDates: [],
      weeklyFeeMinor: 2_000,
      paymentMode: "weekly",
    },
    legacyCollectionEvidence: {
      source: "leagues.double_pay_dates",
      doublePayDates: [],
      excludedFromGeneratorInput: true,
      excludedFromPhysicalComparison: true,
      excludedFromFingerprints: true,
      excludedFromBillingTermAmounts: true,
    },
    generationResult,
    legacyGameRows: [
      ...session(1, "2025-06-01"),
      ...session(2, "2025-06-08"),
      ...session(3, "2025-06-15"),
    ],
    legacyPayments: [],
    paymentOperations: [],
    existingA1EvidenceCounts: {
      commands: 0,
      generationRuns: 0,
      exceptions: 0,
      occurrences: 0,
      billingTerms: 0,
      relationships: 0,
      discrepancies: 0,
    },
    tenantEvidenceValid: true,
    ...overrides,
  });
}

describe("B1 Completed-Summer selection", () => {
  it.each([
    ["2025-06-01 23:30:00", "2025-08-31 23:30:00", true],
    ["2025-08-01T00:00:00", "2025-08-31T00:00:00", true],
    ["2025-05-31 00:00:00", "2025-08-31 00:00:00", false],
    ["2025-09-01 00:00:00", "2025-11-30 00:00:00", false],
    ["2025-08-01 00:00:00", "2026-01-01 00:00:00", false],
  ])("applies the product Summer boundaries to %s through %s", (start, end, eligible) => {
    expect(evaluateCompletedSummerSelection({
      leagueId: 22,
      organizationId: 11,
      locationId: 33,
      locationOrganizationId: 11,
      active: false,
      seasonStartRaw: start,
      seasonEndRaw: end,
    }, operatorInputs)).toMatchObject({ eligible, activeArchiveState: false });
  });

  it("requires strict completion, explicit year, and tenant-proven location without host-time conversion", () => {
    const base = {
      leagueId: 22,
      organizationId: 11,
      locationId: 33,
      locationOrganizationId: 11,
      active: true,
      seasonStartRaw: "2025-06-01 23:59:59",
      seasonEndRaw: "2026-01-01 00:00:00",
    };
    expect(evaluateCompletedSummerSelection(base, operatorInputs).completedBeforeAsOfDate).toBe(false);
    expect(evaluateCompletedSummerSelection({ ...base, seasonEndRaw: "2025-12-31 23:59:59" }, operatorInputs).eligible).toBe(true);
    expect(evaluateCompletedSummerSelection({ ...base, seasonStartRaw: "2024-06-01", seasonEndRaw: "2024-08-31" }, operatorInputs).requestedSeasonYear).toBe(false);
    expect(evaluateCompletedSummerSelection({ ...base, seasonEndRaw: "2025-08-31", locationOrganizationId: 12 }, operatorInputs).eligible).toBe(false);
  });
});

describe("B1 deterministic legacy comparison", () => {
  it("reports unique date/number matches while keeping legacy start instants unproven", () => {
    const report = comparison();
    expect(report.matchResults.filter((finding) => finding.code === "exact_match")).toHaveLength(3);
    expect(report.discrepancies.filter((finding) => finding.code === "legacy_start_time_unproven")).toHaveLength(3);
    expect(report.discrepancies.some((finding) => finding.code === "missing_expected_session")).toBe(false);
  });

  it("surfaces missing, unexpected, date-hint, and numbering mismatches without arbitrary matching", () => {
    const rows = [
      ...session(1, "2025-06-01"),
      ...session(2, "2025-06-09"),
      ...session(8, "2025-06-15"),
    ];
    const report = comparison({ legacyGameRows: rows });
    const codes = report.discrepancies.map((finding) => finding.code);
    expect(codes).toContain("local_date_mismatch");
    expect(codes).toContain("missing_expected_session");
    expect(codes).toContain("unexpected_legacy_session");
    expect(codes).toContain("competition_number_mismatch");
  });

  it("leaves multiple plausible date matches ambiguous and does not choose the lowest week or ID", () => {
    const report = comparison({
      legacyGameRows: [
        ...session(1, "2025-06-01"),
        ...session(9, "2025-06-01").map((row) => ({ ...row, gameId: row.gameId + 1_000 })),
      ],
    });
    expect(report.matchResults.some((finding) => finding.code === "exact_match")).toBe(false);
    expect(report.discrepancies.filter((finding) => finding.code === "unexpected_legacy_session")).toHaveLength(2);
    expect(report.discrepancies.map((finding) => finding.code)).toContain("missing_expected_session");
  });

  it("reports a proven start mismatch without overstating it as an exact match", () => {
    const rows = session(1, "2025-06-01").map((row) => ({
      ...row,
      provenStartAt: "2025-06-01T22:00:00.000Z",
    }));
    const report = comparison({ legacyGameRows: rows });
    expect(report.discrepancies.map((finding) => finding.code)).toContain("start_instant_mismatch");
    expect(report.matchResults.some((finding) => finding.code === "exact_match")).toBe(false);
  });

  it("preserves duplicate historical keys, all IDs and score activity, and inconsistent dates", () => {
    const rows = [
      game(1, 1, "2025-06-01", 10, [101]),
      game(1, 1, "2025-06-01", 11, [102, 103]),
      game(1, 2, "2025-06-02", 12),
    ];
    const report = comparison({ legacyGameRows: rows });
    const duplicate = report.discrepancies.find((finding) => finding.code === "duplicate_historical_game_key");
    expect(duplicate?.legacyGameIds).toEqual([10, 11]);
    expect(report.discrepancies.map((finding) => finding.code)).toContain("legacy_session_date_conflict");
    expect(report.discrepancies.map((finding) => finding.code)).toContain("legacy_game_number_missing");
    expect(report.scoreActivityEvidence).toEqual({ scoreCount: 3, scoredGameCount: 2, scoreIds: [101, 102, 103] });
  });

  it("treats skips as no occurrence and cancellations as activity conflicts with ordinal gaps retained", () => {
    const generated = generateCanonicalOccurrences(generatorInput({
      seasonEnd: "2025-06-22",
      skipExceptions: [{
        kind: "skip",
        localDate: "2025-06-08",
        reason: "holiday",
        source: "legacy_import",
        lifecycleIntent: "draft",
        generationRunAssociationIntent: "associate",
        candidateReference: "skip-1",
      }],
      cancelledDates: ["2025-06-15"],
    }));
    const report = comparison({
      generationResult: generated,
      legacyGameRows: [
        ...session(1, "2025-06-01"),
        ...session(2, "2025-06-08").map((row, index) => ({ ...row, scoreIds: index === 0 ? [88] : [] })),
        ...session(3, "2025-06-15").map((row, index) => ({ ...row, scoreIds: index === 0 ? [99] : [] })),
      ],
    });
    expect(report.discrepancies.map((finding) => finding.code)).toContain("skip_exception_conflict");
    expect(report.discrepancies.map((finding) => finding.code)).toContain("cancelled_session_activity");
    expect(generated.occurrenceCandidates.map((candidate) => [candidate.plannedOrdinal, candidate.competitionNumber])).toEqual([[1, 1], [2, null], [3, 3]]);
  });

  it("never promotes direct payment dates to allocations and retains operational/refund/dispute evidence", () => {
    const report = comparison({
      legacyPayments: [{
        paymentId: 501,
        amountMinor: 2_000,
        status: "paid",
        type: "cash",
        weekOfRaw: "2025-06-01T00:00:00.000000",
        mechanicalWeekOfDate: "2025-06-01",
        operationId: null,
        allocationIndex: null,
        refunded: false,
        disputed: false,
      }, {
        paymentId: 502,
        amountMinor: 2_000,
        status: "refunded",
        type: "square",
        weekOfRaw: "2025-06-08T00:00:00.000000",
        mechanicalWeekOfDate: "2025-06-08",
        operationId: "00000000-0000-4000-8000-000000000001",
        allocationIndex: 0,
        refunded: true,
        disputed: true,
      }],
      paymentOperations: [{
        operationId: "00000000-0000-4000-8000-000000000001",
        operationType: "interactive_charge",
        status: "succeeded",
        amountMinor: 2_000,
        currency: "USD",
        billingCycleAtRaw: null,
        mechanicalBillingCycleDate: null,
        snapshotKind: "interactive",
        snapshotVersion: 2,
        paymentId: null,
        refunded: true,
        disputed: true,
        disputeEvidence: [{
          disputeId: "00000000-0000-4000-8000-000000000002",
          state: "WON",
          reason: "NO_KNOWLEDGE",
          amountMinor: 2_000,
          currency: "USD",
          providerVersion: 3,
        }],
        allocations: [{
          allocationIndex: 0,
          amountMinor: 2_000,
          lineageAmountMinor: 500,
          prizeFundAmountMinor: 1_500,
          weekOfRaw: "2025-06-08T00:00:00.000000",
          mechanicalWeekOfDate: "2025-06-08",
        }],
      }],
    });
    expect(report.discrepancies.find((finding) => finding.code === "ambiguous_historical_payment")?.legacyPaymentIds).toEqual([501]);
    const proven = report.matchResults.find((finding) => finding.code === "proven_payment_operation_evidence");
    expect(proven?.legacyPaymentIds).toEqual([502]);
    expect(proven?.canonicalCandidateReference).toBeNull();
    expect(report.paymentEvidence.operations[0]).toMatchObject({ refunded: true, disputed: true });
  });

  it("keeps double-pay outside generation and physical matching", () => {
    const baseline = comparison();
    const withDoublePay = comparison({
      legacyCollectionEvidence: {
        ...baseline.legacyCollectionEvidence,
        doublePayDates: ["2025-06-08"],
      },
    });
    expect(withDoublePay.canonicalGeneration.inputFingerprint).toBe(baseline.canonicalGeneration.inputFingerprint);
    expect(withDoublePay.matchResults.map((finding) => finding.code)).toEqual(baseline.matchResults.map((finding) => finding.code));
  });

  it("reports generator fatal errors and does not emit usable partial session matches", () => {
    const report = comparison({
      generationResult: generateCanonicalOccurrences(generatorInput({ cancelledDates: ["2025-06-08", "2025-06-08"] })),
    });
    expect(report.discrepancies.map((finding) => finding.code)).toContain("generator_fatal_error");
    expect(report.matchResults.some((finding) => finding.code === "exact_match")).toBe(false);
  });

  it("passes canonical timezone, ordinary DST, fold, gap, UTC, and non-hour offset proofs through unchanged", () => {
    const alias = generateCanonicalOccurrences(generatorInput({ timezone: "US/Eastern" }));
    expect(alias.normalizedInput.timezone).toBe("America/New_York");
    expect(alias.occurrenceCandidates.map((candidate) => candidate.selectedUtcOffsetMinutes)).toEqual([-240, -240, -240]);
    const foldEarlier = generateCanonicalOccurrences(generatorInput({
      seasonStart: "2026-11-01",
      seasonEnd: "2026-11-01",
      plannedSlotCount: 1,
      localCompetitionStartTime: "01:30",
      ambiguousFold: "earlier",
    }));
    const foldLater = generateCanonicalOccurrences(generatorInput({
      seasonStart: "2026-11-01",
      seasonEnd: "2026-11-01",
      plannedSlotCount: 1,
      localCompetitionStartTime: "01:30",
      ambiguousFold: "later",
    }));
    expect(foldEarlier.occurrenceCandidates[0]).toMatchObject({ foldResolution: "earlier", selectedUtcOffsetMinutes: -240 });
    expect(foldLater.occurrenceCandidates[0]).toMatchObject({ foldResolution: "later", selectedUtcOffsetMinutes: -300 });
    expect(generateCanonicalOccurrences(generatorInput({
      seasonStart: "2026-03-08", seasonEnd: "2026-03-08", plannedSlotCount: 1, localCompetitionStartTime: "02:30",
    })).fatalErrors.map((error) => error.code)).toContain("invalid_dst_input");
    expect(generateCanonicalOccurrences(generatorInput({ timezone: "Etc/UTC" })).occurrenceCandidates[0]?.selectedUtcOffsetMinutes).toBe(0);
    expect(generateCanonicalOccurrences(generatorInput({ timezone: "Asia/Kathmandu" })).occurrenceCandidates[0]?.selectedUtcOffsetMinutes).toBe(345);
  });

  it("is byte-stable across equivalent ordering and fingerprints canonical JSON without its fingerprint field", () => {
    const firstLeague = comparison();
    const secondLeague = comparison({ identity: { organizationId: 11, leagueId: 23, locationId: 34 } });
    const first = buildCompletedSummerComparisonReport({
      normalizedOperatorInputs: operatorInputs,
      inspectedLeagueCount: 2,
      eligibleLeagueCount: 2,
      leagues: [secondLeague, firstLeague],
      fatalErrors: [],
    });
    const second = buildCompletedSummerComparisonReport({
      normalizedOperatorInputs: operatorInputs,
      inspectedLeagueCount: 2,
      eligibleLeagueCount: 2,
      leagues: [firstLeague, secondLeague],
      fatalErrors: [],
    });
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
    const { reportFingerprint, ...withoutFingerprint } = first;
    expect(reportFingerprint).toBe(sha256CanonicalJson(withoutFingerprint));
    expect(reportFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
