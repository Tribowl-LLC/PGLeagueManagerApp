import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => {
  const standingAutopayCard = vi.fn((..._args: unknown[]) => null);
  const oneTimePaymentCard = vi.fn((..._args: unknown[]) => null);
  let paymentMode: "upfront" | "weekly" = "upfront";
  let paidInFull = false;
  let remainingMinor = 8_750;
  const csrfFetch = vi.fn();
  const tokenizeCard = vi.fn();
  const toast = vi.fn();
  const prepareRosterPaymentIntent = vi.fn(async (): Promise<{ requestKey: string; outcome: string; status?: string }> => ({ requestKey: "request-key", outcome: "none" }));
  const squareCard = { tokenize: vi.fn(), destroy: vi.fn(), attach: vi.fn() };
  const walletOptions: {
    enabled: boolean;
    onPaymentStarted?: () => void | boolean;
    onTokenReceived?: (token: string, walletType: "apple_pay" | "google_pay") => Promise<void>;
  } = { enabled: false };
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
      allocatedMinor: paidInFull ? 12_000 : 12_000 - remainingMinor,
      outstandingMinor: paidInFull ? 0 : remainingMinor,
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
            leagues: [{ id: 17, name: "League", paymentMode, locationId: "L17", organizationId: 1 }],
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
    setRemainingBalance: (value: number) => { remainingMinor = value; },
    csrfFetch,
    tokenizeCard,
    toast,
    prepareRosterPaymentIntent,
    squareCard,
    walletOptions,
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
vi.mock("@/hooks/use-square-payment", () => ({ useSquarePayment: () => ({ card: mocks.squareCard, isInitialized: true, initializeCard: vi.fn(), cleanupCard: vi.fn() }) }));
vi.mock("@/hooks/use-payment-provider", () => ({ usePaymentProvider: () => ({ supportsWallets: true }) }));
vi.mock("@/hooks/use-wallet-payments", () => ({ useWalletPayments: (options: {
  enabled: boolean;
  onPaymentStarted?: () => void | boolean;
  onTokenReceived: (token: string, walletType: "apple_pay" | "google_pay") => Promise<void>;
}) => {
  mocks.walletOptions.enabled = options.enabled;
  mocks.walletOptions.onPaymentStarted = options.onPaymentStarted;
  mocks.walletOptions.onTokenReceived = options.onTokenReceived;
  return {
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
  };
} }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/make-payment", vi.fn()], useSearch: () => "?leagueId=17", Link: () => null }));
vi.mock("@/lib/queryClient", () => ({ csrfFetch: mocks.csrfFetch, queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/lib/payment-history-financial-query", () => ({ paymentHistoryFinancialQueryKey: (leagueId: number, bowlerId: number) => ["financial", leagueId, bowlerId], invalidatePaymentHistoryFinancials: vi.fn() }));
vi.mock("@/lib/square", () => ({ tokenizeCard: mocks.tokenizeCard }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/provider-not-configured", () => ({ isProviderNotConfiguredError: () => false, providerNotConfiguredToast: () => ({}), makeApiError: () => new Error("payment failed") }));
vi.mock("@/lib/payment-request-identity", () => ({
  assertRosterPaymentSucceeded: vi.fn((status: unknown) => {
    if (status !== "succeeded") throw new Error("payment unresolved");
  }),
  beginPaymentIntent: vi.fn(() => "request-key"),
  clearPaymentIntent: vi.fn(),
  clearPaymentIntentForRequestKey: vi.fn(),
  interactivePaymentIntentScope: vi.fn(() => "stable-scope"),
  isTerminalRosterPaymentFailure: vi.fn((status: unknown) => status === "failed_terminal" || status === "canceled" || status === "action_required"),
  paymentRequestHeaders: vi.fn(() => ({})),
  paymentRequestWithRecovery: vi.fn((_key: string, request: () => Promise<Response>) => request()),
  prepareRosterPaymentIntent: mocks.prepareRosterPaymentIntent,
}));

import MakePaymentPage from "@/pages/make-payment-page";

afterEach(() => {
  mocks.query.mockClear();
  mocks.standingAutopayCard.mockClear();
  mocks.oneTimePaymentCard.mockClear();
  mocks.standingQueryCalls.length = 0;
  mocks.setPaymentMode("upfront");
  mocks.setPaidInFull(false);
  mocks.setRemainingBalance(8_750);
  mocks.csrfFetch.mockReset();
  mocks.tokenizeCard.mockReset();
  mocks.toast.mockReset();
  mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "request-key", outcome: "none" });
  mocks.walletOptions.enabled = false;
  mocks.walletOptions.onPaymentStarted = undefined;
  mocks.walletOptions.onTokenReceived = undefined;
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

  it("recovers a lost success on remount before a changed quote can charge again", async () => {
    const firstRender = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "stable-request", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "stable-request", outcome: "unresolved", status: "pending" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "first-quote", amountMinor: 8_750, payerBowlerId: 42 } }) })
      .mockRejectedValueOnce(new Error("response lost after provider success"));
    mocks.tokenizeCard.mockResolvedValue("source-token");

    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    act(() => { props.onSubmit(); });
    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(2));
    expect(mocks.tokenizeCard).toHaveBeenCalledOnce();
    act(() => { props.onSubmit(); });
    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledTimes(2));
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.tokenizeCard).toHaveBeenCalledOnce();

    firstRender.unmount();
    mocks.setRemainingBalance(5_750);
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "stable-request", outcome: "succeeded" });
    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledOnce());
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentAmountMinor: 5_750 });
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.tokenizeCard).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment already confirmed" }));
    expect(document.body).not.toHaveTextContent("Payment confirmation in progress");
  });

  it("replaces a terminal wallet identity before the next same-page click", async () => {
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "wallet-key", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "wallet-replacement", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "wallet-quote", payerBowlerId: 42 } }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ data: { status: "failed_terminal" } }) });

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));
    expect(mocks.walletOptions.onPaymentStarted?.()).toBe(true);
    await act(async () => {
      await mocks.walletOptions.onTokenReceived?.("wallet-source", "apple_pay");
    });

    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));
    expect(mocks.walletOptions.onPaymentStarted?.()).toBe(true);
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
  });
});
