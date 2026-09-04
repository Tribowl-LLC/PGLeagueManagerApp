import { useCallback } from "react";
import { useLocation } from "wouter";
import { tokenizeCard } from "@/lib/square";
import { useToast } from "@/hooks/use-toast";
import { queryClient, csrfFetch } from "@/lib/queryClient";
import { logger } from "@/lib/logger";
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
  makeApiError,
} from "@/lib/provider-not-configured";
import { isHandledPaymentError, sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import {
  assertRosterPaymentSucceeded,
  beginPaymentIntent,
  clearPaymentIntent,
  paymentRequestHeaders,
  paymentRequestWithRecovery,
} from "@/lib/payment-request-identity";
import type { League, Bowler } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";

type PaymentCard = SquareCard | null;

interface UseBowlerPaymentSubmitOptions {
  league: Pick<League, "id" | "locationId">;
  bowler: Pick<Bowler, "id">;
  card: PaymentCard;
  cardMode: "new" | "saved";
  selectedSavedCardId: string;
  storeCard: boolean;
  buyerEmail?: string;
  calculateTotalAmount: () => number;
  setIsSubmitting: (v: boolean) => void;
  setShowPaymentSetup: (v: boolean) => void;
}

export function useBowlerPaymentSubmit({
  league,
  bowler,
  card,
  cardMode,
  selectedSavedCardId,
  storeCard,
  buyerEmail,
  calculateTotalAmount,
  setIsSubmitting,
  setShowPaymentSetup,
}: UseBowlerPaymentSubmitOptions) {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  return useCallback(async () => {
    try {
      if (cardMode === "new" && !card) throw new Error("Please enter your card details before proceeding.");
      if (cardMode === "saved" && !selectedSavedCardId) throw new Error("Please select a saved card.");
      const amountMinor = calculateTotalAmount();
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Enter a valid payment amount.");
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-quote/2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMinor, payerBowlerId: bowler.id }),
      });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
      const sourceId = cardMode === "saved" ? selectedSavedCardId : card ? await tokenizeCard(card) : "";
      if (!sourceId) throw new Error("A payment source is required.");
      const paymentScope = `roster:${league.id}:${bowler.id}:${amountMinor}:${quoteBody.data.fingerprint}:${cardMode}`;
      const requestKey = beginPaymentIntent(paymentScope);
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-charge/2`, {
        method: "POST",
        headers: paymentRequestHeaders(requestKey),
        body: JSON.stringify({
          amountMinor,
          payerBowlerId: quoteBody.data.payerBowlerId ?? bowler.id,
          sourceId,
          sourceKind: cardMode === "saved" ? "saved_card" : "new_card",
          buyerEmail: buyerEmail?.trim() || null,
          storeCard,
          idempotencyKey: requestKey,
          requestFingerprint: quoteBody.data.fingerprint,
        }),
      }), league.id);
      const body = await response.json();
      if (!response.ok) throw makeApiError(body, response.status, "Payment failed");
      const status = body.data?.status;
      assertRosterPaymentSucceeded(status);
      clearPaymentIntent(paymentScope);
      toast({ title: "Payment submitted", description: status === "succeeded" ? "Your payment was allocated automatically." : "Your payment is being confirmed." });
      setShowPaymentSetup(false);
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials", league.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
      if (storeCard && cardMode === "new") {
        queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
      }
    } catch (error) {
      // Declines, tokenization failures, and customer verification requests
      // are expected outcomes of an interactive payment. They are already
      // rendered in the toast, so don't turn normal customer action into a
      // Sentry incident. Keep provider/server failures observable, while
      // never passing the handled provider object to the logger.
      if (isHandledPaymentError(error)) {
        logger.debug("Payment", "Payment submission requires customer action");
      } else {
        logger.error("Payment", "Payment submission failed", error);
      }
      if (isProviderNotConfiguredError(error)) {
        toast(providerNotConfiguredToast({ navigate, locationId: league.locationId ?? null }));
      } else {
        toast({ title: "Payment Failed", description: sanitizePaymentErrorMessage(error, "Unable to process payment. Please try again."), variant: "destructive" });
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [card, cardMode, selectedSavedCardId, league, bowler, storeCard, buyerEmail, calculateTotalAmount, setIsSubmitting, setShowPaymentSetup, toast, navigate]);
}
