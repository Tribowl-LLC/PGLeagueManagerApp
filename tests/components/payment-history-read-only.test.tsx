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

vi.mock("@/components/bowler-layout", () => ({ BowlerLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/league-switcher-sheet", () => ({ LeagueSwitcherSheet: () => null }));
vi.mock("@/components/canonical-payment-evidence-table", () => ({ CanonicalPaymentEvidenceTable: () => <div data-testid="payment-history-table" /> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: apiRequestMock, csrfFetch: csrfFetchMock, queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/lib/square", () => ({ tokenizeCard: tokenizeCardMock }));

const league = { id: 17, name: "League", weeklyFee: 3000, organizationId: 1, locationId: null, paymentMode: "weekly" as const, payingLineupSize: null, timezone: "America/Detroit" } satisfies Pick<League, "id" | "name" | "weeklyFee" | "organizationId" | "locationId" | "paymentMode" | "payingLineupSize" | "timezone">;
const savedCard: SavedCard = { id: "card_1", brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 };
const squareCard: SquareCard = { tokenize: async () => ({ status: "OK", token: "source_token" }), attach: async () => undefined, destroy: () => undefined };

beforeEach(() => {
  apiRequestMock.mockReset();
  csrfFetchMock.mockReset();
  tokenizeCardMock.mockReset();
});

describe("PaymentHistoryContent", () => {
  it("formats the next automatic payment in the league timezone", () => {
    expect(formatNextPaymentDate("2030-01-01T04:30:00.000Z", "America/Detroit")).toMatch(/December 31, 2029/);
    expect(formatNextPaymentDate("2030-01-01T04:30:00.000Z", "Pacific/Kiritimati")).toMatch(/January 1, 2030/);
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
    expect(screen.getByText("No amount past due")).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Payment History" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("disables automatic-payment setup without a profile email", () => {
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
    expect(screen.getByRole("button", { name: "Enable automatic payments" })).toBeDisabled();
  });

  it("shows the next scheduled automatic-payment date without implementation copy", async () => {
    csrfFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { cutoffAt: "2030-01-10T00:30:00.000Z" } }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ data: { state: "active", partnerBowlerIds: [] } }) } } });
    render(<QueryClientProvider client={queryClient}><StandingAutopayCard
      league={{ ...league, payingLineupSize: 4 }} bowlerId={42}
      savedCards={[savedCard]} bowlerHasEmail={true} card={null} isInitialized={false}
      cardEditorMode={null} initializeCard={vi.fn()} cleanupCard={vi.fn()} onCardEditorModeChange={vi.fn()}
    /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/Next Payment Scheduled:/)).toHaveTextContent("Next Payment Scheduled: January 9, 2030"));
    expect(screen.queryByText(/exact remaining roster obligations|consent version/i)).not.toBeInTheDocument();
    expect(csrfFetchMock).toHaveBeenCalledWith(
      "/api/financials/leagues/17/standing-autopay/1/quote",
      expect.objectContaining({ method: "POST" }),
    );
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
    const enable = screen.getByRole("button", { name: "Enable automatic payments" });
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
    await userEvent.setup().click(screen.getByRole("button", { name: "Save card and enable automatic payments" }));
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
    const save = screen.getByRole("button", { name: "Save card and enable automatic payments" });
    const click = user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await user.click(save);
    expect(tokenizeCardMock).toHaveBeenCalledOnce();
    resolveTokenize("source_pending");
    await click;
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
  });
});
