import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ initializeSquare: vi.fn() }));
vi.mock("@/lib/square", () => ({ initializeSquare: mocks.initializeSquare }));

import { BowlerOneTimePaymentCard } from "@/components/bowler-one-time-payment-card";
import { useWalletPayments } from "@/hooks/use-wallet-payments";

function WalletCardHarness() {
  const wallet = useWalletPayments({
    locationId: 1,
    amountCents: 1_000,
    enabled: true,
    onTokenReceived: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  });

  return (
    <BowlerOneTimePaymentCard
      paymentAmountMinor={1_000}
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
      initializeCard={vi.fn().mockResolvedValue(undefined)}
      cleanupCard={vi.fn()}
      onCardEditorModeChange={vi.fn()}
      cardEditorMode="one-time"
      applePayAvailable={wallet.applePayAvailable}
      googlePayAvailable={wallet.googlePayAvailable}
      applePayTokenizeOnly={wallet.applePayTokenizeOnly}
      googlePayTokenizeOnly={wallet.googlePayTokenizeOnly}
      applePayRef={wallet.applePayRef}
      googlePayRef={wallet.googlePayRef}
      onApplePayClick={wallet.handleApplePayClick}
      onGooglePayClick={wallet.handleGooglePayClick}
      isWalletProcessing={wallet.isProcessing}
      bowlerHasEmail
      receiptEmail=""
      onReceiptEmailChange={vi.fn()}
      recipientRows={[{
        bowlerId: 42,
        name: "Bowler",
        role: "self",
        remainingMinor: 1_000,
        pastDueMinor: 1_000,
        weeks: 1,
        maximumWeekCount: 1,
        amountMinor: 1_000,
        selected: true,
        eligible: true,
        reason: null,
      }]}
      onRecipientToggle={vi.fn()}
      onRecipientWeeksChange={vi.fn()}
    />
  );
}

describe("BowlerOneTimePaymentCard wallet attachment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.initializeSquare.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts the provider node before availability and preserves it when Apple Pay becomes available", async () => {
    const applePay = {
      attach: vi.fn(async (element: HTMLElement) => {
        const providerButton = document.createElement("button");
        providerButton.textContent = "Provider Apple Pay";
        element.appendChild(providerButton);
      }),
      tokenize: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.initializeSquare.mockResolvedValue({
      paymentRequest: vi.fn(() => ({ update: vi.fn() })),
      applePay: vi.fn().mockResolvedValue(applePay),
      googlePay: vi.fn().mockRejectedValue(new Error("unavailable")),
    });

    render(<WalletCardHarness />);

    const walletRegion = document.querySelector('[aria-label="Device wallets"]');
    expect(walletRegion).toBeInTheDocument();
    const appleMount = walletRegion?.firstElementChild;
    const googleMount = walletRegion?.lastElementChild;
    expect(appleMount).toHaveClass("hidden");
    expect(googleMount).toHaveClass("hidden");
    expect(screen.queryByText("Live availability depends on your device and browser.")).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(400); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applePay.attach).toHaveBeenCalledOnce();
    expect(applePay.attach).toHaveBeenCalledWith(appleMount);
    expect(appleMount).not.toHaveClass("hidden");
    expect(googleMount).toHaveClass("hidden");
    expect(screen.getByText("Provider Apple Pay")).toBeInTheDocument();
    expect(screen.queryByText("Live availability depends on your device and browser.")).not.toBeInTheDocument();
  });
});
