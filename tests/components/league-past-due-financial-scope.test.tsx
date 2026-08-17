import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useParams: () => ({ leagueId: "7" }),
}));
vi.mock("@/components/layout", () => ({ Layout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/page-states", () => ({ PageLoadingState: () => <div>loading</div> }));

import LeaguePastDuePage from "@/pages/league-past-due-page";

describe("LeaguePastDuePage financial scope", () => {
  it("uses the selected organization in the system-admin league financial URL and query key", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "/api/user") return new Response(JSON.stringify({ data: { role: "system_admin", organizationId: 77 } }), { status: 200 });
      if (url === "/api/leagues/7") return new Response(JSON.stringify({ data: { id: 7, name: "Scoped League" } }), { status: 200 });
      if (url === "/api/teams" || url === "/api/bowlers" || url === "/api/bowler-leagues?leagueId=7") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ data: { mode: "canonical", rows: [] } }), { status: 200 });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(["/api/user"], { data: { role: "system_admin", organizationId: 77 } });
    queryClient.setQueryData(["/api/leagues/7"], { data: { id: 7, name: "Scoped League" } });
    queryClient.setQueryData(["/api/teams"], { data: [] });
    queryClient.setQueryData(["/api/bowlers"], { data: [] });
    queryClient.setQueryData(["/api/bowler-leagues", 7], { data: [] });

    render(<QueryClientProvider client={queryClient}><LeaguePastDuePage /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText("Scoped League - Past Due Balances")).toBeInTheDocument());
    expect(requestedUrls).toContain("/api/financials/leagues/7/due-past-due?organizationId=77");
    expect(queryClient.getQueryCache().find({ queryKey: ["/api/financials/leagues/7/due-past-due?organizationId=77"] })).toBeDefined();
    vi.unstubAllGlobals();
  });
});
