import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const apiRequestMock = vi.hoisted(() => vi.fn());
const queryClientMock = vi.hoisted(() => ({
  invalidateQueries: vi.fn((input: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => { void input; return Promise.resolve(); }),
}));

vi.mock("wouter", () => ({ useParams: () => ({ teamId: "5" }) }));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: apiRequestMock,
  queryClient: queryClientMock,
}));
vi.mock("@/components/layout", () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/page-states", () => ({ PageLoadingState: () => <div>loading</div>, PageErrorState: () => <div>error</div> }));
vi.mock("@/components/bowler-form", () => ({ BowlerForm: () => null }));
vi.mock("@/components/assign-bowler-form", () => ({ AssignBowlerForm: () => null }));
vi.mock("@/components/reorder-bowlers-dialog", () => ({ ReorderBowlersDialog: () => null }));
vi.mock("@/pages/team-view-page/header", () => ({ TeamViewHeader: () => null }));
vi.mock("@/pages/team-view-page/edit-dialog", () => ({ TeamViewEditDialog: () => null }));
vi.mock("@/pages/team-view-page/remove-bowler-dialog", () => ({
  TeamViewRemoveBowlerDialog: ({ target, onConfirm }: { target: { name: string } | null; onConfirm: () => void }) => target ? <button onClick={onConfirm}>Confirm remove {target.name}</button> : null,
}));
vi.mock("@/pages/team-view-page/bowlers-table", () => ({
  TeamViewBowlersTable: ({ onRemoveBowler }: { onRemoveBowler?: (target: { bowlerId: number; name: string }) => void }) => <button onClick={() => onRemoveBowler?.({ bowlerId: 11, name: "Removed Bowler" })}>Remove bowler</button>,
}));

import TeamViewPage from "@/pages/team-view-page";

describe("TeamViewPage bowler removal", () => {
  it("invalidates refreshed team, membership, roster, and due-past-due data", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: ({ queryKey }) => Promise.resolve(client.getQueryData(queryKey) ?? {}) } } });
    client.setQueryData(["/api/user"], { data: { role: "org_admin", organizationId: 1 } });
    client.setQueryData(["/api/teams/5/details"], { data: {
      team: { id: 5, leagueId: 7, name: "Team Five" },
      league: { id: 7, name: "Tuesday League", weeklyFee: 2_000, timezone: "UTC" },
      bowlers: [{ id: 11, name: "Removed Bowler", active: true }],
      bowlerLeagues: [{ id: 101, bowlerId: 11, leagueId: 7, teamId: 5, active: true }],
    } });
    apiRequestMock.mockResolvedValue({ success: true });

    render(<QueryClientProvider client={client}><TeamViewPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Remove bowler" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove Removed Bowler" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith("/api/bowler-leagues/101", "DELETE"));
    const keys = queryClientMock.invalidateQueries.mock.calls.map((call) => call[0].queryKey);
    expect(keys).toEqual(expect.arrayContaining([
      ["/api/teams/5/details"],
      ["/api/bowler-leagues"],
      ["/api/financials/leagues/7/roster-payment-responsibility/1"],
      ["/api/financials/leagues/7/canonical-due-past-due/2"],
    ]));
    const organizationDuePredicate = queryClientMock.invalidateQueries.mock.calls
      .map(([input]) => input)
      .find((input) => typeof input.predicate === "function")?.predicate;
    expect(organizationDuePredicate?.({ queryKey: ["/api/financials/due-past-due"] })).toBe(true);
    expect(organizationDuePredicate?.({ queryKey: ["/api/financials/due-past-due?organizationId=77"] })).toBe(true);
    expect(organizationDuePredicate?.({ queryKey: ["/api/financials/not-due-past-due"] })).toBe(false);
  });
});
