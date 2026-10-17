import { useCallback } from "react";
import { useLocation } from "wouter";
import { tokenizeCard } from "@/lib/square";
import { useToast } from "@/hooks/use-toast";
import { queryClient, csrfFetch } from "@/lib/queryClient";
import { accountPaymentParticipantsQueryKey, loadAccountPaymentParticipantsV4 } from "@/lib/account-payment-v4";
import { accountPaymentFundingQuoteResponseV4Schema } from "@shared/account-payment-v4-contract";
import { logger } from "@/lib/logger";
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
  makeApiError,
} from "@/lib/provider-not-configured";
import { isHandledPaymentError, sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import {
  assertRosterPaymentSucceeded,
  clearPaymentIntent,
  interactivePaymentIntentScope,
  paymentRequestHeaders,
  paymentRequestWithRecovery,
  prepareRosterPaymentIntent,
} from "@/lib/payment-request-identity";
import type { League, Bowler } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";

type PaymentCard = SquareCard | null;

interface UseBowlerPaymentSubmitOptions {
  league: Pick<League, "id" | "locationId">;
  bowler: Pick<Bowler, "id">;
  actorUserId: number;
  organizationId: number;
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
  actorUserId,
  organizationId,
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
      const amountMinor = calculateTotalAmount();
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Enter a valid payment amount.");
      const paymentScope = interactivePaymentIntentScope({ actorUserId, organizationId, leagueId: league.id, bowlerId: bowler.id });
      const preparedIntent = await prepareRosterPaymentIntent(paymentScope, league.id);
      if (preparedIntent.outcome === "succeeded") {
        clearPaymentIntent(preparedIntent.scope ?? paymentScope, preparedIntent.requestKey);
        toast({ title: "Payment already confirmed", description: "Your previous payment was confirmed. Refreshing the payment balance." });
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        queryClient.invalidateQueries({ queryKey: ["/api/financials", league.id] });
        return;
      }
      if (preparedIntent.outcome === "terminal_failure") {
        clearPaymentIntent(preparedIntent.scope ?? paymentScope, preparedIntent.requestKey);
        throw new Error("Your previous payment was not completed. Try again.");
      }
      if (preparedIntent.outcome === "unresolved") {
        assertRosterPaymentSucceeded(preparedIntent.status);
        throw new Error("Your payment is not confirmed yet. Use payment recovery before trying again.");
      }
      if (cardMode === "new" && !card) throw new Error("Please enter your card details before proceeding.");
      if (cardMode === "saved" && !selectedSavedCardId) throw new Error("Please select a saved card.");
      const requestKey = preparedIntent.requestKey;
      const sourceId = cardMode === "saved" ? selectedSavedCardId : card ? await tokenizeCard(card) : "";
      if (!sourceId) throw new Error("A payment source is required.");
      const participants = await queryClient.fetchQuery({
        queryKey: accountPaymentParticipantsQueryKey(league.id, bowler.id),
        queryFn: ({ signal }) => loadAccountPaymentParticipantsV4(league.id, bowler.id, signal),
        staleTime: 30_000,
      });
      let response: Response;
      if (participants.accountingMode === "confirmed_account_v4") {
        const recipients = [{ bowlerId: bowler.id, selection: { kind: "explicit_amount" as const, amountMinor } }];
        const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-payment-quote/4`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payerBowlerId: bowler.id, recipients }),
        });
        const quoteBody = await quoteResponse.json().catch(() => ({}));
        if (!quoteResponse.ok) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
        const quote = accountPaymentFundingQuoteResponseV4Schema.parse(quoteBody.data);
        if (quote.providerChargeAmountMinor !== amountMinor || quote.recipients.length !== 1 || quote.recipients[0]?.bowlerId !== bowler.id) {
          throw new Error("The exact account funding amount could not be confirmed. Refresh and try again.");
        }
        response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-payment-charge/4`, {
          method: "POST",
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({
            payerBowlerId: bowler.id,
            recipients,
            sourceId,
            sourceKind: cardMode === "saved" ? "saved_card" : "new_card",
            buyerEmail: buyerEmail?.trim() || null,
            storeCard,
            idempotencyKey: requestKey,
            quoteFingerprint: quote.quoteFingerprint,
          }),
        }), league.id);
      } else {
        const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-quote/2`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountMinor, payerBowlerId: bowler.id }),
        });
        const quoteBody = await quoteResponse.json().catch(() => ({}));
        if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
        response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-charge/2`, {
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
      }
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
      queryClient.invalidateQueries({ queryKey: accountPaymentParticipantsQueryKey(league.id, bowler.id).slice(0, 3) });
      queryClient.invalidateQueries({ queryKey: ["manage-payments-snapshot", league.id] });
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
  }, [card, cardMode, selectedSavedCardId, league, bowler, actorUserId, organizationId, storeCard, buyerEmail, calculateTotalAmount, setIsSubmitting, setShowPaymentSetup, toast, navigate]);
}
