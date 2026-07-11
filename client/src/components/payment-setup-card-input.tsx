import { FC, RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, CreditCard, Wallet } from "lucide-react";
import type { SavedCard } from "@shared/schema";
import { WalletPaymentButtons } from "@/components/wallet-payment-buttons";

interface PaymentSetupCardInputProps {
  savedCards: SavedCard[];
  cardMode: 'new' | 'saved';
  setCardMode: (mode: 'new' | 'saved') => void;
  selectedSavedCardId: string;
  setSelectedSavedCardId: (id: string) => void;
  cardContainerRef: RefObject<HTMLDivElement | null>;
  isInitialized: boolean;
  squareError: string | null;
  storeCard: boolean;
  setStoreCard: (v: boolean) => void;
  showStoreCardOption: boolean;
  cleanupCard: () => void;
  applePayAvailable: boolean;
  googlePayAvailable: boolean;
  applePayRef: RefObject<HTMLDivElement | null>;
  googlePayRef: RefObject<HTMLDivElement | null>;
  onApplePayClick: () => void;
  onGooglePayClick: () => void;
  isWalletProcessing: boolean;
  applePayTokenizeOnly: boolean;
  googlePayTokenizeOnly: boolean;
}

export const PaymentSetupCardInput: FC<PaymentSetupCardInputProps> = ({
  savedCards,
  cardMode,
  setCardMode,
  selectedSavedCardId,
  setSelectedSavedCardId,
  cardContainerRef,
  isInitialized,
  squareError,
  storeCard,
  setStoreCard,
  showStoreCardOption,
  cleanupCard,
  applePayAvailable,
  googlePayAvailable,
  applePayRef,
  googlePayRef,
  onApplePayClick,
  onGooglePayClick,
  isWalletProcessing,
  applePayTokenizeOnly,
  googlePayTokenizeOnly,
}) => {
  const showWallet = applePayAvailable || googlePayAvailable;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium">Payment Information</h3>
        <p className="text-sm text-muted-foreground">
          {savedCards.length > 0
            ? "Use a saved card or enter new card details"
            : "Enter your card details securely"}
        </p>
      </div>

      <WalletPaymentButtons
        variant="bowler"
        applePayAvailable={applePayAvailable}
        googlePayAvailable={googlePayAvailable}
        applePayRef={applePayRef}
        googlePayRef={googlePayRef}
        onApplePayClick={onApplePayClick}
        onGooglePayClick={onGooglePayClick}
        isWalletProcessing={isWalletProcessing}
        applePayTokenizeOnly={applePayTokenizeOnly}
        googlePayTokenizeOnly={googlePayTokenizeOnly}
      />
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
              if (cardMode === 'new') return;
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
        <>
          <div ref={cardContainerRef} className="min-h-[200px] border rounded-lg bg-card p-4">
            {!isInitialized && (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <p className="ml-2 text-sm text-muted-foreground">
                  Loading credit card form…
                </p>
              </div>
            )}
          </div>
          {showStoreCardOption && (
            <div className="flex items-center gap-x-3">
              <Checkbox
                id="store-card-status"
                checked={storeCard}
                onCheckedChange={(checked) => setStoreCard(checked === true)}
              />
              <Label htmlFor="store-card-status" className="text-sm cursor-pointer">
                Save this card for future payments
              </Label>
            </div>
          )}
        </>
      )}

      {squareError && cardMode === 'new' && (
        <div className="p-3 text-sm border border-destructive bg-destructive/10 text-destructive rounded-md">
          <p><strong>Credit Card Form Error:</strong> {squareError}</p>
          <p className="mt-1 text-xs">Consider using Cash or Check payment instead.</p>
        </div>
      )}
    </div>
  );
};
