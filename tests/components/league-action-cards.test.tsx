import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeagueActionCards } from "@/pages/league-view-page/league-action-cards";

describe("LeagueActionCards", () => {
  it("puts the user-facing schedule behind a league navigation card", () => {
    render(<LeagueActionCards leagueId={19073} canManageRoster canManagePayments />);

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      expect.stringContaining("Roster Management"),
      expect.stringContaining("Manage Payments"),
      expect.stringContaining("Payment Records"),
      expect.stringContaining("League Schedule"),
    ]);
    expect(screen.getByRole("link", { name: /Manage Payments/i })).toHaveAttribute(
      "href",
      "/leagues/19073/payments/manage",
    );
    expect(screen.getByRole("link", { name: /League Schedule/i })).toHaveAttribute(
      "href",
      "/leagues/19073/schedule",
    );
    expect(screen.getByText("View and manage league dates")).toBeVisible();
    expect(screen.queryByText(/canonical/i)).not.toBeInTheDocument();
  });

  it("describes the schedule as read-only for ordinary league members", () => {
    render(<LeagueActionCards leagueId={7} canManageRoster={false} canManagePayments={false} />);
    expect(screen.getByText("View league dates")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Manage Payments/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Payment Records/i })).not.toBeInTheDocument();
  });

  it("does not expose payment cards when payment management is denied", () => {
    render(<LeagueActionCards leagueId={7} canManageRoster canManagePayments={false} />);

    expect(screen.getByRole("link", { name: /Roster Management/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Manage Payments/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Payment Records/i })).not.toBeInTheDocument();
  });
});
