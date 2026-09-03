import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => {
  const standingAutopayCard = vi.fn((..._args: unknown[]) => null);
  const oneTimePaymentCard = vi.fn((..._args: unknown[]) => null);
  let paymentMode: "upfront" | "weekly" = "upfront";
  let paidInFull = false;
  const standingQueryCalls: unknown[][] = [];
  const financialData = () => ({
    contractVersion: "canonical-due-past-due/2",
    authoritativeSource: "payment_obligations",
    rows: [{
      id: "obligation-1",
      occurrenceId: "occurrence-1",
      payerBowlerId: 42,
      teamId: null,
      amountMinor: 12_000,
      allocatedMinor: paidInFull ? 12_000 : 3_250,
      outstandingMinor: paidInFull ? 0 : 8_750,
      dueAt: null,
      pastDueAt: null,
      classification: paidInFull ? "settled" : "due",
      state: paidInFull ? "settled" : "open",
      reviewRequired: false,
    }],
    totals: { collectiblePastDueMinor: 0 },
  });
  const query = vi.fn(({ queryKey }: { queryKey: unknown[] }) => {
    const key = String(queryKey[0]);
    if (key.startsWith("/api/financials/leagues/") && key.includes("/standing-autopay/")) {
      standingQueryCalls.push(queryKey);
    }
    if (key === "/api/user") {
      return { data: { success: true, data: { id: 1, bowlerId: 42 } }, isLoading: false, error: null };
    }
    if (key.startsWith("/api/bowlers/") && key.endsWith("/details")) {
      return {
        data: {
          success: true,
          data: {
            bowler: { id: 42, name: "Bowler", email: "bowler@example.test" },
            bowlerLeagues: [{ leagueId: 17 }],
            leagues: [{ id: 17, name: "League", paymentMode, locationId: null, organizationId: 1 }],
          },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (key.includes("canonical-due-past-due")) {
      return {
        data: { success: true, data: financialData() },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (key.startsWith("/api/payments-provider/cards/")) {
      return { data: { success: true, data: [] }, isLoading: false, error: null, refetch: vi.fn() };
    }
    if (key === "financial") {
      return {
        data: { success: true, data: financialData() },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    throw new Error(`Unexpected query: ${key}`);
  });
  return {
    standingAutopayCard,
    oneTimePaymentCard,
    query,
    standingQueryCalls,
    setPaymentMode: (mode: "upfront" | "weekly") => { paymentMode = mode; },
    setPaidInFull: (value: boolean) => { paidInFull = value; },
  };
});

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
vi.mock("@/components/bowler-layout", () => ({ BowlerLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/league-switcher-sheet", () => ({ LeagueSwitcherSheet: () => null }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/page-states", () => ({ PageErrorState: () => null, PageLoadingState: () => null }));
vi.mock("@/components/bowler-one-time-payment-card", () => ({ BowlerOneTimePaymentCard: mocks.oneTimePaymentCard }));
vi.mock("@/components/standing-autopay-card", () => ({ StandingAutopayCard: mocks.standingAutopayCard }));
vi.mock("@/hooks/use-selected-league", () => ({ useSelectedLeague: () => [17, vi.fn()] }));
vi.mock("@/hooks/use-saved-card-default", () => ({ useSavedCardDefault: vi.fn() }));
vi.mock("@/hooks/use-square-payment", () => ({ useSquarePayment: () => ({ card: null, isInitialized: false, initializeCard: vi.fn(), cleanupCard: vi.fn() }) }));
vi.mock("@/hooks/use-payment-provider", () => ({ usePaymentProvider: () => ({ supportsWallets: false }) }));
vi.mock("@/hooks/use-wallet-payments", () => ({ useWalletPayments: () => ({
  applePayAvailable: false,
  googlePayAvailable: false,
  applePayTokenizeOnly: false,
  googlePayTokenizeOnly: false,
  applePayRef: { current: null },
  googlePayRef: { current: null },
  handleApplePayClick: vi.fn(),
  handleGooglePayClick: vi.fn(),
  isProcessing: false,
  cleanup: vi.fn(),
}) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/make-payment", vi.fn()], useSearch: () => "?leagueId=17", Link: () => null }));
vi.mock("@/lib/queryClient", () => ({ csrfFetch: vi.fn(), queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/lib/payment-history-financial-query", () => ({ paymentHistoryFinancialQueryKey: (leagueId: number, bowlerId: number) => ["financial", leagueId, bowlerId], invalidatePaymentHistoryFinancials: vi.fn() }));
vi.mock("@/lib/square", () => ({ tokenizeCard: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/provider-not-configured", () => ({ isProviderNotConfiguredError: () => false, providerNotConfiguredToast: () => ({}), makeApiError: () => new Error("payment failed") }));
vi.mock("@/lib/payment-request-identity", () => ({
  assertRosterPaymentSucceeded: vi.fn(),
  beginPaymentIntent: vi.fn(() => "request-key"),
  clearPaymentIntent: vi.fn(),
  isTerminalRosterPaymentFailure: vi.fn(() => false),
  paymentRequestHeaders: vi.fn(() => ({})),
  paymentRequestWithRecovery: vi.fn(),
}));

import MakePaymentPage from "@/pages/make-payment-page";

afterEach(() => {
  mocks.query.mockClear();
  mocks.standingAutopayCard.mockClear();
  mocks.oneTimePaymentCard.mockClear();
  mocks.standingQueryCalls.length = 0;
  mocks.setPaymentMode("upfront");
  mocks.setPaidInFull(false);
});

describe("MakePaymentPage upfront payment mode", () => {
  it("does not mount StandingAutopayCard or issue standing-autopay queries", async () => {
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    expect(mocks.standingAutopayCard).not.toHaveBeenCalled();
    expect(mocks.standingQueryCalls).toHaveLength(0);
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      fullBalanceOnly: true,
      remainingBalance: 8_750,
      paymentAmountMinor: 8_750,
    });
  });

  it("keeps the paid-in-full state free of one-time and automatic-payment cards", async () => {
    mocks.setPaidInFull(true);
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(document.body).toHaveTextContent("Season Paid in Full");
    expect(mocks.oneTimePaymentCard).not.toHaveBeenCalled();
    expect(mocks.standingAutopayCard).not.toHaveBeenCalled();
    expect(mocks.standingQueryCalls).toHaveLength(0);
  });

  it("mounts StandingAutopayCard for weekly leagues", async () => {
    mocks.setPaymentMode("weekly");
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    expect(mocks.standingAutopayCard.mock.calls.at(-1)?.[0]).toMatchObject({
      league: expect.objectContaining({ paymentMode: "weekly" }),
    });
  });
});
