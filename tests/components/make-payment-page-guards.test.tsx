import { describe, expect, it } from "vitest";
import {
  clampPaymentWeekCount,
  clearWalletRequestKeyForTerminalStatus,
  hasPositivePaymentEvidence,
} from "@/pages/make-payment-page";

describe("dedicated make-payment guards", () => {
  it.each(["failed_terminal", "canceled", "action_required"])("clears the in-memory wallet key for terminal HTTP-202 status %s", (status) => {
    const requestKeyRef = { current: "wallet-request-key" };
    clearWalletRequestKeyForTerminalStatus(status, requestKeyRef);
    expect(requestKeyRef.current).toBeNull();
  });

  it("keeps the wallet key while the provider outcome is unresolved", () => {
    const requestKeyRef = { current: "wallet-request-key" };
    clearWalletRequestKeyForTerminalStatus("provider_unknown", requestKeyRef);
    expect(requestKeyRef.current).toBe("wallet-request-key");
  });

  it.each([
    [4, 2, 2],
    [0, 2, 1],
    [2, 4, 2],
    [3, 0, 1],
  ])("clamps selected weeks after options shrink (%s, max %s)", (selected, maximum, expected) => {
    expect(clampPaymentWeekCount(selected, maximum)).toBe(expected);
  });

  it("requires positive allocation evidence before showing paid in full", () => {
    expect(hasPositivePaymentEvidence([])).toBe(false);
    expect(hasPositivePaymentEvidence([{ allocatedMinor: 0, outstandingMinor: 0, state: "settled", reviewRequired: false }])).toBe(false);
    expect(hasPositivePaymentEvidence([{ allocatedMinor: 1, outstandingMinor: 0, state: "settled", reviewRequired: false }])).toBe(true);
  });

  it("fails closed when review-required outstanding evidence accompanies a positive allocation", () => {
    expect(hasPositivePaymentEvidence([
      { allocatedMinor: 100, outstandingMinor: 0, state: "settled", reviewRequired: false },
      { allocatedMinor: 100, outstandingMinor: 50, state: "open", reviewRequired: true },
    ])).toBe(false);
  });
});
