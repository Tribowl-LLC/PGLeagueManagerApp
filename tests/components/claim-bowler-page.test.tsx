import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest, navigate, toast } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/claim-bowler", navigate],
    useSearch: () => "",
  };
});
vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("../../client/src/lib/queryClient")>(
    "../../client/src/lib/queryClient",
  );
  return { ...actual, apiRequest };
});

import ClaimBowlerPage from "@/pages/claim-bowler-page";

const originalFetch = global.fetch;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ClaimBowlerPage />
    </QueryClientProvider>,
  );
}

const candidateGroups = [{
  league: { id: 1, name: "Monday League" },
  teams: [{
    team: { id: 2, name: "Team A", number: 1 },
    bowlers: [{ id: 42, name: "Pat Bowler" }],
  }],
}];

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ success: true, data: {} });
  navigate.mockClear();
  toast.mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("ClaimBowlerPage registration states", () => {
  it("routes an empty candidate list to the administrator waiting state", async () => {
    global.fetch = async () => response([]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /wait for administrator setup/i }));
    expect(navigate).toHaveBeenCalledWith("/registration-complete");
    expect(screen.queryByText(/continue to dashboard/i)).not.toBeInTheDocument();
  });

  it("keeps a roster read failure actionable", async () => {
    global.fetch = async () => response({}, 503);
    renderPage();

    expect(await screen.findByText(/couldn.t load your roster/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a claim conflict as an actionable error", async () => {
    global.fetch = async () => response(candidateGroups);
    apiRequest.mockRejectedValue(new Error("This bowler is already linked to another account"));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /pat bowler/i }));
    await user.click(screen.getByRole("button", { name: /yes, that.s me/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: "destructive",
      description: expect.stringContaining("already linked"),
    })));
    expect(navigate).not.toHaveBeenCalledWith("/bowler-dashboard");
  });

  it("claims a safely returned matching candidate", async () => {
    global.fetch = async () => response(candidateGroups);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /pat bowler/i }));
    await user.click(screen.getByRole("button", { name: /yes, that.s me/i }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "/api/auth/claim-bowler",
      "POST",
      { bowlerId: 42 },
    ));
    expect(navigate).toHaveBeenCalledWith("/bowler-dashboard");
  });
});
