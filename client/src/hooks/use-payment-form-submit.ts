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
import {
  beginPaymentIntent,
  clearPaymentIntent,
  paymentRequestHeaders,
  paymentRequestWithRecovery,
} from "@/lib/payment-request-identity";
import { buildInteractiveOccurrenceFields, interactiveIntentScopeSuffix } from "@/lib/interactive-payment-request";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";
import type { InsertPaymentInput, InsertPayment } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";
type PaymentCard = SquareCard | null;
type InteractiveOccurrenceSelection = { obligationId: string; amountMinor: number };

interface UsePaymentFormSubmitOptions {
  form: UseFormReturn<InsertPaymentInput, unknown, InsertPayment>;
  card: PaymentCard;
  cardMode: 'new' | 'saved';
  selectedSavedCardId: string;
  setPaymentError: (error: string | null) => void;
  onClose: () => void;
  // optional inline email captured when the selected
  // bowler has none on file — threaded to /payments-provider/payments
  // as `buyerEmail` so Square's hosted receipt still fires.
  buyerEmail?: string;
  /** Owning location used to deep-link the PROVIDER_NOT_CONFIGURED toast. */
  locationId?: number | null;
  organizationId?: number | null;
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
  organizationId,
  canonical = false,
  occurrenceAllocations,
  occurrenceQuoteFingerprint,
  occurrenceReadiness,
}: UsePaymentFormSubmitOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const onSubmit = async (data: InsertPayment) => {
    try {
      setPaymentError(null);

      const trimmedBuyerEmail = (buyerEmail ?? '').trim();
      const buyerEmailField = trimmedBuyerEmail ? { buyerEmail: trimmedBuyerEmail } : {};
      const occurrenceFields = buildInteractiveOccurrenceFields(occurrenceAllocations, occurrenceQuoteFingerprint);

      if (canonical && (data.type === 'cash' || data.type === 'check')) {
        const obligationIds = [...new Set((occurrenceAllocations ?? []).map((row) => row.obligationId))];
        if (obligationIds.length === 0) throw new Error('Select one or more exact obligations before recording payment.');
        const quoteResponse = await csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-quote/2`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ obligationIds, allocations: occurrenceAllocations }),
        });
        const quoteBody = await quoteResponse.json();
        if (!quoteResponse.ok || !quoteBody.data?.fingerprint) {
          throw makeApiError(quoteBody, quoteResponse.status, 'Payment quote is unavailable');
        }
        const requestKey = beginPaymentIntent(`manual:${data.leagueId}:${obligationIds.join(',')}:${data.type}:${quoteBody.data.fingerprint}`);
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/canonical/manual-record/1`, {
          method: 'POST',
          headers: { ...paymentRequestHeaders(requestKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            obligationIds,
            allocations: occurrenceAllocations,
            type: data.type,
            checkNumber: data.checkNumber,
            notes: data.notes ?? null,
            idempotencyKey: requestKey,
            requestFingerprint: quoteBody.data.fingerprint,
          }),
        }), organizationId);
        const responseBody = await response.json();
        if (!response.ok) throw makeApiError(responseBody, response.status, 'Failed to record payment');
        clearPaymentIntent(`manual:${data.leagueId}:${obligationIds.join(',')}:${data.type}:${quoteBody.data.fingerprint}`);
        toast({ title: 'Success', description: 'Exact payment obligations recorded successfully' });
        queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
        onClose();
        return;
      }

      if (data.type === 'credit_card') {
        const f2IntentBound = occurrenceReadiness !== undefined
          && (occurrenceAllocations !== undefined || occurrenceQuoteFingerprint !== undefined);
        if (f2IntentBound && occurrenceReadiness !== 'legacy' && occurrenceReadiness !== 'ready') {
          throw new Error(occurrenceReadiness === 'error'
            ? 'Current payment obligations could not be loaded. Refresh before paying.'
            : 'Select obligations totaling the payment amount before paying.');
        }
        if (canonical) {
          const obligationIds = [...new Set((occurrenceAllocations ?? []).map((row) => row.obligationId))];
          if (obligationIds.length === 0) throw new Error('Select one or more exact obligations before paying.');
          const quoteResponse = await csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-quote/2`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ obligationIds, allocations: occurrenceAllocations }),
          });
          const quoteBody = await quoteResponse.json();
          if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw makeApiError(quoteBody, quoteResponse.status, 'Payment quote is unavailable');
          const tokenized = cardMode === 'new' && card ? await card.tokenize() : null;
          if (tokenized && tokenized.status !== 'OK') throw new Error('Card validation failed');
          const sourceId = cardMode === 'saved' ? selectedSavedCardId : tokenized?.token ?? '';
          if (!sourceId) throw new Error('Credit card form is not ready.');
          const paymentScope = `admin-roster:${data.leagueId}:${obligationIds.join(',')}:${quoteBody.data.fingerprint}:${cardMode}`;
          const requestKey = beginPaymentIntent(paymentScope);
          const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${data.leagueId}/interactive-obligation-charge/2`, {
            method: 'POST',
            headers: { ...paymentRequestHeaders(requestKey), 'Content-Type': 'application/json' },
            body: JSON.stringify({ obligationIds, allocations: occurrenceAllocations, payerBowlerId: quoteBody.data.payerBowlerId, sourceId, sourceKind: cardMode === 'saved' ? 'saved_card' : 'new_card', buyerEmail: trimmedBuyerEmail || null, storeCard: false, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }),
          }), organizationId, data.leagueId);
          const responseData = await response.json();
          if (!response.ok) throw makeApiError(responseData, response.status, 'Failed to process payment');
          if (responseData.data?.status !== 'succeeded') throw new Error('Payment is not confirmed yet. Use payment recovery before trying again.');
          clearPaymentIntent(paymentScope);
          toast({ title: 'Success', description: 'Exact payment obligations charged successfully' });
          queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
          onClose();
          return;
        }
        const paymentScope = `admin:${data.bowlerId}:${data.leagueId}:${data.amount}:${cardMode}:${data.storeCard === true}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
        const requestKey = beginPaymentIntent(paymentScope);
        if (cardMode === 'saved' && selectedSavedCardId) {
          const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/payments', {
            method: 'POST',
            headers: paymentRequestHeaders(requestKey),
            body: JSON.stringify({
              sourceId: selectedSavedCardId,
              amount: data.amount,
              bowlerId: data.bowlerId,
              leagueId: data.leagueId,
              storeCard: false,
              sourceKind: 'saved_card',
              ...buyerEmailField,
              ...occurrenceFields,
            }),
          }), organizationId);

          const responseData = await response.json();
          if (!response.ok) {
            throw makeApiError(responseData, response.status, 'Failed to process payment');
          }
          if (responseData.status !== 'COMPLETED') {
            throw new Error('Your payment is still processing. You can safely retry this payment.');
          }

          clearPaymentIntent(paymentScope);
          toast({ title: "Success", description: "Payment processed with saved card" });
          queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
          onClose();
          return;
        }

        if (!card) {
          throw new Error('Credit card form not initialized');
        }

        let sourceToken: string;

        const result = await card.tokenize(
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

        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/payments', {
          method: 'POST',
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({
            sourceId: sourceToken,
            amount: data.amount,
            bowlerId: data.bowlerId,
            leagueId: data.leagueId,
            storeCard: data.storeCard || false,
            sourceKind: 'new_card',
            ...buyerEmailField,
            ...occurrenceFields,
          }),
        }), organizationId);

        const responseData = await response.json();
        if (!response.ok) {
          throw makeApiError(responseData, response.status, 'Failed to process payment');
        }

        if (responseData.status !== 'COMPLETED') {
          throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
        }
        clearPaymentIntent(paymentScope);
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
