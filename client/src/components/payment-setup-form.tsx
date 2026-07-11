import { FC, RefObject } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { League, SavedCard } from "@shared/schema";
import { PaymentCustomAmount } from "@/components/payment-custom-amount";
import { PaymentSetupCardInput } from "@/components/payment-setup-card-input";
import { PaymentSubmitSection } from "@/components/payment-submit-section";
import { PaymentSetupRecipientPicker } from "@/components/payment-setup-recipient-picker";
import { PaymentSetupSummaryCard } from "@/components/payment-setup-summary-card";
import { PaymentSetupCombinedPay } from "@/components/payment-setup-combined-pay";

type RefDiv = React.RefObject<HTMLDivElement | null>;

type PaymentSchedule = "weekly" | "custom";

interface PaymentSetupFormProps {
  league: League;
  weeklyFee: number;
  totalWeeks: number;
  paymentMode: 'autopay' | 'onetime';
  selectedSchedule: PaymentSchedule;
  selectedWeeks: number;
  maxPayableWeeks: number;
  fixedAmount: number | null;
  fixedAmountType: 'remaining' | 'pastDue' | null;
  financials: {
    fullSeasonAmount: number;
    doublePay: { dates: string[]; perWeekExtra: number; totalExtra: number; pastExtra: number; isPaid: boolean };
    amountPastDue: number;
    remainingBalance: number;
    totalPaid: number;
  };
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
  applePayRef: RefDiv;
  googlePayRef: RefDiv;
  onApplePayClick: () => void;
  onGooglePayClick: () => void;
  isWalletProcessing: boolean;
  applePayTokenizeOnly: boolean;
  googlePayTokenizeOnly: boolean;
  // recipient picker. When the logged-in
  // bowler has accepted-link partners, render a "Pay for" select.
  // Locked to self when the form is in autopay mode (autopay charges
  // the schedule's owner each week, partner autopay isn't supported).
  partnerOptions?: { id: number; name: string }[];
  selfBowler: { id: number; name: string };
  targetBowlerId: number;
  setTargetBowlerId: (id: number) => void;
  allowPartnerSelection: boolean;
  // combined-autopay target multi-select. When
  // the bowler is setting up autopay AND has accepted partners, we
  // render a checkbox group that lets them have ONE schedule charge
  // their card weekly for themselves PLUS each selected partner. The
  // `additionalBowlerIds` array is forwarded to POST /api/payment-
  // schedules' `additionalBowlerIds` field, which the autopay executor
  // walks each cycle to charge the payer's vault for each partner. The
  // payer is always the schedule owner (selfBowler); partners are
  // charged BUT credited as their own payment row stamped with
  // `paidByUserId`.
  additionalBowlerIds: number[];
  setAdditionalBowlerIds: (ids: number[]) => void;
  // Task #715: per-partner past-due (cents) for the current league.
  // When weekly auto-pay is being set up and any included bowler has
  // a past-due balance, the immediate charge is Σ(pastDue+weeklyFee)
  // per included bowler — surfaced here as a "Total due today" line.
  partnerPastDueByBowlerId?: Record<number, number>;
}

// Stable default references so optional props don't create a fresh array /
// object on every render (which would defeat memoized children / deps).
const EMPTY_PARTNER_OPTIONS: { id: number; name: string }[] = [];
const EMPTY_PARTNER_PAST_DUE: Record<number, number> = {};

export const PaymentSetupForm: FC<PaymentSetupFormProps> = ({
  league,
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
  partnerOptions = EMPTY_PARTNER_OPTIONS,
  selfBowler,
  targetBowlerId,
  setTargetBowlerId,
  allowPartnerSelection,
  additionalBowlerIds,
  setAdditionalBowlerIds,
  partnerPastDueByBowlerId = EMPTY_PARTNER_PAST_DUE,
}) => {
  // Task #706: combined-pay (multi-select) is now offered for ALL
  // payment modes — autopay, one-time, and upfront — whenever the
  // bowler has accepted partners. Picking at least one partner here
  // bundles the payment into ONE card transaction with N+1 per-bowler
  // rows (server-side endpoint `/api/payments-provider/combined-
  // payments` for one-time/upfront, or the autopay schedule's
  // `additionalBowlerIds` for weekly/custom autopay).
  const hasCombinedPicks = additionalBowlerIds.length > 0;
  // The two partner-pay flows are mutually exclusive:
  //  - "Pay for" dropdown (single recipient): user is paying for ONE
  //    other bowler; the payment is recorded against that bowler only.
  //  - "Also pay for these linked bowlers" (combined-pay): user is
  //    paying for THEMSELVES plus N partners in one card transaction.
  // Showing both at once is confusing — the screenshot bug had a
  // dropdown set to "Bob Testable" while the combined-pay list still
  // offered "Michael Shearer (you)" and "Bob Testable" as additional
  // payees, leaving it unclear who the charge was actually for. So:
  //  - Hide the recipient picker once combined-pay has any picks.
  //  - Hide the combined-pay block once the recipient picker has
  //    swapped away from self (you're paying for that one partner,
  //    not bundling).
  const payingForPartner = targetBowlerId !== selfBowler.id;
  const showPartnerPicker =
    allowPartnerSelection && partnerOptions.length > 0 && !hasCombinedPicks;
  const showCombinedPay = partnerOptions.length > 0 && !payingForPartner;
  const baseAmount = calculateTotalAmount();
  const combinedTotal = baseAmount * (1 + additionalBowlerIds.length);

  // Task #715: weekly auto-pay setup must clear past-due up front. When
  // any included bowler has a past-due balance, the immediate charge is
  // Σ(amountPastDue + weeklyFee) for the payer + each combined partner.
  // The recurring weekly amount is unchanged.
  const isAutopayMode = paymentMode === 'autopay' && league.paymentMode !== 'upfront';
  const selfPastDue = financials.amountPastDue;
  const partnerPastDueSum = additionalBowlerIds.reduce(
    (sum, id) => sum + (partnerPastDueByBowlerId[id] ?? 0),
    0,
  );
  const anyAutopayPastDue =
    isAutopayMode &&
    (selfPastDue > 0 ||
      additionalBowlerIds.some((id) => (partnerPastDueByBowlerId[id] ?? 0) > 0));
  const autopayDueTodayTotal = isAutopayMode
    ? selfPastDue + weeklyFee * (1 + additionalBowlerIds.length) + partnerPastDueSum
    : 0;
  const selfDueToday = selfPastDue + weeklyFee;
  const partnerDueToday = (id: number) => (partnerPastDueByBowlerId[id] ?? 0) + weeklyFee;
  const togglePartner = (id: number, on: boolean) => {
    if (on) {
      if (!additionalBowlerIds.includes(id)) {
        setAdditionalBowlerIds([...additionalBowlerIds, id]);
      }
    } else {
      setAdditionalBowlerIds(additionalBowlerIds.filter((x) => x !== id));
    }
  };
  return (
    <Card className="w-full">
      <CardHeader className={league.paymentMode !== 'upfront' && paymentMode === 'autopay' ? 'pb-4' : undefined}>
        <CardTitle>
          {league.paymentMode === 'upfront' ? 'Full Season Payment' : paymentMode === 'onetime' ? 'Make One-Time Payment' : 'Set Up Automatic Payments'}
        </CardTitle>
        {(league.paymentMode === 'upfront' || paymentMode === 'onetime') && (
          <CardDescription>
            {league.paymentMode === 'upfront' ? 'Your full season dues will be charged in a single payment' : 'Enter your card to make a payment'}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {showPartnerPicker && (
            <PaymentSetupRecipientPicker
              selfBowler={selfBowler}
              targetBowlerId={targetBowlerId}
              setTargetBowlerId={setTargetBowlerId}
              partnerOptions={partnerOptions}
            />
          )}
          <PaymentSetupSummaryCard
            league={league}
            paymentMode={paymentMode}
            weeklyFee={weeklyFee}
            totalWeeks={totalWeeks}
            upfrontPaymentAmount={calculateTotalAmount()}
            additionalBowlerCount={additionalBowlerIds.length}
            anyAutopayPastDue={anyAutopayPastDue}
            autopayDueTodayTotal={autopayDueTodayTotal}
          />

          {showCombinedPay && (
            <PaymentSetupCombinedPay
              league={league}
              paymentMode={paymentMode}
              selfBowler={selfBowler}
              partnerOptions={partnerOptions}
              additionalBowlerIds={additionalBowlerIds}
              togglePartner={togglePartner}
              isAutopayMode={isAutopayMode}
              anyAutopayPastDue={anyAutopayPastDue}
              selfDueToday={selfDueToday}
              partnerDueToday={partnerDueToday}
              baseAmount={baseAmount}
              combinedTotal={combinedTotal}
              autopayDueTodayTotal={autopayDueTodayTotal}
            />
          )}
          
          {selectedSchedule === 'custom' && league.paymentMode !== 'upfront' && (
            <PaymentCustomAmount
              weeklyFee={weeklyFee}
              totalWeeks={totalWeeks}
              selectedWeeks={selectedWeeks}
              maxPayableWeeks={maxPayableWeeks}
              fixedAmount={fixedAmount}
              fixedAmountType={fixedAmountType}
              financials={financials}
              seasonPresets={seasonPresets}
              onWeekChange={onWeekChange}
              onFixedAmount={onFixedAmount}
            />
          )}

          <PaymentSetupCardInput
            savedCards={savedCards}
            cardMode={cardMode}
            setCardMode={setCardMode}
            selectedSavedCardId={selectedSavedCardId}
            setSelectedSavedCardId={setSelectedSavedCardId}
            cardContainerRef={cardContainerRef}
            isInitialized={isInitialized}
            squareError={squareError}
            storeCard={storeCard}
            setStoreCard={setStoreCard}
            showStoreCardOption={league.paymentMode === 'upfront' || selectedSchedule === 'custom'}
            cleanupCard={cleanupCard}
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

          <PaymentSubmitSection
            league={league}
            selectedSchedule={selectedSchedule}
            fixedAmountType={fixedAmountType}
            selectedWeeks={selectedWeeks}
            calculateTotalAmount={calculateTotalAmount}
            isSubmitting={isSubmitting}
            cardMode={cardMode}
            isInitialized={isInitialized}
            selectedSavedCardId={selectedSavedCardId}
            additionalBowlerCount={additionalBowlerIds.length}
            autopayDueTodayOverride={anyAutopayPastDue ? autopayDueTodayTotal : null}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </div>
      </CardContent>
    </Card>
  );
};
