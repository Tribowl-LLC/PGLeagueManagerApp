import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";

/** F5 includes confirmed rotating prepayments before any weekly allocation exists. */
export function rotatingPaidTotalMinor(
  report: CanonicalPaymentReport | undefined,
  leagueId: number,
): number | null {
  if (
    report?.contractVersion !== "canonical-payment-report/2"
    || report.authoritativeSource !== "canonical"
    || report.leagueId !== leagueId
  ) return null;

  const gross = report.totals?.grossConfirmedPaidMinor;
  const refunded = report.totals?.refundedMinor;
  const disputed = report.totals?.disputedReviewRequiredMinor;
  const reviewRequired = report.totals?.reviewRequiredMinor;
  if (
    !Number.isSafeInteger(gross)
    || !Number.isSafeInteger(refunded)
    || !Number.isSafeInteger(disputed)
    || !Number.isSafeInteger(reviewRequired)
    || gross < 0
    || refunded < 0
    || refunded > gross
    || disputed !== 0
    || reviewRequired !== 0
  ) return null;

  return gross - refunded;
}
