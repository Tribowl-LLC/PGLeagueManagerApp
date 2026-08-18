import { describe, expect, it } from "vitest";
import {
  InteractiveOccurrenceAllocationError,
  validateInteractiveOccurrenceBaseAllocations,
  validateInteractiveOccurrenceSelections,
} from "../../server/services/interactive-occurrence-allocation";

describe("F2 interactive occurrence preparation invariants", () => {
  const expectCode = (run: () => void, code: string) => {
    try {
      run();
      throw new Error("expected an allocation error");
    } catch (error) {
      expect(error).toBeInstanceOf(InteractiveOccurrenceAllocationError);
      expect((error as InteractiveOccurrenceAllocationError).code).toBe(code);
    }
  };
  it("accepts one bowler and aggregates multiple obligations for that bowler", () => {
    expect(() => validateInteractiveOccurrenceBaseAllocations(
      [{ bowlerId: 7, amountMinor: 500 }, { bowlerId: 7, amountMinor: 250 }],
      [{ bowlerId: 7, amountMinor: 750 }],
    )).not.toThrow();
  });

  it("rejects a single-charge obligation owned by another bowler before dispatch", () => {
    expectCode(() => validateInteractiveOccurrenceBaseAllocations(
      [{ bowlerId: 8, amountMinor: 750 }],
      [{ bowlerId: 7, amountMinor: 750 }],
    ), "BASE_ALLOCATION_MISMATCH");
  });

  it("rejects combined bowler-set and per-bowler total drift", () => {
    expectCode(() => validateInteractiveOccurrenceBaseAllocations(
      [{ bowlerId: 7, amountMinor: 500 }, { bowlerId: 8, amountMinor: 250 }],
      [{ bowlerId: 7, amountMinor: 600 }, { bowlerId: 9, amountMinor: 150 }],
    ), "BASE_ALLOCATION_MISMATCH");
  });

  it("allows deliberate partial allocation and rejects duplicate, over-outstanding, and stale totals", () => {
    const rows = [{ obligationId: "a", outstandingMinor: 1_000 }, { obligationId: "b", outstandingMinor: 2_000 }];
    expect(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: "a", amountMinor: 400 }], 400)).not.toThrow();
    expectCode(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: "a", amountMinor: 400 }, { obligationId: "a", amountMinor: 100 }], 500), "INVALID_SELECTION");
    expectCode(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: "a", amountMinor: 1_001 }], 1_001), "INVALID_SELECTION");
    expectCode(() => validateInteractiveOccurrenceSelections(rows, [{ obligationId: "a", amountMinor: 400 }], 500), "AMOUNT_MISMATCH");
  });
});
