import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { Router } from "wouter";
import { Layout } from "@/components/layout";

const COUNT_ENDPOINT = "/api/admin/unclaimed-users/count";

vi.mock("@/components/user-profile-menu", () => ({ UserProfileMenu: () => null }));
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLayout({
  role = "org_admin",
  organizationId = 7,
  countResponse = new Response(JSON.stringify({ success: true, data: { count: 7 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
}: {
  role?: string;
  organizationId?: number | null;
  countResponse?: Response;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const response = await fetch(String(queryKey[0]));
          if (!response.ok) throw new Error(`Request failed: ${response.status}`);
          return response.json();
        },
      },
    },
  });
  queryClient.setQueryData(["/api/user"], {
    success: true,
    data: { id: 1, role, organizationId },
  });
  queryClient.setQueryData(["/api/organizations", organizationId], {
    success: true,
    data: { id: organizationId, name: "Fixture Organization" },
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === COUNT_ENDPOINT) return countResponse;
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/leagues", vi.fn()]}>
        <Layout>Content</Layout>
      </Router>
    </QueryClientProvider>,
  );

  return { fetchMock };
}

describe("Layout unclaimed-users navigation badge", () => {
  it("fetches the tenant count and renders it through the shared NavBadge", async () => {
    const { fetchMock } = renderLayout();

    const link = screen.getByTestId("nav-link-/admin/unclaimed-users");
    expect(link).toBeInTheDocument();

    await waitFor(() => {
      expect(within(link).getByTestId("nav-badge")).toHaveTextContent("7");
    });
    expect(fetchMock).toHaveBeenCalledWith(COUNT_ENDPOINT);
  });

  it("keeps the navigation link usable while the count request fails", async () => {
    const { fetchMock } = renderLayout({
      countResponse: new Response(JSON.stringify({ success: false }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    });

    const link = screen.getByTestId("nav-link-/admin/unclaimed-users");
    expect(link).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(COUNT_ENDPOINT));
    expect(within(link).queryByTestId("nav-badge")).not.toBeInTheDocument();
  });
});
