import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { BowlerLayout } from "@/components/bowler-layout";

vi.mock("@/hooks/use-subdomain-org", () => ({ useSubdomainOrg: () => ({ org: null }) }));

function renderLayout(path = "/make-payment?leagueId=17") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ success: true, data: { role: "user", organizationId: 1 } }) } } });
  queryClient.setQueryData(["/api/user"], { success: true, data: { role: "user", organizationId: 1 } });
  return render(<QueryClientProvider client={queryClient}><Router hook={() => [path, vi.fn()]}><BowlerLayout bowlerName="Bowler" leagueName="League" currentLeagueId={17}><div>Content</div></BowlerLayout></Router></QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

describe("BowlerLayout payment navigation", () => {
  it("renders four equal navigation items with deterministic league links and active state", () => {
    renderLayout();
    expect(screen.getByRole("navigation").firstElementChild).toHaveClass("grid-cols-4");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/bowler-dashboard");
    expect(screen.getByRole("link", { name: "Make Payment" })).toHaveAttribute("href", "/make-payment?leagueId=17");
    expect(screen.getByRole("link", { name: "Payment History" })).toHaveAttribute("href", "/payment-history?leagueId=17");
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("link", { name: "Make Payment" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Payment History" })).not.toHaveAttribute("aria-current", "page");
  });
});
