import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BillingOrdinalPolicy,
  CanonicalBillingTermCandidate,
  CanonicalExceptionCandidate,
  CanonicalGenerationDiscrepancy,
  CanonicalGenerationError,
  CanonicalGenerationResult,
  CanonicalNormalizedInput,
  CanonicalOccurrenceCandidate,
} from "./canonical-occurrence-generator";
import type { PaymentMode } from "./schema/constants";
export const FALL_DRAFT_AMBIGUOUS_FOLD_POLICY = "reject" as const;
export const FALL_DRAFT_CURRENCY = "USD" as const;
export const FALL_DRAFT_REGULAR_SESSION_BILLING_POLICY = "eligible_bowlers" as const;
export const FALL_DRAFT_BILLING_ORDINAL_POLICY = "dense_billable" as const satisfies BillingOrdinalPolicy;
export const FALL_DRAFT_PREVIEW_REQUEST_VERSION = "fall-draft-preview-request/3";
export const FALL_DRAFT_PREVIEW_CONTRACT_VERSION = "fall-draft-generation-preview/3";
export const FALL_DRAFT_APPLY_REQUEST_VERSION = "fall-draft-apply-request/3";
export const FALL_DRAFT_APPLY_RESULT_VERSION = "fall-draft-generation-result/3";
export const FALL_DRAFT_IMPLEMENTATION_VERSION = "fall-draft-generation/3";
export const FALL_DRAFT_MAPPING_VERSION = "fall-draft-mapping/1";
export const FALL_DRAFT_OCCURRENCE_REVISION_SNAPSHOT_VERSION = 1;
export const FALL_DRAFT_BILLING_TERM_REVISION_SNAPSHOT_VERSION = 1;
export const FALL_DRAFT_EXCEPTION_REVISION_SNAPSHOT_VERSION = 1;

export const fallDraftPreviewRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_PREVIEW_REQUEST_VERSION),
}).strict();

export const fallDraftApplyRequestSchema = z.object({
  contractVersion: z.literal(FALL_DRAFT_APPLY_REQUEST_VERSION),
  confirmedPreviewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().min(1).max(2_000).refine((value) => value.trim() === value, "reason must be trimmed"),
  idempotencyKey: z.string().min(1).max(255).refine((value) => value.trim() === value, "idempotencyKey must be trimmed"),
}).strict();

export type FallDraftPreviewRequest = z.infer<typeof fallDraftPreviewRequestSchema>;
export type FallDraftApplyRequest = z.infer<typeof fallDraftApplyRequestSchema>;

/**
 * League payment mode controls collection timing, not whether a scheduled
 * session creates a bowling obligation. Both supported modes therefore use
 * the same canonical regular-session billing policy.
 */
export function fallDraftRegularSessionBillingPolicyForPaymentMode(
  _paymentMode: PaymentMode,
): typeof FALL_DRAFT_REGULAR_SESSION_BILLING_POLICY {
  return FALL_DRAFT_REGULAR_SESSION_BILLING_POLICY;
}

export interface FallDraftExistingGenerationSummary {
  generationRunId: string;
  originatingCommandId: string;
  state: string;
  generatorVersion: string;
  inputFingerprint: string;
  sourceScheduleRevision: number;
  occurrenceCount: number;
  billingTermCount: number;
  exceptionCount: number;
  discrepancyCount: number;
}

export interface FallDraftExistingCanonicalState {
  commandCount: number;
  generationRunCount: number;
  occurrenceCount: number;
  billingTermCount: number;
  exceptionCount: number;
  relationshipCount: number;
  occurrenceRevisionCount: number;
  billingTermRevisionCount: number;
  exceptionRevisionCount: number;
  discrepancyCount: number;
  generationRuns: FallDraftExistingGenerationSummary[];
}

export interface FallDraftOccurrencePreviewCandidate extends CanonicalOccurrenceCandidate {
  lifecycleIntent: "draft";
  cancellationMetadataIntent: "none" | "generation_action_time";
}

export interface FallDraftBillingTermPreviewCandidate extends CanonicalBillingTermCandidate {
  stateIntent: "draft";
  policySnapshotOnly: true;
}

export interface FallDraftExceptionPreviewCandidate extends CanonicalExceptionCandidate {
  lifecycleIntent: "draft";
}

export interface FallDraftPreview {
  previewContractVersion: typeof FALL_DRAFT_PREVIEW_CONTRACT_VERSION;
  previewRequestContractVersion: typeof FALL_DRAFT_PREVIEW_REQUEST_VERSION;
  implementationVersion: typeof FALL_DRAFT_IMPLEMENTATION_VERSION;
  mappingVersion: typeof FALL_DRAFT_MAPPING_VERSION;
  generatorVersion: string;
  inputContractVersion: string;
  resultContractVersion: string;
  dstResolverVersion: string;
  operatorScope: {
    organizationId: number;
    leagueId: number;
    locationId: number;
  };
  semantics: {
    paymentMode: PaymentMode;
    ambiguousFold: typeof FALL_DRAFT_AMBIGUOUS_FOLD_POLICY;
    currency: typeof FALL_DRAFT_CURRENCY;
    regularSessionBillingPolicy: typeof FALL_DRAFT_REGULAR_SESSION_BILLING_POLICY;
    billingOrdinalPolicy: typeof FALL_DRAFT_BILLING_ORDINAL_POLICY;
  };
  eligibility: {
    active: true;
    archived: false;
    seasonClassification: "Fall";
    whollyFutureFacing: boolean;
    eligibleForApply: boolean;
    blockers: string[];
  };
  normalizedInput: CanonicalNormalizedInput;
  inputFingerprint: string;
  physicalScheduleFingerprint: string;
  candidateSetFingerprint: string;
  previewFingerprint: string;
  proposedSourceScheduleRevision: {
    value: number;
    reserved: false;
  };
  generationRange: CanonicalGenerationResult["generationRange"];
  occurrenceCandidates: FallDraftOccurrencePreviewCandidate[];
  billingTermCandidates: FallDraftBillingTermPreviewCandidate[];
  exceptionCandidates: FallDraftExceptionPreviewCandidate[];
  fatalErrors: CanonicalGenerationError[];
  discrepancies: CanonicalGenerationDiscrepancy[];
  counts: CanonicalGenerationResult["counts"] & {
    existingCanonicalRows: number;
  };
  existingCanonicalState: FallDraftExistingCanonicalState;
  legacyCollectionEvidence: {
    source: "leagues.double_pay_dates";
    doublePayDates: string[];
    excludedFromCanonicalGeneration: true;
    excludedFromPhysicalScheduleFingerprint: true;
    excludedFromBillingTermsAndAmounts: true;
  };
  draftMapping: {
    occurrenceLifecycle: "draft";
    scheduledStatus: "scheduled";
    cancelledStatus: "cancelled";
    billingTermState: "draft";
    skipExceptionLifecycle: "draft";
    cancellationTimestamp: "generation_action_time";
    approvalMetadata: "none";
    publicationMetadata: "none";
    lockMetadata: "none";
    relationshipMaterialization: "none";
    paymentObligationOrCollectionMaterialization: "none";
    occurrenceRevisionSnapshotVersion: 1;
    billingTermRevisionSnapshotVersion: 1;
    exceptionRevisionSnapshotVersion: 1;
  };
}

export interface FallDraftDurableIds {
  commandIds: string[];
  generationRunId: string;
  occurrenceIds: string[];
  billingTermIds: string[];
  exceptionIds: string[];
  occurrenceRevisionIds: string[];
  billingTermRevisionIds: string[];
  exceptionRevisionIds: string[];
  discrepancyIds: string[];
}

export interface FallDraftApplyResult {
  resultContractVersion: typeof FALL_DRAFT_APPLY_RESULT_VERSION;
  previewContractVersion: typeof FALL_DRAFT_PREVIEW_CONTRACT_VERSION;
  implementationVersion: typeof FALL_DRAFT_IMPLEMENTATION_VERSION;
  mappingVersion: typeof FALL_DRAFT_MAPPING_VERSION;
  mode: "applied" | "idempotent_retry";
  organizationId: number;
  leagueId: number;
  confirmedPreviewFingerprint: string;
  requestFingerprint: string;
  inputFingerprint: string;
  physicalScheduleFingerprint: string;
  candidateSetFingerprint: string;
  sourceScheduleRevision: number;
  durableIds: FallDraftDurableIds;
  counts: {
    commands: number;
    occurrences: number;
    scheduledOccurrences: number;
    cancelledOccurrences: number;
    billingTerms: number;
    exceptions: number;
    discrepancies: number;
  };
  writesPerformed: boolean;
  legacyWritesPerformed: false;
  relationshipsCreated: false;
  paymentObligationOrCollectionRowsCreated: false;
  currentLegacyScheduleMatchesGenerationInput: boolean;
}

export interface FallDraftPersistedView {
  found: boolean;
  result: FallDraftApplyResult | null;
  currentLegacyScheduleMatchesGenerationInput: boolean | null;
  /** True once C2 owns the mutable lifecycle; use the C2 review endpoint for exact current state. */
  transitionedToC2?: boolean;
  generationRunId?: string | null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function fallDraftCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(fallDraftCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareStrings).map((key) => `${JSON.stringify(key)}:${fallDraftCanonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON cannot contain undefined or unsupported values");
}

export function fallDraftSha256(value: unknown): string {
  return createHash("sha256").update(fallDraftCanonicalJson(value), "utf8").digest("hex");
}

export function fallDraftCandidateSetFingerprint(generation: CanonicalGenerationResult): string {
  return fallDraftSha256({
    occurrenceCandidates: generation.occurrenceCandidates,
    billingTermCandidates: generation.billingTermCandidates,
    exceptionCandidates: generation.exceptionCandidates,
    fatalErrors: generation.fatalErrors,
    discrepancies: generation.discrepancies,
  });
}

export function fallDraftPreviewFingerprint<T extends object>(preview: T): string {
  const { previewFingerprint: _ignored, ...semantic } = preview as T & { previewFingerprint?: unknown };
  return fallDraftSha256(semantic);
}
