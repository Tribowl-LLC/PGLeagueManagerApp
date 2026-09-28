import { describe, expect, it } from "vitest";
import { resolveRotatingCreditDisplayState } from "@/components/payment-status-section";

const balance = (eligibleForCredit: boolean) => ({
  success: true as const,
  data: {
    contractVersion: "rotating-credit-balance/1" as const,
    organizationId: 1,
    leagueId: 17,
    bowlerId: 42,
    eligibleForCredit,
    shareAmountMinor: eligibleForCredit ? 2_500 : null,
    currency: "USD" as const,
    fundedMinor: 0,
    availableMinor: 0,
    appliedMinor: 0,
    refundedMinor: 0,
    refundHeldMinor: 0,
    reviewHeldMinor: 0,
    lots: [],
    applications: [],
  },
});

describe("rotating credit display authority", () => {
  it("fails closed while the league-scoped eligibility read is pending or unavailable", () => {
    expect(resolveRotatingCreditDisplayState(undefined, true, null)).toBe("loading");
    expect(resolveRotatingCreditDisplayState(undefined, false, new Error("unavailable"))).toBe("error");
    expect(resolveRotatingCreditDisplayState({ success: false, data: undefined as never }, false, null)).toBe("error");
  });

  it("uses eligibleForCredit as the only rotating-mode switch", () => {
    expect(resolveRotatingCreditDisplayState(balance(true), false, null)).toBe("rotating");
    expect(resolveRotatingCreditDisplayState(balance(false), false, null)).toBe("standard");
  });
});
