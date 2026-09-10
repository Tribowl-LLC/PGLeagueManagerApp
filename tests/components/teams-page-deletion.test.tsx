import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type InvalidationInput = {
  queryKey?: readonly unknown[];
  predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
};

const apiRequestMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ leagueId: "7" }));
const queryClientMock = vi.hoisted(() => ({
  invalidateQueries: vi.fn((input: InvalidationInput) => {
    void input;
    return Promise.resolve();
  }),
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
  useParams: () => route,
}));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: apiRequestMock,
  queryClient: queryClientMock,
}));
vi.mock("@/components/layout", () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/team-form", () => ({ TeamForm: () => null }));
vi.mock("@/components/reorder-teams-dialog", () => ({ ReorderTeamsDialog: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import TeamsPage from "@/pages/teams-page";

const LEAGUE_ID = 7;
const DELETED_TEAM_ID = 42;
const BOWLER_ID = 501;
const ENRICHED_MEMBERSHIP_KEY = `/api/bowler-leagues?leagueId=${LEAGUE_ID}&enriched=true`;
const BOWLER_DETAILS_KEY = `/api/bowlers/${BOWLER_ID}/details`;
const TEAM_DETAILS_KEY = `/api/teams/${DELETED_TEAM_ID}/details`;
const ROSTER_KEY = `/api/financials/leagues/${LEAGUE_ID}/roster-payment-responsibility/1`;
const DUE_KEY = `/api/financials/leagues/${LEAGUE_ID}/canonical-due-past-due/2`;
const SCOPED_DUE_KEY = `${DUE_KEY}?organizationId=1`;

const deletedTeam = {
  id: DELETED_TEAM_ID,
  name: "Thursday Aces",
  number: 1,
  leagueId: LEAGUE_ID,
  active: true,
  displayOrder: 0,
};
const retainedTeam = {
  id: 43,
  name: "Friday Rollers",
  number: 2,
  leagueId: LEAGUE_ID,
  active: true,
  displayOrder: 1,
};
const retainedBowlerDetails = {
  data: {
    bowler: { id: BOWLER_ID, name: "Retained Bowler", active: true },
    leagues: [{ id: 99, name: "Other League" }],
    teams: [{ id: 88, name: "Other League Team" }],
    bowlerLeagues: [{ id: 901, bowlerId: BOWLER_ID, leagueId: 99, teamId: 88, active: true }],
  },
};
const retainedEnrichedMemberships = {
  data: [{
    id: 901,
    bowlerId: BOWLER_ID,
    leagueId: 99,
    teamId: 88,
    active: true,
    bowler: retainedBowlerDetails.data.bowler,
    league: retainedBowlerDetails.data.leagues[0],
    team: retainedBowlerDetails.data.teams[0],
  }],
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async () => ({ data: [] }),
      },
    },
  });
  client.setQueryData(["/api/user"], { data: { role: "org_admin" } });
  client.setQueryData([`/api/leagues/${LEAGUE_ID}`], { data: { id: LEAGUE_ID, name: "Thursday League" } });
  client.setQueryData(["/api/teams", LEAGUE_ID], { data: [deletedTeam, retainedTeam] });
  client.setQueryData([BOWLER_DETAILS_KEY], retainedBowlerDetails);
  client.setQueryData([ENRICHED_MEMBERSHIP_KEY], retainedEnrichedMemberships);

  render(
    <QueryClientProvider client={client}>
      <TeamsPage />
    </QueryClientProvider>,
  );

  return client;
}

async function openDeleteConfirmation() {
  const row = screen.getByRole("row", { name: /Thursday Aces/ });
  const user = userEvent.setup();
  await user.click(within(row).getByRole("button"));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  return screen.findByRole("dialog");
}

function invalidations(): InvalidationInput[] {
  return queryClientMock.invalidateQueries.mock.calls.map(([input]) => input);
}

function invalidatesQuery(queryKey: readonly unknown[]): boolean {
  return invalidations().some((input) => {
    if (input.queryKey) {
      return input.queryKey.length <= queryKey.length
        && input.queryKey.every((part, index) => part === queryKey[index]);
    }
    return input.predicate?.({ queryKey }) === true;
  });
}

afterEach(() => {
  apiRequestMock.mockReset();
  toastMock.mockReset();
  queryClientMock.invalidateQueries.mockReset();
});

describe("TeamsPage team deletion", () => {
  it("confirms that bowler profiles and memberships in other leagues are retained", async () => {
    renderPage();
    await openDeleteConfirmation();

    expect(screen.getByText(/Bowler profiles and their other league memberships are retained/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });

  it("deletes the selected team and invalidates all affected list, roster, membership, bowler, and financial keys", async () => {
    const client = renderPage();
    apiRequestMock.mockResolvedValue({ success: true });

    const dialog = await openDeleteConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(`/api/teams/${DELETED_TEAM_ID}`, "DELETE"));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Team deleted" })));

    const inputs = invalidations();
    expect(invalidatesQuery(["/api/teams", LEAGUE_ID])).toBe(true);
    expect(invalidatesQuery([SCOPED_DUE_KEY])).toBe(true);
    expect(inputs).toEqual(expect.arrayContaining([
      { queryKey: [TEAM_DETAILS_KEY] },
      { queryKey: ["/api/bowlers"] },
      { queryKey: [ROSTER_KEY] },
      { queryKey: [DUE_KEY] },
    ]));

    const membershipPredicate = inputs.find((input) =>
      input.predicate?.({ queryKey: ["/api/bowler-leagues"] })
      && input.predicate({ queryKey: [ENRICHED_MEMBERSHIP_KEY] })
    )?.predicate;
    expect(membershipPredicate).toBeDefined();

    const bowlerDetailsPredicate = inputs.find((input) =>
      input.predicate?.({ queryKey: [BOWLER_DETAILS_KEY] })
    )?.predicate;
    expect(bowlerDetailsPredicate).toBeDefined();
    expect(bowlerDetailsPredicate?.({ queryKey: ["/api/bowlers"] })).toBe(false);

    const structuredAdminFinancialKey = [
      "/api/financials/leagues",
      LEAGUE_ID,
      "canonical-due-past-due/2",
      BOWLER_ID,
      "&organizationId=1",
    ];
    const adminFinancialPredicate = inputs.find((input) =>
      input.predicate?.({ queryKey: structuredAdminFinancialKey })
    )?.predicate;
    expect(adminFinancialPredicate).toBeDefined();

    const organizationDuePredicate = inputs.find((input) =>
      input.predicate?.({ queryKey: ["/api/financials/due-past-due?organizationId=1"] })
    )?.predicate;
    expect(organizationDuePredicate).toBeDefined();

    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Error deleting team" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.getQueryData([BOWLER_DETAILS_KEY])).toEqual(retainedBowlerDetails);
    expect(client.getQueryData([ENRICHED_MEMBERSHIP_KEY])).toEqual(retainedEnrichedMemberships);
  });

  it("does not report success or invalidate caches when DELETE fails", async () => {
    renderPage();
    apiRequestMock.mockRejectedValue(new Error("delete rejected"));

    const dialog = await openDeleteConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(`/api/teams/${DELETED_TEAM_ID}`, "DELETE"));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({
      title: "Error deleting team",
      description: "delete rejected",
      variant: "destructive",
    }));

    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Team deleted" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
