import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { League, Payment, User, SavedCard, ApiResponse, BowlerDetailsResponse } from "@shared/schema";
import type { CanonicalPaymentReport, CanonicalPaymentRow } from "@shared/canonical-payment-report";
import type { FinancialReadContract } from "@shared/financial-contract";
import { BowlerLayout } from "@/components/bowler-layout";
import { PageLoadingState } from "@/components/page-states";
import { useSearch, useLocation as useWouterLocation } from "wouter";
import { useSquarePayment } from "@/hooks/use-square-payment";
import { usePaymentProvider } from "@/hooks/use-payment-provider";
import { useWalletPayments } from "@/hooks/use-wallet-payments";
import { useSavedCardDefault } from "@/hooks/use-saved-card-default";
import { createPayment } from "@/lib/square";
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { queryClient, csrfFetch } from '@/lib/queryClient';
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
  makeApiError,
} from "@/lib/provider-not-configured";
import { calculateFinancials } from "@/lib/financial-utils";
import { formatCurrency } from "@/lib/utils";
import { useSelectedLeague } from "@/hooks/use-selected-league";
import { AuthErrorView } from "./payment-history-page/auth-error-view";
import { NoBowlerView } from "./payment-history-page/no-bowler-view";
import { BowlerErrorView } from "./payment-history-page/bowler-error-view";
import { NoLeaguesView } from "./payment-history-page/no-leagues-view";
import { NoLeagueView } from "./payment-history-page/no-league-view";
import { PaymentHistoryContent } from "./payment-history-page/payment-history-content";
import { beginPaymentIntent, clearPaymentIntent, paymentRequestHeaders, paymentRequestWithRecovery } from "@/lib/payment-request-identity";
import { buildInteractiveOccurrenceFields, interactiveIntentScopeSuffix } from "@/lib/interactive-payment-request";
import { resolveInteractiveFinancialRead } from "@/lib/financial-read-contract";
import { invalidatePaymentHistoryFinancials, paymentHistoryFinancialQueryKey } from "@/lib/payment-history-financial-query";
import { invalidateF3AfterInteractivePayment } from "@/lib/f3-autopay";
import type { InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";

export default function PaymentHistoryPage() {
  const { toast } = useToast();
  const [, navigate] = useWouterLocation();
  const search = useSearch();
  const urlLeagueId = new URLSearchParams(search).get('leagueId');
  const [selectedLeagueId, setSelectedLeagueId] = useSelectedLeague(
    urlLeagueId ? Number(urlLeagueId) : undefined
  );
  const [leagueSheetOpen, setLeagueSheetOpen] = useState(false);
  const [payDialogType, setPayDialogType] = useState<'pastdue' | 'remaining' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cardMode, setCardMode] = useState<'new' | 'saved'>('new');
  const [selectedSavedCardId, setSelectedSavedCardId] = useState<string>('');
  const [storeCard, setStoreCard] = useState(false);
  const [receiptEmail, setReceiptEmail] = useState('');
  const [occurrenceAllocations, setOccurrenceAllocations] = useState<{ obligationId: string; amountMinor: number }[]>([]);
  const [occurrenceQuoteFingerprint, setOccurrenceQuoteFingerprint] = useState<string | undefined>();
  const [occurrenceReadiness, setOccurrenceReadiness] = useState<InteractiveOccurrenceReadiness>('loading');
  const [canonicalReportPage, setCanonicalReportPage] = useState(1);
  const walletRequestKeyRef = useRef<string | null>(null);

  const [isWalletProcessing, setIsWalletProcessing] = useState(false);

  const { data: currentUser, isLoading: loadingUser, error: userError } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
  });

  const bowlerId = currentUser?.data?.bowlerId;

  const { data: savedCardsResponse } = useQuery<ApiResponse<SavedCard[]>>({
    queryKey: [`/api/payments-provider/cards/${bowlerId}`, selectedLeagueId],
    queryFn: async () => {
      const params = selectedLeagueId ? `?leagueId=${selectedLeagueId}` : '';
      const res = await csrfFetch(`/api/payments-provider/cards/${bowlerId}${params}`);
      if (!res.ok) throw new Error('Failed to fetch saved cards');
      return res.json();
    },
    enabled: !!bowlerId,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
  const savedCards = savedCardsResponse?.data || [];
  const firstSavedCardId = savedCards.length > 0 ? savedCards[0].id : null;

  // Default the card picker to the bowler's first saved card once the
  // saved-cards query resolves. Shared with the admin checkout + bowler
  // setup flows.
  useSavedCardDefault({
    firstSavedCardId,
    setCardMode,
    setSelectedSavedCardId,
  });

  const { data: bowlerDetailsResponse, isLoading: loadingBowlerDetails, error: bowlerError } = useQuery<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`, { includePayments: true }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/bowlers/${bowlerId}/details?includePayments=true`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || "Failed to fetch bowler details");
      }
      return response.json();
    },
    enabled: !!bowlerId,
  });

  const bowlerLeagues = useMemo(() => bowlerDetailsResponse?.data?.bowlerLeagues ?? [], [bowlerDetailsResponse?.data?.bowlerLeagues]);
  const hasMultipleLeagues = bowlerLeagues.length > 1;

  useEffect(() => {
    if (!bowlerLeagues.length) return;
    const validIds = bowlerLeagues.map(bl => bl.leagueId);
    if (selectedLeagueId !== null && !validIds.includes(selectedLeagueId)) {
      setSelectedLeagueId(validIds[0]);
    }
  }, [bowlerLeagues, selectedLeagueId, setSelectedLeagueId]);

  const leagueId = selectedLeagueId ?? bowlerLeagues[0]?.leagueId;

  const detailsLeagues = useMemo(() => bowlerDetailsResponse?.data?.leagues || [], [bowlerDetailsResponse?.data?.leagues]);

  const leagueMap = useMemo(() => {
    const map = new Map<number, League>();
    for (const l of detailsLeagues) map.set(l.id, l);
    return map;
  }, [detailsLeagues]);

  const detailsLoaded = !!bowlerDetailsResponse?.data;
  const allPaymentsFromDetails = bowlerDetailsResponse?.data?.payments;
  const hasPaymentsFromDetails = Array.isArray(allPaymentsFromDetails);

  const { data: paymentsResponse, isLoading: loadingPayments } = useQuery<ApiResponse<Payment[]>>({
    queryKey: ["/api/payments", { bowlerId, leagueId }],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("bowlerId", String(bowlerId));
      params.set("leagueId", String(leagueId));
      const response = await fetch(`/api/payments?${params.toString()}`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || "Failed to fetch payments");
      }
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId && detailsLoaded && !hasPaymentsFromDetails,
  });

  const { data: canonicalPaymentReportResponse, isLoading: loadingCanonicalPaymentReport, error: canonicalPaymentReportError } = useQuery<ApiResponse<CanonicalPaymentReport>>({
    queryKey: ["/api/financials/f5/payments", { bowlerId, leagueId, page: canonicalReportPage }],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        leagueId: String(leagueId),
        bowlerId: String(bowlerId),
        page: String(canonicalReportPage),
        limit: "200",
      });
      const response = await fetch(`/api/financials/f5/payments?${params.toString()}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Payment evidence requires review");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 30_000,
    retry: false,
  });

  const league = leagueId === undefined ? undefined : leagueMap.get(leagueId);

  const { supportsWallets, isLoading: providerLoading } = usePaymentProvider(league?.locationId ?? null);

  const { card: sqCard, isInitialized: sqInit, initializeCard: sqInitCard, cleanupCard: sqCleanup } = useSquarePayment({
    onError: (error) => {
      logger.error('Square Payment', 'Payment failed', error);
      toast({ title: "Payment Setup Error", description: error, variant: "destructive" });
    }
  });

  const card = sqCard;
  const isInitialized = sqInit;
  const initializeCard = sqInitCard;
  const cleanupCard = sqCleanup;

  useEffect(() => {
    if (!payDialogType) {
      cleanupCard();
      // clear inline receipt-email on dialog close so a
      // stale typed-in address never silently rides on the next
      // checkout attempt.
      setReceiptEmail('');
    }
  }, [payDialogType, cleanupCard]);

  // A live F1 read is the amount authority for activated leagues. Legacy
  // financial-utils remains the exact fallback until this versioned read is
  // available, while selector state is reset whenever the dialog intent or
  // league changes so an old obligation set cannot ride into a new charge.
  const { data: canonicalFinancialResponse, isLoading: loadingFinancialRead, error: financialReadError } = useQuery<ApiResponse<FinancialReadContract>>({
    queryKey: paymentHistoryFinancialQueryKey(leagueId ?? 0, bowlerId ?? 0),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/due-past-due?bowlerId=${bowlerId}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Financial evidence is unavailable");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 30_000,
    retry: false,
  });

  const payments = hasPaymentsFromDetails ? allPaymentsFromDetails : (paymentsResponse?.data || []);
  const bowlerName = bowlerDetailsResponse?.data?.bowler?.name || '';
  const bowlerEmail = bowlerDetailsResponse?.data?.bowler?.email || '';

  const bowlerPayments = payments.filter(p => p.bowlerId === bowlerId && p.leagueId === leagueId);
  const canonicalPaymentReport = canonicalPaymentReportResponse?.data;
  const canonicalPayments = useMemo(() => {
    const rawById = new Map(bowlerPayments.map((payment) => [payment.id, payment]));
    return [...(canonicalPaymentReport?.rows ?? []), ...(canonicalPaymentReport?.unlinkedHistory ?? [])]
      .filter((row) => row.paymentId !== null && row.bowlerId === bowlerId)
      .map((row) => {
        if (row.paymentId !== null) {
          const existing = rawById.get(row.paymentId);
          if (existing) return existing;
        }
        const displayStatus = row.status === "confirmed_paid" ? "paid" : row.status === "disputed" || row.status === "failed" || row.status === "pending" || row.status === "refunded" ? row.status : "pending";
        const synthetic: Payment = { id: row.paymentId ?? 0, bowlerId: row.bowlerId, leagueId: row.leagueId, amount: row.amountMinor, lineageAmount: null, prizeFundAmount: null, weekOf: row.businessDate, status: displayStatus, type: row.paymentType, checkNumber: null, providerPaymentId: null, idempotencyKey: null, squareRefundId: null, refundReason: null, refundedAt: null, disputeId: null, disputedAt: null, receiptUrl: null, receiptNumber: null, receiptEmailMissing: true, notes: null, paidByUserId: null, combinedChargeGroupId: null, paymentOperationId: null, paymentOperationAllocationIndex: null, createdAt: row.businessDate };
        return synthetic;
      });
  }, [bowlerPayments, canonicalPaymentReport, bowlerId]);
  const paymentBusinessDates = new Map<number, string>();
  const paymentEvidenceStatuses = new Map<number, CanonicalPaymentRow["status"]>();
  for (const row of [...(canonicalPaymentReport?.rows ?? []), ...(canonicalPaymentReport?.unlinkedHistory ?? [])]) {
    if (row.paymentId !== null) {
      paymentBusinessDates.set(row.paymentId, row.authoritativeLocalDate);
      paymentEvidenceStatuses.set(row.paymentId, row.status);
    }
  }

  const resolvedFinancialRead = resolveInteractiveFinancialRead(canonicalFinancialResponse?.data);
  const legacyFinancials = resolvedFinancialRead.status === "legacy_fallback"
    ? calculateFinancials(league, bowlerPayments)
    : null;
  const canonicalRows = resolvedFinancialRead.status === "canonical" ? resolvedFinancialRead.rows : [];
  const financials = legacyFinancials ?? {
    weeksPassed: canonicalRows.filter((row) => row.classification !== "future").length,
    totalWeeksInSeason: canonicalRows.length,
    totalDueToDate: canonicalRows.filter((row) => row.classification !== "future").reduce((sum, row) => sum + row.amountMinor, 0),
    totalPaid: canonicalRows.reduce((sum, row) => sum + row.allocatedMinor, 0),
    amountPastDue: resolvedFinancialRead.amountPastDue,
    fullSeasonAmount: canonicalRows.reduce((sum, row) => sum + row.amountMinor, 0),
    remainingBalance: resolvedFinancialRead.remainingBalance,
    doublePay: { dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: resolvedFinancialRead.remainingBalance <= 0 },
  };
  const {
    weeksPassed: weeksDue,
    totalWeeksInSeason,
    totalDueToDate: totalSeasonDues,
    totalPaid: totalPaidAmount,
    amountPastDue,
    fullSeasonAmount,
    remainingBalance,
    doublePay,
  } = financials;
  const displayAmountPastDue = resolvedFinancialRead.amountPastDue;
  const displayRemainingBalance = resolvedFinancialRead.remainingBalance;
  const weeksDueCount = league?.weeklyFee ? Math.round(totalSeasonDues / league.weeklyFee) : 0;
  const weeksPaid = league?.weeklyFee ? Math.round(totalPaidAmount / league.weeklyFee) : 0;

  const dialogAmountCents = payDialogType === 'pastdue' ? displayAmountPastDue : displayRemainingBalance;

  const handleWalletPayment = useCallback(async (token: string, walletType: 'apple_pay' | 'google_pay') => {
    if (resolvedFinancialRead.status === "unavailable" || loadingFinancialRead || financialReadError) return;
    if (occurrenceReadiness !== 'legacy' && occurrenceReadiness !== 'ready') return;
    if (!bowlerId || !leagueId || !dialogAmountCents) return;
    // same inline email override as the card-form path so
    // Apple Pay / Google Pay charges also trigger Square's hosted
    // receipt when no email is on file for the bowler. Mirrors the
    // server's BUYER_EMAIL_REQUIRED so the wallet sheet doesn't
    // launch into an avoidable 400.
    const trimmedReceiptEmail = receiptEmail.trim();
    // Square requires a buyer email for hosted receipts.
    if (!bowlerEmail && !trimmedReceiptEmail) {
      toast({
        title: 'Email required',
        description: 'Enter an email for the receipt before paying with Apple Pay / Google Pay.',
        variant: 'destructive',
      });
      return;
    }
    const overrideEmail = !bowlerEmail && trimmedReceiptEmail ? trimmedReceiptEmail : undefined;
    try {
      setIsWalletProcessing(true);
      const paymentScope = `history-wallet:${bowlerId}:${leagueId}:${dialogAmountCents}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
      const requestKey = walletRequestKeyRef.current ?? beginPaymentIntent(paymentScope);
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/payments', {
        method: 'POST',
        headers: paymentRequestHeaders(requestKey),
        body: JSON.stringify({
          sourceId: token,
          amount: dialogAmountCents,
          bowlerId,
          leagueId,
          storeCard: false,
          sourceKind: 'wallet',
          ...(overrideEmail ? { buyerEmail: overrideEmail } : {}),
          ...buildInteractiveOccurrenceFields(occurrenceAllocations, occurrenceQuoteFingerprint),
        }),
      }), league?.organizationId);
      const data = await response.json();
      if (!response.ok) {
        throw makeApiError(data, response.status, `Payment failed (HTTP ${response.status})`);
      }
      if (data.status !== 'COMPLETED') {
        throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
      }
      clearPaymentIntent(paymentScope);
      walletRequestKeyRef.current = null;
      const walletLabel = walletType === 'apple_pay' ? 'Apple Pay' : 'Google Pay';
      const dialogLabel = payDialogType === 'pastdue' ? 'past due amount' : 'remaining balance';
      if (data.deduplicated) {
        toast({ title: "Already Processed", description: `This ${walletLabel} payment was already recorded.` });
      } else {
        toast({ title: "Payment Successful", description: `${walletLabel} payment of ${formatCurrency(dialogAmountCents)} ${dialogLabel} completed.` });
      }
      await invalidatePaymentHistoryFinancials(queryClient, leagueId, bowlerId);
      setPayDialogType(null);
      queryClient.invalidateQueries({ queryKey: ["/api/payments", { bowlerId, leagueId }] });
      await invalidateF3AfterInteractivePayment(queryClient, leagueId, league?.organizationId);
      queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${bowlerId}/details`] });
      queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
    } catch (error) {
      logger.error('Wallet Payment', 'Payment failed', error);
      if (isProviderNotConfiguredError(error)) {
        toast(providerNotConfiguredToast({
          navigate,
          locationId: league?.locationId ?? null,
        }));
      } else {
        toast({ title: "Payment Failed", description: error instanceof Error ? error.message : "Unable to process payment.", variant: "destructive" });
      }
    } finally {
      setIsWalletProcessing(false);
    }
  }, [bowlerId, leagueId, dialogAmountCents, payDialogType, toast, bowlerEmail, receiptEmail, navigate, league?.locationId, league?.organizationId, occurrenceAllocations, occurrenceQuoteFingerprint, occurrenceReadiness, resolvedFinancialRead.status, loadingFinancialRead, financialReadError]);

  const beginWalletPayment = useCallback(() => {
    if (resolvedFinancialRead.status === "unavailable" || loadingFinancialRead || financialReadError) return;
    if (occurrenceReadiness !== 'legacy' && occurrenceReadiness !== 'ready') return;
    if (!bowlerId || !leagueId || !dialogAmountCents) return;
    walletRequestKeyRef.current = beginPaymentIntent(
      `history-wallet:${bowlerId}:${leagueId}:${dialogAmountCents}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`,
    );
  }, [bowlerId, dialogAmountCents, leagueId, occurrenceAllocations, occurrenceQuoteFingerprint, occurrenceReadiness, resolvedFinancialRead.status, loadingFinancialRead, financialReadError]);

  const {
    applePayAvailable,
    googlePayAvailable,
    applePayTokenizeOnly,
    googlePayTokenizeOnly,
    applePayRef,
    googlePayRef,
    handleApplePayClick,
    handleGooglePayClick,
    isProcessing: isWalletBusy,
    cleanup: cleanupWallet,
  } = useWalletPayments({
    locationId: league?.locationId,
    amountCents: dialogAmountCents,
    enabled: !!payDialogType && !!league?.locationId && supportsWallets
      && (occurrenceReadiness === 'ready' || occurrenceReadiness === 'legacy'),
    onPaymentStarted: beginWalletPayment,
    onTokenReceived: handleWalletPayment,
    onError: (error) => toast({ title: "Wallet Payment Error", description: error, variant: "destructive" }),
  });

  useEffect(() => {
    if (!payDialogType) {
      cleanupWallet();
    }
  }, [payDialogType, cleanupWallet]);

  const handleDialogPayment = async () => {
    if (resolvedFinancialRead.status === "unavailable" || loadingFinancialRead || financialReadError) {
      toast({ title: "Payment unavailable", description: "Financial evidence is still loading or requires review.", variant: "destructive" });
      return;
    }
    if (occurrenceReadiness !== 'legacy' && occurrenceReadiness !== 'ready') {
      toast({ title: "Payment unavailable", description: occurrenceReadiness === 'error'
        ? "Current obligations could not be loaded. Refresh before paying."
        : "Select obligations totaling the payment amount before paying.", variant: "destructive" });
      return;
    }
    const dialogAmount = dialogAmountCents;
    const dialogLabel = payDialogType === 'pastdue' ? 'past due amount' : 'remaining balance';

    if (!bowlerId || !leagueId || !dialogAmount) {
      toast({ title: "Error", description: "Missing payment information.", variant: "destructive" });
      return;
    }

    if (cardMode === 'new' && !card) {
      toast({ title: "Error", description: "Please enter your card details.", variant: "destructive" });
      return;
    }

    if (cardMode === 'saved' && !selectedSavedCardId) {
      toast({ title: "Error", description: "Please select a saved card.", variant: "destructive" });
      return;
    }

    try {
      setIsSubmitting(true);

      // when no email is on file, the bowler can supply
      // one inline so Square's hosted receipt fires for this charge.
      const trimmedReceiptEmail = receiptEmail.trim();
      const overrideEmail = !bowlerEmail && trimmedReceiptEmail ? trimmedReceiptEmail : undefined;

      if (cardMode === 'saved' && selectedSavedCardId) {
        const paymentScope = `history:${bowlerId}:${leagueId}:${dialogAmount}:saved${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
        const requestKey = beginPaymentIntent(paymentScope);
          const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch('/api/payments-provider/payments', {
          method: 'POST',
          headers: paymentRequestHeaders(requestKey),
          body: JSON.stringify({
            sourceId: selectedSavedCardId,
            amount: dialogAmount,
            bowlerId,
            leagueId,
            storeCard: false,
            sourceKind: 'saved_card',
            ...(overrideEmail ? { buyerEmail: overrideEmail } : {}),
            ...buildInteractiveOccurrenceFields(occurrenceAllocations, occurrenceQuoteFingerprint),
          }),
          }), league?.organizationId);
        const responseData = await response.json();
        if (!response.ok) {
          throw makeApiError(responseData, response.status, 'Payment failed');
        }
        if (responseData.status !== 'COMPLETED') {
          throw new Error('Your payment is still processing. Use payment recovery before entering card details again.');
        }
        clearPaymentIntent(paymentScope);
      } else {
        const paymentScope = `history:${bowlerId}:${leagueId}:${dialogAmount}:new:${storeCard}${interactiveIntentScopeSuffix(occurrenceAllocations, occurrenceQuoteFingerprint)}`;
        const requestKey = beginPaymentIntent(paymentScope);
        if (!card) throw new Error('Please enter your card details.');
        await createPayment(dialogAmount, card, bowlerId, leagueId, storeCard, overrideEmail, requestKey, occurrenceAllocations, occurrenceQuoteFingerprint);
        clearPaymentIntent(paymentScope);
        if (storeCard) {
          queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
        }
      }

      toast({ title: "Payment Successful", description: `${formatCurrency(dialogAmount)} ${dialogLabel} has been paid.` });
      await invalidatePaymentHistoryFinancials(queryClient, leagueId, bowlerId);
      setPayDialogType(null);
      queryClient.invalidateQueries({ queryKey: ["/api/payments", { bowlerId, leagueId }] });
      await invalidateF3AfterInteractivePayment(queryClient, leagueId, league?.organizationId);
      queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${bowlerId}/details`] });
    } catch (error) {
      logger.error('Payment', 'Payment failed', error);
      if (isProviderNotConfiguredError(error)) {
        toast(providerNotConfiguredToast({
          navigate,
          locationId: league?.locationId ?? null,
        }));
      } else {
        toast({ title: "Payment Failed", description: error instanceof Error ? error.message : "Unable to process payment. Please try again.", variant: "destructive" });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOccurrenceChange = useCallback((next: { obligationId: string; amountMinor: number }[], fingerprint?: string) => {
    setOccurrenceAllocations(next);
    setOccurrenceQuoteFingerprint(fingerprint);
  }, []);

  useEffect(() => {
    setOccurrenceAllocations([]);
    setOccurrenceQuoteFingerprint(undefined);
    setOccurrenceReadiness(payDialogType ? 'loading' : 'disabled');
  }, [payDialogType, leagueId]);

  const checkoutAvailable = resolvedFinancialRead.status !== "unavailable" && !loadingFinancialRead && !financialReadError;

  if (loadingUser || loadingBowlerDetails || loadingCanonicalPaymentReport || (!hasPaymentsFromDetails && loadingPayments)) {
    return (
      <BowlerLayout bowlerName={bowlerName || 'Loading...'} leagueName={league?.name || 'Loading...'}>
        <PageLoadingState />
      </BowlerLayout>
    );
  }

  if (userError) {
    return <AuthErrorView />;
  }

  if (currentUser?.data && !currentUser.data.bowlerId) {
    return (
      <NoBowlerView
        userName={currentUser.data.name}
        isSystemAdmin={currentUser.data.role === 'system_admin'}
      />
    );
  }

  if (bowlerId && bowlerError) {
    return <BowlerErrorView />;
  }

  if (canonicalPaymentReportError) {
    return <BowlerLayout bowlerName={bowlerName} leagueName={league?.name || 'Payment history'}><p className="p-6 text-destructive">Payment evidence requires review; no canonical history is shown.</p></BowlerLayout>;
  }

  if (!bowlerDetailsResponse?.data?.bowlerLeagues?.length) {
    return <NoLeaguesView bowlerName={bowlerName} />;
  }

  if (!league) {
    return (
      <NoLeagueView
        bowlerName={bowlerName}
        bowlerId={bowlerId}
        leagueId={leagueId}
      />
    );
  }

  return (
    <PaymentHistoryContent
      bowlerName={bowlerName}
      bowlerId={bowlerId ?? 0}
      league={league}
      leagueId={leagueId}
      hasMultipleLeagues={hasMultipleLeagues}
      leagueSheetOpen={leagueSheetOpen}
      onOpenLeagueSheet={() => setLeagueSheetOpen(true)}
      onCloseLeagueSheet={() => setLeagueSheetOpen(false)}
      bowlerLeagues={bowlerLeagues}
      leagueMap={leagueMap}
      onSelectLeague={(nextLeagueId) => { setSelectedLeagueId(nextLeagueId); setCanonicalReportPage(1); }}
      totalWeeksInSeason={totalWeeksInSeason}
      fullSeasonAmount={fullSeasonAmount}
      weeksDueCount={weeksDueCount}
      totalSeasonDues={totalSeasonDues}
      weeksPaid={weeksPaid}
      totalPaidAmount={totalPaidAmount}
      amountPastDue={displayAmountPastDue}
      remainingBalance={displayRemainingBalance}
      doublePay={doublePay}
      onPayPastDue={() => checkoutAvailable && setPayDialogType('pastdue')}
      onPayRemaining={() => checkoutAvailable && setPayDialogType('remaining')}
      payDialogType={payDialogType}
      onCloseDialog={() => setPayDialogType(null)}
      savedCards={savedCards}
      cardMode={cardMode}
      setCardMode={setCardMode}
      selectedSavedCardId={selectedSavedCardId}
      setSelectedSavedCardId={setSelectedSavedCardId}
      storeCard={storeCard}
      setStoreCard={setStoreCard}
      isInitialized={isInitialized}
      isSubmitting={isSubmitting}
      onSubmit={handleDialogPayment}
      initializeCard={initializeCard}
      cleanupCard={cleanupCard}
      applePayAvailable={applePayAvailable}
      googlePayAvailable={googlePayAvailable}
      applePayTokenizeOnly={applePayTokenizeOnly}
      googlePayTokenizeOnly={googlePayTokenizeOnly}
      applePayRef={applePayRef}
      googlePayRef={googlePayRef}
      onApplePayClick={handleApplePayClick}
      onGooglePayClick={handleGooglePayClick}
      isWalletProcessing={isWalletBusy || isWalletProcessing}
      bowlerHasEmail={!!bowlerEmail}
      receiptEmail={receiptEmail}
      onReceiptEmailChange={setReceiptEmail}
      bowlerPayments={bowlerPayments}
      canonicalPayments={canonicalPayments}
      canonicalPaymentLoading={loadingCanonicalPaymentReport}
      canonicalPaymentError={canonicalPaymentReportError}
      canonicalReportPage={canonicalReportPage}
      canonicalReportTotalPages={canonicalPaymentReport ? Math.max(1, Math.ceil(canonicalPaymentReport.totalRows / canonicalPaymentReport.limit)) : undefined}
      onCanonicalReportPageChange={setCanonicalReportPage}
      paymentBusinessDates={paymentBusinessDates}
      paymentEvidenceStatuses={paymentEvidenceStatuses}
      occurrenceAmountMinor={checkoutAvailable ? dialogAmountCents : 0}
      occurrenceAllocations={occurrenceAllocations}
      occurrenceQuoteFingerprint={occurrenceQuoteFingerprint}
      onOccurrenceChange={handleOccurrenceChange}
      onOccurrenceReadinessChange={setOccurrenceReadiness}
      occurrenceReadiness={occurrenceReadiness}
    />
  );
}
