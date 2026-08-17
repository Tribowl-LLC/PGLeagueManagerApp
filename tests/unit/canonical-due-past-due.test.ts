import { describe, expect, it, vi } from "vitest";
vi.mock("../../server/db.js", () => ({ db: {} }));
import { calculateCanonicalTiming, canonicalReadFingerprint, classifyCanonicalTiming, validateResponsibilityMatrix } from "../../server/services/canonical-due-past-due";
import { calculateBowlerLegacySummary } from "@shared/financial-utils";

const expected = [{ occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 7, billingTermId: "00000000-0000-0000-0000-000000000002", billingTermVersion: 1, billingTermRevision: 1, occurrenceRevision: 2, amountMinor: 3000, currency: "USD", paymentMode: "weekly" as const, occurrenceStartAt: "2026-08-17T01:00:00.000Z" }];

function row(slotIndex: number, bowlerId: number) {
  return { occurrenceId: expected[0].occurrenceId, teamId: 7, slotIndex, bowlerId, role: "regular" as const, provenance: "explicit_admin_selection" };
}

describe("canonical due/past-due contract", () => {
  it("uses occurrence start and exactly three hours of weekly grace", () => {
    const timing = calculateCanonicalTiming(expected[0]);
    expect(timing).toEqual({ dueAt: "2026-08-17T01:00:00.000Z", pastDueAt: "2026-08-17T04:00:00.000Z" });
    expect(classifyCanonicalTiming(timing, new Date("2026-08-17T03:59:59.999Z"))).toBe("due");
    expect(classifyCanonicalTiming(timing, new Date("2026-08-17T04:00:00.000Z"))).toBe("past_due");
  });

  it("uses one stable activation instant for upfront timing", () => {
    const timing = calculateCanonicalTiming({ ...expected[0], paymentMode: "upfront", activationDueAt: "2026-08-01T12:00:00.000Z" });
    expect(timing).toEqual({ dueAt: "2026-08-01T12:00:00.000Z", pastDueAt: "2026-08-01T12:00:00.000Z" });
  });

  it("requires three or four contiguous unique explicit slots", () => {
    expect(validateResponsibilityMatrix(expected, [row(0, 1), row(1, 2), row(2, 3)], 3)).toEqual([]);
    expect(validateResponsibilityMatrix(expected, [row(0, 1), row(2, 2), row(3, 3)], 3)).toContain("slots:00000000-0000-0000-0000-000000000001:7");
    expect(validateResponsibilityMatrix(expected, [row(0, 1), row(1, 1), row(2, 3)], 3)).toContain("duplicate_bowler:00000000-0000-0000-0000-000000000001:7");
  });

  it("fingerprints object key order canonically", () => {
    expect(canonicalReadFingerprint([{ b: 2, a: 1 }])).toBe(canonicalReadFingerprint([{ a: 1, b: 2 }]));
  });

  it("keeps legacy payment history separate from allocation and preserves effective schedule totals", () => {
    const league = { seasonStart: "2026-01-01", seasonEnd: "2026-03-31", weekDay: "Sunday", weeklyFee: 3000, paymentMode: "weekly", totalBowlingWeeks: 12, cancelledDates: ["2026-01-25"], doublePayDates: ["2026-01-18"], competitionStartTime: "19:00", timezone: "UTC" };
    const summary = calculateBowlerLegacySummary(league, 12000, new Date("2026-02-01T00:00:00.000Z"));
    expect(summary.fullSeasonAmount).toBe(33000);
    expect(summary.remainingBalance).toBe(21000);
    expect(summary.amountPastDue).toBeGreaterThanOrEqual(0);
    expect(summary.totalDueToDate).toBeGreaterThanOrEqual(summary.amountPastDue);
    const overpaid = calculateBowlerLegacySummary(league, 999999, new Date("2026-02-01T00:00:00.000Z"));
    expect(overpaid.remainingBalance).toBe(0);
    expect(overpaid.amountPastDue).toBe(0);
  });
});
