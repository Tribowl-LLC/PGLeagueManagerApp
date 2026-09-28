import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { League, SavedCard } from "@shared/schema";
import type { SquareCard } from "@/hooks/use-square-payment";
import { StandingAutopayCard } from "@/components/standing-autopay-card";

const apiRequestMock = vi.hoisted(() => vi.fn());
const csrfFetchMock = vi.hoisted(() => vi.fn());
const tokenizeCardMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: apiRequestMock, csrfFetch: csrfFetchMock, queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/lib/square", () => ({ tokenizeCard: tokenizeCardMock }));

const league = {
  id: 17,
  name: "League",
  organizationId: 1,
  locationId: null,
  paymentMode: "weekly" as const,
  payingLineupSize: 5,
  timezone: "America/Detroit",
} satisfies Pick<League, "id" | "name" | "organizationId" | "locationId" | "paymentMode" | "payingLineupSize" | "timezone">;
const savedCard: SavedCard = { id: "card_1", brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 };
const replacementCard: SavedCard = { id: "card_2", brand: "MASTERCARD", last4: "5555", expMonth: 11, expYear: 2031 };
const squareCard: SquareCard = { tokenize: async () => ({ status: "OK", token: "source_token" }), attach: async () => undefined, destroy: () => undefined };

function makeQueryClient(state: "active" | "none" = "active") {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => String(queryKey[0]).endsWith("/quote")
          ? { data: { cutoffAt: "2030-01-10T00:30:00.000Z" } }
          : { data: { state, partnerBowlerIds: [] } },
      },
    },
  });
}

function ActiveReplacementCard({ savedCards = [savedCard], card = null, isInitialized = false }: { savedCards?: SavedCard[]; card?: SquareCard | null; isInitialized?: boolean }) {
  const [cardEditorMode, setCardEditorMode] = useState<"one-time" | "autopay" | null>(null);
  return <StandingAutopayCard
    league={league}
    bowlerId={42}
    savedCards={savedCards}
    bowlerHasEmail
    card={card}
    isInitialized={isInitialized}
    cardEditorMode={cardEditorMode}
    initializeCard={vi.fn()}
    cleanupCard={vi.fn()}
    onCardEditorModeChange={setCardEditorMode}
  />;
}

function renderCard(props?: Parameters<typeof ActiveReplacementCard>[0]) {
  return render(<QueryClientProvider client={makeQueryClient()}><ActiveReplacementCard {...props} /></QueryClientProvider>);
}

function DueNowSetupCard({
  onPayDueNow,
  leagueOverrides = {},
}: {
  onPayDueNow: () => void;
  leagueOverrides?: Partial<Pick<League, "totalBowlingWeeks" | "doublePayDates">>;
}) {
  const [cardEditorMode, setCardEditorMode] = useState<"one-time" | "autopay" | null>(null);
  return <StandingAutopayCard
    league={{ ...league, ...leagueOverrides }}
    bowlerId={42}
    savedCards={[savedCard]}
    bowlerHasEmail
    card={null}
    isInitialized={false}
    cardEditorMode={cardEditorMode}
    initializeCard={vi.fn()}
    cleanupCard={vi.fn()}
    onCardEditorModeChange={setCardEditorMode}
    dueNowMinor={4_500}
    onPayDueNow={onPayDueNow}
  />;
}

function renderDueNowSetupCard(props: Parameters<typeof DueNowSetupCard>[0]) {
  return render(<QueryClientProvider client={makeQueryClient("none")}><DueNowSetupCard {...props} /></QueryClientProvider>);
}

beforeEach(() => {
  apiRequestMock.mockReset();
  csrfFetchMock.mockReset();
  tokenizeCardMock.mockReset();
  apiRequestMock.mockResolvedValue({ success: true, data: { state: "active" } });
});

describe("StandingAutopayCard active replacement", () => {
  it("opens the saved-card selector and replaces the active payment method", async () => {
    const user = userEvent.setup();
    renderCard({ savedCards: [savedCard, replacementCard] });

    await user.click(await screen.findByRole("button", { name: "Change card" }));
    const selector = await screen.findByLabelText("Saved card");
    expect(selector).toHaveValue("card_1");
    await user.selectOptions(selector, "card_2");
    await user.click(screen.getByRole("button", { name: "Replace payment method" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    expect(apiRequestMock).toHaveBeenCalledWith(
      "/api/financials/leagues/17/standing-autopay/1/consent",
      "POST",
      expect.objectContaining({ sourceId: "card_2", partnerBowlerIds: [] }),
    );
  });

  it("vaults a new card and sends it through the active replacement consent path", async () => {
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { savedCardId: "card_new" } }) });
    tokenizeCardMock.mockResolvedValue("source_token");
    const user = userEvent.setup();
    renderCard({ savedCards: [savedCard], card: squareCard, isInitialized: true });

    await user.click(await screen.findByRole("button", { name: "Change card" }));
    await user.click(screen.getByRole("button", { name: "Add new card" }));
    await user.click(await screen.findByRole("button", { name: "Save card and replace payment method" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    expect(csrfFetchMock).toHaveBeenCalledWith(
      "/api/payments-provider/cards/42",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiRequestMock).toHaveBeenCalledWith(
      "/api/financials/leagues/17/standing-autopay/1/consent",
      "POST",
      expect.objectContaining({ sourceId: "card_new", partnerBowlerIds: [] }),
    );
  });

  it("requires confirmation before revoking the active consent", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Turn off automatic payments?");
    expect(apiRequestMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep automatic payments" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await user.click(screen.getByRole("button", { name: "Turn off automatic payments" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    expect(apiRequestMock).toHaveBeenCalledWith(
      "/api/financials/leagues/17/standing-autopay/1/revoke",
      "POST",
      expect.objectContaining({ commandKey: expect.any(String) }),
    );
  });
});

describe("StandingAutopayCard due-now setup", () => {
  it("requires consent before starting combined due-now checkout", async () => {
    const user = userEvent.setup();
    const onPayDueNow = vi.fn();
    renderDueNowSetupCard({ onPayDueNow });

    await user.click(await screen.findByRole("button", { name: "Set up automatic payments" }));
    const payButton = await screen.findByRole("button", { name: "Pay due now and enable automatic payments" });
    expect(payButton).toBeDisabled();
    expect(onPayDueNow).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox"));
    expect(payButton).toBeEnabled();
    await user.click(payButton);
    expect(onPayDueNow).toHaveBeenCalledOnce();
  });

  it("omits a derived last-pay-week claim when future weeks are already prepaid", async () => {
    const user = userEvent.setup();
    renderDueNowSetupCard({
      onPayDueNow: vi.fn(),
      leagueOverrides: { totalBowlingWeeks: 30, doublePayDates: ["2026-10-10", "2026-11-07"] },
    });

    await user.click(await screen.findByRole("button", { name: "Set up automatic payments" }));
    expect(await screen.findByText("I agree to automatic weekly payments and understand that double-pay weeks may be charged twice to cover the final weeks of the season.")).toBeInTheDocument();
    expect(screen.getByText("Double-pay weeks cover the final weeks of the season. Review this schedule before enabling anything.")).toBeInTheDocument();
    expect(screen.queryByText(/Last pay week|final scheduled payment is Week|Week 28/)).not.toBeInTheDocument();
  });
});
