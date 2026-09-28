/* eslint-disable shadcn/no-restyle, shadcn/no-unknown-classes */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, CreditCard, Loader2, Minus, Plus, RotateCcw, Wallet } from "lucide-react";
import type { League, SavedCard } from "@shared/schema";
import type {
  RotatingCreditBalanceWire,
  RotatingCreditOperationWire,
  RotatingCreditQuoteWire,
} from "@shared/rotating-credit-contract";
import { usePaymentProvider } from "@/hooks/use-payment-provider";
import { useSquarePayment } from "@/hooks/use-square-payment";
import { useWalletPayments } from "@/hooks/use-wallet-payments";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { csrfFetch, queryClient } from "@/lib/queryClient";
import { beginPaymentIntent, clearPaymentIntent, getPaymentIntent, paymentRequestHeaders } from "@/lib/payment-request-identity";
import { makeApiError } from "@/lib/provider-not-configured";
import { tokenizeCard } from "@/lib/square";
import { formatCurrency } from "@/lib/utils";

function formatPayCurrency(amountMinor: number): string {
  const formatted = formatCurrency(amountMinor);
  return amountMinor % 100 === 0 ? formatted.replace(/\.00$/, "") : formatted;
}

type ApiResponse<T> = { success: boolean; data: T; error?: { message: string; code?: string } };
type CreditIntent = { scope: string; requestKey: string; shareCount: number; quoteFingerprint: string };

interface RotatingShareCreditCardProps {
  league: Pick<League, "id" | "locationId">;
  bowlerId: number | undefined;
  bowlerEmail: string;
  savedCards: SavedCard[];
}

const MAX_SHARE_COUNT = 52;
const RECOVERY_PENDING_STATUSES = new Set<RotatingCreditOperationWire["status"]>([
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "reconciliation_required",
  "action_required",
]);
const TERMINAL_STATUSES = new Set<RotatingCreditOperationWire["status"]>(["failed_terminal", "canceled"]);

function rotatingCreditIntentScope(leagueId: number, bowlerId: number): string {
  return `rotating-credit:${leagueId}:${bowlerId}`;
}

function operationMessage(operation: RotatingCreditOperationWire): string {
  switch (operation.status) {
    case "pending":
    case "leased":
    case "retry_scheduled":
      return "Your payment is still being confirmed. Check its status before starting another payment.";
    case "provider_unknown":
      return "The payment provider has not confirmed this payment yet. Check its status before trying another card.";
    case "reconciliation_required":
      return "This payment needs reconciliation. Your balance is not available while it is being reviewed.";
    case "action_required":
      if (operation.confirmedNoChargeDecline) {
        return "The card was declined and no payment was completed. You can request a new quote and try another payment source.";
      }
      return "This payment needs further review. Check its status again; if the status persists, contact league staff. Your balance is not available yet.";
    case "failed_terminal":
      return "The payment was not completed. You can request a new quote and try again.";
    case "canceled":
      return "The payment was canceled. You can request a new quote and try again.";
    case "succeeded":
      return "Your payment balance has been updated.";
  }
}

function operationIsTerminal(operation: RotatingCreditOperationWire): boolean {
  return TERMINAL_STATUSES.has(operation.status)
    || (operation.status === "action_required" && operation.confirmedNoChargeDecline);
}

function operationIsUnresolved(operation: RotatingCreditOperationWire): boolean {
  return RECOVERY_PENDING_STATUSES.has(operation.status) && !operationIsTerminal(operation);
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function RotatingShareCreditCard({ league, bowlerId, bowlerEmail, savedCards }: RotatingShareCreditCardProps) {
  const { toast } = useToast();
  const { isLoading: providerLoading, isProviderConfigured, supportsWallets, error: providerError } = usePaymentProvider(league.locationId ?? null);
  const cardContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingIntentRef = useRef<CreditIntent | null>(null);
  const walletIntentRef = useRef<CreditIntent | null>(null);
  const startupRecoveryScopeRef = useRef<string | null>(null);
  const startupRecoveryStartedRef = useRef(false);
  const currentQuoteRef = useRef<RotatingCreditQuoteWire | null>(null);
  const [shareCount, setShareCount] = useState(1);
  const [cardMode, setCardMode] = useState<"new" | "saved">(savedCards.length > 0 ? "saved" : "new");
  const [sourceOpen, setSourceOpen] = useState(savedCards.length === 0);
  const previousSavedCardCountRef = useRef(savedCards.length);
  const [selectedSavedCardId, setSelectedSavedCardId] = useState(savedCards[0]?.id ?? "");
  const [receiptEmail, setReceiptEmail] = useState(bowlerEmail);
  const [isCharging, setIsCharging] = useState(false);
  const [pendingRequestKey, setPendingRequestKey] = useState<string | null>(null);
  const [operation, setOperation] = useState<RotatingCreditOperationWire | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const { card, isInitialized, initializeCard, cleanupCard, error: cardError } = useSquarePayment({
    locationId: league.locationId ?? null,
    onError: (message) => toast({ title: "Card unavailable", description: message, variant: "destructive" }),
  });
  const creditPath = `/api/financials/leagues/${league.id}/rotating-credit/1`;
  const scope = bowlerId ? rotatingCreditIntentScope(league.id, bowlerId) : null;

  const balanceQuery = useQuery<ApiResponse<RotatingCreditBalanceWire>>({
    queryKey: [creditPath],
    enabled: bowlerId !== undefined && Number.isSafeInteger(bowlerId) && bowlerId > 0,
    retry: false,
  });
  const balance = balanceQuery.data?.data;
  const canBuyCredit = balance?.eligibleForCredit === true && balance.shareAmountMinor !== null && balance.shareAmountMinor > 0;
  const hasCreditHistory = balance !== undefined && (
    balance.fundedMinor > 0
    || balance.availableMinor > 0
    || balance.appliedMinor > 0
    || balance.refundedMinor > 0
    || balance.refundHeldMinor > 0
    || balance.reviewHeldMinor > 0
    || balance.lots.length > 0
    || balance.applications.length > 0
  );
  const profileEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bowlerEmail);
  const buyerEmail = profileEmailValid ? bowlerEmail : receiptEmail.trim();
  const buyerEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail);
  const quoteQuery = useQuery<ApiResponse<RotatingCreditQuoteWire>>({
    queryKey: [`/api/financials/leagues/${league.id}/rotating-credit/quote/1`, shareCount],
    queryFn: async ({ signal }) => {
      const response = await csrfFetch(`/api/financials/leagues/${league.id}/rotating-credit/quote/1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ shareCount }),
        signal,
      });
      const body = await response.json().catch(() => ({})) as ApiResponse<RotatingCreditQuoteWire>;
      if (!response.ok) throw makeApiError(body, response.status, "Payment price could not be confirmed.");
      if (!body.success || !body.data) throw new Error(body.error?.message ?? "Payment price could not be confirmed.");
      return body;
    },
    enabled: canBuyCredit && shareCount >= 1 && shareCount <= MAX_SHARE_COUNT,
    retry: false,
    staleTime: 0,
  });
  const quote = quoteQuery.data?.data;
  currentQuoteRef.current = quote ?? null;
  const quoteIsCurrent = quote?.shareCount === shareCount && quote.leagueId === league.id && quote.bowlerId === bowlerId;
  const intentIsUnresolved = operation !== null && operationIsUnresolved(operation);
  const hasActiveRequest = pendingRequestKey !== null || intentIsUnresolved || isCheckingStatus;
  const savedCard = savedCards.find((candidate) => candidate.id === selectedSavedCardId);
  const selectedSourceReady = cardMode === "saved" ? !!savedCard : isInitialized;

  useEffect(() => {
    if (savedCards.length === 0) setSourceOpen(true);
    if (previousSavedCardCountRef.current === 0 && savedCards.length > 0) setSourceOpen(false);
    previousSavedCardCountRef.current = savedCards.length;
  }, [savedCards.length]);

  const recoverIntent = useCallback(async (requestKey: string, exactScope: string): Promise<RotatingCreditOperationWire | null> => {
    setIsCheckingStatus(true);
    setRecoveryMessage(null);
    try {
      const response = await csrfFetch(`/api/financials/leagues/${league.id}/rotating-credit/operations/recover-by-request-key/1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ idempotencyKey: requestKey }),
      });
      if (response.status === 404) {
        clearPaymentIntent(exactScope, requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
        setOperation(null);
        setRecoveryMessage("No payment operation was found for this saved request.");
        return null;
      }
      const body = await response.json().catch(() => ({})) as ApiResponse<RotatingCreditOperationWire>;
      if (!response.ok) throw makeApiError(body, response.status, "Payment status could not be confirmed.");
      if (!body.success || !body.data) throw new Error(body.error?.message ?? "Payment status could not be confirmed.");
      const result = body.data;
      setOperation(result);
      if (result.status === "succeeded") {
        clearPaymentIntent(exactScope, requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
        await queryClient.invalidateQueries({ queryKey: [creditPath] });
        toast({ title: "Payment balance updated", description: operationMessage(result) });
      } else if (operationIsTerminal(result)) {
        clearPaymentIntent(exactScope, requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
        setRecoveryMessage(operationMessage(result));
      }
      return result;
    } catch (error) {
      setRecoveryMessage(readErrorMessage(error, "Payment status could not be confirmed."));
      return null;
    } finally {
      setIsCheckingStatus(false);
    }
  }, [creditPath, league.id, toast]);

  useEffect(() => {
    if (!scope || startupRecoveryScopeRef.current === scope) return;
    startupRecoveryScopeRef.current = scope;
    let existingKey: string | null;
    try {
      existingKey = getPaymentIntent(scope);
    } catch (error) {
      setRecoveryMessage(readErrorMessage(error, "Saved payment status could not be checked."));
      return;
    }
    if (!existingKey) return;
    setPendingRequestKey(existingKey);
    const intentShareCount = shareCount;
    const existingQuoteFingerprint = currentQuoteRef.current?.fingerprint;
    if (!existingQuoteFingerprint) {
      pendingIntentRef.current = { scope, requestKey: existingKey, shareCount: intentShareCount, quoteFingerprint: "" };
      void recoverIntent(existingKey, scope);
      return;
    }
    pendingIntentRef.current = { scope, requestKey: existingKey, shareCount: intentShareCount, quoteFingerprint: existingQuoteFingerprint };
    void recoverIntent(existingKey, scope);
  }, [scope, shareCount, recoverIntent]);

  useEffect(() => {
    if (!savedCard && cardMode === "saved") setCardMode("new");
  }, [cardMode, savedCard]);

  useEffect(() => {
    const container = cardContainerRef.current;
    if (!canBuyCredit || cardMode !== "new" || !container || providerLoading || !isProviderConfigured || intentIsUnresolved) {
      cleanupCard();
      return;
    }
    void initializeCard(container);
    return () => cleanupCard();
  }, [canBuyCredit, cardMode, providerLoading, isProviderConfigured, intentIsUnresolved, initializeCard, cleanupCard]);

  const applyOperation = useCallback(async (result: RotatingCreditOperationWire, exactIntent: CreditIntent) => {
    setOperation(result);
    if (result.status === "succeeded") {
      clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
      pendingIntentRef.current = null;
      setPendingRequestKey(null);
      await queryClient.invalidateQueries({ queryKey: [creditPath] });
      toast({ title: "Payment complete", description: `${formatPayCurrency(result.fundedMinor)} was added to your available balance.` });
    } else if (operationIsTerminal(result)) {
      clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
      pendingIntentRef.current = null;
      setPendingRequestKey(null);
      setReviewOpen(false);
      setRecoveryMessage(operationMessage(result));
    }
  }, [creditPath, toast]);

  const submitTokenizedSource = useCallback(async (
    sourceId: string,
    sourceKind: "new_card" | "saved_card" | "wallet",
    exactIntent: CreditIntent,
  ) => {
    setIsCharging(true);
    setRecoveryMessage(null);
    try {
      const response = await csrfFetch(`/api/financials/leagues/${league.id}/rotating-credit/charge/1`, {
        method: "POST",
        headers: paymentRequestHeaders(exactIntent.requestKey),
        body: JSON.stringify({
          shareCount: exactIntent.shareCount,
          sourceId,
          sourceKind,
          idempotencyKey: exactIntent.requestKey,
          quoteFingerprint: exactIntent.quoteFingerprint,
          ...(buyerEmail ? { buyerEmail } : {}),
        }),
      });
      const body = await response.json().catch(() => ({})) as ApiResponse<RotatingCreditOperationWire>;
      if (!response.ok) {
        const error = makeApiError(body, response.status, "Payment could not be completed.");
        if (response.status < 500 && response.status !== 409) {
          clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
          pendingIntentRef.current = null;
          setPendingRequestKey(null);
        } else {
          setRecoveryMessage("The purchase request may have reached the provider. Check its status before trying another payment source.");
          await recoverIntent(exactIntent.requestKey, exactIntent.scope);
        }
        throw error;
      }
      if (!body.success || !body.data) throw new Error(body.error?.message ?? "Payment could not be completed.");
      await applyOperation(body.data, exactIntent);
      return body.data;
    } catch (error) {
      if (pendingIntentRef.current?.requestKey === exactIntent.requestKey) {
        setRecoveryMessage("The purchase could not be confirmed. Check its status before starting another purchase.");
      }
      throw error;
    } finally {
      setIsCharging(false);
    }
  }, [applyOperation, buyerEmail, league.id, recoverIntent]);

  const startWalletIntent = useCallback((): boolean => {
    const latestQuote = currentQuoteRef.current;
    if (!scope || !latestQuote || latestQuote.shareCount !== shareCount || !quoteIsCurrent || hasActiveRequest || !buyerEmailValid) return false;
    try {
      const requestKey = beginPaymentIntent(scope);
      const nextIntent = { scope, requestKey, shareCount, quoteFingerprint: latestQuote.fingerprint };
      setOperation(null);
      setRecoveryMessage(null);
      pendingIntentRef.current = nextIntent;
      setPendingRequestKey(requestKey);
      walletIntentRef.current = nextIntent;
      return true;
    } catch (error) {
      toast({ title: "Payment could not start", description: readErrorMessage(error, "Secure payment request setup failed."), variant: "destructive" });
      return false;
    }
  }, [buyerEmailValid, hasActiveRequest, quoteIsCurrent, scope, shareCount, toast]);

  const handleWalletToken = useCallback(async (token: string) => {
    const exactIntent = walletIntentRef.current;
    walletIntentRef.current = null;
    if (!exactIntent) throw new Error("The wallet purchase quote could not be confirmed. Request a new quote.");
    try {
      const result = await submitTokenizedSource(token, "wallet", exactIntent);
      if (result.status !== "succeeded") setRecoveryMessage(operationMessage(result));
    } catch (error) {
      toast({ title: "Payment status unavailable", description: readErrorMessage(error, "Check the payment status before trying again."), variant: "destructive" });
      throw error;
    }
  }, [submitTokenizedSource, toast]);

  const wallet = useWalletPayments({
    locationId: league.locationId ?? null,
    amountCents: quoteIsCurrent ? quote?.amountMinor ?? 0 : 0,
    enabled: canBuyCredit && supportsWallets && quoteIsCurrent && !hasActiveRequest && !quoteQuery.isFetching && buyerEmailValid,
    onPaymentStarted: startWalletIntent,
    onTokenReceived: handleWalletToken,
    onError: (message) => {
      const unusedIntent = walletIntentRef.current;
      walletIntentRef.current = null;
      if (unusedIntent) {
        clearPaymentIntent(unusedIntent.scope, unusedIntent.requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
      }
      toast({ title: "Wallet payment error", description: message, variant: "destructive" });
    },
  });
  const cleanupWallet = wallet.cleanup;
  useEffect(() => () => cleanupWallet(), [cleanupWallet]);

  const submitCard = useCallback(async () => {
    const latestQuote = currentQuoteRef.current;
    if (!scope || !latestQuote || latestQuote.shareCount !== shareCount || !quoteIsCurrent || hasActiveRequest) return;
    let exactIntent: CreditIntent | null = null;
    let chargeAttempted = false;
    try {
      const requestKey = beginPaymentIntent(scope);
      exactIntent = { scope, requestKey, shareCount, quoteFingerprint: latestQuote.fingerprint };
      pendingIntentRef.current = exactIntent;
      setPendingRequestKey(requestKey);
      const sourceId = cardMode === "saved" ? selectedSavedCardId : await tokenizeCard(card);
      if (!sourceId) throw new Error("Select a saved card or enter card details before paying.");
      chargeAttempted = true;
      const result = await submitTokenizedSource(sourceId, cardMode === "saved" ? "saved_card" : "new_card", exactIntent);
      if (result.status !== "succeeded") setRecoveryMessage(operationMessage(result));
    } catch (error) {
      if (exactIntent && !chargeAttempted && pendingIntentRef.current?.requestKey === exactIntent.requestKey) {
        // A tokenization failure happened before a request was submitted.
        clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
      }
      toast({ title: "Payment could not be completed", description: readErrorMessage(error, "Review the payment details and try again."), variant: "destructive" });
    }
  }, [card, cardMode, hasActiveRequest, quoteIsCurrent, scope, selectedSavedCardId, shareCount, submitTokenizedSource, toast]);

  const exactScope = scope;
  const retryStatus = useCallback(async () => {
    if (!exactScope) return;
    let stored: string | null;
    try {
      stored = getPaymentIntent(exactScope);
    } catch (error) {
      setRecoveryMessage(readErrorMessage(error, "Saved payment status could not be checked."));
      return;
    }
    const activeIntent = pendingIntentRef.current;
    const requestKey = stored ?? activeIntent?.requestKey;
    if (!requestKey) {
      setOperation(null);
      pendingIntentRef.current = null;
      setPendingRequestKey(null);
      setRecoveryMessage(null);
      return;
    }
    const result = await recoverIntent(requestKey, exactScope);
    if (result?.status === "succeeded") await queryClient.invalidateQueries({ queryKey: [creditPath] });
  }, [creditPath, exactScope, recoverIntent]);

  const actualApplications = useMemo(() => operation?.applications ?? [], [operation?.applications]);
  if (balanceQuery.isLoading) return <Card aria-busy="true"><CardContent><p className="py-5 text-sm text-muted-foreground">Loading rotating payment balance…</p></CardContent></Card>;
  if (balanceQuery.error || balanceQuery.data?.success === false) return <Card><CardContent><div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between"><div role="alert" className="flex items-start gap-2 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>{readErrorMessage(balanceQuery.error, balanceQuery.data?.error?.message ?? "Your rotating payment balance could not be loaded.")}</span></div><Button variant="outline" size="sm" onClick={() => void balanceQuery.refetch()}>Retry</Button></div></CardContent></Card>;
  if (!balanceQuery.data?.success || !balance || (!canBuyCredit && !hasCreditHistory)) return null;

  const selectedSourceLabel = cardMode === "saved" && savedCard ? `${savedCard.brand} ending in ${savedCard.last4}` : "Enter a new card";
  const reviewAmount = quoteIsCurrent && quote ? formatPayCurrency(quote.amountMinor) : "—";
  return <Card className="familiar-rotating-card familiar-one-time-card">
    <CardHeader spacing="tight">
      <CardTitle>One-time payment</CardTitle>
      {!canBuyCredit && <CardDescription>Your rotating payment balance and date history.</CardDescription>}
    </CardHeader>
    <CardContent><div className="space-y-5">
      {canBuyCredit ? <div className="familiar-rotating-checkout">
        <div className="familiar-rotating-stepper">
          <span className="text-sm text-muted-foreground">Weeks to pay</span>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="icon" aria-label="Pay one fewer week" disabled={shareCount <= 1 || hasActiveRequest} onClick={() => { setReviewOpen(false); setShareCount((count) => Math.max(1, count - 1)); }}><Minus className="size-4" /></Button>
            <output aria-label="Number of weeks to pay" aria-live="polite" className="min-w-8 text-center text-lg font-semibold tabular-nums">{shareCount}</output>
            <Button type="button" variant="outline" size="icon" aria-label="Pay one more week" disabled={shareCount >= MAX_SHARE_COUNT || hasActiveRequest} onClick={() => { setReviewOpen(false); setShareCount((count) => Math.min(MAX_SHARE_COUNT, count + 1)); }}><Plus className="size-4" /></Button>
          </div>
        </div>
        <div aria-live="polite" className="familiar-rotating-quote-summary">
          {quoteQuery.error && <p role="alert" className="text-destructive">{readErrorMessage(quoteQuery.error, "Payment price could not be confirmed.")} <button type="button" className="underline" onClick={() => void quoteQuery.refetch()}>Try again</button></p>}
          {quoteIsCurrent && quote && <>
            <p className="familiar-rotating-coverage">This payment covers {shareCount} {shareCount === 1 ? "week" : "weeks"}</p>
            <div className="familiar-rotating-total"><span>Payment total</span><strong>{formatPayCurrency(quote.amountMinor)}</strong></div>
          </>}
          {!quoteQuery.error && !quoteIsCurrent && <div className="familiar-rotating-total"><span>Payment total</span><strong>{quoteQuery.isFetching ? "Confirming price…" : "—"}</strong></div>}
        </div>

        <div className="familiar-source-picker">
          <button type="button" className="familiar-source-trigger" aria-expanded={sourceOpen} aria-haspopup="listbox" onClick={() => setSourceOpen((open) => !open)} disabled={hasActiveRequest || isCharging}>
            <span className="familiar-source-icon" aria-hidden="true">{cardMode === "saved" ? <Wallet className="size-5" /> : <CreditCard className="size-5" />}</span>
            <span className="familiar-source-copy"><strong>{selectedSourceLabel}</strong><small>{cardMode === "saved" ? "Saved payment method" : "Enter card details securely"}</small></span>
            <ChevronDown className={sourceOpen ? "is-open" : ""} size={18} aria-hidden="true" />
          </button>
          {sourceOpen && <div className="familiar-source-menu" role="listbox" aria-label="Payment source">
            {savedCards.map((candidate) => <button key={candidate.id} type="button" role="option" aria-selected={cardMode === "saved" && selectedSavedCardId === candidate.id} className={`familiar-source-option${cardMode === "saved" && selectedSavedCardId === candidate.id ? " is-selected" : ""}`} onClick={() => { cleanupCard(); setReviewOpen(false); setCardMode("saved"); setSelectedSavedCardId(candidate.id); setSourceOpen(false); }}><span><strong>{candidate.brand} ending in {candidate.last4}</strong><small>Saved card · exp {candidate.expMonth}/{candidate.expYear}</small></span>{cardMode === "saved" && selectedSavedCardId === candidate.id && <span aria-hidden="true">✓</span>}</button>)}
            <button type="button" role="option" aria-selected={cardMode === "new"} className={`familiar-source-option${cardMode === "new" ? " is-selected" : ""}`} onClick={() => { cleanupCard(); setReviewOpen(false); setCardMode("new"); setSourceOpen(true); }}><span><strong>Enter a new card</strong><small>Card details</small></span>{cardMode === "new" && <span aria-hidden="true">✓</span>}</button>
            {cardMode === "new" && <div className="familiar-card-editor" role="group" aria-label="Card details"><span className="text-sm font-medium">Card details</span><div id={`rotating-credit-card-${league.id}`} ref={cardContainerRef} className="min-h-20 rounded-md border p-3" />{cardError && <p role="alert" className="text-sm text-destructive">{cardError}</p>}{providerError && <p role="alert" className="text-sm text-destructive">{providerError}</p>}{!providerLoading && !isProviderConfigured && <p role="status" className="text-sm text-muted-foreground">Card payments are unavailable for this league right now.</p>}</div>}
          </div>}
        </div>
        {sourceOpen && <details className="familiar-rotating-application-details"><summary>Payment application details</summary><p>Available balance after payment: {quoteIsCurrent && quote ? formatPayCurrency(quote.expectedAvailableAfterPurchaseMinor) : "—"}. After payment succeeds, the server applies funds to then-current confirmed dates. Dates are not reserved, and any unused amount remains available for a future week.</p><p>This one-time payment never enrolls a card in automatic payments.</p></details>}

        {!profileEmailValid && <div className="space-y-2"><Label htmlFor={`rotating-credit-email-${league.id}`}>Email for receipt <span className="text-destructive">*</span></Label><Input id={`rotating-credit-email-${league.id}`} type="email" autoComplete="email" value={receiptEmail} onChange={(event) => setReceiptEmail(event.currentTarget.value)} placeholder="you@example.com" aria-invalid={receiptEmail.length > 0 && !buyerEmailValid} required /><p className="text-xs text-muted-foreground">{bowlerEmail ? "Your profile email is invalid. Enter a valid receipt email to continue." : "Add a valid email to complete the receipt for this purchase."}</p></div>}

        <div className="familiar-rotating-wallets grid gap-2 sm:grid-cols-2">
          {!wallet.applePayTokenizeOnly && wallet.applePayRef && <div ref={wallet.applePayRef} className={wallet.applePayAvailable ? "min-h-12 overflow-hidden rounded-md bg-black" : "hidden"} />}
          {wallet.applePayAvailable && wallet.applePayTokenizeOnly && <Button type="button" variant="outline" onClick={() => void wallet.handleApplePayClick()} disabled={hasActiveRequest || wallet.isProcessing}>Pay with Apple Pay</Button>}
          {!wallet.googlePayTokenizeOnly && wallet.googlePayRef && <div ref={wallet.googlePayRef} className={wallet.googlePayAvailable ? "min-h-12 overflow-hidden rounded-md bg-black" : "hidden"} />}
          {wallet.googlePayAvailable && wallet.googlePayTokenizeOnly && <Button type="button" variant="outline" onClick={() => void wallet.handleGooglePayClick()} disabled={hasActiveRequest || wallet.isProcessing}>Pay with Google Pay</Button>}
        </div>
        {wallet.isProcessing && <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Processing wallet payment…</p>}

        {reviewOpen && <section className="familiar-payment-review familiar-rotating-review" aria-label="Review payment"><div><span>Payment total</span><strong>{reviewAmount}</strong></div><p>This payment covers {shareCount} {shareCount === 1 ? "week" : "weeks"}.</p><small>We’ll confirm the latest quote before charging your selected card.</small></section>}
        {reviewOpen && <Button type="button" variant="ghost" onClick={() => setReviewOpen(false)} disabled={isCharging || hasActiveRequest}>Back to payment details</Button>}
        <Button type="button" className="w-full" onClick={() => { if (reviewOpen) void submitCard(); else setReviewOpen(true); }} disabled={!quoteIsCurrent || quoteQuery.isFetching || !!quoteQuery.error || !selectedSourceReady || providerLoading || !isProviderConfigured || !buyerEmailValid || isCharging || wallet.isProcessing || hasActiveRequest || isCheckingStatus}>
          {isCharging ? <><Loader2 className="mr-2 size-4 animate-spin" />Processing…</> : reviewOpen ? <>Pay {reviewAmount}</> : <>Preview payment of {reviewAmount}</>}
        </Button>
      </div> : <div role="status" className="rounded-md border border-warning-500/40 bg-warning-500/5 p-4 text-sm"><p className="font-medium">New rotating payments are unavailable.</p><p className="mt-1 text-muted-foreground">Your existing available or held balance remains in your payment history. Contact league staff for help with a refund or account change.</p></div>}

      {hasCreditHistory && <details className="familiar-rotating-balance-details"><summary>Payment history details</summary><dl>
        <div><dt>{canBuyCredit ? "Available balance" : "Balance"}</dt><dd>{formatPayCurrency(balance.availableMinor)}</dd></div>
        <div><dt>Paid ahead</dt><dd>{formatPayCurrency(balance.fundedMinor)}</dd></div>
        <div><dt>Applied to dates</dt><dd>{formatPayCurrency(balance.appliedMinor)}</dd></div>
        <div><dt>Refunded</dt><dd>{formatPayCurrency(balance.refundedMinor)}</dd></div>
        <div><dt>Refund held</dt><dd>{formatPayCurrency(balance.refundHeldMinor)}</dd></div>
        <div><dt>Review held</dt><dd>{formatPayCurrency(balance.reviewHeldMinor)}</dd></div>
      </dl><div className="familiar-rotating-history"><h3>Payments applied to dates</h3>{balance.applications.length === 0 ? <p>No payment has been applied to a date yet.</p> : <ul>{[...balance.applications].sort((left, right) => right.appliedAt.localeCompare(left.appliedAt)).map((application) => <li key={application.applicationId}><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}{application.status === "reversed" ? " · reversed" : " · paid ahead"}</span><span>{formatPayCurrency(application.amountMinor)}</span></li>)}</ul>}</div></details>}

      {(hasActiveRequest || recoveryMessage) && <div role="status" className="space-y-3 rounded-md border border-warning-500/40 bg-warning-500/5 p-4 text-sm">
        <p>{operation ? operationMessage(operation) : recoveryMessage ?? "Checking your payment status…"}</p>
        {recoveryMessage && <p className="text-muted-foreground">{recoveryMessage}</p>}
        {!operation || !operationIsTerminal(operation) ? <Button type="button" variant="outline" size="sm" onClick={() => void retryStatus()} disabled={isCheckingStatus || isCharging}><RotateCcw className="mr-2 size-4" />{isCheckingStatus ? "Checking…" : "Check payment status"}</Button> : null}
      </div>}

      {operation?.status === "succeeded" && <div role="status" className="space-y-3 rounded-md border border-success-500/40 bg-success-500/5 p-4">
        <div><h3 className="font-medium">Payment complete · {formatPayCurrency(operation.fundedMinor)} paid ahead</h3><p className="mt-1 text-sm text-muted-foreground">Current available balance: {formatPayCurrency(operation.balance?.availableMinor ?? balance.availableMinor)}.</p></div>
        {actualApplications.length > 0 ? <div><p className="text-sm font-medium">Dates actually paid</p><ul className="mt-2 space-y-1 text-sm">{actualApplications.map((application) => <li key={application.applicationId} className="flex flex-wrap justify-between gap-x-4"><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}{application.status === "reversed" ? " · reversed" : ""}</span><span className="tabular-nums">{formatPayCurrency(application.amountMinor)}</span></li>)}</ul></div> : <p className="text-sm text-muted-foreground">No confirmed date received payment at purchase time. The full unused amount remains available for a future week.</p>}
      </div>}

    </div></CardContent>
  </Card>;
}
