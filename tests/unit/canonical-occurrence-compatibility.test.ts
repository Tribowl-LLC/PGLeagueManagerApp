import { describe, expect, it } from "vitest";
import {
  compareCanonicalOccurrenceCompatibility,
  type OccurrenceCompatibilityCandidate,
} from "@shared/canonical-occurrence-compatibility";

const candidate: OccurrenceCompatibilityCandidate = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: 1,
  leagueId: 2,
  authoritativeLocalDate: "2035-03-11",
  authoritativeLocalStartTime: "19:00:00",
  timezone: "America/Detroit",
  startAt: "2035-03-11T23:00:00.000Z",
  foldResolution: "unambiguous",
  competitionNumber: 7,
  lifecycle: "published",
  status: "scheduled",
};

type CompareOptions = {
    candidates?: OccurrenceCompatibilityCandidate[];
    canonicalStatePresent?: boolean;
    publishedStatePresent?: boolean;
    referencedOccurrenceInScope?: boolean | null;
    existingReferenceId?: string | null;
  } & (
    | { subject: "game"; legacyCompetitionNumber: number; legacyTimestamp: string; duplicateLegacyKey: boolean }
    | { subject: "payment_schedule"; legacyStartAt: string; immediateUpfront: boolean; eligibilityNow: string }
    | { subject: "scheduled_operation"; legacyStartAt: string }
  );

function compare(input: CompareOptions) {
  const common = {
    organizationId: 1,
    leagueId: 2,
    canonicalStatePresent: input.canonicalStatePresent ?? true,
    publishedStatePresent: input.publishedStatePresent ?? true,
    referencedOccurrenceInScope: input.referencedOccurrenceInScope ?? null,
    candidates: input.candidates ?? [candidate],
  };
  if (input.subject === "game") {
    return compareCanonicalOccurrenceCompatibility({ ...common, ...input });
  }
  if (input.subject === "payment_schedule") {
    return compareCanonicalOccurrenceCompatibility({ ...common, ...input });
  }
  return compareCanonicalOccurrenceCompatibility({ ...common, ...input });
}

describe("D1 canonical occurrence compatibility comparator", () => {
  it("matches games only on exact local date, competition number, and meaningful start", () => {
    const dateOnly = compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11T00:00:00.000Z",
      duplicateLegacyKey: false,
    });
    expect(dateOnly.classification).toBe("exact_match");
    expect(dateOnly.occurrenceId).toBe(candidate.id);

    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 8,
      legacyTimestamp: "2035-03-11",
      duplicateLegacyKey: false,
    }).classification).toBe("legacy_number_mismatch");
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-18",
      duplicateLegacyKey: false,
    }).classification).toBe("legacy_date_or_start_mismatch");
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11T18:59:00",
      duplicateLegacyKey: false,
    }).classification).toBe("legacy_date_or_start_mismatch");
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11T19:00:00",
      duplicateLegacyKey: false,
    }).classification).toBe("exact_match");
  });

  it("never guesses duplicate, ambiguous, or ineligible game evidence", () => {
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11",
      duplicateLegacyKey: true,
    }).classification).toBe("ambiguous_match");
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11",
      duplicateLegacyKey: false,
      candidates: [candidate, { ...candidate, id: "22222222-2222-4222-8222-222222222222" }],
    }).classification).toBe("ambiguous_match");
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11",
      duplicateLegacyKey: false,
      candidates: [{ ...candidate, status: "cancelled" }],
    }).classification).toBe("ineligible_occurrence_state");
    expect(compare({
      subject: "game",
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11",
      duplicateLegacyKey: false,
      candidates: [{ ...candidate, status: "discarded", lifecycle: "draft" }],
    }).classification).toBe("ineligible_occurrence_state");
  });

  it("matches schedule cursors by exact UTC start only", () => {
    const exact = compare({
      subject: "payment_schedule",
      legacyStartAt: "2035-03-11T23:00:00.000Z",
      immediateUpfront: false,
      eligibilityNow: "2035-03-01T00:00:00.000Z",
    });
    expect(exact.classification).toBe("exact_match");
    expect(compare({
      subject: "payment_schedule",
      legacyStartAt: "2035-03-11T22:59:59.000Z",
      immediateUpfront: false,
      eligibilityNow: "2035-03-01T00:00:00.000Z",
    }).classification).toBe("no_match");
    expect(compare({
      subject: "payment_schedule",
      legacyStartAt: "2035-03-11T23:00:00.000Z",
      immediateUpfront: false,
      eligibilityNow: "2035-03-01T00:00:00.000Z",
      candidates: [{ ...candidate, lifecycle: "draft" }],
      publishedStatePresent: false,
    }).classification).toBe("canonical_not_published");
    expect(compare({
      subject: "payment_schedule",
      legacyStartAt: "2035-03-11T23:00:00.000Z",
      immediateUpfront: true,
      eligibilityNow: "2035-03-01T00:00:00.000Z",
    }).classification).toBe("no_match");
  });

  it("classifies absent state and immutable cross-scope references explicitly", () => {
    expect(compare({
      subject: "payment_schedule",
      legacyStartAt: "2035-03-11T23:00:00.000Z",
      immediateUpfront: false,
      eligibilityNow: "2035-03-01T00:00:00.000Z",
      candidates: [],
      canonicalStatePresent: false,
      publishedStatePresent: false,
    }).classification).toBe("canonical_state_absent");
    expect(compare({
      subject: "scheduled_operation",
      legacyStartAt: candidate.startAt,
      existingReferenceId: candidate.id,
      referencedOccurrenceInScope: false,
    }).classification).toBe("cross_tenant_or_cross_league_reference");
  });

  it("is deterministic and independent of host TZ for DST-safe matching", () => {
    const input = {
      subject: "game" as const,
      legacyCompetitionNumber: 7,
      legacyTimestamp: "2035-03-11T19:00:00",
      duplicateLegacyKey: false,
    };
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    const left = compare(input);
    process.env.TZ = "Asia/Tokyo";
    const right = compare(input);
    process.env.TZ = originalTz;
    expect(left).toEqual(right);
    expect(left.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const sameSemanticsDifferentRandomId = compare({
      ...input,
      candidates: [{ ...candidate, id: "33333333-3333-4333-8333-333333333333" }],
    });
    expect(sameSemanticsDifferentRandomId.occurrenceId).not.toBe(left.occurrenceId);
    expect(sameSemanticsDifferentRandomId.fingerprint).toBe(left.fingerprint);

    const differentNonSemanticClock = compare({
      subject: "payment_schedule",
      legacyStartAt: candidate.startAt,
      immediateUpfront: false,
      eligibilityNow: "2035-02-01T00:00:00.000Z",
    });
    const laterNonSemanticClock = compare({
      subject: "payment_schedule",
      legacyStartAt: candidate.startAt,
      immediateUpfront: false,
      eligibilityNow: "2035-03-01T00:00:00.000Z",
    });
    expect(differentNonSemanticClock.fingerprint).toBe(laterNonSemanticClock.fingerprint);
  });
});
