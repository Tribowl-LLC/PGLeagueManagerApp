import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCanonicalOccurrenceOperatorArguments,
  runCanonicalOccurrenceOperator,
} from "../../scripts/generate-canonical-occurrences";

describe("A2 canonical occurrence read-only operator arguments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults ambiguous folds to reject and requires explicit billing semantics", () => {
    const parsed = parseCanonicalOccurrenceOperatorArguments([
      "--organizationId=1",
      "--leagueId=2",
      "--sourceScheduleRevision=3",
      "--currency=USD",
      "--regularSessionBillingPolicy=eligible_bowlers",
      "--billingOrdinalPolicy=planned_slot",
    ]);
    expect(parsed).toMatchObject({
      organizationId: 1,
      leagueId: 2,
      sourceScheduleRevision: 3,
      ambiguousFold: "reject",
      currency: "USD",
    });
  });

  it("propagates an explicit fold policy and refuses unknown flags", () => {
    expect(parseCanonicalOccurrenceOperatorArguments([
      "--organizationId=1",
      "--leagueId=2",
      "--sourceScheduleRevision=3",
      "--ambiguousFold=later",
    ]).ambiguousFold).toBe("later");
    expect(() => parseCanonicalOccurrenceOperatorArguments([
      "--organizationId=1",
      "--leagueId=2",
      "--sourceScheduleRevision=3",
      "--apply",
    ])).toThrow(/unknown argument/);
  });

  it("fails before connecting when DATABASE_URL is absent", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitCode = await runCanonicalOccurrenceOperator([
      "--organizationId=1",
      "--leagueId=2",
      "--sourceScheduleRevision=3",
    ], {});
    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL is required"));
  });
});
