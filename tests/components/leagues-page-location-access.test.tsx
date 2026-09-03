import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/layout", () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/league-form", () => ({ LeagueForm: () => null }));
vi.mock("@/components/league-square-missing-banner", () => ({ LeagueSquareMissingBanner: () => null }));
vi.mock("@/components/confirm-archive-dialog", () => ({ ConfirmArchiveDialog: () => null }));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));
vi.mock("@/components/leagues-table", () => ({ LeaguesTable: () => <div>Leagues loaded</div> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import LeaguesPage from "@/pages/leagues-page";

function renderForRole(role: "user" | "org_admin") {
  const queryFn = vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "/api/user") {
      return Promise.resolve({ success: true, data: { id: 1, role, organizationId: 7 } });
    }
    if (queryKey[0] === "/api/leagues") return Promise.resolve({ data: [] });
    if (queryKey[0] === "/api/teams") return Promise.resolve({ data: [] });
    if (queryKey[0] === "/api/locations") return Promise.resolve({ data: [] });
    throw new Error(`Unexpected query: ${String(queryKey[0])}`);
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, queryFn },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={client}>
      <LeaguesPage />
    </QueryClientProvider>,
  );

  return queryFn;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LeaguesPage location authorization", () => {
  it("does not request admin-only locations for an ordinary organization member", async () => {
    const queryFn = renderForRole("user");

    expect(await screen.findByText("Leagues loaded")).toBeInTheDocument();
    await waitFor(() => expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["/api/user"] })));

    expect(queryFn).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["/api/locations"] }));
  });

  it("requests locations for an organization administrator", async () => {
    const queryFn = renderForRole("org_admin");

    expect(await screen.findByText("Leagues loaded")).toBeInTheDocument();
    await waitFor(() => expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["/api/locations"] })));
  });
});
