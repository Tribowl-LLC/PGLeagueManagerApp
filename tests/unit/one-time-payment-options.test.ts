import { describe, expect, it } from "vitest";
import { buildOneTimePaymentOptions } from "@/pages/payment-history-page/one-time-payment-options";

const row = (occurrenceId: string, amountMinor: number, outstandingMinor = amountMinor) => ({
  occurrenceId,
  amountMinor,
  outstandingMinor,
  state: "open" as const,
});

describe("one-time payment week options", () => {
  it("calculates fixed weekly increments from canonical obligations", () => {
    expect(buildOneTimePaymentOptions([
      row("week-1", 3_000),
      row("week-2", 3_000),
      row("week-3", 3_000),
    ], 9_000)).toEqual([
      { weekCount: 1, amountMinor: 3_000 },
      { weekCount: 2, amountMinor: 6_000 },
      { weekCount: 3, amountMinor: 9_000 },
    ]);
  });

  it("uses actual split components and caps the final choice after partial credit", () => {
    expect(buildOneTimePaymentOptions([
      row("week-1", 1_000, 500),
      row("week-1", 2_000),
      row("week-2", 3_000),
    ], 5_500)).toEqual([
      { weekCount: 1, amountMinor: 3_000 },
      { weekCount: 2, amountMinor: 5_500 },
    ]);
  });

  it("omits settled, voided, and missing-identity evidence", () => {
    expect(buildOneTimePaymentOptions([
      { ...row("settled", 3_000, 0), state: "settled" as const },
      { ...row("voided", 3_000, 0), state: "voided" as const },
      row("", 3_000),
    ], 3_000)).toEqual([]);
  });
});
