import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallDraftReviewPanel } from "@/pages/league-view-page/fall-draft-review-panel";
import * as queryModule from "@/lib/queryClient";
import type { CanonicalDraftMutationResult, CanonicalDraftReview } from "@shared/canonical-draft-review";

const reviewFingerprint = "a".repeat(64);

const review: CanonicalDraftReview = {
  reviewContractVersion: "canonical-draft-review/1",
  reviewFingerprintVersion: "canonical-draft-review-fingerprint/1",
  reviewFingerprint,
  organizationId: 3,
  leagueId: 7,
  generationRun: {
    id: "00000000-0000-4000-8000-000000000001",
    state: "generated",
    originatingCommandId: "00000000-0000-4000-8000-000000000002",
    generatorVersion: "canonical-occurrence-generator/1",
    inputFingerprint: "b".repeat(64),
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { snapshotContractVersion: "fall-draft-generation-input-snapshot/3", paymentMode: "weekly" },
    rangeStartDate: "2032-08-01",
    rangeEndDate: "2032-08-08",
    candidateOccurrenceCount: 1,
    generatedOccurrenceCount: 1,
    skippedDateCount: 1,
    discrepancyCount: 1,
    approvedAt: null,
    approvedByUserId: null,
    approvalCommandId: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    rejectionCommandId: null,
    supersededAt: null,
    supersededByCommandId: null,
  },
  generation: {
    inputSnapshotVersion: "fall-draft-generation-input-snapshot/3",
    paymentMode: "weekly",
    confirmedPreviewFingerprint: "c".repeat(64),
    candidateSetFingerprint: "d".repeat(64),
    inputFingerprint: "b".repeat(64),
    physicalScheduleFingerprint: "e".repeat(64),
    generatorVersion: "canonical-occurrence-generator/1",
    resultContractVersion: "canonical-occurrence-generation-result/1",
    dstResolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
    seasonClassification: "Fall",
  },
  currentLegacyInput: { matches: true, currentInputFingerprint: "b".repeat(64), generatedInputFingerprint: "b".repeat(64) },
  occurrences: [{
    id: "00000000-0000-4000-8000-000000000010",
    generationKey: "occurrence:v1:7:stable",
    generationRunId: "00000000-0000-4000-8000-000000000001",
    locationId: 9,
    kind: "regular",
    status: "scheduled",
    lifecycle: "draft",
    authoritativeLocalDate: "2032-08-01",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "America/New_York",
    startAt: "2032-08-01T23:00:00.000Z",
    selectedUtcOffsetMinutes: -240,
    foldResolution: "unambiguous",
    resolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    currentRevision: 1,
    lastCommandId: "00000000-0000-4000-8000-000000000002",
    publishedAt: null,
    publishedByUserId: null,
    publicationCommandId: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationCommandId: null,
    lockedAt: null,
    lockedByUserId: null,
    lockReason: null,
    lockCommandId: null,
    completedAt: null,
    completedByUserId: null,
    completionCommandId: null,
    discardedAt: null,
    discardedByUserId: null,
    discardCommandId: null,
    effectivelyLocked: false,
    revisions: [{
      id: "00000000-0000-4000-8000-000000000011",
      occurrenceId: "00000000-0000-4000-8000-000000000010",
      commandId: "00000000-0000-4000-8000-000000000002",
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      beforeSnapshot: null,
      afterSnapshot: { status: "scheduled" },
    }],
  }],
  billingTerms: [{
    id: "00000000-0000-4000-8000-000000000020",
    occurrenceId: "00000000-0000-4000-8000-000000000010",
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: 1,
    version: 1,
    state: "draft",
    currentRevision: 1,
    lastCommandId: "00000000-0000-4000-8000-000000000002",
    publishedAt: null,
    publishedByUserId: null,
    publicationCommandId: null,
    supersededAt: null,
    supersededByCommandId: null,
    revisions: [],
  }],
  scheduleExceptions: [{
    id: "00000000-0000-4000-8000-000000000030",
    kind: "skip",
    localDate: "2032-08-15",
    timezone: "America/New_York",
    source: "generator",
    lifecycle: "draft",
    reason: "Holiday",
    generationRunId: "00000000-0000-4000-8000-000000000001",
    currentRevision: 1,
    lastCommandId: "00000000-0000-4000-8000-000000000002",
    publishedAt: null,
    publishedByUserId: null,
    publicationCommandId: null,
    revokedAt: null,
    revokedByUserId: null,
    revocationCommandId: null,
    revisions: [],
  }],
  discrepancies: [{
    id: "00000000-0000-4000-8000-000000000040",
    severity: "warning",
    code: "total_week_mismatch",
    generationKey: null,
    details: { generatorDetails: { expectedSeasonEnd: "2032-08-22" } },
    resolutionState: "open",
    resolutionCommandId: null,
    resolvedAt: null,
    currentEvidence: { expectedSeasonEnd: "2032-08-22", currentFinalDate: "2032-08-08" },
    canResolve: false,
    revisions: [],
  }],
  commands: [{
    id: "00000000-0000-4000-8000-000000000002",
    commandType: "generate",
    actorUserId: 5,
    reason: "Generate",
    idempotencyKey: "generate-key",
    requestFingerprint: `lvcanoncmd:v1:${"f".repeat(64)}`,
    sameDayOverride: false,
    outcome: "applied",
  }],
};

function renderPanel(value: CanonicalDraftReview = review) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const basePath = "/api/leagues/7/canonical-drafts";
  client.setQueryData([`${basePath}/review`], { success: true, data: value });
  const scheduleQueryKey = ["league-occurrence-schedule", "/api/leagues/7/occurrence-schedule"];
  return {
    ...render(
      <QueryClientProvider client={client}>
        <FallDraftReviewPanel
          basePath={basePath}
          querySuffix=""
          enabled
          scheduleQueryKey={scheduleQueryKey}
        />
      </QueryClientProvider>,
    ),
    client,
    basePath,
    scheduleQueryKey,
  };
}

function result(updatedReview: CanonicalDraftReview, operation: CanonicalDraftMutationResult["operation"]): CanonicalDraftMutationResult {
  return {
    resultContractVersion: "canonical-draft-mutation-result/1",
    operation,
    mode: "applied",
    commandIds: ["00000000-0000-4000-8000-000000000099"],
    durableEntityIds: [updatedReview.occurrences[0].id],
    review: updatedReview,
    writesPerformed: true,
    legacyWritesPerformed: false,
    paymentOrProviderWritesPerformed: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FallDraftReviewPanel", () => {
  it("renders user-facing schedule controls without backend evidence", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Edit Schedule" })).toBeVisible();
    expect(screen.getByText(/Aug 1, 2032/)).toBeVisible();
    expect(screen.getByText("7:00 PM")).toBeVisible();
    expect(screen.queryByText(reviewFingerprint)).not.toBeInTheDocument();
    expect(screen.queryByText((content) => content.includes(review.occurrences[0].id))).not.toBeInTheDocument();
    expect(screen.queryByText(/eligible_bowlers/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("keeps timezone and ambiguous-fold policy behind the user-facing reschedule form", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Reschedule" }));
    expect(screen.getByLabelText("New date")).toBeVisible();
    expect(screen.getByLabelText("New start time")).toBeVisible();
    expect(screen.queryByLabelText("IANA timezone")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ambiguous fold")).not.toBeInTheDocument();
  });

  it("uses the generic E4 route and strict request versions for canonical review", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000092" });
    const apiSpy = vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: result(review, "cancel") });
    const rendered = renderPanel(review);
    const invalidateSpy = vi.spyOn(rendered.client, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.type(screen.getByLabelText("Reason for change"), "Cancel generic future occurrence");
    await user.click(screen.getByRole("button", { name: "Cancel league night" }));
    await waitFor(() => expect(apiSpy).toHaveBeenCalledWith(
      "/api/leagues/7/canonical-drafts/review/cancel",
      "POST",
      expect.objectContaining({
        contractVersion: "canonical-draft-cancel-request/1",
        confirmedReviewFingerprint: reviewFingerprint,
      }),
    ));
    expect(rendered.client.getQueryData([`${rendered.basePath}/review`])).toEqual({ success: true, data: review });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: rendered.scheduleQueryKey,
      exact: true,
      refetchType: "active",
    });
  });

  it("shows the sanitized server reason when a schedule change is rejected", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000093" });
    vi.spyOn(queryModule, "apiRequest").mockImplementation(async (_path, method) => {
      if (method === "GET") return { success: true, data: review };
      throw new Error("409: Another league night already uses this date.");
    });
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.type(screen.getByLabelText("Reason for change"), "Weather cancellation");
    await user.click(screen.getByRole("button", { name: "Cancel league night" }));

    expect(await screen.findByText("Another league night already uses this date.")).toBeVisible();
    expect(screen.queryByText(/latest schedule has been reloaded/i)).not.toBeInTheDocument();
  });

  it("explains why a scheduled league night is locked instead of showing unusable controls", () => {
    renderPanel({
      ...review,
      occurrences: [{ ...review.occurrences[0], lifecycle: "published", effectivelyLocked: true }],
    });

    expect(screen.getByText("This league night cannot be changed because it has started or has linked activity.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("disables editing for unavailable schedule rows without exposing internal state", () => {
    renderPanel({
      ...review,
      generationRun: { ...review.generationRun, state: "rejected", rejectedAt: "2030-01-01T00:00:00.000Z", rejectedByUserId: 5, rejectionReason: "Rejected", rejectionCommandId: "reject" },
      currentLegacyInput: { ...review.currentLegacyInput, matches: false },
      occurrences: [{ ...review.occurrences[0], status: "discarded", plannedOrdinal: null, competitionNumber: null, effectivelyLocked: true }],
    });
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getByText("No changes available")).toBeVisible();
    expect(screen.queryByText("Rejected")).not.toBeInTheDocument();
    expect(screen.queryByText("Effectively locked")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and publish reviewed set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject complete draft set" })).not.toBeInTheDocument();
  });
});
