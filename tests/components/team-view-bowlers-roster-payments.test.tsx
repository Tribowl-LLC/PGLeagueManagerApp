import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bowler, BowlerLeague, League, BowlerWithAccount } from "@shared/schema";

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
      { slotIndex: 0, occupant: "main", mainBowlerId: 10 },
      { slotIndex: 1, occupant: "main", mainBowlerId: 13 },
      { slotIndex: 2, occupant: "vacant", mainBowlerId: null },
    ] }],
  },
};

// The component only reads these fields; the complete persistence rows are
// intentionally not duplicated in a UI fixture.
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

afterEach(() => vi.unstubAllGlobals());

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
});
