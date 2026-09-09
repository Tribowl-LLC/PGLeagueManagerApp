import type { PropsWithChildren } from "react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { League } from "@shared/schema";

vi.mock("@/components/layout", () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/league-form", () => ({ LeagueForm: () => null }));
vi.mock("@/components/league-square-missing-banner", () => ({ LeagueSquareMissingBanner: () => null }));
vi.mock("@/components/confirm-archive-dialog", () => ({ ConfirmArchiveDialog: () => null }));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));
vi.mock("@/components/leagues-table", () => ({ LeaguesTable: () => <div>League management remains available</div> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import LeaguesPage from "@/pages/leagues-page";
import { classifyApiError } from "@/lib/api-error";

const league = {
  id: 42,
  name: "Canonical league",
  description: null,
  active: true,
  allowPublicSignup: false,
  seasonStart: "2031-01-05T00:00:00.000Z",
  seasonEnd: "2031-03-23T00:00:00.000Z",
  weekDay: "Sunday",
  weeklyFee: 2_000,
  lineageFee: null,
  prizeFundFee: null,
  practiceStartTime: null,
  competitionStartTime: "19:00",
  squareLineageItemId: null,
  lineageItemVariationId: null,
  squareLineageItemName: null,
  squarePrizeFundItemId: null,
  prizeFundItemVariationId: null,
  squarePrizeFundItemName: null,
  squareCategoryId: null,
  timezone: "America/New_York",
  paymentMode: "weekly",
  seasonNumber: 1,
  previousSeasonId: null,
  organizationId: 7,
  locationId: null,
  totalBowlingWeeks: 12,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
} satisfies League;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LeaguesPage recent-score failure state", () => {
  it("surfaces a rejected canonical score read, keeps league management usable, and retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          error: {
            code: "CANONICAL_GAMES_SCORES_INCOMPATIBLE",
            message: "Canonical game or score evidence is incompatible and cannot be used safely",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            contractVersion: "canonical-games-scores/2",
            orderingVersion: "canonical-games-scores-order/1",
            organizationId: 7,
            leagueId: 42,
            authoritativeSource: "canonical",
            selection: {
              kind: "latest_scored_session",
              identitySource: null,
              occurrenceId: null,
            },
            scores: [],
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: ({ queryKey }) => {
            if (queryKey[0] === "/api/leagues") return Promise.resolve({ data: [league] });
            if (queryKey[0] === "/api/teams") return Promise.resolve({ data: [] });
            if (queryKey[0] === "/api/locations") return Promise.resolve({ data: [] });
            if (queryKey[0] === "/api/user") return Promise.resolve({ success: true, data: null });
            throw new Error(`Unexpected query: ${String(queryKey[0])}`);
          },
        },
        mutations: { retry: false },
      },
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={client}>
        <LeaguesPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Recent scores could not be loaded safely/i)).toHaveTextContent(
      "Canonical game or score evidence is incompatible and cannot be used safely",
    );
    expect(screen.getByText("League management remains available")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scores?leagueId=42&selection=latest_scored_session&organizationId=7",
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Recent scores could not be loaded safely/i)).not.toBeInTheDocument());
  });

  it.each([401, 500])("preserves HTTP %s for authentication and server-error classification", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR", message: status === 401 ? "Authentication required" : "Server unavailable" },
    }), { status, headers: { "content-type": "application/json" } })));
    const onError = vi.fn();
    const client = new QueryClient({
      queryCache: new QueryCache({ onError }),
      defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } },
    });
    client.setQueryData(["/api/leagues"], { data: [league] });
    client.setQueryData(["/api/teams"], { data: [] });
    client.setQueryData(["/api/user"], { data: null });
    render(<QueryClientProvider client={client}><LeaguesPage /></QueryClientProvider>);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const error = onError.mock.calls[0][0];
    expect(error).toMatchObject({ status });
    expect(classifyApiError(error)).toBe(status === 401 ? "expected-client" : "retryable-server");
    expect(await screen.findByText(/Recent scores could not be loaded safely/i)).toHaveTextContent(
      status === 401 ? "Authentication required" : "Server unavailable",
    );
    client.clear();
  });
});
