/* eslint-disable shadcn/no-restyle */
import { FC, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowRight, CheckCircle2, ChevronDown, CreditCard, Loader2, Minus, Plus, Wallet } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { SavedCard } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function formatPayCurrency(amountMinor: number): string {
  const formatted = formatCurrency(amountMinor);
  return amountMinor % 100 === 0 ? formatted.replace(/\.00$/, "") : formatted;
}

export interface PaymentRecipientRow {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  remainingMinor: number;
  pastDueMinor: number;
  weeks: number;
  maximumWeekCount: number;
  amountMinor: number;
  selected: boolean;
  eligible: boolean;
  reason: string | null;
}

export interface PaymentBreakdownRow {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  amountMinor: number;
  coveredWeeks: string[];
  allocations: Array<{
    obligationId: string | null;
    amountMinor: number;
    occurrenceLocalDate: string;
    plannedOrdinal: number | null;
    label: string;
    isPairedFinalWeek: boolean;
  }>;
}

export interface CompletedPayment {
  amountMinor: number;
  coverage: string;
  isUpfront: boolean;
  hasRemainingBalance: boolean;
  recipients: Array<{
    bowlerId: number;
    name: string;
    role: "self" | "partner";
    amountMinor: number;
    coverage: string;
  }>;
}

interface CoveragePart {
  name: string;
  normalLabel: string | null;
  pairedLabels: string[];
}

function formatCoverageLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0] ?? "";
  const weekLabels = labels.map((label) => label.match(/^Week (\d+)$/));
  if (weekLabels.every((match): match is RegExpMatchArray => match !== null)) {
    const ordinals = weekLabels.map((match) => match[1]);
    return `Weeks ${ordinals.slice(0, -1).join(", ")} and ${ordinals.at(-1)}`;
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function pairedLabelKey(allocation: PaymentBreakdownRow["allocations"][number]): string {
  return allocation.plannedOrdinal === null || allocation.plannedOrdinal === undefined
    ? `label:${allocation.label}`
    : `ordinal:${allocation.plannedOrdinal}`;
}

function coveragePartForRow(row: PaymentBreakdownRow): Omit<CoveragePart, "name"> {
  const allocations = row.allocations.length > 0
    ? row.allocations
    : row.coveredWeeks.map((label) => ({
      obligationId: null,
      amountMinor: 0,
      occurrenceLocalDate: "",
      plannedOrdinal: null,
      label,
      isPairedFinalWeek: false,
    }));
  const normalAllocations = allocations.filter((allocation) => !allocation.isPairedFinalWeek);
  const pairedLabels: string[] = [];
  const seenPairedLabels = new Set<string>();
  for (const allocation of allocations) {
    if (!allocation.isPairedFinalWeek) continue;
    const key = pairedLabelKey(allocation);
    if (seenPairedLabels.has(key)) continue;
    seenPairedLabels.add(key);
    pairedLabels.push(allocation.label);
  }
  return { normalLabel: normalAllocations.at(-1)?.label ?? null, pairedLabels };
}

function formatCoveragePart(part: CoveragePart): string {
  const included = part.pairedLabels.length > 0
    ? ` and includes ${formatCoverageLabels(part.pairedLabels)}`
    : "";
  const coverage = part.normalLabel
    ? `through ${part.normalLabel}${included}`
    : part.pairedLabels.length > 0
      ? formatCoverageLabels(part.pairedLabels)
      : null;
  if (!coverage) return "";
  return part.name ? `${part.name}: ${coverage}` : coverage;
}

function formatReviewCoverage(labels: string[], fallbackWeekCount: number): string {
  if (labels.length === 0) return fallbackWeekCount === 1 ? "Week 1" : `Weeks 1–${fallbackWeekCount}`;
  const numbers = labels.map((label) => label.match(/^Week (\d+)$/)?.[1]);
  if (numbers.every((number): number is string => number !== undefined)) {
    const first = Number(numbers[0]);
    const last = Number(numbers.at(-1));
    if (first === last) return `Week ${first}`;
    if (numbers.every((number, index) => index === 0 || Number(number) === Number(numbers[index - 1]) + 1)) return `Weeks ${first}–${last}`;
  }
  return formatCoverageLabels(labels);
}

function formatFullBalanceReviewCoverage(labels: string[], fallbackWeekCount: number): string {
  const weekNumbers = labels.map((label) => Number(label.match(/\d+/)?.[0])).filter((week): week is number => Number.isInteger(week));
  if (weekNumbers.length > 0) {
    const first = Math.min(...weekNumbers);
    const last = Math.max(...weekNumbers);
    return first === last ? `Week ${first}` : `Weeks ${first}–${last}`;
  }
  return fallbackWeekCount === 1 ? "Week 1" : `Weeks 1–${fallbackWeekCount}`;
}

interface Props {
  paymentAmountMinor: number;
  leagueName?: string;
  quoteFingerprint?: string | null;
  completedPayment?: CompletedPayment | null;
  onViewPaymentHistory?: () => void;
  onMakeAnotherPayment?: () => void;
  fullBalanceOnly?: boolean;
  savedCards: SavedCard[];
  cardMode: "new" | "saved";
  setCardMode: (mode: "new" | "saved") => void;
  selectedSavedCardId: string;
  setSelectedSavedCardId: (id: string) => void;
  storeCard: boolean;
  setStoreCard: (store: boolean) => void;
  isInitialized: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  initializeCard: (el: HTMLDivElement) => Promise<void>;
  cleanupCard: () => void;
  onCardEditorModeChange: (mode: "one-time" | null) => void;
  cardEditorMode: "one-time" | "autopay" | null;
  applePayAvailable: boolean;
  googlePayAvailable: boolean;
  applePayTokenizeOnly: boolean;
  googlePayTokenizeOnly: boolean;
  applePayRef: RefObject<HTMLDivElement | null>;
  googlePayRef: RefObject<HTMLDivElement | null>;
  onApplePayClick: () => Promise<void>;
  onGooglePayClick: () => Promise<void>;
  isWalletProcessing: boolean;
  bowlerHasEmail: boolean;
  receiptEmail: string;
  onReceiptEmailChange: (email: string) => void;
  recipientRows: PaymentRecipientRow[];
  breakdownRows?: PaymentBreakdownRow[];
  quoteLoading?: boolean;
  quoteError?: string | null;
  onRetryQuote?: () => void;
  paymentRefreshState?: "idle" | "refreshing" | "retry";
  paymentRefreshError?: string | null;
  onRetryPaymentRefresh?: () => void;
  selectionStale?: boolean;
  onRecipientToggle: (bowlerId: number, selected: boolean) => void;
  onRecipientWeeksChange: (bowlerId: number, weeks: number) => void;
  onResetRecipientSelection?: () => void;
  /** Lock this checkout to the payer's exact due-now amount for enrollment. */
  dueNowOnly?: boolean;
  /** Rotating-pool members use a one-time presentation without balance boxes or autopay language. */
  rotatingMode?: boolean;
  onCancelDueNow?: () => void;
  combinedConsentRecovery?: {
    message: string;
    onRetry: () => void;
    isRetrying: boolean;
  } | null;
}

export const BowlerOneTimePaymentCard: FC<Props> = ({
  paymentAmountMinor,
  leagueName = "Selected league", quoteFingerprint = null, completedPayment = null,
  onViewPaymentHistory, onMakeAnotherPayment,
  fullBalanceOnly = false, savedCards, cardMode, setCardMode, selectedSavedCardId,
  setSelectedSavedCardId, storeCard, setStoreCard, isInitialized, isSubmitting,
  onSubmit, initializeCard, cleanupCard,
  onCardEditorModeChange, cardEditorMode, applePayAvailable, googlePayAvailable,
  applePayTokenizeOnly, googlePayTokenizeOnly, applePayRef, googlePayRef,
  onApplePayClick, onGooglePayClick, isWalletProcessing, bowlerHasEmail,
  receiptEmail, onReceiptEmailChange, recipientRows, breakdownRows, quoteLoading = false,
  quoteError = null, selectionStale = false, onRecipientToggle, onRecipientWeeksChange,
  onResetRecipientSelection, paymentRefreshState = "idle", paymentRefreshError = null,
  onRetryPaymentRefresh, onRetryQuote, dueNowOnly = false, onCancelDueNow,
  combinedConsentRecovery = null, rotatingMode = false,
}) => {
  const cardCallbackRef = useRef<(el: HTMLDivElement | null) => void>(() => undefined);
  cardCallbackRef.current = (el) => { if (el && cardMode === "new" && cardEditorMode === "one-time") void initializeCard(el); };
  const paymentInFlight = isSubmitting || isWalletProcessing || paymentRefreshState !== "idle";
  const hasWalletOptions = applePayAvailable || googlePayAvailable;
  const hasPaymentPartner = recipientRows.some((row) => row.role === "partner");
  const showRecipientChooser = hasPaymentPartner && !dueNowOnly;
  const showSoloWeekSelection = !hasPaymentPartner && !dueNowOnly && !fullBalanceOnly && !rotatingMode;
  const compactFullBalanceRows = fullBalanceOnly && hasPaymentPartner;
  const showRecipientRows = hasPaymentPartner || dueNowOnly || showSoloWeekSelection;
  const hasSelectedRecipient = recipientRows.some((row) => row.selected);
  const selectionStaleMessage = "The available bowler or payment details changed while this page was open. Review the available bowler and payment details before paying.";
  const [sourceOpen, setSourceOpen] = useState(savedCards.length === 0 || fullBalanceOnly);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewFingerprintRef = useRef<string | null>(null);
  const previousSavedCardCountRef = useRef(savedCards.length);
  useEffect(() => {
    if (savedCards.length === 0 || fullBalanceOnly) setSourceOpen(true);
    if (previousSavedCardCountRef.current === 0 && savedCards.length > 0) setSourceOpen(false);
    previousSavedCardCountRef.current = savedCards.length;
  }, [fullBalanceOnly, savedCards.length]);
  const selectedCard = savedCards.find((candidate) => candidate.id === selectedSavedCardId);
  const selectedSourceLabel = cardMode === "new"
    ? "Use a new card"
    : selectedCard
      ? `${selectedCard.brand} ending in ${selectedCard.last4}`
      : "Choose a saved card";
  const selectedCoverageRows = (breakdownRows ?? [])
    .filter((row) => recipientRows.some((recipient) => recipient.bowlerId === row.bowlerId && recipient.selected));
  const coverageParts: CoveragePart[] = selectedCoverageRows.map((row) => ({
    name: selectedCoverageRows.length > 1 ? row.name : "",
    ...coveragePartForRow(row),
  }));
  const formattedCoverageParts = coverageParts.map(formatCoveragePart).filter(Boolean);
  const fullBalanceCoverageParts = recipientRows
    .filter((row) => row.selected && row.eligible)
    .map((row) => {
      const breakdown = breakdownRows?.find((candidate) => candidate.bowlerId === row.bowlerId);
      return `${row.name}: ${formatFullBalanceReviewCoverage(breakdown?.coveredWeeks ?? [], row.maximumWeekCount)}`;
    });
  const fallbackWeekCount = recipientRows.filter((row) => row.selected && row.eligible).reduce((total, row) => total + row.weeks, 0);
  const fullBalanceCoverageCopy = fullBalanceCoverageParts.length > 0
    ? fullBalanceCoverageParts.map((part) => hasPaymentPartner ? part : part.replace(/^[^:]+:\s*/, "")).join(" · ")
    : "the selected season balances";
  const coverageCopy = fullBalanceOnly
    ? `Covers ${fullBalanceCoverageCopy}`
    : rotatingMode
    ? `This payment covers ${fallbackWeekCount} ${fallbackWeekCount === 1 ? "week" : "weeks"}`
    : formattedCoverageParts.length > 0
    ? `This payment covers ${formattedCoverageParts.join(" · ")}`
    : `This payment covers ${fallbackWeekCount} ${fallbackWeekCount === 1 ? "week" : "weeks"}`;

  const checkoutFingerprint = JSON.stringify({
    quoteFingerprint,
    paymentAmountMinor,
    recipients: recipientRows.map((row) => ({
      bowlerId: row.bowlerId,
      selected: row.selected,
      eligible: row.eligible,
      weeks: row.weeks,
      amountMinor: row.amountMinor,
    })),
    cardMode,
    selectedSavedCardId: cardMode === "saved" ? selectedSavedCardId : null,
    selectedSourceLabel,
    storeCard: cardMode === "new" && storeCard,
  });

  useEffect(() => {
    if (reviewOpen && reviewFingerprintRef.current !== checkoutFingerprint) {
      reviewFingerprintRef.current = null;
      setReviewOpen(false);
    }
  }, [checkoutFingerprint, reviewOpen]);

  const closeReview = () => {
    reviewFingerprintRef.current = null;
    setReviewOpen(false);
  };

  const openReview = () => {
    reviewFingerprintRef.current = checkoutFingerprint;
    setReviewOpen(true);
  };

  const reviewCoverage = fullBalanceOnly
    ? fullBalanceCoverageCopy
    : coverageCopy.replace(/^This payment covers\s*/, "");
  const reviewRecipients = recipientRows.filter((row) => row.selected && row.eligible);
  const reviewQuoteForRecipient = (row: PaymentRecipientRow) => breakdownRows?.find((candidate) => candidate.bowlerId === row.bowlerId);
  const reviewCoverageForRecipient = (row: PaymentRecipientRow) => {
    const breakdown = reviewQuoteForRecipient(row);
    if (fullBalanceOnly) return formatFullBalanceReviewCoverage(breakdown?.coveredWeeks ?? [], row.maximumWeekCount);
    if (breakdown) {
      const allocationAwareCoverage = breakdown.allocations.length > 0
        ? formatCoveragePart({ name: "", ...coveragePartForRow(breakdown) })
        : "";
      if (allocationAwareCoverage) return allocationAwareCoverage;
    }
    return formatReviewCoverage(breakdown?.coveredWeeks ?? [], row.maximumWeekCount);
  };
  const reviewDisabled = (cardMode === "new" && !isInitialized) || (cardMode === "saved" && !selectedSavedCardId)
    || paymentInFlight || paymentAmountMinor <= 0 || !hasSelectedRecipient || quoteLoading || Boolean(quoteError)
    || selectionStale || (!bowlerHasEmail && !receiptEmail.trim());

  if (completedPayment) {
    return (
      <Card data-testid="one-time-payment-success" className="familiar-one-time-card familiar-payment-success-card">
        <CardContent spacing="normal">
          <div className="familiar-payment-success" role="status">
            <CheckCircle2 className="familiar-payment-success-icon" aria-hidden="true" />
            <h2>{completedPayment.isUpfront ? "Upfront payment complete" : "Payment complete"}</h2>
            <p>{formatPayCurrency(completedPayment.amountMinor)} covered {completedPayment.coverage}.</p>
            {completedPayment.recipients.some((recipient) => recipient.role === "partner") && (
              <div className="familiar-payment-success-allocations" aria-label="Payment allocation">
                {completedPayment.recipients.map((recipient) => (
                  <div key={recipient.bowlerId}>
                    <span>{recipient.name}</span>
                    <strong>{formatPayCurrency(recipient.amountMinor)}</strong>
                    <small>{recipient.coverage}</small>
                  </div>
                ))}
              </div>
            )}
            <div className="familiar-payment-success-actions">
              {onViewPaymentHistory && <Button type="button" onClick={onViewPaymentHistory}>View payment history<ArrowRight aria-hidden="true" /></Button>}
              {onMakeAnotherPayment && completedPayment.hasRemainingBalance && <Button type="button" variant="outline" onClick={onMakeAnotherPayment}>{completedPayment.isUpfront ? "Pay remaining balance" : "Make another payment"}<ArrowRight aria-hidden="true" /></Button>}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="one-time-payment-card" data-full-balance={fullBalanceOnly ? "true" : undefined} data-rotating-mode={rotatingMode ? "true" : undefined} className="familiar-one-time-card familiar-partner-one-time-card">
      <CardHeader>
        <CardTitle>{fullBalanceOnly ? "Full season payment" : "One-time payment"}</CardTitle>
        {fullBalanceOnly && <div className="familiar-header-payment-total"><span>Payment total</span><strong>{formatPayCurrency(paymentAmountMinor)}</strong></div>}
        {showRecipientChooser && !fullBalanceOnly && <CardDescription>Choose who to pay and how many weeks to cover. Each recipient is paid oldest-first.</CardDescription>}
        {showRecipientChooser && fullBalanceOnly && <CardDescription>Pay for</CardDescription>}
        {!showRecipientChooser && !fullBalanceOnly && <CardDescription>Payments cover your oldest unpaid weeks first.</CardDescription>}
        {dueNowOnly && <CardDescription>Pay the amount needed to get up to date and enable automatic payments in one checkout.</CardDescription>}
      </CardHeader>
      <CardContent spacing="normal">
        {dueNowOnly && <Alert role="status"><AlertDescription><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span>We'll confirm automatic-payment setup after this payment.</span>{onCancelDueNow && <Button type="button" variant="ghost" size="sm" onClick={onCancelDueNow} disabled={paymentInFlight}>Cancel</Button>}</div></AlertDescription></Alert>}
        {combinedConsentRecovery && <Alert variant="destructive" role="alert"><AlertDescription><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span>{combinedConsentRecovery.message}</span><Button type="button" variant="outline" size="sm" onClick={combinedConsentRecovery.onRetry} disabled={combinedConsentRecovery.isRetrying}>{combinedConsentRecovery.isRetrying ? "Checking status…" : "Retry automatic payments"}</Button></div></AlertDescription></Alert>}
        <fieldset className="flex flex-col gap-3" aria-label="Payment recipients">
              {showRecipientChooser && !fullBalanceOnly && <legend className="text-sm font-medium">Who would you like to pay?</legend>}
              {(showRecipientRows ? recipientRows : []).map((row) => (
                <div key={row.bowlerId} className={showSoloWeekSelection ? "familiar-solo-week-selection" : compactFullBalanceRows ? "familiar-upfront-recipient-row" : `familiar-recipient-card rounded-md border bg-muted/50 p-4${row.selected ? " is-selected" : ""}`} data-testid={showSoloWeekSelection ? undefined : `payment-recipient-${row.bowlerId}`}>
                  <div className="flex items-start gap-3">
                    {showRecipientChooser && <Checkbox
                        id={`payment-recipient-${row.bowlerId}-checkbox`}
                        checked={row.selected}
                        disabled={paymentInFlight || !row.eligible}
                        onCheckedChange={(checked) => { closeReview(); onRecipientToggle(row.bowlerId, checked === true); }}
                        aria-label={`Pay ${row.name}`}
                    />}
                    <div className="min-w-0 flex-1">
                      {compactFullBalanceRows && row.eligible && row.selected ? <div className="familiar-upfront-recipient-summary"><Label htmlFor={`payment-recipient-${row.bowlerId}-checkbox`} size="sm" weight="semibold" className="cursor-pointer">{row.name}{row.role === "self" ? " (You)" : " (Partner)"}</Label><small>Full season · {row.maximumWeekCount} {row.maximumWeekCount === 1 ? "week" : "weeks"}</small><strong>{formatPayCurrency(row.amountMinor)}</strong></div> : !showSoloWeekSelection && (showRecipientChooser ? <Label htmlFor={`payment-recipient-${row.bowlerId}-checkbox`} size="sm" weight="semibold" className="cursor-pointer">
                          {row.name}{row.role === "self" ? " (You)" : " (Partner)"}
                        </Label> : <span className="text-sm font-semibold">{row.name}{row.role === "self" ? " (You)" : " (Partner)"}</span>)}
                      {!compactFullBalanceRows && !showSoloWeekSelection && !rotatingMode && <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:gap-4">
                        <span>Remaining balance: {formatPayCurrency(row.remainingMinor)}</span>
                        <span>Past due: {formatPayCurrency(row.pastDueMinor)}</span>
                      </div>}
                      {!row.eligible && row.reason && <p className="mt-2 text-xs text-muted-foreground">{row.reason}</p>}
                      {row.selected && row.eligible && !compactFullBalanceRows && (
                        fullBalanceOnly ? (
                          <div className="familiar-full-balance mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
                            <span>Full season remaining balance</span>
                            <span className="font-semibold">{formatPayCurrency(row.remainingMinor)} · {row.maximumWeekCount} {row.maximumWeekCount === 1 ? "week" : "weeks"}</span>
                          </div>
                        ) : dueNowOnly ? (
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
                            <span>Amount needed to get up to date</span>
                            <span className="font-semibold">{formatPayCurrency(row.amountMinor)}</span>
                          </div>
                        ) : (
                          <div className="familiar-week-stepper mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
                            <span className="text-sm text-muted-foreground">Weeks to pay</span>
                            <Button type="button" variant="outline" size="icon" aria-label={`Pay ${row.name} for one fewer week`} disabled={paymentInFlight || row.weeks <= 1} onClick={() => { closeReview(); onRecipientWeeksChange(row.bowlerId, row.weeks - 1); }}><Minus className="size-4" /></Button>
                            <output aria-label={`Number of weeks to pay for ${row.name}`} className="min-w-8 text-center text-lg font-semibold">{row.weeks}</output>
                            <Button type="button" variant="outline" size="icon" aria-label={`Pay ${row.name} for one more week`} disabled={paymentInFlight || row.weeks >= row.maximumWeekCount} onClick={() => { closeReview(); onRecipientWeeksChange(row.bowlerId, row.weeks + 1); }}><Plus className="size-4" /></Button>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ))}
        </fieldset>
        {hasSelectedRecipient && !dueNowOnly && !compactFullBalanceRows && <p className="familiar-payment-coverage" aria-live="polite">{coverageCopy}</p>}
        {recipientRows.length === 0 && <Alert><AlertDescription>No payment recipients are available for this league.</AlertDescription></Alert>}
        {showRecipientChooser && !hasSelectedRecipient && <Alert><AlertDescription>Select at least one recipient to continue.</AlertDescription></Alert>}
        {paymentRefreshState === "refreshing" && <Alert><AlertDescription>Refreshing payment balances before continuing…</AlertDescription></Alert>}
        {paymentRefreshState === "retry" && <Alert variant="destructive"><AlertDescription gap="3" className="flex flex-wrap items-center justify-between"><span>{paymentRefreshError ?? "Payment balances could not be refreshed. Try again."}</span>{onRetryPaymentRefresh && <Button type="button" variant="outline" size="sm" onClick={onRetryPaymentRefresh}>Retry refresh</Button>}</AlertDescription></Alert>}
        {selectionStale && <Alert variant="destructive"><AlertDescription gap="3" className="flex flex-wrap items-center justify-between"><span>{selectionStaleMessage}</span>{onResetRecipientSelection && <Button type="button" variant="outline" size="sm" onClick={onResetRecipientSelection}>Reset choices</Button>}</AlertDescription></Alert>}
        {quoteError && <Alert variant="destructive"><AlertDescription gap="3" className="flex flex-wrap items-center justify-between"><span>{quoteError}</span>{onRetryQuote && <Button type="button" variant="outline" size="sm" onClick={onRetryQuote}>Retry quote</Button>}</AlertDescription></Alert>}
        {!fullBalanceOnly && !rotatingMode && <div className="familiar-primary-payment-total"><span>Payment total</span><strong>{quoteLoading ? "Calculating…" : formatPayCurrency(paymentAmountMinor)}</strong></div>}
        <div className="familiar-payment-breakdown flex flex-col gap-2 rounded-md border bg-muted/50 p-4" aria-live="polite" data-testid="payment-breakdown">
          {!fullBalanceOnly && <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Payment total</span>
            <span className="text-lg font-bold">{quoteLoading ? "Calculating…" : formatPayCurrency(paymentAmountMinor)}</span>
          </div>}
          {breakdownRows && breakdownRows.length > 0 && !quoteLoading && (
            <div className="flex flex-col gap-2 border-t pt-3 text-sm">
              {breakdownRows.map((row) => (
                <div key={row.bowlerId} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{row.name}</span>
                    <span className="shrink-0 font-medium">{formatPayCurrency(row.amountMinor)}</span>
                  </div>
                  <div className="flex flex-col gap-1 pl-3 text-xs text-muted-foreground">
                    {(row.allocations.length > 0 ? row.allocations : row.coveredWeeks.map((label) => ({ obligationId: null, label, amountMinor: 0, occurrenceLocalDate: "", plannedOrdinal: null }))).map((allocation, index) => (
                      <div key={`${row.bowlerId}-${allocation.obligationId ?? "unlinked"}-${allocation.plannedOrdinal ?? (allocation.occurrenceLocalDate || index)}-${index}`} className="flex items-center justify-between gap-3">
                        <span>{allocation.label}{allocation.occurrenceLocalDate ? ` · ${allocation.occurrenceLocalDate}` : ""}</span>
                        {allocation.amountMinor > 0 && <span>{formatPayCurrency(allocation.amountMinor)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!dueNowOnly && <div className="familiar-wallets" aria-label="Device wallets">
          {!applePayTokenizeOnly && applePayRef && <div ref={applePayRef} className={applePayAvailable ? "min-h-12 overflow-hidden rounded-md bg-black" : "hidden"} />}
          {applePayAvailable && applePayTokenizeOnly && <button type="button" aria-label="Pay with Apple Pay" onClick={() => void onApplePayClick()} disabled={paymentInFlight} className="wallet-button h-12 disabled:opacity-50"><span className="text-xl font-medium text-white"> Pay</span></button>}
          {!googlePayTokenizeOnly && googlePayRef && <div ref={googlePayRef} className={googlePayAvailable ? "min-h-12 overflow-hidden rounded-md bg-black" : "hidden"} />}
          {googlePayAvailable && googlePayTokenizeOnly && <button type="button" aria-label="Pay with Google Pay" onClick={() => void onGooglePayClick()} disabled={paymentInFlight} className="wallet-button h-12 disabled:opacity-50"><span className="text-sm font-medium text-white">Google Pay</span></button>}
          {isWalletProcessing && <div className="flex items-center justify-center gap-2 py-2"><Loader2 className="size-4 animate-spin" /><span className="text-sm text-muted-foreground">Processing wallet payment…</span></div>}
          {hasWalletOptions && <div className="familiar-payment-divider" aria-hidden="true"><span>Pay with a card</span></div>}
        </div>}

        {fullBalanceOnly && <div className="familiar-source-label">Pay with a card</div>}
        <div className="familiar-source-picker">
          <button type="button" className="familiar-source-trigger" aria-expanded={sourceOpen} aria-haspopup="listbox" onClick={() => setSourceOpen((open) => !open)} disabled={paymentInFlight}>
            <span className="familiar-source-icon" aria-hidden="true">{cardMode === "saved" ? <Wallet className="size-5" /> : <CreditCard className="size-5" />}</span>
            <span className="familiar-source-copy"><strong>{selectedSourceLabel}</strong><small>{cardMode === "saved" ? "Saved payment method" : "Enter card details securely"}</small></span>
            <ChevronDown className={sourceOpen ? "is-open" : ""} size={18} aria-hidden="true" />
          </button>
          {sourceOpen && <div className="familiar-source-menu" role="listbox" aria-label="Payment source">
            {savedCards.map((candidate) => <button key={candidate.id} type="button" role="option" aria-selected={cardMode === "saved" && selectedSavedCardId === candidate.id} className={`familiar-source-option${cardMode === "saved" && selectedSavedCardId === candidate.id ? " is-selected" : ""}`} onClick={() => { cleanupCard(); onCardEditorModeChange(null); setCardMode("saved"); setSelectedSavedCardId(candidate.id); closeReview(); setSourceOpen(false); }}><span><strong>{candidate.brand} ending in {candidate.last4}</strong><small>Saved card · exp {candidate.expMonth}/{candidate.expYear}</small></span>{cardMode === "saved" && selectedSavedCardId === candidate.id && <span aria-hidden="true">✓</span>}</button>)}
            <button type="button" role="option" aria-selected={cardMode === "new"} className={`familiar-source-option${cardMode === "new" ? " is-selected" : ""}`} onClick={() => { cleanupCard(); setCardMode("new"); onCardEditorModeChange("one-time"); closeReview(); setSourceOpen(true); }}><span><strong>Use a new card</strong><small>Card details</small></span>{cardMode === "new" && <span aria-hidden="true">✓</span>}</button>
            {cardMode === "new" && <div className="familiar-card-editor" role="group" aria-label="Card details"><span className="text-sm font-medium">Card details</span><div ref={(element) => cardCallbackRef.current(element)} className={cardEditorMode === "one-time" ? "min-h-20 rounded-md border p-3" : "min-h-20 rounded-md border p-3 hidden"} /><div className="flex items-center gap-x-3"><Checkbox id="store-card-make-payment" checked={dueNowOnly ? true : storeCard} disabled={dueNowOnly} onCheckedChange={(checked) => setStoreCard(checked === true)} /><Label htmlFor="store-card-make-payment" size="sm" className="cursor-pointer">{dueNowOnly ? "Save this card to enroll in recurring automatic payments" : "Save this card for future payments"}</Label></div></div>}
          </div>}
        </div>
        {!bowlerHasEmail && <div className="space-y-2 rounded-md border bg-muted/30 p-3"><Label htmlFor="make-payment-receipt-email" size="sm">Email for receipt <span className="text-destructive">*</span></Label><Input id="make-payment-receipt-email" type="email" placeholder="you@example.com" value={receiptEmail} onChange={(event) => onReceiptEmailChange(event.target.value)} /><p className="text-xs text-muted-foreground">We don't have an email on file for you. Add one to get a Square receipt for this payment.</p></div>}
        <Dialog open={reviewOpen} onOpenChange={(open) => { if (open) openReview(); else closeReview(); }}>
          <DialogContent className="familiar-payment-review-dialog">
            <DialogHeader className="familiar-payment-review-header">
              <DialogTitle>{fullBalanceOnly ? "Review upfront payment" : "Review payment"}</DialogTitle>
              <DialogDescription>{dueNowOnly ? "Check the payment details before confirming and enrolling in recurring automatic payments." : "Check the payment details before confirming."}</DialogDescription>
            </DialogHeader>
            <dl className="familiar-payment-review-details">
              <div><dt>League</dt><dd>{leagueName}</dd></div>
              {hasPaymentPartner
                ? reviewRecipients.map((row) => {
                  const quoteRow = reviewQuoteForRecipient(row);
                  return <div className="familiar-payment-review-recipient" key={row.bowlerId}><dt>{row.name}</dt><dd>{reviewCoverageForRecipient(row)} · {quoteRow ? formatPayCurrency(quoteRow.amountMinor) : "Quote unavailable"}</dd></div>;
                })
                : <div><dt>Weeks covered</dt><dd>{reviewCoverage}</dd></div>}
              <div><dt>Method</dt><dd>{selectedSourceLabel}</dd></div>
              <div><dt>Total</dt><dd>{formatPayCurrency(paymentAmountMinor)}</dd></div>
              {cardMode === "new" && (storeCard || dueNowOnly) && <div><dt>Card on file</dt><dd>{dueNowOnly ? "Save card for recurring automatic payments" : "Save card for later"}</dd></div>}
            </dl>
            <DialogFooter className="familiar-payment-review-actions">
              <Button type="button" onClick={() => { closeReview(); onSubmit(); }} disabled={reviewDisabled}>{dueNowOnly ? "Confirm payment and enable automatic payments" : "Confirm payment"}</Button>
              <Button type="button" variant="outline" onClick={closeReview} disabled={isSubmitting || isWalletProcessing}>Go back</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button type="button" onClick={openReview} disabled={reviewDisabled} aria-haspopup="dialog" className="w-full">
          {isSubmitting ? <><Loader2 className="mr-2 size-4 animate-spin" />Processing…</> : <>{fullBalanceOnly ? "Review payment" : paymentAmountMinor > 0 ? `Review payment of ${formatPayCurrency(paymentAmountMinor)}` : "Review payment"}<ArrowRight className="ml-auto size-4" aria-hidden="true" /></>}
        </Button>
      </CardContent>
    </Card>
  );
};
