import { describe, expect, it } from "vitest";
import type { CanonicalDuePastDueRowV2 } from "@shared/roster-payment-contract";
import { deriveBowlerFinancials } from "@/lib/financial-utils";

const AS_OF = "2038-01-25 00:00:00+00";
let nextId = 1;

function row(overrides: Partial<CanonicalDuePastDueRowV2> = {}): CanonicalDuePastDueRowV2 {
  const id = `obligation-${nextId++}`;
  return {
    id,
    organizationId: 1,
    leagueId: 2,
    occurrenceId: `occurrence-${id}`,
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

describe("deriveBowlerFinancials", () => {
  it("excludes voided history, counts split components once, and uses dueAt against asOf", () => {
    const activeRows = [
      row({ occurrenceId: "week-1", component: "lineage", amountMinor: 1_500, outstandingMinor: 1_500, dueAt: "2038-01-24T00:00:00.000Z", pastDueAt: AS_OF, classification: "due" }),
      row({ occurrenceId: "week-1", component: "prize", amountMinor: 1_000, outstandingMinor: 1_000, dueAt: "2038-01-24T00:00:00.000Z", pastDueAt: AS_OF, classification: "due" }),
      ...Array.from({ length: 29 }, (_, index) => {
        const week = index + 2;
        const isSettledFuture = week === 2;
        const dueAt = new Date(Date.UTC(2038, 1, 1 + (week - 2) * 7)).toISOString();
        const pastDueAt = new Date(Date.parse(dueAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
        return row({
          occurrenceId: `week-${week}`,
          dueAt,
          pastDueAt,
          classification: isSettledFuture ? "settled" : "future",
          state: isSettledFuture ? "settled" : "open",
          outstandingMinor: isSettledFuture ? 0 : 2_500,
          stillOwed: !isSettledFuture,
          allocatedMinor: isSettledFuture ? 2_500 : 0,
        });
      }),
    ];
    const voidedHistory = Array.from({ length: 90 }, (_, index) => row({
      occurrenceId: `replaced-week-${index + 1}`,
      amountMinor: 2_500,
      state: "voided",
      classification: index === 1 ? "review_required" : "voided",
      reviewRequired: index === 1,
      allocatedMinor: index === 0 ? 2_500 : 0,
      outstandingMinor: 0,
      stillOwed: false,
    }));

    const result = deriveBowlerFinancials([...activeRows, ...voidedHistory], AS_OF, 2_500);

    expect(result).toMatchObject({
      weeksDue: 1,
      totalSeasonDues: 2_500,
      totalWeeksInSeason: 30,
      fullSeasonAmount: 75_000,
      amountPastDue: 2_500,
      totalPaidAmount: 5_000,
    });
  });

  it("applies waivers to charges while excluding review evidence from collectible balance", () => {
    const result = deriveBowlerFinancials([
      row({ occurrenceId: "waived-week", amountMinor: 3_000, waivedMinor: 500, dueAt: "2038-01-24T00:00:00.000Z", classification: "due", outstandingMinor: 2_500 }),
      row({ occurrenceId: "review-week", amountMinor: 4_000, waivedMinor: 1_000, dueAt: "2038-01-24T00:00:00.000Z", classification: "review_required", reviewRequired: true, outstandingMinor: 3_000 }),
      row({ occurrenceId: "future-week", amountMinor: 2_500 }),
    ], AS_OF, 0);

    expect(result).toMatchObject({
      weeksDue: 2,
      totalSeasonDues: 5_500,
      totalWeeksInSeason: 3,
      fullSeasonAmount: 8_000,
      remainingBalance: 5_000,
      waivedAmount: 1_500,
      reviewRequired: true,
      reviewCategory: "evidence",
    });
  });
});
