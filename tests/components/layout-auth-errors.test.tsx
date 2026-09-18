import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { Layout } from "@/components/layout";
import { BowlerLayout } from "@/components/bowler-layout";

vi.mock("@/hooks/use-business-context", () => ({ useBusinessContext: () => ({ business: null }) }));
vi.mock("@/components/user-profile-menu", () => ({ UserProfileMenu: () => null }));
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["admin", "bowler"])("%s layout branding context", (kind) => {
  it("does not request the retired organization-management endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
        },
      },
    });
    client.setQueryData(["/api/user"], { data: { role: "user", organizationId: 7 } });
    render(<QueryClientProvider client={client}><Router hook={() => ["/leagues", vi.fn()]}>
      {kind === "admin" ? <Layout>Content</Layout> : <BowlerLayout bowlerName="Fixture" leagueName="League">Content</BowlerLayout>}
    </Router></QueryClientProvider>);
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/organizations(?:\/|$)/),
      expect.anything(),
    ));
    client.clear();
  });
});
