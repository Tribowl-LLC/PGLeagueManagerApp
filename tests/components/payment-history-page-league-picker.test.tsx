import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const content = vi.fn((_props: { viewerRole?: string }) => null);
  const navigate = vi.fn();
  const setSelectedLeague = vi.fn();
  const useQuery = vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
    const key = String(queryKey[0]);
    const base = { isLoading: false, error: null, refetch: vi.fn() };
    if (key === "/api/user") {
      return { ...base, data: { success: true, data: { id: 1, bowlerId: 42, name: "Bowler", role: "system_admin" } } };
    }
    if (key.startsWith("/api/bowlers/") && key.endsWith("/details")) {
      return { ...base, data: { success: true, data: {
        bowler: { id: 42, name: "Bowler" },
        bowlerLeagues: [{ id: 71, bowlerId: 42, leagueId: 17, teamId: 81, active: true, order: 0, joinedAt: "2026-08-01T00:00:00.000Z" }],
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
  return { content, navigate, setSelectedLeague, useQuery };
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
vi.mock("@/pages/payment-history-page/payment-history-content", () => ({ PaymentHistoryContent: mocks.content }));

import PaymentHistoryPage from "@/pages/payment-history-page";

describe("PaymentHistoryPage league picker wiring", () => {
  beforeEach(() => {
    mocks.content.mockClear();
    mocks.navigate.mockClear();
    mocks.useQuery.mockClear();
  });

  it("forwards the signed-in user's role to the shared picker content", async () => {
    render(<PaymentHistoryPage />);

    await waitFor(() => expect(mocks.content).toHaveBeenCalled());
    expect(mocks.content.mock.lastCall?.[0].viewerRole).toBe("system_admin");
  });
});
