import type { RefundPaymentDisposition } from "@shared/schema";

export type RefundAllocationAdjustmentAmount = {
  amountMinor: number;
  disposition: RefundPaymentDisposition;
};

export type CanonicalObligationBalance = {
  grossAllocatedMinor: number;
  refundedMinor: number;
  effectiveAllocatedMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
  stillOwed: boolean;
};

/**
 * Refunds retain the original tender/allocation rows. This is the one shared
 * balance rule for all read, FIFO, standing, and provider-finalization paths:
 * refunded tender is removed from effective payment, while only an explicit
 * waive disposition offsets the obligation without changing its immutable
 * amount. A still-owed marker remains relevant until the complete obligation
 * balance is collected.
 */
export function canonicalObligationBalance(input: {
  amountMinor: number;
  state: "open" | "partially_settled" | "settled" | "voided";
  grossAllocatedMinor: number;
  adjustments: RefundAllocationAdjustmentAmount[];
}): CanonicalObligationBalance {
  const refundedMinor = input.adjustments.reduce((sum, adjustment) => sum + adjustment.amountMinor, 0);
  const waivedMinor = input.adjustments
    .filter((adjustment) => adjustment.disposition === "waived")
    .reduce((sum, adjustment) => sum + adjustment.amountMinor, 0);
  const effectiveAllocatedMinor = Math.max(0, input.grossAllocatedMinor - refundedMinor);
  const outstandingMinor = input.state === "voided"
    ? 0
    : Math.max(0, input.amountMinor - effectiveAllocatedMinor - waivedMinor);
  return {
    grossAllocatedMinor: input.grossAllocatedMinor,
    refundedMinor,
    effectiveAllocatedMinor,
    waivedMinor,
    outstandingMinor,
    stillOwed: input.state !== "voided"
      && outstandingMinor > 0
      && input.adjustments.some((adjustment) => adjustment.disposition === "still_owed"),
  };
}
