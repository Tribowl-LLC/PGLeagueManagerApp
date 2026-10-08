import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  accountPaymentParticipantsQueryOptions,
  bowlerDetailsWithPaymentsQueryOptions,
  dashboardDuePastDueQueryOptions,
  dashboardLatestPaymentsQueryOptions,
  paymentHistoryFinancialQueryOptions,
  paymentHistoryReportQueryOptions,
  preloadBowlerScreens,
  resolvePreloadLeagueId,
  savedCardsQueryOptions,
} from "@/lib/bowler-screen-queries";
import { BowlerScreenSkeleton } from "@/components/bowler-screen-skeleton";

vi.mock("@/pages/make-payment-page", () => ({ default: () => null }));
vi.mock("@/pages/payment-history-page", () => ({ default: () => null }));
vi.mock("@/lib/queryClient", () => ({
  csrfFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));
vi.mock("@/components/bowler-layout", () => ({
  BowlerLayout: ({ children, bowlerName, leagueName }: { children: ReactNode; bowlerName: string; leagueName: string }) => (
    <div data-testid="bowler-layout" data-bowler-name={bowlerName} data-league-name={leagueName}>{children}</div>
  ),
}));

const BOWLER_ID = 42;
const details = {
  bowler: { id: BOWLER_ID, name: "Avery Lane" },
  bowlerLeagues: [
    { bowlerId: BOWLER_ID, leagueId: 17, teamId: 3, active: true },
    { bowlerId: BOWLER_ID, leagueId: 23, teamId: 5, active: true },
  ],
  leagues: [{ id: 17, name: "Monday Mixed", active: true }, { id: 23, name: "Thursday Trios", active: true }],
  teams: [],
};

function participantsBody(leagueId: number) {
  return {
    contractVersion: "interactive-payment-participants/4",
    accountingMode: "confirmed_account_v4",
    organizationId: 9,
    leagueId,
    payerBowlerId: BOWLER_ID,
    paymentMode: "weekly",
    recipients: [{
      bowlerId: BOWLER_ID,
      name: "Avery Lane",
      role: "self",
      confirmedDebtMinor: 0,
      confirmedPastDueMinor: 0,
      availableCreditMinor: 0,
      forecastTargets: { currentCollectionMinor: 2_500, selectedWeeks: [{ weeks: 1, amountMinor: 2_500 }], fullSeasonMinor: 5_000 },
    }],
  };
}

function bodyFor(url: string): unknown {
  const leagueId = Number(/leagues\/(\d+)\//.exec(url)?.[1] ?? /leagueId=(\d+)/.exec(url)?.[1] ?? 0);
  if (url.includes("/details")) return { success: true, data: details };
  if (url.includes("interactive-payment-participants/4")) return { success: true, data: participantsBody(leagueId) };
  if (url.includes("/api/financials/f5/payments")) return { success: true, data: { rows: [], totalRows: 0 } };
  if (url.includes("canonical-due-past-due/2")) return { success: true, data: { leagueId, rows: [] } };
  if (url.includes("/api/payments-provider/cards/")) return { success: true, data: [] };
  return { success: true, data: [] };
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => (await fetch(String(queryKey[0]))).json(),
      },
    },
  });
}

describe("bowler screen preload", () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(JSON.stringify(bodyFor(url)), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills the cache under the exact keys the dashboard, Pay, and history screens read", async () => {
    const client = newClient();
    await preloadBowlerScreens(client, BOWLER_ID);

    expect(client.getQueryData(dashboardDuePastDueQueryOptions(17, BOWLER_ID).queryKey)).toBeDefined();
    expect(client.getQueryData(dashboardLatestPaymentsQueryOptions(17, BOWLER_ID).queryKey)).toBeDefined();
    expect(client.getQueryData(bowlerDetailsWithPaymentsQueryOptions(BOWLER_ID).queryKey)).toBeDefined();
    expect(client.getQueryData(accountPaymentParticipantsQueryOptions(17, BOWLER_ID).queryKey)).toMatchObject({ leagueId: 17 });
    expect(client.getQueryData(savedCardsQueryOptions(BOWLER_ID, 17).queryKey)).toBeDefined();
    expect(client.getQueryData(paymentHistoryReportQueryOptions(17, BOWLER_ID, 1).queryKey)).toBeDefined();
    expect(client.getQueryData(["/api/financials/leagues/17/standing-autopay/1"])).toBeDefined();
  });

  it("reuses the dashboard balance read for payment history instead of requesting it twice", async () => {
    const client = newClient();
    await preloadBowlerScreens(client, BOWLER_ID);

    expect(client.getQueryData(paymentHistoryFinancialQueryOptions(17, BOWLER_ID).queryKey))
      .toEqual(client.getQueryData(dashboardDuePastDueQueryOptions(17, BOWLER_ID).queryKey));
    expect(requested.filter((url) => url.includes("canonical-due-past-due/2"))).toHaveLength(1);
  });

  it("preloads the league the bowler last chose", async () => {
    localStorage.setItem("bowler_selected_league_id", "23");
    const client = newClient();
    await preloadBowlerScreens(client, BOWLER_ID);

    expect(client.getQueryData(accountPaymentParticipantsQueryOptions(23, BOWLER_ID).queryKey)).toMatchObject({ leagueId: 23 });
    expect(requested.some((url) => url.includes("/leagues/17/"))).toBe(false);
  });

  it("stops after the profile reads when the bowler has no league", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const body = url.includes("/details") ? { success: true, data: { ...details, bowlerLeagues: [], leagues: [] } } : bodyFor(url);
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    await preloadBowlerScreens(newClient(), BOWLER_ID);

    expect(requested.some((url) => url.includes("/api/financials/"))).toBe(false);
  });

  it("leaves a failed read for the screen to report and still loads the rest", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("rotating-credit/1")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(bodyFor(url)), { status: 200 });
    }));
    const client = newClient();
    await expect(preloadBowlerScreens(client, BOWLER_ID)).resolves.toBeUndefined();

    expect(client.getQueryData(accountPaymentParticipantsQueryOptions(17, BOWLER_ID).queryKey)).toBeDefined();
  });
});

describe("resolvePreloadLeagueId", () => {
  beforeEach(() => localStorage.clear());

  it("ignores a remembered league the bowler no longer belongs to", () => {
    localStorage.setItem("bowler_selected_league_id", "999");
    expect(resolvePreloadLeagueId(details as never)).toBe(17);
  });

  it("prefers an active league and has no answer without memberships", () => {
    expect(resolvePreloadLeagueId({
      ...details,
      leagues: [{ id: 17, name: "Monday Mixed", active: false }, { id: 23, name: "Thursday Trios", active: true }],
    } as never)).toBe(23);
    expect(resolvePreloadLeagueId(undefined)).toBeUndefined();
  });
});

describe("BowlerScreenSkeleton", () => {
  it("shows the page outline inside the bowler navigation with what is already known", () => {
    render(<BowlerScreenSkeleton screen="pay" bowlerName="Avery Lane" leagueName="Monday Mixed" />);

    const layout = screen.getByTestId("bowler-layout");
    expect(layout).toHaveAttribute("data-bowler-name", "Avery Lane");
    expect(layout).toHaveAttribute("data-league-name", "Monday Mixed");
    expect(screen.getByRole("heading", { name: "Make a payment" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("does not invite a league choice before the leagues are known", () => {
    render(<BowlerScreenSkeleton screen="dashboard" message="Loading dashboard data..." />);

    expect(screen.getByTestId("bowler-layout").getAttribute("data-league-name")?.trim()).toBe("");
    expect(screen.getByText("Loading dashboard data...")).toBeInTheDocument();
  });
});
