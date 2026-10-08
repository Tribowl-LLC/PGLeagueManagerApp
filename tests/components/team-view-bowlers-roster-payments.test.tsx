import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bowler, BowlerLeague, League, BowlerWithAccount } from "@shared/schema";

const apiRequestMock = vi.hoisted(() => vi.fn());
const queryClientMock = vi.hoisted(() => ({
  invalidateQueries: vi.fn((input: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => { void input; return Promise.resolve(); }),
}));
const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: apiRequestMock,
  queryClient: queryClientMock,
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

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
      { id: "00000000-0000-4000-8000-000000000001", startAt: "2038-01-03 03:00:00+00", status: "scheduled" },
      { id: "00000000-0000-4000-8000-000000000002", startAt: "2038-01-10T03:00:00.000Z", status: "scheduled" },
    ],
    occurrenceResponsibilities: [
      { occurrenceId: "00000000-0000-4000-8000-000000000001", teamId: 9, slotIndex: 0, positionIndex: 0, responsibilityKind: "substitute", mainBowlerId: 10, substituteBowlerId: 11, payerBowlerId: 10, policy: "main_pays_full", amountMinor: 2000, lineageAmountMinor: null, prizeFundAmountMinor: null },
      { occurrenceId: "00000000-0000-4000-8000-000000000002", teamId: 9, slotIndex: 1, positionIndex: 1, responsibilityKind: "substitute", mainBowlerId: 13, substituteBowlerId: 12, payerBowlerId: 12, policy: "sub_pays_full", amountMinor: 2000, lineageAmountMinor: null, prizeFundAmountMinor: null },
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

const sharedSpotTeam = {
  policy: "main_pays_full" as const,
  eligibleRotatingBowlerIds: [12, 11],
  slots: [
    { teamId: 9, slotIndex: 0, occupant: "main" as const, mainBowlerId: 10, currentRevision: 1 },
    { teamId: 9, slotIndex: 1, occupant: "main" as const, mainBowlerId: 13, currentRevision: 1 },
    { teamId: 9, slotIndex: 2, occupant: "rotating" as const, mainBowlerId: null, currentRevision: 1 },
  ],
};

function renderRoster(
  paymentMode: "fixed" | "rotating" | "unavailable" = "fixed",
  callbacks: { onEditBowler?: (bowler: Bowler) => void; onRemoveBowler?: (target: { bowlerId: number; name: string }) => void } = {},
) {
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
    paymentMode={paymentMode}
    sharedSpotTeam={paymentMode === "rotating" ? sharedSpotTeam : undefined}
    onEditBowler={callbacks.onEditBowler}
    onRemoveBowler={callbacks.onRemoveBowler}
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
  toastMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Team roster", () => {
  const stubRoster = (response: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })));

  it("shows only the roster: no weekly payment override, team policy, or rotating controls", async () => {
    stubRoster(rosterResponse);
    renderRoster("fixed");

    await waitFor(() => expect(screen.getByLabelText("Role Main One")).toHaveValue("regular"));
    expect(screen.getByRole("button", { name: "Save roster" })).toBeInTheDocument();
    expect(screen.queryByText("Payment override for one occurrence")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Team payment policy")).not.toBeInTheDocument();
    expect(screen.queryByText("Rotating team payments")).not.toBeInTheDocument();
    expect(screen.queryByText("Weekly Fee")).not.toBeInTheDocument();
  });

  it("labels members as Regular or Sub by whether they hold a lineup spot", async () => {
    stubRoster(vacantRosterResponse);
    renderRosterWithThreeMainsAndVacancy();

    await waitFor(() => expect(screen.getByLabelText("Lineup spot 4")).toHaveValue("vacant"));
    const roles = screen.getAllByRole("combobox")
      .filter((element) => (element.getAttribute("aria-label") ?? "").startsWith("Role "))
      .map((element) => (element as HTMLSelectElement).value)
      .sort();
    expect(roles).toEqual(["regular", "regular", "regular", "sub", "sub", "sub"]);
  });

  it("submits only the strict roster slot request fields and keeps the saved team policy", async () => {
    stubRoster({ data: { ...rosterResponse.data, teams: [{ ...rosterResponse.data.teams[0], policy: "sub_pays_full" }] } });
    apiRequestMock.mockResolvedValue(new Response(null, { status: 200 }));
    renderRoster();

    await waitFor(() => {
      expect(screen.getByLabelText("Role Main One")).toHaveValue("regular");
      expect(screen.getByLabelText("Role Main Two")).toHaveValue("regular");
      expect(screen.getByLabelText("Lineup spot 3")).toHaveValue("vacant");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    const [url, method, body] = apiRequestMock.mock.calls[0] as [string, string, { policy: string; slots: Array<Record<string, unknown>> }];
    expect(url).toBe("/api/financials/leagues/1/roster-payment-responsibility/1/teams/9");
    expect(method).toBe("POST");
    expect(body.policy).toBe("sub_pays_full");
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

  it("moves a regular to sub and a sub into the freed lineup spot", async () => {
    stubRoster(rosterResponse);
    apiRequestMock.mockResolvedValue(new Response(null, { status: 200 }));
    renderRoster();

    await waitFor(() => expect(screen.getByLabelText("Role Main One")).toHaveValue("regular"));
    fireEvent.change(screen.getByLabelText("Role Main One"), { target: { value: "sub" } });
    fireEvent.change(screen.getByLabelText("Role Sub One"), { target: { value: "regular" } });
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    const body = apiRequestMock.mock.calls[0]?.[2] as { slots: Array<Record<string, unknown>> };
    expect(body.slots).toEqual([
      { slotIndex: 0, occupant: "main", mainBowlerId: 11 },
      { slotIndex: 1, occupant: "main", mainBowlerId: 13 },
      { slotIndex: 2, occupant: "vacant", mainBowlerId: null },
    ]);
  });

  it("keeps a shared spot unchanged while the regular spots stay editable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    apiRequestMock.mockResolvedValue(new Response(null, { status: 200 }));
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    renderRoster("rotating", { onEditBowler: onEdit, onRemoveBowler: onRemove });

    await waitFor(() => expect(screen.getByLabelText("Role Main One")).toHaveValue("regular"));
    expect(screen.getByText("Shared spot")).toBeInTheDocument();
    expect(screen.getByText("Assigned weekly in Manage Payments")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lineup spot 3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Main One" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Main One" }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 10, name: "Main One" }));
    expect(onRemove).toHaveBeenCalledWith({ bowlerId: 10, name: "Main One" });
    expect(fetchMock).not.toHaveBeenCalled();

    // A team with a shared spot has no open spot to promote a sub into.
    fireEvent.change(screen.getByLabelText("Role Sub One"), { target: { value: "regular" } });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "No open lineup spot" }));

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledOnce());
    const [url, , body] = apiRequestMock.mock.calls[0] as [string, string, { requestFingerprint: string; eligibleRotatingBowlerIds: number[]; slots: Array<Record<string, unknown>> }];
    expect(url).toBe("/api/financials/leagues/1/roster-payment-responsibility/2/teams/9");
    expect(body.requestFingerprint).toMatch(/^lvroster:v2:[0-9a-f]{64}$/);
    expect(body.eligibleRotatingBowlerIds).toEqual([11, 12]);
    expect(body.slots).toEqual([
      { slotIndex: 0, occupant: "main", mainBowlerId: 10 },
      { slotIndex: 1, occupant: "main", mainBowlerId: 13 },
      { slotIndex: 2, occupant: "rotating", mainBowlerId: null },
    ]);
  });
});
