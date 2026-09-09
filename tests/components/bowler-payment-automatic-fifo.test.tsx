import { beforeEach, describe, expect, it, vi } from "vitest";
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
  prepareRosterPaymentIntent: vi.fn(),
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
  clearPaymentIntent: mocks.clearPaymentIntent,
  interactivePaymentIntentScope: () => "stable-scope",
  paymentRequestHeaders: () => ({ "Content-Type": "application/json" }),
  paymentRequestWithRecovery: (_key: string, request: () => Promise<unknown>) => request(),
  prepareRosterPaymentIntent: mocks.prepareRosterPaymentIntent,
}));
vi.mock("@/lib/provider-not-configured", () => ({
  isProviderNotConfiguredError: () => false,
  providerNotConfiguredToast: () => ({}),
  makeApiError: (_body: unknown, _status: number, message: string) => new Error(message),
}));
vi.mock("@/lib/payment-user-error", () => ({ isHandledPaymentError: () => false, sanitizePaymentErrorMessage: (error: unknown) => String(error) }));
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
    actorUserId: 1,
    organizationId: 2,
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
  beforeEach(() => {
    mocks.csrfFetch.mockReset();
    mocks.tokenizeCard.mockReset();
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "automatic-fifo-request", outcome: "new" });
  });

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

  it("recovers an acknowledged lost response before a changed quote can tokenize or charge again", async () => {
    mocks.prepareRosterPaymentIntent
      .mockResolvedValueOnce({ requestKey: "automatic-fifo-request", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "automatic-fifo-request", outcome: "succeeded" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "first-quote", payerBowlerId: bowler.id } }) })
      .mockRejectedValueOnce(new Error("response lost"));
    mocks.tokenizeCard.mockResolvedValue("card-source");

    const user = userEvent.setup();
    render(<SubmitProbe />);
    await user.click(screen.getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(mocks.tokenizeCard).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Pay" }));

    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledTimes(2));
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.tokenizeCard).toHaveBeenCalledOnce();
  });

  it("keeps an unresolved intent authoritative and permits a new attempt after a terminal outcome", async () => {
    mocks.prepareRosterPaymentIntent
      .mockResolvedValueOnce({ requestKey: "automatic-fifo-request", outcome: "unresolved", status: "pending" })
      .mockResolvedValueOnce({ requestKey: "automatic-fifo-request", outcome: "terminal_failure", status: "failed_terminal" })
      .mockResolvedValueOnce({ requestKey: "automatic-fifo-request-2", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "retry-quote", payerBowlerId: bowler.id } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { status: "succeeded" } }) });
    mocks.tokenizeCard.mockResolvedValue("card-source");

    const user = userEvent.setup();
    render(<SubmitProbe />);
    await user.click(screen.getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledOnce());
    expect(mocks.csrfFetch).not.toHaveBeenCalled();
    expect(mocks.tokenizeCard).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledTimes(2));
    expect(mocks.csrfFetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledTimes(3));
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
  });

  it("uses plus and minus controls to select a fixed number of weeks", async () => {
    const onPaymentWeekCountChange = vi.fn();
    const user = userEvent.setup();
    render(<BowlerPaymentDialog
      payDialogType="remaining"
      onClose={vi.fn()}
      remainingBalance={3_000}
      paymentWeekCount={2}
      maximumWeekCount={3}
      paymentAmountMinor={2_000}
      onPaymentWeekCountChange={onPaymentWeekCountChange}
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

    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Number of weeks to pay" })).toHaveTextContent("2");
    expect(screen.getByText("Remaining balance: $30.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $20.00" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pay for one fewer week" }));
    await user.click(screen.getByRole("button", { name: "Pay for one more week" }));
    expect(onPaymentWeekCountChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPaymentWeekCountChange).toHaveBeenNthCalledWith(2, 3);
    expect(screen.queryByText(/week of/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/allocation/i)).not.toBeInTheDocument();
  });

  it.each([
    ["card", true, false],
    ["wallet", false, true],
  ] as const)("locks the week selection while a %s payment is in flight", (_kind, isSubmitting, isWalletProcessing) => {
    render(<BowlerPaymentDialog
      payDialogType="remaining"
      onClose={vi.fn()}
      remainingBalance={3_000}
      paymentWeekCount={2}
      maximumWeekCount={3}
      paymentAmountMinor={2_000}
      onPaymentWeekCountChange={vi.fn()}
      savedCards={[]}
      cardMode="new"
      setCardMode={vi.fn()}
      selectedSavedCardId=""
      setSelectedSavedCardId={vi.fn()}
      storeCard={false}
      setStoreCard={vi.fn()}
      isSubmitting={isSubmitting}
      isWalletProcessing={isWalletProcessing}
      onSubmit={vi.fn()}
      isInitialized
      initializeCard={vi.fn()}
      cleanupCard={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Pay for one fewer week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pay for one more week" })).toBeDisabled();
  });
});
