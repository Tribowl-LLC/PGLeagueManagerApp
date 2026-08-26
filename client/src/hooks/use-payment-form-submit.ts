import { UseFormReturn } from "react-hook-form";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import { makeApiError, isProviderNotConfiguredError, providerNotConfiguredToast } from "@/lib/provider-not-configured";
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import { beginPaymentIntent, clearPaymentIntent, paymentRequestHeaders, paymentRequestWithRecovery, assertRosterPaymentSucceeded } from "@/lib/payment-request-identity";
import { tokenizeCard } from "@/lib/square";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";
import type { InsertPaymentInput, InsertPayment } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";

type PaymentCard = SquareCard | null;
type InteractiveOccurrenceSelection = { obligationId: string; amountMinor: number };

interface UsePaymentFormSubmitOptions {
  form: UseFormReturn<InsertPaymentInput, unknown, InsertPayment>;
  card: PaymentCard;
  cardMode: "new" | "saved";
  selectedSavedCardId: string;
  setPaymentError: (error: string | null) => void;
  onClose: () => void;
  buyerEmail?: string;
  locationId?: number | null;
  organizationId?: number | null;
  // Kept in the public hook shape while the form is collapsed to one
  // canonical path. Every league now uses exact occurrence obligations.
  canonical?: boolean;
  occurrenceAllocations?: InteractiveOccurrenceSelection[];
  occurrenceQuoteFingerprint?: string;
  occurrenceReadiness?: InteractiveOccurrenceReadiness;
}

export function usePaymentFormSubmit({
  form,
  card,
  cardMode,
  selectedSavedCardId,
  setPaymentError,
  onClose,
  buyerEmail,
  locationId,
  occurrenceAllocations,
  occurrenceReadiness,
}: UsePaymentFormSubmitOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  return async (data: InsertPayment) => {
    try {
      setPaymentError(null);
      if (occurrenceReadiness !== undefined && occurrenceReadiness !== "ready") {
        throw new Error(occurrenceReadiness === "error"
          ? "Current payment obligations could not be loaded. Refresh before paying."
          : "Select obligations totaling the payment amount before paying.");
      }
      const allocations = occurrenceAllocations ?? [];
      if (allocations.length === 0) throw new Error("Select one or more exact payment obligations before recording payment.");
      const obligationIds = [...new Set(allocations.map((row) => row.obligationId))];
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-quote/2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ obligationIds, allocations, payerBowlerId: data.bowlerId }),
      });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
      const paymentScope = `admin:${data.leagueId}:${obligationIds.join(",")}:${quoteBody.data.fingerprint}:${data.type}:${cardMode}`;
      const requestKey = beginPaymentIntent(paymentScope);

      if (data.type === "cash" || data.type === "check") {
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/canonical/manual-record/1`, {
          method: "POST",
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({ obligationIds, allocations, type: data.type, checkNumber: data.checkNumber, notes: data.notes ?? null, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }),
        }));
        const body = await response.json();
        if (!response.ok) throw makeApiError(body, response.status, "Failed to record payment");
        clearPaymentIntent(paymentScope);
        toast({ title: "Success", description: "Exact payment obligations recorded successfully" });
      } else {
        const sourceId = cardMode === "saved" ? selectedSavedCardId : card ? await tokenizeCard(card) : "";
        if (!sourceId) throw new Error("Credit card form is not ready.");
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-charge/2`, {
          method: "POST",
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({ obligationIds, allocations, payerBowlerId: quoteBody.data.payerBowlerId ?? data.bowlerId, sourceId, sourceKind: cardMode === "saved" ? "saved_card" : "new_card", buyerEmail: buyerEmail?.trim() || null, storeCard: data.storeCard === true, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }),
        }), data.leagueId);
        const body = await response.json();
        if (!response.ok) throw makeApiError(body, response.status, "Failed to process payment");
        assertRosterPaymentSucceeded(body.data?.status);
        clearPaymentIntent(paymentScope);
        toast({ title: "Success", description: "Exact payment obligations charged successfully" });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      onClose();
    } catch (error) {
      if (isProviderNotConfiguredError(error)) {
        toast(providerNotConfiguredToast({ navigate, locationId: locationId ?? null }));
      } else {
        const message = sanitizePaymentErrorMessage(error, "Unable to process payment. Please try again.");
        setPaymentError(message);
        toast({ title: "Payment Failed", description: message, variant: "destructive" });
      }
    }
  };
}
