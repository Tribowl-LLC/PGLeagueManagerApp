/** Presentation-only shape retained for the payment-history display. Amounts
 * and due status come from the canonical financial API, not this module. */
export interface DoublePayStatus {
  dates: string[];
  perWeekExtra: number;
  totalExtra: number;
  pastExtra: number;
  isPaid: boolean;
}

export interface BowlerViewFinancials {
  weeksDue: number;
  totalSeasonDues: number;
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  amountPastDue: number;
  remainingBalance: number;
  totalPaidAmount: number;
  totalUnpaidAmount: number;
  reviewRequired: boolean;
  reviewCategory: "refund" | "dispute" | "evidence" | null;
}
