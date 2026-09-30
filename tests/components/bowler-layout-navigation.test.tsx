import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { BowlerLayout } from "@/components/bowler-layout";

vi.mock("@/hooks/use-business-context", () => ({ useBusinessContext: () => ({ business: null }) }));

function renderLayout(path = "/make-payment?leagueId=17", onOpenLeagueSheet?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ success: true, data: { role: "user", organizationId: 1 } }) } } });
  queryClient.setQueryData(["/api/user"], { success: true, data: { role: "user", organizationId: 1 } });
  return render(<QueryClientProvider client={queryClient}><Router hook={() => [path, vi.fn()]}><BowlerLayout bowlerName="Bowler" leagueName="League" currentLeagueId={17} onOpenLeagueSheet={onOpenLeagueSheet}><div>Content</div></BowlerLayout></Router></QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

describe("BowlerLayout payment navigation", () => {
  it("keeps both league picker triggers enabled when there is only one active league", async () => {
    const user = userEvent.setup();
    const openLeagueSheet = vi.fn();
    renderLayout("/make-payment?leagueId=17", openLeagueSheet);

    const mobileTrigger = screen.getByRole("button", { name: "League" });
    const desktopTrigger = screen.getByRole("button", { name: "Switch league" });
    expect(mobileTrigger).toBeEnabled();
    expect(desktopTrigger).toBeEnabled();

    await user.click(mobileTrigger);
    await user.click(desktopTrigger);
    expect(openLeagueSheet).toHaveBeenCalledTimes(2);
  });

  it("renders four equal navigation items with deterministic league links and active state", () => {
    renderLayout();
    const navigations = screen.getAllByRole("navigation", { name: "Bowler navigation" });
    expect(navigations).toHaveLength(2);

    const desktopNavigation = navigations.find((navigation) => navigation.classList.contains("familiar-bowler-desktop-nav"));
    const mobileNavigation = navigations.find((navigation) => navigation.classList.contains("familiar-bowler-mobile-nav"));
    expect(desktopNavigation).toBeDefined();
    expect(mobileNavigation).toBeDefined();
    if (!desktopNavigation || !mobileNavigation) return;

    const desktopLinks = within(desktopNavigation);
    const mobileLinks = within(mobileNavigation);
    expect(mobileNavigation.firstElementChild).toHaveClass("grid-cols-4");

    expect(mobileLinks.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/bowler-dashboard");
    expect(mobileLinks.getByRole("link", { name: "Make Payment" })).toHaveAttribute("href", "/make-payment?leagueId=17");
    expect(mobileLinks.getByRole("link", { name: "Payment History" })).toHaveAttribute("href", "/payment-history?leagueId=17");
    expect(mobileLinks.getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/profile");
    expect(mobileLinks.getByRole("link", { name: "Make Payment" })).toHaveAttribute("aria-current", "page");
    expect(mobileLinks.getByRole("link", { name: "Payment History" })).not.toHaveAttribute("aria-current", "page");

    expect(desktopLinks.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/bowler-dashboard");
    expect(desktopLinks.getByRole("link", { name: "Pay" })).toHaveAttribute("href", "/make-payment?leagueId=17");
    expect(desktopLinks.getByRole("link", { name: "History" })).toHaveAttribute("href", "/payment-history?leagueId=17");
    expect(desktopLinks.getByRole("link", { name: "Pay" })).toHaveAttribute("aria-current", "page");
    expect(desktopLinks.getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current", "page");
    expect(desktopLinks.getByRole("link", { name: "Profile for Bowler" })).toHaveAttribute("href", "/profile");
    expect(desktopLinks.getByRole("link", { name: "Profile for Bowler" })).not.toHaveAttribute("aria-current", "page");
  });
});
