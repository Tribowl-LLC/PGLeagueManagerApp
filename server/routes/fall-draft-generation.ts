import { Router, type Request } from "express";
import { z } from "zod";
import {
  fallDraftApplyRequestSchema,
  fallDraftPreviewRequestSchema,
} from "@shared/fall-draft-generation";
import {
  fallDraftApproveRequestSchema,
  fallDraftCancelRequestSchema,
  fallDraftRejectRequestSchema,
  fallDraftRescheduleRequestSchema,
  fallDraftRestoreRequestSchema,
} from "@shared/fall-draft-review";
import {
  CANONICAL_DRAFT_APPROVE_REQUEST_VERSION,
  CANONICAL_DRAFT_CANCEL_REQUEST_VERSION,
  CANONICAL_DRAFT_REJECT_REQUEST_VERSION,
  CANONICAL_DRAFT_RESCHEDULE_REQUEST_VERSION,
  CANONICAL_DRAFT_RESTORE_REQUEST_VERSION,
  CANONICAL_DRAFT_MUTATION_RESULT_VERSION,
  canonicalDraftApproveRequestSchema,
  canonicalDraftCancelRequestSchema,
  canonicalDraftRejectRequestSchema,
  canonicalDraftRescheduleRequestSchema,
  canonicalDraftRestoreRequestSchema,
  toCanonicalDraftReview,
  type CanonicalDraftMutationResult,
  type CanonicalDraftReview,
} from "@shared/canonical-draft-review";
import { isFutureSeasonDraftInputSnapshot } from "@shared/future-season-draft-generation";
import { filterByOrganization } from "../middleware/organization.js";
import { singleRouteParam } from "../utils/route-params.js";
import { handleZodError, sendError, sendSuccess } from "../utils/api.js";
import {
  applyFallDraftGeneration,
  FallDraftGenerationError,
  loadFallDraftPersistedView,
  previewFallDraftGeneration,
} from "../services/fall-draft-generation.js";
import { createLogger } from "../logger.js";
import {
  approveAndPublishFallDraft,
  cancelFallDraftOccurrence,
  FallDraftReviewError,
  loadFallDraftReview,
  rejectFallDraft,
  rescheduleFallDraftOccurrence,
  restoreFallDraftOccurrence,
} from "../services/fall-draft-review.js";

const log = createLogger("FallDraftGenerationRoutes");
const router = Router();

router.use(filterByOrganization);

function positiveRouteId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function authorizedScope(req: Request): { organizationId: number; leagueId: number; actorUserId: number } | null {
  const leagueId = positiveRouteId(singleRouteParam(req.params.id));
  if (!leagueId || !req.user) return null;
  if (req.user.role === "org_admin") {
    return req.user.organizationId
      ? { organizationId: req.user.organizationId, leagueId, actorUserId: req.user.id }
      : null;
  }
  if (req.user.role !== "system_admin") return null;
  const rawOrganizationId = req.query.organizationId;
  if (typeof rawOrganizationId !== "string") return null;
  const organizationId = positiveRouteId(rawOrganizationId);
  return organizationId ? { organizationId, leagueId, actorUserId: req.user.id } : null;
}

function sendFallDraftError(res: Parameters<typeof sendError>[0], caught: unknown): void {
  if (caught instanceof z.ZodError) return handleZodError(res, caught);
  const code = caught instanceof FallDraftGenerationError || caught instanceof FallDraftReviewError
    ? caught.code
    : typeof caught === "object" && caught !== null && "code" in caught
      ? String(caught.code)
      : "transaction_failure";
  const message = caught instanceof FallDraftGenerationError || caught instanceof FallDraftReviewError
    ? caught.message
    : "Fall canonical administration could not be completed";
  const mapping: Record<string, { status: number; apiCode: string }> = {
    invalid_scope: { status: 400, apiCode: "INVALID_REQUEST" },
    unauthorized_actor: { status: 403, apiCode: "FORBIDDEN" },
    league_not_found: { status: 404, apiCode: "LEAGUE_NOT_FOUND" },
    invalid_location: { status: 422, apiCode: "FALL_DRAFT_INELIGIBLE" },
    ineligible_league: { status: 422, apiCode: "FALL_DRAFT_INELIGIBLE" },
    incomplete_authoritative_input: { status: 422, apiCode: "FALL_DRAFT_INCOMPLETE_INPUT" },
    generator_fatal_error: { status: 422, apiCode: "FALL_DRAFT_GENERATOR_ERROR" },
    unsupported_discrepancy: { status: 409, apiCode: "FALL_DRAFT_UNSUPPORTED_DISCREPANCY" },
    not_wholly_future: { status: 409, apiCode: "FALL_DRAFT_NOT_FUTURE" },
    stale_preview: { status: 409, apiCode: "FALL_DRAFT_STALE_PREVIEW" },
    idempotency_conflict: { status: 409, apiCode: "IDEMPOTENCY_CONFLICT" },
    canonical_collision: { status: 409, apiCode: "FALL_DRAFT_COLLISION" },
    incompatible_canonical_state: { status: 409, apiCode: "FALL_DRAFT_INCOMPATIBLE_STATE" },
    same_day_collision: { status: 409, apiCode: "FALL_DRAFT_COLLISION" },
    exact_start_collision: { status: 409, apiCode: "FALL_DRAFT_COLLISION" },
    exception_collision: { status: 409, apiCode: "FALL_DRAFT_COLLISION" },
    c1_run_not_found: { status: 404, apiCode: "FALL_DRAFT_NOT_FOUND" },
    stale_review: { status: 409, apiCode: "FALL_DRAFT_STALE_REVIEW" },
    revision_conflict: { status: 409, apiCode: "FALL_DRAFT_REVISION_CONFLICT" },
    effective_lock: { status: 409, apiCode: "FALL_DRAFT_EFFECTIVELY_LOCKED" },
    terminal_state: { status: 409, apiCode: "FALL_DRAFT_TERMINAL_STATE" },
    activity_evidence: { status: 409, apiCode: "FALL_DRAFT_ACTIVITY_EVIDENCE" },
    invalid_dst_input: { status: 422, apiCode: "FALL_DRAFT_DST_ERROR" },
    legacy_input_stale: { status: 409, apiCode: "FALL_DRAFT_LEGACY_INPUT_STALE" },
    discrepancy_disposition_invalid: { status: 409, apiCode: "FALL_DRAFT_DISCREPANCY_DISPOSITION_INVALID" },
  };
  const selected = mapping[code] ?? { status: 500, apiCode: "FALL_DRAFT_ERROR" };
  if (selected.status >= 500) log.error("Fall draft generation failed", { code });
  sendError(res, message, selected.status, selected.apiCode);
}

function requireAdminScope(req: Request, res: Parameters<typeof sendError>[0]) {
  if (!req.user || (req.user.role !== "org_admin" && req.user.role !== "system_admin")) {
    sendError(res, "Administrator access is required", 403, "FORBIDDEN");
    return null;
  }
  const scope = authorizedScope(req);
  if (!scope) {
    const message = req.user.role === "system_admin"
      ? "System administrators must select one organization with ?organizationId=<id>"
      : "A valid tenant-scoped league is required";
    sendError(res, message, 400, "INVALID_REQUEST");
    return null;
  }
  return scope;
}

router.post("/:id/canonical-fall-drafts/preview", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    fallDraftPreviewRequestSchema.parse(req.body);
    const preview = await previewFallDraftGeneration(scope);
    sendSuccess(res, preview);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-fall-drafts/apply", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const apply = fallDraftApplyRequestSchema.parse(req.body);
    const result = await applyFallDraftGeneration({ ...scope, apply });
    sendSuccess(res, result, result.mode === "applied" ? 201 : 200);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.get("/:id/canonical-fall-drafts", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    sendSuccess(res, await loadFallDraftPersistedView(scope));
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.get("/:id/canonical-fall-drafts/review", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    sendSuccess(res, await loadFallDraftReview(scope));
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-fall-drafts/review/reschedule", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const request = fallDraftRescheduleRequestSchema.parse(req.body);
    const result = await rescheduleFallDraftOccurrence({ ...scope, request });
    sendSuccess(res, result, result.mode === "applied" ? 201 : 200);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-fall-drafts/review/cancel", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const request = fallDraftCancelRequestSchema.parse(req.body);
    const result = await cancelFallDraftOccurrence({ ...scope, request });
    sendSuccess(res, result, result.mode === "applied" ? 201 : 200);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-fall-drafts/review/restore", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const request = fallDraftRestoreRequestSchema.parse(req.body);
    const result = await restoreFallDraftOccurrence({ ...scope, request });
    sendSuccess(res, result, result.mode === "applied" ? 201 : 200);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-fall-drafts/review/approve", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const request = fallDraftApproveRequestSchema.parse(req.body);
    const result = await approveAndPublishFallDraft({ ...scope, request });
    sendSuccess(res, result, result.mode === "applied" ? 201 : 200);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-fall-drafts/review/reject", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const request = fallDraftRejectRequestSchema.parse(req.body);
    const result = await rejectFallDraft({ ...scope, request });
    sendSuccess(res, result, result.mode === "applied" ? 201 : 200);
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

async function genericReview(scope: NonNullable<ReturnType<typeof authorizedScope>>): Promise<CanonicalDraftReview> {
  const review = await loadFallDraftReview({ ...scope, draftContractFamily: "future_season" });
  if (!isFutureSeasonDraftInputSnapshot(review.generationRun.normalizedInputSnapshot)) {
    throw new FallDraftReviewError("incompatible_canonical_state", "canonical draft review requires E4 future-season evidence");
  }
  return toCanonicalDraftReview(review, review.generationRun.normalizedInputSnapshot.seasonClassification);
}

function genericMutationResult(
  result: Awaited<ReturnType<typeof rescheduleFallDraftOccurrence>>,
): CanonicalDraftMutationResult {
  if (!isFutureSeasonDraftInputSnapshot(result.review.generationRun.normalizedInputSnapshot)) {
    throw new FallDraftReviewError("incompatible_canonical_state", "canonical draft mutation returned non-E4 evidence");
  }
  return {
    ...result,
    resultContractVersion: CANONICAL_DRAFT_MUTATION_RESULT_VERSION,
    review: toCanonicalDraftReview(
      result.review,
      result.review.generationRun.normalizedInputSnapshot.seasonClassification,
    ),
  };
}

async function genericMutationScope(
  scope: NonNullable<ReturnType<typeof authorizedScope>>,
  contractVersion: string,
  confirmedReviewFingerprint: string,
) {
  const current = await genericReview(scope);
  return {
    ...scope,
    draftContractFamily: "future_season" as const,
    draftSeasonClassification: current.generation.seasonClassification,
    draftReviewRequestContext: { contractVersion, confirmedReviewFingerprint },
  };
}

router.get("/:id/canonical-drafts/review", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    sendSuccess(res, await genericReview(scope));
  } catch (caught) {
    sendFallDraftError(res, caught);
  }
});

router.post("/:id/canonical-drafts/review/reschedule", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const parsed = canonicalDraftRescheduleRequestSchema.parse(req.body);
    const result = await rescheduleFallDraftOccurrence({
      ...await genericMutationScope(scope, CANONICAL_DRAFT_RESCHEDULE_REQUEST_VERSION, parsed.confirmedReviewFingerprint),
      request: { ...parsed, contractVersion: "fall-draft-reschedule-request/2" },
    });
    sendSuccess(res, genericMutationResult(result), result.mode === "applied" ? 201 : 200);
  } catch (caught) { sendFallDraftError(res, caught); }
});

router.post("/:id/canonical-drafts/review/cancel", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const parsed = canonicalDraftCancelRequestSchema.parse(req.body);
    const result = await cancelFallDraftOccurrence({
      ...await genericMutationScope(scope, CANONICAL_DRAFT_CANCEL_REQUEST_VERSION, parsed.confirmedReviewFingerprint),
      request: { ...parsed, contractVersion: "fall-draft-cancel-request/1" },
    });
    sendSuccess(res, genericMutationResult(result), result.mode === "applied" ? 201 : 200);
  } catch (caught) { sendFallDraftError(res, caught); }
});

router.post("/:id/canonical-drafts/review/restore", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const parsed = canonicalDraftRestoreRequestSchema.parse(req.body);
    const result = await restoreFallDraftOccurrence({
      ...await genericMutationScope(scope, CANONICAL_DRAFT_RESTORE_REQUEST_VERSION, parsed.confirmedReviewFingerprint),
      request: { ...parsed, contractVersion: "fall-draft-restore-request/1" },
    });
    sendSuccess(res, genericMutationResult(result), result.mode === "applied" ? 201 : 200);
  } catch (caught) { sendFallDraftError(res, caught); }
});

router.post("/:id/canonical-drafts/review/approve", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const parsed = canonicalDraftApproveRequestSchema.parse(req.body);
    const result = await approveAndPublishFallDraft({
      ...await genericMutationScope(scope, CANONICAL_DRAFT_APPROVE_REQUEST_VERSION, parsed.confirmedReviewFingerprint),
      request: { ...parsed, contractVersion: "fall-draft-approve-request/1" },
    });
    sendSuccess(res, genericMutationResult(result), result.mode === "applied" ? 201 : 200);
  } catch (caught) { sendFallDraftError(res, caught); }
});

router.post("/:id/canonical-drafts/review/reject", async (req: Request, res) => {
  const scope = requireAdminScope(req, res);
  if (!scope) return;
  try {
    const parsed = canonicalDraftRejectRequestSchema.parse(req.body);
    const result = await rejectFallDraft({
      ...await genericMutationScope(scope, CANONICAL_DRAFT_REJECT_REQUEST_VERSION, parsed.confirmedReviewFingerprint),
      request: { ...parsed, contractVersion: "fall-draft-reject-request/1" },
    });
    sendSuccess(res, genericMutationResult(result), result.mode === "applied" ? 201 : 200);
  } catch (caught) { sendFallDraftError(res, caught); }
});

export default router;
