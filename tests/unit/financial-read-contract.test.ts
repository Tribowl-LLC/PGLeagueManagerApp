import { describe, expect, it } from "vitest";
import { resolveInteractiveFinancialRead } from "@/lib/financial-read-contract";
import type { FinancialReadContract } from "@shared/financial-contract";

const contractVersion = "canonical-due-past-due/1";
const resolve = (data: unknown) => resolveInteractiveFinancialRead(data as FinancialReadContract | undefined);

describe("interactive financial read contract", () => {
  it("counts only collectible canonical outstanding rows", () => {
    const result = resolve({
      contractVersion,
      mode: "canonical",
      totals: { collectiblePastDueMinor: 300 },
      rows: [
        { amountMinor: 300, allocatedMinor: 0, outstandingMinor: 300, classification: "past_due", state: "open", reviewRequired: false, incompatibleEvidence: false },
        { amountMinor: 500, allocatedMinor: 0, outstandingMinor: 500, classification: "review_required", state: "open", reviewRequired: true, incompatibleEvidence: false },
        { amountMinor: 700, allocatedMinor: 700, outstandingMinor: 0, classification: "settled", state: "settled", reviewRequired: false, incompatibleEvidence: false },
        { amountMinor: 900, allocatedMinor: 0, outstandingMinor: 900, classification: "voided", state: "voided", reviewRequired: false, incompatibleEvidence: false },
      ],
    });
    expect(result).toMatchObject({ status: "canonical", amountPastDue: 300, remainingBalance: 300 });
  });

  it("uses calculateFinancials-compatible values only for explicit legacy fallback", () => {
    const result = resolve({
      contractVersion,
      mode: "legacy_fallback",
      legacyFallback: { helperVersion: "shared-financial-utils/1", totalPaidMinor: 0, amountPastDueMinor: 1200, totalDueToDateMinor: 3400, fullSeasonAmountMinor: 3400, remainingBalanceMinor: 3400, totalWeeksInSeason: 10 },
      rows: [],
    });
    expect(result).toMatchObject({ status: "legacy_fallback", amountPastDue: 1200, remainingBalance: 3400 });
  });

  it.each([
    undefined,
    { contractVersion, mode: "unavailable" },
    { contractVersion, mode: "incomplete" },
    { contractVersion: "wrong/1", mode: "canonical", totals: { collectiblePastDueMinor: 1 }, rows: [] },
  ])("fails closed for unavailable or incompatible read %#", (data) => {
    expect(resolve(data)).toMatchObject({ status: "unavailable", amountPastDue: 0, remainingBalance: 0 });
  });
});
