import { z } from "zod";
import { fallDraftSha256 } from "./fall-draft-generation";

export const FALL_DRAFT_REVIEW_CONTRACT_VERSION = "fall-draft-review/1";
export const FALL_DRAFT_REVIEW_FINGERPRINT_VERSION = "fall-draft-review-fingerprint/1";
export const FALL_DRAFT_MUTATION_RESULT_VERSION = "fall-draft-mutation-result/1";
export const FALL_DRAFT_RESCHEDULE_REQUEST_VERSION = "fall-draft-reschedule-request/1";
export const FALL_DRAFT_CANCEL_REQUEST_VERSION = "fall-draft-cancel-request/1";
export const FALL_DRAFT_RESTORE_REQUEST_VERSION = "fall-draft-restore-request/1";
export const FALL_DRAFT_APPROVE_REQUEST_VERSION = "fall-draft-approve-request/1";
export const FALL_DRAFT_REJECT_REQUEST_VERSION = "fall-draft-reject-request/1";
export const FALL_DRAFT_DISCREPANCY_REVISION_SNAPSHOT_VERSION = 1;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const idempotencyKeySchema = z.string().min(1).max(255)
  .refine((value) => value.trim() === value, "idempotencyKey must be trimmed");
const reasonSchema = z.string().min(1).max(2_000)
  .refine((value) => value.trim() === value, "reason must be trimmed");
const entityRevisionSchema = z.number().int().positive();

const mutationBase = {
  confirmedReviewFingerprint: fingerprintSchema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const fallDraftRescheduleRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_RESCHEDULE_REQUEST_VERSION),
  ...mutationBase,
  occurrenceId: z.uuid(),
  expectedOccurrenceRevision: entityRevisionSchema,
  authoritativeLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  authoritativeLocalStartTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  timezone: z.string().min(1).max(128).refine((value) => value.trim() === value, "timezone must be trimmed"),
  ambiguousFold: z.enum(["reject", "earlier", "later"]),
  startAt: z.iso.datetime({ offset: false }).optional(),
  selectedUtcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  foldResolution: z.enum(["unambiguous", "earlier", "later"]).optional(),
  resolverVersion: z.string().min(1).max(128).optional(),
}).strict();

export const fallDraftCancelRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_CANCEL_REQUEST_VERSION),
  ...mutationBase,
  occurrenceId: z.uuid(),
  expectedOccurrenceRevision: entityRevisionSchema,
}).strict();

export const fallDraftRestoreRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_RESTORE_REQUEST_VERSION),
  ...mutationBase,
  occurrenceId: z.uuid(),
  expectedOccurrenceRevision: entityRevisionSchema,
}).strict();

export const fallDraftDiscrepancyDispositionSchema = z.object({
  discrepancyId: z.uuid(),
  disposition: z.enum(["resolved", "waived"]),
}).strict();

export const fallDraftApproveRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_APPROVE_REQUEST_VERSION),
  ...mutationBase,
  discrepancyDispositions: z.array(fallDraftDiscrepancyDispositionSchema),
}).strict();

export const fallDraftRejectRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_REJECT_REQUEST_VERSION),
  ...mutationBase,
}).strict();

export type FallDraftRescheduleRequest = z.infer<typeof fallDraftRescheduleRequestSchema>;
export type FallDraftCancelRequest = z.infer<typeof fallDraftCancelRequestSchema>;
export type FallDraftRestoreRequest = z.infer<typeof fallDraftRestoreRequestSchema>;
export type FallDraftApproveRequest = z.infer<typeof fallDraftApproveRequestSchema>;
export type FallDraftRejectRequest = z.infer<typeof fallDraftRejectRequestSchema>;
export type FallDraftDiscrepancyDisposition = z.infer<typeof fallDraftDiscrepancyDispositionSchema>;

export interface FallDraftReviewCommand {
  id: string;
  commandType: string;
  actorUserId: number;
  reason: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  sameDayOverride: boolean;
  outcome: string;
}

export interface FallDraftReviewOccurrenceRevision {
  id: string;
  occurrenceId: string;
  commandId: string;
  revisionNumber: number;
  snapshotSchemaVersion: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}

export interface FallDraftReviewBillingTermRevision {
  id: string;
  billingTermId: string;
  commandId: string;
  revisionNumber: number;
  snapshotSchemaVersion: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}

export interface FallDraftReviewExceptionRevision {
  id: string;
  exceptionId: string;
  commandId: string;
  revisionNumber: number;
  snapshotSchemaVersion: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}

export interface FallDraftReviewDiscrepancyRevision {
  id: string;
  discrepancyId: string;
  commandId: string;
  revisionNumber: number;
  snapshotSchemaVersion: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}

export interface FallDraftReviewOccurrence {
  id: string;
  generationKey: string;
  generationRunId: string | null;
  locationId: number;
  kind: string;
  status: string;
  lifecycle: string;
  authoritativeLocalDate: string;
  authoritativeLocalStartTime: string;
  timezone: string;
  startAt: string;
  selectedUtcOffsetMinutes: number;
  foldResolution: string;
  resolverVersion: string;
  plannedOrdinal: number | null;
  competitionNumber: number | null;
  competitive: boolean;
  countsInStandings: boolean;
  currentRevision: number;
  lastCommandId: string | null;
  publishedAt: string | null;
  publishedByUserId: number | null;
  publicationCommandId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: number | null;
  cancellationCommandId: string | null;
  lockedAt: string | null;
  lockedByUserId: number | null;
  lockReason: string | null;
  lockCommandId: string | null;
  completedAt: string | null;
  completedByUserId: number | null;
  completionCommandId: string | null;
  discardedAt: string | null;
  discardedByUserId: number | null;
  discardCommandId: string | null;
  effectivelyLocked: boolean;
  revisions: FallDraftReviewOccurrenceRevision[];
}

export interface FallDraftReviewBillingTerm {
  id: string;
  occurrenceId: string;
  purpose: string;
  obligationPolicy: string;
  defaultAmountMinor: number;
  currency: string;
  billingOrdinal: number | null;
  version: number;
  state: string;
  currentRevision: number;
  lastCommandId: string | null;
  publishedAt: string | null;
  publishedByUserId: number | null;
  publicationCommandId: string | null;
  supersededAt: string | null;
  supersededByCommandId: string | null;
  revisions: FallDraftReviewBillingTermRevision[];
}

export interface FallDraftReviewException {
  id: string;
  kind: string;
  localDate: string;
  timezone: string;
  source: string;
  lifecycle: string;
  reason: string;
  generationRunId: string | null;
  currentRevision: number;
  lastCommandId: string | null;
  publishedAt: string | null;
  publishedByUserId: number | null;
  publicationCommandId: string | null;
  revokedAt: string | null;
  revokedByUserId: number | null;
  revocationCommandId: string | null;
  revisions: FallDraftReviewExceptionRevision[];
}

export interface FallDraftReviewDiscrepancy {
  id: string;
  severity: string;
  code: string;
  generationKey: string | null;
  details: unknown;
  resolutionState: string;
  resolutionCommandId: string | null;
  resolvedAt: string | null;
  currentEvidence: unknown;
  canResolve: boolean;
  revisions: FallDraftReviewDiscrepancyRevision[];
}

export interface FallDraftReview {
  reviewContractVersion: typeof FALL_DRAFT_REVIEW_CONTRACT_VERSION;
  reviewFingerprintVersion: typeof FALL_DRAFT_REVIEW_FINGERPRINT_VERSION;
  reviewFingerprint: string;
  organizationId: number;
  leagueId: number;
  generationRun: {
    id: string;
    state: string;
    originatingCommandId: string;
    generatorVersion: string;
    inputFingerprint: string;
    sourceScheduleRevision: number;
    normalizedInputSnapshot: unknown;
    rangeStartDate: string;
    rangeEndDate: string;
    candidateOccurrenceCount: number;
    generatedOccurrenceCount: number;
    skippedDateCount: number;
    discrepancyCount: number;
    approvedAt: string | null;
    approvedByUserId: number | null;
    approvalCommandId: string | null;
    rejectedAt: string | null;
    rejectedByUserId: number | null;
    rejectionReason: string | null;
    rejectionCommandId: string | null;
    supersededAt: string | null;
    supersededByCommandId: string | null;
  };
  c1: {
    inputSnapshotVersion: string;
    confirmedPreviewFingerprint: string;
    candidateSetFingerprint: string;
    inputFingerprint: string;
    physicalScheduleFingerprint: string;
    generatorVersion: string;
    resultContractVersion: string;
    dstResolverVersion: string;
  };
  currentLegacyInput: {
    matches: boolean;
    currentInputFingerprint: string | null;
    generatedInputFingerprint: string;
  };
  occurrences: FallDraftReviewOccurrence[];
  billingTerms: FallDraftReviewBillingTerm[];
  scheduleExceptions: FallDraftReviewException[];
  discrepancies: FallDraftReviewDiscrepancy[];
  commands: FallDraftReviewCommand[];
}

export interface FallDraftMutationResult {
  resultContractVersion: typeof FALL_DRAFT_MUTATION_RESULT_VERSION;
  operation: "reschedule" | "cancel" | "restore" | "approve_publish" | "reject";
  mode: "applied" | "idempotent_retry";
  commandIds: string[];
  durableEntityIds: string[];
  review: FallDraftReview;
  writesPerformed: boolean;
  legacyWritesPerformed: false;
  paymentOrProviderWritesPerformed: false;
}

export function fallDraftReviewFingerprint<T extends object>(review: T): string {
  const { reviewFingerprint: _ignored, ...semantic } = review as T & { reviewFingerprint?: unknown };
  const semanticValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(semanticValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "effectivelyLocked" && key !== "actorUserId" && !key.endsWith("ByUserId"))
      .map(([key, nested]) => [key, semanticValue(nested)]));
  };
  return fallDraftSha256({
    fingerprintVersion: FALL_DRAFT_REVIEW_FINGERPRINT_VERSION,
    review: semanticValue(semantic),
  });
}
