/* eslint-disable shadcn/no-unknown-classes */
import { FC } from "react";
import { Link } from "wouter";
import { ArrowRight, Check } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { PaymentMode } from "@shared/schema";

interface FinancialsData {
  fullSeasonAmount: number;
  totalDueToDate: number;
  totalPaid: number;
  waivedAmount?: number;
  amountPastDue: number;
  remainingBalance: number;
}

interface PaymentOverviewCardProps {
  weeklyFee: number;
  financials: FinancialsData;
  leagueId?: number;
  paymentMode: PaymentMode;
  /** Current due includes canonical rows classified due as well as past due. */
  currentDueMinor?: number;
  /** Stored canonical schedule period for the current due, when available. */
  duePeriod?: string | null;
  /** Rotating shares intentionally expose only paid and past-due totals. */
  isRotating?: boolean;
}

/** Read-only canonical payment summary for the bowler dashboard. */
export const PaymentOverviewCard: FC<PaymentOverviewCardProps> = ({
  financials,
  leagueId,
  paymentMode,
  currentDueMinor,
  duePeriod,
  isRotating = false,
}) => {
  const isUpfront = paymentMode === "upfront";
  const pastDue = isUpfront ? 0 : Math.max(0, financials.amountPastDue);
  const isPaidInFull = !isRotating && financials.remainingBalance <= 0 && financials.totalPaid > 0;
  const statusAmount = isUpfront ? Math.max(0, financials.remainingBalance) : Math.max(0, currentDueMinor ?? pastDue);
  const hasDueStatus = statusAmount > 0;
  const summaryItems = isRotating
    ? [
        { label: "Paid", value: financials.totalPaid },
        ...(pastDue > 0 ? [{ label: "Past Due", value: pastDue, pastDue: true }] : []),
      ]
    : [
        { label: "Paid", value: financials.totalPaid },
        ...(pastDue > 0 ? [{ label: "Past Due", value: pastDue, pastDue: true }] : []),
        { label: "Remaining", value: financials.remainingBalance },
        { label: "Season", value: financials.fullSeasonAmount },
      ];

  return (
    <section className="familiar-payment-overview" aria-labelledby="payment-overview-title">
      <header className="familiar-payment-overview__header">
        <h2 id="payment-overview-title" className="familiar-payment-overview__title">Payment overview</h2>
      </header>

      <div className="familiar-payment-overview__status" aria-live="polite">
        {hasDueStatus ? (
          <>
            <strong className="familiar-payment-overview__amount">{formatFamiliarCurrency(statusAmount)}</strong>
            <h3 className="familiar-payment-overview__status-title">Due now</h3>
            {duePeriod && <p className="familiar-payment-overview__status-copy">{duePeriod}</p>}
          </>
        ) : (
          <>
            {isPaidInFull && <span aria-hidden="true" className="familiar-payment-overview__success-icon"><Check size={24} /></span>}
            <h3 className="familiar-payment-overview__status-title">
              {isPaidInFull ? "Season paid in full" : "You’re up to date"}
            </h3>
            <p className="familiar-payment-overview__status-copy">
              {isPaidInFull ? "Your full season balance is settled." : "No payment is due right now."}
            </p>
          </>
        )}
      </div>

      {leagueId !== undefined && (
        <Link
          href={`/make-payment?leagueId=${leagueId}`}
          className="familiar-payment-overview__cta"
          aria-label={hasDueStatus ? `Pay ${formatFamiliarCurrency(statusAmount)}` : "Make a payment"}
        >
          {hasDueStatus ? `Pay ${formatFamiliarCurrency(statusAmount)}` : "Make a payment"}
          <ArrowRight aria-hidden="true" size={18} />
        </Link>
      )}

      <div className="familiar-payment-overview__summary">
        <span className="familiar-payment-overview__summary-label">Season totals</span>
        <div className={`familiar-payment-overview__summary-grid${pastDue > 0 ? " familiar-payment-overview__summary-grid--past-due" : ""}${isRotating ? " familiar-payment-overview__summary-grid--rotating" : ""}`}>
          {summaryItems.map((item) => (
            <div key={item.label}>
              <span className="familiar-payment-overview__summary-label">{item.label}</span>
              <strong className={`familiar-payment-overview__summary-value${item.pastDue ? " familiar-payment-overview__summary-value--past-due" : ""}`}>
                {formatFamiliarCurrency(item.value)}
              </strong>
            </div>
          ))}
        </div>
      </div>

    </section>
  );
};

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
