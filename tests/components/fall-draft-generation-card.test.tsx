import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallDraftGenerationCard } from "@/pages/league-view-page/fall-draft-generation-card";
import * as queryModule from "@/lib/queryClient";
import type { FallDraftApplyResult, FallDraftPersistedView, FallDraftPreview } from "@shared/fall-draft-generation";

const fingerprint = "a".repeat(64);
const inputFingerprint = "b".repeat(64);
const physicalFingerprint = "c".repeat(64);
const candidateFingerprint = "d".repeat(64);

const preview = {
  previewContractVersion: "fall-draft-generation-preview/2",
  previewRequestContractVersion: "fall-draft-preview-request/2",
  implementationVersion: "fall-draft-generation/2",
  mappingVersion: "fall-draft-mapping/1",
  generatorVersion: "canonical-occurrence-generator/1",
  inputContractVersion: "canonical-occurrence-input/1",
  resultContractVersion: "canonical-occurrence-generation-result/1",
  dstResolverVersion: "canonical-dst-resolver/1;icu=test;tzdata=test",
  operatorScope: { organizationId: 3, leagueId: 7, locationId: 9 },
  semantics: { paymentMode: "weekly", ambiguousFold: "reject", currency: "USD", regularSessionBillingPolicy: "eligible_bowlers", billingOrdinalPolicy: "planned_slot" },
  eligibility: { active: true, archived: false, seasonClassification: "Fall", whollyFutureFacing: true, eligibleForApply: true, blockers: [] },
  normalizedInput: {
    contractVersion: "canonical-occurrence-input/1",
    organizationId: 3, leagueId: 7, locationId: 9, sourceScheduleRevision: 1,
    seasonStart: "2032-08-01", seasonEnd: "2032-08-22", weekday: "Sunday", localCompetitionStartTime: "19:00:00",
    timezone: "America/New_York", plannedSlotCount: 2, skipExceptions: [], cancelledDates: ["2032-08-08"], ambiguousFold: "reject",
    defaultWeeklyAmountMinor: 2000, currency: "USD", regularSessionBillingPolicy: "eligible_bowlers", billingOrdinalPolicy: "planned_slot",
    specialSessionBehavior: { mode: "regular_only", version: "1" },
  },
  inputFingerprint,
  physicalScheduleFingerprint: physicalFingerprint,
  candidateSetFingerprint: candidateFingerprint,
  previewFingerprint: fingerprint,
  proposedSourceScheduleRevision: { value: 1, reserved: false },
  generationRange: { startDate: "2032-08-01", endDate: "2032-08-15", expectedSeasonEndDate: "2032-08-22", examinedCalendarDateCount: 3 },
  occurrenceCandidates: [
    {
      candidateReference: "occurrence-1", generationKey: "occurrence:v1:7:first", kind: "regular", status: "scheduled",
      authoritativeLocalDate: "2032-08-01", authoritativeLocalStartTime: "19:00:00", timezone: "America/New_York",
      startAt: "2032-08-01T23:00:00.000Z", selectedUtcOffsetMinutes: -240, foldResolution: "unambiguous", resolverVersion: "resolver",
      plannedOrdinal: 1, competitionNumber: 1, competitive: true, countsInStandings: true, makeupFor: null,
      lifecycleIntent: "draft", cancellationMetadataIntent: "none",
    },
    {
      candidateReference: "occurrence-2", generationKey: "occurrence:v1:7:cancelled", kind: "regular", status: "cancelled",
      authoritativeLocalDate: "2032-08-08", authoritativeLocalStartTime: "19:00:00", timezone: "America/New_York",
      startAt: "2032-08-08T23:00:00.000Z", selectedUtcOffsetMinutes: -240, foldResolution: "unambiguous", resolverVersion: "resolver",
      plannedOrdinal: 2, competitionNumber: null, competitive: false, countsInStandings: false, makeupFor: null,
      lifecycleIntent: "draft", cancellationMetadataIntent: "generation_action_time",
    },
  ],
  billingTermCandidates: [
    { candidateReference: "term-1", occurrenceCandidateReference: "occurrence-1", purpose: "league_weekly_fee", obligationPolicy: "eligible_bowlers", defaultAmountMinor: 2000, currency: "USD", billingOrdinal: 1, version: 1, stateIntent: "draft", policySnapshotOnly: true },
    { candidateReference: "term-2", occurrenceCandidateReference: "occurrence-2", purpose: "league_weekly_fee", obligationPolicy: "none", defaultAmountMinor: 0, currency: "USD", billingOrdinal: null, version: 1, stateIntent: "draft", policySnapshotOnly: true },
  ],
  exceptionCandidates: [
    { candidateReference: "skip-1", candidateKey: "skip-key", kind: "skip", authoritativeLocalDate: "2032-08-15", timezone: "America/New_York", reason: "Holiday", source: "legacy_import", lifecycleIntent: "draft", generationRunAssociationIntent: "associate" },
  ],
  fatalErrors: [],
  discrepancies: [{ severity: "warning", code: "total_week_mismatch", details: { expectedSeasonEnd: "2032-08-22", generatedFinalDate: "2032-08-15" } }],
  counts: { generatedOccurrenceCount: 2, skippedDateCount: 1, candidateOccurrenceCount: 3, fatalErrorCount: 0, discrepancyCount: 1, issueCount: 1, existingCanonicalRows: 0 },
  existingCanonicalState: {
    commandCount: 0, generationRunCount: 0, occurrenceCount: 0, billingTermCount: 0, exceptionCount: 0, relationshipCount: 0,
    occurrenceRevisionCount: 0, billingTermRevisionCount: 0, exceptionRevisionCount: 0, discrepancyCount: 0, generationRuns: [],
  },
  legacyCollectionEvidence: {
    source: "leagues.double_pay_dates", doublePayDates: ["2032-08-22"], excludedFromCanonicalGeneration: true,
    excludedFromPhysicalScheduleFingerprint: true, excludedFromBillingTermsAndAmounts: true,
  },
  draftMapping: {
    occurrenceLifecycle: "draft", scheduledStatus: "scheduled", cancelledStatus: "cancelled", billingTermState: "draft", skipExceptionLifecycle: "draft",
    cancellationTimestamp: "generation_action_time", approvalMetadata: "none", publicationMetadata: "none", lockMetadata: "none",
    relationshipMaterialization: "none", paymentObligationOrCollectionMaterialization: "none",
    occurrenceRevisionSnapshotVersion: 1, billingTermRevisionSnapshotVersion: 1, exceptionRevisionSnapshotVersion: 1,
  },
} satisfies FallDraftPreview;

const applyResult = {
  resultContractVersion: "fall-draft-generation-result/2",
  previewContractVersion: "fall-draft-generation-preview/2",
  implementationVersion: "fall-draft-generation/2",
  mappingVersion: "fall-draft-mapping/1",
  mode: "applied",
  organizationId: 3,
  leagueId: 7,
  confirmedPreviewFingerprint: fingerprint,
  requestFingerprint: `lvcanoncmd:v1:${"e".repeat(64)}`,
  inputFingerprint,
  physicalScheduleFingerprint: physicalFingerprint,
  candidateSetFingerprint: candidateFingerprint,
  sourceScheduleRevision: 1,
  durableIds: {
    commandIds: ["command"], generationRunId: "run", occurrenceIds: ["one", "two"], billingTermIds: ["term-one", "term-two"],
    exceptionIds: ["exception"], occurrenceRevisionIds: ["revision-one", "revision-two"], billingTermRevisionIds: ["term-revision-one", "term-revision-two"],
    exceptionRevisionIds: ["exception-revision"], discrepancyIds: ["discrepancy"],
  },
  counts: { commands: 3, occurrences: 2, scheduledOccurrences: 1, cancelledOccurrences: 1, billingTerms: 2, exceptions: 1, discrepancies: 1 },
  writesPerformed: true,
  legacyWritesPerformed: false,
  relationshipsCreated: false,
  paymentObligationOrCollectionRowsCreated: false,
  currentLegacyScheduleMatchesGenerationInput: true,
} satisfies FallDraftApplyResult;

function renderCard(status: FallDraftPersistedView = { found: false, result: null, currentLegacyScheduleMatchesGenerationInput: null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["/api/leagues/7/canonical-fall-drafts"], { success: true, data: status });
  return render(
    <QueryClientProvider client={client}>
      <FallDraftGenerationCard leagueId={7} organizationId={3} isSystemAdmin={false} />
    </QueryClientProvider>,
  );
}

async function selectRequiredPolicies(user: UserEvent) {
  await user.click(screen.getByLabelText("Billing ordinal policy"));
  await user.click(screen.getByRole("option", { name: "Planned slot" }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FallDraftGenerationCard", () => {
  it("derives billing policy, provides accessible preview focus, and requires explicit confirmation", async () => {
    const user = userEvent.setup();
    const apiSpy = vi.spyOn(queryModule, "apiRequest")
      .mockResolvedValueOnce({ success: true, data: preview })
      .mockResolvedValueOnce({ success: true, data: applyResult });
    renderCard();

    expect(screen.queryByLabelText("Ambiguous DST fold policy")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Currency")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Regular-session billing policy")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Billing ordinal policy")).toBeEnabled();
    expect(screen.getByText("No C1 canonical draft generation exists for this league.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate zero-write preview" })).toBeDisabled();

    await selectRequiredPolicies(user);
    expect(screen.getByRole("button", { name: "Generate zero-write preview" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Generate zero-write preview" }));
    const heading = await screen.findByRole("heading", { name: "Canonical preview" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(apiSpy).toHaveBeenNthCalledWith(1, "/api/leagues/7/canonical-fall-drafts/preview", "POST", {
      contractVersion: "fall-draft-preview-request/2",
      billingOrdinalPolicy: "planned_slot",
    });
    expect(screen.getByText("cancelled")).toBeVisible();
    expect(screen.getByText(/2032-08-15: Holiday/)).toBeVisible();
    expect(screen.getByText("Excluded legacy collection evidence")).toBeVisible();
    expect(screen.getByText(/complete preview fingerprint includes this displayed evidence/i)).toBeVisible();
    expect(screen.getByText(/total_week_mismatch/)).toBeVisible();
    expect(screen.getByText("League payment timing:").parentElement).toHaveTextContent("Weekly; weekly session obligations retained");

    await user.type(screen.getByLabelText("Reason for draft creation"), "Reviewed C1 draft generation");
    await user.click(screen.getByRole("button", { name: "Confirm and create canonical drafts" }));
    expect(await screen.findByRole("heading", { name: "Create this complete draft set?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create drafts" }));
    expect(await screen.findByText("Canonical drafts created")).toBeVisible();
    expect(apiSpy).toHaveBeenNthCalledWith(2, "/api/leagues/7/canonical-fall-drafts/apply", "POST", expect.objectContaining({
      confirmedPreviewFingerprint: fingerprint,
      reason: "Reviewed C1 draft generation",
    }));
    const applyPayload = apiSpy.mock.calls[1][2] as Record<string, unknown>;
    expect(applyPayload.contractVersion).toBe("fall-draft-apply-request/2");
    expect(applyPayload).not.toHaveProperty("ambiguousFold");
    expect(applyPayload).not.toHaveProperty("currency");
    expect(applyPayload).not.toHaveProperty("regularSessionBillingPolicy");
    expect(applyPayload).not.toHaveProperty("occurrenceCandidates");
    expect(applyPayload).not.toHaveProperty("organizationId");
  });

  it("marks a preview stale after policy edits and disables confirmation until re-preview", async () => {
    const user = userEvent.setup();
    vi.spyOn(queryModule, "apiRequest").mockResolvedValue({ success: true, data: preview });
    renderCard();
    await selectRequiredPolicies(user);
    await user.click(screen.getByRole("button", { name: "Generate zero-write preview" }));
    const previewHeading = await screen.findByRole("heading", { name: "Canonical preview" });
    await waitFor(() => expect(previewHeading).toHaveFocus());
    await user.type(screen.getByLabelText("Reason for draft creation"), "Reviewed");
    await user.click(screen.getByLabelText("Billing ordinal policy"));
    await user.click(screen.getByRole("option", { name: "Dense billable" }));
    expect(screen.getByText("Preview controls changed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm and create canonical drafts" })).toBeDisabled();
  });

  it("shows persisted success and legacy-schedule staleness after reload", () => {
    renderCard({ found: true, result: { ...applyResult, currentLegacyScheduleMatchesGenerationInput: false }, currentLegacyScheduleMatchesGenerationInput: false });
    expect(screen.getByText("Canonical drafts already exist")).toBeVisible();
    expect(screen.getByText("Stale — preview again for review only")).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate zero-write preview" })).toBeDisabled();
  });

  it("exposes a disabled loading state while preview is in flight", async () => {
    const user = userEvent.setup();
    let resolvePreview!: (value: { success: true; data: FallDraftPreview }) => void;
    vi.spyOn(queryModule, "apiRequest").mockImplementation(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));
    renderCard();
    await selectRequiredPolicies(user);
    const button = screen.getByRole("button", { name: "Generate zero-write preview" });
    await user.click(button);
    expect(button).toBeDisabled();
    resolvePreview({ success: true, data: preview });
    expect(await screen.findByRole("heading", { name: "Canonical preview" })).toBeVisible();
  });

  it("retries the exact failed apply request even if the editable reason changes", async () => {
    const user = userEvent.setup();
    const apiSpy = vi.spyOn(queryModule, "apiRequest")
      .mockResolvedValueOnce({ success: true, data: preview })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ success: true, data: applyResult });
    renderCard();
    await selectRequiredPolicies(user);
    await user.click(screen.getByRole("button", { name: "Generate zero-write preview" }));
    const previewHeading = await screen.findByRole("heading", { name: "Canonical preview" });
    await waitFor(() => expect(previewHeading).toHaveFocus());
    const reasonInput = screen.getByLabelText("Reason for draft creation");
    await user.type(reasonInput, "Original reviewed reason");
    expect(reasonInput).toHaveValue("Original reviewed reason");
    expect(screen.queryByText("Preview controls changed")).not.toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "Confirm and create canonical drafts" });
    await waitFor(() => expect(confirmButton).toBeEnabled());
    await user.click(confirmButton);
    expect(await screen.findByRole("heading", { name: "Create this complete draft set?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create drafts" }));
    expect(await screen.findByText("Draft creation failed")).toBeVisible();
    await user.clear(reasonInput);
    await user.type(reasonInput, "Changed after the failed transport");
    await user.click(screen.getByRole("button", { name: "Retry exact request" }));
    expect(await screen.findByText("Canonical drafts created")).toBeVisible();
    expect(apiSpy.mock.calls[2][2]).toEqual(apiSpy.mock.calls[1][2]);
  });

  it("uses a secure getRandomValues UUID fallback when randomUUID is unavailable", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_value, index) => { bytes[index] = index + 1; });
        return bytes;
      },
    });
    const apiSpy = vi.spyOn(queryModule, "apiRequest")
      .mockResolvedValueOnce({ success: true, data: preview })
      .mockResolvedValueOnce({ success: true, data: applyResult });
    renderCard();
    await selectRequiredPolicies(user);
    await user.click(screen.getByRole("button", { name: "Generate zero-write preview" }));
    const previewHeading = await screen.findByRole("heading", { name: "Canonical preview" });
    await waitFor(() => expect(previewHeading).toHaveFocus());
    await user.type(screen.getByLabelText("Reason for draft creation"), "Reviewed with iOS-compatible identity");
    await user.click(screen.getByRole("button", { name: "Confirm and create canonical drafts" }));
    await user.click(await screen.findByRole("button", { name: "Create drafts" }));
    expect(await screen.findByText("Canonical drafts created")).toBeVisible();
    expect(apiSpy.mock.calls[1][2]).toMatchObject({
      idempotencyKey: "01020304-0506-4708-890a-0b0c0d0e0f10",
    });
  });
});
