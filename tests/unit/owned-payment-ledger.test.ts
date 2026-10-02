import { describe, expect, it } from "vitest";
import { isOccurrenceConfirmedInOwnedLedger, planOwnedFundingFifo, type OwnedConfirmedObligation, type OwnedPaymentFundingLot } from "../../server/services/owned-payment-ledger.js";

function debt(overrides: Partial<OwnedConfirmedObligation> & Pick<OwnedConfirmedObligation, "obligationId" | "dueAt" | "outstandingMinor">): OwnedConfirmedObligation {
  return {
    responsibilityId: `responsibility-${overrides.obligationId}`,
    occurrenceId: `occurrence-${overrides.obligationId}`,
    occurrenceLocalDate: overrides.dueAt.slice(0, 10),
    teamId: 10,
    amountMinor: overrides.outstandingMinor,
    paidMinor: 0,
    waivedMinor: 0,
    payerBowlerId: 5,
    debtorBowlerId: 5,
    targetKind: "bowler_responsibility",
    assignmentId: null,
    reviewRequired: false,
    ...overrides,
  };
}

function lot(overrides: Partial<OwnedPaymentFundingLot> & Pick<OwnedPaymentFundingLot, "fundingId" | "createdAt" | "availableMinor">): OwnedPaymentFundingLot {
  return {
    sourceKind: "generic",
    paymentId: 50,
    bowlerId: 5,
    amountMinor: overrides.availableMinor,
    ...overrides,
  };
}

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

describe("owned payment account FIFO planning", () => {
  it("combines generic and rotating sources oldest-first and stops at a held debt", () => {
    const plan = planOwnedFundingFifo(5, [
      debt({ obligationId: "oldest", dueAt: "2026-09-01T00:00:00Z", outstandingMinor: 700 }),
      debt({ obligationId: "held", dueAt: "2026-09-08T00:00:00Z", outstandingMinor: 200, reviewRequired: true }),
      debt({ obligationId: "later", dueAt: "2026-09-15T00:00:00Z", outstandingMinor: 100 }),
    ], [
      lot({ fundingId: "generic-early", createdAt: "2026-08-20T00:00:00Z", availableMinor: 400 }),
      lot({ fundingId: "rotating-next", sourceKind: "rotating", createdAt: "2026-08-21T00:00:00Z", availableMinor: 350 }),
      lot({ fundingId: "generic-late", createdAt: "2026-08-22T00:00:00Z", availableMinor: 500 }),
    ]);

    expect(plan.map((row) => [row.obligation.obligationId, row.lot.fundingId, row.amountMinor])).toEqual([
      ["oldest", "generic-early", 400],
      ["oldest", "rotating-next", 300],
    ]);
  });

  it("reapplies a released source amount to the reduced oldest confirmed debt", () => {
    const plan = planOwnedFundingFifo(5, [
      debt({ obligationId: "corrected-week", dueAt: "2026-09-01T00:00:00Z", amountMinor: 900, outstandingMinor: 200 }),
    ], [lot({ fundingId: "released-receipt", createdAt: "2026-09-02T00:00:00Z", amountMinor: 900, availableMinor: 900 })]);

    expect(plan).toEqual([expect.objectContaining({
      obligation: expect.objectContaining({ obligationId: "corrected-week" }),
      lot: expect.objectContaining({ fundingId: "released-receipt" }),
      amountMinor: 200,
    })]);
  });
});
