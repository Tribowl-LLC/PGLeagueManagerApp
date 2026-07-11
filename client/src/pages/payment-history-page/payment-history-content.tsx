import { FC, RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { League, Payment, SavedCard, BowlerLeague } from "@shared/schema";
import type { DoublePayStatus } from "@/lib/financial-utils";
import { BowlerLayout } from "@/components/bowler-layout";
import { PaymentSummaryCards } from "@/components/payment-summary-cards";
import { ErrorBoundary } from "@/components/error-boundary";
import { BowlerPaymentTable } from "@/components/bowler-payment-table";
import { BowlerPaymentDialog } from "@/components/bowler-payment-dialog";
import { LeagueSwitcherSheet } from "@/components/league-switcher-sheet";

interface PaymentHistoryContentProps {
  bowlerName: string;
  league: League;
  leagueId: number;
  hasMultipleLeagues: boolean;
  leagueSheetOpen: boolean;
  onOpenLeagueSheet: () => void;
  onCloseLeagueSheet: () => void;
  bowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  onSelectLeague: (leagueId: number) => void;
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  weeksDueCount: number;
  totalSeasonDues: number;
  weeksPaid: number;
  totalPaidAmount: number;
  amountPastDue: number;
  remainingBalance: number;
  doublePay: DoublePayStatus;
  onPayPastDue: () => void;
  onPayRemaining: () => void;
  payDialogType: 'pastdue' | 'remaining' | null;
  onCloseDialog: () => void;
  savedCards: SavedCard[];
  cardMode: 'new' | 'saved';
  setCardMode: (mode: 'new' | 'saved') => void;
  selectedSavedCardId: string;
  setSelectedSavedCardId: (id: string) => void;
  storeCard: boolean;
  setStoreCard: (store: boolean) => void;
  isInitialized: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  initializeCard: (container: HTMLDivElement) => Promise<void>;
  cleanupCard: () => void;
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
  bowlerPayments: Payment[];
}

export const PaymentHistoryContent: FC<PaymentHistoryContentProps> = ({
  bowlerName,
  league,
  leagueId,
  hasMultipleLeagues,
  leagueSheetOpen,
  onOpenLeagueSheet,
  onCloseLeagueSheet,
  bowlerLeagues,
  leagueMap,
  onSelectLeague,
  totalWeeksInSeason,
  fullSeasonAmount,
  weeksDueCount,
  totalSeasonDues,
  weeksPaid,
  totalPaidAmount,
  amountPastDue,
  remainingBalance,
  doublePay,
  onPayPastDue,
  onPayRemaining,
  payDialogType,
  onCloseDialog,
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
  applePayAvailable,
  googlePayAvailable,
  applePayTokenizeOnly,
  googlePayTokenizeOnly,
  applePayRef,
  googlePayRef,
  onApplePayClick,
  onGooglePayClick,
  isWalletProcessing,
  bowlerHasEmail,
  receiptEmail,
  onReceiptEmailChange,
  bowlerPayments,
}) => {
  return (
    <BowlerLayout bowlerName={bowlerName} leagueName={league.name} currentLeagueId={leagueId}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">Payment History</h1>
          {hasMultipleLeagues ? (
            <button type="button"
              onClick={onOpenLeagueSheet}
              className="flex items-center gap-1 text-slate-500 hover:text-slate-700 transition-colors mb-4"
            >
              <span>{league.name}</span>
              <ChevronDown className="size-4" />
            </button>
          ) : (
            <p className="text-muted-foreground mb-4">
              {league.name}
            </p>
          )}
        </div>

        <ErrorBoundary level="section">
          <PaymentSummaryCards
            totalWeeksInSeason={totalWeeksInSeason}
            fullSeasonAmount={fullSeasonAmount}
            weeklyFee={league?.weeklyFee || 0}
            weeksDueCount={weeksDueCount}
            totalSeasonDues={totalSeasonDues}
            weeksPaid={weeksPaid}
            totalPaidAmount={totalPaidAmount}
            amountPastDue={amountPastDue}
            remainingBalance={remainingBalance}
            doublePay={doublePay}
            onPayPastDue={onPayPastDue}
            onPayRemaining={onPayRemaining}
          />
        </ErrorBoundary>

        <ErrorBoundary level="section">
          <BowlerPaymentDialog
            payDialogType={payDialogType}
            onClose={onCloseDialog}
            amountPastDue={amountPastDue}
            remainingBalance={remainingBalance}
            savedCards={savedCards}
            cardMode={cardMode}
            setCardMode={setCardMode}
            selectedSavedCardId={selectedSavedCardId}
            setSelectedSavedCardId={setSelectedSavedCardId}
            storeCard={storeCard}
            setStoreCard={setStoreCard}
            isInitialized={isInitialized}
            isSubmitting={isSubmitting}
            onSubmit={onSubmit}
            initializeCard={initializeCard}
            cleanupCard={cleanupCard}
            applePayAvailable={applePayAvailable}
            googlePayAvailable={googlePayAvailable}
            applePayTokenizeOnly={applePayTokenizeOnly}
            googlePayTokenizeOnly={googlePayTokenizeOnly}
            applePayRef={applePayRef}
            googlePayRef={googlePayRef}
            onApplePayClick={onApplePayClick}
            onGooglePayClick={onGooglePayClick}
            isWalletProcessing={isWalletProcessing}
            bowlerHasEmail={bowlerHasEmail}
            receiptEmail={receiptEmail}
            onReceiptEmailChange={onReceiptEmailChange}
          />
        </ErrorBoundary>

        <ErrorBoundary level="section">
          <BowlerPaymentTable payments={bowlerPayments} league={league} />
        </ErrorBoundary>
      </div>

      <LeagueSwitcherSheet
        open={leagueSheetOpen}
        onClose={onCloseLeagueSheet}
        bowlerLeagues={bowlerLeagues}
        leagueMap={leagueMap}
        selectedLeagueId={leagueId}
        onSelect={onSelectLeague}
      />
    </BowlerLayout>
  );
};
