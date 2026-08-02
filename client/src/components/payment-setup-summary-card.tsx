import { FC } from "react";
import { CalendarDays } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { formatInTimeZone } from "date-fns-tz";
import type { AutopaySetupQuote } from "@/lib/autopay-setup";

interface PaymentSetupSummaryCardProps {
  league: { paymentMode: string | null };
  paymentMode: 'autopay' | 'onetime';
  weeklyFee: number;
  totalWeeks: number;
  upfrontPaymentAmount: number;
  additionalBowlerCount: number;
  anyAutopayPastDue: boolean;
  autopayDueTodayTotal: number;
  autopayQuote?: AutopaySetupQuote;
  autopayQuoteLoading: boolean;
  autopayQuoteError: string | null;
}

export const PaymentSetupSummaryCard: FC<PaymentSetupSummaryCardProps> = ({
  league,
  paymentMode,
  weeklyFee,
  totalWeeks,
  upfrontPaymentAmount,
  additionalBowlerCount,
  anyAutopayPastDue,
  autopayDueTodayTotal,
  autopayQuote,
  autopayQuoteLoading,
  autopayQuoteError,
}) => {
  if (league.paymentMode === 'upfront') {
    return (
      <div className="rounded-md border bg-muted/30 p-4 space-y-2">
        <div className="flex items-center justify-between py-1">
          <span className="text-sm text-muted-foreground">Weekly fee</span>
          <span className="text-sm">{formatCurrency(weeklyFee)} / week</span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-sm text-muted-foreground">Season length</span>
          <span className="text-sm">{totalWeeks} weeks</span>
        </div>
        <div className="border-t pt-3 flex items-center justify-between">
          <span className="font-semibold">Total due today</span>
          <span className="text-lg font-bold" data-testid="upfront-total-due">
            {formatCurrency(upfrontPaymentAmount * (1 + additionalBowlerCount))}
          </span>
        </div>
      </div>
    );
  }
  if (paymentMode === 'autopay') {
    const coveredDates = [...new Set(
      autopayQuote?.coveredOccurrences.map((row) => row.localDate) ?? [],
    )];
    return (
      <div className="rounded-md border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <CalendarDays className="size-5 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium">Weekly auto-pay</p>
            <p className="text-sm text-muted-foreground">{formatCurrency(weeklyFee)} charged each league night</p>
          </div>
        </div>
        {autopayQuoteLoading && (
          <p className="border-t pt-3 text-sm text-muted-foreground">Calculating exact billing occurrencesâ€¦</p>
        )}
        {autopayQuoteError && (
          <p className="border-t pt-3 text-sm text-destructive" role="alert">{autopayQuoteError}</p>
        )}
        {autopayQuote && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Charge today</span>
              <span
                className="text-base font-bold"
                data-testid="autopay-due-today"
              >
                {formatCurrency(autopayDueTodayTotal)}
              </span>
            </div>
            {anyAutopayPastDue && coveredDates.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Covering {coveredDates.map((date) => formatInTimeZone(
                  new Date(`${date}T12:00:00Z`),
                  'UTC',
                  'MMMM d',
                )).join(', ')}
              </p>
            )}
            {autopayQuote.firstAutomaticAt ? (
              <div className="text-sm">
                <span className="font-medium">First automatic payment: </span>
                <span>
                  {formatInTimeZone(
                    new Date(autopayQuote.firstAutomaticAt),
                    autopayQuote.timezone,
                    'MMMM d, yyyy h:mm a zzz',
                  )} â€” {formatCurrency(autopayQuote.firstAutomaticAmountMinor)}
                </span>
              </div>
            ) : (
              <p className="text-sm">No future automatic payment is required.</p>
            )}
            {autopayQuote.firstAutomaticAt && (
              <p className="text-xs text-muted-foreground">
                Then weekly at {formatInTimeZone(
                  new Date(autopayQuote.firstAutomaticAt),
                  autopayQuote.timezone,
                  'h:mm a zzz',
                )}; configured double-pay weeks may be higher.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }
  return null;
};
