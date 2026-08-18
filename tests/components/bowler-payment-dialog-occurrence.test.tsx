import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BowlerPaymentDialog } from "@/components/bowler-payment-dialog";
import { InteractiveOccurrenceSelector } from "@/components/interactive-occurrence-selector";

vi.mock("@/lib/queryClient", () => ({
  csrfFetch: vi.fn(async () => new Response(JSON.stringify({
    rows: [{ obligationId: "11111111-1111-4111-8111-111111111111", bowlerId: 7, amountMinor: 2000, outstandingMinor: 2000, dueAt: null }],
    fingerprint: `lvpayquote:v1:${"a".repeat(64)}`,
  }), { status: 200, headers: { "content-type": "application/json" } })),
}));

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
});
