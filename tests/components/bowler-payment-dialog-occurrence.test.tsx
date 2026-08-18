import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BowlerPaymentDialog } from "@/components/bowler-payment-dialog";
import { InteractiveOccurrenceSelector, formatMinorUnitsAsDollars, formatMinorUnitsAsEditableDollars, parseCurrencyToMinorUnits } from "@/components/interactive-occurrence-selector";
import { PaymentSubmitSection } from "@/components/payment-submit-section";
import { PaymentFormActions } from "@/components/payment-form-actions";

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));

vi.mock("@/lib/queryClient", () => ({ csrfFetch: csrfFetchMock }));

beforeEach(() => {
  csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({
    rows: [{ obligationId: "11111111-1111-4111-8111-111111111111", bowlerId: 7, amountMinor: 2000, outstandingMinor: 2000, dueAt: null }],
    fingerprint: `lvpayquote:v1:${"a".repeat(64)}`,
  }), { status: 200, headers: { "content-type": "application/json" } }));
});

describe("history payment dialog occurrence selector", () => {
  it("allows selection inside the open dialog and submits the bound intent", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BowlerPaymentDialog
          payDialogType="remaining"
          onClose={vi.fn()}
          amountPastDue={2000}
          remainingBalance={2000}
          savedCards={[{ id: "card-1", brand: "Visa", last4: "1111", expMonth: 12, expYear: 2030 }]}
          cardMode="saved"
          setCardMode={vi.fn()}
          selectedSavedCardId="card-1"
          setSelectedSavedCardId={vi.fn()}
          storeCard={false}
          setStoreCard={vi.fn()}
          isInitialized
          isSubmitting={false}
          onSubmit={onSubmit}
          occurrenceReadiness="ready"
          initializeCard={vi.fn()}
          cleanupCard={vi.fn()}
          occurrenceSelector={<InteractiveOccurrenceSelector leagueId={11} timezone="America/Chicago" amountMinor={2000} bowlerIds={[7]} enabled onChange={onChange} />}
        />
      </QueryClientProvider>,
    );
    const checkbox = await screen.findByRole("checkbox");
    await userEvent.click(checkbox);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([
      { obligationId: "11111111-1111-4111-8111-111111111111", amountMinor: 2000 },
    ], `lvpayquote:v1:${"a".repeat(64)}`));
    expect(csrfFetchMock).toHaveBeenCalledWith("/api/payments-provider/payments/quote", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueId: 11, amountMinor: 2000, payees: [{ bowlerId: 7 }] }),
    }));
    await userEvent.click(screen.getByRole("button", { name: /pay \$20\.00/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("reports empty then ready readiness so active checkout can gate tokenization", async () => {
    const onReadinessChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InteractiveOccurrenceSelector
          leagueId={11}
          timezone="America/Chicago"
          amountMinor={2000}
          bowlerIds={[7]}
          enabled
          onChange={vi.fn()}
          onReadinessChange={onReadinessChange}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(onReadinessChange).toHaveBeenLastCalledWith('empty'));
    await userEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(onReadinessChange).toHaveBeenLastCalledWith('ready'));
  });

  it("keeps selection values in minor units while displaying and accepting dollars exactly", async () => {
    expect(formatMinorUnitsAsDollars(2000)).toBe("20.00");
    expect(formatMinorUnitsAsEditableDollars(100000)).toBe("1000.00");
    expect(parseCurrencyToMinorUnits("10.00")).toBe(1000);
    expect(parseCurrencyToMinorUnits("10.001")).toBeNull();
    expect(parseCurrencyToMinorUnits("0.00")).toBeNull();
    const onChange = vi.fn();
    const onReadinessChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InteractiveOccurrenceSelector
          leagueId={11}
          timezone="America/Chicago"
          amountMinor={2000}
          bowlerIds={[7]}
          enabled
          onChange={onChange}
          onReadinessChange={onReadinessChange}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("checkbox"));
    const input = await screen.findByRole("textbox", { name: /amount for obligation/i });
    expect(input).toHaveValue("20.00");
    await userEvent.clear(input);
    expect(input).toHaveValue("");
    await waitFor(() => expect(onReadinessChange).toHaveBeenLastCalledWith("empty"));
    await userEvent.type(input, "10.00");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([
      { obligationId: "11111111-1111-4111-8111-111111111111", amountMinor: 1000 },
    ], `lvpayquote:v1:${"a".repeat(64)}`));
    expect(input).toHaveValue("10.00");
    await userEvent.clear(input);
    await userEvent.type(input, "1000.00");
    expect(input).toHaveValue("1000.00");
    await waitFor(() => expect(onReadinessChange).toHaveBeenLastCalledWith("empty"));
    await userEvent.tab();
    expect(input).toHaveValue("20.00");
    expect(onChange.mock.calls.flatMap(([rows]) => rows).every((row: { amountMinor: number }) => Number.isInteger(row.amountMinor) && row.amountMinor > 0)).toBe(true);
  });

  it("formats due dates in the configured league timezone", async () => {
    csrfFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      rows: [{ obligationId: "11111111-1111-4111-8111-111111111111", bowlerId: 7, amountMinor: 2000, outstandingMinor: 2000, dueAt: "2030-01-01T01:30:00.000Z" }],
      fingerprint: `lvpayquote:v1:${"a".repeat(64)}`,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InteractiveOccurrenceSelector
          leagueId={11}
          timezone="America/Los_Angeles"
          amountMinor={2000}
          bowlerIds={[7]}
          enabled
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Dec 31, 2029/)).toBeInTheDocument();
  });

  it("disables the payment submit control while canonical selection is incomplete", () => {
    render(
      <PaymentSubmitSection
        league={{ paymentMode: 'upfront' }}
        selectedSchedule="custom"
        fixedAmountType="remaining"
        selectedWeeks={1}
        calculateTotalAmount={() => 2000}
        isSubmitting={false}
        cardMode="saved"
        isInitialized
        selectedSavedCardId="card-1"
        occurrenceReadiness="empty"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /pay \$20\.00/i })).toBeDisabled();
  });

  it("keeps an explicit legacy-unavailable state usable when the canonical quote is absent", async () => {
    csrfFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "OCCURRENCE_ALLOCATION_UNAVAILABLE" },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const onReadinessChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InteractiveOccurrenceSelector
          leagueId={11}
          timezone="America/Chicago"
          amountMinor={2000}
          bowlerIds={[7]}
          enabled
          onChange={vi.fn()}
          onReadinessChange={onReadinessChange}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(onReadinessChange).toHaveBeenLastCalledWith("legacy"));
    expect(screen.queryByTestId("interactive-occurrence-selector")).not.toBeInTheDocument();
  });

  it("does not let F2 readiness gate weekly auto-pay, which remains F3-owned", () => {
    render(
      <PaymentSubmitSection
        league={{ paymentMode: 'weekly' }}
        selectedSchedule="weekly"
        fixedAmountType="remaining"
        selectedWeeks={1}
        calculateTotalAmount={() => 2000}
        isSubmitting={false}
        cardMode="saved"
        isInitialized
        selectedSavedCardId="card-1"
        occurrenceReadiness="disabled"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /set up automatic payments/i })).not.toBeDisabled();
  });

  it("fails closed in admin card actions until canonical readiness is verified", () => {
    render(
      <PaymentFormActions
        onCancel={vi.fn()}
        isSubmitting={false}
        isWalletProcessing={false}
        paymentType="credit_card"
        providerNotFullyConfigured={false}
        cardMode="saved"
        isSquareReady
        selectedSavedCardId="card-1"
        selectedBowlerId={7}
        bowlerHasEmail
        receiptEmail=""
        occurrenceReadiness="loading"
      />,
    );
    expect(screen.getByRole('button', { name: /submit payment/i })).toBeDisabled();
  });
});
