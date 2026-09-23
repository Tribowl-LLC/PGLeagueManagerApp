import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { League } from "@shared/schema";
import type { RotatingCreditBalanceWire, RotatingCreditQuoteWire } from "@shared/rotating-credit-contract";

const mocks = vi.hoisted(() => {
  let balanceResponse: unknown = null;
  let quoteResponse: unknown = null;
  return {
    get balanceResponse() { return balanceResponse; },
    set balanceResponse(value: unknown) { balanceResponse = value; },
    get quoteResponse() { return quoteResponse; },
    set quoteResponse(value: unknown) { quoteResponse = value; },
    invalidateQueries: vi.fn(async () => {}),
    toast: vi.fn(),
    initializeCard: vi.fn(),
    cleanupCard: vi.fn(),
    getPaymentIntent: vi.fn(() => null),
    clearPaymentIntent: vi.fn(),
    beginPaymentIntent: vi.fn(() => "request-key-000000000000"),
    csrfFetch: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => String(queryKey[0]).includes("/rotating-credit/quote/")
    ? { data: mocks.quoteResponse, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }
    : { data: mocks.balanceResponse, isLoading: false, isFetching: false, error: null, refetch: vi.fn() },
}));
vi.mock("@/hooks/use-payment-provider", () => ({ usePaymentProvider: () => ({ isLoading: false, isProviderConfigured: false, supportsWallets: false, error: null }) }));
vi.mock("@/hooks/use-square-payment", () => ({ useSquarePayment: () => ({ card: null, isInitialized: false, initializeCard: mocks.initializeCard, cleanupCard: mocks.cleanupCard, error: null }) }));
vi.mock("@/hooks/use-wallet-payments", () => ({ useWalletPayments: () => ({ applePayAvailable: false, googlePayAvailable: false, applePayTokenizeOnly: false, googlePayTokenizeOnly: false, applePayRef: { current: null }, googlePayRef: { current: null }, handleApplePayClick: vi.fn(), handleGooglePayClick: vi.fn(), isProcessing: false, cleanup: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/queryClient", () => ({ csrfFetch: mocks.csrfFetch, queryClient: { invalidateQueries: mocks.invalidateQueries } }));
vi.mock("@/lib/payment-request-identity", () => ({ beginPaymentIntent: mocks.beginPaymentIntent, clearPaymentIntent: mocks.clearPaymentIntent, getPaymentIntent: mocks.getPaymentIntent, paymentRequestHeaders: (key: string) => ({ "Idempotency-Key": key }) }));
vi.mock("@/lib/provider-not-configured", () => ({ makeApiError: (_body: unknown, _status: number, fallback: string) => new Error(fallback) }));
vi.mock("@/lib/square", () => ({ tokenizeCard: vi.fn() }));

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

function renderCreditCard(email = "bowler@example.test") {
  const testLeague: Pick<League, "id" | "locationId"> = { id: 17, locationId: 17 };
  return render(<RotatingShareCreditCard
    league={testLeague}
    bowlerId={42}
    bowlerEmail={email}
    savedCards={[]}
  />);
}

afterEach(() => {
  mocks.balanceResponse = null;
  mocks.quoteResponse = null;
  mocks.invalidateQueries.mockClear();
  mocks.toast.mockClear();
  mocks.initializeCard.mockClear();
  mocks.cleanupCard.mockClear();
  mocks.getPaymentIntent.mockReset();
  mocks.getPaymentIntent.mockReturnValue(null);
  mocks.clearPaymentIntent.mockClear();
  mocks.beginPaymentIntent.mockClear();
  mocks.csrfFetch.mockReset();
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
