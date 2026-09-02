import { describe, expect, it } from "vitest";
import { parseOneTimePaymentAmount } from "@/pages/payment-history-page/one-time-payment-amount";

describe("one-time payment amount", () => {
  it("accepts any positive cent amount up to the open balance", () => {
    expect(parseOneTimePaymentAmount("30", 9_000)).toBe(3_000);
    expect(parseOneTimePaymentAmount("100.25", 10_025)).toBe(10_025);
  });

  it("rejects blank, malformed, zero, and excess amounts", () => {
    expect(parseOneTimePaymentAmount("", 9_000)).toBeNull();
    expect(parseOneTimePaymentAmount("0", 9_000)).toBeNull();
    expect(parseOneTimePaymentAmount("1.001", 9_000)).toBeNull();
    expect(parseOneTimePaymentAmount("90.01", 9_000)).toBeNull();
  });
});
