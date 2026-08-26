import { UseFormReturn } from "react-hook-form";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import { makeApiError, isProviderNotConfiguredError, providerNotConfiguredToast } from "@/lib/provider-not-configured";
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import { beginPaymentIntent, clearPaymentIntent, paymentRequestHeaders, paymentRequestWithRecovery, assertRosterPaymentSucceeded } from "@/lib/payment-request-identity";
import { tokenizeCard } from "@/lib/square";
import type { InsertPaymentInput, InsertPayment } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";

type PaymentCard = SquareCard | null;

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
  allowStoreCard?: boolean;
}

/** Resolve the vault request from both the form checkbox and the current
 * payer ownership decision. A stale checked value must never survive a payer
 * change into the provider charge payload. */
export function resolveStoreCardRequest(allowStoreCard: boolean, requested: boolean | undefined): boolean {
  return allowStoreCard && requested === true;
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
  allowStoreCard = false,
}: UsePaymentFormSubmitOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  return async (data: InsertPayment) => {
    try {
      setPaymentError(null);
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-quote/2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMinor: data.amount, payerBowlerId: data.bowlerId }),
      });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
      const paymentScope = `admin:${data.leagueId}:${data.bowlerId}:${data.amount}:${quoteBody.data.fingerprint}:${data.type}:${cardMode}`;
      const requestKey = beginPaymentIntent(paymentScope);

      if (data.type === "cash" || data.type === "check") {
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/canonical/manual-record/1`, {
          method: "POST",
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({ amountMinor: data.amount, payerBowlerId: data.bowlerId, type: data.type, checkNumber: data.checkNumber, notes: data.notes ?? null, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }),
        }));
        const body = await response.json();
        if (!response.ok) throw makeApiError(body, response.status, "Failed to record payment");
        clearPaymentIntent(paymentScope);
        toast({ title: "Success", description: "Exact payment obligations recorded successfully" });
      } else {
        const sourceId = cardMode === "saved" ? selectedSavedCardId : card ? await tokenizeCard(card) : "";
        if (!sourceId) throw new Error("Credit card form is not ready.");
        const storeCard = resolveStoreCardRequest(allowStoreCard, data.storeCard);
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-charge/2`, {
          method: "POST",
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({ amountMinor: data.amount, payerBowlerId: quoteBody.data.payerBowlerId ?? data.bowlerId, sourceId, sourceKind: cardMode === "saved" ? "saved_card" : "new_card", buyerEmail: buyerEmail?.trim() || null, storeCard, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }),
        }), data.leagueId);
        const body = await response.json();
        if (!response.ok) throw makeApiError(body, response.status, "Failed to process payment");
        assertRosterPaymentSucceeded(body.data?.status);
        clearPaymentIntent(paymentScope);
        toast({ title: "Success", description: "Exact payment obligations charged successfully" });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
      if (allowStoreCard && data.storeCard === true && cardMode === "new") {
        queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${data.bowlerId}`] });
      }
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
