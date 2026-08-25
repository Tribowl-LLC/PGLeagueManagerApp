import { useCallback } from "react";
import { useLocation } from "wouter";
import { createPayment, tokenizeCard } from "@/lib/square";
import { useToast } from "@/hooks/use-toast";
import { queryClient, csrfFetch } from '@/lib/queryClient';
import { logger } from "@/lib/logger";
import { formatCurrency } from "@/lib/utils";
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
import { invalidateF3AfterInteractivePayment } from "@/lib/f3-autopay";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";
import type { League, Bowler } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";
import type { AutopaySetupQuote } from "@/lib/autopay-setup";
type PaymentCard = SquareCard | null;
type InteractiveOccurrenceSelection = { obligationId: string; amountMinor: number };

interface UseBowlerPaymentSubmitOptions {
  league: League;
  bowler: Bowler;
  weeklyFee: number;
  card: PaymentCard;
  cardMode: 'new' | 'saved';
  selectedSavedCardId: string;
  selectedSchedule: 'weekly' | 'custom';
  storeCard: boolean;
  // optional inline email captured at checkout when the
  // bowler has none on file. Threaded to the server so Square's
  // hosted receipt fires for this charge.
  buyerEmail?: string;
  // the dashboard recipient picker passes
  // a partner's bowler id here when the logged-in bowler chose to
  // pay for them. Defaults to the logged-in bowler's own id (self
  // pay). Server-side `canUserPayForBowler` enforces that the actor
  // is actually linked to the chosen target.
  targetBowlerId?: number;
  // combined-autopay recipients. Forwarded as
  // `additionalBowlerIds` on POST /api/payment-schedules so the
  // autopay executor charges the payer's vault once per cycle for
  // every selected partner. Ignored unless `isAutoPay`.
  additionalBowlerIds?: number[];
  autopayQuote?: AutopaySetupQuote;
  occurrenceAllocations?: InteractiveOccurrenceSelection[];
  occurrenceQuoteFingerprint?: string;
  occurrenceReadiness?: InteractiveOccurrenceReadiness;
  financials: {
    fullSeasonAmount: number;
    remainingBalance: number;
    amountPastDue: number;
  };
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
  selectedSchedule,
  storeCard,
  buyerEmail,
  targetBowlerId,
  additionalBowlerIds,
  autopayQuote,
  occurrenceAllocations,
  occurrenceQuoteFingerprint,
  occurrenceReadiness,
  financials,
  calculateTotalAmount,
  setIsSubmitting,
  setShowPaymentSetup,
}: UseBowlerPaymentSubmitOptions) {
  // The bowler the charge is for — the picker's value when the
  // logged-in bowler chose a linked partner, otherwise self.
  const chargeForBowlerId = targetBowlerId ?? bowler.id;
  const { toast } = useToast();
  const [, navigate] = useLocation();
  // Local helper that lets the inline csrfFetch calls below propagate
  // the structured `error.code` (specifically PROVIDER_NOT_CONFIGURED)
  // up to the catch block — the previous code threw a bare-message
  // Error which dropped that signal.
  const throwApiErrorIfNotOk = async (
    response: Response,
    body: unknown,
    fallback: string,
  ) => {
    if (response.ok) return;
    throw makeApiError(body, response.status, fallback);
  };

  return useCallback(async () => {
    if (cardMode === 'new' && !card) {
      toast({ title: "Payment Setup Error", description: "Please enter your card details before proceeding.", variant: "destructive" });
      return;
    }
    if (cardMode === 'saved' && !selectedSavedCardId) {
      toast({ title: "Payment Setup Error", description: "Please select a saved card.", variant: "destructive" });
      return;
    }
    // After the gate above, if cardMode === 'new' then card is non-null.
    // Capture into a local so downstream branches can pass it without
    // a `card!` non-null assertion (lint forbids
    // `@typescript-eslint/no-non-null-assertion`).
    const newCard: NonNullable<PaymentCard> | null = cardMode === 'new' && card ? card : null;
    const occurrenceFields = buildInteractiveOccurrenceFields(occurrenceAllocations, occurrenceQuoteFingerprint);

    const isUpfront = league.paymentMode === 'upfront';
    const isAutoPay = !isUpfront && selectedSchedule !== 'custom';
    const hasCombinedPartners = (additionalBowlerIds?.length ?? 0) > 0;

    try {
      setIsSubmitting(true);

      const f2IntentBound = occurrenceReadiness !== undefined
        && (occurrenceAllocations !== undefined || occurrenceQuoteFingerprint !== undefined);
      if (f2IntentBound && occurrenceReadiness !== 'legacy' && occurrenceReadiness !== 'ready') {
        throw new Error(occurrenceReadiness === 'error'
          ? 'Current payment obligations could not be loaded. Refresh before paying.'
          : 'Select obligations totaling the payment amount before paying.');
      }

      // Roster-configured leagues use only the exact-obligation contract. The
      // historical amount/season payment routes remain archive-compatible,
      // but are deliberately unavailable for new canonical charges.
      if (league.payingLineupSize != null) {
        const selectedObligationIds = [...new Set((occurrenceAllocations ?? []).map((row) => row.obligationId))];
        if (selectedObligationIds.length === 0) {
          throw new Error('Select one or more exact payment obligations before paying.');
        }
        const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-quote/2`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ obligationIds: selectedObligationIds }),
        });
        const quoteBody = await quoteResponse.json().catch(() => ({}));
        await throwApiErrorIfNotOk(quoteResponse, quoteBody, 'Payment quote is unavailable');
        const quote = quoteBody?.data as { amountMinor?: number; fingerprint?: string } | undefined;
        const quotedAmountMinor = quote?.amountMinor;
        if (!quote?.fingerprint || typeof quotedAmountMinor !== 'number' || !Number.isSafeInteger(quotedAmountMinor) || quotedAmountMinor <= 0) {
          throw new Error('The exact payment quote is invalid. Refresh and try again.');
        }
        const sourceId = cardMode === 'saved'
          ? selectedSavedCardId
          : newCard ? await tokenizeCard(newCard) : '';
        if (!sourceId) throw new Error('A payment source is required.');
        const paymentScope = `roster:${league.id}:${selectedObligationIds.join(',')}:${quote.fingerprint}:${cardMode}`;
        const requestKey = beginPaymentIntent(paymentScope);
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-charge/2`, {
          method: 'POST',
          headers: { ...paymentRequestHeaders(requestKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            obligationIds: selectedObligationIds,
            sourceId,
            sourceKind: cardMode === 'saved' ? 'saved_card' : 'new_card',
            buyerEmail: (buyerEmail ?? '').trim() || null,
            // Card vaulting is a separate, explicitly authorized operation in
            // the PR2 consent flow and is not enabled by this PR1 charge.
            storeCard: false,
            idempotencyKey: requestKey,
            requestFingerprint: quote.fingerprint,
          }),
        }));
        const data = await response.json();
        await throwApiErrorIfNotOk(response, data, 'Payment failed');
        clearPaymentIntent(paymentScope);
        toast({ title: 'Payment submitted', description: data?.data?.status === 'succeeded' ? 'Your exact obligations were paid.' : 'Your payment is being confirmed.' });
        setShowPaymentSetup(false);
        queryClient.invalidateQueries({ queryKey: ['/api/financials', league.id] });
        queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
        return;
      }

      if (isUpfront) {
        // Preserve the established combined-upfront behavior. For one
        // bowler, settle a legacy partial payment with only the remaining
        // balance so the server-side overpayment guard accepts it.
        const upfrontAmount = hasCombinedPartners
          ? financials.fullSeasonAmount
          : financials.remainingBalance;
        const isRemainingBalanceSettlement =
          upfrontAmount < financials.fullSeasonAmount;
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();

        // Task #706: combined upfront — route through combined-payments
        // so ONE charge writes N+1 per-bowler rows.
        if (hasCombinedPartners) {
          const partnerIds = additionalBowlerIds ?? [];
          const totalPayees = 1 + partnerIds.length;
          const totalAmount = upfrontAmount * totalPayees;
          const payees = [
            { bowlerId: bowler.id, amount: upfrontAmount },
            ...partnerIds.map((id) => ({ bowlerId: id, amount: upfrontAmount })),
          ];
          const paymentScope = `bowler:combined:${league.id}:${totalAmount}:${JSON.stringify(payees)}:${cardMode === 'new' && storeCard}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
          const requestKey = beginPaymentIntent(paymentScope);
          let sourceId = selectedSavedCardId;
          if (cardMode === 'new') {
            if (!newCard) throw new Error('Please enter your card details before proceeding.');
            sourceId = await tokenizeCard(newCard);
          }
          const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/combined-payments', {
            method: 'POST',
            headers: paymentRequestHeaders(requestKey),
            body: JSON.stringify({
              sourceId,
              amount: totalAmount,
              leagueId: league.id,
              storeCard: cardMode === 'new' ? storeCard : false,
              sourceKind: cardMode === 'new' ? 'new_card' : 'saved_card',
              payees,
              ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
              ...occurrenceFields,
            }),
          }));
          const data = await response.json();
          await throwApiErrorIfNotOk(response, data, 'Payment failed');
          if (data.status !== 'COMPLETED') {
            throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
          }
          clearPaymentIntent(paymentScope);
          toast({
            title: "Payment Successful",
            description: `Combined payment of ${formatCurrency(totalAmount)} has been processed.`,
          });
          setShowPaymentSetup(false);
          queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
          invalidateF3AfterInteractivePayment(queryClient, league.id, league.organizationId);
          partnerIds.forEach((id) =>
            queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] }),
          );
          return;
        }

        if (cardMode === 'saved' && selectedSavedCardId) {
          const paymentScope = `bowler:${league.id}:${chargeForBowlerId}:${upfrontAmount}:saved${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
          const requestKey = beginPaymentIntent(paymentScope);
          const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/payments', {
            method: 'POST',
            headers: paymentRequestHeaders(requestKey),
            body: JSON.stringify({
              sourceId: selectedSavedCardId,
              amount: upfrontAmount,
              // target bowler is the payment recipient.
              // Server resolves the payer's vault from the session and
              // gates via canUserPayForBowler.
              bowlerId: chargeForBowlerId,
              leagueId: league.id,
              storeCard: false,
              sourceKind: 'saved_card',
              ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
              ...occurrenceFields,
            }),
          }));
          const responseData = await response.json();
          await throwApiErrorIfNotOk(response, responseData, 'Payment failed');
          if (responseData.status !== 'COMPLETED') {
            throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
          }
          clearPaymentIntent(paymentScope);
        } else {
          const overrideEmail = trimmedBuyerEmail && !bowler.email ? trimmedBuyerEmail : undefined;
          if (!newCard) throw new Error('Please enter your card details before proceeding.');
          const paymentScope = `bowler:${league.id}:${chargeForBowlerId}:${upfrontAmount}:new:${storeCard}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
          const requestKey = beginPaymentIntent(paymentScope);
          await createPayment(
            upfrontAmount,
            newCard,
            chargeForBowlerId,
            league.id,
            storeCard,
            overrideEmail,
            requestKey,
            occurrenceAllocations,
            occurrenceQuoteFingerprint,
          );
          clearPaymentIntent(paymentScope);
          if (storeCard) {
            // Vault belongs to the payer (logged-in bowler), not the
            // recipient — invalidate the payer's saved-card list.
            queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
          }
        }

        toast({
          title: "Payment Successful",
          description: isRemainingBalanceSettlement
            ? `Your remaining season balance of ${formatCurrency(upfrontAmount)} has been processed.`
            : `Your full season payment of ${formatCurrency(upfrontAmount)} has been processed.`,
        });
        setShowPaymentSetup(false);
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        invalidateF3AfterInteractivePayment(queryClient, league.id, league.organizationId);
        return;
      }

      const amount = calculateTotalAmount();

      // Task #706: combined ONE-TIME (non-autopay, non-upfront) — also
      // routed through the combined-payments endpoint. Autopay combined
      // is handled below by POSTing additionalBowlerIds on the schedule.
      if (!isAutoPay && hasCombinedPartners) {
        const partnerIds = additionalBowlerIds ?? [];
        const totalPayees = 1 + partnerIds.length;
        const totalAmount = amount * totalPayees;
        const payees = [
          { bowlerId: bowler.id, amount },
          ...partnerIds.map((id) => ({ bowlerId: id, amount })),
        ];
        const paymentScope = `bowler:combined:${league.id}:${totalAmount}:${JSON.stringify(payees)}:${cardMode === 'new' && storeCard}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
        const requestKey = beginPaymentIntent(paymentScope);
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        let sourceId = selectedSavedCardId;
        if (cardMode === 'new') {
          if (!newCard) throw new Error('Please enter your card details before proceeding.');
          sourceId = await tokenizeCard(newCard);
        }
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/combined-payments', {
          method: 'POST',
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({
            sourceId,
            amount: totalAmount,
            leagueId: league.id,
            storeCard: cardMode === 'new' ? storeCard : false,
            sourceKind: cardMode === 'new' ? 'new_card' : 'saved_card',
            payees,
            ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
            ...occurrenceFields,
          }),
        }));
        const data = await response.json();
        await throwApiErrorIfNotOk(response, data, 'Payment failed');
        if (data.status !== 'COMPLETED') {
          throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
        }
        clearPaymentIntent(paymentScope);
        if (cardMode === 'new' && storeCard) {
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }
        toast({
          title: "Payment Successful",
          description: `Combined payment of ${formatCurrency(totalAmount)} has been processed.`,
        });
        setShowPaymentSetup(false);
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        invalidateF3AfterInteractivePayment(queryClient, league.id, league.organizationId);
        partnerIds.forEach((id) =>
          queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] }),
        );
        return;
      }

      if (isAutoPay) {
        if (!autopayQuote) {
          throw new Error('Your auto-pay amounts are still loading. Please review them before confirming.');
        }
        let paymentCardId = selectedSavedCardId;
        if (cardMode === 'new') {
          if (!newCard) throw new Error('Please enter your card details before proceeding.');
          const token = await tokenizeCard(newCard);
          const saveResponse = await csrfFetch(`/api/payments-provider/cards/${bowler.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId: token, leagueId: league.id }),
          });
          const saveData = await saveResponse.json();
          await throwApiErrorIfNotOk(saveResponse, saveData, 'Failed to save card');
          paymentCardId = saveData.data?.savedCardId || '';
          if (!paymentCardId) {
            throw new Error('Your card could not be saved for auto-pay. Please try again.');
          }
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        const setupResponse = await csrfFetch('/api/payment-schedules/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bowlerId: bowler.id,
            leagueId: league.id,
            sourceId: paymentCardId,
            quoteFingerprint: autopayQuote.quoteFingerprint,
            additionalBowlerIds: additionalBowlerIds ?? [],
            ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
          }),
        });
        const setupData = await setupResponse.json();
        await throwApiErrorIfNotOk(setupResponse, setupData, 'Failed to set up automatic payments');
        const chargedToday = Number(setupData.data?.immediateAmountMinor ?? 0);
        toast({
          title: "Auto-Pay Activated",
          description: chargedToday > 0
            ? `Paid ${formatCurrency(chargedToday)} today and weekly auto-pay is now active for the next unpaid league occurrence.`
            : 'Your card has been saved and weekly auto-pay is now active for the next unpaid league occurrence.',
        });
        setShowPaymentSetup(false);
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        invalidateF3AfterInteractivePayment(queryClient, league.id, league.organizationId);
        queryClient.invalidateQueries({ queryKey: [`/api/payment-schedules/${bowler.id}/${league.id}`] });
        (additionalBowlerIds ?? []).forEach((id) =>
          queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] }),
        );
        return;
      }

      // One-time payments retain the established interactive charge path.
      if (cardMode === 'saved' && selectedSavedCardId) {
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        const paymentScope = `bowler:${league.id}:${chargeForBowlerId}:${amount}:saved${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
        const requestKey = beginPaymentIntent(paymentScope);
        const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/payments', {
          method: 'POST',
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({
            sourceId: selectedSavedCardId,
            amount,
            // chargeForBowlerId is the recipient bowler.
            bowlerId: chargeForBowlerId,
            leagueId: league.id,
            storeCard: false,
            sourceKind: 'saved_card',
            ...occurrenceFields,
            ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
          }),
        }));
        const responseData = await response.json();
        await throwApiErrorIfNotOk(response, responseData, 'Payment failed');
        if (responseData.status !== 'COMPLETED') {
          throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
        }
        clearPaymentIntent(paymentScope);
      } else {
        const shouldStore = storeCard;
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        const overrideEmail = trimmedBuyerEmail && !bowler.email ? trimmedBuyerEmail : undefined;
        if (!newCard) throw new Error('Please enter your card details before proceeding.');
        const paymentScope = `bowler:${league.id}:${chargeForBowlerId}:${amount}:new:${shouldStore}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
        const requestKey = beginPaymentIntent(paymentScope);
        await createPayment(
          amount,
          newCard,
          chargeForBowlerId,
          league.id,
          shouldStore,
          overrideEmail,
          requestKey,
          occurrenceAllocations,
          occurrenceQuoteFingerprint,
        );
        clearPaymentIntent(paymentScope);
        if (shouldStore) {
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }
      }
      toast({
        title: "Payment Successful",
        description: `Your payment of ${formatCurrency(amount)} has been processed.`,
      });

      setShowPaymentSetup(false);
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      invalidateF3AfterInteractivePayment(queryClient, league.id, league.organizationId);
      // Refresh the recipient's bowler details so payment-history
      // surfaces (which read /api/bowlers/:id/details?includePayments=true)
      // pick up the new "Paid by …" attribution immediately.
      if (chargeForBowlerId !== bowler.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${chargeForBowlerId}/details`] });
      }
    } catch (error) {
      logger.error('Payment', 'Payment submission failed', error);
      if (isProviderNotConfiguredError(error)) {
        toast(providerNotConfiguredToast({
          navigate,
          locationId: league.locationId ?? null,
        }));
        return;
      }
      // task #514: the backend (and `client/src/lib/square.ts`) no
      // longer return JSON-shaped `error.message` strings, so the
      // previous `JSON.parse(error.message)` branch is gone. The
      // shared sanitizer is the single source of truth for what a
      // payment-failure toast actually shows the user.
      const errorMessage = sanitizePaymentErrorMessage(
        error,
        "Unable to process payment. Please try again.",
      );
      toast({ title: "Payment Failed", description: errorMessage, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    card, cardMode, selectedSavedCardId, league, bowler,
    selectedSchedule, storeCard,
    buyerEmail, chargeForBowlerId, additionalBowlerIds, financials, calculateTotalAmount, toast, navigate,
    setIsSubmitting, setShowPaymentSetup, autopayQuote, occurrenceAllocations, occurrenceQuoteFingerprint, occurrenceReadiness,
  ]);
}
