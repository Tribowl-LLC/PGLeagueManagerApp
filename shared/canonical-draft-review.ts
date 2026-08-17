import { z } from "zod";
import type {
  FallDraftMutationResult,
  FallDraftReview,
} from "./fall-draft-review";
import { fallDraftSha256 } from "./fall-draft-generation";

export const CANONICAL_DRAFT_REVIEW_CONTRACT_VERSION = "canonical-draft-review/1";
export const CANONICAL_DRAFT_REVIEW_FINGERPRINT_VERSION = "canonical-draft-review-fingerprint/1";
export const CANONICAL_DRAFT_MUTATION_RESULT_VERSION = "canonical-draft-mutation-result/1";
export const CANONICAL_DRAFT_RESCHEDULE_REQUEST_VERSION = "canonical-draft-reschedule-request/1";
export const CANONICAL_DRAFT_CANCEL_REQUEST_VERSION = "canonical-draft-cancel-request/1";
export const CANONICAL_DRAFT_RESTORE_REQUEST_VERSION = "canonical-draft-restore-request/1";
export const CANONICAL_DRAFT_APPROVE_REQUEST_VERSION = "canonical-draft-approve-request/1";
export const CANONICAL_DRAFT_REJECT_REQUEST_VERSION = "canonical-draft-reject-request/1";

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const idempotencyKeySchema = z.string().min(1).max(255)
  .refine((value) => value.trim() === value, "idempotencyKey must be trimmed");
const reasonSchema = z.string().min(1).max(2_000)
  .refine((value) => value.trim() === value, "reason must be trimmed");
const mutationBase = {
  confirmedReviewFingerprint: fingerprintSchema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const canonicalDraftRescheduleRequestSchema = z.object({
  contractVersion: z.literal(CANONICAL_DRAFT_RESCHEDULE_REQUEST_VERSION),
  ...mutationBase,
  occurrenceId: z.uuid(),
  expectedOccurrenceRevision: z.number().int().positive(),
  authoritativeLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  authoritativeLocalStartTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  timezone: z.string().min(1).max(128).refine((value) => value.trim() === value, "timezone must be trimmed"),
  startAt: z.iso.datetime({ offset: false }).optional(),
  selectedUtcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  foldResolution: z.literal("unambiguous").optional(),
  resolverVersion: z.string().min(1).max(128).optional(),
}).strict();

export const canonicalDraftCancelRequestSchema = z.object({
  contractVersion: z.literal(CANONICAL_DRAFT_CANCEL_REQUEST_VERSION),
  ...mutationBase,
  occurrenceId: z.uuid(),
  expectedOccurrenceRevision: z.number().int().positive(),
}).strict();

export const canonicalDraftRestoreRequestSchema = z.object({
  contractVersion: z.literal(CANONICAL_DRAFT_RESTORE_REQUEST_VERSION),
  ...mutationBase,
  occurrenceId: z.uuid(),
  expectedOccurrenceRevision: z.number().int().positive(),
}).strict();

export const canonicalDraftApproveRequestSchema = z.object({
  contractVersion: z.literal(CANONICAL_DRAFT_APPROVE_REQUEST_VERSION),
  ...mutationBase,
  discrepancyDispositions: z.array(z.object({
    discrepancyId: z.uuid(),
    disposition: z.enum(["resolved", "waived"]),
  }).strict()),
}).strict();

export const canonicalDraftRejectRequestSchema = z.object({
  contractVersion: z.literal(CANONICAL_DRAFT_REJECT_REQUEST_VERSION),
  ...mutationBase,
}).strict();

export type CanonicalDraftRescheduleRequest = z.infer<typeof canonicalDraftRescheduleRequestSchema>;
export type CanonicalDraftCancelRequest = z.infer<typeof canonicalDraftCancelRequestSchema>;
export type CanonicalDraftRestoreRequest = z.infer<typeof canonicalDraftRestoreRequestSchema>;
export type CanonicalDraftApproveRequest = z.infer<typeof canonicalDraftApproveRequestSchema>;
export type CanonicalDraftRejectRequest = z.infer<typeof canonicalDraftRejectRequestSchema>;

export interface CanonicalDraftReview extends Omit<FallDraftReview,
  "reviewContractVersion" | "reviewFingerprintVersion" | "c1"> {
  reviewContractVersion: typeof CANONICAL_DRAFT_REVIEW_CONTRACT_VERSION;
  reviewFingerprintVersion: typeof CANONICAL_DRAFT_REVIEW_FINGERPRINT_VERSION;
  generation: FallDraftReview["c1"] & {
    seasonClassification: "Winter" | "Spring" | "Summer" | "Fall";
  };
}

export interface CanonicalDraftMutationResult extends Omit<FallDraftMutationResult,
  "resultContractVersion" | "review"> {
  resultContractVersion: typeof CANONICAL_DRAFT_MUTATION_RESULT_VERSION;
  review: CanonicalDraftReview;
}

function semanticReviewValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticReviewValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "effectivelyLocked" && key !== "actorUserId" && !key.endsWith("ByUserId"))
    .map(([key, nested]) => [key, semanticReviewValue(nested)]));
}

export function canonicalDraftReviewFingerprint<T extends object>(review: T): string {
  const { reviewFingerprint: _ignored, ...semantic } = review as T & { reviewFingerprint?: unknown };
  return fallDraftSha256({
    fingerprintVersion: CANONICAL_DRAFT_REVIEW_FINGERPRINT_VERSION,
    review: semanticReviewValue(semantic),
  });
}

export function toCanonicalDraftReview(
  review: FallDraftReview,
  seasonClassification: "Winter" | "Spring" | "Summer" | "Fall",
): CanonicalDraftReview {
  const { c1, reviewContractVersion: _contract, reviewFingerprintVersion: _fingerprintVersion,
    reviewFingerprint: _fingerprint, ...rest } = review;
  const withoutFingerprint: Omit<CanonicalDraftReview, "reviewFingerprint"> = {
    ...rest,
    reviewContractVersion: CANONICAL_DRAFT_REVIEW_CONTRACT_VERSION,
    reviewFingerprintVersion: CANONICAL_DRAFT_REVIEW_FINGERPRINT_VERSION,
    generation: { ...c1, seasonClassification },
  };
  return { ...withoutFingerprint, reviewFingerprint: canonicalDraftReviewFingerprint(withoutFingerprint) };
}
