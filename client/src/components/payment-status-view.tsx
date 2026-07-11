import { FC, RefObject } from "react";
import type { League, Bowler, SavedCard } from "@shared/schema";
import type { FinancialCalculation } from "@/lib/financial-utils";
import { PaymentOverviewCard } from "@/components/payment-overview-card";
import { PaymentSetupForm } from "@/components/payment-setup-form";

type PaymentSchedule = "weekly" | "custom";

interface ScheduleData {
  id: number;
  frequency: string;
  nextPaymentDate: string;
  amount: number;
  active: boolean;
  leagueTimezone?: string;
}

interface PaymentStatusViewProps {
  showPaymentSetup: boolean;
  league: League;
  bowler: Bowler;
  weeklyFee: number;
  totalWeeks: number;
  paymentMode: 'autopay' | 'onetime';
  selectedSchedule: PaymentSchedule;
  selectedWeeks: number;
  maxPayableWeeks: number;
  fixedAmount: number | null;
  fixedAmountType: 'remaining' | 'pastDue' | null;
  financials: FinancialCalculation;
  seasonPresets: { label: string; weeks: number }[];
  savedCards: SavedCard[];
  cardMode: 'new' | 'saved';
  selectedSavedCardId: string;
  cardContainerRef: RefObject<HTMLDivElement | null>;
  isInitialized: boolean;
  squareError: string | null;
  storeCard: boolean;
  isSubmitting: boolean;
  onWeekChange: (weeks: number) => void;
  onFixedAmount: (amount: number | null, type: 'remaining' | 'pastDue' | null) => void;
  setCardMode: (mode: 'new' | 'saved') => void;
  setSelectedSavedCardId: (id: string) => void;
  setStoreCard: (val: boolean) => void;
  cleanupCard: () => void;
  calculateTotalAmount: () => number;
  onSubmit: () => void;
  onCancel: () => void;
  applePayAvailable: boolean;
  googlePayAvailable: boolean;
  applePayRef: RefObject<HTMLDivElement | null>;
  googlePayRef: RefObject<HTMLDivElement | null>;
  onApplePayClick: () => void;
  onGooglePayClick: () => void;
  isWalletProcessing: boolean;
  applePayTokenizeOnly: boolean;
  googlePayTokenizeOnly: boolean;
  partnerOptions: { id: number; name: string }[];
  targetBowlerId: number;
  setTargetBowlerId: (id: number) => void;
  additionalBowlerIds: number[];
  setAdditionalBowlerIds: (ids: number[]) => void;
  partnerPastDueByBowlerId: Record<number, number>;
  activeSchedule?: ScheduleData;
  onSetupPayment: (mode: 'autopay' | 'onetime') => void;
}

export const PaymentStatusView: FC<PaymentStatusViewProps> = ({
  showPaymentSetup,
  league,
  bowler,
  weeklyFee,
  totalWeeks,
  paymentMode,
  selectedSchedule,
  selectedWeeks,
  maxPayableWeeks,
  fixedAmount,
  fixedAmountType,
  financials,
  seasonPresets,
  savedCards,
  cardMode,
  selectedSavedCardId,
  cardContainerRef,
  isInitialized,
  squareError,
  storeCard,
  isSubmitting,
  onWeekChange,
  onFixedAmount,
  setCardMode,
  setSelectedSavedCardId,
  setStoreCard,
  cleanupCard,
  calculateTotalAmount,
  onSubmit,
  onCancel,
  applePayAvailable,
  googlePayAvailable,
  applePayRef,
  googlePayRef,
  onApplePayClick,
  onGooglePayClick,
  isWalletProcessing,
  applePayTokenizeOnly,
  googlePayTokenizeOnly,
  partnerOptions,
  targetBowlerId,
  setTargetBowlerId,
  additionalBowlerIds,
  setAdditionalBowlerIds,
  partnerPastDueByBowlerId,
  activeSchedule,
  onSetupPayment,
}) => {
  if (showPaymentSetup) {
    return (
      <PaymentSetupForm
        league={league}
        weeklyFee={weeklyFee}
        totalWeeks={totalWeeks}
        paymentMode={paymentMode}
        selectedSchedule={selectedSchedule}
        selectedWeeks={selectedWeeks}
        maxPayableWeeks={maxPayableWeeks}
        fixedAmount={fixedAmount}
        fixedAmountType={fixedAmountType}
        financials={financials}
        seasonPresets={seasonPresets}
        savedCards={savedCards}
        cardMode={cardMode}
        selectedSavedCardId={selectedSavedCardId}
        cardContainerRef={cardContainerRef}
        isInitialized={isInitialized}
        squareError={squareError}
        storeCard={storeCard}
        isSubmitting={isSubmitting}
        onWeekChange={onWeekChange}
        onFixedAmount={onFixedAmount}
        setCardMode={setCardMode}
        setSelectedSavedCardId={setSelectedSavedCardId}
        setStoreCard={setStoreCard}
        cleanupCard={cleanupCard}
        calculateTotalAmount={calculateTotalAmount}
        onSubmit={onSubmit}
        onCancel={onCancel}
        applePayAvailable={applePayAvailable}
        googlePayAvailable={googlePayAvailable}
        applePayRef={applePayRef}
        googlePayRef={googlePayRef}
        onApplePayClick={onApplePayClick}
        onGooglePayClick={onGooglePayClick}
        isWalletProcessing={isWalletProcessing}
        applePayTokenizeOnly={applePayTokenizeOnly}
        googlePayTokenizeOnly={googlePayTokenizeOnly}
        partnerOptions={partnerOptions}
        selfBowler={{ id: bowler.id, name: bowler.name || 'You' }}
        targetBowlerId={targetBowlerId}
        setTargetBowlerId={setTargetBowlerId}
        // Autopay only supports self pay (combined-autopay is configured
        // separately by the schedule owner). Lock the picker to self in
        // autopay mode; allow partner selection in onetime / upfront.
        allowPartnerSelection={paymentMode !== 'autopay'}
        additionalBowlerIds={additionalBowlerIds}
        setAdditionalBowlerIds={setAdditionalBowlerIds}
        partnerPastDueByBowlerId={partnerPastDueByBowlerId}
      />
    );
  }

  return (
    <PaymentOverviewCard
      league={league}
      weeklyFee={weeklyFee}
      financials={financials}
      activeSchedule={activeSchedule}
      bowlerId={bowler.id}
      onSetupPayment={onSetupPayment}
    />
  );
};
