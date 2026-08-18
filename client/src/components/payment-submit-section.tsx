import { FC } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";

interface PaymentSubmitSectionProps {
  league: { paymentMode: string | null };
  selectedSchedule: string;
  fixedAmountType: 'remaining' | 'pastDue' | null;
  selectedWeeks: number;
  calculateTotalAmount: () => number;
  isSubmitting: boolean;
  cardMode: 'new' | 'saved';
  isInitialized: boolean;
  selectedSavedCardId: string;
  additionalBowlerCount?: number;
  // Server-calculated amount to charge during weekly auto-pay setup.
  autopayDueTodayOverride?: number | null;
  autopayQuoteLoading?: boolean;
  autopayQuoteError?: string | null;
  occurrenceReadiness?: InteractiveOccurrenceReadiness;
  onSubmit: () => void;
  onCancel: () => void;
}

export const PaymentSubmitSection: FC<PaymentSubmitSectionProps> = ({
  league,
  selectedSchedule,
  fixedAmountType,
  selectedWeeks,
  calculateTotalAmount,
  isSubmitting,
  cardMode,
  isInitialized,
  selectedSavedCardId,
  additionalBowlerCount = 0,
  autopayDueTodayOverride = null,
  autopayQuoteLoading = false,
  autopayQuoteError = null,
  occurrenceReadiness = 'loading',
  onSubmit,
  onCancel,
}) => {
  const multiplier = 1 + additionalBowlerCount;
  const useDueTodayOverride =
    autopayDueTodayOverride !== null && selectedSchedule === 'weekly';
  const displayAmount = useDueTodayOverride
    ? autopayDueTodayOverride
    : calculateTotalAmount() * multiplier;
  const occurrenceSelectionRequired = league.paymentMode === 'upfront' || selectedSchedule === 'custom';
  return (
    <>
      {league.paymentMode !== 'upfront' && (
        <div className="pt-4 border-t">
          <div className="flex justify-between items-center">
            <span className="text-lg font-medium">
              {useDueTodayOverride ? 'Total due today' : 'Total Amount'}
            </span>
            <span className="text-lg font-bold">{formatCurrency(displayAmount)}</span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {selectedSchedule === 'weekly' && (
              useDueTodayOverride
                ? `Then ${formatCurrency(calculateTotalAmount() * multiplier)} charged each league night`
                : 'Charged weekly'
            )}
            {selectedSchedule === 'custom' && (
              fixedAmountType === 'pastDue'
                ? 'One-time payment for Past Due Balance'
                : fixedAmountType === 'remaining'
                  ? 'One-time payment for Season Remaining Balance'
                  : `One-time payment for ${selectedWeeks} weeks`
            )}
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:justify-between gap-2">
        <Button 
          variant="outline"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button 
          onClick={onSubmit}
          disabled={
            (cardMode === 'new' && !isInitialized) ||
            (cardMode === 'saved' && !selectedSavedCardId) ||
            isSubmitting
            || autopayQuoteLoading
            || autopayQuoteError !== null
            || (occurrenceSelectionRequired && occurrenceReadiness !== 'legacy' && occurrenceReadiness !== 'ready')
          }
          className="min-w-[200px]"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Processing…
            </>
          ) : league.paymentMode === 'upfront' ? (
            `Pay ${formatCurrency(calculateTotalAmount() * multiplier)}`
          ) : (
            <>{selectedSchedule === 'custom' ? 'Make One-Time Payment' : 'Set Up Automatic Payments'}</>
          )}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground pt-2">
        <div className="flex-1 border-t" />
        <span>Secure payment powered by Square</span>
        <div className="flex-1 border-t" />
      </div>
    </>
  );
};
