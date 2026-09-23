import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { League, SavedCard } from "@shared/schema";
import type { RotatingCreditBalanceWire, RotatingCreditOperationWire, RotatingCreditQuoteWire } from "@shared/rotating-credit-contract";

const mocks = vi.hoisted(() => {
  let balanceResponse: unknown = null;
  let quoteResponse: unknown = null;
  let balanceLoading = false;
  let providerLoading = false;
  let providerConfigured = false;
  let squareInitialized = false;
  let storedPaymentIntent: string | null = null;
  return {
    get balanceResponse() { return balanceResponse; },
    set balanceResponse(value: unknown) { balanceResponse = value; },
    get quoteResponse() { return quoteResponse; },
    set quoteResponse(value: unknown) { quoteResponse = value; },
    get balanceLoading() { return balanceLoading; },
    set balanceLoading(value: boolean) { balanceLoading = value; },
    get providerLoading() { return providerLoading; },
    set providerLoading(value: boolean) { providerLoading = value; },
    get providerConfigured() { return providerConfigured; },
    set providerConfigured(value: boolean) { providerConfigured = value; },
    get squareInitialized() { return squareInitialized; },
    set squareInitialized(value: boolean) { squareInitialized = value; },
    get storedPaymentIntent() { return storedPaymentIntent; },
    set storedPaymentIntent(value: string | null) { storedPaymentIntent = value; },
    invalidateQueries: vi.fn(async () => {}),
    toast: vi.fn(),
    initializeCard: vi.fn(),
    cleanupCard: vi.fn(),
    getPaymentIntent: vi.fn(() => storedPaymentIntent),
    clearPaymentIntent: vi.fn((_scope: string, requestKey: string) => {
      if (storedPaymentIntent === requestKey) storedPaymentIntent = null;
    }),
    beginPaymentIntent: vi.fn(() => {
      storedPaymentIntent = "request-key-000000000000";
      return storedPaymentIntent;
    }),
    csrfFetch: vi.fn(),
    tokenizeCard: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => String(queryKey[0]).includes("/rotating-credit/quote/")
    ? { data: mocks.quoteResponse, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }
    : { data: mocks.balanceResponse, isLoading: mocks.balanceLoading, isFetching: false, error: null, refetch: vi.fn() },
}));
vi.mock("@/hooks/use-payment-provider", () => ({ usePaymentProvider: () => ({ isLoading: mocks.providerLoading, isProviderConfigured: mocks.providerConfigured, supportsWallets: false, error: null }) }));
vi.mock("@/hooks/use-square-payment", () => ({ useSquarePayment: () => ({ card: null, isInitialized: mocks.squareInitialized, initializeCard: mocks.initializeCard, cleanupCard: mocks.cleanupCard, error: null }) }));
vi.mock("@/hooks/use-wallet-payments", () => ({ useWalletPayments: () => ({ applePayAvailable: false, googlePayAvailable: false, applePayTokenizeOnly: false, googlePayTokenizeOnly: false, applePayRef: { current: null }, googlePayRef: { current: null }, handleApplePayClick: vi.fn(), handleGooglePayClick: vi.fn(), isProcessing: false, cleanup: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/queryClient", () => ({ csrfFetch: mocks.csrfFetch, queryClient: { invalidateQueries: mocks.invalidateQueries } }));
vi.mock("@/lib/payment-request-identity", () => ({ beginPaymentIntent: mocks.beginPaymentIntent, clearPaymentIntent: mocks.clearPaymentIntent, getPaymentIntent: mocks.getPaymentIntent, paymentRequestHeaders: (key: string) => ({ "Idempotency-Key": key }) }));
vi.mock("@/lib/provider-not-configured", () => ({ makeApiError: (_body: unknown, _status: number, fallback: string) => new Error(fallback) }));
vi.mock("@/lib/square", () => ({ tokenizeCard: mocks.tokenizeCard }));

import { RotatingShareCreditCard } from "@/components/rotating-share-credit-card";

function balance(overrides: Partial<RotatingCreditBalanceWire> = {}): RotatingCreditBalanceWire {
  return {
    contractVersion: "rotating-credit-balance/1",
    organizationId: 1,
    leagueId: 17,
    bowlerId: 42,
    eligibleForCredit: true,
    shareAmountMinor: 2_000,
    currency: "USD",
    fundedMinor: 0,
    availableMinor: 0,
    appliedMinor: 0,
    refundedMinor: 0,
    refundHeldMinor: 0,
    reviewHeldMinor: 0,
    lots: [],
    applications: [],
    ...overrides,
  };
}

const quote: RotatingCreditQuoteWire = {
  contractVersion: "rotating-credit-quote/1",
  organizationId: 1,
  leagueId: 17,
  bowlerId: 42,
  currency: "USD",
  shareCount: 1,
  shareAmountMinor: 2_000,
  amountMinor: 2_000,
  currentAvailableMinor: 0,
  expectedAvailableAfterPurchaseMinor: 2_000,
  advisoryApplications: [],
  fingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
};

function renderCreditCard(email = "bowler@example.test", savedCards: SavedCard[] = []) {
  const testLeague: Pick<League, "id" | "locationId"> = { id: 17, locationId: 17 };
  return render(<RotatingShareCreditCard
    league={testLeague}
    bowlerId={42}
    bowlerEmail={email}
    savedCards={savedCards}
  />);
}

afterEach(() => {
  mocks.balanceResponse = null;
  mocks.quoteResponse = null;
  mocks.balanceLoading = false;
  mocks.providerLoading = false;
  mocks.providerConfigured = false;
  mocks.squareInitialized = false;
  mocks.storedPaymentIntent = null;
  mocks.invalidateQueries.mockClear();
  mocks.toast.mockClear();
  mocks.initializeCard.mockClear();
  mocks.cleanupCard.mockClear();
  mocks.getPaymentIntent.mockClear();
  mocks.clearPaymentIntent.mockClear();
  mocks.beginPaymentIntent.mockClear();
  mocks.csrfFetch.mockReset();
  mocks.tokenizeCard.mockReset();
});

describe("RotatingShareCreditCard", () => {
  it("shows the exact one-time share quote and labels date applications as advisory", () => {
    mocks.balanceResponse = { success: true, data: balance() };
    mocks.quoteResponse = { success: true, data: quote };
    renderCreditCard();

    expect(screen.getByText("Buy weekly shares")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("Possible date applications · preview only")).toBeInTheDocument();
    expect(screen.getByText(/No confirmed date currently needs this credit/)).toBeInTheDocument();
    expect(screen.getByText(/This is a one-time payment. The card is not saved and no autopay is created./)).toBeInTheDocument();
  });

  it("initializes the new-card form when credit balance arrives after provider configuration", async () => {
    mocks.balanceLoading = true;
    mocks.providerConfigured = true;
    mocks.quoteResponse = { success: true, data: quote };
    const view = renderCreditCard();

    expect(screen.getByText("Loading rotating share credit…")).toBeInTheDocument();
    expect(mocks.initializeCard).not.toHaveBeenCalled();

    mocks.balanceResponse = { success: true, data: balance() };
    mocks.balanceLoading = false;
    view.rerender(<RotatingShareCreditCard
      league={{ id: 17, locationId: 17 }}
      bowlerId={42}
      bowlerEmail="bowler@example.test"
      savedCards={[]}
    />);

    await waitFor(() => expect(mocks.initializeCard).toHaveBeenCalledTimes(1));
    expect(mocks.initializeCard).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    mocks.squareInitialized = true;
    view.rerender(<RotatingShareCreditCard
      league={{ id: 17, locationId: 17 }}
      bowlerId={42}
      bowlerEmail="bowler@example.test"
      savedCards={[]}
    />);
    expect(screen.getByRole("button", { name: /Buy 1 share/ })).toBeEnabled();
  });

  it("clears the purchase intent after a confirmed no-charge card decline", async () => {
    const user = userEvent.setup();
    mocks.balanceResponse = { success: true, data: balance() };
    mocks.quoteResponse = { success: true, data: quote };
    mocks.providerConfigured = true;
    mocks.squareInitialized = true;
    mocks.tokenizeCard.mockResolvedValue("card-token");
    const declinedOperation: RotatingCreditOperationWire = {
      contractVersion: "rotating-credit-operation/1",
      operationId: "operation-declined",
      fundingId: null,
      status: "action_required",
      paymentId: null,
      providerPaymentId: null,
      confirmedNoChargeDecline: true,
      fundedMinor: 0,
      applications: [],
      balance: null,
    };
    mocks.csrfFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: declinedOperation }), { status: 202 }));
    renderCreditCard("bowler@example.test", [{ id: "saved-card-1", last4: "4242", brand: "Visa", expMonth: 8, expYear: 2030 }]);

    await user.click(screen.getByRole("button", { name: /Buy 1 share/ }));

    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("rotating-credit:17:42", "request-key-000000000000"));
    expect(mocks.storedPaymentIntent).toBeNull();
    expect(screen.getAllByText(/The card was declined and no share purchase was completed/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Buy 1 share/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Buy one more weekly share" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Saved card" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Check purchase status" })).not.toBeInTheDocument();
  });

  it("clears a stored purchase intent when startup recovery confirms a no-charge decline", async () => {
    mocks.balanceResponse = { success: true, data: balance() };
    mocks.quoteResponse = { success: true, data: quote };
    mocks.providerConfigured = true;
    mocks.squareInitialized = true;
    mocks.storedPaymentIntent = "persisted-request-key";
    const declinedOperation: RotatingCreditOperationWire = {
      contractVersion: "rotating-credit-operation/1",
      operationId: "operation-recovered-decline",
      fundingId: null,
      status: "action_required",
      paymentId: null,
      providerPaymentId: null,
      confirmedNoChargeDecline: true,
      fundedMinor: 0,
      applications: [],
      balance: null,
    };
    mocks.csrfFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: declinedOperation }), { status: 202 }));
    renderCreditCard();

    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("rotating-credit:17:42", "persisted-request-key"));
    expect(mocks.storedPaymentIntent).toBeNull();
    expect(screen.getByRole("button", { name: /Buy 1 share/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Check purchase status" })).not.toBeInTheDocument();
  });

  it("keeps an ambiguous action-required intent held through startup recovery", async () => {
    mocks.balanceResponse = { success: true, data: balance() };
    mocks.quoteResponse = { success: true, data: quote };
    mocks.providerConfigured = true;
    mocks.squareInitialized = true;
    mocks.storedPaymentIntent = "ambiguous-request-key";
    const unresolvedOperation: RotatingCreditOperationWire = {
      contractVersion: "rotating-credit-operation/1",
      operationId: "operation-ambiguous",
      fundingId: null,
      status: "action_required",
      paymentId: null,
      providerPaymentId: null,
      confirmedNoChargeDecline: false,
      fundedMinor: 0,
      applications: [],
      balance: null,
    };
    mocks.csrfFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: unresolvedOperation }), { status: 202 }));
    renderCreditCard();

    await waitFor(() => expect(screen.getByText(/needs further payment review/)).toBeInTheDocument());
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.storedPaymentIntent).toBe("ambiguous-request-key");
    expect(screen.getByRole("button", { name: /Buy 1 share/ })).toBeDisabled();
  });

  it("keeps an ineligible member's existing balance and applied dates visible with purchases disabled", () => {
    mocks.balanceResponse = { success: true, data: balance({
      eligibleForCredit: false,
      shareAmountMinor: null,
      fundedMinor: 2_000,
      availableMinor: 1_000,
      appliedMinor: 1_000,
      lots: [{ fundingId: "funding-1", paymentId: 99, amountMinor: 2_000, availableMinor: 1_000, appliedMinor: 1_000, refundedMinor: 0, refundHeldMinor: 0, reviewHeldMinor: 0, paymentType: "cash", createdAt: "2038-01-01T00:00:00.000Z", receiptAvailable: false, receiptUrl: null, receiptNumber: null, receiptEmailMissing: false }],
      applications: [{ applicationId: "application-1", fundingId: "funding-1", paymentId: 99, allocationId: "allocation-1", obligationId: "obligation-1", assignmentId: "assignment-1", occurrenceId: "occurrence-1", occurrenceLocalDate: "2038-01-02", teamId: 9, slotIndex: 1, amountMinor: 1_000, appliedAt: "2038-01-02T00:00:00.000Z", status: "active", reversedAt: null, reversalReason: null }],
    }) };
    mocks.quoteResponse = null;
    renderCreditCard();

    expect(screen.getByText("New rotating share purchases are unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Credit balance").parentElement).toHaveTextContent("$10.00");
    expect(screen.getByText("Applied to dates").parentElement).toHaveTextContent("$10.00");
    expect(screen.getByText(/2038-01-02/)).toHaveTextContent("paid/credited");
    expect(screen.getByText(/Contact league staff for help with a refund or account change/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Buy 1 share/ })).not.toBeInTheDocument();
  });

  it("shows an explicit retryable error when the balance response reports failure", () => {
    mocks.balanceResponse = { success: false, error: { message: "Credit lookup failed." } };
    mocks.quoteResponse = null;
    renderCreditCard();

    expect(screen.getByRole("alert")).toHaveTextContent("Credit lookup failed.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
