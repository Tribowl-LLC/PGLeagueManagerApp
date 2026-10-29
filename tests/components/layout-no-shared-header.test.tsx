import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { Layout } from "@/components/layout";

vi.mock("@/hooks/use-business-context", () => ({ useBusinessContext: () => ({ business: null }) }));
vi.mock("@/components/user-profile-menu", () => ({ UserProfileMenu: () => null }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }))));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["/", "/leagues/4", "/reports/past-due"])("admin layout at %s", (path) => {
  it("renders no shared header, breadcrumbs, or search", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["/api/user"], { data: { role: "org_admin", organizationId: 7 } });
    const { container } = render(<QueryClientProvider client={client}><Router hook={() => [path, vi.fn()]}>
      <Layout>Content</Layout>
    </Router></QueryClientProvider>);

    expect(container.querySelector("header")).toBeNull();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation menu" })).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
    client.clear();
  });
});
