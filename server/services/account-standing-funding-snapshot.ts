import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccountPaymentOperationSnapshot as StoredAccountPaymentOperationSnapshot } from "@shared/schema/account-payment-operations";
import { ACCOUNT_STANDING_FUNDING_SNAPSHOT_VERSION } from "@shared/schema/account-payment-operations";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";

export const ACCOUNT_STANDING_FUNDING_SNAPSHOT_FINGERPRINT_PREFIX = "lvstandingfunding:v1:" as const;

const moneyMinor = z.number().int().min(0).max(2_147_483_647);
const positiveId = z.number().int().positive().max(2_147_483_647);
const fundingPortionSchema = z.object({
  portionIndex: z.number().int().min(0).max(199),
  creditedBowlerId: positiveId,
  amountMinor: z.number().int().positive().max(2_147_483_647),
}).strict();

const recipientEvidenceSchema = z.object({
  recipientBowlerId: positiveId,
  role: z.enum(["self", "partner"]),
  paymentLinkId: positiveId.nullable(),
  linkFingerprint: z.string().regex(/^lvpartnerlink:v1:[0-9a-f]{64}$/).nullable(),
  target: z.object({
    confirmedDebtMinor: moneyMinor,
    olderConfirmedDebtMinor: moneyMinor,
    availableCreditMinor: moneyMinor,
    creditAppliedToOlderDebtMinor: moneyMinor,
    olderConfirmedDebtRemainingMinor: moneyMinor,
    olderDebtReviewRequired: z.boolean(),
    currentDebtReviewRequired: z.boolean(),
    currentCollectionTargetMinor: moneyMinor,
    forecastCollectionTargetMinor: moneyMinor,
    newChargeMinor: moneyMinor,
  }).strict(),
}).strict().superRefine((evidence, context) => {
  if (evidence.role === "self" && (evidence.paymentLinkId !== null || evidence.linkFingerprint !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentLinkId"], message: "self evidence cannot contain a payment link" });
  }
  if (evidence.role === "partner" && (evidence.paymentLinkId === null || evidence.linkFingerprint === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentLinkId"], message: "partner evidence requires an accepted payment link" });
  }
});

const standingEvidenceSchema = z.object({
  consentId: z.string().uuid(),
  consentVersion: z.number().int().positive().max(2_147_483_647),
  consentFingerprint: z.string().regex(/^lvstandingconsent:v1:[0-9a-f]{64}$/),
  bindingEvidenceFingerprint: z.string().regex(/^lvstandingcutoff:v1:[0-9a-f]{64}$/),
  cutoffAt: z.string().datetime({ offset: true }),
  collectionMode: z.enum(["weekly", "double_pay"]),
  triggerOccurrenceId: z.string().uuid(),
  triggerOccurrenceRevision: z.number().int().positive().max(2_147_483_647),
  pairedOccurrenceId: z.string().uuid().nullable(),
  collectionGroupId: z.string().uuid().nullable(),
  collectionGroupRevision: z.number().int().positive().max(2_147_483_647).nullable(),
  collectionGroupFingerprint: z.string().regex(/^lvcollectiongroup:v1:[0-9a-f]{64}$/).nullable(),
  triggerMemberId: z.string().uuid().nullable(),
  pairedMemberId: z.string().uuid().nullable(),
  collectionRequirementOccurrenceIds: z.array(z.string().uuid()).min(1).max(1000),
}).strict().superRefine((evidence, context) => {
  if (new Set(evidence.collectionRequirementOccurrenceIds).size !== evidence.collectionRequirementOccurrenceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["collectionRequirementOccurrenceIds"], message: "collection requirement occurrences must be unique" });
  }
  if (!evidence.collectionRequirementOccurrenceIds.includes(evidence.triggerOccurrenceId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["collectionRequirementOccurrenceIds"], message: "the trigger occurrence must be part of the frozen target" });
  }
  if (evidence.collectionMode === "double_pay") {
    if (!evidence.pairedOccurrenceId || !evidence.collectionGroupId || !evidence.collectionGroupRevision
      || !evidence.collectionGroupFingerprint || !evidence.triggerMemberId || !evidence.pairedMemberId
      || evidence.pairedOccurrenceId === evidence.triggerOccurrenceId
      || !evidence.collectionRequirementOccurrenceIds.includes(evidence.pairedOccurrenceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["collectionMode"], message: "double-pay evidence requires the exact published trigger and paired members" });
    }
  } else if (evidence.pairedOccurrenceId !== null || evidence.collectionGroupId !== null
    || evidence.collectionGroupRevision !== null || evidence.collectionGroupFingerprint !== null
    || evidence.triggerMemberId !== null || evidence.pairedMemberId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["collectionMode"], message: "weekly evidence cannot contain a double-pay group" });
  }
});

const semanticSchema = z.object({
  snapshotVersion: z.literal(ACCOUNT_STANDING_FUNDING_SNAPSHOT_VERSION),
  snapshotKind: z.literal("standing_funding"),
  operationId: z.string().uuid(),
  operationType: z.literal("standing_autopay_charge"),
  organizationId: positiveId,
  leagueId: positiveId,
  payerBowlerId: positiveId,
  amountMinor: z.number().int().positive().max(2_147_483_647),
  fundingPortions: z.array(fundingPortionSchema).min(1).max(200),
  recipientEvidence: z.array(recipientEvidenceSchema).min(1).max(200),
  standingEvidence: standingEvidenceSchema,
  currency: z.literal("USD"),
  providerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  providerIdempotencyKey: z.string().min(1).max(45).regex(/^[A-Za-z0-9_-]+$/),
  locationId: positiveId.nullable(),
  providerLocationId: z.string().trim().min(1).max(255).nullable(),
  authorizingUserId: positiveId,
  requestKind: z.literal("standing"),
}).strict().superRefine((snapshot, context) => {
  const portions = snapshot.fundingPortions;
  if (portions.some((portion, index) => portion.portionIndex !== index)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundingPortions"], message: "recipient portion indexes must be contiguous and ordered" });
  }
  if (new Set(portions.map((portion) => portion.creditedBowlerId)).size !== portions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundingPortions"], message: "each recipient may have only one funding portion" });
  }
  if (portions.reduce((sum, portion) => sum + portion.amountMinor, 0) !== snapshot.amountMinor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundingPortions"], message: "recipient funding portions must equal the provider operation amount" });
  }

  const evidenceByRecipient = new Map<number, z.infer<typeof recipientEvidenceSchema>>();
  for (const [index, evidence] of snapshot.recipientEvidence.entries()) {
    if (evidenceByRecipient.has(evidence.recipientBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientEvidence", index], message: "recipient evidence must be unique" });
    }
    evidenceByRecipient.set(evidence.recipientBowlerId, evidence);
    if ((evidence.role === "self") !== (evidence.recipientBowlerId === snapshot.payerBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientEvidence", index, "recipientBowlerId"], message: "recipient role does not match the original payer" });
    }
    const target = evidence.target;
    const creditApplied = Math.min(target.availableCreditMinor, target.olderConfirmedDebtMinor);
    const olderRemaining = target.olderConfirmedDebtMinor - creditApplied;
    const creditForCollection = target.availableCreditMinor - creditApplied;
    const expectedCharge = target.olderDebtReviewRequired || target.currentDebtReviewRequired || olderRemaining > 0
      ? 0
      : Math.max(0, target.currentCollectionTargetMinor - creditForCollection);
    if (target.confirmedDebtMinor < target.olderConfirmedDebtMinor
      || target.currentCollectionTargetMinor !== target.confirmedDebtMinor - target.olderConfirmedDebtMinor + target.forecastCollectionTargetMinor
      || target.creditAppliedToOlderDebtMinor !== creditApplied
      || target.olderConfirmedDebtRemainingMinor !== olderRemaining
      || target.forecastCollectionTargetMinor > target.currentCollectionTargetMinor
      || target.newChargeMinor !== expectedCharge) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientEvidence", index, "target"], message: "standing account target arithmetic is inconsistent" });
    }
  }

  for (const [index, portion] of portions.entries()) {
    const evidence = evidenceByRecipient.get(portion.creditedBowlerId);
    if (!evidence || evidence.target.newChargeMinor !== portion.amountMinor) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundingPortions", index], message: "every funded recipient requires matching positive standing target evidence" });
    }
    if ((portion.creditedBowlerId === snapshot.payerBowlerId) !== (evidence?.role === "self")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundingPortions", index, "creditedBowlerId"], message: "recipient role does not match the original payer" });
    }
  }
  for (const evidence of snapshot.recipientEvidence) {
    if (evidence.target.newChargeMinor > 0 && !portions.some((portion) => portion.creditedBowlerId === evidence.recipientBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientEvidence"], message: "a positive standing charge target is missing its funding portion" });
    }
  }
});

export type AccountStandingFundingSnapshotSemantic = z.infer<typeof semanticSchema>;
export type AccountStandingFundingSnapshotInput = Omit<AccountStandingFundingSnapshotSemantic,
  "snapshotVersion" | "snapshotKind" | "operationType" | "requestKind">;
export type AccountStandingFundingSnapshotBuildInput = Omit<AccountStandingFundingSnapshotInput,
  "operationId" | "providerIdempotencyKey">;

export type AccountStandingFundingOperationIdentity = {
  id: string;
  operationType: string;
  organizationId: number;
  leagueId: number | null;
  amountMinor: number;
  currency: string;
  providerName: string;
  providerIdempotencyKey: string;
  authorizingUserId: number | null;
};

export type StoredAccountStandingFundingSnapshotFields = Omit<StoredAccountPaymentOperationSnapshot, "createdAt">;

export class AccountStandingFundingSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountStandingFundingSnapshotValidationError";
  }
}

function normalize(value: unknown): AccountStandingFundingSnapshotSemantic {
  const parsed = semanticSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccountStandingFundingSnapshotValidationError("standing funding operation snapshot is invalid", { cause: parsed.error });
  }
  return parsed.data;
}

export function validateAccountStandingFundingSnapshot(value: unknown): AccountStandingFundingSnapshotSemantic {
  return normalize(value);
}

export function buildAccountStandingFundingSnapshot(
  operation: Pick<AccountStandingFundingOperationIdentity, "id" | "providerIdempotencyKey">,
  input: AccountStandingFundingSnapshotBuildInput,
): AccountStandingFundingSnapshotSemantic {
  return normalize({
    ...input,
    snapshotVersion: ACCOUNT_STANDING_FUNDING_SNAPSHOT_VERSION,
    snapshotKind: "standing_funding",
    operationId: operation.id,
    operationType: "standing_autopay_charge",
    providerIdempotencyKey: operation.providerIdempotencyKey,
    requestKind: "standing",
  });
}

export function fingerprintAccountStandingFundingSnapshot(
  snapshot: AccountStandingFundingSnapshotInput | AccountStandingFundingSnapshotSemantic,
): string {
  const normalized = normalize({
    ...snapshot,
    snapshotVersion: ACCOUNT_STANDING_FUNDING_SNAPSHOT_VERSION,
    snapshotKind: "standing_funding",
    operationType: "standing_autopay_charge",
    requestKind: "standing",
  });
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex");
  return `${ACCOUNT_STANDING_FUNDING_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}

export function storeAccountStandingFundingSnapshot(
  snapshot: AccountStandingFundingSnapshotInput | AccountStandingFundingSnapshotSemantic,
): StoredAccountStandingFundingSnapshotFields {
  const normalized = normalize({
    ...snapshot,
    snapshotVersion: ACCOUNT_STANDING_FUNDING_SNAPSHOT_VERSION,
    snapshotKind: "standing_funding",
    operationType: "standing_autopay_charge",
    requestKind: "standing",
  });
  return {
    snapshotVersion: normalized.snapshotVersion,
    snapshotKind: normalized.snapshotKind,
    operationId: normalized.operationId,
    organizationId: normalized.organizationId,
    leagueId: normalized.leagueId,
    payerBowlerId: normalized.payerBowlerId,
    amountMinor: normalized.amountMinor,
    fundingPortions: normalized.fundingPortions,
    recipientEvidence: normalized.recipientEvidence,
    standingEvidence: normalized.standingEvidence,
    currency: normalized.currency,
    providerName: normalized.providerName,
    locationId: normalized.locationId,
    providerLocationId: normalized.providerLocationId,
    authorizingUserId: normalized.authorizingUserId,
    requestKind: normalized.requestKind,
    sourceKind: null,
    encryptedSourceId: null,
    encryptedCustomerId: null,
    encryptedBuyerEmail: null,
    storeCard: false,
    quoteFingerprint: null,
    snapshotFingerprint: fingerprintAccountStandingFundingSnapshot(normalized),
  };
}

export type AccountStandingFundingExecutionSnapshot = AccountStandingFundingSnapshotSemantic & {
  kind: "account_standing_funding";
  snapshotFingerprint: string;
  allocations: [];
  lineItems: [];
};

export function reconstructAccountStandingFundingSnapshot(input: {
  operation: AccountStandingFundingOperationIdentity;
  stored: StoredAccountPaymentOperationSnapshot;
}): AccountStandingFundingExecutionSnapshot {
  const { operation, stored } = input;
  if (stored.snapshotVersion !== ACCOUNT_STANDING_FUNDING_SNAPSHOT_VERSION || stored.snapshotKind !== "standing_funding") {
    throw new AccountStandingFundingSnapshotValidationError("standing funding operation snapshot version is unsupported");
  }
  if (stored.requestKind !== "standing" || stored.standingEvidence === null
    || stored.sourceKind !== null || stored.encryptedSourceId !== null || stored.encryptedCustomerId !== null
    || stored.encryptedBuyerEmail !== null || stored.storeCard || stored.quoteFingerprint !== null) {
    throw new AccountStandingFundingSnapshotValidationError("standing funding snapshot contains incompatible payment-source evidence");
  }
  if (stored.operationId !== operation.id || stored.organizationId !== operation.organizationId
    || stored.leagueId !== operation.leagueId || stored.amountMinor !== operation.amountMinor
    || stored.currency !== operation.currency || stored.providerName !== operation.providerName
    || stored.authorizingUserId !== operation.authorizingUserId) {
    throw new AccountStandingFundingSnapshotValidationError("standing funding snapshot provenance does not match its payment operation");
  }
  const semantic = normalize({
    snapshotVersion: stored.snapshotVersion,
    snapshotKind: stored.snapshotKind,
    operationId: operation.id,
    operationType: operation.operationType,
    organizationId: operation.organizationId,
    leagueId: operation.leagueId,
    payerBowlerId: stored.payerBowlerId,
    amountMinor: operation.amountMinor,
    fundingPortions: stored.fundingPortions,
    recipientEvidence: stored.recipientEvidence,
    standingEvidence: stored.standingEvidence,
    currency: operation.currency,
    providerName: operation.providerName,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    locationId: stored.locationId,
    providerLocationId: stored.providerLocationId,
    authorizingUserId: operation.authorizingUserId,
    requestKind: stored.requestKind,
  });
  const snapshotFingerprint = fingerprintAccountStandingFundingSnapshot(semantic);
  if (snapshotFingerprint !== stored.snapshotFingerprint) {
    throw new AccountStandingFundingSnapshotValidationError("standing funding snapshot fingerprint does not match its immutable contents");
  }
  return { ...semantic, kind: "account_standing_funding", snapshotFingerprint, allocations: [], lineItems: [] };
}
