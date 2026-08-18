import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BowlerPaymentDialog } from "@/components/bowler-payment-dialog";
import { InteractiveOccurrenceSelector } from "@/components/interactive-occurrence-selector";
import { PaymentSubmitSection } from "@/components/payment-submit-section";

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
          occurrenceSelector={<InteractiveOccurrenceSelector leagueId={11} amountMinor={2000} bowlerIds={[7]} enabled onChange={onChange} />}
        />
      </QueryClientProvider>,
    );
    const checkbox = await screen.findByRole("checkbox");
    await userEvent.click(checkbox);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([
      { obligationId: "11111111-1111-4111-8111-111111111111", amountMinor: 2000 },
    ], `lvpayquote:v1:${"a".repeat(64)}`));
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
});
