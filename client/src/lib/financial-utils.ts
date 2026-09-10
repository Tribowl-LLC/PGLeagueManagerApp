import { getApiErrorCode, getApiErrorStatus, isSessionExpiredError } from "@/lib/api-error";

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
  /** Explicitly waived refund effects are not counted as payments. */
  waivedAmount?: number;
  totalUnpaidAmount: number;
  reviewRequired: boolean;
  reviewCategory: "refund" | "dispute" | "evidence" | null;
}

/** Keep read failures distinct from the one known financial evidence conflict. */
export function financialReadErrorMessage(error: unknown): string {
  if (isSessionExpiredError(error)) return "Your session expired. Please sign in again.";
  const status = getApiErrorStatus(error);
  if (status === 409 || getApiErrorCode(error) === "FINANCIAL_EVIDENCE_INCOMPATIBLE") {
    return "Financial evidence requires review; no balance is shown.";
  }
  if (status === 403) return "You do not have permission to view financial evidence.";
  if (typeof status === "number" && status >= 500) {
    return "Financial data is temporarily unavailable; no balance is shown.";
  }
  return "Financial data could not be loaded; no balance is shown.";
}
