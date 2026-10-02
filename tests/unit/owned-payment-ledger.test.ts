import { describe, expect, it } from "vitest";
import { isOccurrenceConfirmedInOwnedLedger } from "../../server/services/owned-payment-ledger.js";

describe("owned payment ledger confirmation eligibility", () => {
  it("uses an explicit saved confirmation regardless of the adoption cutoff", () => {
    expect(isOccurrenceConfirmedInOwnedLedger(null, "2026-10-02", true)).toBe(true);
    expect(isOccurrenceConfirmedInOwnedLedger({ adoptedThroughLocalDate: "2026-09-01" }, "2026-10-02", true)).toBe(true);
  });

  it("treats only canonical periods through the adopted cutoff as confirmed", () => {
    const adoption = { adoptedThroughLocalDate: "2026-09-28" };
    expect(isOccurrenceConfirmedInOwnedLedger(adoption, "2026-09-14", false)).toBe(true);
    expect(isOccurrenceConfirmedInOwnedLedger(adoption, "2026-09-28", false)).toBe(true);
    expect(isOccurrenceConfirmedInOwnedLedger(adoption, "2026-10-05", false)).toBe(false);
  });

  it("does not infer confirmation from a current calendar date or malformed local date", () => {
    expect(isOccurrenceConfirmedInOwnedLedger(null, "2026-10-02", false)).toBe(false);
    expect(isOccurrenceConfirmedInOwnedLedger({ adoptedThroughLocalDate: "2026-10-30" }, "not-a-date", false)).toBe(false);
  });
});
