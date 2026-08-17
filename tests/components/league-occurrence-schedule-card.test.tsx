import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeagueOccurrenceScheduleReadContract } from "@shared/league-occurrence-schedule";
import * as queryModule from "@/lib/queryClient";

vi.mock("@/pages/league-view-page/fall-draft-generation-card", () => ({
  FallCanonicalRecoveryPanel: () => <div>Contextual Fall recovery</div>,
}));
vi.mock("@/pages/league-view-page/fall-draft-review-panel", () => ({
  FallDraftReviewPanel: ({ basePath, contractFamily }: { basePath: string; contractFamily: string }) => (
    <div data-testid="draft-review-panel" data-base-path={basePath} data-contract-family={contractFamily}>
      Audited C2 controls
    </div>
  ),
}));

import { LeagueOccurrenceScheduleCard } from "@/pages/league-view-page/league-occurrence-schedule-card";

const canonical: LeagueOccurrenceScheduleReadContract = {
  contractVersion: "league-occurrence-schedule/1",
  ordering: {
    version: "league-occurrence-schedule-order/1",
    keys: ["authoritativeLocalDate", "authoritativeLocalStartTime", "plannedOrdinal", "competitionNumber", "kind", "stableIdentity"],
  },
  organizationId: 3,
  leagueId: 7,
  authoritativeSource: "canonical",
  operationalCanonicalStateExists: true,
  occurrences: [
    {
      occurrenceId: "20000000-0000-4000-8000-000000000001",
      legacyProjectionKey: null,
      identitySource: "canonical_uuid",
      kind: "regular",
      status: "cancelled",
      lifecycle: "published",
      authoritativeLocalDate: "2032-11-07",
      authoritativeLocalStartTime: "19:00:00",
      timezone: "America/Detroit",
      startAt: "2032-11-08T00:00:00.000Z",
      selectedUtcOffsetMinutes: -300,
      foldResolution: "later",
      resolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
      plannedOrdinal: 4,
      competitionNumber: 9,
      competitive: false,
      countsInStandings: false,
      currentRevision: 3,
      effectivelyLocked: false,
      effectiveLockReasons: [],
      billing: { purpose: "league_weekly_fee", obligationPolicy: "none", billingOrdinal: 12, version: 2, currentRevision: 2 },
      relationships: [],
    },
    {
      occurrenceId: "20000000-0000-4000-8000-000000000002",
      legacyProjectionKey: null,
      identitySource: "canonical_uuid",
      kind: "makeup",
      status: "completed",
      lifecycle: "locked",
      authoritativeLocalDate: "2032-11-14",
      authoritativeLocalStartTime: "18:30:00",
      timezone: "America/Detroit",
      startAt: "2032-11-14T23:30:00.000Z",
      selectedUtcOffsetMinutes: -300,
      foldResolution: "unambiguous",
      resolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
      plannedOrdinal: 5,
      competitionNumber: 10,
      competitive: true,
      countsInStandings: true,
      currentRevision: 4,
      effectivelyLocked: true,
      effectiveLockReasons: ["canonical_lock"],
      billing: null,
      relationships: [{ relationshipId: "60000000-0000-4000-8000-000000000001", kind: "makeup_for", role: "source", relatedOccurrenceId: "20000000-0000-4000-8000-000000000001", currentRevision: 1 }],
    },
  ],
  skippedDates: [{
    exceptionId: "50000000-0000-4000-8000-000000000001",
    kind: "skip",
    localDate: "2032-11-21",
    timezone: "America/Detroit",
    reason: "Holiday closure",
    source: "generator",
    lifecycle: "published",
    durableCanonicalException: true,
    currentRevision: 1,
  }],
  administrator: {
    hasDraftEvidence: false,
    hasRejectedEvidence: false,
    hasSupersededEvidence: false,
    hasRevokedEvidence: false,
  c2ReviewAvailable: true,
  reviewContractFamily: "fall",
    fallRecoveryEligible: false,
    counts: {
      generationRuns: 1,
      draftOccurrences: 0,
      discardedOccurrences: 0,
      draftExceptions: 0,
      revokedExceptions: 0,
      draftRelationships: 0,
      revokedRelationships: 0,
      supersededBillingTerms: 0,
    },
  },
};

function renderCard(role: "user" | "org_admin" | "system_admin" = "org_admin") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeagueOccurrenceScheduleCard leagueId={7} organizationId={3} viewerRole={role} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LeagueOccurrenceScheduleCard", () => {
  it("renders an accessible responsive canonical schedule with distinct states and ordinals", async () => {
    vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: canonical });
    renderCard();
    expect(await screen.findByRole("heading", { name: "Season schedule" })).toBeVisible();
    expect(await screen.findByText("Canonical schedule")).toBeVisible();
    expect(screen.getByRole("list", { name: "Chronological season schedule" })).toBeVisible();
    expect(screen.getByText("Cancelled")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.getByText("Skipped")).toBeVisible();
    expect(screen.getByText("Makeup session")).toBeVisible();
    expect(screen.getByText("Makes up a cancelled session")).toBeVisible();
    expect(screen.getByText("Holiday closure")).toBeVisible();
    expect(screen.getAllByText("Planned")[0].parentElement).toHaveTextContent("4");
    expect(screen.getAllByText("Competition")[0].parentElement).toHaveTextContent("9");
    expect(screen.getAllByText("Billing")[0].parentElement).toHaveTextContent("12");
    expect(screen.getByText(/fold later/)).toBeVisible();
    expect(screen.getByText("Audited C2 controls")).toBeVisible();
    expect(screen.queryByText("Fall canonical draft generation")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveClass("md:grid-cols-[minmax(190px,1.25fr)_minmax(170px,1fr)_minmax(220px,1.25fr)]");
  });

  it("labels legacy fallback, cancellation, missing UUIDs, and contextual Fall recovery", async () => {
    const administrator = canonical.administrator;
    if (!administrator) throw new Error("canonical component fixture is missing administrator evidence");
    const fallback: LeagueOccurrenceScheduleReadContract = {
      ...canonical,
      authoritativeSource: "legacy_fallback",
      operationalCanonicalStateExists: false,
      occurrences: [{
        ...canonical.occurrences[0],
        occurrenceId: null,
        legacyProjectionKey: "legacy:7:2032-11-07:4",
        identitySource: "legacy_projection",
        lifecycle: "legacy",
        startAt: null,
        selectedUtcOffsetMinutes: null,
        foldResolution: null,
        resolverVersion: null,
        currentRevision: null,
        billing: null,
      }],
      skippedDates: [],
      administrator: { ...administrator, c2ReviewAvailable: false, reviewContractFamily: null, fallRecoveryEligible: true },
    };
    vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: fallback });
    renderCard();
    expect(await screen.findByText("Legacy fallback")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Legacy schedule fallback" })).toBeVisible();
    expect(screen.getByText("No canonical occurrence identity is assigned in legacy fallback.")).toBeVisible();
    expect(screen.getByText("Contextual Fall recovery")).toBeVisible();
    expect(screen.queryByText("Audited C2 controls")).not.toBeInTheDocument();
  });

  it("selects the generic review route for an E4 generation snapshot", async () => {
    const administrator = canonical.administrator;
    if (!administrator) throw new Error("canonical component fixture is missing administrator evidence");
    vi.spyOn(queryModule, "apiRequest").mockResolvedValue({
      success: true,
      data: {
        ...canonical,
        administrator: { ...administrator, reviewContractFamily: "canonical" },
      },
    });
    renderCard();
    const panel = await screen.findByTestId("draft-review-panel");
    expect(panel).toHaveAttribute("data-base-path", "/api/leagues/7/canonical-drafts");
    expect(panel).toHaveAttribute("data-contract-family", "canonical");
  });

  it("supports loading, empty, error, and retry states", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: { success: true; data: LeagueOccurrenceScheduleReadContract }) => void;
    const api = vi.spyOn(queryModule, "apiRequest")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockRejectedValueOnce(new Error("unsafe canonical state"))
      .mockResolvedValueOnce({ success: true, data: { ...canonical, occurrences: [], skippedDates: [] } });
    const first = renderCard();
    expect(screen.getByText("Loading season schedule…")).toBeVisible();
    resolveFirst({ success: true, data: canonical });
    expect(await screen.findByText("Canonical schedule")).toBeVisible();
    first.unmount();

    renderCard();
    expect(await screen.findByRole("heading", { name: "Season schedule is unavailable" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No physical sessions or skipped dates");
    await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  });

  it("uses explicit organization scope for system administrators and omits admin diagnostics for ordinary users", async () => {
    const api = vi.spyOn(queryModule, "apiRequest").mockResolvedValue({
      success: true,
      data: { ...canonical, administrator: null },
    });
    renderCard("system_admin");
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/leagues/7/occurrence-schedule?organizationId=3", "GET"));

    renderCard("user");
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/leagues/7/occurrence-schedule", "GET"));
    expect(screen.queryByRole("heading", { name: "Schedule administration" })).not.toBeInTheDocument();
  });
});
