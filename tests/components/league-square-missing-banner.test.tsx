import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { League } from "@shared/schema";
import { LeagueSquareMissingBanner } from "@/components/league-square-missing-banner";

function makeLeague(overrides: Partial<League> = {}): League {
  return {
    id: 1,
    name: "Active League",
    description: null,
    active: true,
    scheduleAuthority: "canonical",
    allowPublicSignup: false,
    seasonStart: "2026-01-01",
    seasonEnd: "2026-04-01",
    weekDay: "Monday",
    weeklyFee: 1_500,
    lineageFee: 1_000,
    prizeFundFee: 500,
    practiceStartTime: null,
    competitionStartTime: null,
    squareLineageItemId: "item-lineage",
    lineageItemVariationId: "var-lineage",
    squareLineageItemName: "Lineage Item",
    squarePrizeFundItemId: "item-prize",
    prizeFundItemVariationId: "var-prize",
    squarePrizeFundItemName: "Prize Item",
    squareCategoryId: null,
    timezone: "America/New_York",
    paymentMode: "weekly",
    seasonNumber: 1,
    previousSeasonId: null,
    locationId: 200,
    organizationId: 100,
    totalBowlingWeeks: null,
    finalTwoWeeksDueWeek: null,
    skipDates: [],
    cancelledDates: [],
    doublePayDates: [],
    ...overrides,
  };
}

function renderBanner(leagues: League[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async () => ({ data: null }),
      },
    },
  });
  queryClient.setQueryData(["/api/user"], {
    data: { id: 10, role: "org_admin", organizationId: 100 },
  });
  queryClient.setQueryData(["/api/leagues/square-missing-alerts/recent"], {
    data: {
      alerts: leagues.map((league) => ({
        sentAt: "2026-05-01T00:00:00.000Z",
        leagueId: league.id,
        leagueName: league.name,
        organizationId: league.organizationId,
        missing: [{ kind: "lineage", itemName: "Lineage", variationId: "var-lineage" }],
      })),
    },
  });
  const onEditLeague = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <LeagueSquareMissingBanner leagues={leagues} onEditLeague={onEditLeague} />
    </QueryClientProvider>,
  );
  return onEditLeague;
}

describe("LeagueSquareMissingBanner archive guard", () => {
  beforeEach(() => localStorage.clear());

  it("omits inactive canonical leagues from actionable Square-missing alerts", async () => {
    const active = makeLeague();
    const archived = makeLeague({ id: 2, name: "Archived League", active: false });
    const onEditLeague = renderBanner([active, archived]);

    expect(await screen.findByText("Active League")).toBeInTheDocument();
    expect(screen.queryByText("Archived League")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Active League" }));
    expect(onEditLeague).toHaveBeenCalledWith(active);
  });

  it("does not expose retired legacy rows even when diagnostics include them", async () => {
    const retired = makeLeague({ id: 3, name: "Retired Legacy", active: false, scheduleAuthority: "retired_legacy" });
    renderBanner([retired]);

    expect(screen.queryByTestId("banner-league-square-missing-alert")).not.toBeInTheDocument();
  });
});
