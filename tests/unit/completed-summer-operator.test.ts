import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCompletedSummerComparatorArguments,
  runCompletedSummerComparator,
} from "../../scripts/compare-completed-summer-occurrences";

const required = [
  "--organizationId=1",
  "--seasonYear=2025",
  "--asOfDate=2026-01-01",
  "--sourceScheduleRevision=2",
  "--currency=USD",
  "--regularSessionBillingPolicy=eligible_bowlers",
  "--billingOrdinalPolicy=planned_slot",
];

describe("B1 Completed-Summer operator arguments", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires explicit selection and billing inputs while defaulting the fold policy safely", () => {
    expect(parseCompletedSummerComparatorArguments(required)).toEqual({
      organizationId: 1,
      seasonYear: 2025,
      asOfDate: "2026-01-01",
      leagueId: null,
      sourceScheduleRevision: 2,
      ambiguousFold: "reject",
      currency: "USD",
      regularSessionBillingPolicy: "eligible_bowlers",
      billingOrdinalPolicy: "planned_slot",
    });
    expect(parseCompletedSummerComparatorArguments([...required, "--leagueId=9", "--ambiguousFold=later"])).toMatchObject({ leagueId: 9, ambiguousFold: "later" });
  });

  it("rejects implicit current dates, invalid dates, missing semantics, duplicate and apply flags", () => {
    expect(() => parseCompletedSummerComparatorArguments(required.filter((flag) => !flag.startsWith("--asOfDate")))).toThrow(/asOfDate/);
    expect(() => parseCompletedSummerComparatorArguments(required.map((flag) => flag.startsWith("--asOfDate") ? "--asOfDate=2025-02-29" : flag))).toThrow(/valid YYYY-MM-DD/);
    expect(() => parseCompletedSummerComparatorArguments(required.filter((flag) => !flag.startsWith("--currency")))).toThrow(/currency/);
    expect(() => parseCompletedSummerComparatorArguments([...required, "--organizationId=2"])).toThrow(/only once/);
    expect(() => parseCompletedSummerComparatorArguments([...required, "--apply"])).toThrow(/unknown argument/);
  });

  it("fails before connecting when DATABASE_URL is absent", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runCompletedSummerComparator(required, {})).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL is required"));
  });
});
