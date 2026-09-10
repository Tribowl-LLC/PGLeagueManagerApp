import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalSeasonProgress } from "@/components/canonical-season-progress";
import { LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION } from "@shared/league-occurrence-schedule";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", () => ({ apiRequest: request }));
function occurrence(localDate: string, startAt: string, options: Record<string, unknown> = {}) {
  return {
    occurrenceId: `occurrence-${localDate}-${startAt}`,
    authoritativeLocalDate: localDate,
    timezone: "America/New_York",
    startAt,
    status: "scheduled",
    ...options,
  };
}
const rows = [
  occurrence("2026-11-01", "2026-11-01T05:30:00Z", {
    status: "completed",
    collectionGroups: [{ kind: "double_pay" }],
  }),
  occurrence("2026-11-01", "2026-11-01T06:30:00Z", { kind: "makeup" }),
  occurrence("2026-10-01", "2026-10-01T00:00:00Z", { status: "cancelled" }),
];
function mount(role = "user", organizationId: number | null = 3, allowRetry = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><CanonicalSeasonProgress leagueId={7} organizationId={organizationId} viewerRole={role} allowRetry={allowRetry} /></QueryClientProvider>);
}
afterEach(() => vi.restoreAllMocks());
describe("Canonical season progress", () => {
  it.each([
    ["2026-11-02T03:59:59Z", "0 of 2 weeks completed"],
    ["2026-11-02T04:00:00Z", "2 of 2 weeks completed"],
  ])("uses the 11pm canonical local cutoff at %s", async (now, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
    request.mockResolvedValue({ data: { contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION, authoritativeSource: "canonical", occurrences: rows, skippedDates: [{ localDate: "2026-10-08" }] } });
    mount();
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
  it("uses the canonical date and timezone rather than the browser timezone for reschedules", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-13T05:59:59Z"));
    request.mockResolvedValue({ data: {
      contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
      authoritativeSource: "canonical",
      occurrences: [occurrence("2026-07-12", "2026-07-10T02:00:00Z", { timezone: "America/Los_Angeles" })],
      skippedDates: [{ localDate: "2026-07-05", timezone: "America/Los_Angeles" }],
    } });
    mount();
    expect(await screen.findByText("0 of 1 weeks completed")).toBeInTheDocument();
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-13T06:00:00Z"));
    mount();
    expect(await screen.findByText("1 of 1 weeks completed")).toBeInTheDocument();
  });
  it.each([
    ["2026-01-11", "2026-01-12T04:00:00Z"],
    ["2026-07-12", "2026-07-13T03:00:00Z"],
  ])("resolves the 11pm cutoff across DST for %s", async (localDate, cutoff) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(cutoff));
    request.mockResolvedValue({ data: {
      contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
      authoritativeSource: "canonical",
      occurrences: [occurrence(localDate, `${localDate}T18:00:00Z`)],
      skippedDates: [],
    } });
    mount();
    expect(await screen.findByText("1 of 1 weeks completed")).toBeInTheDocument();
  });
  it.each([
    ["not-a-date", "America/New_York"],
    ["2026-11-01", "Mars/Olympus"],
    ["2026-11-01", ""],
  ])("fails closed for an invalid canonical date or timezone (%s, %s)", async (localDate, timezone) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-02T04:00:00Z"));
    request.mockResolvedValue({ data: {
      contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
      authoritativeSource: "canonical",
      occurrences: [occurrence(localDate, "2026-11-01T23:00:00Z", { timezone })],
      skippedDates: [],
    } });
    mount();
    expect(await screen.findByText("Schedule unavailable")).toBeInTheDocument();
  });
  it("passes explicit organization scope for system administrators", async () => {
    request.mockResolvedValue({ data: { contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION, authoritativeSource: "canonical", occurrences: [] } });
    mount("system_admin");
    expect(await screen.findByText("0 of 0 weeks completed")).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("/api/leagues/7/occurrence-schedule?organizationId=3", "GET");
  });
  it("shows unavailable on incompatible evidence without inventing a 30-week season", async () => {
    request.mockRejectedValue(new Error("409 incompatible schedule"));
    mount();
    expect(await screen.findByText("Schedule unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
  it("does not request an unscoped system-administrator schedule", () => {
    request.mockClear();
    mount("system_admin", null);
    expect(screen.getByText("Schedule unavailable")).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a retired response version", async () => {
    request.mockResolvedValue({ data: { contractVersion: "league-occurrence-schedule/1", authoritativeSource: "canonical", occurrences: rows } });
    mount();
    expect(await screen.findByText("Schedule unavailable")).toBeInTheDocument();
  });
  it("does not embed a retry button inside a league-switcher button", async () => {
    request.mockRejectedValue(new Error("Unavailable"));
    mount("user", 3, false);
    expect(await screen.findByText("Schedule unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
