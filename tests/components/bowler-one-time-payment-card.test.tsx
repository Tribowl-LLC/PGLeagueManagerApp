import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { BowlerOneTimePaymentCard, type PaymentBreakdownRow, type PaymentRecipientRow } from "@/components/bowler-one-time-payment-card";

function renderCard(fullBalanceOnly: boolean, overrides: Partial<PaymentRecipientRow> = {}, additionalRows: PaymentRecipientRow[] = [], breakdownRows: PaymentBreakdownRow[] = [], isWalletProcessing = false) {
  const applePayRef: RefObject<HTMLDivElement | null> = { current: null };
  const googlePayRef: RefObject<HTMLDivElement | null> = { current: null };
  const onRecipientToggle = vi.fn();
  const onRecipientWeeksChange = vi.fn();
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
    isWalletProcessing={isWalletProcessing}
    bowlerHasEmail
    receiptEmail=""
    onReceiptEmailChange={vi.fn()}
    recipientRows={[recipient, ...additionalRows]}
    breakdownRows={breakdownRows}
    onRecipientToggle={onRecipientToggle}
    onRecipientWeeksChange={onRecipientWeeksChange}
  />);
  return { onRecipientToggle, onRecipientWeeksChange };
}

describe("BowlerOneTimePaymentCard payment mode", () => {
  it("shows the selected recipient full balance for an upfront league", () => {
    renderCard(true);

    expect(screen.getByText("Bowler (You)")).toBeInTheDocument();
    expect(screen.queryByText("Who would you like to pay?")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pay Bowler" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("label[for^='payment-recipient-']")).toHaveLength(0);
    expect(screen.getByText("Remaining balance: $87.50")).toBeInTheDocument();
    expect(screen.getByText("Past due: $25.00")).toBeInTheDocument();
    expect(screen.getByText("Full Season Remaining Balance")).toBeInTheDocument();
    expect(screen.queryByText("Weeks")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /one more week/i })).not.toBeInTheDocument();
    expect(screen.getByText("Full Season Remaining Balance").parentElement).toHaveTextContent("$87.50");
    expect(screen.getByRole("button", { name: "Pay $87.50" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Save this card for future payments" })).not.toBeChecked();
  });

  it("automatically selects a solo bowler while keeping independent weekly controls", () => {
    const { onRecipientToggle, onRecipientWeeksChange } = renderCard(false);

    expect(screen.queryByText("Choose who to pay and how many weeks to cover. Each recipient is paid oldest-first.")).not.toBeInTheDocument();
    expect(screen.queryByText("Who would you like to pay?")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pay Bowler" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("label[for^='payment-recipient-']")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Pay Bowler for one fewer week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay Bowler for one more week" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Number of weeks to pay for Bowler" })).toHaveTextContent("3");
    expect(screen.getByText("Remaining balance: $87.50")).toBeInTheDocument();
    expect(screen.queryByText("Select at least one recipient to continue.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pay Bowler for one fewer week" }));
    expect(onRecipientWeeksChange).toHaveBeenCalledWith(42, 2);
    expect(onRecipientToggle).not.toHaveBeenCalled();
  });

  it("shows partner identity and server-projected covered weeks without exposing allocation ids", () => {
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
        coveredWeeks: ["Week 1"],
        allocations: [{ obligationId: "obligation-1", amountMinor: 3_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1" }],
      },
      {
        bowlerId: 84,
        name: "Alex Partner",
        role: "partner",
        amountMinor: 4_000,
        coveredWeeks: ["Week 2", "Week 3"],
        allocations: [
          { obligationId: "obligation-2", amountMinor: 2_000, occurrenceLocalDate: "2026-09-08", plannedOrdinal: 2, label: "Week 2" },
          { obligationId: "obligation-3", amountMinor: 2_000, occurrenceLocalDate: "2026-09-15", plannedOrdinal: 3, label: "Week 3" },
        ],
      },
    ]);

    expect(screen.getByText("Alex Partner (Partner)")).toBeInTheDocument();
    expect(screen.getByText("Remaining balance: $60.00")).toBeInTheDocument();
    expect(screen.getByText("Past due: $10.00")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pay Alex Partner" })).toBeChecked();
    expect(screen.getByText("Alex Partner")).toBeInTheDocument();
    expect(screen.getByText("Week 2 · 2026-09-08")).toBeInTheDocument();
    expect(screen.getByText("Week 3 · 2026-09-15")).toBeInTheDocument();
    expect(screen.queryByText(/obligation-|allocation/i)).not.toBeInTheDocument();
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

    expect(screen.getByText("Choose who to pay and how many weeks to cover. Each recipient is paid oldest-first.")).toBeInTheDocument();
    expect(screen.getByText("Who would you like to pay?")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pay Bowler" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Pay Alex Partner" })).toBeDisabled();
    expect(screen.getByText("No remaining balance")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Pay $87.50" })).toBeDisabled();
  });

  it("keeps repeated schedule labels distinct with server obligation identity", () => {
    renderCard(false, {}, [], [{
      bowlerId: 42,
      name: "Bowler",
      role: "self",
      amountMinor: 4_000,
      coveredWeeks: ["Week 1", "Week 1"],
      allocations: [
        { obligationId: "obligation-1", amountMinor: 2_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1" },
        { obligationId: "obligation-2", amountMinor: 2_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1" },
      ],
    }]);

    expect(screen.getAllByText("Week 1 · 2026-09-01")).toHaveLength(2);
  });
});
