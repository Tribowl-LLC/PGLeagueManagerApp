import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bowler, BowlerLeague, League, BowlerWithAccount } from "@shared/schema";

const apiRequestMock = vi.hoisted(() => vi.fn());
const queryClientMock = vi.hoisted(() => ({
  invalidateQueries: vi.fn((input: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => { void input; return Promise.resolve(); }),
}));

vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: apiRequestMock,
  queryClient: queryClientMock,
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));

import { TeamViewBowlersTable } from "@/pages/team-view-page/bowlers-table";

const rosterResponse = {
  data: {
    payingLineupSize: 3,
    ready: true,
    lineageFee: null,
    prizeFundFee: null,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    substituteBowlerOptions: [
      { id: 11, name: "Sub One", teamId: 9 },
      { id: 12, name: "Sub Two", teamId: 9 },
    ],
    occurrences: [
      { id: "00000000-0000-0000-0000-000000000001", startAt: "2038-01-03T03:00:00.000Z", status: "scheduled" },
      { id: "00000000-0000-0000-0000-000000000002", startAt: "2038-01-10T03:00:00.000Z", status: "scheduled" },
    ],
    occurrenceResponsibilities: [
      { occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 9, slotIndex: 0, positionIndex: 0, responsibilityKind: "substitute", mainBowlerId: 10, substituteBowlerId: 11, payerBowlerId: 10, policy: "main_pays_full", amountMinor: 2000, lineageAmountMinor: null, prizeFundAmountMinor: null },
      { occurrenceId: "00000000-0000-0000-0000-000000000002", teamId: 9, slotIndex: 1, positionIndex: 1, responsibilityKind: "substitute", mainBowlerId: 13, substituteBowlerId: 12, payerBowlerId: 12, policy: "sub_pays_full", amountMinor: 2000, lineageAmountMinor: null, prizeFundAmountMinor: null },
    ],
    teams: [{ id: 9, policy: "main_pays_full", slots: [
      { id: "slot-1", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 3, slotIndex: 0, occupant: "main", mainBowlerId: 10, currentRevision: 1 },
      { id: "slot-2", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 3, slotIndex: 1, occupant: "main", mainBowlerId: 13, currentRevision: 1 },
      { id: "slot-3", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 3, slotIndex: 2, occupant: "vacant", mainBowlerId: null, currentRevision: 1 },
    ] }],
  },
};

const vacantRosterResponse = {
  data: {
    ...rosterResponse.data,
    payingLineupSize: 4,
    ready: false,
    occurrences: [],
    occurrenceResponsibilities: [],
    teams: [{ id: 9, policy: "main_pays_full", slots: [
      { id: "slot-main-1", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 4, slotIndex: 0, occupant: "main", mainBowlerId: 10, currentRevision: 1 },
      { id: "slot-main-2", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 4, slotIndex: 1, occupant: "main", mainBowlerId: 13, currentRevision: 1 },
      { id: "slot-main-3", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 4, slotIndex: 2, occupant: "main", mainBowlerId: 14, currentRevision: 1 },
      { id: "slot-vacant", organizationId: 1, leagueId: 1, teamId: 9, lineupSize: 4, slotIndex: 3, occupant: "vacant", mainBowlerId: null, currentRevision: 1 },
    ] }],
  },
};

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const league = { id: 1, weeklyFee: 2000, timezone: "America/Los_Angeles" } as League;
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const bowler = (id: number, name: string): BowlerWithAccount => ({ id, name, active: true, hasAccount: true } as BowlerWithAccount);
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const bowlerLeague = (id: number, bowlerId: number): BowlerLeague => ({ id, bowlerId, leagueId: 1, teamId: 9, active: true } as BowlerLeague);

function renderRoster() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => {
    const response = await fetch(String(queryKey[0]));
    return response.json();
  } } } });
  return render(<QueryClientProvider client={queryClient}><TeamViewBowlersTable
    teamBowlers={[{ bowler: bowler(10, "Main One"), bowlerLeague: bowlerLeague(101, 10) }, { bowler: bowler(11, "Sub One"), bowlerLeague: bowlerLeague(102, 11) }, { bowler: bowler(12, "Sub Two"), bowlerLeague: bowlerLeague(103, 12) }, { bowler: bowler(13, "Main Two"), bowlerLeague: bowlerLeague(104, 13) }]}
    league={league}
    teamId={9}
    leagueId={1}
    canManage
  /></QueryClientProvider>);
}

function renderRosterWithThreeMainsAndVacancy() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => {
    const response = await fetch(String(queryKey[0]));
    return response.json();
  } } } });
  return render(<QueryClientProvider client={queryClient}><TeamViewBowlersTable
    teamBowlers={[{ bowler: bowler(10, "Main One"), bowlerLeague: bowlerLeague(101, 10) }, { bowler: bowler(11, "Sub One"), bowlerLeague: bowlerLeague(102, 11) }, { bowler: bowler(12, "Sub Two"), bowlerLeague: bowlerLeague(103, 12) }, { bowler: bowler(13, "Main Two"), bowlerLeague: bowlerLeague(104, 13) }, { bowler: bowler(14, "Main Three"), bowlerLeague: bowlerLeague(105, 14) }, { bowler: bowler(15, "Sub Three"), bowlerLeague: bowlerLeague(106, 15) }]}
    league={{ ...league, payingLineupSize: 4 }}
    teamId={9}
    leagueId={1}
    canManage
  /></QueryClientProvider>);
}

afterEach(() => {
  apiRequestMock.mockReset();
  queryClientMock.invalidateQueries.mockReset();
  vi.unstubAllGlobals();
});

describe("Team Rosters payment responsibility surface", () => {
  it("edits one selected occurrence and hydrates overrides independently by occurrence and slot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rosterResponse), { status: 200, headers: { "content-type": "application/json" } })));
    renderRoster();

    expect(await screen.findByText("Payment override for one occurrence")).toBeInTheDocument();
    expect(screen.getByText("Saved non-default overrides: 2")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Override kind/)).toHaveLength(3);
    expect(screen.getByText("Sub One · $20.00")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Override occurrence"), { target: { value: "00000000-0000-0000-0000-000000000002" } });
    await waitFor(() => expect(screen.getByText("Sub Two · $20.00")).toBeInTheDocument());
    expect(screen.getAllByLabelText(/Override kind/)).toHaveLength(3);
    expect(screen.queryByText("Sub One · $20.00")).not.toBeInTheDocument();
  });

  it("submits only the strict roster slot request fields when read data contains persistence metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rosterResponse), { status: 200, headers: { "content-type": "application/json" } })));
    apiRequestMock.mockResolvedValue(new Response(null, { status: 200 }));
    renderRoster();

    await screen.findByText("Payment override for one occurrence");
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    const [url, method, body] = apiRequestMock.mock.calls[0] as [string, string, { slots: Array<Record<string, unknown>> }];
    expect(url).toBe("/api/financials/leagues/1/roster-payment-responsibility/1/teams/9");
    expect(method).toBe("POST");
    expect(body.slots).toEqual([
      { slotIndex: 0, occupant: "main", mainBowlerId: 10 },
      { slotIndex: 1, occupant: "main", mainBowlerId: 13 },
      { slotIndex: 2, occupant: "vacant", mainBowlerId: null },
    ]);
    const invalidations = queryClientMock.invalidateQueries.mock.calls.map(([input]) => input);
    expect(invalidations).toEqual(expect.arrayContaining([
      expect.objectContaining({ queryKey: ["/api/financials/leagues/1/roster-payment-responsibility/1"] }),
      expect.objectContaining({ queryKey: ["/api/financials/leagues/1/canonical-due-past-due/2"] }),
    ]));
    const organizationDuePredicate = invalidations.find((input) => typeof input.predicate === "function")?.predicate;
    expect(organizationDuePredicate?.({ queryKey: ["/api/financials/due-past-due"] })).toBe(true);
    expect(organizationDuePredicate?.({ queryKey: ["/api/financials/due-past-due?organizationId=77"] })).toBe(true);
    expect(organizationDuePredicate?.({ queryKey: ["/api/other"] })).toBe(false);
  });

  it("renders an existing VACANT slot beside three Main and three Substitute members", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(vacantRosterResponse), { status: 200, headers: { "content-type": "application/json" } })));
    renderRosterWithThreeMainsAndVacancy();

    await screen.findByText("VACANT · no obligation");
    expect(screen.getAllByRole("cell").some((cell) => cell.textContent?.trim() === "VACANT")).toBe(true);
    expect(screen.getByText("VACANT · no obligation")).toBeInTheDocument();
    const memberRoleSelects = screen.getAllByRole("combobox").filter((element) => {
      const label = element.getAttribute("aria-label") ?? "";
      return label.startsWith("Payer role ") && !label.startsWith("Payer role position");
    });
    expect(memberRoleSelects.map((element) => (element as HTMLSelectElement).value).sort()).toEqual([
      "main", "main", "main", "substitute", "substitute", "substitute",
    ]);
  });
});
