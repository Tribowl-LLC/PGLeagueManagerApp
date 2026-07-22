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
import type { League, Bowler } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";
type PaymentCard = SquareCard | null;

// Human-friendly cadence label for auto-pay toast copy (avoids
// interpolating raw schedule keys into user-facing text).
function scheduleLabel(schedule: 'weekly' | 'custom'): string {
  return schedule === 'weekly' ? 'weekly' : 'recurring';
}

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
  // Task #715: per-partner past-due balances. Used to compute the
  // combined "catch-up + this week" immediate charge when setting up
  // weekly auto-pay so every included bowler is brought current as
  // part of the same transaction. When omitted, partners are assumed
  // to have zero past-due (legacy behavior).
  partnerPastDueByBowlerId?: Record<number, number>;
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
  weeklyFee,
  card,
  cardMode,
  selectedSavedCardId,
  selectedSchedule,
  storeCard,
  buyerEmail,
  targetBowlerId,
  additionalBowlerIds,
  partnerPastDueByBowlerId,
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

    const isUpfront = league.paymentMode === 'upfront';
    const isAutoPay = !isUpfront && selectedSchedule !== 'custom';
    const hasCombinedPartners = (additionalBowlerIds?.length ?? 0) > 0;

    try {
      setIsSubmitting(true);

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
          let sourceId = selectedSavedCardId;
          if (cardMode === 'new') {
            if (!newCard) throw new Error('Please enter your card details before proceeding.');
            sourceId = await tokenizeCard(newCard);
          }
          const response = await csrfFetch('/api/payments-provider/combined-payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId,
              amount: totalAmount,
              leagueId: league.id,
              storeCard: cardMode === 'new' ? storeCard : false,
              payees,
              ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
            }),
          });
          const data = await response.json();
          await throwApiErrorIfNotOk(response, data, 'Payment failed');
          toast({
            title: "Payment Successful",
            description: `Combined payment of ${formatCurrency(totalAmount)} has been processed.`,
          });
          setShowPaymentSetup(false);
          queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
          partnerIds.forEach((id) =>
            queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] }),
          );
          return;
        }

        if (cardMode === 'saved' && selectedSavedCardId) {
          const response = await csrfFetch('/api/payments-provider/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId: selectedSavedCardId,
              amount: upfrontAmount,
              // target bowler is the payment recipient.
              // Server resolves the payer's vault from the session and
              // gates via canUserPayForBowler.
              bowlerId: chargeForBowlerId,
              leagueId: league.id,
              storeCard: false,
              ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
            }),
          });
          const responseData = await response.json();
          await throwApiErrorIfNotOk(response, responseData, 'Payment failed');
        } else {
          const overrideEmail = trimmedBuyerEmail && !bowler.email ? trimmedBuyerEmail : undefined;
          if (!newCard) throw new Error('Please enter your card details before proceeding.');
          await createPayment(upfrontAmount, newCard, chargeForBowlerId, league.id, storeCard, overrideEmail);
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
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        let sourceId = selectedSavedCardId;
        if (cardMode === 'new') {
          if (!newCard) throw new Error('Please enter your card details before proceeding.');
          sourceId = await tokenizeCard(newCard);
        }
        const response = await csrfFetch('/api/payments-provider/combined-payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId,
            amount: totalAmount,
            leagueId: league.id,
            storeCard: cardMode === 'new' ? storeCard : false,
            payees,
            ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
          }),
        });
        const data = await response.json();
        await throwApiErrorIfNotOk(response, data, 'Payment failed');
        if (cardMode === 'new' && storeCard) {
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }
        toast({
          title: "Payment Successful",
          description: `Combined payment of ${formatCurrency(totalAmount)} has been processed.`,
        });
        setShowPaymentSetup(false);
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        partnerIds.forEach((id) =>
          queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] }),
        );
        return;
      }

      // Task #715: weekly auto-pay setup must clear any included
      // bowler's past-due balance up front. The immediate charge is
      // Σ(amountPastDue + weeklyFee) across the payer + each combined
      // partner; only on success do we create the recurring schedule.
      const partnerIdsForAutopay = isAutoPay ? (additionalBowlerIds ?? []) : [];
      const partnerPastDueMap = partnerPastDueByBowlerId ?? {};
      const selfPastDue = financials.amountPastDue;
      const anyAutopayPastDue =
        isAutoPay &&
        (selfPastDue > 0 ||
          partnerIdsForAutopay.some((id) => (partnerPastDueMap[id] ?? 0) > 0));
      let paymentCardId: string | null = null;
      let paymentWasCharged = false;
      let autopayChargedAmount = 0;

      if (isAutoPay && !anyAutopayPastDue) {
        // Zero past-due everywhere: keep the legacy "save card only,
        // schedule starts on the next league night" flow.
        if (cardMode === 'saved' && selectedSavedCardId) {
          paymentCardId = selectedSavedCardId;
        } else {
          const token = await tokenizeCard(card);
          const saveResponse = await csrfFetch(`/api/payments-provider/cards/${bowler.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId: token, leagueId: league.id }),
          });
          const saveData = await saveResponse.json();
          await throwApiErrorIfNotOk(saveResponse, saveData, 'Failed to save card');
          paymentCardId = saveData.data?.savedCardId || null;
          if (!paymentCardId) {
            throw new Error('Your card could not be saved for auto-pay. Please try again.');
          }
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }
      } else if (isAutoPay && anyAutopayPastDue) {
        // Step 1: get a savedCardId. We always vault new cards here
        // because the recurring schedule needs a card id to charge.
        let cardIdForAutopay: string | null = null;
        if (cardMode === 'saved' && selectedSavedCardId) {
          cardIdForAutopay = selectedSavedCardId;
        } else {
          if (!newCard) throw new Error('Please enter your card details before proceeding.');
          const token = await tokenizeCard(newCard);
          const saveResponse = await csrfFetch(`/api/payments-provider/cards/${bowler.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId: token, leagueId: league.id }),
          });
          const saveData = await saveResponse.json();
          await throwApiErrorIfNotOk(saveResponse, saveData, 'Failed to save card');
          cardIdForAutopay = saveData.data?.savedCardId || null;
          if (!cardIdForAutopay) {
            throw new Error('Your card could not be saved for auto-pay. Please try again.');
          }
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }

        // Step 2: charge the combined catch-up + this-week amount.
        // Per-bowler amount = amountPastDue + weeklyFee. Every
        // included bowler is brought current in the same charge so
        // the schedule can start on the next league night cleanly.
        const selfDueToday = selfPastDue + weeklyFee;
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        if (hasCombinedPartners) {
          const payees = [
            { bowlerId: bowler.id, amount: selfDueToday },
            ...partnerIdsForAutopay.map((id) => ({
              bowlerId: id,
              amount: (partnerPastDueMap[id] ?? 0) + weeklyFee,
            })),
          ];
          const totalAmount = payees.reduce((sum, p) => sum + p.amount, 0);
          const response = await csrfFetch('/api/payments-provider/combined-payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId: cardIdForAutopay,
              amount: totalAmount,
              leagueId: league.id,
              storeCard: false,
              payees,
              ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
            }),
          });
          const data = await response.json();
          await throwApiErrorIfNotOk(response, data, 'Payment failed');
          autopayChargedAmount = totalAmount;
          partnerIdsForAutopay.forEach((id) =>
            queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] }),
          );
        } else {
          const response = await csrfFetch('/api/payments-provider/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId: cardIdForAutopay,
              amount: selfDueToday,
              bowlerId: chargeForBowlerId,
              leagueId: league.id,
              storeCard: false,
              ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
            }),
          });
          const responseData = await response.json();
          await throwApiErrorIfNotOk(response, responseData, 'Payment failed');
          autopayChargedAmount = selfDueToday;
        }

        paymentCardId = cardIdForAutopay;
        paymentWasCharged = true;
      } else if (cardMode === 'saved' && selectedSavedCardId) {
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        const response = await csrfFetch('/api/payments-provider/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: selectedSavedCardId,
            amount,
            // chargeForBowlerId is the recipient bowler.
            bowlerId: chargeForBowlerId,
            leagueId: league.id,
            storeCard: false,
            ...(trimmedBuyerEmail && !bowler.email ? { buyerEmail: trimmedBuyerEmail } : {}),
          }),
        });
        const responseData = await response.json();
        await throwApiErrorIfNotOk(response, responseData, 'Payment failed');
        paymentCardId = selectedSavedCardId;
        paymentWasCharged = true;
      } else {
        const shouldStore = isAutoPay || storeCard;
        const trimmedBuyerEmail = (buyerEmail ?? '').trim();
        const overrideEmail = trimmedBuyerEmail && !bowler.email ? trimmedBuyerEmail : undefined;
        if (!newCard) throw new Error('Please enter your card details before proceeding.');
        const paymentResult = await createPayment(amount, newCard, chargeForBowlerId, league.id, shouldStore, overrideEmail);
        if (shouldStore) {
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`] });
        }
        if (isAutoPay) {
          paymentCardId = paymentResult.savedCardId || null;
          if (!paymentCardId) {
            throw new Error('Your card could not be saved for auto-pay. Please try again.');
          }
        }
        paymentWasCharged = true;
      }

      if (isAutoPay && paymentCardId) {
        const recurringAmount = weeklyFee;
        const scheduleResponse = await csrfFetch('/api/payment-schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bowlerId: bowler.id,
            leagueId: league.id,
            frequency: selectedSchedule,
            amount: recurringAmount,
            nextPaymentDate: new Date(),
            paymentCardId,
            // combined-autopay. Only sent when
            // the bowler picked at least one accepted partner in the
            // checkbox group. Server validates each id is currently
            // linked & accepted to the schedule owner.
            ...(additionalBowlerIds && additionalBowlerIds.length > 0
              ? { additionalBowlerIds }
              : {}),
          }),
        });
        if (!scheduleResponse.ok) {
          const scheduleData = await scheduleResponse.json();
          throw new Error(scheduleData.error?.message || 'Failed to set up payment schedule');
        }
        queryClient.invalidateQueries({ queryKey: [`/api/payment-schedules/${bowler.id}/${league.id}`] });
      }

      if (isAutoPay) {
        const cadence = scheduleLabel(selectedSchedule);
        const chargedToday = autopayChargedAmount > 0 ? autopayChargedAmount : amount;
        toast({
          title: "Auto-Pay Activated",
          description: paymentWasCharged
            ? `Paid ${formatCurrency(chargedToday)} today and ${cadence} auto-pay is now active for future weeks.`
            : `Your card has been saved and ${cadence} auto-pay is now active.`,
        });
      } else {
        toast({
          title: "Payment Successful",
          description: `Your payment of ${formatCurrency(amount)} has been processed.`,
        });
      }

      setShowPaymentSetup(false);
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
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
    card, cardMode, selectedSavedCardId, league, bowler, weeklyFee,
    selectedSchedule, storeCard,
    buyerEmail, chargeForBowlerId, additionalBowlerIds, financials, calculateTotalAmount, toast, navigate,
    setIsSubmitting, setShowPaymentSetup, partnerPastDueByBowlerId,
  ]);
}
