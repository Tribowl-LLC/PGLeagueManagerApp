import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeagueActionCards } from "@/pages/league-view-page/league-action-cards";

describe("LeagueActionCards", () => {
  it("puts the user-facing schedule behind a league navigation card", () => {
    render(<LeagueActionCards leagueId={19073} canManageRoster />);

    expect(screen.getByRole("link", { name: /League Schedule/i })).toHaveAttribute(
      "href",
      "/leagues/19073/schedule",
    );
    expect(screen.getByText("View and manage league dates")).toBeVisible();
    expect(screen.queryByText(/canonical/i)).not.toBeInTheDocument();
  });

  it("describes the schedule as read-only for ordinary league members", () => {
    render(<LeagueActionCards leagueId={7} canManageRoster={false} />);
    expect(screen.getByText("View league dates")).toBeVisible();
  });
});
