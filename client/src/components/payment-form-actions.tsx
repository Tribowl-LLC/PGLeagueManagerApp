import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";

interface PaymentFormActionsProps {
  onCancel: () => void;
  isSubmitting: boolean;
  isWalletProcessing: boolean;
  paymentType: string;
  providerNotFullyConfigured: boolean;
  cardMode: 'new' | 'saved';
  isSquareReady: boolean;
  selectedSavedCardId: string;
  selectedBowlerId: number | null | undefined;
  bowlerHasEmail: boolean;
  receiptEmail: string;
  occurrenceReadiness?: InteractiveOccurrenceReadiness;
}

export function PaymentFormActions({
  onCancel,
  isSubmitting,
  isWalletProcessing,
  paymentType,
  providerNotFullyConfigured,
  cardMode,
  isSquareReady,
  selectedSavedCardId,
  selectedBowlerId,
  bowlerHasEmail,
  receiptEmail,
  occurrenceReadiness = 'loading',
}: PaymentFormActionsProps) {
  return (
    <div className="flex justify-end gap-x-2">
      <Button
        type="button"
        variant="outline"
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        disabled={
          isSubmitting ||
          isWalletProcessing ||
          (paymentType === "credit_card" && providerNotFullyConfigured) ||
          (paymentType === "credit_card" && cardMode === 'new' && !isSquareReady) ||
          (paymentType === "credit_card" && cardMode === 'saved' && !selectedSavedCardId) ||
          // inline email is
          // required for Square card charges when bowler has
          // none on file. Server enforces this with
          // BUYER_EMAIL_REQUIRED; mirrored here so the user
          // never sees an avoidable round-trip.
          (paymentType === "credit_card" && !!selectedBowlerId && !bowlerHasEmail && !receiptEmail.trim())
          || (paymentType === "credit_card" && occurrenceReadiness !== 'ready')
        }
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Processing…
          </>
        ) : (
          "Submit Payment"
        )}
      </Button>
    </div>
  );
}
