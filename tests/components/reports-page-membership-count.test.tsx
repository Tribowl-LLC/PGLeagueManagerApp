import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({ Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }));
vi.mock("@/components/layout", () => ({ Layout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/page-states", () => ({ PageLoadingState: () => <div>loading</div> }));

import ReportsPage from "@/pages/reports-page";

describe("ReportsPage membership counts", () => {
  it("counts unique active bowlers from active memberships, excluding inactive memberships", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/user") return new Response(JSON.stringify({ data: { role: "org_admin", organizationId: 1 } }), { status: 200 });
      if (url === "/api/leagues") return new Response(JSON.stringify({ data: [{ id: 7, name: "Tuesday League", active: true }] }), { status: 200 });
      if (url === "/api/teams") return new Response(JSON.stringify({ data: [
        { id: 10, leagueId: 7, name: "Lucky Strikes", number: 1, active: true, displayOrder: 0 },
        { id: 20, leagueId: 7, name: "Split Happens", number: 2, active: true, displayOrder: 1 },
      ] }), { status: 200 });
      if (url === "/api/bowlers") return new Response(JSON.stringify({ data: [
        { id: 1, name: "Alex", active: true },
        { id: 2, name: "Casey", active: true },
        { id: 3, name: "Inactive Membership", active: true },
        { id: 4, name: "Inactive Bowler", active: false },
      ] }), { status: 200 });
      if (url === "/api/bowler-leagues") return new Response(JSON.stringify({ data: [
        { id: 1, bowlerId: 1, leagueId: 7, teamId: 10, active: true },
        { id: 2, bowlerId: 1, leagueId: 7, teamId: 20, active: true },
        { id: 3, bowlerId: 2, leagueId: 7, teamId: 10, active: true },
        { id: 4, bowlerId: 3, leagueId: 7, teamId: 10, active: false },
        { id: 5, bowlerId: 4, leagueId: 7, teamId: 10, active: true },
      ] }), { status: 200 });
      if (url.startsWith("/api/financials/f5/payments")) return new Response(JSON.stringify({ data: { totals: { grossConfirmedPaidMinor: 0 } } }), { status: 200 });
      if (url.startsWith("/api/financials/due-past-due")) return new Response(JSON.stringify({ data: { leagues: [{ leagueId: 7, report: { rows: [], totals: {} } }] } }), { status: 200 });
      return new Response(JSON.stringify({ data: {} }), { status: 404 });
    }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: ({ queryKey }) => fetch(String(queryKey[0])).then((response) => response.json()) } } });
    render(<QueryClientProvider client={queryClient}><ReportsPage /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByRole("row", { name: /Tuesday League/ })).toBeInTheDocument());
    const row = screen.getByRole("row", { name: /Tuesday League/ });
    expect(within(row).getAllByRole("cell")[1]).toHaveTextContent("2");
    vi.unstubAllGlobals();
  });
});
