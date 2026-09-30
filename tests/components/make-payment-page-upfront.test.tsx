import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => {
  const leagueBottomSheet = vi.fn((_props: { viewerRole?: string }) => null);
  const standingAutopayCard = vi.fn((..._args: unknown[]) => null);
  const oneTimePaymentCard = vi.fn((..._args: unknown[]) => null);
  const rotatingShareCreditCard = vi.fn((..._args: unknown[]) => null);
  let paymentMode: "upfront" | "weekly" = "upfront";
  let paidInFull = false;
  let zeroParticipants = false;
  let includePartner = false;
  let remainingMinor = 8_750;
  let dueNowMinor = 1_000;
  let pastDueMinor = 0;
  let participantRefreshUsesCurrentData = false;
  let detailsLeagueReady = true;
  let selectedLeagueId: number | null = 17;
  const csrfFetch = vi.fn();
  const apiRequest = vi.fn();
  const tokenizeCard = vi.fn();
  const paymentRequestWithRecovery = vi.fn((_key: string, request: () => Promise<Response>) => request());
  const toast = vi.fn();
  const clearPaymentIntent = vi.fn();
  const invalidatePaymentHistoryFinancials = vi.fn(async () => {});
  const prepareRosterPaymentIntent = vi.fn(async (): Promise<{ requestKey: string; outcome: string; status?: string; response?: { clone: () => { json: () => Promise<unknown> } } }> => ({ requestKey: "request-key", outcome: "none" }));
  const squareCard = { tokenize: vi.fn(), destroy: vi.fn(), attach: vi.fn() };
  const cleanupCard = vi.fn();
  const walletOptions: {
    enabled: boolean;
    onPaymentStarted?: () => void | boolean;
    onTokenReceived?: (token: string, walletType: "apple_pay" | "google_pay") => Promise<void>;
  } = { enabled: false };
  let quoteFetching = false;
  let quoteError: { code: string; message: string; status: number } | null = null;
  let participantRefreshGate: Promise<void> | null = null;
  let participantRefreshMissing = false;
  const standingQueryCalls: unknown[][] = [];
  let rotatingPoolMember = false;
  let standingAutopayState: "pending" | "active" | "revoked" | "expired" | "none" = "none";
  const standingStatusRefetch = vi.fn(async () => ({ data: { data: { state: standingAutopayState } }, error: null, isError: false }));
  const financialData = () => ({
    contractVersion: "canonical-due-past-due/2",
    authoritativeSource: "payment_obligations",
    rows: paymentMode === "weekly" ? [1, 2, 3].map((week) => ({
      id: `obligation-${week}`,
      occurrenceId: `occurrence-${week}`,
      payerBowlerId: 42,
      teamId: null,
      amountMinor: 1_000,
      allocatedMinor: paidInFull ? 1_000 : 0,
      outstandingMinor: paidInFull ? 0 : 1_000,
      dueAt: null,
      pastDueAt: null,
      classification: paidInFull ? "settled" : "due",
      state: paidInFull ? "settled" : "open",
      reviewRequired: false,
    })) : [{
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
  const participantsData = () => ({
    contractVersion: "interactive-payment-participants/3",
    organizationId: 1,
    leagueId: 17,
    paymentMode,
    participants: zeroParticipants ? [] : [{
      bowlerId: 42,
      name: "Bowler",
      role: "self" as const,
      remainingMinor: paidInFull ? 0 : remainingMinor,
      pastDueMinor,
      weeklyOptions: paymentMode === "upfront"
        ? (paidInFull ? [] : [{ weeks: 1, amountMinor: remainingMinor }])
        : [1, 2, 3].map((weeks) => ({ weeks, amountMinor: weeks * 1_000 })),
      eligible: !paidInFull,
      reason: paidInFull ? "No remaining balance" : null,
      ...(paymentMode === "weekly" ? { dueNowMinor, catchUpWeeks: 1, catchUpAmountMinor: dueNowMinor } : {}),
    }, ...(includePartner ? [{
      bowlerId: 84,
      name: "Partner",
      role: "partner" as const,
      remainingMinor: 6_000,
      pastDueMinor: 0,
      weeklyOptions: [{ weeks: 1, amountMinor: 6_000 }],
      eligible: true,
      reason: null,
    }] : [])],
  });
  const query = vi.fn(({ queryKey, enabled = true }: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = String(queryKey[0]);
    if (enabled && key.startsWith("/api/financials/leagues/") && key.includes("/standing-autopay/")) {
      standingQueryCalls.push(queryKey);
    }
    if (key.startsWith("/api/financials/leagues/") && key.includes("/rotating-credit/1")) {
      return {
        data: { success: true, data: { eligibleForCredit: rotatingPoolMember, shareAmountMinor: rotatingPoolMember ? 1_000 : null } },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (key.startsWith("/api/financials/leagues/") && key.endsWith("/standing-autopay/1")) {
      return {
        data: { success: true, data: { contractVersion: "standing-autopay-consent/1", organizationId: 1, leagueId: 17, payerBowlerId: 42, consentId: standingAutopayState === "active" ? "consent-1" : null, consentVersion: standingAutopayState === "active" ? 1 : null, state: standingAutopayState, paymentMode: "weekly", partnerBowlerIds: [], paymentAttention: null } },
        isLoading: false,
        error: null,
        refetch: standingStatusRefetch,
      };
    }
    if (key === "/api/user") {
      return { data: { success: true, data: { id: 1, bowlerId: 42, role: "user" } }, isLoading: false, error: null };
    }
    if (key.startsWith("/api/bowlers/") && key.endsWith("/details")) {
      return {
        data: {
          success: true,
          data: {
            bowler: { id: 42, name: "Bowler", email: "bowler@example.test" },
            bowlerLeagues: detailsLeagueReady ? [{ leagueId: 17 }] : [],
            leagues: detailsLeagueReady ? [{ id: 17, name: "League", paymentMode, locationId: "L17", organizationId: 1 }] : [],
          },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (key === "/api/financials/leagues" && queryKey[2] === "interactive-payment-participants/3") {
      const participantResponse = { success: true, data: participantsData() };
      return {
        data: participantResponse,
        isLoading: false,
        error: null,
        // Deliberately return the same object reference to model TanStack
        // Query structural sharing after an authoritative unchanged read.
        refetch: vi.fn(async () => {
          if (participantRefreshGate) await participantRefreshGate;
          if (participantRefreshMissing) return { data: undefined, isLoading: false, isFetching: false, error: null, isError: false };
          return { data: participantRefreshUsesCurrentData ? { success: true, data: participantsData() } : participantResponse, isLoading: false, isFetching: false, error: null, isError: false };
        }),
      };
    }
    if (key === "/api/financials/leagues" && queryKey[2] === "interactive-payment-quote/3") {
      if (quoteError) return { data: undefined, isLoading: false, isFetching: false, error: quoteError, refetch: vi.fn() };
      const recipientRows = queryKey[4] as Array<{ bowlerId: number; weeks: number }> | undefined;
      const weeks = recipientRows?.[0]?.weeks ?? 1;
      const amountMinor = paymentMode === "upfront" ? remainingMinor : weeks * 1_000;
      const quote = {
        contractVersion: "interactive-payment-quote/3" as const,
        organizationId: 1,
        leagueId: 17,
        payerBowlerId: 42,
        currency: "USD" as const,
        amountMinor,
        fingerprint: `quote-${amountMinor}`,
        recipients: [{
          bowlerId: 42,
          name: "Bowler",
          role: "self" as const,
          weeks,
          fullBalance: paymentMode === "upfront",
          subtotalMinor: amountMinor,
          allocations: [{ obligationId: "obligation-1", amountMinor, occurrenceId: "occurrence-1", occurrenceLocalDate: "2026-09-01", plannedOrdinal: 1, label: "Week 1", isPairedFinalWeek: false }],
          coveredWeeks: ["Week 1"],
        }],
      };
      return { data: { success: true, data: quote }, isLoading: false, isFetching: quoteFetching, error: null, refetch: vi.fn(async () => ({ data: { success: true, data: quote }, error: null })) };
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
    leagueBottomSheet,
    standingAutopayCard,
    oneTimePaymentCard,
    rotatingShareCreditCard,
    apiRequest,
    query,
    standingQueryCalls,
    standingStatusRefetch,
    setPaymentMode: (mode: "upfront" | "weekly") => { paymentMode = mode; },
    setRotatingPoolMember: (value: boolean) => { rotatingPoolMember = value; },
    setStandingAutopayState: (state: "pending" | "active" | "revoked" | "expired" | "none") => { standingAutopayState = state; },
    setPaidInFull: (value: boolean) => { paidInFull = value; },
    setZeroParticipants: (value: boolean) => { zeroParticipants = value; },
    setIncludePartner: (value: boolean) => { includePartner = value; },
    setRemainingBalance: (value: number) => { remainingMinor = value; },
    setDueNowMinor: (value: number) => { dueNowMinor = value; },
    setPastDueMinor: (value: number) => { pastDueMinor = value; },
    setParticipantRefreshUsesCurrentData: (value: boolean) => { participantRefreshUsesCurrentData = value; },
    setDetailsLeagueReady: (value: boolean) => { detailsLeagueReady = value; },
    setSelectedLeagueId: (value: number | null) => { selectedLeagueId = value; },
    getSelectedLeagueId: () => selectedLeagueId,
    setQuoteFetching: (value: boolean) => { quoteFetching = value; },
    setQuoteError: (value: { code: string; message: string; status: number } | null) => { quoteError = value; },
    setParticipantRefreshGate: (value: Promise<void> | null) => { participantRefreshGate = value; },
    setParticipantRefreshMissing: (value: boolean) => { participantRefreshMissing = value; },
    csrfFetch,
    paymentRequestWithRecovery,
    tokenizeCard,
    toast,
    clearPaymentIntent,
    invalidatePaymentHistoryFinancials,
    prepareRosterPaymentIntent,
    squareCard,
    cleanupCard,
    walletOptions,
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tanstack/react-query")>()), useQuery: mocks.query, useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) }));
vi.mock("@/components/bowler-layout", () => ({ BowlerLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/league-bottom-sheet", () => ({ LeagueBottomSheet: mocks.leagueBottomSheet }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/page-states", () => ({ PageErrorState: () => null, PageLoadingState: () => null }));
vi.mock("@/components/bowler-one-time-payment-card", () => ({ BowlerOneTimePaymentCard: mocks.oneTimePaymentCard }));
vi.mock("@/components/standing-autopay-card", () => ({ StandingAutopayCard: mocks.standingAutopayCard }));
vi.mock("@/components/rotating-share-credit-card", () => ({ RotatingShareCreditCard: mocks.rotatingShareCreditCard }));
vi.mock("@/hooks/use-selected-league", () => ({ useSelectedLeague: () => [mocks.getSelectedLeagueId(), vi.fn()] }));
vi.mock("@/hooks/use-saved-card-default", () => ({ useSavedCardDefault: vi.fn() }));
vi.mock("@/hooks/use-square-payment", () => ({ useSquarePayment: () => ({ card: mocks.squareCard, isInitialized: true, initializeCard: vi.fn(), cleanupCard: mocks.cleanupCard }) }));
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
vi.mock("@/lib/queryClient", () => ({ apiRequest: mocks.apiRequest, csrfFetch: mocks.csrfFetch, queryClient: { invalidateQueries: vi.fn(), cancelQueries: vi.fn(async () => {}), removeQueries: vi.fn() } }));
vi.mock("@/lib/payment-history-financial-query", () => ({ paymentHistoryFinancialQueryKey: (leagueId: number, bowlerId: number) => ["financial", leagueId, bowlerId], invalidatePaymentHistoryFinancials: mocks.invalidatePaymentHistoryFinancials }));
vi.mock("@/lib/square", () => ({ tokenizeCard: mocks.tokenizeCard }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/provider-not-configured", () => ({
  isProviderNotConfiguredError: () => false,
  providerNotConfiguredToast: () => ({}),
  makeApiError: (body: { error?: { message?: string; code?: string } }, status: number, fallback: string) => Object.assign(new Error(body?.error?.message || fallback), { status, code: body?.error?.code }),
}));
vi.mock("@/lib/payment-request-identity", () => ({
  assertRosterPaymentSucceeded: vi.fn((status: unknown) => {
    if (status !== "succeeded") throw new Error("payment unresolved");
  }),
  beginPaymentIntent: vi.fn(() => "request-key"),
  clearPaymentIntent: mocks.clearPaymentIntent,
  clearPaymentIntentForRequestKey: vi.fn(),
  interactivePaymentIntentScope: vi.fn(() => "stable-scope"),
  isTerminalRosterPaymentFailure: vi.fn((status: unknown) => status === "failed_terminal" || status === "canceled" || status === "action_required"),
  paymentRequestHeaders: vi.fn((requestKey: string) => ({ "Idempotency-Key": requestKey })),
  paymentRequestWithRecovery: mocks.paymentRequestWithRecovery,
  prepareRosterPaymentIntent: mocks.prepareRosterPaymentIntent,
  rosterPaymentStatusMessage: vi.fn((status: unknown) => status === "pending" ? "Your payment is still being confirmed. Use payment recovery before trying another card." : null),
}));

import MakePaymentPage from "@/pages/make-payment-page";

afterEach(() => {
  mocks.leagueBottomSheet.mockClear();
  mocks.query.mockClear();
  mocks.apiRequest.mockReset();
  mocks.standingAutopayCard.mockClear();
  mocks.oneTimePaymentCard.mockClear();
  mocks.rotatingShareCreditCard.mockClear();
  mocks.standingQueryCalls.length = 0;
  mocks.standingStatusRefetch.mockReset().mockImplementation(async () => ({ data: { data: { state: "none" } }, error: null, isError: false }));
  mocks.setPaymentMode("upfront");
  mocks.setRotatingPoolMember(false);
  mocks.setStandingAutopayState("none");
  mocks.setPaidInFull(false);
  mocks.setZeroParticipants(false);
  mocks.setIncludePartner(false);
  mocks.setRemainingBalance(8_750);
  mocks.setDueNowMinor(1_000);
  mocks.setPastDueMinor(0);
  mocks.setParticipantRefreshUsesCurrentData(false);
  mocks.setDetailsLeagueReady(true);
  mocks.setSelectedLeagueId(17);
  mocks.setQuoteFetching(false);
  mocks.setQuoteError(null);
  mocks.setParticipantRefreshGate(null);
  mocks.setParticipantRefreshMissing(false);
  mocks.csrfFetch.mockReset();
  mocks.paymentRequestWithRecovery.mockReset().mockImplementation((_key: string, request: () => Promise<Response>) => request());
  mocks.tokenizeCard.mockReset();
  mocks.cleanupCard.mockReset();
  mocks.toast.mockReset();
  mocks.clearPaymentIntent.mockReset();
  mocks.invalidatePaymentHistoryFinancials.mockReset().mockResolvedValue(undefined);
  mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "request-key", outcome: "none" });
  window.localStorage.removeItem("leaguevault:standing-consent-intent:v1:stable-scope");
  mocks.walletOptions.enabled = false;
  mocks.walletOptions.onPaymentStarted = undefined;
  mocks.walletOptions.onTokenReceived = undefined;
});

describe("MakePaymentPage upfront payment mode", () => {
  it("uses the Overview league sheet and forwards the current user role", async () => {
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.leagueBottomSheet).toHaveBeenCalled());
    expect(mocks.leagueBottomSheet.mock.calls.at(-1)?.[0]).toMatchObject({
      open: false,
      viewerRole: "user",
    });
  });

  it("does not call an on-time current payment past due", async () => {
    mocks.setPaymentMode("weekly");
    mocks.setDueNowMinor(1_000);
    render(<MakePaymentPage />);

    expect(await screen.findByText("Current payment due")).toBeInTheDocument();
    expect(screen.queryByText("Past-due balance")).not.toBeInTheDocument();
  });

  it("calls out past-due evidence only when the participant reports it", async () => {
    mocks.setPaymentMode("weekly");
    mocks.setPastDueMinor(500);
    render(<MakePaymentPage />);

    expect(await screen.findByText("Includes past-due balance")).toBeInTheDocument();
  });

  it("passes a payable solo self participant as selected by default", async () => {
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      recipientRows: [expect.objectContaining({ bowlerId: 42, role: "self", selected: true })],
    });
  });

  it("replaces standing autopay setup with a revoke path for a rotating member who has legacy consent", async () => {
    mocks.setPaymentMode("weekly");
    mocks.setRotatingPoolMember(true);
    mocks.setStandingAutopayState("active");
    render(<MakePaymentPage />);

    expect(await screen.findByText("Existing automatic payment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke existing automatic payments" })).toBeInTheDocument();
    expect(screen.getByText(/Rotating members buy shares manually/)).toBeInTheDocument();
    expect(mocks.oneTimePaymentCard).not.toHaveBeenCalled();
    expect(mocks.standingAutopayCard).not.toHaveBeenCalled();
  });

  it("keeps the solo self selected after a selected partner is removed, while stale guard blocks charging", async () => {
    mocks.setIncludePartner(true);
    const view = render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    let props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as {
      recipientRows: Array<{ bowlerId: number; selected: boolean }>;
      onRecipientToggle: (bowlerId: number, selected: boolean) => void;
      onResetRecipientSelection: () => void;
    };
    expect(props.recipientRows).toEqual([
      expect.objectContaining({ bowlerId: 42, selected: true }),
      expect.objectContaining({ bowlerId: 84, selected: false }),
    ]);

    act(() => {
      props.onRecipientToggle(42, false);
      props.onRecipientToggle(84, true);
    });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      recipientRows: [
        expect.objectContaining({ bowlerId: 42, selected: false }),
        expect.objectContaining({ bowlerId: 84, selected: true }),
      ],
    }));

    mocks.setIncludePartner(false);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ selectionStale: true }));
    props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as typeof props;
    expect(props.recipientRows).toEqual([expect.objectContaining({ bowlerId: 42, selected: true })]);

    act(() => { props.onResetRecipientSelection(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ selectionStale: false }));
    expect((mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as typeof props).recipientRows).toEqual([
      expect.objectContaining({ bowlerId: 42, selected: true }),
    ]);
    view.unmount();
  });

  it("keeps the reselected solo self basket guarded when both recipients were unchecked", async () => {
    mocks.setIncludePartner(true);
    const view = render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    let props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as {
      recipientRows: Array<{ bowlerId: number; selected: boolean }>;
      onRecipientToggle: (bowlerId: number, selected: boolean) => void;
    };
    act(() => { props.onRecipientToggle(42, false); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      recipientRows: [
        expect.objectContaining({ bowlerId: 42, selected: false }),
        expect.objectContaining({ bowlerId: 84, selected: false }),
      ],
    }));

    mocks.setIncludePartner(false);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      selectionStale: false,
      recipientRows: [expect.objectContaining({ bowlerId: 42, selected: true })],
    }));

    mocks.setRemainingBalance(5_750);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ selectionStale: true }));
    expect((mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as typeof props).recipientRows).toEqual([
      expect.objectContaining({ bowlerId: 42, selected: true, remainingMinor: 5_750 }),
    ]);
    view.unmount();
  });

  it("does not mount StandingAutopayCard or issue standing-autopay queries", async () => {
    const view = render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    expect(mocks.standingAutopayCard).not.toHaveBeenCalled();
    expect(mocks.standingQueryCalls).toHaveLength(0);
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      fullBalanceOnly: true,
      paymentAmountMinor: 8_750,
    });
  });

  it("shows a neutral no-balance state for a self participant with no obligations", async () => {
    mocks.setPaidInFull(true);
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(document.body).toHaveTextContent("No one-time balance available");
    expect(document.body).toHaveTextContent("There is no remaining one-time balance.");
    expect(document.body).not.toHaveTextContent("Season Paid in Full");
    expect(mocks.oneTimePaymentCard).not.toHaveBeenCalled();
    expect(mocks.standingAutopayCard).not.toHaveBeenCalled();
    expect(mocks.standingQueryCalls).toHaveLength(0);
  });

  it("does not claim season paid in full when the participant projection is empty", async () => {
    mocks.setZeroParticipants(true);
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    expect(document.body).not.toHaveTextContent("Season Paid in Full");
  });

  it("mounts StandingAutopayCard for weekly leagues", async () => {
    mocks.setPaymentMode("weekly");
    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    expect(mocks.rotatingShareCreditCard).toHaveBeenCalled();
    expect(mocks.standingAutopayCard.mock.calls.at(-1)?.[0]).toMatchObject({
      league: expect.objectContaining({ paymentMode: "weekly" }),
    });
  });

  it("retains a restored consent marker while the initial league resolves", async () => {
    mocks.setPaymentMode("weekly");
    mocks.setDetailsLeagueReady(false);
    mocks.setSelectedLeagueId(null);
    window.localStorage.setItem("leaguevault:standing-consent-intent:v1:stable-scope", JSON.stringify({
      scope: "stable-scope",
      requestKey: "reload-consent",
      operationId: "operation-reload",
      commandKey: "standing-consent-reload",
      phase: "consent",
    }));
    const view = render(<MakePaymentPage />);
    expect(screen.queryByRole("button", { name: "Retry automatic payments" })).not.toBeInTheDocument();

    mocks.setDetailsLeagueReady(true);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry automatic payments" })).toBeInTheDocument());
    expect(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope")).not.toBeNull();
  });

  it("returns to the refreshed due-now checkout after an authoritative FIFO consent rejection", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "fifo-initial", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded", operationId: "operation-fifo-initial" } }) });
    mocks.apiRequest.mockImplementationOnce(async () => {
      mocks.setDueNowMinor(2_000);
      mocks.setParticipantRefreshUsesCurrentData(true);
      throw Object.assign(new Error("new due amount"), { status: 409, code: "ARREARS_REQUIRE_ONE_TIME_FIFO" });
    });
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    act(() => { (mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void }).onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    await act(async () => { await (mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void }).onSubmit(); });

    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard.mock.calls.at(-1)?.[0]).toMatchObject({ combinedCheckoutActive: false, dueNowMinor: 2_000 }));
    expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "fifo-initial");
    expect(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope")).toBeNull();
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.paymentRequestWithRecovery).toHaveBeenCalledOnce();
  });

  it("refreshes before clearing recovery when a consent retry hits FIFO arrears", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "fifo-retry", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded", operationId: "operation-fifo-retry" } }) });
    mocks.apiRequest
      .mockRejectedValueOnce(Object.assign(new Error("consent unavailable"), { status: 503 }))
      .mockImplementationOnce(async () => {
        mocks.setDueNowMinor(2_000);
        mocks.setParticipantRefreshUsesCurrentData(true);
        throw Object.assign(new Error("new due amount"), { status: 409, code: "ARREARS_REQUIRE_ONE_TIME_FIFO" });
      });
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    act(() => { (mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void }).onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    await act(async () => { await (mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void }).onSubmit(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry automatic payments" })).toBeInTheDocument());

    await act(async () => { screen.getByRole("button", { name: "Retry automatic payments" }).click(); });
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard.mock.calls.at(-1)?.[0]).toMatchObject({ combinedCheckoutActive: false, dueNowMinor: 2_000 }));
    expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "fifo-retry");
    expect(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope")).toBeNull();
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.paymentRequestWithRecovery).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry automatic payments" })).not.toBeInTheDocument();
  });

  it("keeps FIFO consent recovery blocked when the balance refresh fails", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "fifo-refresh-failure", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded", operationId: "operation-fifo-refresh-failure" } }) });
    mocks.apiRequest
      .mockRejectedValueOnce(Object.assign(new Error("consent unavailable"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("new due amount"), { status: 409, code: "ARREARS_REQUIRE_ONE_TIME_FIFO" }));
    mocks.invalidatePaymentHistoryFinancials.mockRejectedValue(new Error("balance refresh unavailable"));
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    act(() => { (mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void }).onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    await act(async () => { await (mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void }).onSubmit(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry automatic payments" })).toBeInTheDocument());

    await act(async () => { screen.getByRole("button", { name: "Retry automatic payments" }).click(); });
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope")).not.toBeNull();
    expect(document.body).toHaveTextContent("the updated amount needed before automatic-payment setup could not be refreshed");
    expect(document.body).toHaveTextContent("Retry automatic payments");
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a same-page combined payment recovery action for an unresolved charge", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "combined-request", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ data: { status: "pending" } }) });
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    const standingProps = mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void };
    act(() => { standingProps.onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    const checkoutProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };

    await act(async () => { await checkoutProps.onSubmit(); });

    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.apiRequest).not.toHaveBeenCalled();
    expect(document.body).toHaveTextContent("still being confirmed");
    expect(document.body).toHaveTextContent("Retry automatic payments");
  });

  it("keeps transport recovery visible and promotes a recovered success without charging again", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "combined-transport", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockRejectedValueOnce(new Error("charge transport"));
    mocks.paymentRequestWithRecovery.mockImplementationOnce(async (_key: string, request: () => Promise<Response>) => {
      await request().catch(() => undefined);
      throw new Error("recovery transport");
    });
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    const standingProps = mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void };
    act(() => { standingProps.onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    const checkoutProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };

    await act(async () => { await checkoutProps.onSubmit(); });
    expect(document.body).toHaveTextContent("Payment confirmation is in progress");
    expect(document.body).toHaveTextContent("Retry automatic payments");
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();

    mocks.prepareRosterPaymentIntent.mockResolvedValue({
      requestKey: "combined-transport",
      outcome: "succeeded",
      response: { clone: () => ({ json: async () => ({ data: { operationId: "operation-recovered" } }) }) },
    });
    await act(async () => { await checkoutProps.onSubmit(); });

    expect(mocks.paymentRequestWithRecovery).toHaveBeenCalledOnce();
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope") ?? "{}")).toMatchObject({ phase: "consent", operationId: "operation-recovered" });
  });

  it("clears a charging marker after reload when the exact request key has no server operation", async () => {
    mocks.setPaymentMode("weekly");
    window.localStorage.setItem("leaguevault:standing-consent-intent:v1:stable-scope", JSON.stringify({
      scope: "stable-scope",
      requestKey: "stale-charge",
      operationId: null,
      commandKey: "standing-consent-stale",
      phase: "charging",
    }));
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "stale-charge", outcome: "new" });

    render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment setup can restart" })));
    expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "stale-charge");
    expect(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope")).toBeNull();
    expect(document.body).not.toHaveTextContent("Retry automatic payments");
  });

  it("promotes a succeeded charging marker after reload without submitting another charge", async () => {
    mocks.setPaymentMode("weekly");
    window.localStorage.setItem("leaguevault:standing-consent-intent:v1:stable-scope", JSON.stringify({
      scope: "stable-scope",
      requestKey: "recovered-charge",
      operationId: null,
      commandKey: "standing-consent-recovered",
      phase: "charging",
    }));
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({
      requestKey: "recovered-charge",
      outcome: "succeeded",
      response: { clone: () => ({ json: async () => ({ data: { operationId: "operation-recovered" } }) }) },
    });

    render(<MakePaymentPage />);

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope") ?? "{}")).toMatchObject({ phase: "consent", operationId: "operation-recovered" }));
    expect(mocks.paymentRequestWithRecovery).not.toHaveBeenCalled();
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(document.body).toHaveTextContent("Retry automatic payments");
  });

  it("clears the combined marker and returns to checkout after a terminal charge outcome", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "combined-terminal", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ data: { status: "failed_terminal" } }) });
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    const standingProps = mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void };
    act(() => { standingProps.onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    const checkoutProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };

    await act(async () => { await checkoutProps.onSubmit(); });

    expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "combined-terminal");
    expect(document.body).not.toHaveTextContent("Payment confirmation is in progress");
    expect(document.body).not.toHaveTextContent("Retry automatic payments");
  });

  it("keeps consent retry visible when the successful payment removes the remaining balance", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "combined-consent", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded", operationId: "operation-1" } }) });
    mocks.apiRequest.mockRejectedValueOnce(Object.assign(new Error("consent unavailable"), { status: 503 }));
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    const standingProps = mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void };
    act(() => { standingProps.onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    const checkoutProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };

    await act(async () => { await checkoutProps.onSubmit(); });
    await waitFor(() => expect(document.body).toHaveTextContent("Retry automatic payments"));
    expect(document.body).toHaveTextContent("Payment complete; automatic-payment setup needs confirmation. Check status and retry.");

    mocks.setPaidInFull(true);
    view.rerender(<MakePaymentPage />);
    expect(document.body).toHaveTextContent("Retry automatic payments");
    expect(document.body).not.toHaveTextContent("No one-time balance available");

    const oneTimeCallCountBeforeRetry = mocks.oneTimePaymentCard.mock.calls.length;
    mocks.setStandingAutopayState("active");
    mocks.standingStatusRefetch.mockResolvedValue({ data: { data: { state: "active" } }, error: null, isError: false });
    view.rerender(<MakePaymentPage />);
    await act(async () => { screen.getByRole("button", { name: "Retry automatic payments" }).click(); });
    await waitFor(() => expect(document.body).toHaveTextContent("No one-time balance available"));
    expect(mocks.oneTimePaymentCard).toHaveBeenCalledTimes(oneTimeCallCountBeforeRetry);
    expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "combined-consent");
    expect(mocks.paymentRequestWithRecovery).toHaveBeenCalledOnce();
  });

  it("keeps consent recovery blocked when the authoritative balance refresh fails", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "refresh-failure", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded", operationId: "operation-refresh-failure" } }) });
    mocks.apiRequest.mockRejectedValueOnce(Object.assign(new Error("consent unavailable"), { status: 503 }));
    mocks.invalidatePaymentHistoryFinancials.mockRejectedValue(new Error("balance refresh unavailable"));
    mocks.tokenizeCard.mockResolvedValue("combined-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    const standingProps = mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void };
    act(() => { standingProps.onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ dueNowOnly: true }));
    const checkoutProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await checkoutProps.onSubmit(); });
    await waitFor(() => expect(document.body).toHaveTextContent("Retry automatic payments"));

    mocks.setStandingAutopayState("active");
    mocks.standingStatusRefetch.mockResolvedValue({ data: { data: { state: "active" } }, error: null, isError: false });
    await act(async () => { screen.getByRole("button", { name: "Retry automatic payments" }).click(); });

    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("leaguevault:standing-consent-intent:v1:stable-scope")).not.toBeNull();
    expect(document.body).toHaveTextContent("Automatic-payment setup is confirmed, but payment balances could not be refreshed.");
    expect(document.body).toHaveTextContent("Retry automatic payments");
  });

  it("does not re-probe recovery when a positive payment amount changes", async () => {
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValue({ requestKey: "stable-request", outcome: "new" });
    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledOnce());

    mocks.setRemainingBalance(5_750);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentAmountMinor: 5_750 }));
    expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledOnce();
  });

  it("blocks card tokenization when the submit quote no longer matches the displayed quote", async () => {
    const firstRender = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "stale-quote-request", outcome: "new" });
    mocks.csrfFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-5750", amountMinor: 5_750 } }) });

    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await props.onSubmit(); });

    expect(mocks.csrfFetch).toHaveBeenCalledOnce();
    expect(mocks.tokenizeCard).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment Failed" }));
    firstRender.unmount();
  });

  it("marks the selected basket stale after a participant balance refetch instead of silently clamping it", async () => {
    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());

    mocks.setRemainingBalance(5_750);
    view.rerender(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ selectionStale: true }));
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { recipientRows: Array<{ bowlerId: number; selected: boolean; remainingMinor: number }>; onSubmit: () => void };
    expect(props.recipientRows).toEqual([expect.objectContaining({ bowlerId: 42, selected: true, remainingMinor: 5_750 })]);
    expect(mocks.csrfFetch).not.toHaveBeenCalled();
    view.unmount();
  });

  it("recovers a lost success on remount before a changed quote can charge again", async () => {
    const firstRender = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "stable-request", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "stable-request", outcome: "unresolved", status: "pending" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750, payerBowlerId: 42 } }) })
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
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ completedPayment: null });
    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.tokenizeCard).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment already confirmed" }));
    expect(document.body).not.toHaveTextContent("Payment confirmation in progress");
  });

  it("clears the refresh baseline after an authoritative unchanged response", async () => {
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "successful-request", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded" } }) });
    mocks.tokenizeCard.mockResolvedValue("card-source");

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await props.onSubmit(); });
    expect(mocks.toast.mock.calls.filter(([value]) => (value as { title?: string }).title === "Payment Successful")).toHaveLength(0);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      completedPayment: expect.objectContaining({ amountMinor: 8_750, isUpfront: true, coverage: "Week 1", hasRemainingBalance: false }),
    }));
    expect((mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { completedPayment: { coverage: string } }).completedPayment.coverage).not.toContain("Bowler:");

    mocks.setRemainingBalance(5_750);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ selectionStale: true, paymentAmountMinor: 5_750 }));
    view.unmount();
  });

  it("clears ordinary card completion before starting combined automatic-payment enrollment", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "ordinary-card-request", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-1000", amountMinor: 1_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded" } }) });
    mocks.tokenizeCard.mockResolvedValue("card-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.standingAutopayCard).toHaveBeenCalled());
    const checkoutProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await checkoutProps.onSubmit(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      completedPayment: expect.objectContaining({ amountMinor: 1_000 }),
    }));

    const standingProps = mocks.standingAutopayCard.mock.calls.at(-1)?.[0] as { onPayDueNow: () => void };
    act(() => { standingProps.onPayDueNow(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      dueNowOnly: true,
      completedPayment: null,
      onCancelDueNow: expect.any(Function),
    }));
  });

  it("keeps recovered checkout blocked until the balance refresh settles", async () => {
    let resolveRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { resolveRefresh = resolve; });
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "confirmed-request", outcome: "succeeded" });
    mocks.invalidatePaymentHistoryFinancials.mockReturnValueOnce(refresh);

    render(<MakePaymentPage />);
    await waitFor(() => expect(document.body).toHaveTextContent("Payment confirmation in progress"));
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();

    await act(async () => { resolveRefresh(); });
    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "confirmed-request"));
    expect(document.body).not.toHaveTextContent("Payment confirmation in progress");
  });

  it("keeps recovered checkout blocked and preserves its identity when refresh fails", async () => {
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "confirmed-request", outcome: "succeeded" });
    mocks.invalidatePaymentHistoryFinancials.mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValue(undefined);

    render(<MakePaymentPage />);
    await waitFor(() => expect(document.body).toHaveTextContent("Payment confirmation in progress"));
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    await act(async () => { await (document.querySelector("button") as HTMLButtonElement).click(); });
    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "confirmed-request"));
  });

  it("can retry a submit-time confirmed payment after its first balance refresh fails", async () => {
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "initial-request", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "submit-confirmed", outcome: "succeeded" })
      .mockResolvedValue({ requestKey: "submit-confirmed", outcome: "succeeded" });
    mocks.invalidatePaymentHistoryFinancials.mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValue(undefined);

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await props.onSubmit(); });
    await waitFor(() => expect(document.body).toHaveTextContent("Payment confirmation in progress"));
    expect((mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { completedPayment: unknown }).completedPayment).toBeNull();
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();

    await act(async () => { await (document.querySelector("button") as HTMLButtonElement).click(); });
    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "submit-confirmed"));
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ completedPayment: null });
    expect(document.body).not.toHaveTextContent("Payment confirmation in progress");
  });

  it("keeps the remaining-balance action when an unselected partner still owes after a self-only upfront payment", async () => {
    mocks.setIncludePartner(true);
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "partner-balance-request", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: "succeeded" } }) });
    mocks.tokenizeCard.mockResolvedValue("card-source");

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void; recipientRows: Array<{ bowlerId: number; selected: boolean }> };
    expect(props.recipientRows).toEqual([
      expect.objectContaining({ bowlerId: 42, selected: true }),
      expect.objectContaining({ bowlerId: 84, selected: false }),
    ]);

    await act(async () => { await props.onSubmit(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      completedPayment: expect.objectContaining({ hasRemainingBalance: true }),
    }));
  });

  it("replaces a terminal wallet identity before the next same-page click", async () => {
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "wallet-key", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "wallet-replacement", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750, payerBowlerId: 42 } }) })
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

  it.each(["apple_pay", "google_pay"] as const)("keeps the prepared identity through weekly selection changes for %s", async (walletType) => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "prepared-wallet-request", outcome: "new" })
      .mockResolvedValue({ requestKey: "prepared-wallet-request", outcome: "unresolved", status: "pending" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-2000", payerBowlerId: 42, amountMinor: 2_000 } }) })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ data: { status: "pending" } }) });

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));
    expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledOnce();
    let props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { recipientRows: Array<{ bowlerId: number; weeks: number }>; paymentAmountMinor: number; onRecipientWeeksChange: (bowlerId: number, value: number) => void };
    expect(props).toMatchObject({ paymentAmountMinor: 1_000, recipientRows: [expect.objectContaining({ bowlerId: 42, weeks: 1 })] });

    act(() => { props.onRecipientWeeksChange(42, 3); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentAmountMinor: 3_000, recipientRows: [expect.objectContaining({ bowlerId: 42, weeks: 3 })] }));
    props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as typeof props;
    act(() => { props.onRecipientWeeksChange(42, 2); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentAmountMinor: 2_000, recipientRows: [expect.objectContaining({ bowlerId: 42, weeks: 2 })] }));
    expect(mocks.prepareRosterPaymentIntent).toHaveBeenCalledOnce();
    expect(mocks.walletOptions.onPaymentStarted?.()).toBe(true);

    await act(async () => { await mocks.walletOptions.onTokenReceived?.("wallet-source", walletType); });
    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(2));
    const quoteRequest = mocks.csrfFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(quoteRequest.body))).toMatchObject({ recipients: [{ bowlerId: 42, weeks: 2, fullBalance: false }] });
    expect(JSON.parse(String(quoteRequest.body))).not.toHaveProperty("amountMinor");
    expect(JSON.parse(String(quoteRequest.body))).not.toHaveProperty("payerBowlerId");
    const chargeRequest = mocks.csrfFetch.mock.calls[1]?.[1] as RequestInit;
    expect(chargeRequest.headers).toMatchObject({ "Idempotency-Key": "prepared-wallet-request" });
    expect(JSON.parse(String(chargeRequest.body))).toMatchObject({
      recipients: [{ bowlerId: 42, weeks: 2, fullBalance: false }],
      sourceId: "wallet-source",
      sourceKind: "wallet",
      idempotencyKey: "prepared-wallet-request",
      requestFingerprint: "quote-2000",
    });
    expect(document.body).toHaveTextContent("Payment confirmation in progress");
    view.unmount();
  });

  it("rejects a deferred wallet token when the basket changes after the native sheet opens", async () => {
    mocks.setPaymentMode("weekly");
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "wallet-request", outcome: "new" });
    mocks.csrfFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-3000", amountMinor: 3_000 } }) });

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));
    expect(mocks.walletOptions.onPaymentStarted?.()).toBe(true);

    let props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { recipientRows: Array<{ bowlerId: number; weeks: number }>; onRecipientWeeksChange: (bowlerId: number, value: number) => void };
    act(() => { props.onRecipientWeeksChange(42, 3); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentAmountMinor: 3_000, recipientRows: [expect.objectContaining({ bowlerId: 42, weeks: 3 })] }));

    await act(async () => { await mocks.walletOptions.onTokenReceived?.("deferred-wallet-source", "apple_pay"); });
    expect(mocks.csrfFetch).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment Failed" }));
    view.unmount();
  });

  it("keeps wallet SDK eligibility mounted while a background quote fetch is in flight", async () => {
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "wallet-request", outcome: "new" });
    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));

    mocks.setQuoteFetching(true);
    view.rerender(<MakePaymentPage />);

    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ quoteLoading: true }));
    expect(mocks.walletOptions.enabled).toBe(true);
    view.unmount();
  });

  it("does not charge a card when the displayed quote changes during tokenization", async () => {
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "card-request", outcome: "new" });
    mocks.csrfFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) });
    let resolveToken!: (token: string) => void;
    mocks.tokenizeCard.mockReturnValue(new Promise<string>((resolve) => { resolveToken = resolve; }));

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    act(() => { props.onSubmit(); });
    await waitFor(() => expect(mocks.tokenizeCard).toHaveBeenCalledOnce());

    mocks.setRemainingBalance(5_750);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ selectionStale: true }));
    await act(async () => { resolveToken("card-source"); });

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment Failed" })));
    expect(mocks.csrfFetch).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps controls gated until the authoritative participant refresh returns", async () => {
    let resolveParticipants!: () => void;
    mocks.setParticipantRefreshGate(new Promise<void>((resolve) => { resolveParticipants = resolve; }));
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "refresh-request", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { status: "succeeded" } }) });
    mocks.tokenizeCard.mockResolvedValue("card-source");

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    act(() => { props.onSubmit(); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ isSubmitting: true, paymentRefreshState: "refreshing" }));
    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();

    await act(async () => { resolveParticipants(); });
    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "refresh-request"));
  });

  it("fails closed when participant refresh returns no authoritative data", async () => {
    mocks.setParticipantRefreshMissing(true);
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "missing-refresh-request", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { status: "succeeded" } }) });
    mocks.tokenizeCard.mockResolvedValue("card-source");

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await props.onSubmit(); });

    expect(mocks.clearPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.toast.mock.calls.filter(([value]) => (value as { title?: string }).title === "Payment Successful")).toHaveLength(0);
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ completedPayment: null });
    expect(mocks.cleanupCard).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentRefreshState: "retry", isSubmitting: true }));
    mocks.setParticipantRefreshMissing(false);
    const retryProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onRetryPaymentRefresh: () => void };
    await act(async () => { retryProps.onRetryPaymentRefresh(); });
    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "missing-refresh-request"));
    expect(mocks.toast.mock.calls.filter(([value]) => (value as { title?: string }).title === "Payment Successful")).toHaveLength(0);
    expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ completedPayment: expect.objectContaining({ amountMinor: 8_750, coverage: "Week 1" }) });
    expect(mocks.cleanupCard).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("replaces a wallet identity after a failed refresh before the next wallet payment", async () => {
    mocks.setParticipantRefreshMissing(true);
    mocks.setIncludePartner(true);
    mocks.prepareRosterPaymentIntent
      .mockReset()
      .mockResolvedValueOnce({ requestKey: "wallet-old", outcome: "new" })
      .mockResolvedValueOnce({ requestKey: "wallet-new", outcome: "new" });
    mocks.csrfFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { status: "succeeded" } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { fingerprint: "quote-8750", amountMinor: 8_750 } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { status: "succeeded" } }) });

    const view = render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const selectionProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onRecipientToggle: (bowlerId: number, selected: boolean) => void };
    act(() => { selectionProps.onRecipientToggle(84, true); });
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));
    expect(mocks.walletOptions.onPaymentStarted?.()).toBe(true);
    await act(async () => { await mocks.walletOptions.onTokenReceived?.("wallet-source-1", "apple_pay"); });
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ paymentRefreshState: "retry" }));
    expect(mocks.toast.mock.calls.filter(([value]) => (value as { title?: string }).title === "Payment Successful")).toHaveLength(1);
    await waitFor(() => expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledWith(expect.anything(), 17, 84));
    mocks.invalidatePaymentHistoryFinancials.mockClear();

    mocks.setParticipantRefreshMissing(false);
    const retryProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onRetryPaymentRefresh: () => void };
    await act(async () => { retryProps.onRetryPaymentRefresh(); });
    await waitFor(() => expect(mocks.clearPaymentIntent).toHaveBeenCalledWith("stable-scope", "wallet-old"));
    expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledWith(expect.anything(), 17, 84);
    await waitFor(() => expect(mocks.walletOptions.enabled).toBe(true));
    expect(mocks.walletOptions.onPaymentStarted?.()).toBe(true);
    await act(async () => { await mocks.walletOptions.onTokenReceived?.("wallet-source-2", "apple_pay"); });
    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(4));
    expect((mocks.csrfFetch.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({ "Idempotency-Key": "wallet-new" });
    expect(mocks.toast.mock.calls.filter(([value]) => (value as { title?: string }).title === "Payment Successful")).toHaveLength(2);
    view.unmount();
  });

  it("does not tokenize or charge when the fresh quote reports the network fallback", async () => {
    mocks.prepareRosterPaymentIntent.mockReset().mockResolvedValue({ requestKey: "network-request", outcome: "new" });
    mocks.csrfFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "NETWORK_UNAVAILABLE", message: "Unable to connect. Check your connection and try again." } }),
    });

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    const props = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onSubmit: () => void };
    await act(async () => { await props.onSubmit(); });

    expect(mocks.tokenizeCard).not.toHaveBeenCalled();
    expect(mocks.csrfFetch).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Payment Failed",
      description: "Unable to connect. Check your connection and try again.",
    }));
  });

  it("refreshes participants and keeps the checkout safe when the quote reports no payable obligations", async () => {
    mocks.setQuoteError({ code: "NO_ELIGIBLE_OBLIGATIONS", status: 422, message: "The selected recipient has no remaining payable balance" });

    render(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard).toHaveBeenCalled());
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({
      quoteError: "No remaining balance is available for the selected recipient. Review the recipients and try again.",
    }));
    expect(mocks.csrfFetch).not.toHaveBeenCalled();
    expect(mocks.tokenizeCard).not.toHaveBeenCalled();
  });

  it("bounds a persistent stale quote and re-arms after a successful quote", async () => {
    const staleQuote = { code: "STALE_QUOTE", status: 409, message: "The quote is stale" };
    mocks.setQuoteError(staleQuote);
    const view = render(<MakePaymentPage />);

    await waitFor(() => expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledTimes(1));
    expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledWith(expect.anything(), 17, 42);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledTimes(1);

    const quoteProps = mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0] as { onRetryQuote: () => void };
    act(() => { quoteProps.onRetryQuote(); });
    // Model the refetch returning the same stale code after the explicit
    // retry action; the changed error object reruns the page effect without
    // changing the selection key.
    mocks.setQuoteError({ ...staleQuote });
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledTimes(2);

    mocks.setQuoteError(null);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.oneTimePaymentCard.mock.calls.at(-1)?.[0]).toMatchObject({ quoteError: null }));

    mocks.setQuoteError(staleQuote);
    view.rerender(<MakePaymentPage />);
    await waitFor(() => expect(mocks.invalidatePaymentHistoryFinancials).toHaveBeenCalledTimes(3));
    view.unmount();
  });
});
