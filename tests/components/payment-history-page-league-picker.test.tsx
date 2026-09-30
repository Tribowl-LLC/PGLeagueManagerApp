import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const content = vi.fn((_props: {
    canonicalReportPage?: number;
    onCanonicalReportPageChange?: (page: number) => void;
    onSelectLeague?: (leagueId: number) => void;
    leagueSheetOpen?: boolean;
    onOpenLeagueSheet?: () => void;
    bowlerLeagues?: Array<{ leagueId: number; active: boolean }>;
  }) => null);
  const navigate = vi.fn();
  const setSelectedLeague = vi.fn();
  let useActualContent = false;
  let useActualBowlerLayout = false;
  const useQuery = vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
    const key = String(queryKey[0]);
    const base = { isLoading: false, error: null, refetch: vi.fn() };
    if (key === "/api/user") {
      return { ...base, data: { success: true, data: { id: 1, bowlerId: 42, name: "Bowler", role: "system_admin" } } };
    }
    if (key.startsWith("/api/bowlers/") && key.endsWith("/details")) {
      return { ...base, data: { success: true, data: {
        bowler: { id: 42, name: "Bowler" },
        bowlerLeagues: [
          { id: 71, bowlerId: 42, leagueId: 17, teamId: 81, active: true, order: 0, joinedAt: "2026-08-01T00:00:00.000Z" },
          { id: 72, bowlerId: 42, leagueId: 18, teamId: 82, active: false, order: 1, joinedAt: "2026-08-01T00:00:00.000Z" },
        ],
        leagues: [{ id: 17, name: "Wednesday League", active: true, weeklyFee: 3000, organizationId: 1, competitionStartTime: null }],
        teams: [{ id: 81, name: "Team 1", number: 1, leagueId: 17, active: true, displayOrder: 0 }],
      } } };
    }
    if (key === "/api/financials/f5/payments") {
      return { ...base, data: { success: true, data: { rows: [], totalTransactions: 0, limit: 200 } } };
    }
    if (key === "/api/financials/leagues") {
      if (queryKey[2] === "rotating-credit/1") {
        return { ...base, data: { success: true, data: { eligibleForCredit: false } } };
      }
      return { ...base, data: { success: true, data: {
        contractVersion: "canonical-due-past-due/2",
        authoritativeSource: "payment_obligations",
        rows: [],
        asOf: "2026-09-30T00:00:00.000Z",
        totals: { collectiblePastDueMinor: 0 },
      } } };
    }
    return base;
  });
  return {
    content,
    navigate,
    setSelectedLeague,
    useQuery,
    setUseActualContent: (value: boolean) => { useActualContent = value; },
    getUseActualContent: () => useActualContent,
    setUseActualBowlerLayout: (value: boolean) => { useActualBowlerLayout = value; },
    getUseActualBowlerLayout: () => useActualBowlerLayout,
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: mocks.useQuery,
}));
vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wouter")>()),
  useLocation: () => ["/payment-history", mocks.navigate],
  useSearch: () => "?leagueId=17",
}));
vi.mock("@/hooks/use-selected-league", () => ({ useSelectedLeague: () => [17, mocks.setSelectedLeague] }));
vi.mock("@/components/bowler-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/bowler-layout")>();
  return {
    BowlerLayout: (props: ComponentProps<typeof actual.BowlerLayout>) => mocks.getUseActualBowlerLayout()
      ? createElement(actual.BowlerLayout, props)
      : createElement("div", null, props.children),
  };
});
vi.mock("@/pages/payment-history-page/payment-history-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pages/payment-history-page/payment-history-content")>();
  return {
    PaymentHistoryContent: (props: ComponentProps<typeof actual.PaymentHistoryContent>) => mocks.getUseActualContent()
      ? createElement(actual.PaymentHistoryContent, props)
      : mocks.content(props),
  };
});

import PaymentHistoryPage from "@/pages/payment-history-page";

describe("PaymentHistoryPage league picker wiring", () => {
  beforeEach(() => {
    mocks.content.mockClear();
    mocks.navigate.mockClear();
    mocks.setSelectedLeague.mockClear();
    mocks.useQuery.mockClear();
  });

  afterEach(() => {
    mocks.setUseActualContent(false);
    mocks.setUseActualBowlerLayout(false);
  });

  it("opens the actual one-row picker from the mobile History header trigger", async () => {
    const user = userEvent.setup();
    mocks.setUseActualContent(true);
    mocks.setUseActualBowlerLayout(true);
    render(<PaymentHistoryPage />);

    await screen.findByRole("heading", { name: "Payment history" });
    const trigger = document.querySelector<HTMLButtonElement>(".familiar-bowler-league-select");
    expect(trigger).not.toBeNull();
    expect(trigger).toBeEnabled();
    if (!trigger) return;

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    const options = screen.getByRole("group", { name: "Available leagues" });
    expect(options.querySelectorAll("button")).toHaveLength(1);
    const option = screen.getByRole("button", { name: "Wednesday League" });
    expect(option).toHaveAttribute("aria-pressed", "true");

    await user.click(option);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(mocks.setSelectedLeague).toHaveBeenCalledWith(17));
    expect(mocks.navigate).toHaveBeenCalledWith("/payment-history?leagueId=17");
  });

  it("keeps History league selection routing and resets report pagination", async () => {
    render(<PaymentHistoryPage />);

    await waitFor(() => expect(mocks.content).toHaveBeenCalled());
    let contentProps = mocks.content.mock.lastCall?.[0];
    expect(contentProps?.canonicalReportPage).toBe(1);
    expect(contentProps?.bowlerLeagues).toEqual([{ id: 71, bowlerId: 42, leagueId: 17, teamId: 81, active: true, order: 0, joinedAt: "2026-08-01T00:00:00.000Z" }]);
    expect(contentProps?.onOpenLeagueSheet).toBeTypeOf("function");
    expect(contentProps && "viewerRole" in contentProps).toBe(false);
    expect(contentProps && "teamMap" in contentProps).toBe(false);

    act(() => { contentProps?.onOpenLeagueSheet?.(); });
    await waitFor(() => expect(mocks.content.mock.lastCall?.[0].leagueSheetOpen).toBe(true));
    expect(mocks.content.mock.lastCall?.[0].bowlerLeagues).toHaveLength(1);

    contentProps = mocks.content.mock.lastCall?.[0];
    act(() => { contentProps?.onCanonicalReportPageChange?.(4); });
    await waitFor(() => expect(mocks.content.mock.lastCall?.[0].canonicalReportPage).toBe(4));

    contentProps = mocks.content.mock.lastCall?.[0];
    act(() => { contentProps?.onSelectLeague?.(18); });
    expect(mocks.setSelectedLeague).toHaveBeenCalledWith(18);
    expect(mocks.navigate).toHaveBeenCalledWith("/payment-history?leagueId=18");
    await waitFor(() => expect(mocks.content.mock.lastCall?.[0].canonicalReportPage).toBe(1));
  });
});
