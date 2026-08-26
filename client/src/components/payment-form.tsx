import { useEffect, useRef, useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSquarePayment } from "@/hooks/use-square-payment";
import { usePaymentProvider } from "@/hooks/use-payment-provider";
import { useWalletPayments } from "@/hooks/use-wallet-payments";
import { useSavedCardDefault } from "@/hooks/use-saved-card-default";
import { Form } from "@/components/ui/form";
import { insertPaymentSchema, DEFAULT_TIMEZONE, DEFAULT_WEEKLY_FEE_CENTS } from "@shared/schema";
import type { InsertPaymentInput, InsertPayment, Bowler, League, User, ApiResponse } from "@shared/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PaymentCreditCardSection } from "@/components/payment-credit-card-section";
import { csrfFetch } from '@/lib/queryClient';
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
} from "@/lib/provider-not-configured";
import { useLocation } from "wouter";
import { PaymentFormFields } from "@/components/payment-form-fields";
import { PaymentMethodTabs } from "@/components/payment-method-tabs";
import { usePaymentFormSubmit } from "@/hooks/use-payment-form-submit";
import { assertRosterPaymentSucceeded, beginPaymentIntent, clearPaymentIntent, isTerminalRosterPaymentFailure, paymentRequestHeaders, paymentRequestWithRecovery } from "@/lib/payment-request-identity";
import { PaymentFeeInfoAlert } from "@/components/payment-fee-info-alert";
import { PaymentCheckNumberField } from "@/components/payment-check-number-field";
import { PaymentReceiptEmailField } from "@/components/payment-receipt-email-field";
import { PaymentProviderNotConfiguredAlert } from "@/components/payment-provider-not-configured-alert";
import { PaymentFormActions } from "@/components/payment-form-actions";
import { InteractiveOccurrenceSelector, type InteractiveOccurrenceReadiness } from "@/components/interactive-occurrence-selector";

interface SavedCard {
  id: string;
  last4: string;
  brand: string;
  expMonth: number;
  expYear: number;
}

interface PaymentFormProps {
  open: boolean;
  onClose: () => void;
  bowlers: Bowler[];
  leagueId?: number;
  paymentManager?: boolean;
}

export function PaymentForm({ open, onClose, bowlers, leagueId, paymentManager = false }: PaymentFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const walletRequestKeyRef = useRef<string | null>(null);
  const [isSquareReady, setIsSquareReady] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [activePaymentMethod, setActivePaymentMethod] = useState<'credit' | 'cash' | 'check'>('credit');
  const [squareLoadFailed, setSquareLoadFailed] = useState(false);
  const [cardMode, setCardMode] = useState<'new' | 'saved'>('new');
  const [selectedSavedCardId, setSelectedSavedCardId] = useState<string>('');
  const [occurrenceAllocations, setOccurrenceAllocations] = useState<{ obligationId: string; amountMinor: number }[]>([]);
  const [occurrenceQuoteFingerprint, setOccurrenceQuoteFingerprint] = useState<string | undefined>();
  const [occurrenceReadiness, setOccurrenceReadiness] = useState<InteractiveOccurrenceReadiness>('loading');
  const [receiptEmail, setReceiptEmail] = useState<string>('');
  const initializationAttempted = useRef(false);

  const { data: leagueData } = useQuery<{ success: boolean; data: League }>({
    queryKey: ['/api/leagues', leagueId],
    enabled: !!leagueId,
  });
  const leagueInfo = leagueData?.data;

  // Admins (system_admin or org_admin) can fix a misconfigured provider;
  // non-admins get the static "ask your league admin" copy. (Task #583,
  // mirrors `providerNotConfiguredToast` in lib/provider-not-configured.)
  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 1000 * 60 * 5,
  });
  const currentUser = currentUserResponse?.data;
  const isAdmin =
    currentUser?.role === 'system_admin' || currentUser?.role === 'org_admin';

  const form = useForm<InsertPaymentInput, unknown, InsertPayment>({
    resolver: zodResolver(insertPaymentSchema),
    defaultValues: {
      amount: DEFAULT_WEEKLY_FEE_CENTS,
      weekOf: new Date().toISOString(),
      status: "paid",
      type: "cash",
      leagueId: leagueId,
      storeCard: false,
    },
  });

  const {
    supportsWallets,
    isLoading: providerLoading,
    isProviderConfigured,
    missingFields: providerMissingFields,
  } = usePaymentProvider(leagueInfo?.locationId ?? null);
  // Square exposes per-field "missing" data via
  // `/payments-provider/config`. When the active provider is partially
  // configured we replace the card UI with an alert listing missing fields
  // and disable submit — instead of spinning up a tokenizer that will fail.
  const providerNotFullyConfigured = !providerLoading && !isProviderConfigured;

  const {
    card: squareCard,
    isInitialized: squareInitialized,
    error: squareError,
    initializeCard: squareInitializeCard,
    cleanupCard: squareCleanupCard,
  } = useSquarePayment({
    locationId: leagueInfo?.locationId ?? null,
    onError: (error) => {
      form.setValue("type", "cash");
      toast({
        title: "Payment Form Notice",
        description: "Credit card form unavailable. Please try another payment method.",
        variant: "default",
      });
    },
  });

  const card = squareCard;
  const isInitialized = squareInitialized;
  const cardError = squareError;
  const initializeCard = squareInitializeCard;
  const cleanupCard = squareCleanupCard;

  useEffect(() => {
    if (leagueId) {
      form.setValue('leagueId', leagueId, { shouldDirty: false });
    }
  }, [leagueId, form]);

  const paymentType = form.watch("type");
  const selectedBowlerId = form.watch("bowlerId");
  const watchedAmount = form.watch("amount");
  const allowStoreCard = !paymentManager && currentUser?.bowlerId === selectedBowlerId;

  useEffect(() => {
    if (!allowStoreCard && form.getValues("storeCard")) {
      form.setValue("storeCard", false, { shouldDirty: false });
    }
  }, [allowStoreCard, form]);

  const { data: savedCardsResponse } = useQuery<{ success: boolean; data: SavedCard[] }>({
    queryKey: [`/api/payments-provider/cards/${selectedBowlerId}`, leagueId],
    queryFn: async () => {
      const params = leagueId ? `?leagueId=${leagueId}` : '';
      const res = await csrfFetch(`/api/payments-provider/cards/${selectedBowlerId}${params}`);
      if (!res.ok) throw new Error('Failed to fetch saved cards');
      return res.json();
    },
    enabled: !!selectedBowlerId && paymentType === 'credit_card',
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
  const savedCards = savedCardsResponse?.data || [];
  const firstSavedCardId = savedCards.length > 0 ? savedCards[0].id : null;

  // Default the card picker to the bowler's first saved card whenever the
  // bowler, payment type, or loaded saved-card set changes (and back to "new"
  // otherwise). Shared with the bowler setup + quick-pay flows.
  useSavedCardDefault({
    firstSavedCardId,
    enabled: paymentType === 'credit_card',
    dependencyKey: `${selectedBowlerId ?? ''}|${paymentType}`,
    setCardMode,
    setSelectedSavedCardId,
  });

  useEffect(() => {
    if (!open || paymentType !== "credit_card") {
      if (isInitialized) {
        cleanupCard();
        setIsSquareReady(false);
        initializationAttempted.current = false;
      }
      return;
    }
    if (providerLoading || !cardContainerRef.current) {
      return;
    }
    // Don't spin up the active provider's tokenizer when the location's
    // credentials are missing/partial — the SDK load would fail with a
    // generic error. The friendly notice below tells admins what to fix.
    // (Tasks #575 + #579.)
    if (providerNotFullyConfigured) {
      return;
    }
    if (isInitialized) {
      setIsSquareReady(true);
      return;
    }
    if (initializationAttempted.current && isSquareReady) {
      return;
    }
    initializationAttempted.current = true;
    setPaymentError(null);
    const container = cardContainerRef.current;
    const initTimeout = setTimeout(() => {
      if (!isSquareReady) {
        setPaymentError('Failed to initialize payment form in a timely manner');
        form.setValue("type", "cash", { shouldDirty: false });
        initializationAttempted.current = false;
        toast({
          title: "Payment Option Changed",
          description: "Credit card processing unavailable at this time. Switched to cash payment.",
          variant: "default",
        });
      }
    }, 5000);
    setTimeout(() => {
      initializeCard(container)
        .then(() => {
          setIsSquareReady(true);
          clearTimeout(initTimeout);
        })
        .catch((error) => {
          setIsSquareReady(false);
          setPaymentError(error instanceof Error ? error.message : 'Failed to initialize payment form');
          initializationAttempted.current = false;
          clearTimeout(initTimeout);
          form.setValue("type", "cash", { shouldDirty: false });
          toast({
            title: "Payment Form Notice",
            description: "Credit card form unavailable. Please try another payment method.",
            variant: "default",
          });
        });
    }, 300);
    return () => {
      clearTimeout(initTimeout);
    };
  }, [open, paymentType, isInitialized, isSquareReady, cleanupCard, initializeCard, toast, form, providerLoading, providerNotFullyConfigured]);

  useEffect(() => {
    if (!open) {
      form.reset();
      setCardMode('new');
      setSelectedSavedCardId('');
      setReceiptEmail('');
    }
  }, [open, form]);

  // Clear inline receipt-email when operator switches bowlers so we never
  // reuse the prior bowler's typed address. Render-time adjustment keyed on
  // the selected bowler rather than an effect.
  const [prevReceiptBowlerId, setPrevReceiptBowlerId] = useState(selectedBowlerId);
  if (selectedBowlerId !== prevReceiptBowlerId) {
    setPrevReceiptBowlerId(selectedBowlerId);
    setReceiptEmail('');
  }

  const handleWalletPayment = useCallback(async (token: string, walletType: 'apple_pay' | 'google_pay') => {
    const bowlerId = form.getValues('bowlerId');
    const amount = form.getValues('amount');
    const currentLeagueId = form.getValues('leagueId');
    if (!bowlerId || !amount || !currentLeagueId) {
      setPaymentError('Please select a bowler and enter an amount before paying');
      return;
    }
    // Thread the inline-captured email through wallet (Apple/Google Pay)
    // charges so Square's hosted receipt fires for bowlers with no email on
    // file. Mirrors the server's BUYER_EMAIL_REQUIRED gate.
    const selected = bowlers.find((b) => b.id === bowlerId);
    const trimmedReceiptEmail = receiptEmail.trim();
    if (!selected?.email && !trimmedReceiptEmail) {
      setPaymentError(
        'This bowler has no email on file. Enter an email for the receipt before paying with Apple Pay / Google Pay.',
      );
      return;
    }
    const overrideEmail = !selected?.email && trimmedReceiptEmail ? trimmedReceiptEmail : undefined;
    try {
      const exactObligationIds = [...new Set((occurrenceAllocations ?? []).map((row) => row.obligationId))];
      if (!leagueInfo || leagueInfo.id !== currentLeagueId) throw new Error("Payment league context is unavailable.");
      if (exactObligationIds.length === 0) throw new Error("Wallet payments require exact obligations.");
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${currentLeagueId}/interactive-obligation-quote/2`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ obligationIds: exactObligationIds, allocations: occurrenceAllocations }) });
      const quoteBody = await quoteResponse.json();
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw new Error(quoteBody.error?.message || "Exact payment obligations are unavailable.");
      const paymentScope = `admin-wallet:${currentLeagueId}:${exactObligationIds.join(",")}:${quoteBody.data.fingerprint}`;
      const requestKey = walletRequestKeyRef.current ?? beginPaymentIntent(paymentScope);
      const exactResponse = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${currentLeagueId}/interactive-obligation-charge/2`, { method: "POST", headers: { ...paymentRequestHeaders(requestKey), "Content-Type": "application/json" }, body: JSON.stringify({ obligationIds: exactObligationIds, allocations: occurrenceAllocations, payerBowlerId: quoteBody.data.payerBowlerId ?? bowlerId, sourceId: token, sourceKind: "wallet", buyerEmail: overrideEmail ?? selected?.email ?? null, storeCard: false, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }) }), currentLeagueId);
      const exactBody = await exactResponse.json();
      const rosterStatus = exactBody.data?.status ?? exactBody.status;
      if (!exactResponse.ok) {
        if (isTerminalRosterPaymentFailure(rosterStatus)) walletRequestKeyRef.current = null;
        throw new Error(exactBody.error?.message || "Wallet payment failed.");
      }
      if (isTerminalRosterPaymentFailure(rosterStatus)) walletRequestKeyRef.current = null;
      assertRosterPaymentSucceeded(rosterStatus);
      clearPaymentIntent(paymentScope);
      walletRequestKeyRef.current = null;
      toast({ title: "Success", description: `Payment processed via ${walletType === "apple_pay" ? "Apple Pay" : "Google Pay"}` });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
      onClose();
    } catch (error) {
      if (isProviderNotConfiguredError(error)) {
        const props = providerNotConfiguredToast({
          navigate,
          locationId: leagueInfo?.locationId ?? null,
        });
        setPaymentError(props.title);
        toast(props);
        return;
      }
      const errorMessage = error instanceof Error ? error.message : 'Payment failed';
      setPaymentError(errorMessage);
      toast({ title: "Error", description: errorMessage, variant: "destructive" });
    }
  }, [form, toast, queryClient, onClose, bowlers, receiptEmail, navigate, leagueInfo, occurrenceAllocations]);

  const beginWalletPayment = useCallback(() => {
    const values = form.getValues();
    if (!values.bowlerId || !values.leagueId || !values.amount) return;
    const exactObligationIds = [...new Set((occurrenceAllocations ?? []).map((row) => row.obligationId))];
    walletRequestKeyRef.current = beginPaymentIntent(
      `admin-wallet:${values.leagueId}:${exactObligationIds.join(",")}:${occurrenceQuoteFingerprint ?? ""}`,
    );
  }, [form, occurrenceAllocations, occurrenceQuoteFingerprint]);

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
    locationId: leagueInfo?.locationId ?? null,
    amountCents: watchedAmount || 0,
    enabled: open && paymentType === 'credit_card' && supportsWallets
      && occurrenceReadiness === 'ready',
    onPaymentStarted: beginWalletPayment,
    onTokenReceived: handleWalletPayment,
    onError: (error) => setPaymentError(error),
  });

  useEffect(() => {
    if (!open) {
      cleanupWallet();
    }
  }, [open, cleanupWallet]);

  useEffect(() => {
    setOccurrenceAllocations([]);
    setOccurrenceQuoteFingerprint(undefined);
    setOccurrenceReadiness(open && (paymentType === 'credit_card' || leagueInfo?.payingLineupSize != null) ? 'loading' : 'disabled');
  }, [open, selectedBowlerId, leagueInfo?.id, leagueInfo?.payingLineupSize, paymentType]);

  // When the selected bowler has no email on file, capture one inline so
  // Square's hosted receipt still fires for this charge.
  const selectedBowler = bowlers.find((b) => b.id === selectedBowlerId);
  const bowlerHasEmail = !!selectedBowler?.email;

  const onSubmit = usePaymentFormSubmit({
    form,
    card,
    cardMode,
    selectedSavedCardId,
    setPaymentError,
    onClose,
    buyerEmail: !bowlerHasEmail ? receiptEmail : undefined,
    locationId: leagueInfo?.locationId ?? null,
    organizationId: leagueInfo?.organizationId,
    canonical: true,
    occurrenceAllocations,
    occurrenceQuoteFingerprint,
    occurrenceReadiness,
    allowStoreCard,
  });
  const handleOccurrenceChange = useCallback((next: { obligationId: string; amountMinor: number }[], fingerprint?: string) => {
    setOccurrenceAllocations(next);
    setOccurrenceQuoteFingerprint(fingerprint);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
        </DialogHeader>
        {leagueInfo && (leagueInfo.squareLineageItemName || leagueInfo.squarePrizeFundItemName) && (
          <PaymentFeeInfoAlert league={leagueInfo} />
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {paymentError && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>{paymentError}</AlertDescription>
              </Alert>
            )}
            <PaymentFormFields form={form} bowlers={bowlers} />
            {selectedBowlerId && leagueInfo && (paymentType === "credit_card" || leagueInfo.payingLineupSize != null) && (
              <InteractiveOccurrenceSelector
                leagueId={leagueInfo.id}
                organizationId={leagueInfo.organizationId ?? undefined}
                timezone={leagueInfo.timezone || DEFAULT_TIMEZONE}
                amountMinor={watchedAmount || 0}
                bowlerIds={[selectedBowlerId]}
                enabled={open}
                onChange={handleOccurrenceChange}
                onReadinessChange={setOccurrenceReadiness}
              />
            )}
            <PaymentMethodTabs
              form={form}
              paymentType={paymentType}
              squareLoadFailed={squareLoadFailed}
              allowCard={!paymentManager}
            />
            {paymentType === "check" && <PaymentCheckNumberField form={form} />}
            {/* Square requires a buyer email for hosted receipts. */}
            {paymentType === "credit_card" && selectedBowlerId && !bowlerHasEmail && (
              <PaymentReceiptEmailField value={receiptEmail} onChange={setReceiptEmail} />
            )}
            {paymentType === "credit_card" && providerNotFullyConfigured && (
              <PaymentProviderNotConfiguredAlert
                missingFields={providerMissingFields}
                isAdmin={isAdmin}
                onOpenSettings={() => {
                  const locId = leagueInfo?.locationId ?? null;
                  navigate(locId ? `/integrations?location=${locId}` : '/integrations');
                }}
              />
            )}
            {paymentType === "credit_card" && !providerNotFullyConfigured && (
              <PaymentCreditCardSection
                form={form}
                savedCards={savedCards}
                cardMode={cardMode}
                setCardMode={setCardMode}
                selectedSavedCardId={selectedSavedCardId}
                setSelectedSavedCardId={setSelectedSavedCardId}
                isSquareReady={isSquareReady}
                squareError={cardError}
                squareLoadFailed={squareLoadFailed}
                cardContainerRef={cardContainerRef}
                onCleanupCard={cleanupCard}
                initializationAttempted={initializationAttempted}
                setIsSquareReady={setIsSquareReady}
                applePayAvailable={supportsWallets && applePayAvailable}
                googlePayAvailable={supportsWallets && googlePayAvailable}
                applePayRef={applePayRef}
                googlePayRef={googlePayRef}
                onApplePayClick={handleApplePayClick}
                onGooglePayClick={handleGooglePayClick}
                isWalletProcessing={isWalletProcessing}
                applePayTokenizeOnly={applePayTokenizeOnly}
                googlePayTokenizeOnly={googlePayTokenizeOnly}
                allowStoreCard={allowStoreCard}
              />
            )}
            <PaymentFormActions
              onCancel={onClose}
              isSubmitting={form.formState.isSubmitting}
              isWalletProcessing={isWalletProcessing}
              paymentType={paymentType}
              providerNotFullyConfigured={providerNotFullyConfigured}
              cardMode={cardMode}
              isSquareReady={isSquareReady}
              selectedSavedCardId={selectedSavedCardId}
              selectedBowlerId={selectedBowlerId}
              bowlerHasEmail={bowlerHasEmail}
              receiptEmail={receiptEmail}
              occurrenceReadiness={occurrenceReadiness}
            />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
