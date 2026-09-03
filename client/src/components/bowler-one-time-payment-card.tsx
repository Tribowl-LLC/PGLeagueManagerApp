import { FC, useRef, type CSSProperties, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CreditCard, Loader2, Minus, Plus, Wallet } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { SavedCard } from "@shared/schema";

const WALLET_STYLE: CSSProperties = { WebkitAppearance: "none", appearance: "none", backgroundColor: "#000", border: "none", borderRadius: "5px", width: "100%", height: "48px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 };

interface Props {
  remainingBalance: number;
  paymentWeekCount: number;
  maximumWeekCount: number;
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
  onPaymentWeekCountChange: (value: number) => void;
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
}

export const BowlerOneTimePaymentCard: FC<Props> = ({
  remainingBalance, paymentWeekCount, maximumWeekCount, paymentAmountMinor,
  fullBalanceOnly = false, savedCards, cardMode, setCardMode, selectedSavedCardId,
  setSelectedSavedCardId, storeCard, setStoreCard, isInitialized, isSubmitting,
  onSubmit, onPaymentWeekCountChange, initializeCard, cleanupCard,
  onCardEditorModeChange, cardEditorMode, applePayAvailable, googlePayAvailable,
  applePayTokenizeOnly, googlePayTokenizeOnly, applePayRef, googlePayRef,
  onApplePayClick, onGooglePayClick, isWalletProcessing, bowlerHasEmail,
  receiptEmail, onReceiptEmailChange,
}) => {
  const cardCallbackRef = useRef<(el: HTMLDivElement | null) => void>(() => undefined);
  cardCallbackRef.current = (el) => { if (el && cardMode === "new" && cardEditorMode === "one-time") void initializeCard(el); };
  const paymentInFlight = isSubmitting || isWalletProcessing;
  const showWallet = applePayAvailable || googlePayAvailable;

  return (
    <Card data-testid="one-time-payment-card">
      <CardHeader>
        <CardTitle>One-Time Payment</CardTitle>
        {!fullBalanceOnly && <CardDescription>Choose how many weeks to pay. Your payment is automatically applied to your oldest open week first.</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3 rounded-md border bg-muted/50 p-4">
          {fullBalanceOnly ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Full Season Remaining Balance</span>
              <span className="text-lg font-bold">{formatCurrency(remainingBalance)}</span>
            </div>
          ) : (
            <>
              <Label>Number of weeks</Label>
              <div className="flex items-center justify-center gap-4">
                <Button type="button" variant="outline" size="icon" aria-label="Pay for one fewer week" disabled={paymentInFlight || paymentWeekCount <= 1} onClick={() => onPaymentWeekCountChange(paymentWeekCount - 1)}><Minus className="size-4" /></Button>
                <output aria-label="Number of weeks to pay" className="min-w-20 text-center text-2xl font-bold">{paymentWeekCount}</output>
                <Button type="button" variant="outline" size="icon" aria-label="Pay for one more week" disabled={paymentInFlight || paymentWeekCount >= maximumWeekCount} onClick={() => onPaymentWeekCountChange(paymentWeekCount + 1)}><Plus className="size-4" /></Button>
              </div>
              <div className="flex items-center justify-between border-t pt-3"><span className="text-sm text-muted-foreground">Payment amount</span><span className="text-lg font-bold">{formatCurrency(paymentAmountMinor)}</span></div>
              <p className="text-xs text-muted-foreground">Remaining balance: {formatCurrency(remainingBalance)}</p>
            </>
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
        <Button onClick={onSubmit} disabled={(cardMode === "new" && !isInitialized) || (cardMode === "saved" && !selectedSavedCardId) || isSubmitting || isWalletProcessing || paymentAmountMinor <= 0 || (!bowlerHasEmail && !receiptEmail.trim())} className="w-full">{isSubmitting ? <><Loader2 className="mr-2 size-4 animate-spin" />Processing…</> : <><CreditCard className="mr-2 size-4" />Pay {formatCurrency(paymentAmountMinor)}</>}</Button>
      </CardContent>
    </Card>
  );
};
