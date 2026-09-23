import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CreditCard, Loader2, Minus, Plus, RotateCcw, Wallet } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { csrfFetch, queryClient } from "@/lib/queryClient";
import { beginPaymentIntent, clearPaymentIntent, getPaymentIntent, paymentRequestHeaders } from "@/lib/payment-request-identity";
import { makeApiError } from "@/lib/provider-not-configured";
import { tokenizeCard } from "@/lib/square";
import { formatCurrency } from "@/lib/utils";

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

function operationMessage(status: RotatingCreditOperationWire["status"]): string {
  switch (status) {
    case "pending":
    case "leased":
    case "retry_scheduled":
      return "Your share purchase is still being confirmed. Check its status before starting another purchase.";
    case "provider_unknown":
      return "The payment provider has not confirmed this purchase yet. Check its status before trying another card.";
    case "reconciliation_required":
      return "This purchase needs payment reconciliation. Your credit is not available while it is being reviewed.";
    case "action_required":
      return "This purchase needs further payment review. Check its status again; if the status persists, contact league staff. Your credit is not available yet.";
    case "failed_terminal":
      return "The share purchase was not completed. You can request a new quote and try again.";
    case "canceled":
      return "The share purchase was canceled. You can request a new quote and try again.";
    case "succeeded":
      return "Share credit has been added.";
  }
}

function operationIsUnresolved(status: RotatingCreditOperationWire["status"]): boolean {
  return RECOVERY_PENDING_STATUSES.has(status);
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
  const [cardMode, setCardMode] = useState<"new" | "saved">("new");
  const [selectedSavedCardId, setSelectedSavedCardId] = useState("");
  const [receiptEmail, setReceiptEmail] = useState(bowlerEmail);
  const [isCharging, setIsCharging] = useState(false);
  const [pendingRequestKey, setPendingRequestKey] = useState<string | null>(null);
  const [operation, setOperation] = useState<RotatingCreditOperationWire | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const { card, isInitialized, initializeCard, cleanupCard, error: cardError } = useSquarePayment({
    locationId: league.locationId ?? null,
    onError: (message) => toast({ title: "Credit card unavailable", description: message, variant: "destructive" }),
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
      if (!response.ok) throw makeApiError(body, response.status, "Share price could not be confirmed.");
      if (!body.success || !body.data) throw new Error(body.error?.message ?? "Share price could not be confirmed.");
      return body;
    },
    enabled: canBuyCredit && shareCount >= 1 && shareCount <= MAX_SHARE_COUNT,
    retry: false,
    staleTime: 0,
  });
  const quote = quoteQuery.data?.data;
  currentQuoteRef.current = quote ?? null;
  const quoteIsCurrent = quote?.shareCount === shareCount && quote.leagueId === league.id && quote.bowlerId === bowlerId;
  const intentIsUnresolved = operation !== null && operationIsUnresolved(operation.status);
  const hasActiveRequest = pendingRequestKey !== null || intentIsUnresolved || isCheckingStatus;
  const savedCard = savedCards.find((candidate) => candidate.id === selectedSavedCardId);
  const selectedSourceReady = cardMode === "saved" ? !!savedCard : isInitialized;

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
      if (!response.ok) throw makeApiError(body, response.status, "Purchase status could not be confirmed.");
      if (!body.success || !body.data) throw new Error(body.error?.message ?? "Purchase status could not be confirmed.");
      const result = body.data;
      setOperation(result);
      if (result.status === "succeeded") {
        clearPaymentIntent(exactScope, requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
        await queryClient.invalidateQueries({ queryKey: [creditPath] });
        toast({ title: "Share credit updated", description: operationMessage(result.status) });
      } else if (TERMINAL_STATUSES.has(result.status)) {
        clearPaymentIntent(exactScope, requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
        setRecoveryMessage(operationMessage(result.status));
      }
      return result;
    } catch (error) {
      setRecoveryMessage(readErrorMessage(error, "Purchase status could not be confirmed."));
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
    if (cardMode !== "new" || !container || providerLoading || !isProviderConfigured || intentIsUnresolved) {
      cleanupCard();
      return;
    }
    void initializeCard(container);
    return () => cleanupCard();
  }, [cardMode, providerLoading, isProviderConfigured, intentIsUnresolved, initializeCard, cleanupCard]);

  const applyOperation = useCallback(async (result: RotatingCreditOperationWire, exactIntent: CreditIntent) => {
    setOperation(result);
    if (result.status === "succeeded") {
      clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
      pendingIntentRef.current = null;
      setPendingRequestKey(null);
      await queryClient.invalidateQueries({ queryKey: [creditPath] });
      toast({ title: "Share purchase complete", description: `${formatCurrency(result.fundedMinor)} was added to your rotating credit.` });
    } else if (TERMINAL_STATUSES.has(result.status)) {
      clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
      pendingIntentRef.current = null;
      setPendingRequestKey(null);
      setRecoveryMessage(operationMessage(result.status));
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
        const error = makeApiError(body, response.status, "Share purchase could not be completed.");
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
      if (!body.success || !body.data) throw new Error(body.error?.message ?? "Share purchase could not be completed.");
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
      if (result.status !== "succeeded") setRecoveryMessage(operationMessage(result.status));
    } catch (error) {
      toast({ title: "Share purchase status unavailable", description: readErrorMessage(error, "Check the payment status before trying again."), variant: "destructive" });
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
      if (!sourceId) throw new Error("Select a saved card or enter card details before buying shares.");
      chargeAttempted = true;
      const result = await submitTokenizedSource(sourceId, cardMode === "saved" ? "saved_card" : "new_card", exactIntent);
      if (result.status !== "succeeded") setRecoveryMessage(operationMessage(result.status));
    } catch (error) {
      if (exactIntent && !chargeAttempted && pendingIntentRef.current?.requestKey === exactIntent.requestKey) {
        // A tokenization failure happened before a request was submitted.
        clearPaymentIntent(exactIntent.scope, exactIntent.requestKey);
        pendingIntentRef.current = null;
        setPendingRequestKey(null);
      }
      toast({ title: "Share purchase could not be completed", description: readErrorMessage(error, "Review the payment details and try again."), variant: "destructive" });
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
  if (balanceQuery.isLoading) return <Card aria-busy="true"><CardContent><p className="py-5 text-sm text-muted-foreground">Loading rotating share credit…</p></CardContent></Card>;
  if (balanceQuery.error || balanceQuery.data?.success === false) return <Card><CardContent><div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between"><div role="alert" className="flex items-start gap-2 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>{readErrorMessage(balanceQuery.error, balanceQuery.data?.error?.message ?? "Your rotating credit could not be loaded.")}</span></div><Button variant="outline" size="sm" onClick={() => void balanceQuery.refetch()}>Retry</Button></div></CardContent></Card>;
  if (!balanceQuery.data?.success || !balance || (!canBuyCredit && !hasCreditHistory)) return null;

  return <Card>
    <CardHeader spacing="tight">
      <CardTitle><span className="flex items-center gap-2"><RotateCcw className="size-5" />Rotating share credit</span></CardTitle>
      <CardDescription>{canBuyCredit ? "Buy one or more weekly shares in advance. This one-time purchase never enrolls a card in autopay." : "Your rotating payment credit and date history."}</CardDescription>
    </CardHeader>
    <CardContent><div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">{canBuyCredit ? "Available credit" : "Credit balance"}</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrency(balance.availableMinor)}</dd></div>
        <div className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">Funded</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrency(balance.fundedMinor)}</dd></div>
        <div className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">Applied to dates</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrency(balance.appliedMinor)}</dd></div>
        <div className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">Refunded</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrency(balance.refundedMinor)}</dd></div>
        <div className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">Refund held</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrency(balance.refundHeldMinor)}</dd></div>
        <div className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">Review held</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrency(balance.reviewHeldMinor)}</dd></div>
      </dl>

      {canBuyCredit ? <div className="space-y-3 rounded-md border p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div><h3 className="font-medium">Buy weekly shares</h3><p className="text-sm text-muted-foreground">Each share costs {formatCurrency(balance.shareAmountMinor ?? 0)}.</p></div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="icon" aria-label="Buy one fewer weekly share" disabled={shareCount <= 1 || hasActiveRequest} onClick={() => setShareCount((count) => Math.max(1, count - 1))}><Minus className="size-4" /></Button>
            <output aria-label="Number of weekly shares" aria-live="polite" className="min-w-10 text-center text-lg font-semibold tabular-nums">{shareCount}</output>
            <Button type="button" variant="outline" size="icon" aria-label="Buy one more weekly share" disabled={shareCount >= MAX_SHARE_COUNT || hasActiveRequest} onClick={() => setShareCount((count) => Math.min(MAX_SHARE_COUNT, count + 1))}><Plus className="size-4" /></Button>
          </div>
        </div>
        <div aria-live="polite" className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between gap-3"><span>Purchase amount</span><span className="font-semibold tabular-nums">{quoteQuery.isFetching ? "Confirming price…" : quoteIsCurrent && quote ? formatCurrency(quote.amountMinor) : "—"}</span></div>
          {quoteQuery.error && <p role="alert" className="text-destructive">{readErrorMessage(quoteQuery.error, "Share price could not be confirmed.")} <button type="button" className="underline" onClick={() => void quoteQuery.refetch()}>Try again</button></p>}
          {quoteIsCurrent && quote && <>
            <p className="text-xs text-muted-foreground">Expected available credit after purchase: {formatCurrency(quote.expectedAvailableAfterPurchaseMinor)}.</p>
            <div className="border-t pt-2">
              <p className="font-medium">Possible date applications · preview only</p>
              <p className="text-xs text-muted-foreground">These dates are not reserved. After payment succeeds, the server applies funds to then-current confirmed dates. Any unused amount remains your credit.</p>
              {quote.advisoryApplications.length > 0 ? <ul className="mt-2 space-y-1 text-xs">{quote.advisoryApplications.map((application) => <li key={`${application.obligationId}-${application.teamId}`} className="flex flex-wrap justify-between gap-x-4"><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}</span><span className="tabular-nums">{formatCurrency(application.amountMinor)}</span></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No confirmed date currently needs this credit. Your purchase remains available personal credit until an eligible date is confirmed.</p>}
            </div>
          </>}
        </div>

        {savedCards.length > 0 && <div className="flex flex-wrap gap-2" role="group" aria-label="Payment source">
          <Button type="button" variant={cardMode === "new" ? "default" : "outline"} size="sm" onClick={() => { cleanupCard(); setCardMode("new"); }}><CreditCard className="mr-2 size-4" />New card</Button>
          <Button type="button" variant={cardMode === "saved" ? "default" : "outline"} size="sm" onClick={() => { cleanupCard(); setCardMode("saved"); }}><Wallet className="mr-2 size-4" />Saved card</Button>
        </div>}
        {cardMode === "saved" && savedCards.length > 0 ? <div className="space-y-2"><Label htmlFor={`rotating-saved-card-${league.id}`}>Saved card</Label><Select value={selectedSavedCardId} onValueChange={setSelectedSavedCardId}><SelectTrigger id={`rotating-saved-card-${league.id}`}><SelectValue placeholder="Choose a saved card" /></SelectTrigger><SelectContent>{savedCards.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.brand} ending in {candidate.last4} · exp {candidate.expMonth}/{candidate.expYear}</SelectItem>)}</SelectContent></Select></div> : <div className="space-y-2"><Label htmlFor={`rotating-credit-card-${league.id}`}>Card details</Label><div id={`rotating-credit-card-${league.id}`} ref={cardContainerRef} className="min-h-20 rounded-md border p-3" />{cardError && <p role="alert" className="text-sm text-destructive">{cardError}</p>}{providerError && <p role="alert" className="text-sm text-destructive">{providerError}</p>}{!providerLoading && !isProviderConfigured && <p role="status" className="text-sm text-muted-foreground">Card payments are unavailable for this league right now.</p>}</div>}

        {!profileEmailValid && <div className="space-y-2"><Label htmlFor={`rotating-credit-email-${league.id}`}>Email for receipt <span className="text-destructive">*</span></Label><Input id={`rotating-credit-email-${league.id}`} type="email" autoComplete="email" value={receiptEmail} onChange={(event) => setReceiptEmail(event.currentTarget.value)} placeholder="you@example.com" aria-invalid={receiptEmail.length > 0 && !buyerEmailValid} required /><p className="text-xs text-muted-foreground">{bowlerEmail ? "Your profile email is invalid. Enter a valid receipt email to continue." : "Add a valid email to complete the receipt for this purchase."}</p></div>}

        <div className="grid gap-2 sm:grid-cols-2">
          {!wallet.applePayTokenizeOnly && wallet.applePayRef && <div ref={wallet.applePayRef} className={wallet.applePayAvailable ? "min-h-12 overflow-hidden rounded-md bg-black" : "hidden"} />}
          {wallet.applePayAvailable && wallet.applePayTokenizeOnly && <Button type="button" variant="outline" onClick={() => void wallet.handleApplePayClick()} disabled={hasActiveRequest || wallet.isProcessing}>Pay with Apple Pay</Button>}
          {!wallet.googlePayTokenizeOnly && wallet.googlePayRef && <div ref={wallet.googlePayRef} className={wallet.googlePayAvailable ? "min-h-12 overflow-hidden rounded-md bg-black" : "hidden"} />}
          {wallet.googlePayAvailable && wallet.googlePayTokenizeOnly && <Button type="button" variant="outline" onClick={() => void wallet.handleGooglePayClick()} disabled={hasActiveRequest || wallet.isProcessing}>Pay with Google Pay</Button>}
        </div>
        {wallet.isProcessing && <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Processing wallet payment…</p>}

        <Button type="button" className="w-full" onClick={() => void submitCard()} disabled={!quoteIsCurrent || quoteQuery.isFetching || !!quoteQuery.error || !selectedSourceReady || providerLoading || !isProviderConfigured || !buyerEmailValid || isCharging || wallet.isProcessing || hasActiveRequest || isCheckingStatus}>
          {isCharging ? <><Loader2 className="mr-2 size-4 animate-spin" />Processing…</> : <>Buy {shareCount} {shareCount === 1 ? "share" : "shares"} · {quoteIsCurrent && quote ? formatCurrency(quote.amountMinor) : "…"}</>}
        </Button>
        <p className="text-xs text-muted-foreground">This is a one-time payment. The card is not saved and no autopay is created.</p>
      </div> : <div role="status" className="rounded-md border border-warning-500/40 bg-warning-500/5 p-4 text-sm"><p className="font-medium">New rotating share purchases are unavailable.</p><p className="mt-1 text-muted-foreground">Your existing available or held credit remains in your balance history. Contact league staff for help with a refund or account change.</p></div>}

      {(hasActiveRequest || recoveryMessage) && <div role="status" className="space-y-3 rounded-md border border-warning-500/40 bg-warning-500/5 p-4 text-sm">
        <p>{operation ? operationMessage(operation.status) : recoveryMessage ?? "Checking your share purchase status…"}</p>
        {recoveryMessage && <p className="text-muted-foreground">{recoveryMessage}</p>}
        <Button type="button" variant="outline" size="sm" onClick={() => void retryStatus()} disabled={isCheckingStatus || isCharging}><RotateCcw className="mr-2 size-4" />{isCheckingStatus ? "Checking…" : "Check purchase status"}</Button>
      </div>}

      {operation?.status === "succeeded" && <div role="status" className="space-y-3 rounded-md border border-success-500/40 bg-success-500/5 p-4">
        <div><h3 className="font-medium">Purchase complete · {formatCurrency(operation.fundedMinor)} funded</h3><p className="mt-1 text-sm text-muted-foreground">Current available credit: {formatCurrency(operation.balance?.availableMinor ?? balance.availableMinor)}.</p></div>
        {actualApplications.length > 0 ? <div><p className="text-sm font-medium">Dates actually paid/credited</p><ul className="mt-2 space-y-1 text-sm">{actualApplications.map((application) => <li key={application.applicationId} className="flex flex-wrap justify-between gap-x-4"><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}{application.status === "reversed" ? " · reversed" : ""}</span><span className="tabular-nums">{formatCurrency(application.amountMinor)}</span></li>)}</ul></div> : <p className="text-sm text-muted-foreground">No confirmed date received credit at purchase time. The full unused amount remains in your personal credit balance.</p>}
      </div>}

      <div className="space-y-2 border-t pt-4">
        <h3 className="font-medium">Credit applied to dates</h3>
        {balance.applications.length === 0 ? <p className="text-sm text-muted-foreground">No credit has been applied to a date yet.</p> : <ul className="space-y-2 text-sm">{[...balance.applications].sort((left, right) => right.appliedAt.localeCompare(left.appliedAt)).map((application) => <li key={application.applicationId} className="flex flex-col justify-between gap-1 rounded-md border p-3 sm:flex-row sm:items-center"><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}{application.status === "reversed" ? " · reversed" : " · paid/credited"}</span><span className="tabular-nums">{formatCurrency(application.amountMinor)}</span></li>)}</ul>}
      </div>
    </div></CardContent>
  </Card>;
}
