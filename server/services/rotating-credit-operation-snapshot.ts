import { createHash } from "node:crypto";
import { z } from "zod";
import type { RotatingCreditPaymentOperationSnapshot as StoredRotatingCreditPaymentOperationSnapshot } from "@shared/schema";
import { canonicalizePaymentOperationInput, buildSquarePaymentRequestIdentity } from "./payment-operation-idempotency.js";
import { decrypt, encrypt } from "../utils/crypto.js";

export const ROTATING_CREDIT_OPERATION_SNAPSHOT_VERSION = 1 as const;
export const ROTATING_CREDIT_OPERATION_SNAPSHOT_FINGERPRINT_PREFIX = "lvrotcrexec:v1:" as const;

const semanticSchema = z.object({
  snapshotVersion: z.literal(ROTATING_CREDIT_OPERATION_SNAPSHOT_VERSION),
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  bowlerId: z.number().int().positive(),
  amountMinor: z.number().int().positive().max(2_147_483_647),
  currency: z.literal("USD"),
  shareCount: z.number().int().min(1).max(52),
  providerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  locationId: z.number().int().positive().nullable(),
  providerLocationId: z.string().min(1).max(255).nullable(),
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]),
  sourceId: z.string().min(1).max(2048),
  customerId: z.string().min(1).max(255).nullable(),
  buyerEmail: z.string().email().max(255).nullable(),
  quoteFingerprint: z.string().regex(/^lvrotcrquote:v1:[0-9a-f]{64}$/),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.providerLocationId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["providerLocationId"], message: "rotating credit uses direct provider payment" });
  }
});

export type RotatingCreditOperationSemanticSnapshot = z.infer<typeof semanticSchema> & {
  requestKind: "direct";
  storeCard: false;
  squarePaymentIdempotencyKey: string;
  squareOrderIdempotencyKey: null;
};
export type RotatingCreditOperationSnapshotInput = z.input<typeof semanticSchema>;

export type RotatingCreditOperationExecutionSnapshot = RotatingCreditOperationSemanticSnapshot & {
  kind: "rotating_credit";
  snapshotFingerprint: string;
  allocations: [];
  lineItems: [];
};

export class RotatingCreditOperationSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RotatingCreditOperationSnapshotValidationError";
  }
}

function normalize(value: z.input<typeof semanticSchema>): z.infer<typeof semanticSchema> {
  const parsed = semanticSchema.safeParse(value);
  if (!parsed.success) {
    throw new RotatingCreditOperationSnapshotValidationError("rotating credit operation snapshot is invalid", { cause: parsed.error });
  }
  return parsed.data;
}

export function fingerprintRotatingCreditOperationSnapshot(snapshot: RotatingCreditOperationSnapshotInput): string {
  const normalized = normalize(snapshot);
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex");
  return `${ROTATING_CREDIT_OPERATION_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}

export function encryptRotatingCreditOperationSnapshot(snapshot: RotatingCreditOperationSnapshotInput) {
  const normalized = normalize(snapshot);
  return {
    snapshotVersion: ROTATING_CREDIT_OPERATION_SNAPSHOT_VERSION,
    bowlerId: normalized.bowlerId,
    amountMinor: normalized.amountMinor,
    currency: normalized.currency,
    shareCount: normalized.shareCount,
    locationId: normalized.locationId,
    providerLocationId: normalized.providerLocationId,
    sourceKind: normalized.sourceKind,
    encryptedSourceId: encrypt(normalized.sourceId),
    encryptedCustomerId: normalized.customerId === null ? null : encrypt(normalized.customerId),
    encryptedBuyerEmail: normalized.buyerEmail === null ? null : encrypt(normalized.buyerEmail),
    quoteFingerprint: normalized.quoteFingerprint,
    idempotencyKey: normalized.idempotencyKey,
    snapshotFingerprint: fingerprintRotatingCreditOperationSnapshot(normalized),
  };
}

function decryptRequired(ciphertext: string, label: string): string {
  const result = decrypt(ciphertext);
  if (result === null || result.length === 0) throw new RotatingCreditOperationSnapshotValidationError(`${label} could not be decrypted`);
  return result;
}

function decryptOptional(ciphertext: string | null, label: string): string | null {
  return ciphertext === null ? null : decryptRequired(ciphertext, label);
}

export function reconstructRotatingCreditOperationSnapshot(input: {
  organizationId: number;
  leagueId: number;
  providerName: string;
  providerIdempotencyKey: string;
  stored: StoredRotatingCreditPaymentOperationSnapshot;
}): RotatingCreditOperationExecutionSnapshot {
  if (input.stored.snapshotVersion !== ROTATING_CREDIT_OPERATION_SNAPSHOT_VERSION) {
    throw new RotatingCreditOperationSnapshotValidationError("rotating credit operation snapshot version is unsupported");
  }
  if (input.stored.currency !== "USD") throw new RotatingCreditOperationSnapshotValidationError("rotating credit currency is unsupported");
  const normalized = normalize({
    snapshotVersion: input.stored.snapshotVersion,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: input.stored.bowlerId,
    amountMinor: input.stored.amountMinor,
    currency: "USD",
    shareCount: input.stored.shareCount,
    providerName: input.providerName,
    locationId: input.stored.locationId,
    providerLocationId: input.stored.providerLocationId,
    sourceKind: input.stored.sourceKind,
    sourceId: decryptRequired(input.stored.encryptedSourceId, "payment source reference"),
    customerId: decryptOptional(input.stored.encryptedCustomerId, "provider customer reference"),
    buyerEmail: decryptOptional(input.stored.encryptedBuyerEmail, "buyer email"),
    quoteFingerprint: input.stored.quoteFingerprint,
    idempotencyKey: input.stored.idempotencyKey,
  });
  if (fingerprintRotatingCreditOperationSnapshot(normalized) !== input.stored.snapshotFingerprint) {
    throw new RotatingCreditOperationSnapshotValidationError("rotating credit operation snapshot fingerprint mismatch");
  }
  const squareIdentity = buildSquarePaymentRequestIdentity({
    providerIdempotencyKey: input.providerIdempotencyKey,
    requestKind: "direct",
    providerLocationId: null,
  });
  return {
    ...normalized,
    kind: "rotating_credit",
    snapshotFingerprint: input.stored.snapshotFingerprint,
    requestKind: "direct",
    storeCard: false,
    squarePaymentIdempotencyKey: squareIdentity.paymentKey,
    squareOrderIdempotencyKey: null,
    allocations: [],
    lineItems: [],
  };
}
