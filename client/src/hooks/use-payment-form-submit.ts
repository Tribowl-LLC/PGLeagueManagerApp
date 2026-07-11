import { UseFormReturn } from "react-hook-form";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
  makeApiError,
} from "@/lib/provider-not-configured";
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import type { InsertPaymentInput, InsertPayment } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";
import type { CloverCard } from "@/hooks/use-clover-payment";

type PaymentCard = SquareCard | CloverCard | null;

interface UsePaymentFormSubmitOptions {
  form: UseFormReturn<InsertPaymentInput, unknown, InsertPayment>;
  card: PaymentCard;
  cardMode: 'new' | 'saved';
  selectedSavedCardId: string;
  setPaymentError: (error: string | null) => void;
  onClose: () => void;
  isClover?: boolean;
  // optional inline email captured when the selected
  // bowler has none on file — threaded to /payments-provider/payments
  // as `buyerEmail` so Square's hosted receipt still fires.
  buyerEmail?: string;
  /** Owning location used to deep-link the PROVIDER_NOT_CONFIGURED toast. */
  locationId?: number | null;
}

export function usePaymentFormSubmit({
  form,
  card,
  cardMode,
  selectedSavedCardId,
  setPaymentError,
  onClose,
  isClover = false,
  buyerEmail,
  locationId,
}: UsePaymentFormSubmitOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const onSubmit = async (data: InsertPayment) => {
    try {
      setPaymentError(null);

      const trimmedBuyerEmail = (buyerEmail ?? '').trim();
      const buyerEmailField = trimmedBuyerEmail ? { buyerEmail: trimmedBuyerEmail } : {};

      if (data.type === 'credit_card') {
        if (cardMode === 'saved' && selectedSavedCardId) {
          const response = await csrfFetch('/api/payments-provider/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId: selectedSavedCardId,
              amount: data.amount,
              bowlerId: data.bowlerId,
              leagueId: data.leagueId,
              storeCard: false,
              ...buyerEmailField,
            }),
          });

          const responseData = await response.json();
          if (!response.ok) {
            throw makeApiError(responseData, response.status, 'Failed to process payment');
          }

          toast({ title: "Success", description: "Payment processed with saved card" });
          queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
          onClose();
          return;
        }

        if (!card) {
          throw new Error('Credit card form not initialized');
        }

        let sourceToken: string;

        if (isClover) {
          const cvCard = card as CloverCard;
          const result = await cvCard.tokenize();
          sourceToken = result.token;
        } else {
          const sqCard = card as SquareCard;
          const result = await sqCard.tokenize(
            data.storeCard ? {
              cardOnFile: true,
              verificationMethod: 'EXTERNAL',
              verificationDetails: {
                amount: data.amount.toString(),
                currencyCode: 'USD',
                intent: 'STORE'
              }
            } : undefined
          );

          if (result.status !== 'OK' || !result.token) {
            const errors = result.errors || [];
            const errorMessage = errors.map((e: { message: string }) => e.message).join(', ') || 'Card validation failed';
            throw new Error(errorMessage);
          }
          sourceToken = result.token;
        }

        const response = await csrfFetch('/api/payments-provider/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: sourceToken,
            amount: data.amount,
            bowlerId: data.bowlerId,
            leagueId: data.leagueId,
            storeCard: data.storeCard || false,
            ...buyerEmailField,
          }),
        });

        const responseData = await response.json();
        if (!response.ok) {
          throw makeApiError(responseData, response.status, 'Failed to process payment');
        }

        toast({ title: "Success", description: "Payment processed successfully" });
        if (data.storeCard) {
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${data.bowlerId}`] });
        }
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        onClose();
        return;
      }

      const response = await csrfFetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const responseData = await response.json();

      if (!response.ok) {
        throw new Error(responseData.error?.message || 'Failed to process payment');
      }

      toast({ title: "Success", description: "Payment recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      onClose();
    } catch (error) {
      if (isProviderNotConfiguredError(error)) {
        const props = providerNotConfiguredToast({
          navigate,
          locationId: locationId ?? null,
          provider: isClover ? "clover" : "square",
        });
        setPaymentError(props.title);
        toast(props);
        return;
      }
      // task #514: route every payment-failure message through a
      // single sanitizer so JSON-shaped or multi-line strings never
      // leak into the toast even if a new code path forgets to map
      // them to a friendly sentence.
      const errorMessage = sanitizePaymentErrorMessage(error, "Failed to process payment");
      setPaymentError(errorMessage);
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  return onSubmit;
}
