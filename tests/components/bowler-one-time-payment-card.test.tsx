import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { BowlerOneTimePaymentCard, type PaymentBreakdownRow, type PaymentRecipientRow } from "@/components/bowler-one-time-payment-card";

function renderCard(fullBalanceOnly: boolean, overrides: Partial<PaymentRecipientRow> = {}, additionalRows: PaymentRecipientRow[] = [], breakdownRows: PaymentBreakdownRow[] = [], isWalletProcessing = false, selectionStale = false, recipientRowsOverride?: PaymentRecipientRow[], dueNowOnly = false, options: { applePayAvailable?: boolean; googlePayAvailable?: boolean; rotatingMode?: boolean } = {}) {
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
    savedCards={[]}
    cardMode="new"
    setCardMode={vi.fn()}
    selectedSavedCardId=""
    setSelectedSavedCardId={vi.fn()}
    storeCard={false}
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
    selectionStale={selectionStale}
    onRecipientToggle={onRecipientToggle}
    onRecipientWeeksChange={onRecipientWeeksChange}
    dueNowOnly={dueNowOnly}
    rotatingMode={options.rotatingMode ?? false}
    onCancelDueNow={vi.fn()}
  />);
  return { onRecipientToggle, onRecipientWeeksChange, onSubmit };
}

describe("BowlerOneTimePaymentCard payment mode", () => {
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
    expect(screen.getByText("Covers Weeks 1–3")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    expect(screen.getByRole("region", { name: "Review payment" })).toHaveTextContent("$87.50");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pay $87.50" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("locks combined automatic-payment setup to the amount needed to get up to date", () => {
    renderCard(false, { amountMinor: 4_500, weeks: 2 }, [], [], false, false, undefined, true);

    expect(screen.getByText("Pay the amount needed to get up to date and enable automatic payments in one checkout.")).toBeInTheDocument();
    expect(screen.getByText("Amount needed to get up to date").parentElement).toHaveTextContent("$45");
    expect(screen.queryByRole("button", { name: /one more week/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
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
    expect(screen.queryByTestId("payment-recipient-42")).not.toBeInTheDocument();
    expect(screen.queryByText("Remaining balance: $87.50")).not.toBeInTheDocument();
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
        allocations: [{ obligationId: "obligation-1", amountMinor: 3_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1", isPairedFinalWeek: false }],
      },
      {
        bowlerId: 84,
        name: "Alex Partner",
        role: "partner",
        amountMinor: 4_000,
        coveredWeeks: ["Week 2", "Week 3"],
        allocations: [
          { obligationId: "obligation-2", amountMinor: 2_000, occurrenceLocalDate: "2026-09-08", plannedOrdinal: 2, label: "Week 2", isPairedFinalWeek: false },
          { obligationId: "obligation-3", amountMinor: 2_000, occurrenceLocalDate: "2026-09-15", plannedOrdinal: 3, label: "Week 3", isPairedFinalWeek: false },
        ],
      },
    ]);

    expect(screen.getByText("Alex Partner (Partner)")).toBeInTheDocument();
    expect(screen.getByText("Remaining balance: $60")).toBeInTheDocument();
    expect(screen.getByText("Past due: $10")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pay Alex Partner" })).toBeChecked();
    expect(screen.getByText("Alex Partner")).toBeInTheDocument();
    expect(screen.getByText("Week 2 · 2026-09-08")).toBeInTheDocument();
    expect(screen.getByText("Week 3 · 2026-09-15")).toBeInTheDocument();
    expect(screen.getByText("This payment covers Bowler: through Week 1 · Alex Partner: through Week 3")).toBeInTheDocument();
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

  it("describes the normal coverage endpoint and one quoted paired final week", () => {
    renderCard(false, { weeks: 4 }, [], [{
      bowlerId: 42,
      name: "Bowler",
      role: "self",
      amountMinor: 4_000,
      coveredWeeks: ["Week 3", "Week 4", "Week 5", "Week 30"],
      allocations: [
        { obligationId: "obligation-3", amountMinor: 1_000, occurrenceLocalDate: "2026-09-15", plannedOrdinal: 3, label: "Week 3", isPairedFinalWeek: false },
        { obligationId: "obligation-4", amountMinor: 1_000, occurrenceLocalDate: "2026-09-22", plannedOrdinal: 4, label: "Week 4", isPairedFinalWeek: false },
        { obligationId: "obligation-5", amountMinor: 1_000, occurrenceLocalDate: "2026-09-29", plannedOrdinal: 5, label: "Week 5", isPairedFinalWeek: false },
        { obligationId: "obligation-30", amountMinor: 1_000, occurrenceLocalDate: "2027-04-27", plannedOrdinal: 30, label: "Week 30", isPairedFinalWeek: true },
      ],
    }]);

    expect(screen.getByText("This payment covers through Week 5 and includes Week 30")).toBeInTheDocument();
  });

  it("lists multiple quoted paired final weeks once each", () => {
    renderCard(false, { weeks: 5 }, [], [{
      bowlerId: 42,
      name: "Bowler",
      role: "self",
      amountMinor: 5_000,
      coveredWeeks: ["Week 5", "Week 30", "Week 30", "Week 6", "Week 31"],
      allocations: [
        { obligationId: "obligation-5", amountMinor: 1_000, occurrenceLocalDate: "2026-09-29", plannedOrdinal: 5, label: "Week 5", isPairedFinalWeek: false },
        { obligationId: "obligation-30a", amountMinor: 500, occurrenceLocalDate: "2027-04-27", plannedOrdinal: 30, label: "Week 30", isPairedFinalWeek: true },
        { obligationId: "obligation-30b", amountMinor: 500, occurrenceLocalDate: "2027-04-27", plannedOrdinal: 30, label: "Week 30", isPairedFinalWeek: true },
        { obligationId: "obligation-6", amountMinor: 1_000, occurrenceLocalDate: "2026-10-06", plannedOrdinal: 6, label: "Week 6", isPairedFinalWeek: false },
        { obligationId: "obligation-31", amountMinor: 1_000, occurrenceLocalDate: "2027-05-04", plannedOrdinal: 31, label: "Week 31", isPairedFinalWeek: true },
      ],
    }]);

    expect(screen.getByText("This payment covers through Week 6 and includes Weeks 30 and 31")).toBeInTheDocument();
  });

  it("keeps normal-only and paired-only coverage copy tied to quoted labels", () => {
    const normalOnly = {
      bowlerId: 42,
      name: "Bowler",
      role: "self" as const,
      amountMinor: 2_000,
      coveredWeeks: ["Week of 2026-09-01", "Week of 2026-09-08"],
      allocations: [
        { obligationId: "obligation-a", amountMinor: 1_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: null, label: "Week of 2026-09-01", isPairedFinalWeek: false },
        { obligationId: "obligation-b", amountMinor: 1_000, occurrenceLocalDate: "2026-09-08", plannedOrdinal: null, label: "Week of 2026-09-08", isPairedFinalWeek: false },
      ],
    } satisfies PaymentBreakdownRow;
    renderCard(false, {}, [], [normalOnly]);
    expect(screen.getByText("This payment covers through Week of 2026-09-08")).toBeInTheDocument();
    expect(screen.queryByText(/includes/)).not.toBeInTheDocument();
  });

  it("uses direct coverage copy when the quote contains only a paired final week", () => {
    renderCard(false, {}, [], [{
      bowlerId: 42,
      name: "Bowler",
      role: "self",
      amountMinor: 1_000,
      coveredWeeks: ["Week 30"],
      allocations: [{ obligationId: "obligation-30", amountMinor: 1_000, occurrenceLocalDate: "2027-04-27", plannedOrdinal: 30, label: "Week 30", isPairedFinalWeek: true }],
    }]);

    expect(screen.getByText("This payment covers Week 30")).toBeInTheDocument();
    expect(screen.queryByText("This payment covers through Week 30")).not.toBeInTheDocument();
  });

  it("keeps rotating payments in count-only coverage mode", () => {
    renderCard(false, { weeks: 3 }, [], [{
      bowlerId: 42,
      name: "Bowler",
      role: "self",
      amountMinor: 3_000,
      coveredWeeks: ["Week 3", "Week 30"],
      allocations: [
        { obligationId: "obligation-3", amountMinor: 2_000, occurrenceLocalDate: "2026-09-15", plannedOrdinal: 3, label: "Week 3", isPairedFinalWeek: false },
        { obligationId: "obligation-30", amountMinor: 1_000, occurrenceLocalDate: "2027-04-27", plannedOrdinal: 30, label: "Week 30", isPairedFinalWeek: true },
      ],
    }], false, false, undefined, false, { rotatingMode: true });

    expect(screen.getByText("This payment covers 3 weeks")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
  });

  it("keeps repeated schedule labels distinct with server obligation identity", () => {
    renderCard(false, {}, [], [{
      bowlerId: 42,
      name: "Bowler",
      role: "self",
      amountMinor: 4_000,
      coveredWeeks: ["Week 1", "Week 1"],
      allocations: [
        { obligationId: "obligation-1", amountMinor: 2_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1", isPairedFinalWeek: false },
        { obligationId: "obligation-2", amountMinor: 2_000, occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1", isPairedFinalWeek: false },
      ],
    }]);

    expect(screen.getAllByText("Week 1 · 2026-09-01")).toHaveLength(2);
  });
});
