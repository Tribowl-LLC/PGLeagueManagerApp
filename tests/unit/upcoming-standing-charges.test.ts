import { describe, expect, it } from "vitest";
import { projectUpcomingStandingCharges, type UpcomingStandingCutoff } from "../../server/services/account-payment-funding-targets";
import type { FifoPaymentCandidate } from "../../server/services/automatic-fifo-allocation";

const fee = 2500;
const week = (ordinal: number) => new Date(Date.UTC(2030, 0, 1 + (ordinal - 1) * 7, 23, 30)).toISOString();

function candidate(ordinal: number, outstandingMinor = fee, collectAtOrdinal = ordinal): FifoPaymentCandidate {
  return {
    id: `obligation-${ordinal}`,
    outstandingMinor,
    dueAt: week(ordinal),
    memberOrdinal: 0,
    billingOrdinal: ordinal,
    occurrenceId: `occurrence-${ordinal}`,
    effectiveCollectionAt: week(collectAtOrdinal),
    reservedMinor: 0,
    reviewRequired: false,
    pairedCollectionReady: collectAtOrdinal !== ordinal,
  };
}

function weekly(ordinal: number): UpcomingStandingCutoff {
  return { cutoffAt: week(ordinal), collectionMode: "weekly", requirementOccurrenceIds: [`occurrence-${ordinal}`], billingOrdinals: [ordinal] };
}

function doublePay(trigger: number, paired: number): UpcomingStandingCutoff {
  return { cutoffAt: week(trigger), collectionMode: "double_pay", requirementOccurrenceIds: [`occurrence-${trigger}`, `occurrence-${paired}`], billingOrdinals: [trigger, paired] };
}

describe("projectUpcomingStandingCharges", () => {
  it("lists the next three charges and folds a paired final into its trigger week", () => {
    const projection = projectUpcomingStandingCharges({
      recipients: [{ candidates: [candidate(4), candidate(5), candidate(31, fee, 5), candidate(6), candidate(32, fee, 6), candidate(7)], confirmedDebts: [], availableCreditMinor: 0 }],
      cutoffs: [weekly(4), doublePay(5, 31), doublePay(6, 32), weekly(7)],
      limit: 3,
    });
    expect(projection).toEqual({
      charges: [
        { cutoffAt: week(4), collectionMode: "weekly", amountMinor: fee, billingOrdinals: [4] },
        { cutoffAt: week(5), collectionMode: "double_pay", amountMinor: fee * 2, billingOrdinals: [5, 31] },
        { cutoffAt: week(6), collectionMode: "double_pay", amountMinor: fee * 2, billingOrdinals: [6, 32] },
      ],
      paidAheadThroughOrdinal: null,
      overdueMinor: 0,
      reviewRequired: false,
    });
  });

  it("skips prepaid weeks and reports how far the bowler paid ahead", () => {
    const projection = projectUpcomingStandingCharges({
      recipients: [{ candidates: [candidate(12, 0), candidate(13, 0), candidate(14), candidate(15), candidate(16)], confirmedDebts: [], availableCreditMinor: 0 }],
      cutoffs: [weekly(12), weekly(13), weekly(14), weekly(15), weekly(16)],
      limit: 3,
    });
    expect(projection.paidAheadThroughOrdinal).toBe(13);
    expect(projection.charges.map((charge) => charge.billingOrdinals)).toEqual([[14], [15], [16]]);
  });

  it("carries account credit forward across cutoffs", () => {
    const projection = projectUpcomingStandingCharges({
      recipients: [{ candidates: [candidate(4), candidate(5), candidate(6)], confirmedDebts: [], availableCreditMinor: fee + 1000 }],
      cutoffs: [weekly(4), weekly(5), weekly(6)],
      limit: 3,
    });
    expect(projection.paidAheadThroughOrdinal).toBe(4);
    expect(projection.charges.map((charge) => charge.amountMinor)).toEqual([fee - 1000, fee]);
  });

  it("reports older debt as overdue and still shows the charges that resume after it is paid", () => {
    const projection = projectUpcomingStandingCharges({
      recipients: [{
        candidates: [candidate(3), candidate(4), candidate(5)],
        confirmedDebts: [{ obligationId: "obligation-3", occurrenceId: "occurrence-3", outstandingMinor: fee, reviewRequired: false }],
        availableCreditMinor: 0,
      }],
      cutoffs: [weekly(4), weekly(5)],
      limit: 3,
    });
    expect(projection.overdueMinor).toBe(fee);
    expect(projection.charges.map((charge) => charge.amountMinor)).toEqual([fee, fee]);
  });

  it("sums the payer and partner at each cutoff", () => {
    const recipient = { candidates: [candidate(4), candidate(5)], confirmedDebts: [], availableCreditMinor: 0 };
    const projection = projectUpcomingStandingCharges({ recipients: [recipient, recipient], cutoffs: [weekly(4), weekly(5)], limit: 3 });
    expect(projection.charges.map((charge) => charge.amountMinor)).toEqual([fee * 2, fee * 2]);
  });

  it("stops forecasting when evidence requires staff review", () => {
    const projection = projectUpcomingStandingCharges({
      recipients: [{ candidates: [candidate(4), { ...candidate(5), reviewRequired: true }], confirmedDebts: [], availableCreditMinor: 0 }],
      cutoffs: [weekly(4), weekly(5)],
      limit: 3,
    });
    expect(projection.reviewRequired).toBe(true);
    expect(projection.charges).toHaveLength(1);
  });
});
