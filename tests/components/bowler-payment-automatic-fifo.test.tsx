import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BowlerPaymentDialog } from "@/components/bowler-payment-dialog";
import { PaymentSummaryCards } from "@/components/payment-summary-cards";
import { useBowlerPaymentSubmit } from "@/hooks/use-bowler-payment-submit";
import type { Bowler, League } from "@shared/schema";

const mocks = vi.hoisted(() => ({
  csrfFetch: vi.fn(),
  tokenizeCard: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
  invalidateQueries: vi.fn(),
  clearPaymentIntent: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  csrfFetch: mocks.csrfFetch,
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));
vi.mock("@/lib/square", () => ({ tokenizeCard: mocks.tokenizeCard }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/", mocks.navigate] }));
vi.mock("@/lib/payment-request-identity", () => ({
  assertRosterPaymentSucceeded: (status: string) => {
    if (!["succeeded", "pending", "provider_unknown", "reconciliation_required"].includes(status)) throw new Error("unexpected payment status");
  },
  beginPaymentIntent: () => "automatic-fifo-request",
  clearPaymentIntent: mocks.clearPaymentIntent,
  paymentRequestHeaders: () => ({ "Content-Type": "application/json" }),
  paymentRequestWithRecovery: (_key: string, request: () => Promise<unknown>) => request(),
}));
vi.mock("@/lib/provider-not-configured", () => ({
  isProviderNotConfiguredError: () => false,
  providerNotConfiguredToast: () => ({}),
  makeApiError: (_body: unknown, _status: number, message: string) => new Error(message),
}));
vi.mock("@/lib/payment-user-error", () => ({ sanitizePaymentErrorMessage: (error: unknown) => String(error) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

const league: Pick<League, "id" | "locationId"> = { id: 17, locationId: null };
const bowler: Pick<Bowler, "id"> = { id: 9 };
const mockCard = {
  tokenize: async () => ({ status: "OK", token: "card-source" }),
  destroy: () => undefined,
  attach: async (_container: HTMLElement) => undefined,
};

function SubmitProbe() {
  const submit = useBowlerPaymentSubmit({
    league,
    bowler,
    card: mockCard,
    cardMode: "new",
    selectedSavedCardId: "",
    storeCard: false,
    buyerEmail: "payer@example.test",
    calculateTotalAmount: () => 3_000,
    setIsSubmitting: vi.fn(),
    setShowPaymentSetup: vi.fn(),
  });
  return <button type="button" onClick={() => void submit()}>Pay</button>;
}

describe("automatic FIFO bowler payment flow", () => {
  it("offers a one-time payment as soon as future roster obligations create a remaining balance", async () => {
    const onPayRemaining = vi.fn();
    const user = userEvent.setup();
    render(<PaymentSummaryCards
      totalWeeksInSeason={32}
      fullSeasonAmount={96_000}
      weeklyFee={3_000}
      weeksDueCount={0}
      totalSeasonDues={0}
      weeksPaid={0}
      totalPaidAmount={0}
      amountPastDue={0}
      remainingBalance={96_000}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false }}
      onPayPastDue={vi.fn()}
      onPayRemaining={onPayRemaining}
    />);

    await user.click(screen.getByText("Click to make a one-time payment"));
    expect(onPayRemaining).toHaveBeenCalledOnce();
  });

  it("quotes and charges only amount plus authorized payer", async () => {
    mocks.csrfFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url.includes("quote")
        ? { data: { fingerprint: "quote-fingerprint", payerBowlerId: bowler.id } }
        : { data: { status: "succeeded" } },
    }));
    mocks.tokenizeCard.mockResolvedValue("card-source");

    const user = userEvent.setup();
    render(<SubmitProbe />);
    await user.click(screen.getByRole("button", { name: "Pay" }));

    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(2));
    const quoteRequest: RequestInit = mocks.csrfFetch.mock.calls[0]?.[1];
    const chargeRequest: RequestInit = mocks.csrfFetch.mock.calls[1]?.[1];
    expect(JSON.parse(String(quoteRequest.body))).toEqual({ amountMinor: 3_000, payerBowlerId: bowler.id });
    expect(JSON.parse(String(chargeRequest.body))).toMatchObject({ amountMinor: 3_000, payerBowlerId: bowler.id, sourceId: "card-source" });
    expect(JSON.parse(String(chargeRequest.body))).not.toHaveProperty("obligationIds");
    expect(JSON.parse(String(chargeRequest.body))).not.toHaveProperty("allocations");
    expect(mocks.tokenizeCard).toHaveBeenCalledOnce();
  });

  it("accepts one operator-entered tender amount and no occurrence selector", () => {
    render(<BowlerPaymentDialog
      payDialogType="remaining"
      onClose={vi.fn()}
      remainingBalance={3_000}
      paymentAmount="10.00"
      paymentAmountMinor={1_000}
      onPaymentAmountChange={vi.fn()}
      savedCards={[]}
      cardMode="new"
      setCardMode={vi.fn()}
      selectedSavedCardId=""
      setSelectedSavedCardId={vi.fn()}
      storeCard={false}
      setStoreCard={vi.fn()}
      isInitialized={false}
      isSubmitting={false}
      onSubmit={vi.fn()}
      initializeCard={vi.fn()}
      cleanupCard={vi.fn()}
    />);

    expect(screen.getByRole("spinbutton", { name: "One-time payment amount" })).toHaveValue(10);
    expect(screen.getByText("Remaining balance: $30.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $10.00" })).toBeInTheDocument();
    expect(screen.queryByText(/week of/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/allocation/i)).not.toBeInTheDocument();
  });
});
