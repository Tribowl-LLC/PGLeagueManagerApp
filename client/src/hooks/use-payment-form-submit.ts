import { UseFormReturn } from "react-hook-form";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import { makeApiError, isProviderNotConfiguredError, providerNotConfiguredToast } from "@/lib/provider-not-configured";
import { isHandledPaymentError, sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import { beginPaymentIntent, clearPaymentIntent, interactivePaymentIntentScope, paymentRequestHeaders, paymentRequestWithRecovery, assertRosterPaymentSucceeded, prepareRosterPaymentIntent } from "@/lib/payment-request-identity";
import { tokenizeCard } from "@/lib/square";
import { logger } from "@/lib/logger";
import { accountPaymentParticipantsQueryKey, loadAccountPaymentParticipantsV4 } from "@/lib/account-payment-v4";
import { accountPaymentFundingQuoteResponseV4Schema } from "@shared/account-payment-v4-contract";
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
  actorUserId?: number | null;
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
  organizationId,
  actorUserId,
  allowStoreCard = false,
}: UsePaymentFormSubmitOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  return async (data: InsertPayment) => {
    try {
      setPaymentError(null);
      const isCardPayment = data.type !== "cash" && data.type !== "check";
      let paymentScope = "";
      let requestKey = "";
      if (isCardPayment) {
        if (!Number.isSafeInteger(data.leagueId) || !Number.isSafeInteger(data.bowlerId)
          || typeof organizationId !== "number" || !Number.isSafeInteger(organizationId)
          || typeof actorUserId !== "number" || !Number.isSafeInteger(actorUserId)) {
          throw new Error("Payment identity is unavailable. Refresh and try again.");
        }
        paymentScope = interactivePaymentIntentScope({ actorUserId, organizationId, leagueId: data.leagueId, bowlerId: data.bowlerId });
        const preparedIntent = await prepareRosterPaymentIntent(paymentScope, data.leagueId);
        if (preparedIntent.outcome === "succeeded") {
          clearPaymentIntent(preparedIntent.scope ?? paymentScope, preparedIntent.requestKey);
          toast({ title: "Payment already confirmed", description: "Your previous payment was confirmed. Refreshing the payment balance." });
          queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
          queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
          onClose();
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
        requestKey = preparedIntent.requestKey;
      }
      let legacyRequestFingerprint: string | null = null;
      let accountQuoteFingerprint: string | null = null;
      if (isCardPayment) {
        const participants = await queryClient.fetchQuery({
          queryKey: accountPaymentParticipantsQueryKey(data.leagueId, data.bowlerId),
          queryFn: ({ signal }) => loadAccountPaymentParticipantsV4(data.leagueId, data.bowlerId, signal),
          staleTime: 30_000,
        });
        if (participants.accountingMode === "confirmed_account_v4") {
          const recipients = [{ bowlerId: data.bowlerId, selection: { kind: "explicit_amount" as const, amountMinor: data.amount } }];
          const quoteResponse = await csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-payment-quote/4`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payerBowlerId: data.bowlerId, recipients }),
          });
          const quoteBody = await quoteResponse.json().catch(() => ({}));
          if (!quoteResponse.ok) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
          const quote = accountPaymentFundingQuoteResponseV4Schema.parse(quoteBody.data);
          if (quote.providerChargeAmountMinor !== data.amount || quote.recipients.length !== 1 || quote.recipients[0]?.bowlerId !== data.bowlerId) {
            throw new Error("The exact account funding amount could not be confirmed. Refresh and try again.");
          }
          accountQuoteFingerprint = quote.quoteFingerprint;
        }
      }
      if (!accountQuoteFingerprint) {
        const quoteResponse = await csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-quote/2`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountMinor: data.amount, payerBowlerId: data.bowlerId }),
        });
        const quoteBody = await quoteResponse.json().catch(() => ({}));
        if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, "Payment quote is unavailable");
        legacyRequestFingerprint = quoteBody.data.fingerprint;
      }
      if (!isCardPayment) {
        paymentScope = `admin:${data.leagueId}:${data.bowlerId}:${data.amount}:${legacyRequestFingerprint}:${data.type}:${cardMode}`;
        requestKey = beginPaymentIntent(paymentScope);
      }

      if (data.type === "cash" || data.type === "check") {
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/canonical/manual-record/1`, {
          method: "POST",
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({ amountMinor: data.amount, payerBowlerId: data.bowlerId, type: data.type, checkNumber: data.checkNumber, notes: data.notes ?? null, idempotencyKey: requestKey, requestFingerprint: legacyRequestFingerprint }),
        }));
        const body = await response.json();
        if (!response.ok) throw makeApiError(body, response.status, "Failed to record payment");
        clearPaymentIntent(paymentScope);
        toast({ title: "Success", description: "Exact payment obligations recorded successfully" });
      } else {
        const sourceId = cardMode === "saved" ? selectedSavedCardId : card ? await tokenizeCard(card) : "";
        if (!sourceId) throw new Error("Credit card form is not ready.");
        const storeCard = resolveStoreCardRequest(allowStoreCard, data.storeCard);
        const response = await paymentRequestWithRecovery(requestKey, () => accountQuoteFingerprint
          ? csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-payment-charge/4`, {
            method: "POST",
            headers: paymentRequestHeaders(requestKey),
            body: JSON.stringify({ payerBowlerId: data.bowlerId, recipients: [{ bowlerId: data.bowlerId, selection: { kind: "explicit_amount", amountMinor: data.amount } }], sourceId, sourceKind: cardMode === "saved" ? "saved_card" : "new_card", buyerEmail: buyerEmail?.trim() || null, storeCard, idempotencyKey: requestKey, quoteFingerprint: accountQuoteFingerprint }),
          })
          : csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-charge/2`, {
            method: "POST",
            headers: paymentRequestHeaders(requestKey),
            body: JSON.stringify({ amountMinor: data.amount, payerBowlerId: data.bowlerId, sourceId, sourceKind: cardMode === "saved" ? "saved_card" : "new_card", buyerEmail: buyerEmail?.trim() || null, storeCard, idempotencyKey: requestKey, requestFingerprint: legacyRequestFingerprint }),
          }), data.leagueId);
        const body = await response.json();
        if (!response.ok) throw makeApiError(body, response.status, "Failed to process payment");
        assertRosterPaymentSucceeded(body.data?.status);
        clearPaymentIntent(paymentScope);
        toast({ title: "Success", description: "Exact payment obligations charged successfully" });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
      queryClient.invalidateQueries({ queryKey: accountPaymentParticipantsQueryKey(data.leagueId, data.bowlerId).slice(0, 3) });
      queryClient.invalidateQueries({ queryKey: ["manage-payments-snapshot", data.leagueId] });
      if (allowStoreCard && data.storeCard === true && cardMode === "new") {
        queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${data.bowlerId}`] });
      }
      onClose();
    } catch (error) {
      if (isHandledPaymentError(error)) {
        logger.debug("Payment", "Payment submission requires customer action");
      } else {
        logger.error("Payment", "Payment submission failed", error);
      }
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
