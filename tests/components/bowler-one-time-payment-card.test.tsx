import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { BowlerOneTimePaymentCard } from "@/components/bowler-one-time-payment-card";

function renderCard(fullBalanceOnly: boolean) {
  const applePayRef: RefObject<HTMLDivElement | null> = { current: null };
  const googlePayRef: RefObject<HTMLDivElement | null> = { current: null };
  return render(<BowlerOneTimePaymentCard
    remainingBalance={8_750}
    paymentWeekCount={3}
    maximumWeekCount={3}
    paymentAmountMinor={8_750}
    fullBalanceOnly={fullBalanceOnly}
    savedCards={[]}
    cardMode="new"
    setCardMode={vi.fn()}
    selectedSavedCardId=""
    setSelectedSavedCardId={vi.fn()}
    storeCard={false}
    setStoreCard={vi.fn()}
    isInitialized
    isSubmitting={false}
    onSubmit={vi.fn()}
    onPaymentWeekCountChange={vi.fn()}
    initializeCard={vi.fn(async () => undefined)}
    cleanupCard={vi.fn()}
    onCardEditorModeChange={vi.fn()}
    cardEditorMode="one-time"
    applePayAvailable={false}
    googlePayAvailable={false}
    applePayTokenizeOnly={false}
    googlePayTokenizeOnly={false}
    applePayRef={applePayRef}
    googlePayRef={googlePayRef}
    onApplePayClick={vi.fn(async () => undefined)}
    onGooglePayClick={vi.fn(async () => undefined)}
    isWalletProcessing={false}
    bowlerHasEmail={true}
    receiptEmail=""
    onReceiptEmailChange={vi.fn()}
  />);
}

describe("BowlerOneTimePaymentCard payment mode", () => {
  it("shows only the canonical remaining balance for an unpaid upfront league", () => {
    renderCard(true);

    expect(screen.getByText("Full Season Remaining Balance")).toBeInTheDocument();
    expect(screen.getAllByText("$87.50")).toHaveLength(1);
    expect(screen.queryByText("Number of weeks")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Number of weeks to pay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay for one fewer week" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay for one more week" })).not.toBeInTheDocument();
    expect(screen.queryByText("Payment amount")).not.toBeInTheDocument();
    expect(screen.queryByText(/Remaining balance:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose how many weeks|oldest open week first/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $87.50" })).toBeInTheDocument();
  });

  it("keeps week selection and FIFO copy for weekly leagues", () => {
    renderCard(false);

    expect(screen.getByText("Number of weeks")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Number of weeks to pay" })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: "Pay for one fewer week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay for one more week" })).toBeInTheDocument();
    expect(screen.getByText("Payment amount")).toBeInTheDocument();
    expect(screen.getByText("Remaining balance: $87.50")).toBeInTheDocument();
    expect(screen.getByText(/oldest open week first/i)).toBeInTheDocument();
  });
});
