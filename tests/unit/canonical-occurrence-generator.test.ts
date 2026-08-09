import { describe, expect, it } from "vitest";
import {
  generateCanonicalOccurrences,
  type CanonicalOccurrenceGeneratorInput,
} from "@shared/canonical-occurrence-generator";
import {
  CanonicalDstResolutionError,
  resolveCanonicalLocalDateTime,
} from "@shared/canonical-dst-resolver";

function input(overrides: Partial<CanonicalOccurrenceGeneratorInput> = {}): CanonicalOccurrenceGeneratorInput {
  return {
    organizationId: 11,
    leagueId: 22,
    locationId: 33,
    sourceScheduleRevision: 4,
    seasonStart: "2026-01-01",
    seasonEnd: "2026-02-01",
    weekday: "Sunday",
    localCompetitionStartTime: "19:00",
    timezone: "America/New_York",
    plannedSlotCount: 4,
    skipExceptions: [],
    cancelledDates: [],
    ambiguousFold: "reject",
    defaultWeeklyAmountMinor: 2000,
    currency: "USD",
    regularSessionBillingPolicy: "eligible_bowlers",
    billingOrdinalPolicy: "planned_slot",
    specialSessionBehavior: { mode: "regular_only", version: "1" },
    ...overrides,
  };
}

describe("A2 canonical occurrence generator", () => {
  it("starts on the first configured weekday and preserves skip/cancel numbering gaps", () => {
    const result = generateCanonicalOccurrences(input({
      seasonStart: "2026-01-01",
      seasonEnd: "2026-02-01",
      plannedSlotCount: 4,
      skipExceptions: [{
        kind: "skip",
        localDate: "2026-01-11",
        reason: "facility holiday",
        source: "manual",
        lifecycleIntent: "draft",
        generationRunAssociationIntent: "associate",
        candidateReference: "skip-facility-holiday",
      }],
      cancelledDates: ["2026-01-18"],
    }));

    expect(result.fatalErrors).toEqual([]);
    expect(result.occurrenceCandidates.map((candidate) => [
      candidate.authoritativeLocalDate,
      candidate.plannedOrdinal,
      candidate.competitionNumber,
      candidate.status,
      candidate.competitive,
    ])).toEqual([
      ["2026-01-04", 1, 1, "scheduled", true],
      ["2026-01-18", 2, null, "cancelled", false],
      ["2026-01-25", 3, 3, "scheduled", true],
      ["2026-02-01", 4, 4, "scheduled", true],
    ]);
    expect(result.exceptionCandidates[0]).toMatchObject({
      kind: "skip",
      authoritativeLocalDate: "2026-01-11",
      timezone: "America/New_York",
      reason: "facility holiday",
      source: "manual",
      lifecycleIntent: "draft",
      generationRunAssociationIntent: "associate",
    });
    expect(result.exceptionCandidates[0]?.candidateKey).not.toBe("2026-01-11");
    expect(result.billingTermCandidates.map((term) => [term.defaultAmountMinor, term.billingOrdinal, term.obligationPolicy])).toEqual([
      [2000, 1, "eligible_bowlers"],
      [0, null, "none"],
      [2000, 3, "eligible_bowlers"],
      [2000, 4, "eligible_bowlers"],
    ]);
    expect(result.counts).toMatchObject({
      generatedOccurrenceCount: 4,
      skippedDateCount: 1,
      candidateOccurrenceCount: 5,
      fatalErrorCount: 0,
    });
  });

  it("uses deterministic canonical normalization and excludes legacy double-pay evidence", () => {
    const common = input({
      timezone: "US/Eastern",
      cancelledDates: ["2026-01-18", "2026-01-04"],
      skipExceptions: [{
        kind: "skip",
        localDate: "2026-01-11",
        reason: "facility holiday",
        source: "manual",
        lifecycleIntent: "draft",
        generationRunAssociationIntent: "associate",
        candidateReference: "skip-facility-holiday",
      }],
    });
    const first = generateCanonicalOccurrences(common);
    const second = generateCanonicalOccurrences({
      ...common,
      timezone: "America/New_York",
      cancelledDates: ["2026-01-04", "2026-01-18"],
    });
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second.occurrenceCandidates).toEqual(first.occurrenceCandidates);
    expect(first.normalizedInput.timezone).toBe("America/New_York");

    const withLegacyEvidence = Object.assign({}, common, { doublePayDates: ["2026-01-18"] });
    const third = generateCanonicalOccurrences(withLegacyEvidence);
    expect(third.inputFingerprint).toBe(first.inputFingerprint);
    expect(third.billingTermCandidates).toEqual(first.billingTermCandidates);
  });

  it("retains duplicate multiplicity as fatal evidence and does not return partial candidates", () => {
    const duplicate = generateCanonicalOccurrences(input({ cancelledDates: ["2026-01-18", "2026-01-18"] }));
    const valid = generateCanonicalOccurrences(input({ cancelledDates: ["2026-01-18"] }));
    expect(duplicate.fatalErrors.some((issue) => issue.code === "duplicate_cancelled_date")).toBe(true);
    expect(duplicate.occurrenceCandidates).toEqual([]);
    expect(duplicate.billingTermCandidates).toEqual([]);
    expect(duplicate.counts).toMatchObject({
      generatedOccurrenceCount: 0,
      skippedDateCount: 0,
      candidateOccurrenceCount: 0,
    });
    expect(duplicate.inputFingerprint).not.toBe(valid.inputFingerprint);
  });

  it("returns explicit season-end discrepancy while terminating only on planned slots", () => {
    const result = generateCanonicalOccurrences(input({ seasonEnd: "2026-01-18", plannedSlotCount: 4 }));
    expect(result.fatalErrors).toEqual([]);
    expect(result.occurrenceCandidates).toHaveLength(4);
    expect(result.generationRange.endDate).toBe("2026-01-25");
    expect(result.discrepancies).toEqual(expect.arrayContaining([{
      severity: "warning",
      code: "total_week_mismatch",
      details: { expectedSeasonEnd: "2026-01-18", generatedFinalDate: "2026-01-25" },
    }]));
    expect(result.discrepancies.some((issue) => issue.code === "outside_season_occurrence")).toBe(true);
  });

  it("rejects invalid pre-generation billing and duplicate skip input without a usable schedule", () => {
    const result = generateCanonicalOccurrences(input({
      defaultWeeklyAmountMinor: 0,
      skipExceptions: [
        {
          kind: "skip",
          localDate: "2026-01-11",
          reason: "holiday",
          source: "generator",
          lifecycleIntent: "draft",
          generationRunAssociationIntent: "associate",
          candidateReference: "same",
        },
        {
          kind: "skip",
          localDate: "2026-01-11",
          reason: "holiday duplicate",
          source: "generator",
          lifecycleIntent: "draft",
          generationRunAssociationIntent: "associate",
          candidateReference: "same-2",
        },
      ],
    }));
    expect(result.fatalErrors.map((issue) => issue.code)).toEqual([
      "invalid_billing_amount",
      "duplicate_skip_date",
    ]);
    expect(result.occurrenceCandidates).toEqual([]);
  });
});

describe("A2 canonical DST resolver", () => {
  it("rejects gaps and requires an explicit fold policy", () => {
    expect(() => resolveCanonicalLocalDateTime({
      localDate: "2026-03-08",
      localTime: "02:30",
      timezone: "America/New_York",
      ambiguousFold: "reject",
    })).toThrowError(expect.objectContaining<Partial<CanonicalDstResolutionError>>({ code: "nonexistent_local_time" }));
    expect(() => resolveCanonicalLocalDateTime({
      localDate: "2026-11-01",
      localTime: "01:30",
      timezone: "America/New_York",
      ambiguousFold: "reject",
    })).toThrowError(expect.objectContaining<Partial<CanonicalDstResolutionError>>({ code: "ambiguous_local_time" }));
  });

  it("selects earlier/later folds, canonicalizes aliases, and reports runtime tzdata", () => {
    const earlier = resolveCanonicalLocalDateTime({
      localDate: "2026-11-01",
      localTime: "01:30:00",
      timezone: "US/Eastern",
      ambiguousFold: "earlier",
    });
    const later = resolveCanonicalLocalDateTime({
      localDate: "2026-11-01",
      localTime: "01:30:00",
      timezone: "America/New_York",
      ambiguousFold: "later",
    });
    expect(earlier).toMatchObject({ canonicalTimezone: "America/New_York", selectedUtcOffsetMinutes: -240, foldResolution: "earlier" });
    expect(later).toMatchObject({ canonicalTimezone: "America/New_York", selectedUtcOffsetMinutes: -300, foldResolution: "later" });
    expect(earlier.startAt).toBe("2026-11-01T05:30:00.000Z");
    expect(later.startAt).toBe("2026-11-01T06:30:00.000Z");
    expect(earlier.resolverVersion).toMatch(/^canonical-dst-resolver\/1;icu=.+;tzdata=.+$/);
    expect(earlier.resolverVersion.length).toBeLessThanOrEqual(128);
  });

  it("is independent of host TZ and locale defaults", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      const resolved = resolveCanonicalLocalDateTime({
        localDate: "2026-06-07",
        localTime: "19:00",
        timezone: "Etc/UTC",
        ambiguousFold: "reject",
      });
      expect(resolved).toMatchObject({ canonicalTimezone: "UTC", selectedUtcOffsetMinutes: 0, foldResolution: "unambiguous" });
      expect(resolved.startAt).toBe("2026-06-07T19:00:00.000Z");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
