import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Team } from "@shared/schema";
import { TeamViewHeader } from "@/pages/team-view-page/header";

const makeTeam = (input: Partial<Team> & Pick<Team, "id" | "name">): Team => {
  const team: Team = {
    id: input.id,
    name: input.name,
    leagueId: input.leagueId ?? 7,
    number: input.number ?? input.id,
    displayOrder: input.displayOrder ?? 0,
    active: input.active ?? true,
  };
  return team;
};

describe("TeamViewHeader team navigation", () => {
  it("moves through the league's persisted team order with boundary arrows", async () => {
    const onTeamChange = vi.fn();
    const teams = [
      makeTeam({ id: 30, name: "Third Team", number: 3, displayOrder: 2 }),
      makeTeam({ id: 20, name: "Second Team", number: 2, displayOrder: 1 }),
      makeTeam({ id: 10, name: "First Team", number: 1, displayOrder: 0 }),
    ];
    const user = userEvent.setup();

    render(
      <TeamViewHeader
        teamName="Second Team"
        leagueId={7}
        teams={teams}
        currentTeamId={20}
        onTeamChange={onTeamChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Previous team: First Team" }));
    await user.click(screen.getByRole("button", { name: "Next team: Third Team" }));

    expect(onTeamChange.mock.calls).toEqual([[10], [30]]);
  });

  it("jumps directly from the dropdown and labels archived teams", async () => {
    const onTeamChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TeamViewHeader
        teamName="First Team"
        leagueId={7}
        teams={[
          makeTeam({ id: 20, name: "Archived Team", number: 2, displayOrder: 1, active: false }),
          makeTeam({ id: 10, name: "First Team", number: 1, displayOrder: 0 }),
        ]}
        currentTeamId={10}
        onTeamChange={onTeamChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Select team" }));
    await user.click(screen.getByRole("option", { name: "#2 - Archived Team (Archived)" }));

    expect(onTeamChange).toHaveBeenCalledWith(20);
    expect(screen.getByRole("button", { name: "No previous team" })).toBeDisabled();
  });
});
