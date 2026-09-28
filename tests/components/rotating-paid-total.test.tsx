import { describe, expect, it } from "vitest";
import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";
import { rotatingPaidTotalMinor } from "@/lib/rotating-paid-total";

function report(gross: number, refunded: number): CanonicalPaymentReport {
  return {
    contractVersion: "canonical-payment-report/2",
    orderVersion: "league,business-date,bowler,occurrence,allocation,payment/2",
    organizationId: 1,
    authoritativeSource: "canonical",
    leagueId: 17,
    mode: "canonical",
    asOf: "2030-01-01T00:00:00.000Z",
    fingerprint: "test-fingerprint",
    page: 1,
    limit: 20,
    totalRows: 0,
    totalTransactions: 0,
    totals: {
      grossConfirmedPaidMinor: gross,
      activeAllocatedMinor: 0,
      refundedMinor: refunded,
      disputedReviewRequiredMinor: 0,
      reviewRequiredMinor: 0,
      unresolvedOperationMinor: 0,
    },
    rows: [],
    transactions: [],
    paymentTiming: { paymentMode: "weekly", upfrontDueAt: null, source: "canonical" },
  };
}

describe("rotating paid total", () => {
  it("counts a confirmed prepayment before any weekly share is allocated, then subtracts completed refunds", () => {
    expect(rotatingPaidTotalMinor(report(10_000, 0), 17)).toBe(10_000);
    expect(rotatingPaidTotalMinor(report(10_000, 2_500), 17)).toBe(7_500);
    expect(rotatingPaidTotalMinor(report(10_000, 10_000), 17)).toBe(0);
  });

  it("fails closed on a different league or inconsistent canonical totals", () => {
    expect(rotatingPaidTotalMinor(report(10_000, 0), 18)).toBeNull();
    expect(rotatingPaidTotalMinor(report(10_000, 10_001), 17)).toBeNull();
    expect(rotatingPaidTotalMinor(report(Number.NaN, 0), 17)).toBeNull();
    const disputed = report(10_000, 0);
    disputed.totals.disputedReviewRequiredMinor = 2_500;
    expect(rotatingPaidTotalMinor(disputed, 17)).toBeNull();
  });
});
