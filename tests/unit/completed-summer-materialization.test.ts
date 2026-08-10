import { describe, expect, it } from "vitest";
import {
  generateCanonicalOccurrences,
  type CanonicalOccurrenceGeneratorInput,
} from "@shared/canonical-occurrence-generator";
import {
  buildCompletedSummerComparisonReport,
  canonicalJsonStringify,
  compareCompletedSummerLeague,
  evaluateCompletedSummerSelection,
  type CompletedSummerLeagueComparisonInput,
  type CompletedSummerOperatorInputs,
  type LegacyGameRowEvidence,
} from "@shared/completed-summer-comparator";
import {
  COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
  CompletedSummerMaterializationError,
  validateCompletedSummerMaterializationArtifact,
  type CompletedSummerMaterializationApprovalInput,
} from "@shared/completed-summer-materialization";
import {
  buildCompletedSummerMaterializationCommandRequests,
  buildCompletedSummerMaterializationPlanResult,
} from "../../server/services/completed-summer-materialization";
import { parseCompletedSummerMaterializationArguments } from "../../scripts/materialize-completed-summer-occurrences";

const scope: CompletedSummerOperatorInputs & { leagueId: number } = {
  organizationId: 11,
  seasonYear: 2025,
  asOfDate: "2026-01-01",
  leagueId: 22,
  sourceScheduleRevision: 1,
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
    sourceScheduleRevision: 1,
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

function session(
  weekNumber: number,
  date: string,
  provenStartAt: string | null,
): LegacyGameRowEvidence[] {
  return [1, 2, 3].map((gameNumber) => ({
    gameId: weekNumber * 10 + gameNumber,
    leagueId: 22,
    weekNumber,
    gameNumber,
    rawTimestamp: `${date}T19:00:00.000000`,
    mechanicalDate: date,
    provenStartAt,
    scoreIds: [],
  }));
}

function leagueComparison(overrides: Partial<CompletedSummerLeagueComparisonInput> = {}) {
  const generationResult = overrides.generationResult ?? generateCanonicalOccurrences(generatorInput());
  const legacyGameRows = generationResult.occurrenceCandidates.flatMap((candidate) => candidate.status === "cancelled" ? [] : session(
    candidate.competitionNumber as number,
    candidate.authoritativeLocalDate,
    candidate.startAt,
  ));
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
    }, scope),
    legacyScheduleConfiguration: {
      leagueId: 22,
      locationId: 33,
      organizationId: 11,
      active: true,
      seasonNumber: 1,
      previousSeasonId: null,
      seasonStart: { raw: "2025-06-01 00:00:00", dateOnly: "2025-06-01" },
      seasonEnd: { raw: "2025-06-15 00:00:00", dateOnly: "2025-06-15" },
      weekday: "Sunday",
      totalBowlingWeeks: generationResult.normalizedInput.plannedSlotCount,
      competitionStartTime: "19:00",
      timezone: "America/New_York",
      skipDates: generationResult.normalizedInput.skipExceptions.map((exception) => exception.localDate),
      cancelledDates: generationResult.normalizedInput.cancelledDates,
      weeklyFeeMinor: 2_000,
      paymentMode: "weekly",
    },
    legacyCollectionEvidence: {
      source: "leagues.double_pay_dates",
      doublePayDates: ["2025-06-08"],
      excludedFromGeneratorInput: true,
      excludedFromPhysicalComparison: true,
      excludedFromA2InputFingerprint: true,
      excludedFromA2PhysicalScheduleFingerprint: true,
      excludedFromBillingTermAmounts: true,
    },
    generationResult,
    legacyGameRows,
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

function report(overrides: Partial<CompletedSummerLeagueComparisonInput> = {}) {
  return buildCompletedSummerComparisonReport({
    normalizedOperatorInputs: scope,
    inspectedLeagueCount: 1,
    eligibleLeagueCount: 1,
    leagues: [leagueComparison(overrides)],
    fatalErrors: [],
  });
}

function approvalFor(
  value: ReturnType<typeof report>,
  overrides: Partial<CompletedSummerMaterializationApprovalInput> = {},
): CompletedSummerMaterializationApprovalInput {
  const league = value.leagues[0];
  return {
    organizationId: 11,
    leagueId: 22,
    actorUserId: 44,
    reason: "Reviewed Completed-Summer canonical history",
    idempotencyKey: "test",
    reportFingerprint: value.reportFingerprint,
    inputFingerprint: league.canonicalGeneration.inputFingerprint,
    physicalScheduleFingerprint: league.canonicalGeneration.physicalScheduleFingerprint,
    expectedSourceScheduleRevision: 1,
    materializationContractVersion: COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
    acknowledgedFindingReferences: [],
    requestedScope: scope,
    ...overrides,
  };
}

function validate(value = report(), approvalOverrides: Partial<CompletedSummerMaterializationApprovalInput> = {}) {
  return validateCompletedSummerMaterializationArtifact({
    reportArtifact: canonicalJsonStringify(value),
    approval: approvalFor(value, approvalOverrides),
  });
}

function expectMaterializationError(callback: () => unknown, code: string): void {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CompletedSummerMaterializationError);
  expect(caught).toMatchObject({ code });
}

describe("B2 Completed-Summer approval contract", () => {
  it("validates one canonical explicit report and produces a deterministic zero-write plan", () => {
    const first = validate();
    const second = validate();
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
    expect(first.counts).toEqual({
      occurrences: 3,
      scheduledOccurrences: 3,
      cancelledOccurrences: 0,
      billingTerms: 3,
      exceptions: 0,
      persistedDiscrepancies: 0,
    });
    expect(first.materializationSemantics).toMatchObject({
      historicalLockTimestamp: "not_invented",
      paymentLinking: "none",
      relationshipMaterialization: "none",
    });
    expect(buildCompletedSummerMaterializationPlanResult(first)).toMatchObject({
      mode: "plan",
      writesPerformed: false,
      legacyWritesPerformed: false,
      paymentOrObligationLinksCreated: false,
      durableIds: null,
    });
  });

  it("rejects noncanonical JSON, tampering, unsupported versions, multi-league scope, and existing A1 evidence", () => {
    const baseline = report();
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: JSON.stringify(baseline, null, 2),
      approval: approvalFor(baseline),
    }), "noncanonical_report_json");
    const tampered = structuredClone(baseline);
    tampered.leagues[0].legacyScheduleConfiguration.weeklyFeeMinor += 1;
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(tampered),
      approval: approvalFor(baseline),
    }), "report_fingerprint_mismatch");
    const unsupported = {
      ...structuredClone(baseline),
      comparatorImplementationVersion: "completed-summer-comparator/999",
    };
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(unsupported),
      approval: approvalFor(baseline),
    }), "unsupported_contract");
    const multi = structuredClone(baseline);
    multi.leagues.push(structuredClone(multi.leagues[0]));
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(multi),
      approval: approvalFor(baseline),
    }), "report_fingerprint_mismatch");
    const withA1 = report({
      existingA1EvidenceCounts: {
        commands: 1,
        generationRuns: 0,
        exceptions: 0,
        occurrences: 0,
        billingTerms: 0,
        relationships: 0,
        discrepancies: 0,
      },
    });
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(withA1),
      approval: approvalFor(withA1),
    }), "unexpected_existing_a1_evidence");
  });

  it("requires exactly every waivable non-info stable reference and blocks contradictory activity", () => {
    const unproven = report({
      legacyGameRows: [
        ...session(1, "2025-06-01", null),
        ...session(2, "2025-06-08", null),
        ...session(3, "2025-06-15", null),
      ],
    });
    const required = unproven.leagues[0].discrepancies.map((finding) => finding.stableReference).sort();
    expect(required).toHaveLength(3);
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(unproven),
      approval: approvalFor(unproven),
    }), "acknowledgement_mismatch");
    expect(validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(unproven),
      approval: approvalFor(unproven, { acknowledgedFindingReferences: [...required].reverse() }),
    }).requiredAcknowledgementReferences).toEqual(required);
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(unproven),
      approval: approvalFor(unproven, { acknowledgedFindingReferences: [...required, required[0]] }),
    }), "acknowledgement_mismatch");

    const cancelledGeneration = generateCanonicalOccurrences(generatorInput({ cancelledDates: ["2025-06-08"] }));
    const contradictory = report({
      generationResult: cancelledGeneration,
      legacyGameRows: [
        ...session(1, "2025-06-01", cancelledGeneration.occurrenceCandidates[0].startAt),
        ...session(2, "2025-06-08", null),
        ...session(2, "2025-06-15", cancelledGeneration.occurrenceCandidates[2].startAt),
      ],
    });
    const allNonInfo = contradictory.leagues[0].discrepancies
      .filter((finding) => finding.severity !== "info" && finding.severity !== "fatal")
      .map((finding) => finding.stableReference);
    expectMaterializationError(() => validateCompletedSummerMaterializationArtifact({
      reportArtifact: canonicalJsonStringify(contradictory),
      approval: approvalFor(contradictory, { acknowledgedFindingReferences: allNonInfo }),
    }), "hard_blocker");
  });

  it("binds actor, reason, acknowledgements, report, generator, and semantics into lvcanoncmd:v1", () => {
    const baseline = validate();
    const baseFingerprint = buildCompletedSummerMaterializationCommandRequests(baseline).approval.requestFingerprint;
    expect(baseFingerprint).toMatch(/^lvcanoncmd:v1:[0-9a-f]{64}$/);
    const changedActor = validate(report(), { actorUserId: 45 });
    const changedReason = validate(report(), { reason: "A different reviewed approval reason" });
    expect(buildCompletedSummerMaterializationCommandRequests(changedActor).approval.requestFingerprint).not.toBe(baseFingerprint);
    expect(buildCompletedSummerMaterializationCommandRequests(changedReason).approval.requestFingerprint).not.toBe(baseFingerprint);
  });
});

describe("B2 operator apply gate", () => {
  const baseArgs = [
    "--reportFile=/tmp/report.json",
    "--organizationId=11",
    "--leagueId=22",
    "--seasonYear=2025",
    "--asOfDate=2026-01-01",
    "--sourceScheduleRevision=1",
    "--ambiguousFold=reject",
    "--currency=USD",
    "--regularSessionBillingPolicy=eligible_bowlers",
    "--billingOrdinalPolicy=planned_slot",
    "--actorUserId=44",
    "--reason=Reviewed Completed-Summer canonical history",
    "--idempotencyKey=test",
    `--reportFingerprint=${"a".repeat(64)}`,
    `--inputFingerprint=${"b".repeat(64)}`,
    `--physicalScheduleFingerprint=${"c".repeat(64)}`,
    `--materializationContract=${COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION}`,
  ];

  it("defaults to plan-only and rejects unknown, duplicate, or misplaced confirmation flags", () => {
    expect(parseCompletedSummerMaterializationArguments(baseArgs)).toMatchObject({ apply: false });
    expect(() => parseCompletedSummerMaterializationArguments([...baseArgs, "--wat"])).toThrow(/unknown argument/);
    expect(() => parseCompletedSummerMaterializationArguments([...baseArgs, "--leagueId=23"])).toThrow(/only once/);
    expect(() => parseCompletedSummerMaterializationArguments([
      ...baseArgs,
      "--confirmReportFingerprint=a",
    ])).toThrow(/only with --apply/);
    expect(() => parseCompletedSummerMaterializationArguments([
      ...baseArgs,
      "--acknowledge=b1:test",
      "--acknowledge=b1:test",
    ])).toThrow(/must not be duplicated/);
  });
});
