import { FC, useRef, useEffect, useState, useMemo, useCallback } from "react";
import { useSquarePayment } from "@/hooks/use-square-payment";
import { usePaymentProvider } from "@/hooks/use-payment-provider";
import { useWalletPayments } from "@/hooks/use-wallet-payments";
import { useSavedCardDefault } from "@/hooks/use-saved-card-default";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueries } from "@tanstack/react-query";
import { csrfFetch, queryClient } from '@/lib/queryClient';
import { logger } from "@/lib/logger";
import { calculateFinancials } from "@/lib/financial-utils";
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import type { League, Bowler, Payment, SavedCard, ApiResponse, BowlerDetailsResponse } from "@shared/schema";
import { PaymentStatusView } from "@/components/payment-status-view";
import { useBowlerPaymentSubmit } from "@/hooks/use-bowler-payment-submit";
import type { AutopaySetupQuote } from "@/lib/autopay-setup";

interface BowlerLinkRow {
  id: number;
  status: "pending" | "accepted";
  partnerBowlerId: number;
  partnerName: string;
}

interface BowlerLinksPayload {
  links: BowlerLinkRow[];
  hasAny: boolean;
}

type PaymentSchedule = "weekly" | "custom";

interface ScheduleData {
  id: number;
  frequency: string;
  nextPaymentDate: string;
  amount: number;
  active: boolean;
  leagueTimezone?: string;
}

interface PaymentStatusSectionProps {
  league: League;
  bowler: Bowler;
  weeklyFee: number;
  totalWeeks: number;
  payments: Payment[];
}

export const PaymentStatusSection: FC<PaymentStatusSectionProps> = ({
  league,
  bowler,
  weeklyFee,
  totalWeeks,
  payments,
}) => {
  const { toast } = useToast();
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const [showPaymentSetup, setShowPaymentSetup] = useState(false);
  const [paymentMode, setPaymentMode] = useState<'autopay' | 'onetime'>('autopay');
  const [selectedSchedule, setSelectedSchedule] = useState<PaymentSchedule>("weekly");
  const [storeCard, setStoreCard] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedWeeks, setSelectedWeeks] = useState<number>(1);
  const [fixedAmount, setFixedAmount] = useState<number | null>(null);
  const [fixedAmountType, setFixedAmountType] = useState<'remaining' | 'pastDue' | null>(null);
  const [cardMode, setCardMode] = useState<'new' | 'saved'>('new');
  const [selectedSavedCardId, setSelectedSavedCardId] = useState<string>('');
  // selected payment recipient for partner-pay.
  // Defaults to self; the picker (rendered below in PaymentSetupForm)
  // lets the bowler swap to a linked partner. Reset whenever the form
  // opens so a stale partner choice never silently rides into a new
  // checkout.
  const [targetBowlerId, setTargetBowlerId] = useState<number>(bowler.id);
  // combined-autopay recipients. The
  // PaymentSetupForm renders a checkbox group when paymentMode ===
  // 'autopay' AND there are accepted partners; selected ids are POSTed
  // as `additionalBowlerIds` on /api/payment-schedules. Reset whenever
  // the form closes or paymentMode flips so a stale combined-autopay
  // pick can never silently ride into the next checkout.
  const [additionalBowlerIds, setAdditionalBowlerIds] = useState<number[]>([]);
  const quotePartnerKey = useMemo(
    () => [...additionalBowlerIds].sort((left, right) => left - right).join(','),
    [additionalBowlerIds],
  );

  const {
    data: autopayQuoteResponse,
    isLoading: autopayQuoteLoading,
    error: autopayQuoteError,
  } = useQuery<ApiResponse<AutopaySetupQuote>>({
    queryKey: ['/api/payment-schedules/setup-quote', bowler.id, league.id, quotePartnerKey],
    queryFn: async () => {
      const query = quotePartnerKey
        ? `?additionalBowlerIds=${encodeURIComponent(quotePartnerKey)}`
        : '';
      const response = await csrfFetch(
        `/api/payment-schedules/setup-quote/${bowler.id}/${league.id}${query}`,
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || 'Unable to calculate automatic payment dates.');
      }
      return body;
    },
    enabled: showPaymentSetup && paymentMode === 'autopay' && selectedSchedule === 'weekly',
    staleTime: 0,
    retry: false,
  });
  const autopayQuote = autopayQuoteResponse?.data;

  const { supportsWallets, isLoading: providerLoading } = usePaymentProvider(league.locationId ?? null);

  const { card: sqCard, isInitialized: sqInit, error: sqError, initializeCard: sqInitCard, cleanupCard: sqCleanup } = useSquarePayment({
    locationId: league.locationId ?? null,
    onError: (error) => {
      logger.error('Square Payment', 'Payment failed', error);
      toast({ title: "Payment Setup Error", description: error, variant: "destructive" });
    }
  });

  const card = sqCard;
  const isInitialized = sqInit;
  const squareError = sqError;
  const initializeCard = sqInitCard;
  const cleanupCard = sqCleanup;

  // pull accepted partner links so the
  // recipient picker in PaymentSetupForm can offer them as targets.
  // Org-scoping + accept-status filtering happen server-side; we
  // additionally filter to status==='accepted' here as defense in depth.
  const { data: linksResponse } = useQuery<ApiResponse<BowlerLinksPayload>>({
    queryKey: ["/api/bowler-links"],
    enabled: !!bowler.id,
    staleTime: 30_000,
  });
  // All accepted partners regardless of league. Drives the per-partner
  // details fetch below so the eligibility filter has each partner's
  // `bowlerLeagues` to consult.
  const acceptedPartners = useMemo(() => {
    const all = linksResponse?.data?.links ?? [];
    return all.flatMap((l) =>
      l.status === "accepted" ? [{ id: l.partnerBowlerId, name: l.partnerName }] : []
    );
  }, [linksResponse]);

  // Task #715: per-partner past-due in this league. The combined
  // weekly auto-pay setup must clear every included bowler's past-due
  // balance up front, so we fetch each accepted partner's payments,
  // filter to this league, and reuse the same `calculateBowlerPastDue`
  // helper the server uses to enforce the rule. The same response
  // payload (`bowlerLeagues`) also feeds the Task #725 enrollment
  // filter just below — one fetch covers both.
  const partnerDetailsQueries = useQueries({
    queries: acceptedPartners.map((p) => ({
      queryKey: [`/api/bowlers/${p.id}/details`, { includePayments: true }],
      queryFn: async (): Promise<ApiResponse<BowlerDetailsResponse>> => {
        const res = await csrfFetch(`/api/bowlers/${p.id}/details?includePayments=true`);
        if (!res.ok) throw new Error('Failed to fetch partner details');
        return res.json();
      },
      enabled: !!p.id,
      staleTime: 30_000,
      retry: false,
    })),
  });

  // Task #725: scope partner options to the current league. A linked
  // partner should only surface as a payment recipient / combined-pay
  // row on leagues they are *also* enrolled in. While a partner's
  // details query is still in flight we treat them as not-yet-eligible
  // (rather than optimistically showing them and yanking them once the
  // fetch resolves) so the picker doesn't flicker.
  const partnerOptions = useMemo(() => {
    return acceptedPartners.filter((p, idx) => {
      const data = partnerDetailsQueries[idx]?.data?.data;
      if (!data) return false;
      return (data.bowlerLeagues ?? []).some(
        (bl) => bl.leagueId === league.id && bl.active,
      );
    });
  }, [acceptedPartners, partnerDetailsQueries, league.id]);

  const { data: savedCardsResponse } = useQuery<{ success: boolean; data: SavedCard[] }>({
    queryKey: [`/api/payments-provider/cards/${bowler.id}`, league.id],
    queryFn: async () => {
      const res = await csrfFetch(`/api/payments-provider/cards/${bowler.id}?leagueId=${league.id}`);
      if (!res.ok) throw new Error('Failed to fetch saved cards');
      return res.json();
    },
    enabled: !!bowler.id,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
  const savedCards = savedCardsResponse?.data || [];
  const firstSavedCardId = savedCards.length > 0 ? savedCards[0].id : null;

  // Default the card picker to the bowler's first saved card once the
  // saved-cards query resolves (and back to "new" if the set empties).
  // Shared with the admin checkout + quick-pay flows.
  useSavedCardDefault({
    firstSavedCardId,
    setCardMode,
    setSelectedSavedCardId,
  });

  useEffect(() => {
    if (showPaymentSetup && cardContainerRef.current && cardMode === 'new' && !providerLoading) {
      initializeCard(cardContainerRef.current);
    }
  }, [showPaymentSetup, cardContainerRef, initializeCard, cardMode, providerLoading]);

  useEffect(() => {
    if (!showPaymentSetup) {
      cleanupCard();
    }
  }, [showPaymentSetup, cleanupCard]);

  // Recipient (self vs partner) and combined-pay selections are reset
  // when the form is opened (see `onSetupPayment` below) rather than via
  // close/open effects, so a stale partner choice never silently rides
  // into a new checkout. paymentMode only ever changes at open time (the
  // PaymentOverviewCard that triggers it is rendered only while the form
  // is closed), so resetting at open also covers the old "switching into
  // autopay resets to self" case. The reconcile effect just below keeps
  // these selections valid against the eligible-partner set while open.

  // Task #725: reconcile recipient + combined-pay selections to the
  // currently-eligible partner set. When the user navigates between
  // leagues (or a partner-details fetch resolves and reveals the
  // partner is not enrolled here) any previously-picked partner that
  // is no longer eligible must be dropped so a stale id never rides
  // into checkout. Recipient resets to self; combined-pay drops the
  // ineligible id(s) and keeps the rest.
  useEffect(() => {
    const eligibleIds = new Set(partnerOptions.map((p) => p.id));
    if (targetBowlerId !== bowler.id && !eligibleIds.has(targetBowlerId)) {
      setTargetBowlerId(bowler.id);
    }
    setAdditionalBowlerIds((prev) => {
      const next = prev.filter((id) => eligibleIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [partnerOptions, bowler.id, targetBowlerId]);

  const bowlerPayments = useMemo(() => {
    return (payments || []).filter(p => p.bowlerId === bowler.id && p.leagueId === league.id);
  }, [payments, bowler.id, league.id]);

  const financials = useMemo(() => {
    return calculateFinancials(league, bowlerPayments);
  }, [league, bowlerPayments]);

  const maxPayableWeeks = useMemo(() => {
    return Math.max(1, Math.floor(financials.remainingBalance / weeklyFee));
  }, [financials.remainingBalance, weeklyFee]);

  const handleWeekChangeWrapper = useCallback((weeks: number) => {
    const validWeeks = Math.min(Math.max(1, weeks), maxPayableWeeks);
    setSelectedWeeks(validWeeks);
    setFixedAmount(null);
    setFixedAmountType(null);
  }, [maxPayableWeeks]);

  const calculateTotalAmount = useCallback(() => {
    if (league.paymentMode === 'upfront') {
      // An upfront league normally charges the full season in one payment.
      // A legacy partial payment must settle only the remaining balance or
      // the server correctly rejects the charge as an overpayment.
      return additionalBowlerIds.length > 0
        ? financials.fullSeasonAmount
        : financials.remainingBalance;
    }
    if (selectedSchedule === 'custom') {
      return fixedAmount !== null ? fixedAmount : weeklyFee * selectedWeeks;
    }
    return weeklyFee;
  }, [league.paymentMode, financials.fullSeasonAmount, financials.remainingBalance, additionalBowlerIds.length, selectedSchedule, weeklyFee, selectedWeeks, fixedAmount]);

  const handleWalletPayment = useCallback(async (token: string, walletType: 'apple_pay' | 'google_pay') => {
    try {
      setIsSubmitting(true);
      const perAmount = calculateTotalAmount();
      // Task #706: when combined-pay partners are selected, route the
      // wallet token through the combined-payments endpoint so ONE
      // provider charge writes N+1 per-bowler rows sharing a
      // `combinedChargeGroupId`. Otherwise fall through to the legacy
      // single-bowler payments endpoint.
      const isCombined = additionalBowlerIds.length > 0;
      const totalPayees = 1 + additionalBowlerIds.length;
      const totalAmount = perAmount * totalPayees;
      const response = isCombined
        ? await csrfFetch('/api/payments-provider/combined-payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId: token,
              amount: totalAmount,
              leagueId: league.id,
              storeCard: true,
              payees: [
                { bowlerId: bowler.id, amount: perAmount },
                ...additionalBowlerIds.map((id) => ({ bowlerId: id, amount: perAmount })),
              ],
            }),
          })
        : await csrfFetch('/api/payments-provider/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceId: token,
              amount: perAmount,
              bowlerId: targetBowlerId,
              leagueId: league.id,
              storeCard: true,
            }),
          });
      const amount = isCombined ? totalAmount : perAmount;
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || data.message || `Payment failed (HTTP ${response.status})`);
      }
      if (data.status && data.status !== 'COMPLETED') {
        throw new Error(`Payment not completed (status: ${data.status})`);
      }
      const walletLabel = walletType === 'apple_pay' ? 'Apple Pay' : 'Google Pay';
      if (data.deduplicated) {
        toast({ title: "Already Processed", description: `This ${walletLabel} payment was already recorded.` });
      } else {
        toast({ title: "Payment Successful", description: `${walletLabel} payment of $${(amount / 100).toFixed(2)} completed. Your card has been saved for future payments.` });
      }
      queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
      queryClient.invalidateQueries({ queryKey: [`/api/payment-schedules/${bowler.id}/${league.id}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowler.id}`, league.id] });
      // when paying for a partner, refresh THEIR bowler-details
      // cache so the recipient's payment-history surfaces pick up the new
      // "Paid by …" attribution immediately.
      if (targetBowlerId !== bowler.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${targetBowlerId}/details`] });
      }
      // Task #706: combined-pay writes a row against EVERY included
      // partner — refresh each partner's details so all of their
      // payment-history surfaces pick up the new "Paid by …" rows.
      if (isCombined) {
        for (const id of additionalBowlerIds) {
          queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${id}/details`] });
        }
      }
      setShowPaymentSetup(false);
    } catch (err: unknown) {
      // task #514: route the wallet-payment failure path through the
      // same sanitizer so a JSON-shaped or multi-line message never
      // makes it into the toast, even if a future backend change
      // forgets the typed PaymentProviderError contract.
      const message = sanitizePaymentErrorMessage(err, 'Payment could not be processed');
      toast({ title: "Payment Failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  }, [bowler.id, league.id, targetBowlerId, additionalBowlerIds, calculateTotalAmount, toast, setIsSubmitting, setShowPaymentSetup]);

  const {
    applePayAvailable,
    googlePayAvailable,
    applePayRef,
    googlePayRef,
    handleApplePayClick,
    handleGooglePayClick,
    isProcessing: isWalletProcessing,
    cleanup: cleanupWallet,
    applePayTokenizeOnly,
    googlePayTokenizeOnly,
  } = useWalletPayments({
    locationId: league.locationId ?? null,
    // Wallet sheet must authorize the full combined total when partners
    // are selected so the device-sheet amount matches the server charge.
    amountCents: calculateTotalAmount() * (1 + additionalBowlerIds.length),
    enabled: showPaymentSetup && supportsWallets && (selectedSchedule === 'custom' || league.paymentMode === 'upfront'),
    onTokenReceived: handleWalletPayment,
    // task #514: route the wallet hook's `onError` string through the
    // shared sanitizer for parity with the other payment-failure
    // toast paths — defends against any future provider/SDK string
    // (JSON-shaped, multi-line, or oversized) leaking into the toast.
    onError: (error) =>
      toast({
        title: "Wallet Payment Error",
        description: sanitizePaymentErrorMessage(error, "Wallet payment could not be processed."),
        variant: "destructive",
      }),
  });

  useEffect(() => {
    if (!showPaymentSetup) {
      cleanupWallet();
    }
  }, [showPaymentSetup, cleanupWallet]);

  const handleSubmitPayment = useBowlerPaymentSubmit({
    league,
    bowler,
    weeklyFee,
    card,
    cardMode,
    selectedSavedCardId,
    selectedSchedule,
    storeCard,
    targetBowlerId,
    additionalBowlerIds,
    autopayQuote,
    financials,
    calculateTotalAmount,
    setIsSubmitting,
    setShowPaymentSetup,
  });

  const seasonPresets = useMemo(() => {
    const seasonStarted = league.seasonStart && new Date(league.seasonStart) < new Date();
    const halfSeasonAmount = weeklyFee * Math.ceil(totalWeeks / 2);
    const hideFullSeason = financials.totalPaid > 0 && seasonStarted;
    const hideHalfSeason = financials.totalPaid >= halfSeasonAmount && seasonStarted;
    const presets: { label: string; weeks: number }[] = [];
    if (!hideHalfSeason) {
      presets.push({ label: "Half Season", weeks: Math.ceil(totalWeeks / 2) });
    }
    if (!hideFullSeason) {
      presets.push({ label: "Full Season", weeks: totalWeeks });
    }
    return presets;
  }, [totalWeeks, weeklyFee, financials.totalPaid, league.seasonStart]);

  const { data: scheduleResponse } = useQuery<{ success: boolean; data: ScheduleData | null }>({
    queryKey: [`/api/payment-schedules/${bowler.id}/${league.id}`],
    enabled: !!bowler.id && !!league.id,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
  const activeSchedule = scheduleResponse?.success ? scheduleResponse.data ?? undefined : undefined;

  return (
    <PaymentStatusView
      showPaymentSetup={showPaymentSetup}
      league={league}
      bowler={bowler}
      weeklyFee={weeklyFee}
      totalWeeks={totalWeeks}
      paymentMode={paymentMode}
      selectedSchedule={selectedSchedule}
      selectedWeeks={selectedWeeks}
      maxPayableWeeks={maxPayableWeeks}
      fixedAmount={fixedAmount}
      fixedAmountType={fixedAmountType}
      financials={financials}
      seasonPresets={seasonPresets}
      savedCards={savedCards}
      cardMode={cardMode}
      selectedSavedCardId={selectedSavedCardId}
      cardContainerRef={cardContainerRef}
      isInitialized={isInitialized}
      squareError={squareError}
      storeCard={storeCard}
      isSubmitting={isSubmitting}
      onWeekChange={handleWeekChangeWrapper}
      onFixedAmount={(amount, type) => {
        setFixedAmount(amount);
        setFixedAmountType(type);
        if (type === 'pastDue' && amount !== null) {
          setSelectedWeeks(Math.max(1, Math.round(amount / weeklyFee)));
        } else if (type === 'remaining') {
          setSelectedWeeks(maxPayableWeeks);
        }
      }}
      setCardMode={setCardMode}
      setSelectedSavedCardId={setSelectedSavedCardId}
      setStoreCard={setStoreCard}
      cleanupCard={cleanupCard}
      calculateTotalAmount={calculateTotalAmount}
      onSubmit={handleSubmitPayment}
      onCancel={() => {
        setShowPaymentSetup(false);
      }}
      applePayAvailable={applePayAvailable}
      googlePayAvailable={googlePayAvailable}
      applePayRef={applePayRef}
      googlePayRef={googlePayRef}
      onApplePayClick={handleApplePayClick}
      onGooglePayClick={handleGooglePayClick}
      isWalletProcessing={isWalletProcessing}
      applePayTokenizeOnly={applePayTokenizeOnly}
      googlePayTokenizeOnly={googlePayTokenizeOnly}
      partnerOptions={partnerOptions}
      targetBowlerId={targetBowlerId}
      setTargetBowlerId={setTargetBowlerId}
      additionalBowlerIds={additionalBowlerIds}
      setAdditionalBowlerIds={setAdditionalBowlerIds}
      autopayQuote={autopayQuote}
      autopayQuoteLoading={autopayQuoteLoading}
      autopayQuoteError={autopayQuoteError instanceof Error ? autopayQuoteError.message : null}
      activeSchedule={activeSchedule}
      onSetupPayment={(mode) => {
        setPaymentMode(mode);
        if (mode === 'autopay') {
          setSelectedSchedule('weekly');
        } else {
          setSelectedSchedule('custom');
        }
        // Reset recipient + combined-pay picks on open so a stale choice
        // from a prior session never rides into the new checkout. (These
        // used to be cleared by close/open effects.)
        setTargetBowlerId(bowler.id);
        setAdditionalBowlerIds([]);
        setShowPaymentSetup(true);
      }}
    />
  );
};
