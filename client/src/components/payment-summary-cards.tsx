/* eslint-disable shadcn/no-unknown-classes */
import { formatCurrency } from "@/lib/utils";
import { Link } from "wouter";

interface DoublePayInfo {
  dates: string[];
  perWeekExtra: number;
  totalExtra: number;
  pastExtra: number;
  isPaid: boolean;
}

interface PaymentSummaryCardsProps {
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  weeklyFee: number;
  weeksDueCount: number;
  totalSeasonDues: number;
  weeksPaid: number;
  totalPaidAmount: number;
  waivedAmount?: number;
  amountPastDue: number;
  remainingBalance: number;
  doublePay: DoublePayInfo;
  onPayPastDue: () => void;
  onPayRemaining: () => void;
  pastDueHref?: string;
  remainingHref?: string;
  /** Rotating shares intentionally expose only paid and past-due totals. */
  isRotating?: boolean;
}

export function PaymentSummaryCards({
  fullSeasonAmount,
  totalPaidAmount,
  amountPastDue,
  remainingBalance,
  onPayPastDue,
  onPayRemaining,
  pastDueHref,
  remainingHref,
  isRotating = false,
}: PaymentSummaryCardsProps) {
  const showPastDue = amountPastDue > 0;
  const summaryClassName = [
    "familiar-payment-summary__grid",
    showPastDue ? "familiar-payment-summary__grid--past-due" : "",
    isRotating ? "familiar-payment-summary__grid--rotating" : "",
  ].filter(Boolean).join(" ");

  const pastDueValue = showPastDue && pastDueHref ? (
    <Link
      href={pastDueHref}
      className="familiar-payment-summary__value familiar-payment-summary__value--past-due"
      aria-label="Amount Past Due — Make a payment"
      onClick={onPayPastDue}
    >
      {formatFamiliarCurrency(amountPastDue)}
    </Link>
  ) : showPastDue ? (
    <button type="button" className="familiar-payment-summary__value familiar-payment-summary__value--past-due" aria-label={`Pay past due balance of ${formatFamiliarCurrency(amountPastDue)}`} onClick={onPayPastDue}>
      {formatFamiliarCurrency(amountPastDue)}
    </button>
  ) : <span className="familiar-payment-summary__value">{formatFamiliarCurrency(0)}</span>;

  const remainingValue = remainingBalance > 0 && remainingHref ? (
    <Link
      href={remainingHref}
      className="familiar-payment-summary__value"
      aria-label="Full Season Remaining Balance — Make a payment"
      onClick={onPayRemaining}
    >
      {formatFamiliarCurrency(remainingBalance)}
    </Link>
  ) : remainingBalance > 0 ? (
    <button type="button" className="familiar-payment-summary__value" aria-label={`Pay remaining balance of ${formatFamiliarCurrency(remainingBalance)}`} onClick={onPayRemaining}>
      {formatFamiliarCurrency(remainingBalance)}
    </button>
  ) : <span className="familiar-payment-summary__value">{formatFamiliarCurrency(0)}</span>;

  return (
    <section className="familiar-payment-summary" aria-labelledby="history-season-totals-title">
      <h2 id="history-season-totals-title" className="familiar-payment-summary__heading">Season totals</h2>
      <div className={summaryClassName}>
        <div>
          <span className="familiar-payment-summary__label">Paid</span>
          <strong className="familiar-payment-summary__value">{formatFamiliarCurrency(totalPaidAmount)}</strong>
        </div>
        {!isRotating && (
          <>
            {showPastDue && <div>
              <span className="familiar-payment-summary__label">Past Due</span>
              {pastDueValue}
            </div>}
            <div>
              <span className="familiar-payment-summary__label">Remaining</span>
              {remainingValue}
              {remainingBalance <= 0 && <span className="sr-only">Fully paid</span>}
            </div>
            <div>
              <span className="familiar-payment-summary__label">Season</span>
              <strong className="familiar-payment-summary__value">{formatFamiliarCurrency(fullSeasonAmount)}</strong>
            </div>
          </>
        )}
        {isRotating && showPastDue && (
          <div>
            <span className="familiar-payment-summary__label">Past Due</span>
            {pastDueValue}
          </div>
        )}
      </div>

    </section>
  );
}

function formatFamiliarCurrency(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) return formatCurrency(amountMinor);
  const hasCents = Math.abs(amountMinor) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
