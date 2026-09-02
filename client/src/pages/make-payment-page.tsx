import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import type { ApiResponse, BowlerDetailsResponse, League, SavedCard, User } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { BowlerLayout } from "@/components/bowler-layout";
import { LeagueSwitcherSheet } from "@/components/league-switcher-sheet";
import { BowlerOneTimePaymentCard } from "@/components/bowler-one-time-payment-card";
import { StandingAutopayCard } from "@/components/standing-autopay-card";
import { PageLoadingState } from "@/components/page-states";
import { ErrorBoundary } from "@/components/error-boundary";
import { useSelectedLeague } from "@/hooks/use-selected-league";
import { useSquarePayment } from "@/hooks/use-square-payment";
import { usePaymentProvider } from "@/hooks/use-payment-provider";
import { useWalletPayments } from "@/hooks/use-wallet-payments";
import { useSavedCardDefault } from "@/hooks/use-saved-card-default";
import { buildOneTimePaymentOptions } from "./payment-history-page/one-time-payment-options";
import { csrfFetch, queryClient } from "@/lib/queryClient";
import { tokenizeCard } from "@/lib/square";
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { isProviderNotConfiguredError, providerNotConfiguredToast, makeApiError } from "@/lib/provider-not-configured";
import { assertRosterPaymentSucceeded, beginPaymentIntent, clearPaymentIntent, isTerminalRosterPaymentFailure, paymentRequestHeaders, paymentRequestWithRecovery } from "@/lib/payment-request-identity";
import { paymentHistoryFinancialQueryKey, invalidatePaymentHistoryFinancials } from "@/lib/payment-history-financial-query";
import { resolveInteractiveFinancialRead } from "@/lib/financial-read-contract";

type EditorMode = "one-time" | "autopay" | null;

/** Keep the in-memory wallet identity in step with the durable intent. */
export function clearWalletRequestKeyForTerminalStatus(
  status: unknown,
  requestKeyRef: { current: string | null },
): void {
  if (isTerminalRosterPaymentFailure(status)) requestKeyRef.current = null;
}

export function clampPaymentWeekCount(value: number, maximum: number): number {
  if (maximum <= 0) return 1;
  return Math.min(Math.max(1, value), maximum);
}

export function hasPositivePaymentEvidence(rows: Array<{
  allocatedMinor: number;
  outstandingMinor: number;
  state: string;
  reviewRequired: boolean;
}>): boolean {
  const hasConfirmedAllocation = rows.some((row) =>
    row.allocatedMinor > 0 && row.state !== "voided" && !row.reviewRequired,
  );
  const hasUnresolvedReview = rows.some((row) =>
    row.state !== "voided" && row.reviewRequired && row.outstandingMinor > 0,
  );
  return hasConfirmedAllocation && !hasUnresolvedReview;
}

function invalidatePaymentViews(leagueId: number, bowlerId: number): void {
  void queryClient.invalidateQueries({ queryKey: paymentHistoryFinancialQueryKey(leagueId, bowlerId) });
  void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`, bowlerId] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/payments", { bowlerId, leagueId }] });
  void queryClient.invalidateQueries({ queryKey: ["/api/payments", bowlerId] });
  void queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${bowlerId}/details`] });
}

export default function MakePaymentPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const urlLeagueId = params.get("leagueId");
  const intent = params.get("intent");
  const [selectedLeagueId, setSelectedLeagueId] = useSelectedLeague(urlLeagueId ? Number(urlLeagueId) : undefined);
  const [leagueSheetOpen, setLeagueSheetOpen] = useState(false);
  const [canonicalReportPage] = useState(1);
  const [oneTimePaymentWeekCount, setOneTimePaymentWeekCount] = useState(1);
  const [cardMode, setCardMode] = useState<"new" | "saved">("new");
  const [selectedSavedCardId, setSelectedSavedCardId] = useState("");
  const [storeCard, setStoreCard] = useState(false);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWalletProcessing, setIsWalletProcessing] = useState(false);
  const [cardEditorMode, setCardEditorMode] = useState<EditorMode>(null);
  const walletRequestKeyRef = useRef<string | null>(null);
  const intentAppliedRef = useRef(false);

  const { data: currentUser, isLoading: loadingUser, error: userError } = useQuery<ApiResponse<User>>({ queryKey: ["/api/user"] });
  const bowlerId = currentUser?.data?.bowlerId;
  const { data: detailsResponse, isLoading: loadingDetails, error: detailsError } = useQuery<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`, { includePayments: true }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/bowlers/${bowlerId}/details?includePayments=true`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error?.message || "Failed to fetch bowler details");
      return response.json();
    },
    enabled: !!bowlerId,
  });
  const details = detailsResponse?.data;
  const bowlerLeagues = useMemo(() => details?.bowlerLeagues ?? [], [details?.bowlerLeagues]);
  useEffect(() => {
    if (!bowlerLeagues.length) return;
    const validIds = bowlerLeagues.map((membership) => membership.leagueId);
    if (selectedLeagueId !== null && !validIds.includes(selectedLeagueId)) setSelectedLeagueId(validIds[0]);
  }, [bowlerLeagues, selectedLeagueId, setSelectedLeagueId]);
  const leagueId = selectedLeagueId ?? bowlerLeagues[0]?.leagueId;
  const leagueMap = useMemo(() => new Map((details?.leagues ?? []).map((league) => [league.id, league])), [details?.leagues]);
  const league = leagueId === undefined ? undefined : leagueMap.get(leagueId);
  const hasMultipleLeagues = bowlerLeagues.length > 1;

  const { data: financialResponse, isLoading: loadingFinancial, error: financialError } = useQuery<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: paymentHistoryFinancialQueryKey(leagueId ?? 0, bowlerId ?? 0),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/canonical-due-past-due/2?bowlerId=${bowlerId}`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error("Financial evidence is unavailable");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 30_000,
    retry: false,
  });
  const { data: savedCardsResponse } = useQuery<ApiResponse<SavedCard[]>>({
    queryKey: [`/api/payments-provider/cards/${bowlerId}`, leagueId],
    queryFn: async () => {
      const response = await csrfFetch(`/api/payments-provider/cards/${bowlerId}?leagueId=${leagueId}`);
      if (!response.ok) throw new Error("Failed to fetch saved cards");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const savedCards = savedCardsResponse?.data ?? [];
  useSavedCardDefault({ firstSavedCardId: savedCards[0]?.id ?? null, setCardMode, setSelectedSavedCardId, dependencyKey: String(leagueId ?? "") });
  const resolvedFinancial = useMemo(() => resolveInteractiveFinancialRead(financialResponse?.data), [financialResponse?.data]);
  const rows = useMemo(() => resolvedFinancial.status === "canonical" ? resolvedFinancial.rows : [], [resolvedFinancial]);
  const remainingBalance = resolvedFinancial.remainingBalance;
  const amountPastDue = resolvedFinancial.amountPastDue;
  const options = useMemo(() => buildOneTimePaymentOptions(rows, remainingBalance), [rows, remainingBalance]);
  const maximumWeekCount = options.length;
  const fullBalanceOnly = league?.paymentMode === "upfront";
  const clampedWeekCount = clampPaymentWeekCount(oneTimePaymentWeekCount, maximumWeekCount);
  const selectedOption = fullBalanceOnly ? options.at(-1) : options.find((option) => option.weekCount === clampedWeekCount);
  const paymentAmountMinor = selectedOption?.amountMinor ?? 0;
  const bowlerEmail = details?.bowler?.email ?? "";

  useEffect(() => {
    if (fullBalanceOnly && maximumWeekCount > 0) setOneTimePaymentWeekCount(maximumWeekCount);
  }, [fullBalanceOnly, maximumWeekCount]);
  useEffect(() => {
    setOneTimePaymentWeekCount((current) => {
      const next = clampPaymentWeekCount(current, maximumWeekCount);
      return next === current ? current : next;
    });
  }, [maximumWeekCount]);
  useEffect(() => {
    if (intent !== "past-due" || intentAppliedRef.current || amountPastDue <= 0 || options.length === 0) return;
    const suggested = options.find((option) => option.amountMinor >= amountPastDue);
    setOneTimePaymentWeekCount(suggested?.weekCount ?? options.length);
    intentAppliedRef.current = true;
  }, [amountPastDue, intent, options]);
  useEffect(() => { setCardEditorMode(savedCards.length === 0 ? "one-time" : null); }, [savedCards.length]);

  const { card, isInitialized, initializeCard, cleanupCard } = useSquarePayment({
    locationId: league?.locationId,
    onError: (error) => toast({ title: "Payment Setup Error", description: error, variant: "destructive" }),
  });
  const { supportsWallets } = usePaymentProvider(league?.locationId ?? null);
  const previousLeagueIdRef = useRef<number | undefined>(leagueId);
  useEffect(() => {
    if (previousLeagueIdRef.current !== undefined && previousLeagueIdRef.current !== leagueId) {
      cleanupCard();
      walletRequestKeyRef.current = null;
      setCardEditorMode(savedCards.length === 0 ? "one-time" : null);
    }
    previousLeagueIdRef.current = leagueId;
  }, [leagueId, savedCards.length, cleanupCard]);
  const selectEditorMode = useCallback((mode: EditorMode) => {
    if (mode !== cardEditorMode) cleanupCard();
    setCardEditorMode(mode);
  }, [cardEditorMode, cleanupCard]);

  const handleWalletPayment = useCallback(async (token: string, walletType: "apple_pay" | "google_pay") => {
    if (!bowlerId || !leagueId || !league || resolvedFinancial.status === "unavailable" || paymentAmountMinor <= 0) return;
    if (!bowlerEmail && !receiptEmail.trim()) { toast({ title: "Email required", description: "Enter an email for the receipt before paying with a wallet.", variant: "destructive" }); return; }
    const overrideEmail = !bowlerEmail && receiptEmail.trim() ? receiptEmail.trim() : undefined;
    try {
      setIsWalletProcessing(true);
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-quote/2`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountMinor: paymentAmountMinor, payerBowlerId: bowlerId }) });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw new Error(quoteBody.error?.message || "Payment allocation is unavailable.");
      const scope = `make-payment-wallet:${league.id}:${bowlerId}:${paymentAmountMinor}`;
      const requestKey = walletRequestKeyRef.current ?? beginPaymentIntent(scope);
      walletRequestKeyRef.current = requestKey;
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-charge/2`, { method: "POST", headers: { ...paymentRequestHeaders(requestKey), "Content-Type": "application/json" }, body: JSON.stringify({ amountMinor: paymentAmountMinor, payerBowlerId: quoteBody.data.payerBowlerId ?? bowlerId, sourceId: token, sourceKind: "wallet", buyerEmail: (overrideEmail ?? bowlerEmail) || null, storeCard: false, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }) }), league.id);
      const body = await response.json().catch(() => ({}));
      const status = body.data?.status ?? body.status;
      clearWalletRequestKeyForTerminalStatus(status, walletRequestKeyRef);
      if (!response.ok) throw makeApiError(body, response.status, "Wallet payment failed.");
      assertRosterPaymentSucceeded(status);
      clearPaymentIntent(scope);
      walletRequestKeyRef.current = null;
      cleanupCard();
      setCardEditorMode(null);
      toast({ title: "Payment Successful", description: `${walletType === "apple_pay" ? "Apple Pay" : "Google Pay"} payment completed.` });
      await invalidatePaymentHistoryFinancials(queryClient, leagueId, bowlerId);
      invalidatePaymentViews(leagueId, bowlerId);
    } catch (error) { logger.error("Wallet Payment", "Payment failed", error); toast(isProviderNotConfiguredError(error) ? providerNotConfiguredToast({ navigate, locationId: league.locationId }) : { title: "Payment Failed", description: error instanceof Error ? error.message : "Unable to process payment.", variant: "destructive" }); }
    finally { setIsWalletProcessing(false); }
  }, [bowlerId, leagueId, league, resolvedFinancial.status, paymentAmountMinor, bowlerEmail, receiptEmail, toast, navigate, cleanupCard]);
  const beginWalletPayment = useCallback(() => { if (leagueId && bowlerId && paymentAmountMinor > 0) walletRequestKeyRef.current = beginPaymentIntent(`make-payment-wallet:${leagueId}:${bowlerId}:${paymentAmountMinor}`); }, [leagueId, bowlerId, paymentAmountMinor]);
  const wallet = useWalletPayments({ locationId: league?.locationId, amountCents: paymentAmountMinor, enabled: !!league?.locationId && paymentAmountMinor > 0 && supportsWallets, onPaymentStarted: beginWalletPayment, onTokenReceived: handleWalletPayment, onError: (error) => toast({ title: "Wallet Payment Error", description: error, variant: "destructive" }) });
  const cleanupWallet = wallet.cleanup;
  useEffect(() => () => cleanupWallet(), [cleanupWallet]);

  const submitOneTimePayment = async () => {
    if (!bowlerId || !leagueId || !league || resolvedFinancial.status === "unavailable" || financialError || paymentAmountMinor <= 0) { toast({ title: "Payment unavailable", description: "Exact payment obligations are unavailable. Refresh and try again.", variant: "destructive" }); return; }
    if (cardMode === "new" && (!card || !isInitialized)) { toast({ title: "Card details required", description: "Enter your card details before paying.", variant: "destructive" }); return; }
    if (cardMode === "saved" && !selectedSavedCardId) { toast({ title: "Card required", description: "Select a saved card before paying.", variant: "destructive" }); return; }
    if (!bowlerEmail && !receiptEmail.trim()) { toast({ title: "Email required", description: "Enter an email for the receipt before paying.", variant: "destructive" }); return; }
    try {
      setIsSubmitting(true);
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-quote/2`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountMinor: paymentAmountMinor, payerBowlerId: bowlerId }) });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint || !Number.isSafeInteger(quoteBody.data?.amountMinor)) throw new Error(quoteBody.error?.message || "Exact payment obligations are unavailable.");
      const cardToTokenize = card;
      if (cardMode === "new" && !cardToTokenize) throw new Error("A payment source is required.");
      const sourceId = cardMode === "saved" ? selectedSavedCardId : await tokenizeCard(cardToTokenize);
      const scope = `make-payment-roster:${league.id}:${bowlerId}:${paymentAmountMinor}:${quoteBody.data.fingerprint}:${cardMode}`;
      const requestKey = beginPaymentIntent(scope);
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-obligation-charge/2`, { method: "POST", headers: { ...paymentRequestHeaders(requestKey), "Content-Type": "application/json" }, body: JSON.stringify({ amountMinor: paymentAmountMinor, payerBowlerId: quoteBody.data.payerBowlerId ?? bowlerId, sourceId, sourceKind: cardMode === "saved" ? "saved_card" : "new_card", buyerEmail: bowlerEmail || receiptEmail.trim() || null, storeCard: cardMode === "new" ? storeCard : false, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }) }), league.id);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw makeApiError(body, response.status, "Payment failed");
      assertRosterPaymentSucceeded(body.data?.status ?? body.status);
      clearPaymentIntent(scope);
      cleanupCard();
      setCardEditorMode(null);
      toast({ title: "Payment Successful", description: `${formatCurrency(paymentAmountMinor)} has been paid.` });
      await invalidatePaymentHistoryFinancials(queryClient, leagueId, bowlerId);
      invalidatePaymentViews(leagueId, bowlerId);
      if (storeCard && cardMode === "new") void queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
    } catch (error) { logger.error("Payment", "Payment failed", error); toast(isProviderNotConfiguredError(error) ? providerNotConfiguredToast({ navigate, locationId: league.locationId }) : { title: "Payment Failed", description: error instanceof Error ? error.message : "Unable to process payment. Please try again.", variant: "destructive" }); }
    finally { setIsSubmitting(false); }
  };

  if (loadingUser || loadingDetails || loadingFinancial) return <PageLoadingState />;
  if (userError) return <PageLoadingState message="Authentication required" />;
  if (currentUser?.data && !currentUser.data.bowlerId) return <PageLoadingState message="A bowler profile is required to make a payment" />;
  if (detailsError || financialError || !league || leagueId === undefined || !bowlerId) return <PageLoadingState message="Payment information is unavailable" />;

  const isPaidInFull = remainingBalance <= 0 && hasPositivePaymentEvidence(rows);
  return <BowlerLayout bowlerName={details?.bowler?.name ?? ""} leagueName={league.name} currentLeagueId={leagueId}>
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">Make a Payment</h1>
        {hasMultipleLeagues ? <button type="button" onClick={() => setLeagueSheetOpen(true)} className="flex items-center gap-1 text-slate-500 hover:text-slate-700 transition-colors">{league.name}<span aria-hidden="true">⌄</span></button> : <p className="text-muted-foreground">{league.name}</p>}
      </div>
      <ErrorBoundary level="section">
        {isPaidInFull ? <div className="rounded-lg border border-green-500/50 bg-green-500/5 p-6 text-center"><h2 className="text-lg font-semibold text-green-700">Season Paid in Full</h2><p className="mt-1 text-sm text-muted-foreground">There is no remaining one-time balance.</p></div> : <BowlerOneTimePaymentCard
          remainingBalance={remainingBalance}
          paymentWeekCount={clampedWeekCount}
          maximumWeekCount={Math.max(1, maximumWeekCount)}
          paymentAmountMinor={paymentAmountMinor}
          fullBalanceOnly={fullBalanceOnly}
          savedCards={savedCards}
          cardMode={cardMode}
          setCardMode={setCardMode}
          selectedSavedCardId={selectedSavedCardId}
          setSelectedSavedCardId={setSelectedSavedCardId}
          storeCard={storeCard}
          setStoreCard={setStoreCard}
          isInitialized={isInitialized && cardEditorMode === "one-time"}
          isSubmitting={isSubmitting}
          onSubmit={() => void submitOneTimePayment()}
          onPaymentWeekCountChange={(value) => { walletRequestKeyRef.current = null; setOneTimePaymentWeekCount(value); }}
          initializeCard={initializeCard}
          cleanupCard={cleanupCard}
          onCardEditorModeChange={selectEditorMode}
          cardEditorMode={cardEditorMode}
          applePayAvailable={wallet.applePayAvailable}
          googlePayAvailable={wallet.googlePayAvailable}
          applePayTokenizeOnly={wallet.applePayTokenizeOnly}
          googlePayTokenizeOnly={wallet.googlePayTokenizeOnly}
          applePayRef={wallet.applePayRef}
          googlePayRef={wallet.googlePayRef}
          onApplePayClick={wallet.handleApplePayClick}
          onGooglePayClick={wallet.handleGooglePayClick}
          isWalletProcessing={wallet.isProcessing || isWalletProcessing}
          bowlerHasEmail={!!bowlerEmail}
          receiptEmail={receiptEmail}
          onReceiptEmailChange={setReceiptEmail}
        />}
      </ErrorBoundary>
      <ErrorBoundary level="section"><StandingAutopayCard league={league} bowlerId={bowlerId} savedCards={savedCards} bowlerHasEmail={!!bowlerEmail} card={card} isInitialized={isInitialized && cardEditorMode === "autopay"} cardEditorMode={cardEditorMode} initializeCard={initializeCard} cleanupCard={cleanupCard} onCardEditorModeChange={selectEditorMode} /></ErrorBoundary>
    </div>
    <LeagueSwitcherSheet open={leagueSheetOpen} onClose={() => setLeagueSheetOpen(false)} bowlerLeagues={bowlerLeagues} leagueMap={leagueMap} selectedLeagueId={leagueId} onSelect={(nextId) => { setSelectedLeagueId(nextId); intentAppliedRef.current = false; navigate(`/make-payment?leagueId=${nextId}`); }} />
  </BowlerLayout>;
}
