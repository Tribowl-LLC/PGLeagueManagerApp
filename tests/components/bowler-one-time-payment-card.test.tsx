import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { BowlerOneTimePaymentCard, type CompletedPayment, type PaymentBreakdownRow, type PaymentRecipientRow } from "@/components/bowler-one-time-payment-card";

function renderCard(fullBalanceOnly: boolean, overrides: Partial<PaymentRecipientRow> = {}, additionalRows: PaymentRecipientRow[] = [], breakdownRows: PaymentBreakdownRow[] = [], isWalletProcessing = false, selectionStale = false, recipientRowsOverride?: PaymentRecipientRow[], dueNowOnly = false, options: { quoteLoading?: boolean; previewQuote?: { amountMinor: number; rows: PaymentBreakdownRow[] } | null; applePayAvailable?: boolean; googlePayAvailable?: boolean; cardMode?: "new" | "saved"; selectedSavedCardId?: string; savedCards?: Array<{ id: string; brand: string; last4: string; expMonth: number; expYear: number }>; storeCard?: boolean; quoteFingerprint?: string; completedPayment?: CompletedPayment; onViewPaymentHistory?: () => void; onMakeAnotherPayment?: () => void; onRetryQuote?: () => void; hasAccountForecastChoices?: boolean } = {}) {
  const applePayRef: RefObject<HTMLDivElement | null> = { current: null };
  const googlePayRef: RefObject<HTMLDivElement | null> = { current: null };
  const onRecipientToggle = vi.fn();
  const onRecipientWeeksChange = vi.fn();
  const onSubmit = vi.fn();
  const recipient: PaymentRecipientRow = {
    bowlerId: 42,
    name: "Bowler",
    role: "self",
    remainingMinor: 8_750,
    pastDueMinor: 2_500,
    weeks: 3,
    maximumWeekCount: 3,
    amountMinor: 8_750,
    selected: true,
    eligible: true,
    reason: null,
    ...overrides,
  };
  render(<BowlerOneTimePaymentCard
    paymentAmountMinor={recipient.amountMinor}
    fullBalanceOnly={fullBalanceOnly}
    savedCards={options.savedCards ?? []}
    cardMode={options.cardMode ?? "new"}
    setCardMode={vi.fn()}
    selectedSavedCardId={options.selectedSavedCardId ?? ""}
    setSelectedSavedCardId={vi.fn()}
    storeCard={options.storeCard ?? false}
    setStoreCard={vi.fn()}
    isInitialized
    isSubmitting={false}
    onSubmit={onSubmit}
    initializeCard={vi.fn(async () => undefined)}
    cleanupCard={vi.fn()}
    onCardEditorModeChange={vi.fn()}
    cardEditorMode="one-time"
    applePayAvailable={options.applePayAvailable ?? false}
    googlePayAvailable={options.googlePayAvailable ?? false}
    applePayTokenizeOnly={false}
    googlePayTokenizeOnly={false}
    applePayRef={applePayRef}
    googlePayRef={googlePayRef}
    onApplePayClick={vi.fn(async () => undefined)}
    onGooglePayClick={vi.fn(async () => undefined)}
    isWalletProcessing={isWalletProcessing}
    bowlerHasEmail
    receiptEmail=""
    onReceiptEmailChange={vi.fn()}
    recipientRows={recipientRowsOverride ?? [recipient, ...additionalRows]}
    breakdownRows={breakdownRows}
    quoteLoading={options.quoteLoading}
    previewQuote={options.previewQuote}
    quoteFingerprint={options.quoteFingerprint}
    completedPayment={options.completedPayment}
    onViewPaymentHistory={options.onViewPaymentHistory}
    onMakeAnotherPayment={options.onMakeAnotherPayment}
    onRetryQuote={options.onRetryQuote}
    selectionStale={selectionStale}
    onRecipientToggle={onRecipientToggle}
    onRecipientWeeksChange={onRecipientWeeksChange}
    dueNowOnly={dueNowOnly}
    onCancelDueNow={vi.fn()}
    hasAccountForecastChoices={options.hasAccountForecastChoices}
  />);
  return { onRecipientToggle, onRecipientWeeksChange, onSubmit };
}

describe("BowlerOneTimePaymentCard payment mode", () => {
  it("shows the on-page total while the quote loads but keeps review locked until it arrives", () => {
    renderCard(false, { weeks: 2, amountMinor: 0 }, [], [], false, false, undefined, false, {
      quoteLoading: true,
      previewQuote: { amountMinor: 5_000, rows: [{ bowlerId: 42, name: "Bowler", role: "self", amountMinor: 5_000 }] },
    });
    expect(screen.queryByText("Calculating…")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("payment-breakdown")).getAllByText("$50")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Review payment/ })).toBeDisabled();
  });

  it("falls back to the calculating label when no on-page total is available", () => {
    renderCard(false, { weeks: 2, amountMinor: 0 }, [], [], false, false, undefined, false, { quoteLoading: true });
    expect(screen.getAllByText("Calculating…").length).toBeGreaterThan(0);
  });

  it("reviews one server-priced week without offering an arbitrary amount", () => {
    const { onSubmit } = renderCard(false, { weeks: 1, maximumWeekCount: 1, hasPricedWeekOptions: true, amountMinor: 2_500 }, [], [], false, false, undefined, false, {
      hasAccountForecastChoices: true,
    });

    expect(screen.queryByRole("textbox", { name: "Amount to add to your account" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay Bowler for one more week" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review payment of $25" }));
    expect(screen.getByRole("dialog", { name: "Review payment" })).toHaveTextContent("Payment selection");
    expect(screen.getByRole("dialog", { name: "Review payment" })).toHaveTextContent("1 week selected");
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("shows an unavailable state and disables review when no server-priced week option exists", () => {
    renderCard(false, { amountMinor: 0 }, [], [], false, false, undefined, false, {
      hasAccountForecastChoices: false,
    });

    expect(screen.queryByText("Weeks to pay")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Amount to add to your account" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Weekly payments are unavailable for this league right now. Contact your league manager for help.");
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
  });

  it("tells a weekly bowler the server proved paid in full that no payment is needed", () => {
    renderCard(false, { amountMinor: 0, remainingMinor: 0, pastDueMinor: 0, seasonPaidInFull: true }, [], [], false, false, undefined, false, {
      hasAccountForecastChoices: false,
    });

    expect(screen.getByRole("status")).toHaveTextContent("Paid in full, no additional payment needed.");
    expect(screen.queryByText(/Weekly payments are unavailable/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
  });

  it("does not infer paid in full from a zero balance the server did not prove", () => {
    renderCard(false, { amountMinor: 0, remainingMinor: 0, pastDueMinor: 0, seasonPaidInFull: false, noPaymentDue: false }, [], [], false, false, undefined, false, {
      hasAccountForecastChoices: false,
    });

    expect(screen.getByRole("status")).toHaveTextContent("Weekly payments are unavailable for this league right now. Contact your league manager for help.");
    expect(screen.queryByText(/Paid in full/)).not.toBeInTheDocument();
  });

  it("tells a recipient the server proved owes nothing that no payment is due", () => {
    renderCard(false, { amountMinor: 0, remainingMinor: 0, pastDueMinor: 0, seasonPaidInFull: false, noPaymentDue: true }, [], [], false, false, undefined, false, {
      hasAccountForecastChoices: false,
    });

    expect(screen.getByRole("status")).toHaveTextContent("No payment is due right now.");
    expect(screen.queryByText(/Paid in full/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Weekly payments are unavailable/)).not.toBeInTheDocument();
  });

  it("does not ask for a recipient when linked recipients are all paid in full", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 0,
      pastDueMinor: 0,
      weeks: 1,
      maximumWeekCount: 1,
      hasPricedWeekOptions: false,
      amountMinor: 0,
      selected: false,
      eligible: false,
      reason: "Paid in full, no additional payment needed.",
      seasonPaidInFull: true,
    };
    renderCard(false, {
      amountMinor: 0, remainingMinor: 0, pastDueMinor: 0, selected: false, eligible: false,
      reason: "Paid in full, no additional payment needed.", hasPricedWeekOptions: false, seasonPaidInFull: true,
    }, [partner], [], false, false, undefined, false, {
      hasAccountForecastChoices: false,
    });

    expect(screen.getByRole("status")).toHaveTextContent("Paid in full, no additional payment needed.");
    expect(screen.queryByText("Select at least one recipient to continue.")).not.toBeInTheDocument();
  });

  it("keeps combined autopay review available for its server-quoted current collection", () => {
    renderCard(false, { amountMinor: 4_500 }, [], [], false, false, undefined, true);

    expect(screen.getByText("Pay the amount needed to get up to date and enable automatic payments in one checkout.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Amount to add to your account" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment of $45" })).toBeEnabled();
  });

  it("lets a payable partner review a week while the unavailable self row stays disabled", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 6_000,
      pastDueMinor: 0,
      weeks: 1,
      maximumWeekCount: 1,
      hasPricedWeekOptions: true,
      amountMinor: 6_000,
      selected: true,
      eligible: true,
      reason: null,
    };
    renderCard(false, {
      amountMinor: 6_000,
      selected: false,
      eligible: false,
      reason: "Weekly payments are unavailable for this recipient right now.",
      hasPricedWeekOptions: false,
    }, [partner], [], false, false, undefined, false, {
      hasAccountForecastChoices: true,
    });

    expect(screen.getByRole("checkbox", { name: "Pay Bowler" })).toBeDisabled();
    expect(screen.getByText("Weekly payments are unavailable for this recipient right now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review payment of $60" }));
    const review = screen.getByRole("dialog", { name: "Review payment" });
    expect(review).toHaveTextContent("Alex Partner");
    expect(review).toHaveTextContent("1 week selected");
    expect(review).not.toHaveTextContent("Bowler");
  });

  it("explains when the participant projection is empty without showing an impossible chooser action", () => {
    renderCard(false, { amountMinor: 0 }, [], [], false, false, []);

    expect(screen.getByText("No payment recipients are available for this league.")).toBeInTheDocument();
    expect(screen.queryByText("Select at least one recipient to continue.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
  });

  it("shows the selected recipient full balance for an upfront league", () => {
    renderCard(true);

    expect(screen.getByText("Full season payment")).toBeInTheDocument();
    expect(screen.getByText("Payment total").parentElement).toHaveTextContent("$87.50");
    expect(screen.queryByTestId("payment-recipient-42")).not.toBeInTheDocument();
    expect(screen.queryByText("Who would you like to pay?")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pay Bowler" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("label[for^='payment-recipient-']")).toHaveLength(0);
    expect(screen.queryByText("Remaining balance: $87.50")).not.toBeInTheDocument();
    expect(screen.queryByText("Past due: $25.00")).not.toBeInTheDocument();
    expect(screen.queryByText("Full season remaining balance")).not.toBeInTheDocument();
    expect(screen.queryByText("Weeks to pay")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /one more week/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Save this card for future payments" })).not.toBeChecked();
  });

  it("requires an explicit final action after reviewing the quoted payment", () => {
    const { onSubmit } = renderCard(false);

    fireEvent.click(screen.getByRole("button", { name: "Review payment of $87.50" }));
    expect(screen.getByRole("dialog", { name: "Review payment" })).toHaveTextContent("$87.50");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review payment of $87.50" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("locks combined automatic-payment setup to the amount needed to get up to date", () => {
    renderCard(false, { amountMinor: 4_500, weeks: 2 }, [], [], false, false, undefined, true);

    expect(screen.getByText("Pay the amount needed to get up to date and enable automatic payments in one checkout.")).toBeInTheDocument();
    expect(screen.getByText("Amount needed to get up to date").parentElement).toHaveTextContent("$45");
    expect(screen.queryByRole("button", { name: /one more week/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment of $45" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("makes recurring enrollment explicit in the combined-autopay review", () => {
    renderCard(false, { amountMinor: 4_500, weeks: 2 }, [], [], false, false, undefined, true);

    expect(screen.getByText("Save this card to enroll in recurring automatic payments")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review payment of $45" }));
    const dialog = screen.getByRole("dialog", { name: "Review payment" });
    expect(dialog).toHaveTextContent("confirming and enrolling in recurring automatic payments");
    expect(dialog).toHaveTextContent("Save card for recurring automatic payments");
    expect(screen.getByRole("button", { name: "Confirm payment and enable automatic payments" })).toBeEnabled();
  });

  it("automatically selects a solo bowler while keeping independent weekly controls", () => {
    const { onRecipientToggle, onRecipientWeeksChange } = renderCard(false);

    expect(screen.queryByText("Choose who to pay and how many weeks to pay for.")).not.toBeInTheDocument();
    expect(screen.queryByText("Who would you like to pay?")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pay Bowler" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("label[for^='payment-recipient-']")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Pay Bowler for one fewer week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay Bowler for one more week" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Number of weeks to pay for Bowler" })).toHaveTextContent("3");
    expect(screen.queryByTestId("payment-recipient-42")).not.toBeInTheDocument();
    expect(screen.queryByText("Remaining balance: $87.50")).not.toBeInTheDocument();
    expect(screen.queryByText("Select at least one recipient to continue.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pay Bowler for one fewer week" }));
    expect(onRecipientWeeksChange).toHaveBeenCalledWith(42, 2);
    expect(onRecipientToggle).not.toHaveBeenCalled();
  });

  it("shows partner identity, balances, and the quoted partner subtotal", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 6_000,
      pastDueMinor: 1_000,
      weeks: 2,
      maximumWeekCount: 3,
      amountMinor: 4_000,
      selected: true,
      eligible: true,
      reason: null,
    };
    const { onRecipientToggle, onRecipientWeeksChange } = renderCard(false, { amountMinor: 3_000, weeks: 1 }, [partner], [
      {
        bowlerId: 42,
        name: "Bowler",
        role: "self",
        amountMinor: 3_000,
      },
      {
        bowlerId: 84,
        name: "Alex Partner",
        role: "partner",
        amountMinor: 4_000,
      },
    ]);

    expect(screen.getByText("Alex Partner (Partner)")).toBeInTheDocument();
    expect(screen.getByText("Remaining balance: $60")).toBeInTheDocument();
    expect(screen.getByText("Past due: $10")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pay Alex Partner" })).toBeChecked();
    expect(screen.getByText("Alex Partner")).toBeInTheDocument();
    expect(screen.getByTestId("payment-breakdown")).toHaveTextContent("Alex Partner$40");
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay Alex Partner" }));
    expect(onRecipientToggle).toHaveBeenCalledWith(84, false);
    fireEvent.click(screen.getByRole("button", { name: "Pay Alex Partner for one more week" }));
    expect(onRecipientWeeksChange).toHaveBeenCalledWith(84, 3);
  });

  it("keeps the chooser when a partner is present but not payable", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 0,
      pastDueMinor: 0,
      weeks: 1,
      maximumWeekCount: 1,
      amountMinor: 0,
      selected: false,
      eligible: false,
      reason: "No remaining balance",
    };
    renderCard(false, {}, [partner]);

    expect(screen.getByText("Choose who to pay and how many weeks to pay for.")).toBeInTheDocument();
    expect(screen.getByText("Who would you like to pay?")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pay Bowler" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Pay Alex Partner" })).toBeDisabled();
    expect(screen.getByText("No remaining balance")).toBeInTheDocument();
  });

  it("does not show the removed wallet availability note", () => {
    renderCard(false, {}, [], [], false, false, undefined, false, { applePayAvailable: true });

    expect(screen.queryByText("Live availability depends on your device and browser.")).not.toBeInTheDocument();
    expect(screen.getByText("Pay with a card")).toBeInTheDocument();
  });

  it.each([false, true])("uses generic available-bowler/payment-detail language for stale %s payment choices", (fullBalanceOnly) => {
    renderCard(fullBalanceOnly, {}, [], [], false, true);

    expect(screen.getByText("The available bowler or payment details changed while this page was open. Review the available bowler and payment details before paying.")).toBeInTheDocument();
    expect(screen.queryByText(/balance changed|week count/i)).not.toBeInTheDocument();
  });

  it("locks recipient choices and card submission while a wallet sheet is processing", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 6_000,
      pastDueMinor: 1_000,
      weeks: 2,
      maximumWeekCount: 3,
      amountMinor: 4_000,
      selected: true,
      eligible: true,
      reason: null,
    };
    renderCard(false, { weeks: 2 }, [partner], [], true);

    expect(screen.getByRole("checkbox", { name: "Pay Bowler" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pay Bowler for one fewer week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pay Bowler for one more week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review payment of $87.50" })).toBeDisabled();
  });

  it("reviews a saved-card weekly payment with league, selection, method, and total", () => {
    const { onSubmit } = renderCard(false, {}, [], [], false, false, undefined, false, {
      cardMode: "saved",
      selectedSavedCardId: "saved-1",
      savedCards: [{ id: "saved-1", brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 }],
      quoteFingerprint: "quote-saved",
    });

    fireEvent.click(screen.getByRole("button", { name: "Review payment of $87.50" }));
    const dialog = screen.getByRole("dialog", { name: "Review payment" });
    expect(dialog).toHaveTextContent("Selected league");
    expect(dialog).toHaveTextContent("3 weeks selected");
    expect(dialog).toHaveTextContent("VISA ending in 4242");
    expect(dialog).toHaveTextContent("$87.50");
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the review action label and arrow together", () => {
    renderCard(false);

    const reviewButton = screen.getByRole("button", { name: "Review payment of $87.50" });
    expect(reviewButton).not.toHaveClass("ml-auto");
    expect(reviewButton.querySelector("svg")).toBeInTheDocument();
    expect(reviewButton.querySelector("svg")).not.toHaveClass("size-4");
    expect(document.querySelector(".familiar-one-time-card")).toContainElement(reviewButton);
  });

  it("shows Save card for later only when a new card is selected and stored", () => {
    renderCard(true, {}, [], [], false, false, undefined, false, { storeCard: true });

    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    expect(screen.getByRole("dialog", { name: "Review upfront payment" })).toHaveTextContent("Save card for later");
  });

  it("includes each selected recipient and quoted subtotal in an upfront review", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 6_000,
      pastDueMinor: 0,
      weeks: 2,
      maximumWeekCount: 2,
      amountMinor: 6_000,
      selected: true,
      eligible: true,
      reason: null,
    };
    renderCard(true, { amountMinor: 2_750 }, [partner], [
      { bowlerId: 42, name: "Bowler", role: "self", amountMinor: 2_750 },
      { bowlerId: 84, name: "Alex Partner", role: "partner", amountMinor: 6_000 },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    const dialog = screen.getByRole("dialog", { name: "Review upfront payment" });
    expect(dialog).toHaveTextContent("BowlerFull season · $27.50");
    expect(dialog).toHaveTextContent("Alex PartnerFull season · $60");
  });

  it("shows the authoritative quote subtotal when a partner projection differs", () => {
    const partner: PaymentRecipientRow = {
      bowlerId: 84,
      name: "Alex Partner",
      role: "partner",
      remainingMinor: 6_000,
      pastDueMinor: 0,
      weeks: 2,
      maximumWeekCount: 2,
      amountMinor: 6_000,
      selected: true,
      eligible: true,
      reason: null,
    };
    renderCard(true, { amountMinor: 2_750 }, [partner], [
      { bowlerId: 42, name: "Bowler", role: "self", amountMinor: 2_750 },
      { bowlerId: 84, name: "Alex Partner", role: "partner", amountMinor: 5_000 },
    ]);

    const reviewButton = screen.getByRole("button", { name: "Review payment" });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);
    const dialog = screen.getByRole("dialog", { name: "Review upfront payment" });
    expect(dialog).toHaveTextContent("Alex PartnerFull season · $50");
    expect(dialog).not.toHaveTextContent("Alex PartnerFull season · $60");
  });

  it("renders card completion only from an already confirmed and refreshed payment", () => {
    renderCard(false, {}, [], [], false, false, undefined, false, {
      completedPayment: {
        amountMinor: 2_500,
        paymentSelection: "1 week",
        isUpfront: false,
        hasRemainingBalance: true,
        recipients: [{ bowlerId: 84, name: "Alex Partner", role: "partner", amountMinor: 2_500, coverage: "1 week" }],
      },
      onViewPaymentHistory: vi.fn(),
      onMakeAnotherPayment: vi.fn(),
    });

    expect(screen.getByRole("status")).toHaveTextContent("Payment complete");
    expect(screen.getByRole("status")).toHaveTextContent("Paid $25 for 1 week.");
    expect(screen.getByRole("status")).toHaveTextContent("Alex Partner");
    expect(screen.getByRole("button", { name: "View payment history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make another payment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm payment/ })).not.toBeInTheDocument();
  });

  it("shows selected account weeks without claiming account credit allocated future obligations", () => {
    renderCard(false, {}, [], [], false, false, undefined, false, {
      completedPayment: {
        amountMinor: 2_500,
        paymentSelection: "1 week",
        isUpfront: false,
        hasRemainingBalance: true,
        recipients: [{ bowlerId: 84, name: "Alex Partner", role: "partner", amountMinor: 2_500, coverage: "1 week" }],
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent("Paid $25 for 1 week.");
    expect(screen.getByRole("status")).not.toHaveTextContent("account credit");
    expect(screen.getByRole("status")).toHaveTextContent("Alex Partner");
    expect(screen.getByRole("status")).toHaveTextContent("1 week");
  });

  it("shows the full-season selection in account completion copy", () => {
    renderCard(true, {}, [], [], false, false, undefined, false, {
      completedPayment: {
        amountMinor: 5_000,
        paymentSelection: "full season",
        isUpfront: true,
        hasRemainingBalance: false,
        recipients: [{ bowlerId: 42, name: "Bowler", role: "self", amountMinor: 5_000, coverage: "full season" }],
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent("Paid $50 for full season.");
    expect(screen.getByRole("status")).not.toHaveTextContent("account credit");
  });


});
