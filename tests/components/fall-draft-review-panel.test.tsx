import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallDraftReviewPanel } from "@/pages/league-view-page/fall-draft-review-panel";
import * as queryModule from "@/lib/queryClient";
import type { FallDraftMutationResult, FallDraftReview } from "@shared/fall-draft-review";

const reviewFingerprint = "a".repeat(64);

const review: FallDraftReview = {
  reviewContractVersion: "fall-draft-review/2",
  reviewFingerprintVersion: "fall-draft-review-fingerprint/2",
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
  c1: {
    inputSnapshotVersion: "fall-draft-generation-input-snapshot/3",
    paymentMode: "weekly",
    confirmedPreviewFingerprint: "c".repeat(64),
    candidateSetFingerprint: "d".repeat(64),
    inputFingerprint: "b".repeat(64),
    physicalScheduleFingerprint: "e".repeat(64),
    generatorVersion: "canonical-occurrence-generator/1",
    resultContractVersion: "canonical-occurrence-generation-result/1",
    dstResolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
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

function renderPanel(value: FallDraftReview = review, contractFamily: "fall" | "canonical" = "fall", readOnlyArchive = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const basePath = contractFamily === "canonical"
    ? "/api/leagues/7/canonical-drafts"
    : "/api/leagues/7/canonical-fall-drafts";
  client.setQueryData([`${basePath}/review`], { success: true, data: value });
  const scheduleQueryKey = ["league-occurrence-schedule", "/api/leagues/7/occurrence-schedule"];
  return {
    ...render(
      <QueryClientProvider client={client}>
        <FallDraftReviewPanel
          basePath={basePath}
          querySuffix=""
          enabled
          contractFamily={contractFamily}
          scheduleQueryKey={scheduleQueryKey}
          readOnlyArchive={readOnlyArchive}
        />
      </QueryClientProvider>,
    ),
    client,
    basePath,
    scheduleQueryKey,
  };
}

function result(updatedReview: FallDraftReview, operation: FallDraftMutationResult["operation"]): FallDraftMutationResult {
  return {
    resultContractVersion: "fall-draft-mutation-result/2",
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
  it("renders exact UUID, DST, lifecycle, numbering, billing, exception, fingerprint, and eligible controls", () => {
    renderPanel();
    expect(screen.getByText("League payment timing:").parentElement).toHaveTextContent("Weekly");
    expect(screen.getByRole("heading", { name: "Audited C2 review and publication" })).toBeVisible();
    expect(screen.getByText(reviewFingerprint)).toBeVisible();
    expect(screen.getByText((content) => content.includes(review.occurrences[0].id))).toBeVisible();
    expect(screen.getByText(/offset -240; unambiguous/)).toBeVisible();
    expect(screen.getByText(/planned 1/)).toBeVisible();
    expect(screen.getByText(/eligible_bowlers/)).toBeVisible();
    expect(screen.getByText(/2032-08-15, skip, draft/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel occurrence" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore draft" })).toBeDisabled();
  });

  it("hardcodes ambiguous-fold rejection for rescheduling and does not expose a policy selector", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Reschedule" }));
    expect(screen.getByLabelText("Local date")).toBeVisible();
    expect(screen.getByLabelText("Local time")).toBeVisible();
    expect(screen.getByLabelText("IANA timezone")).toBeVisible();
    expect(screen.queryByLabelText("Ambiguous fold")).not.toBeInTheDocument();
  });

  it("requires a reason and confirmation and sends the exact fingerprint and revision for cancellation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000090" });
    const updated: FallDraftReview = {
      ...review,
      reviewFingerprint: "9".repeat(64),
      occurrences: [{ ...review.occurrences[0], status: "cancelled", competitionNumber: null, competitive: false, countsInStandings: false, currentRevision: 2 }],
    };
    const apiSpy = vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: result(updated, "cancel") });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Cancel occurrence" }));
    expect(screen.getByRole("button", { name: "Confirm cancel" })).toBeDisabled();
    await user.type(screen.getByLabelText("Reason"), "Cancel reviewed future occurrence");
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(apiSpy).toHaveBeenCalledWith(
      "/api/leagues/7/canonical-fall-drafts/review/cancel",
      "POST",
      expect.objectContaining({
        contractVersion: "fall-draft-cancel-request/1",
        confirmedReviewFingerprint: reviewFingerprint,
        expectedOccurrenceRevision: 1,
        occurrenceId: review.occurrences[0].id,
        reason: "Cancel reviewed future occurrence",
      }),
    ));
    expect(await screen.findByText("The audited mutation was committed.")).toBeVisible();
  });

  it("uses generic E4 routes and strict request versions for canonical review", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000092" });
    const apiSpy = vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: result(review, "cancel") });
    const rendered = renderPanel(review, "canonical");
    const invalidateSpy = vi.spyOn(rendered.client, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "Cancel occurrence" }));
    await user.type(screen.getByLabelText("Reason"), "Cancel generic future occurrence");
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
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

  it("requires every explicit discrepancy disposition before approval and describes excluded side effects", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000091" });
    const published: FallDraftReview = {
      ...review,
      reviewFingerprint: "8".repeat(64),
      generationRun: { ...review.generationRun, state: "applied", approvalCommandId: "approved" },
      occurrences: [{ ...review.occurrences[0], lifecycle: "published", publicationCommandId: "published", currentRevision: 2 }],
      billingTerms: [{ ...review.billingTerms[0], state: "published", publicationCommandId: "published", currentRevision: 2 }],
      scheduleExceptions: [{ ...review.scheduleExceptions[0], lifecycle: "published", publicationCommandId: "published", currentRevision: 2 }],
      discrepancies: [{ ...review.discrepancies[0], resolutionState: "waived", resolutionCommandId: "approved" }],
    };
    const apiSpy = vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: result(published, "approve_publish") });
    const rendered = renderPanel(review, "canonical");
    const invalidateSpy = vi.spyOn(rendered.client, "invalidateQueries");
    await user.type(screen.getByLabelText("Reason for approval or rejection"), "Approve reviewed policy snapshots");
    expect(screen.getByRole("button", { name: "Approve and publish reviewed set" })).toBeDisabled();
    await user.click(screen.getByLabelText("Disposition"));
    expect(screen.queryByRole("option", { name: "Resolved by current state" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Waived knowingly" }));
    await user.click(screen.getByRole("button", { name: "Approve and publish reviewed set" }));
    expect(await screen.findByText(/creates no debts, games, standings results, payments, or collection plans/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve and publish" }));
    await waitFor(() => expect(apiSpy).toHaveBeenCalledWith(
      "/api/leagues/7/canonical-drafts/review/approve",
      "POST",
      expect.objectContaining({
        contractVersion: "canonical-draft-approve-request/1",
        discrepancyDispositions: [{ discrepancyId: review.discrepancies[0].id, disposition: "waived" }],
      }),
    ));
    expect(rendered.client.getQueryData([`${rendered.basePath}/review`])).toEqual({ success: true, data: published });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: rendered.scheduleQueryKey,
      exact: true,
      refetchType: "active",
    });
  });

  it("clearly displays stale, effectively locked, and terminal rejected states", () => {
    renderPanel({
      ...review,
      generationRun: { ...review.generationRun, state: "rejected", rejectedAt: "2030-01-01T00:00:00.000Z", rejectedByUserId: 5, rejectionReason: "Rejected", rejectionCommandId: "reject" },
      currentLegacyInput: { ...review.currentLegacyInput, matches: false },
      occurrences: [{ ...review.occurrences[0], status: "discarded", plannedOrdinal: null, competitionNumber: null, effectivelyLocked: true }],
    });
    expect(screen.getByText("Rejected")).toBeVisible();
    expect(screen.getByText("Effectively locked")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Approve and publish reviewed set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject complete draft set" })).not.toBeInTheDocument();
  });

  it("renders archived canonical review evidence without mutation controls", () => {
    renderPanel(review, "canonical", true);

    expect(screen.getByRole("status")).toHaveTextContent(/read-only archive/i);
    expect(screen.getByText(reviewFingerprint)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel occurrence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and publish reviewed set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject complete draft set" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Disposition")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reason for approval or rejection")).not.toBeInTheDocument();
  });
});
