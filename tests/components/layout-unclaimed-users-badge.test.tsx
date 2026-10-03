import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { Layout } from "@/components/layout";

const COUNT_ENDPOINT = "/api/admin/unclaimed-users/count";

vi.mock("@/components/user-profile-menu", () => ({ UserProfileMenu: () => null }));
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }));

beforeEach(() => {
  window.localStorage.removeItem("sidebarCollapsed");
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
  path = "/leagues",
  appearance = "default",
  countResponse = new Response(JSON.stringify({ success: true, data: { count: 7 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
}: {
  role?: string;
  organizationId?: number | null;
  path?: string;
  appearance?: "default" | "weekly-payments";
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

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Router hook={() => [path, vi.fn()]}>
        <Layout appearance={appearance}>Content</Layout>
      </Router>
    </QueryClientProvider>,
  );

  return { ...view, fetchMock };
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

  it("scopes the white active Manage Payments treatment to its route", async () => {
    const user = userEvent.setup();
    const view = renderLayout({ path: "/manage-payments", appearance: "weekly-payments" });

    const activeLink = screen.getByTestId("nav-link-/manage-payments");
    expect(activeLink).toHaveAttribute("aria-current", "page");
    expect(activeLink).toHaveClass("bg-familiar-surface", "text-familiar-navy");
    expect(activeLink.querySelector("svg")).toHaveClass("text-familiar-navy");
    expect(screen.getByTestId("nav-link-/reports")).not.toHaveClass("bg-familiar-surface");
    expect(document.querySelector(".manage-payments-layout-content")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const collapsedLink = screen.getByTestId("nav-link-/manage-payments");
    expect(collapsedLink).toHaveAttribute("aria-label", "Manage Payments");
    expect(collapsedLink).toHaveClass("bg-familiar-surface", "text-familiar-navy");

    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const sheetLinks = await screen.findAllByTestId("nav-link-/manage-payments");
    expect(sheetLinks).toHaveLength(2);
    for (const link of sheetLinks) {
      expect(link).toHaveClass("bg-familiar-surface", "text-familiar-navy");
    }
    expect(screen.getByRole("dialog")).toHaveClass("font-familiar");

    view.unmount();
    renderLayout({ path: "/manage-payments" });
    const defaultAppearanceLink = screen.getByTestId("nav-link-/manage-payments");
    expect(defaultAppearanceLink).toHaveClass("bg-brand-accent-500/10", "text-brand-accent-400");
    expect(defaultAppearanceLink).not.toHaveClass("bg-familiar-surface");
  });
});
