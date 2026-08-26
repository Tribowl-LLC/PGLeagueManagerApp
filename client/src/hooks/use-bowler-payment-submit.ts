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
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import {
  assertRosterPaymentSucceeded,
  beginPaymentIntent,
  clearPaymentIntent,
  paymentRequestHeaders,
  paymentRequestWithRecovery,
} from "@/lib/payment-request-identity";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";
import type { League, Bowler } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";

type PaymentCard = SquareCard | null;
type InteractiveOccurrenceSelection = { obligationId: string; amountMinor: number };

interface UseBowlerPaymentSubmitOptions {
  league: League;
  bowler: Bowler;
  weeklyFee: number;
  card: PaymentCard;
  cardMode: "new" | "saved";
  selectedSavedCardId: string;
  selectedSchedule: "weekly" | "custom";
  storeCard: boolean;
  buyerEmail?: string;
  targetBowlerId?: number;
  // Retained in the call shape so old screens can be simplified separately;
  // canonical checkout never accepts combined or scheduled setup requests.
  additionalBowlerIds?: number[];
  autopayQuote?: unknown;
  occurrenceAllocations?: InteractiveOccurrenceSelection[];
  occurrenceQuoteFingerprint?: string;
  occurrenceReadiness?: InteractiveOccurrenceReadiness;
  financials: { fullSeasonAmount: number; remainingBalance: number; amountPastDue: number };
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
  targetBowlerId,
  occurrenceAllocations,
  occurrenceReadiness,
  setIsSubmitting,
  setShowPaymentSetup,
}: UseBowlerPaymentSubmitOptions) {
  const chargeForBowlerId = targetBowlerId ?? bowler.id;
  const { toast } = useToast();
  const [, navigate] = useLocation();

  return useCallback(async () => {
    try {
      if (cardMode === "new" && !card) throw new Error("Please enter your card details before proceeding.");
      if (cardMode === "saved" && !selectedSavedCardId) throw new Error("Please select a saved card.");
      if (occurrenceReadiness !== undefined && occurrenceReadiness !== "ready") {
        throw new Error(occurrenceReadiness === "error"
          ? "Current payment obligations could not be loaded. Refresh before paying."
          : "Select obligations totaling the payment amount before paying.");
      }
      const allocations = occurrenceAllocations ?? [];
      if (allocations.length === 0) throw new Error("Select one or more exact payment obligations before paying.");
      if (chargeForBowlerId !== bowler.id) throw new Error("Pay only obligations authorized for your account.");
      const obligationIds = [...new Set(allocations.map((row) => row.obligationId))];
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-quote/2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ obligationIds, allocations, payerBowlerId: bowler.id }),
      });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
      const sourceId = cardMode === "saved" ? selectedSavedCardId : card ? await tokenizeCard(card) : "";
      if (!sourceId) throw new Error("A payment source is required.");
      const paymentScope = `roster:${league.id}:${obligationIds.join(",")}:${quoteBody.data.fingerprint}:${cardMode}`;
      const requestKey = beginPaymentIntent(paymentScope);
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-charge/2`, {
        method: "POST",
        headers: paymentRequestHeaders(requestKey),
        body: JSON.stringify({
          obligationIds,
          allocations,
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
      toast({ title: "Payment submitted", description: status === "succeeded" ? "Your exact obligations were paid." : "Your payment is being confirmed." });
      setShowPaymentSetup(false);
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials", league.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
      if (storeCard && cardMode === "new") {
        queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
      }
    } catch (error) {
      logger.error("Payment", "Payment submission failed", error);
      if (isProviderNotConfiguredError(error)) {
        toast(providerNotConfiguredToast({ navigate, locationId: league.locationId ?? null }));
      } else {
        toast({ title: "Payment Failed", description: sanitizePaymentErrorMessage(error, "Unable to process payment. Please try again."), variant: "destructive" });
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [card, cardMode, selectedSavedCardId, league, bowler, storeCard, buyerEmail, chargeForBowlerId, occurrenceAllocations, occurrenceReadiness, setIsSubmitting, setShowPaymentSetup, toast, navigate]);
}
