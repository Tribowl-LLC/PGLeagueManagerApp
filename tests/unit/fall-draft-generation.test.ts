import { describe, expect, it } from "vitest";
import { generateCanonicalOccurrences } from "@shared/canonical-occurrence-generator";
import {
  FALL_DRAFT_APPLY_REQUEST_VERSION,
  FALL_DRAFT_PREVIEW_REQUEST_VERSION,
  fallDraftApplyRequestSchema,
  fallDraftCandidateSetFingerprint,
  fallDraftPreviewRequestSchema,
  fallDraftPreviewFingerprint,
  fallDraftRegularSessionBillingPolicyForPaymentMode,
  fallDraftSha256,
} from "@shared/fall-draft-generation";
import { getProductSeasonFromDateOnly } from "@shared/season-utils";

describe("C1 Fall classification", () => {
  it.each([
    ["2032-07-31", "Summer"],
    ["2032-08-01", "Fall"],
    ["2032-09-01", "Fall"],
    ["2032-10-31", "Fall"],
    ["2032-11-01", "Winter"],
  ] as const)("classifies %s as %s", (date, expected) => {
    expect(getProductSeasonFromDateOnly(date)).toBe(expected);
  });

  it("uses the start calendar month for a cross-year Fall season and rejects invalid dates", () => {
    expect(getProductSeasonFromDateOnly("2032-09-01")).toBe("Fall");
    expect(getProductSeasonFromDateOnly("2032-02-30")).toBeNull();
    expect(getProductSeasonFromDateOnly("2032-9-01")).toBeNull();
  });
});

describe("C1 semantic fingerprints", () => {
  const generation = generateCanonicalOccurrences({
    organizationId: 4,
    leagueId: 9,
    locationId: 12,
    sourceScheduleRevision: 1,
    seasonStart: "2032-08-01",
    seasonEnd: "2032-08-29",
    weekday: "Sunday",
    localCompetitionStartTime: "19:00",
    timezone: "America/New_York",
    plannedSlotCount: 4,
    skipExceptions: [],
    cancelledDates: ["2032-08-15"],
    ambiguousFold: "reject",
    defaultWeeklyAmountMinor: 2_000,
    currency: "USD",
    regularSessionBillingPolicy: "eligible_bowlers",
    billingOrdinalPolicy: "planned_slot",
    specialSessionBehavior: { mode: "regular_only", version: "1" },
  });

  it("produces a deterministic candidate-set fingerprint and changes for semantic candidates", () => {
    const first = fallDraftCandidateSetFingerprint(generation);
    expect(fallDraftCandidateSetFingerprint(structuredClone(generation))).toBe(first);
    expect(fallDraftSha256({ ...generation.occurrenceCandidates[0], status: "cancelled" }))
      .not.toBe(fallDraftSha256(generation.occurrenceCandidates[0]));
  });

  it("excludes only the previewFingerprint field from the preview fingerprint", () => {
    const semantic = {
      previewContractVersion: "fall-draft-generation-preview/2",
      operatorScope: { organizationId: 4, leagueId: 9, locationId: 12 },
      semantics: { currency: "USD", ambiguousFold: "reject" },
      occurrenceCandidates: generation.occurrenceCandidates,
    };
    const fingerprint = fallDraftPreviewFingerprint(semantic);
    expect(fallDraftPreviewFingerprint({ ...semantic, previewFingerprint: fingerprint })).toBe(fingerprint);
    expect(fallDraftPreviewFingerprint({
      ...semantic,
      semantics: { currency: "CAD", ambiguousFold: "reject" },
    })).not.toBe(fingerprint);
  });
});

describe("C1 fixed system policy contracts", () => {
  const semantics = {
    billingOrdinalPolicy: "planned_slot",
  } as const;

  it("accepts only version 2 requests without a caller-selected ambiguous-fold policy", () => {
    const previewRequest = {
      contractVersion: FALL_DRAFT_PREVIEW_REQUEST_VERSION,
      ...semantics,
    };
    expect(fallDraftPreviewRequestSchema.parse(previewRequest)).toEqual(previewRequest);
    expect(() => fallDraftPreviewRequestSchema.parse({ ...previewRequest, ambiguousFold: "later" })).toThrow();
    expect(() => fallDraftPreviewRequestSchema.parse({ ...previewRequest, currency: "CAD" })).toThrow();
    expect(() => fallDraftPreviewRequestSchema.parse({ ...previewRequest, regularSessionBillingPolicy: "none" })).toThrow();

    const applyRequest = {
      contractVersion: FALL_DRAFT_APPLY_REQUEST_VERSION,
      ...semantics,
      confirmedPreviewFingerprint: "a".repeat(64),
      reason: "Create the reviewed Fall draft set",
      idempotencyKey: "fixed-fold-policy",
    };
    expect(fallDraftApplyRequestSchema.parse(applyRequest)).toEqual(applyRequest);
    expect(() => fallDraftApplyRequestSchema.parse({ ...applyRequest, ambiguousFold: "earlier" })).toThrow();
    expect(() => fallDraftApplyRequestSchema.parse({ ...applyRequest, currency: "EUR" })).toThrow();
    expect(() => fallDraftApplyRequestSchema.parse({ ...applyRequest, regularSessionBillingPolicy: "none" })).toThrow();
  });

  it("keeps weekly obligations for both weekly and prepaid collection timing", () => {
    expect(fallDraftRegularSessionBillingPolicyForPaymentMode("weekly")).toBe("eligible_bowlers");
    expect(fallDraftRegularSessionBillingPolicyForPaymentMode("upfront")).toBe("eligible_bowlers");
  });
});
