import { FC, useRef, type CSSProperties, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CreditCard, Loader2, Minus, Plus, Wallet } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { SavedCard } from "@shared/schema";

const WALLET_STYLE: CSSProperties = { WebkitAppearance: "none", appearance: "none", backgroundColor: "#000", border: "none", borderRadius: "5px", width: "100%", height: "48px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 };

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
  }>;
}

interface Props {
  paymentAmountMinor: number;
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
  selectionStale?: boolean;
  onRecipientToggle: (bowlerId: number, selected: boolean) => void;
  onRecipientWeeksChange: (bowlerId: number, weeks: number) => void;
  onResetRecipientSelection?: () => void;
}

export const BowlerOneTimePaymentCard: FC<Props> = ({
  paymentAmountMinor,
  fullBalanceOnly = false, savedCards, cardMode, setCardMode, selectedSavedCardId,
  setSelectedSavedCardId, storeCard, setStoreCard, isInitialized, isSubmitting,
  onSubmit, initializeCard, cleanupCard,
  onCardEditorModeChange, cardEditorMode, applePayAvailable, googlePayAvailable,
  applePayTokenizeOnly, googlePayTokenizeOnly, applePayRef, googlePayRef,
  onApplePayClick, onGooglePayClick, isWalletProcessing, bowlerHasEmail,
  receiptEmail, onReceiptEmailChange, recipientRows, breakdownRows, quoteLoading = false,
  quoteError = null, selectionStale = false, onRecipientToggle, onRecipientWeeksChange,
  onResetRecipientSelection,
}) => {
  const cardCallbackRef = useRef<(el: HTMLDivElement | null) => void>(() => undefined);
  cardCallbackRef.current = (el) => { if (el && cardMode === "new" && cardEditorMode === "one-time") void initializeCard(el); };
  const paymentInFlight = isSubmitting || isWalletProcessing;
  const showWallet = applePayAvailable || googlePayAvailable;
  const hasSelectedRecipient = recipientRows.some((row) => row.selected);

  return (
    <Card data-testid="one-time-payment-card">
      <CardHeader>
        <CardTitle>One-Time Payment</CardTitle>
        {!fullBalanceOnly && <CardDescription>Choose who to pay and how many weeks to cover. Each recipient is paid oldest-first.</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="flex flex-col gap-3" aria-label="Payment recipients">
              <legend className="text-sm font-medium">Who would you like to pay?</legend>
              {recipientRows.map((row) => (
                <div key={row.bowlerId} className="rounded-md border bg-muted/50 p-4" data-testid={`payment-recipient-${row.bowlerId}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={`payment-recipient-${row.bowlerId}-checkbox`}
                      checked={row.selected}
                      disabled={paymentInFlight || !row.eligible}
                      onCheckedChange={(checked) => onRecipientToggle(row.bowlerId, checked === true)}
                      aria-label={`Pay ${row.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <Label htmlFor={`payment-recipient-${row.bowlerId}-checkbox`} className="cursor-pointer text-sm font-semibold">
                        {row.name}{row.role === "self" ? " (You)" : " (Partner)"}
                      </Label>
                      <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:gap-4">
                        <span>Remaining balance: {formatCurrency(row.remainingMinor)}</span>
                        <span>Past due: {formatCurrency(row.pastDueMinor)}</span>
                      </div>
                      {!row.eligible && row.reason && <p className="mt-2 text-xs text-muted-foreground">{row.reason}</p>}
                      {row.selected && row.eligible && (
                        fullBalanceOnly ? (
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
                            <span>Full Season Remaining Balance</span>
                            <span className="font-semibold">{formatCurrency(row.remainingMinor)} · {row.maximumWeekCount} {row.maximumWeekCount === 1 ? "week" : "weeks"}</span>
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
                            <span className="text-sm text-muted-foreground">Weeks</span>
                            <Button type="button" variant="outline" size="icon" aria-label={`Pay ${row.name} for one fewer week`} disabled={paymentInFlight || row.weeks <= 1} onClick={() => onRecipientWeeksChange(row.bowlerId, row.weeks - 1)}><Minus className="size-4" /></Button>
                            <output aria-label={`Number of weeks to pay for ${row.name}`} className="min-w-8 text-center text-lg font-semibold">{row.weeks}</output>
                            <Button type="button" variant="outline" size="icon" aria-label={`Pay ${row.name} for one more week`} disabled={paymentInFlight || row.weeks >= row.maximumWeekCount} onClick={() => onRecipientWeeksChange(row.bowlerId, row.weeks + 1)}><Plus className="size-4" /></Button>
                            <span className="ml-auto text-sm font-semibold">{formatCurrency(row.amountMinor)}</span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ))}
        </fieldset>
        {!hasSelectedRecipient && <Alert><AlertDescription>Select at least one recipient to continue.</AlertDescription></Alert>}
        {selectionStale && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>The payment choices changed while this page was open. Review the recipients and week counts before paying.</span>{onResetRecipientSelection && <Button type="button" variant="outline" size="sm" onClick={onResetRecipientSelection}>Reset choices</Button>}</AlertDescription></Alert>}
        {quoteError && <Alert variant="destructive"><AlertDescription>{quoteError}</AlertDescription></Alert>}
        <div className="flex flex-col gap-2 rounded-md border bg-muted/50 p-4" aria-live="polite" data-testid="payment-breakdown">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Payment total</span>
            <span className="text-lg font-bold">{quoteLoading ? "Calculating…" : formatCurrency(paymentAmountMinor)}</span>
          </div>
          {breakdownRows && breakdownRows.length > 0 && !quoteLoading && (
            <div className="flex flex-col gap-2 border-t pt-3 text-sm">
              {breakdownRows.map((row) => (
                <div key={row.bowlerId} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{row.name}</span>
                    <span className="shrink-0 font-medium">{formatCurrency(row.amountMinor)}</span>
                  </div>
                  <div className="flex flex-col gap-1 pl-3 text-xs text-muted-foreground">
                    {(row.allocations.length > 0 ? row.allocations : row.coveredWeeks.map((label) => ({ obligationId: null, label, amountMinor: 0, occurrenceLocalDate: "", plannedOrdinal: null }))).map((allocation, index) => (
                      <div key={`${row.bowlerId}-${allocation.obligationId ?? "unlinked"}-${allocation.plannedOrdinal ?? (allocation.occurrenceLocalDate || index)}-${index}`} className="flex items-center justify-between gap-3">
                        <span>{allocation.label}{allocation.occurrenceLocalDate ? ` · ${allocation.occurrenceLocalDate}` : ""}</span>
                        {allocation.amountMinor > 0 && <span>{formatCurrency(allocation.amountMinor)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!applePayTokenizeOnly && applePayRef && <div ref={applePayRef} className={applePayAvailable ? "min-h-[48px] overflow-hidden rounded-md bg-black" : undefined} style={applePayAvailable ? undefined : { display: "none" }} />}
        {applePayAvailable && applePayTokenizeOnly && <button type="button" aria-label="Pay with Apple Pay" onClick={() => void onApplePayClick()} disabled={isWalletProcessing} style={{ ...WALLET_STYLE, opacity: isWalletProcessing ? 0.5 : 1 }}><span className="text-xl font-medium text-white"> Pay</span></button>}
        {!googlePayTokenizeOnly && googlePayRef && <div ref={googlePayRef} className={googlePayAvailable ? "min-h-[48px] overflow-hidden rounded-md bg-black" : undefined} style={googlePayAvailable ? undefined : { display: "none" }} />}
        {googlePayAvailable && googlePayTokenizeOnly && <button type="button" aria-label="Pay with Google Pay" onClick={() => void onGooglePayClick()} disabled={isWalletProcessing} style={{ ...WALLET_STYLE, opacity: isWalletProcessing ? 0.5 : 1 }}><span className="text-sm font-medium text-white">Google Pay</span></button>}
        {isWalletProcessing && <div className="flex items-center justify-center gap-2 py-2"><Loader2 className="size-4 animate-spin" /><span className="text-sm text-muted-foreground">Processing wallet payment…</span></div>}
        {showWallet && <div className="relative flex items-center gap-4 py-2"><div className="flex-1 border-t" /><span className="text-xs text-muted-foreground">or pay with card</span><div className="flex-1 border-t" /></div>}

        {savedCards.length > 0 && <div className="flex gap-2"><Button type="button" variant={cardMode === "saved" ? "default" : "outline"} size="sm" onClick={() => { cleanupCard(); onCardEditorModeChange(null); setCardMode("saved"); }}><Wallet className="mr-2 size-4" />Saved Card</Button><Button type="button" variant={cardMode === "new" ? "default" : "outline"} size="sm" onClick={() => { cleanupCard(); setCardMode("new"); onCardEditorModeChange("one-time"); }}><CreditCard className="mr-2 size-4" />New Card</Button></div>}
        {cardMode === "saved" && savedCards.length > 0 ? <Select value={selectedSavedCardId} onValueChange={setSelectedSavedCardId}><SelectTrigger><SelectValue placeholder="Select a saved card" /></SelectTrigger><SelectContent>{savedCards.map((card) => <SelectItem key={card.id} value={card.id}>{card.brand} ending in {card.last4} (exp {card.expMonth}/{card.expYear})</SelectItem>)}</SelectContent></Select> : <div className="space-y-3"><span className="text-sm font-medium">Card Details</span><div ref={(element) => cardCallbackRef.current(element)} className="min-h-[80px] rounded-md border p-3" style={cardEditorMode === "one-time" ? undefined : { display: "none" }} /><div className="flex items-center gap-x-3"><Checkbox id="store-card-make-payment" checked={storeCard} onCheckedChange={(checked) => setStoreCard(checked === true)} /><Label htmlFor="store-card-make-payment" className="text-sm cursor-pointer">Save this card for future payments</Label></div></div>}
        {!bowlerHasEmail && <div className="space-y-2 rounded-md border bg-muted/30 p-3"><Label htmlFor="make-payment-receipt-email" className="text-sm font-medium">Email for receipt <span className="text-destructive">*</span></Label><Input id="make-payment-receipt-email" type="email" placeholder="you@example.com" value={receiptEmail} onChange={(event) => onReceiptEmailChange(event.target.value)} /><p className="text-xs text-muted-foreground">We don't have an email on file for you. Add one to get a Square receipt for this payment.</p></div>}
        <Button onClick={onSubmit} disabled={(cardMode === "new" && !isInitialized) || (cardMode === "saved" && !selectedSavedCardId) || isSubmitting || isWalletProcessing || paymentAmountMinor <= 0 || !hasSelectedRecipient || quoteLoading || Boolean(quoteError) || selectionStale || (!bowlerHasEmail && !receiptEmail.trim())} className="w-full">{isSubmitting ? <><Loader2 className="mr-2 size-4 animate-spin" />Processing…</> : <><CreditCard className="mr-2 size-4" />Pay {formatCurrency(paymentAmountMinor)}</>}</Button>
      </CardContent>
    </Card>
  );
};
