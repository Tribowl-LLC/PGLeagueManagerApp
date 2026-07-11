import { FC, useRef, type CSSProperties, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, CreditCard, Wallet } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { SavedCard } from "@shared/schema";

// Apple Pay / Google Pay buttons use pure black (#000) by brand requirement.
// Hoisted to module scope so the exhaustive style object isn't reallocated per
// render; the dynamic `opacity` is applied inline at the call site.
const APPLE_PAY_BUTTON_BASE_STYLE: CSSProperties = {
  WebkitAppearance: 'none',
  appearance: 'none',
  backgroundColor: '#000',
  border: 'none',
  borderRadius: '5px',
  width: '100%',
  height: '48px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '2px',
  padding: 0,
};

const GOOGLE_PAY_BUTTON_BASE_STYLE: CSSProperties = {
  WebkitAppearance: 'none',
  appearance: 'none',
  backgroundColor: '#000',
  border: '1px solid #747775',
  borderRadius: '5px',
  width: '100%',
  height: '48px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  padding: 0,
};

interface BowlerPaymentDialogProps {
  payDialogType: 'pastdue' | 'remaining' | null;
  onClose: () => void;
  amountPastDue: number;
  remainingBalance: number;
  savedCards: SavedCard[];
  cardMode: 'new' | 'saved';
  setCardMode: (mode: 'new' | 'saved') => void;
  selectedSavedCardId: string;
  setSelectedSavedCardId: (id: string) => void;
  storeCard: boolean;
  setStoreCard: (v: boolean) => void;
  isInitialized: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  initializeCard: (el: HTMLDivElement) => void;
  cleanupCard: () => void;
  applePayAvailable?: boolean;
  googlePayAvailable?: boolean;
  applePayTokenizeOnly?: boolean;
  googlePayTokenizeOnly?: boolean;
  applePayRef?: RefObject<HTMLDivElement | null>;
  googlePayRef?: RefObject<HTMLDivElement | null>;
  onApplePayClick?: () => Promise<void>;
  onGooglePayClick?: () => Promise<void>;
  isWalletProcessing?: boolean;
  // when the bowler has no email on file, surface an inline
  // capture so we can pass `buyerEmail` into the charge and trigger
  // Square's hosted receipt. Parent owns the controlled state.
  bowlerHasEmail?: boolean;
  receiptEmail?: string;
  onReceiptEmailChange?: (value: string) => void;
}

export const BowlerPaymentDialog: FC<BowlerPaymentDialogProps> = ({
  payDialogType,
  onClose,
  amountPastDue,
  remainingBalance,
  savedCards,
  cardMode,
  setCardMode,
  selectedSavedCardId,
  setSelectedSavedCardId,
  storeCard,
  setStoreCard,
  isInitialized,
  isSubmitting,
  onSubmit,
  initializeCard,
  cleanupCard,
  applePayAvailable = false,
  googlePayAvailable = false,
  applePayTokenizeOnly = false,
  googlePayTokenizeOnly = false,
  applePayRef,
  googlePayRef,
  onApplePayClick,
  onGooglePayClick,
  isWalletProcessing = false,
  bowlerHasEmail = true,
  receiptEmail = "",
  onReceiptEmailChange,
}) => {
  const showWallet = applePayAvailable || googlePayAvailable;
  const cardCallbackRef = useRef<(el: HTMLDivElement | null) => void>(() => {});
  cardCallbackRef.current = (el: HTMLDivElement | null) => {
    if (el && payDialogType && cardMode === 'new') {
      initializeCard(el);
    }
  };

  const dialogAmount = payDialogType === 'pastdue' ? amountPastDue : remainingBalance;

  return (
    <Dialog open={!!payDialogType} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{payDialogType === 'pastdue' ? 'Pay Past Due Amount' : 'Pay Remaining Balance'}</DialogTitle>
          <DialogDescription>
            {payDialogType === 'pastdue'
              ? `Pay your outstanding balance of ${formatCurrency(amountPastDue)}`
              : `Pay off your remaining season balance of ${formatCurrency(remainingBalance)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="rounded-md border p-4 bg-muted/50">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Amount</span>
              <span className="text-lg font-bold">{formatCurrency(dialogAmount)}</span>
            </div>
          </div>

          {/*
           * Always-mounted Apple Pay container. Square's `applePay.attach()`
           * runs against this exact node before `applePayAvailable`
           * flips, so the rendered button isn't unmounted out from
           * under us. The previous pattern split the ref across a
           * visible div and a hidden placeholder; when the placeholder
           * unmounted, Square's attached button was destroyed and
           * users saw an empty clickable area instead of a button.
           */}
          {!applePayTokenizeOnly && applePayRef && (
            <div
              ref={applePayRef}
              className={applePayAvailable ? 'min-h-[48px] overflow-hidden rounded-md bg-black' : undefined}
              style={applePayAvailable ? undefined : { display: 'none' }}
            />
          )}
          {applePayAvailable && applePayTokenizeOnly && onApplePayClick && (
            <button
              type="button"
              onClick={onApplePayClick}
              disabled={isWalletProcessing}
              style={{ ...APPLE_PAY_BUTTON_BASE_STYLE, opacity: isWalletProcessing ? 0.5 : 1 }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="19" height="24" viewBox="0 0 17 20" fill="white" style={{ position: 'relative', top: '-1px' }}>
                <path d="M13.55 10.63a4.27 4.27 0 0 1 2.04-3.59 4.4 4.4 0 0 0-3.46-1.87c-1.46-.15-2.88.87-3.63.87s-1.91-.85-3.15-.83a4.65 4.65 0 0 0-3.91 2.38c-1.68 2.91-.43 7.2 1.19 9.56.8 1.15 1.74 2.44 2.98 2.4 1.2-.05 1.65-.77 3.1-.77s1.86.77 3.12.74c1.29-.02 2.1-1.16 2.88-2.32a10.4 10.4 0 0 0 1.31-2.69 4.13 4.13 0 0 1-2.47-3.88zM11.17 3.46A4.17 4.17 0 0 0 12.14 0a4.25 4.25 0 0 0-2.75 1.42 3.98 3.98 0 0 0-1 2.89 3.52 3.52 0 0 0 2.78-0.85z"/>
              </svg>
              <span style={{
                color: '#fff',
                fontFamily: '-apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif',
                fontSize: '22px',
                fontWeight: 400,
                letterSpacing: '0.4px',
              }}>Pay</span>
            </button>
          )}
          {/*
           * Always-mounted Google Pay container — same reasoning as
           * the Apple Pay block above. Splitting the ref across two
           * sibling divs caused Google Pay's button to render into a
           * hidden placeholder, then disappear when that placeholder
           * unmounted, leaving an empty clickable area.
           */}
          {!googlePayTokenizeOnly && googlePayRef && (
            <div
              ref={googlePayRef}
              className={googlePayAvailable ? 'min-h-[48px] overflow-hidden rounded-md bg-black' : undefined}
              style={googlePayAvailable ? undefined : { display: 'none' }}
            />
          )}
          {googlePayAvailable && googlePayTokenizeOnly && onGooglePayClick && (
            <button
              type="button"
              aria-label="Pay with Google Pay"
              onClick={onGooglePayClick}
              disabled={isWalletProcessing}
              style={{ ...GOOGLE_PAY_BUTTON_BASE_STYLE, opacity: isWalletProcessing ? 0.5 : 1 }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="41" height="17" viewBox="0 0 41 17" fill="none">
                <path d="M19.4 8.5V13.1H18V1.8H21.5C22.4 1.8 23.2 2.1 23.8 2.7C24.5 3.3 24.8 4 24.8 4.9C24.8 5.8 24.5 6.5 23.8 7.1C23.2 7.7 22.4 8 21.5 8H19.4V8.5ZM19.4 3.2V7H21.5C22.1 7 22.6 6.8 23 6.4C23.4 6 23.6 5.5 23.6 4.9C23.6 4.4 23.4 3.9 23 3.5C22.6 3.1 22.1 2.9 21.5 2.9H19.4V3.2Z" fill="white"/>
                <path d="M28.8 4.8C29.9 4.8 30.8 5.1 31.4 5.7C32 6.3 32.4 7.1 32.4 8.1V13.1H31.1V12H31C30.4 12.9 29.7 13.3 28.7 13.3C27.9 13.3 27.2 13 26.6 12.5C26.1 12 25.8 11.3 25.8 10.5C25.8 9.7 26.1 9 26.7 8.5C27.3 8 28.1 7.7 29.1 7.7C29.9 7.7 30.6 7.9 31.1 8.2V7.9C31.1 7.3 30.9 6.8 30.5 6.4C30.1 6 29.5 5.8 29 5.8C28.2 5.8 27.5 6.2 27.1 6.9L25.9 6.1C26.6 5.2 27.6 4.8 28.8 4.8ZM27.1 10.6C27.1 11 27.3 11.4 27.6 11.7C28 12 28.3 12.1 28.8 12.1C29.5 12.1 30 11.8 30.5 11.3C31 10.8 31.2 10.2 31.2 9.5C30.7 9.2 30 9 29.2 9C28.6 9 28.1 9.2 27.7 9.5C27.3 9.9 27.1 10.2 27.1 10.6Z" fill="white"/>
                <path d="M38.6 5L34.4 14.6H33L34.7 11L32 5H33.5L35.5 10L37.5 5H38.6Z" fill="white"/>
                <path d="M13 7.2C13 6.7 13 6.2 12.9 5.7H6.6V8.5H10.2C10 9.5 9.5 10.3 8.7 10.8V12.7H10.9C12.3 11.4 13 9.5 13 7.2Z" fill="#4285F4"/>
                <path d="M6.6 14.5C8.5 14.5 10.1 13.9 10.9 12.7L8.7 10.8C8 11.3 7.4 11.5 6.6 11.5C4.8 11.5 3.3 10.2 2.7 8.5H0.5V10.4C1.6 12.7 3.9 14.5 6.6 14.5Z" fill="#34A853"/>
                <path d="M2.7 8.5C2.5 8 2.4 7.5 2.4 6.9C2.4 6.3 2.5 5.8 2.7 5.3V3.4H0.5C-0.2 4.8 -0.2 9 0.5 10.4L2.7 8.5Z" fill="#FBBC04"/>
                <path d="M6.6 2.3C7.5 2.3 8.3 2.6 9 3.2L11 1.3C10 0.4 8.4-0.1 6.6-0.1C3.9-0.1 1.6 1.7 0.5 3.4L2.7 5.3C3.3 3.6 4.8 2.3 6.6 2.3Z" fill="#EA4335"/>
              </svg>
            </button>
          )}
          {!googlePayAvailable && googlePayRef && (
            <div ref={googlePayRef} style={{ display: 'none' }} />
          )}
          {isWalletProcessing && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-sm text-muted-foreground">Processing wallet payment…</span>
            </div>
          )}
          {showWallet && (
            <div className="relative flex items-center gap-4 py-2">
              <div className="flex-1 border-t" />
              <span className="text-xs text-muted-foreground">or pay with card</span>
              <div className="flex-1 border-t" />
            </div>
          )}

          {savedCards.length > 0 && (
            <div className="flex gap-2">
              <Button
                type="button"
                variant={cardMode === 'saved' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  cleanupCard();
                  setCardMode('saved');
                }}
                className="flex items-center gap-2"
              >
                <Wallet className="size-4" />
                Saved Card
              </Button>
              <Button
                type="button"
                variant={cardMode === 'new' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  cleanupCard();
                  setCardMode('new');
                }}
                className="flex items-center gap-2"
              >
                <CreditCard className="size-4" />
                New Card
              </Button>
            </div>
          )}

          {cardMode === 'saved' && savedCards.length > 0 ? (
            <div className="space-y-3">
              <Select value={selectedSavedCardId} onValueChange={setSelectedSavedCardId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a saved card" />
                </SelectTrigger>
                <SelectContent>
                  {savedCards.map((sc) => (
                    <SelectItem key={sc.id} value={sc.id}>
                      {sc.brand} ending in {sc.last4} (exp {sc.expMonth}/{sc.expYear})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-3">
              <span className="text-sm font-medium mb-2 block">Card Details</span>
              <div
                ref={(el) => cardCallbackRef.current(el)}
                className="min-h-[80px] rounded-md border p-3"
              />
              <div className="flex items-center gap-x-3">
                <Checkbox
                  id="store-card-history"
                  checked={storeCard}
                  onCheckedChange={(checked) => setStoreCard(checked === true)}
                />
                <Label htmlFor="store-card-history" className="text-sm cursor-pointer">
                  Save this card for future payments
                </Label>
              </div>
            </div>
          )}

          {!bowlerHasEmail && onReceiptEmailChange && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <Label htmlFor="receipt-email" className="text-sm font-medium">
                Email for receipt <span className="text-destructive">*</span>
              </Label>
              <Input
                id="receipt-email"
                type="email"
                placeholder="you@example.com"
                value={receiptEmail}
                onChange={(e) => onReceiptEmailChange(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                We don't have an email on file for you. Add one to get a
                Square receipt for this payment.
              </p>
            </div>
          )}

          <Button
            onClick={onSubmit}
            disabled={
              (cardMode === 'new' && !isInitialized) ||
              (cardMode === 'saved' && !selectedSavedCardId) ||
              isSubmitting ||
              isWalletProcessing ||
              // block submit when the
              // bowler has no email on file AND the inline "Email for
              // receipt" input is empty. Square will hard-reject the
              // request server-side; gating here gives instant UX.
              (!bowlerHasEmail && !receiptEmail.trim())
            }
            className="w-full"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Processing…
              </>
            ) : (
              <>
                <CreditCard className="mr-2 size-4" />
                Pay {formatCurrency(dialogAmount)}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
