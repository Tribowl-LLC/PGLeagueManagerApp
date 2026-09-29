import { describe, expect, it, vi } from "vitest";
import {
  CanonicalCollectionGroupingError,
  deriveCanonicalCollectionPairs,
} from "@shared/canonical-collection-groups";
vi.mock("../../server/db.js", () => ({ db: {} }));
import {
  deriveCurrentFinalPairedOccurrenceIds,
  type CurrentPublishedPairMemberEvidence,
} from "../../server/services/roster-payment-archive-report.js";
import { countCanonicalPaidWeeks } from "@/lib/financial-utils";
import type { CanonicalDuePastDueRowV2 } from "@shared/roster-payment-contract";

let nextObligationId = 1;

function paidWeekRow(overrides: Partial<CanonicalDuePastDueRowV2> = {}): CanonicalDuePastDueRowV2 {
  const id = `week-obligation-${nextObligationId++}`;
  return {
    id,
    organizationId: 1,
    leagueId: 2,
    occurrenceId: `week-${id}`,
    responsibilityId: `responsibility-${id}`,
    teamId: 3,
    component: "full",
    payerBowlerId: 4,
    amountMinor: 2_500,
    currency: "USD",
    dueAt: "2038-02-01T00:00:00.000Z",
    pastDueAt: "2038-02-08T00:00:00.000Z",
    state: "open",
    allocatedMinor: 0,
    grossAllocatedMinor: 0,
    refundedMinor: 0,
    waivedMinor: 0,
    stillOwed: true,
    outstandingMinor: 2_500,
    classification: "future",
    reviewRequired: false,
    ...overrides,
  };
}

function occurrence(index: number, overrides: Partial<Parameters<typeof deriveCanonicalCollectionPairs>[0]["occurrences"][number]> = {}) {
  const date = `2027-0${index + 1}-0${index + 1}`;
  return {
    occurrenceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    localDate: date,
    status: "scheduled" as const,
    lifecycle: "published" as const,
    billingTerm: {
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      obligationPolicy: "eligible_bowlers" as const,
      billingOrdinal: index + 1,
      amountMinor: 500,
      currency: "USD",
    },
    ...overrides,
  };
}

describe("canonical double-pay collection pairing", () => {
  it("pairs sorted triggers with the sorted final tail without changing rows or amounts", () => {
    const rows = Array.from({ length: 7 }, (_, index) => occurrence(index));
    const pairs = deriveCanonicalCollectionPairs({
      doublePayDates: [rows[1].localDate, rows[0].localDate],
      occurrences: rows,
    });
    expect(pairs.map((pair) => [pair.trigger.localDate, pair.paired.localDate])).toEqual([
      ["2027-01-01", "2027-06-06"],
      ["2027-02-02", "2027-07-07"],
    ]);
    expect(pairs[0]?.trigger.amountMinor).toBe(500);
    expect(pairs[0]?.paired.amountMinor).toBe(500);
    expect(new Set(pairs.flatMap((pair) => pair.paired.occurrenceId)).size).toBe(2);
  });

  it("matches the audited 19073-style final-season mapping", () => {
    const dates = [
      "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02",
      "2027-04-12", "2027-04-19", "2027-04-26", "2027-05-03",
    ];
    const rows = dates.map((localDate, index) => occurrence(index, { localDate }));
    const pairs = deriveCanonicalCollectionPairs({
      doublePayDates: ["2026-10-19", "2026-10-12"],
      occurrences: rows,
    });
    expect(pairs.map((pair) => [pair.trigger.localDate, pair.paired.localDate])).toEqual([
      ["2026-10-12", "2027-04-26"],
      ["2026-10-19", "2027-05-03"],
    ]);
  });

  it("retains skips and rejects nonbillable triggers or insufficient tails", () => {
    const skipped = occurrence(1, { status: "cancelled", billingTerm: { id: "10000000-0000-4000-8000-000000000002", obligationPolicy: "none", billingOrdinal: null, amountMinor: 0, currency: "USD" } });
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: [skipped.localDate], occurrences: [skipped, occurrence(0), occurrence(2)] }))
      .toThrowError(CanonicalCollectionGroupingError);
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: ["2027-01-01", "2027-02-02"], occurrences: [occurrence(0), occurrence(1), occurrence(2)] }))
      .toThrow(/not enough final billable/);
  });

  it("rejects duplicate and invalid calendar inputs", () => {
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: ["2027-01-01", "2027-01-01"], occurrences: [] }))
      .toThrow(/unique/);
    expect(() => deriveCanonicalCollectionPairs({ doublePayDates: ["2027-02-30"], occurrences: [] }))
      .toThrow(/invalid double-pay date/);
  });
});

describe("current published final-pair payment evidence", () => {
  const currentRun = { id: "run-current", state: "applied", sourceScheduleRevision: 5, supersededAt: null };
  const member = (role: "trigger" | "paired", overrides: Partial<CurrentPublishedPairMemberEvidence> = {}): CurrentPublishedPairMemberEvidence => ({
    groupId: "group-current",
    groupGenerationRunId: "run-current",
    groupState: "published",
    groupKind: "double_pay",
    groupSourceScheduleRevision: 5,
    groupCurrentRevision: 1,
    groupPublishedAt: "2038-01-01T00:00:00.000Z",
    groupPublishedByUserId: 9,
    groupPublicationCommandId: "command-publish",
    groupRevokedAt: null,
    groupRevokedByUserId: null,
    groupRevocationCommandId: null,
    memberGenerationRunId: "run-current",
    memberActive: true,
    memberRole: role,
    memberOrdinal: role === "trigger" ? 1 : 2,
    memberCurrentRevision: 1,
    occurrenceId: role === "trigger" ? "occ-trigger" : "occ-final",
    memberLocalDate: role === "trigger" ? "2038-01-01" : "2038-04-01",
    memberBillingTermId: role === "trigger" ? "term-trigger" : "term-final",
    memberBillingOrdinal: role === "trigger" ? 1 : 14,
    memberAmountMinor: 3_000,
    memberCurrency: "USD",
    occurrenceGenerationRunId: "run-current",
    occurrenceLifecycle: "published",
    occurrenceStatus: "scheduled",
    occurrenceLocalDate: role === "trigger" ? "2038-01-01" : "2038-04-01",
    termId: role === "trigger" ? "term-trigger" : "term-final",
    termPurpose: "league_weekly_fee",
    termObligationPolicy: "eligible_bowlers",
    termDefaultAmountMinor: 3_000,
    termCurrency: "USD",
    termBillingOrdinal: role === "trigger" ? 1 : 14,
    termState: "published",
    termPublishedAt: "2037-12-01T00:00:00.000Z",
    termPublishedByUserId: 9,
    termPublicationCommandId: "command-term-publish",
    termSupersededAt: null,
    termSupersededByCommandId: null,
    ...overrides,
  });
  const validPair = () => [member("trigger"), member("paired")];

  it("marks only the paired occurrence from a complete current published group", () => {
    expect(deriveCurrentFinalPairedOccurrenceIds(currentRun, validPair())).toEqual(new Set(["occ-final"]));
  });

  it("fails closed for missing or ambiguous current generation evidence", () => {
    expect(deriveCurrentFinalPairedOccurrenceIds(null, validPair())).toEqual(new Set());
    expect(deriveCurrentFinalPairedOccurrenceIds({ ...currentRun, supersededAt: "2038-02-01T00:00:00.000Z" }, validPair())).toEqual(new Set());
    expect(deriveCurrentFinalPairedOccurrenceIds(currentRun, [member("trigger")])).toEqual(new Set());
  });

  it("ignores revoked, stale-generation, and superseded-term memberships", () => {
    const revoked = validPair().map((row) => ({ ...row, groupState: "revoked" }));
    const previousGeneration = validPair().map((row) => ({ ...row, groupGenerationRunId: "run-old" }));
    const supersededTerm = validPair().map((row, index) => index === 1 ? { ...row, termSupersededAt: "2038-02-01T00:00:00.000Z" } : row);

    expect(deriveCurrentFinalPairedOccurrenceIds(currentRun, revoked)).toEqual(new Set());
    expect(deriveCurrentFinalPairedOccurrenceIds(currentRun, previousGeneration)).toEqual(new Set());
    expect(deriveCurrentFinalPairedOccurrenceIds(currentRun, supersededTerm)).toEqual(new Set());
  });
});

describe("canonical paid-week counts", () => {
  it("counts unique self-owned settled occurrences, including the final pair", () => {
    const fifteenOfThirtyTwo = Array.from({ length: 32 }, (_, index) => paidWeekRow({
      occurrenceId: `canonical-week-${index + 1}`,
      state: index < 15 ? "settled" : "open",
      classification: index < 15 ? "settled" : "future",
      allocatedMinor: index < 15 ? 2_500 : 0,
      outstandingMinor: index < 15 ? 0 : 2_500,
      stillOwed: index >= 15,
    }));
    expect(countCanonicalPaidWeeks(fifteenOfThirtyTwo, 4)).toBe(15);

    const allThirtyTwoPaid = fifteenOfThirtyTwo.map((row, index) => ({
      ...row,
      occurrenceId: index === 30 ? "canonical-week-31" : index === 31 ? "canonical-week-32" : `canonical-week-${index + 1}`,
      state: "settled" as const,
      classification: "settled" as const,
      allocatedMinor: 2_500,
      outstandingMinor: 0,
      stillOwed: false,
    }));
    expect(countCanonicalPaidWeeks(allThirtyTwoPaid, 4)).toBe(32);
  });

  it("excludes partial, waived-only, refunded, review-required, voided, and partner rows", () => {
    const paid = paidWeekRow({ occurrenceId: "paid", state: "settled", classification: "settled", allocatedMinor: 2_500, outstandingMinor: 0, stillOwed: false });
    const invalidRows = [
      paidWeekRow({ occurrenceId: "partial", state: "partially_settled", classification: "due", allocatedMinor: 1_000, outstandingMinor: 1_500, stillOwed: true }),
      paidWeekRow({ occurrenceId: "waived-only", state: "settled", classification: "settled", waivedMinor: 2_500, outstandingMinor: 0, stillOwed: false }),
      paidWeekRow({ occurrenceId: "refunded", state: "settled", classification: "settled", grossAllocatedMinor: 2_500, refundedMinor: 2_500, outstandingMinor: 2_500, stillOwed: true }),
      paidWeekRow({ occurrenceId: "review", state: "settled", classification: "review_required", allocatedMinor: 2_500, outstandingMinor: 0, stillOwed: false, reviewRequired: true }),
      paidWeekRow({ occurrenceId: "voided", state: "voided", classification: "voided", allocatedMinor: 2_500, outstandingMinor: 0, stillOwed: false }),
      paidWeekRow({ occurrenceId: "partner", payerBowlerId: 8, state: "settled", classification: "settled", allocatedMinor: 2_500, outstandingMinor: 0, stillOwed: false }),
    ];
    expect(countCanonicalPaidWeeks([paid, ...invalidRows], 4)).toBe(1);
  });

  it("counts a refunded overpayment when canonical effective payment still covers the obligation", () => {
    const refundedOverpayment = paidWeekRow({
      occurrenceId: "refunded-overpayment-still-settled",
      state: "settled",
      classification: "settled",
      grossAllocatedMinor: 3_000,
      allocatedMinor: 2_500,
      refundedMinor: 500,
      outstandingMinor: 0,
      stillOwed: false,
    });

    expect(countCanonicalPaidWeeks([refundedOverpayment], 4)).toBe(1);
  });
});
