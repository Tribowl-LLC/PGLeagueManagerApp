import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { League, SavedCard } from "@shared/schema";
import { PaymentHistoryContent } from "@/pages/payment-history-page/payment-history-content";
import { formatNextPaymentDate, StandingAutopayCard } from "@/components/standing-autopay-card";
import type { SquareCard } from "@/hooks/use-square-payment";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequestMock = vi.hoisted(() => vi.fn());
const csrfFetchMock = vi.hoisted(() => vi.fn());
const tokenizeCardMock = vi.hoisted(() => vi.fn());
const leagueBottomSheetMock = vi.hoisted(() => vi.fn((_props: { viewerRole?: string }) => null));

vi.mock("@/components/bowler-layout", () => ({ BowlerLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/league-bottom-sheet", () => ({ LeagueBottomSheet: leagueBottomSheetMock }));
vi.mock("@/components/canonical-payment-evidence-table", () => ({ CanonicalPaymentEvidenceTable: () => <div data-testid="payment-history-table" /> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: apiRequestMock, csrfFetch: csrfFetchMock, queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/lib/square", () => ({ tokenizeCard: tokenizeCardMock }));

const league = { id: 17, name: "League", weeklyFee: 3000, organizationId: 1, locationId: null, paymentMode: "weekly" as const, payingLineupSize: null, timezone: "America/Detroit" } satisfies Pick<League, "id" | "name" | "weeklyFee" | "organizationId" | "locationId" | "paymentMode" | "payingLineupSize" | "timezone">;
const savedCard: SavedCard = { id: "card_1", brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 };
const squareCard: SquareCard = { tokenize: async () => ({ status: "OK", token: "source_token" }), attach: async () => undefined, destroy: () => undefined };

beforeEach(() => {
  leagueBottomSheetMock.mockClear();
  apiRequestMock.mockReset();
  csrfFetchMock.mockReset();
  tokenizeCardMock.mockReset();
});

describe("PaymentHistoryContent", () => {
  it("passes the current user role to the shared Overview league picker", () => {
    render(<PaymentHistoryContent
      bowlerName="Bowler"
      viewerRole="user"
      league={league}
      leagueId={17}
      hasMultipleLeagues
      leagueSheetOpen
      onOpenLeagueSheet={vi.fn()}
      onCloseLeagueSheet={vi.fn()}
      bowlerLeagues={[{ id: 71, bowlerId: 42, leagueId: 17, teamId: 81, active: true, order: 0, joinedAt: "2026-08-01T00:00:00.000Z" }]}
      leagueMap={new Map()}
      onSelectLeague={vi.fn()}
      totalWeeksInSeason={10}
      fullSeasonAmount={30000}
      weeksDueCount={3}
      totalSeasonDues={9000}
      weeksPaid={1}
      totalPaidAmount={3000}
      amountPastDue={6000}
      remainingBalance={27000}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false }}
      canonicalPaymentLoading={false}
      canonicalPaymentError={null}
      canonicalRows={[]}
    />);

    expect(leagueBottomSheetMock.mock.lastCall?.[0].viewerRole).toBe("user");
  });

  it("formats the next automatic payment in the league timezone", () => {
    expect(formatNextPaymentDate("2030-01-01T04:30:00.000Z", "America/Detroit")).toMatch(/December 31, 2029/);
    expect(formatNextPaymentDate("2030-01-01T04:30:00.000Z", "Pacific/Kiritimati")).toMatch(/January 1, 2030/);
    expect(formatNextPaymentDate("2030-01-01T04:30:00.000Z", "America/Detroit", "short")).toMatch(/Dec 31/);
    expect(formatNextPaymentDate("2030-01-01T04:30:00.000Z", "Pacific/Kiritimati", "short")).toMatch(/Jan 1/);
  });

  it("is read-only action-wise and links summary cards to Make Payment", () => {
    render(<PaymentHistoryContent
      bowlerName="Bowler"
      league={league}
      leagueId={17}
      hasMultipleLeagues={false}
      leagueSheetOpen={false}
      onOpenLeagueSheet={vi.fn()}
      onCloseLeagueSheet={vi.fn()}
      bowlerLeagues={[]}
      leagueMap={new Map()}
      onSelectLeague={vi.fn()}
      totalWeeksInSeason={10}
      fullSeasonAmount={30000}
      weeksDueCount={3}
      totalSeasonDues={9000}
      weeksPaid={1}
      totalPaidAmount={3000}
      amountPastDue={6000}
      remainingBalance={27000}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false }}
      canonicalPaymentLoading={false}
      canonicalPaymentError={null}
      canonicalRows={[]}
    />);
    expect(screen.getByRole("link", { name: /Amount Past Due/ })).toHaveAttribute("href", "/make-payment?leagueId=17&intent=past-due");
    expect(screen.getByRole("link", { name: /Remaining Balance/ })).toHaveAttribute("href", "/make-payment?leagueId=17");
    expect(screen.getByTestId("history-weeks-paid")).toHaveTextContent("Weeks paid");
    expect(screen.getByTestId("history-weeks-paid")).toHaveTextContent("1/10 weeks");
    expect(screen.queryByRole("button", { name: /revoke|enable|replace|pay/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Square|card details|automatic weekly payments/i)).not.toBeInTheDocument();
  });

  it("does not make zero-balance summary cards actionable", () => {
    render(<PaymentHistoryContent
      bowlerName="Bowler"
      league={league}
      leagueId={17}
      hasMultipleLeagues={false}
      leagueSheetOpen={false}
      onOpenLeagueSheet={vi.fn()}
      onCloseLeagueSheet={vi.fn()}
      bowlerLeagues={[]}
      leagueMap={new Map()}
      onSelectLeague={vi.fn()}
      totalWeeksInSeason={10}
      fullSeasonAmount={30000}
      weeksDueCount={3}
      totalSeasonDues={9000}
      weeksPaid={3}
      totalPaidAmount={9000}
      amountPastDue={0}
      remainingBalance={0}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: true }}
      canonicalPaymentLoading={false}
      canonicalPaymentError={null}
      canonicalRows={[]}
    />);
    expect(screen.queryByRole("link", { name: /Amount Past Due/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Remaining Balance/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Past Due")).not.toBeInTheDocument();
    expect(screen.getByText("Fully paid")).toBeInTheDocument();
  });

  it("keeps report failures inside the layout and offers a retry", async () => {
    const retry = vi.fn();
    render(<PaymentHistoryContent
      bowlerName="Bowler" league={league} leagueId={17} hasMultipleLeagues={false}
      leagueSheetOpen={false} onOpenLeagueSheet={vi.fn()} onCloseLeagueSheet={vi.fn()}
      bowlerLeagues={[]} leagueMap={new Map()} onSelectLeague={vi.fn()}
      totalWeeksInSeason={10} fullSeasonAmount={30000} weeksDueCount={3} totalSeasonDues={9000}
      weeksPaid={1} totalPaidAmount={3000} amountPastDue={6000} remainingBalance={27000}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false }}
      canonicalPaymentLoading={false} canonicalPaymentError={new Error("report unavailable")}
      onCanonicalReportRetry={retry}
    />);
    expect(screen.getByRole("heading", { name: "Payment history" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("supports previous and next report pages", async () => {
    const onPageChange = vi.fn();
    const view = render(<PaymentHistoryContent
      bowlerName="Bowler" league={league} leagueId={17} hasMultipleLeagues={false}
      leagueSheetOpen={false} onOpenLeagueSheet={vi.fn()} onCloseLeagueSheet={vi.fn()}
      bowlerLeagues={[]} leagueMap={new Map()} onSelectLeague={vi.fn()}
      totalWeeksInSeason={10} fullSeasonAmount={30000} weeksDueCount={3} totalSeasonDues={9000}
      weeksPaid={1} totalPaidAmount={3000} amountPastDue={6000} remainingBalance={27000}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false }}
      canonicalPaymentLoading={false} canonicalPaymentError={null} canonicalRows={[]}
      canonicalReportPage={1} canonicalReportTotalPages={2} onCanonicalReportPageChange={onPageChange}
    />);

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    view.rerender(<PaymentHistoryContent
      bowlerName="Bowler" league={league} leagueId={17} hasMultipleLeagues={false}
      leagueSheetOpen={false} onOpenLeagueSheet={vi.fn()} onCloseLeagueSheet={vi.fn()}
      bowlerLeagues={[]} leagueMap={new Map()} onSelectLeague={vi.fn()}
      totalWeeksInSeason={10} fullSeasonAmount={30000} weeksDueCount={3} totalSeasonDues={9000}
      weeksPaid={1} totalPaidAmount={3000} amountPastDue={6000} remainingBalance={27000}
      doublePay={{ dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false }}
      canonicalPaymentLoading={false} canonicalPaymentError={null} canonicalRows={[]}
      canonicalReportPage={2} canonicalReportTotalPages={2} onCanonicalReportPageChange={onPageChange}
    />);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("does not expose ordinary totals while rotating eligibility is unresolved", () => {
    const props = {
      bowlerName: "Bowler",
      league,
      leagueId: 17,
      hasMultipleLeagues: false,
      leagueSheetOpen: false,
      onOpenLeagueSheet: vi.fn(),
      onCloseLeagueSheet: vi.fn(),
      bowlerLeagues: [],
      leagueMap: new Map(),
      onSelectLeague: vi.fn(),
      totalWeeksInSeason: 10,
      fullSeasonAmount: 30000,
      weeksDueCount: 3,
      totalSeasonDues: 9000,
      weeksPaid: 1,
      totalPaidAmount: 3000,
      amountPastDue: 6000,
      remainingBalance: 27000,
      doublePay: { dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: false },
      canonicalPaymentLoading: false,
      canonicalPaymentError: null,
      canonicalRows: [],
    };
    const view = render(<PaymentHistoryContent {...props} rotatingCreditState="loading" />);
    expect(screen.getByText("Loading payment summary…")).toBeInTheDocument();
    expect(screen.queryByText("Season totals")).not.toBeInTheDocument();

    view.rerender(<PaymentHistoryContent {...props} rotatingCreditState="standard" isRotating={false} />);
    expect(screen.getByText("Season totals")).toBeInTheDocument();
    expect(screen.getByTestId("history-weeks-paid")).toHaveTextContent("1/10 weeks");

    view.rerender(<PaymentHistoryContent {...props} totalWeeksInSeason={32} weeksPaid={32} rotatingCreditState="standard" isRotating={false} />);
    expect(screen.getByTestId("history-weeks-paid")).toHaveTextContent("32/32 weeks");

    view.rerender(<PaymentHistoryContent {...props} rotatingCreditState="standard" isRotating />);
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.queryByTestId("history-weeks-paid")).not.toBeInTheDocument();
    expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
    expect(screen.queryByText("Season", { selector: ".familiar-payment-summary__label" })).not.toBeInTheDocument();
  });

  it("disables automatic-payment setup without a profile email", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }}
      bowlerId={42}
      savedCards={[savedCard]}
      bowlerHasEmail={false}
      card={null}
      isInitialized={false}
      cardEditorMode={null}
      initializeCard={vi.fn()}
      cleanupCard={vi.fn()}
      onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/profile");
    await waitFor(() => expect(screen.getByRole("button", { name: "Set up automatic payments" })).toBeDisabled());
  });

  it("keeps the due-now CTA hidden until a delayed active status read completes", async () => {
    let resolveStatus!: (value: { data: { state: string; partnerBowlerIds: never[] } }) => void;
    const statusResponse = new Promise<{ data: { state: string; partnerBowlerIds: never[] } }>((resolve) => { resolveStatus = resolve; });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => String(queryKey[0]).endsWith("/quote") ? ({ data: { cutoffAt: "2030-01-10T00:30:00.000Z" } }) : statusResponse } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[savedCard]}
      bowlerHasEmail={true} card={null} isInitialized={false} cardEditorMode={null}
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
      dueNowMinor={4_500} onPayDueNow={vi.fn()}
    /></QueryClientProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Checking automatic-payment status…");
    expect(screen.queryByRole("button", { name: "Pay due now and enable automatic payments" })).not.toBeInTheDocument();

    resolveStatus({ data: { state: "active", partnerBowlerIds: [] } });
    await waitFor(() => expect(screen.getByText("Enabled")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Pay due now and enable automatic payments" })).not.toBeInTheDocument();
  });

  it("does not flash a due-now CTA while cached status refetches", async () => {
    let resolveStatus!: (value: { data: { state: string; partnerBowlerIds: never[] } }) => void;
    const statusResponse = new Promise<{ data: { state: string; partnerBowlerIds: never[] } }>((resolve) => { resolveStatus = resolve; });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => String(queryKey[0]).endsWith("/quote") ? ({ data: { cutoffAt: "2030-01-10T00:30:00.000Z" } }) : statusResponse } } });
    queryClient.setQueryData(["/api/financials/leagues/17/standing-autopay/1"], { data: { state: "none", partnerBowlerIds: [] } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[savedCard]}
      bowlerHasEmail={true} card={null} isInitialized={false} cardEditorMode={null}
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
      dueNowMinor={4_500} onPayDueNow={vi.fn()}
    /></QueryClientProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Checking automatic-payment status…");
    expect(screen.queryByRole("button", { name: "Pay due now and enable automatic payments" })).not.toBeInTheDocument();

    resolveStatus({ data: { state: "active", partnerBowlerIds: [] } });
    await waitFor(() => expect(screen.getByText("Enabled")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Pay due now and enable automatic payments" })).not.toBeInTheDocument();
  });

  it("routes due obligations through one combined checkout", async () => {
    const onPayDueNow = vi.fn();
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[savedCard]}
      bowlerHasEmail={true} card={null} isInitialized={false} cardEditorMode={null}
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
      dueNowMinor={4_500} catchUpWeeks={2} onPayDueNow={onPayDueNow}
    /></QueryClientProvider>);
    await user.click(await screen.findByRole("button", { name: "Set up automatic payments" }));
    expect(await screen.findByText("Pay $45.00 due now and enable automatic payments in one checkout.")).toBeInTheDocument();
    expect(screen.queryByText(/This payment covers/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable automatic payments" })).not.toBeInTheDocument();
    const payDueNow = screen.getByRole("button", { name: "Pay due now and enable automatic payments" });
    expect(payDueNow).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(payDueNow);
    expect(onPayDueNow).toHaveBeenCalledOnce();
  });

  it("replaces the duplicate due CTA while combined checkout is active", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[savedCard]}
      bowlerHasEmail={true} card={null} isInitialized={false} cardEditorMode={null}
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
      dueNowMinor={4_500} catchUpWeeks={2} combinedCheckoutActive onPayDueNow={vi.fn()}
    /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Complete checkout above to enable automatic payments."));
    expect(screen.queryByRole("button", { name: "Pay due now and enable automatic payments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable automatic payments" })).not.toBeInTheDocument();
  });

  it("hides normal consent controls while a combined recovery marker is active", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[savedCard]}
      bowlerHasEmail={true} card={null} isInitialized={false} cardEditorMode={null}
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
      dueNowMinor={0} dueNowDataAvailable combinedCheckoutActive onPayDueNow={vi.fn()}
    /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("standing-autopay-card")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Enable automatic payments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add new card" })).not.toBeInTheDocument();
  });

  it("shows the next scheduled automatic-payment date without implementation copy", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => String(queryKey[0]).endsWith("/quote")
      ? ({ data: { cutoffAt: "2030-01-10T00:30:00.000Z", amountMinor: 2500, collectionMode: "weekly" } })
      : ({ data: { state: "active", partnerBowlerIds: [], paymentMethod: { brand: "Visa", last4: "4242" } } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 4 }} bowlerId={42}
      savedCards={[savedCard]} bowlerHasEmail={true} card={null} isInitialized={false}
      cardEditorMode={null} initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("$25")).toBeInTheDocument());
    expect(screen.getByText("· Jan 9")).toBeInTheDocument();
    expect(screen.getByText("Next automatic payment")).toBeInTheDocument();
    expect(screen.getByText("Visa ending in 4242")).toBeInTheDocument();
    expect(screen.queryByText("Double-pay weeks")).not.toBeInTheDocument();
    expect(screen.queryByText(/exact remaining roster obligations|consent version/i)).not.toBeInTheDocument();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it("shows the recovery message when the next automatic payment is blocked", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => {
      if (String(queryKey[0]).endsWith("/quote")) throw new Error("409: Pay older unpaid obligations with a one-time payment before automatic payments can resume.");
      return { data: { state: "active", partnerBowlerIds: [] } };
    } } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 4 }} bowlerId={42}
      savedCards={[savedCard]} bowlerHasEmail={true} card={null} isInitialized={false}
      cardEditorMode={null} initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("Unavailable")).toBeInTheDocument());
    expect(screen.getByText("Next automatic payment")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Pay older unpaid obligations with a one-time payment before automatic payments can resume.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("409:");
  });

  it("prioritizes the actionable scheduled decline over the misleading arrears quote", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => {
      if (String(queryKey[0]).endsWith("/quote")) throw new Error("409: Pay older unpaid obligations with a one-time payment before automatic payments can resume.");
      return { data: {
        state: "active",
        partnerBowlerIds: [],
        paymentAttention: "scheduled_payment_declined",
      } };
    } } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 4 }} bowlerId={42}
      savedCards={[savedCard]} bowlerHasEmail={true} card={null} isInitialized={false}
      cardEditorMode={null} initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("scheduled automatic payment was declined"));
    expect(screen.getByRole("alert")).toHaveTextContent("Use the One-Time Payment section below");
    expect(screen.queryByText(/Next Payment Scheduled:/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("ARREARS_REQUIRE_ONE_TIME_FIFO");
  });

  it("reuses the consent command key when the outcome is unresolved", async () => {
    apiRequestMock.mockRejectedValue(new Error("temporary network failure"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42}
      savedCards={[savedCard]}
      bowlerHasEmail={true} card={null} isInitialized={false} cardEditorMode={null}
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    await user.click(await screen.findByRole("button", { name: "Set up automatic payments" }));
    const enable = await screen.findByRole("button", { name: "Enable automatic payments" });
    await user.click(screen.getByRole("checkbox", { name: /I agree to automatic weekly payments/i }));
    await user.click(enable);
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    await user.click(enable);
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
    expect(apiRequestMock.mock.calls[0]?.[2]?.commandKey).toBe(apiRequestMock.mock.calls[1]?.[2]?.commandKey);
  });

  it("vaults a new card without charging and passes the returned card to consent", async () => {
    tokenizeCardMock.mockResolvedValue("source_token");
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { savedCardId: "saved_1" } }) });
    apiRequestMock.mockResolvedValue({ success: true, data: { state: "active" } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[]}
      bowlerHasEmail={true}
      card={squareCard}
      isInitialized={true} cardEditorMode="autopay" initializeCard={vi.fn()}
      cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Set up automatic payments" }));
    await user.click(await screen.findByRole("checkbox", { name: /I agree to automatic weekly payments/i }));
    await user.click(await screen.findByRole("button", { name: "Save card and enable automatic payments" }));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(csrfFetchMock).toHaveBeenCalledWith("/api/payments-provider/cards/42", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(csrfFetchMock.mock.calls[0]?.[1]?.body))).toEqual({ sourceId: "source_token", leagueId: 17 });
    expect(apiRequestMock.mock.calls[0]?.[2]).toMatchObject({ sourceId: "saved_1" });
  });

  it("locks card setup while tokenize, vault, and consent are pending", async () => {
    let resolveTokenize!: (token: string) => void;
    tokenizeCardMock.mockReturnValue(new Promise<string>((resolve) => { resolveTokenize = resolve; }));
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { savedCardId: "saved_pending" } }) });
    apiRequestMock.mockResolvedValue({ success: true, data: { state: "active" } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "none", partnerBowlerIds: [] } }) } } });
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 5 }} bowlerId={42} savedCards={[]}
      bowlerHasEmail={true} card={squareCard} isInitialized={true} cardEditorMode="autopay"
      initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    await user.click(await screen.findByRole("button", { name: "Set up automatic payments" }));
    const save = await screen.findByRole("button", { name: "Save card and enable automatic payments" });
    await user.click(screen.getByRole("checkbox", { name: /I agree to automatic weekly payments/i }));
    const click = user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await user.click(save);
    expect(tokenizeCardMock).toHaveBeenCalledOnce();
    resolveTokenize("source_pending");
    await click;
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
  });
});
