export type FifoPaymentCandidate = {
  id: string;
  outstandingMinor: number;
  dueAt: string;
  memberOrdinal: number;
  billingOrdinal: number;
  occurrenceId: string;
  reservedMinor: number;
  reviewRequired: boolean;
  pairedCollectionReady: boolean;
};

export class AutomaticFifoAllocationError extends Error {
  constructor(public readonly code: "INVALID_AMOUNT" | "OBLIGATION_RESERVED" | "FINANCIAL_EVIDENCE_INVALID" | "EXCESS_PAYMENT", message: string, public readonly status: number) {
    super(message);
    this.name = "AutomaticFifoAllocationError";
  }
}

export function allocateAutomaticFifoPayment(
  amountMinor: number,
  candidates: FifoPaymentCandidate[],
  paymentMode: "weekly" | "upfront",
  nowIso = new Date().toISOString(),
): Array<{ obligationId: string; amountMinor: number }> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new AutomaticFifoAllocationError("INVALID_AMOUNT", "Payment amount must be a positive whole number of cents", 422);
  const now = new Date(nowIso).getTime();
  const eligible = candidates.filter((row) => row.outstandingMinor > 0).sort((a, b) => {
    const rank = (row: FifoPaymentCandidate): number => {
      if (paymentMode === "upfront") return 0;
      if (new Date(row.dueAt).getTime() <= now) return 0;
      return row.pairedCollectionReady ? 1 : 2;
    };
    return rank(a) - rank(b) || a.dueAt.localeCompare(b.dueAt) || a.memberOrdinal - b.memberOrdinal || a.billingOrdinal - b.billingOrdinal || a.occurrenceId.localeCompare(b.occurrenceId) || a.id.localeCompare(b.id);
  });
  let remaining = amountMinor;
  const allocations: Array<{ obligationId: string; amountMinor: number }> = [];
  for (const candidate of eligible) {
    if (candidate.reviewRequired) throw new AutomaticFifoAllocationError("FINANCIAL_EVIDENCE_INVALID", "An existing payment allocation requires review before collection can continue", 409);
    if (candidate.reservedMinor > 0) throw new AutomaticFifoAllocationError("OBLIGATION_RESERVED", "The oldest eligible payment obligation is reserved by an automatic payment", 409);
    const take = Math.min(remaining, candidate.outstandingMinor);
    if (take > 0) allocations.push({ obligationId: candidate.id, amountMinor: take });
    remaining -= take;
    if (remaining === 0) break;
  }
  if (remaining > 0) throw new AutomaticFifoAllocationError("EXCESS_PAYMENT", "The payment amount exceeds the remaining eligible balance", 422);
  return allocations;
}
