import { getApiErrorCode, getApiErrorStatus, isSessionExpiredError } from "@/lib/api-error";
import type { CanonicalDuePastDueRowV2 } from "@shared/roster-payment-contract";

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

/**
 * Derive the bowler summary from canonical obligation evidence.
 *
 * Voided obligations are retained in the response for audit history, but they
 * are not current season charges. Allocated amounts intentionally use every
 * row so payments applied before an obligation was voided remain visible.
 */
export function deriveBowlerFinancials(
  rows: CanonicalDuePastDueRowV2[],
  asOf: string,
  authoritativePastDueMinor: number,
): BowlerViewFinancials {
  const activeRows = rows.filter((row) => row.state !== "voided" && row.classification !== "voided");
  const asOfMs = Date.parse(asOf);
  const dueToDateRows = activeRows.filter((row) => {
    const dueAtMs = Date.parse(row.dueAt);
    return Number.isFinite(asOfMs) && Number.isFinite(dueAtMs) && dueAtMs <= asOfMs;
  });
  const netDue = (row: CanonicalDuePastDueRowV2) => Math.max(0, row.amountMinor - row.waivedMinor);
  const occurrenceCount = (sourceRows: CanonicalDuePastDueRowV2[]) => new Set(sourceRows.map((row) => row.occurrenceId)).size;

  return {
    weeksDue: occurrenceCount(dueToDateRows),
    totalSeasonDues: dueToDateRows.reduce((sum, row) => sum + netDue(row), 0),
    totalWeeksInSeason: occurrenceCount(activeRows),
    fullSeasonAmount: activeRows.reduce((sum, row) => sum + netDue(row), 0),
    amountPastDue: authoritativePastDueMinor,
    remainingBalance: activeRows
      .filter((row) => !row.reviewRequired)
      .reduce((sum, row) => sum + Math.max(0, row.outstandingMinor), 0),
    // Keep historical payment evidence, including allocations on a later
    // voided obligation, in the amount-paid card.
    totalPaidAmount: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
    waivedAmount: activeRows.reduce((sum, row) => sum + row.waivedMinor, 0),
    totalUnpaidAmount: 0,
    reviewRequired: rows.some((row) => row.reviewRequired),
    reviewCategory: rows.some((row) => row.reviewRequired) ? "evidence" : null,
  };
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
