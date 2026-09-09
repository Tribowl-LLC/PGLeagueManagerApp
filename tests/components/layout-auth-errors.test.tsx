import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { Layout } from "@/components/layout";
import { BowlerLayout } from "@/components/bowler-layout";
import { classifyApiError } from "@/lib/api-error";

vi.mock("@/hooks/use-subdomain-org", () => ({ useSubdomainOrg: () => ({ org: null }) }));
vi.mock("@/components/user-profile-menu", () => ({ UserProfileMenu: () => null }));
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["admin", "bowler"])("%s layout organization request", (kind) => {
  it.each([401, 500])("preserves HTTP %s instead of throwing an unclassified error", async (status) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: status === 401 ? "Authentication required" : "Server unavailable" },
    }), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const client = new QueryClient({
      queryCache: new QueryCache({ onError }),
      defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: null }) } },
    });
    client.setQueryData(["/api/user"], { data: { role: "user", organizationId: 7 } });
    render(<QueryClientProvider client={client}><Router hook={() => ["/leagues", vi.fn()]}>
      {kind === "admin" ? <Layout>Content</Layout> : <BowlerLayout bowlerName="Fixture" leagueName="League">Content</BowlerLayout>}
    </Router></QueryClientProvider>);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const error = onError.mock.calls[0][0];
    expect(error).toMatchObject({ status });
    expect(classifyApiError(error)).toBe(status === 401 ? "expected-client" : "retryable-server");
    expect(fetchMock).toHaveBeenCalledWith("/api/organizations/7", expect.objectContaining({ credentials: "include" }));
    client.clear();
  });
});
