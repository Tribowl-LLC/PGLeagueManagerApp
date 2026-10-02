import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AccountPaymentOperationSnapshot as StoredAccountPaymentOperationSnapshot,
} from "@shared/schema/account-payment-operations";
import { ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS, ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION } from "@shared/schema/account-payment-operations";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { decrypt, encrypt } from "../utils/crypto.js";
import type { InteractivePartnerPaymentEvidence } from "./interactive-partner-payment-snapshot.js";

export const ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_FINGERPRINT_PREFIX = "lvaccountfunding:v4:" as const;

export type AccountPaymentFundingRecipientEvidenceV4 = Pick<InteractivePartnerPaymentEvidence,
  "recipientBowlerId" | "role" | "paymentLinkId" | "linkFingerprint"
>;

const fundingPortionSchema = z.object({
  portionIndex: z.number().int().min(0),
  creditedBowlerId: z.number().int().positive().max(2_147_483_647),
  amountMinor: z.number().int().positive().max(2_147_483_647),
}).strict();

/** Same accepted-link fingerprint and recipient role fields as V3, without
 * V3's selected-week fields (V4 does not earmark future obligations). */
const recipientEvidenceSchema = z.object({
  recipientBowlerId: z.number().int().positive().max(2_147_483_647),
  role: z.enum(["self", "partner"]),
  paymentLinkId: z.number().int().positive().max(2_147_483_647).nullable(),
  linkFingerprint: z.string().regex(/^lvpartnerlink:v1:[0-9a-f]{64}$/).nullable(),
}).strict().superRefine((evidence, context) => {
  if (evidence.role === "self" && (evidence.paymentLinkId !== null || evidence.linkFingerprint !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentLinkId"], message: "self evidence cannot contain a payment link" });
  }
  if (evidence.role === "partner" && (evidence.paymentLinkId === null || evidence.linkFingerprint === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentLinkId"], message: "partner evidence requires an accepted payment link" });
  }
});

const semanticSchema = z.object({
  snapshotVersion: z.literal(ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION),
  snapshotKind: z.literal(ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS[0]),
  operationId: z.string().uuid(),
  operationType: z.literal("interactive_charge"),
  organizationId: z.number().int().positive().max(2_147_483_647),
  leagueId: z.number().int().positive().max(2_147_483_647),
  payerBowlerId: z.number().int().positive().max(2_147_483_647),
  amountMinor: z.number().int().positive().max(2_147_483_647),
  fundingPortions: z.array(fundingPortionSchema).min(1).max(200),
  recipientEvidence: z.array(recipientEvidenceSchema).min(1).max(200),
  currency: z.literal("USD"),
  providerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  providerIdempotencyKey: z.string().min(1).max(45).regex(/^[A-Za-z0-9_-]+$/),
  locationId: z.number().int().positive().max(2_147_483_647).nullable(),
  providerLocationId: z.string().trim().min(1).max(255).nullable(),
  authorizingUserId: z.number().int().positive().max(2_147_483_647),
  requestKind: z.literal("direct"),
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]),
  sourceId: z.string().trim().min(1).max(255),
  customerId: z.string().trim().min(1).max(255).nullable(),
  buyerEmail: z.string().email().max(255).nullable(),
  storeCard: z.boolean(),
  quoteFingerprint: z.string().regex(/^lvaccountfundquote:v4:[0-9a-f]{64}$/),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.sourceKind === "wallet" && snapshot.storeCard) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["storeCard"], message: "wallet sources cannot be vaulted" });
  }
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
  const evidenceByRecipient = new Map<number, AccountPaymentFundingRecipientEvidenceV4>();
  for (const evidence of snapshot.recipientEvidence) {
    if (evidenceByRecipient.has(evidence.recipientBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientEvidence"], message: "recipient authorization evidence must be unique" });
    }
    evidenceByRecipient.set(evidence.recipientBowlerId, evidence);
  }
  if (evidenceByRecipient.size !== portions.length || portions.some((portion) => !evidenceByRecipient.has(portion.creditedBowlerId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientEvidence"], message: "every credited recipient requires matching authorization evidence" });
  }
  for (const [index, portion] of portions.entries()) {
    const evidence = evidenceByRecipient.get(portion.creditedBowlerId);
    if (!evidence) continue;
    if ((evidence.role === "self") !== (portion.creditedBowlerId === snapshot.payerBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundingPortions", index, "creditedBowlerId"], message: "recipient role does not match the original payer" });
    }
  }
});

export type AccountPaymentOperationSemanticSnapshot = z.infer<typeof semanticSchema>;

export type AccountPaymentOperationSnapshotInput = Omit<AccountPaymentOperationSemanticSnapshot, "snapshotVersion" | "snapshotKind" | "operationType" | "requestKind">;

export type AccountPaymentOperationIdentity = {
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

export type AccountPaymentOperationPreparationInput = Omit<
  AccountPaymentOperationSnapshotInput,
  "operationId" | "providerIdempotencyKey"
> & {
  requestKey: string;
  now?: Date;
};

export type AccountPaymentOperationExecutionSnapshot = AccountPaymentOperationSemanticSnapshot & {
  kind: "account_funding";
  snapshotFingerprint: string;
  allocations: [];
  lineItems: [];
};

export class AccountPaymentOperationSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountPaymentOperationSnapshotValidationError";
  }
}

/** Pure adapter that keeps request orchestration metadata out of the strict
 * immutable snapshot codec. */
export function buildAccountPaymentOperationSnapshot(
  operation: Pick<AccountPaymentOperationIdentity, "id" | "providerIdempotencyKey">,
  input: AccountPaymentOperationPreparationInput,
): AccountPaymentOperationSnapshotInput {
  return {
    operationId: operation.id,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerId: input.payerBowlerId,
    amountMinor: input.amountMinor,
    fundingPortions: input.fundingPortions,
    recipientEvidence: input.recipientEvidence,
    currency: input.currency,
    providerName: input.providerName,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    locationId: input.locationId,
    providerLocationId: input.providerLocationId,
    authorizingUserId: input.authorizingUserId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    customerId: input.customerId,
    buyerEmail: input.buyerEmail,
    storeCard: input.storeCard,
    quoteFingerprint: input.quoteFingerprint,
  };
}

function normalize(value: unknown): AccountPaymentOperationSemanticSnapshot {
  const parsed = semanticSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccountPaymentOperationSnapshotValidationError("account funding operation snapshot is invalid", { cause: parsed.error });
  }
  return parsed.data;
}

export function validateAccountPaymentOperationSnapshot(value: unknown): AccountPaymentOperationSemanticSnapshot {
  return normalize(value);
}

export function fingerprintAccountPaymentOperationSnapshot(snapshot: AccountPaymentOperationSnapshotInput | AccountPaymentOperationSemanticSnapshot): string {
  const normalized = normalize({
    ...snapshot,
    snapshotVersion: ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION,
    snapshotKind: ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS[0],
    operationType: "interactive_charge",
    requestKind: "direct",
  });
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex");
  return `${ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}

export type StoredAccountPaymentOperationSnapshotFields = Omit<StoredAccountPaymentOperationSnapshot, "createdAt">;

export function encryptAccountPaymentOperationSnapshot(
  snapshot: AccountPaymentOperationSnapshotInput | AccountPaymentOperationSemanticSnapshot,
): StoredAccountPaymentOperationSnapshotFields {
  const normalized = normalize({
    ...snapshot,
    snapshotVersion: ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION,
    snapshotKind: ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS[0],
    operationType: "interactive_charge",
    requestKind: "direct",
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
    currency: normalized.currency,
    providerName: normalized.providerName,
    locationId: normalized.locationId,
    providerLocationId: normalized.providerLocationId,
    authorizingUserId: normalized.authorizingUserId,
    requestKind: normalized.requestKind,
    sourceKind: normalized.sourceKind,
    encryptedSourceId: encrypt(normalized.sourceId),
    encryptedCustomerId: normalized.customerId === null ? null : encrypt(normalized.customerId),
    encryptedBuyerEmail: normalized.buyerEmail === null ? null : encrypt(normalized.buyerEmail),
    storeCard: normalized.storeCard,
    quoteFingerprint: normalized.quoteFingerprint,
    snapshotFingerprint: fingerprintAccountPaymentOperationSnapshot(normalized),
  };
}

function decryptRequired(ciphertext: string, label: string): string {
  const value = decrypt(ciphertext);
  if (value === null || value.length === 0) {
    throw new AccountPaymentOperationSnapshotValidationError(`${label} could not be decrypted`);
  }
  return value;
}

function decryptOptional(ciphertext: string | null, label: string): string | null {
  return ciphertext === null ? null : decryptRequired(ciphertext, label);
}

export function reconstructAccountPaymentOperationSnapshot(input: {
  operation: AccountPaymentOperationIdentity;
  stored: StoredAccountPaymentOperationSnapshot;
}): AccountPaymentOperationExecutionSnapshot {
  const { operation, stored } = input;
  if (stored.snapshotVersion !== ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_VERSION || stored.snapshotKind !== ACCOUNT_PAYMENT_OPERATION_SNAPSHOT_KINDS[0]) {
    throw new AccountPaymentOperationSnapshotValidationError("account funding operation snapshot version is unsupported");
  }
  if (
    stored.operationId !== operation.id
    || stored.organizationId !== operation.organizationId
    || stored.leagueId !== operation.leagueId
    || stored.amountMinor !== operation.amountMinor
    || stored.currency !== operation.currency
    || stored.providerName !== operation.providerName
    || stored.authorizingUserId !== operation.authorizingUserId
  ) {
    throw new AccountPaymentOperationSnapshotValidationError("account funding snapshot provenance does not match its payment operation");
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
    currency: operation.currency,
    providerName: operation.providerName,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    locationId: stored.locationId,
    providerLocationId: stored.providerLocationId,
    authorizingUserId: operation.authorizingUserId,
    requestKind: stored.requestKind,
    sourceKind: stored.sourceKind,
    sourceId: decryptRequired(stored.encryptedSourceId, "payment source reference"),
    customerId: decryptOptional(stored.encryptedCustomerId, "provider customer reference"),
    buyerEmail: decryptOptional(stored.encryptedBuyerEmail, "buyer email"),
    storeCard: stored.storeCard,
    quoteFingerprint: stored.quoteFingerprint,
  });

  const snapshotFingerprint = fingerprintAccountPaymentOperationSnapshot(semantic);
  if (snapshotFingerprint !== stored.snapshotFingerprint) {
    throw new AccountPaymentOperationSnapshotValidationError("account funding snapshot fingerprint does not match its immutable contents");
  }
  return { ...semantic, kind: "account_funding", snapshotFingerprint, allocations: [], lineItems: [] };
}
