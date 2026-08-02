import { createHash } from "node:crypto";
import { z } from "zod";
import {
  INTERACTIVE_PAYMENT_SNAPSHOT_VERSION,
  type InteractivePaymentRequestKind,
} from "@shared/schema";
import { decrypt, encrypt } from "../utils/crypto.js";
import {
  buildSquarePaymentRequestIdentity,
  canonicalizePaymentOperationInput,
} from "./payment-operation-idempotency.js";

export const INTERACTIVE_PAYMENT_SNAPSHOT_FINGERPRINT_PREFIX = "lvpayexecic:v1:" as const;

const allocationSchema = z.object({
  allocationIndex: z.number().int().min(0),
  bowlerId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  lineageAmountMinor: z.number().int().min(0).nullable(),
  prizeFundAmountMinor: z.number().int().min(0).nullable(),
  weekOf: z.string().datetime(),
  notes: z.string().max(500).nullable(),
  paidByUserId: z.number().int().positive().nullable(),
}).strict();

const lineItemSchema = z.object({
  lineItemIndex: z.number().int().min(0),
  catalogObjectId: z.string().min(1).max(255),
  quantity: z.string().regex(/^[1-9][0-9]*$/).max(32),
}).strict();

const semanticSnapshotSchema = z.object({
  snapshotVersion: z.literal(INTERACTIVE_PAYMENT_SNAPSHOT_VERSION),
  organizationId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^USD$/),
  providerName: z.string().regex(/^square$/),
  leagueId: z.number().int().positive(),
  locationId: z.number().int().positive().nullable(),
  providerLocationId: z.string().min(1).max(255).nullable(),
  payerBowlerId: z.number().int().positive(),
  requestKind: z.enum(["direct", "order"]),
  squarePaymentIdempotencyKey: z.string().min(1).max(45),
  squareOrderIdempotencyKey: z.string().min(1).max(45).nullable(),
  sourceId: z.string().min(1).max(2048),
  customerId: z.string().min(1).max(255).nullable(),
  buyerEmail: z.string().email().max(255).nullable(),
  storeCard: z.boolean(),
  weekOf: z.string().datetime(),
  combinedChargeGroupId: z.string().min(1).max(128).nullable(),
  allocations: z.array(allocationSchema).min(1).max(25),
  lineItems: z.array(lineItemSchema).max(25),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.requestKind === "order" && snapshot.lineItems.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lineItems"],
      message: "order requests require line items",
    });
  }
  if (snapshot.requestKind === "order" && snapshot.providerLocationId === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerLocationId"],
      message: "order requests require a provider location",
    });
  }
  if (snapshot.requestKind === "direct" && snapshot.squareOrderIdempotencyKey !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["squareOrderIdempotencyKey"],
      message: "direct requests cannot include an order idempotency key",
    });
  }
  if (snapshot.requestKind === "direct" && snapshot.lineItems.length !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lineItems"],
      message: "direct requests cannot include line items",
    });
  }

  const allocationIndexes = snapshot.allocations.map((row) => row.allocationIndex);
  const lineItemIndexes = snapshot.lineItems.map((row) => row.lineItemIndex);
  if (allocationIndexes.some((value, index) => value !== index)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "allocation indexes must be contiguous and ordered",
    });
  }
  if (lineItemIndexes.some((value, index) => value !== index)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lineItems"],
      message: "line item indexes must be contiguous and ordered",
    });
  }

  const allocationTotal = snapshot.allocations.reduce((total, row) => total + row.amountMinor, 0);
  if (allocationTotal !== snapshot.amountMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "allocation total must match operation amount",
    });
  }
  if (snapshot.allocations.some((row) => row.weekOf !== snapshot.weekOf)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "interactive allocations must use the snapshot week",
    });
  }
  const bowlerIds = snapshot.allocations.map((row) => row.bowlerId);
  if (new Set(bowlerIds).size !== bowlerIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "interactive allocation bowlers must be unique",
    });
  }
});

export type InteractivePaymentSemanticSnapshot = z.infer<typeof semanticSnapshotSchema>;

export interface StoredInteractivePaymentSnapshot {
  snapshotVersion: number;
  snapshotFingerprint: string;
  leagueId: number;
  locationId: number | null;
  providerLocationId: string | null;
  payerBowlerId: number;
  requestKind: InteractivePaymentRequestKind;
  encryptedSourceId: string;
  encryptedCustomerId: string | null;
  encryptedBuyerEmail: string | null;
  storeCard: boolean;
  weekOf: string;
  combinedChargeGroupId: string | null;
}

export class InteractivePaymentSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InteractivePaymentSnapshotValidationError";
  }
}

function normalize(snapshot: InteractivePaymentSemanticSnapshot): InteractivePaymentSemanticSnapshot {
  const parsed = semanticSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new InteractivePaymentSnapshotValidationError(
      "interactive payment execution snapshot is invalid",
      { cause: parsed.error },
    );
  }
  return {
    ...parsed.data,
    weekOf: new Date(parsed.data.weekOf).toISOString(),
    allocations: parsed.data.allocations.map((allocation) => ({
      ...allocation,
      weekOf: new Date(allocation.weekOf).toISOString(),
    })),
  };
}

export function fingerprintInteractivePaymentSnapshot(
  snapshot: InteractivePaymentSemanticSnapshot,
): string {
  const normalized = normalize(snapshot);
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput(normalized))
    .digest("hex");
  return `${INTERACTIVE_PAYMENT_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}

export function encryptInteractivePaymentSnapshot(
  snapshot: InteractivePaymentSemanticSnapshot,
): StoredInteractivePaymentSnapshot {
  const normalized = normalize(snapshot);
  return {
    snapshotVersion: normalized.snapshotVersion,
    snapshotFingerprint: fingerprintInteractivePaymentSnapshot(normalized),
    leagueId: normalized.leagueId,
    locationId: normalized.locationId,
    providerLocationId: normalized.providerLocationId,
    payerBowlerId: normalized.payerBowlerId,
    requestKind: normalized.requestKind,
    encryptedSourceId: encrypt(normalized.sourceId),
    encryptedCustomerId: normalized.customerId === null ? null : encrypt(normalized.customerId),
    encryptedBuyerEmail: normalized.buyerEmail === null ? null : encrypt(normalized.buyerEmail),
    storeCard: normalized.storeCard,
    weekOf: normalized.weekOf,
    combinedChargeGroupId: normalized.combinedChargeGroupId,
  };
}

function decryptRequired(ciphertext: string, label: string): string {
  const value = decrypt(ciphertext);
  if (value === null || value.length === 0) {
    throw new InteractivePaymentSnapshotValidationError(`${label} could not be decrypted`);
  }
  return value;
}

function decryptOptional(ciphertext: string | null, label: string): string | null {
  return ciphertext === null ? null : decryptRequired(ciphertext, label);
}

function storedTimestampToIso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new InteractivePaymentSnapshotValidationError("stored interactive snapshot timestamp is invalid");
  }
  return parsed.toISOString();
}

export function reconstructInteractivePaymentSnapshot(input: {
  organizationId: number;
  amountMinor: number;
  currency: string;
  providerName: string;
  providerIdempotencyKey: string;
  stored: StoredInteractivePaymentSnapshot;
  allocations: InteractivePaymentSemanticSnapshot["allocations"];
  lineItems: InteractivePaymentSemanticSnapshot["lineItems"];
}): InteractivePaymentSemanticSnapshot {
  if (input.stored.snapshotVersion !== INTERACTIVE_PAYMENT_SNAPSHOT_VERSION) {
    throw new InteractivePaymentSnapshotValidationError("interactive payment snapshot version is unsupported");
  }
  const squareIdentity = buildSquarePaymentRequestIdentity({
    providerIdempotencyKey: input.providerIdempotencyKey,
    requestKind: input.stored.requestKind,
    providerLocationId: input.stored.providerLocationId,
  });
  const snapshot = normalize({
    snapshotVersion: INTERACTIVE_PAYMENT_SNAPSHOT_VERSION,
    organizationId: input.organizationId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    leagueId: input.stored.leagueId,
    locationId: input.stored.locationId,
    providerLocationId: input.stored.providerLocationId,
    payerBowlerId: input.stored.payerBowlerId,
    requestKind: input.stored.requestKind,
    squarePaymentIdempotencyKey: squareIdentity.paymentKey,
    squareOrderIdempotencyKey: input.stored.requestKind === "order"
      ? squareIdentity.orderKey ?? null
      : null,
    sourceId: decryptRequired(input.stored.encryptedSourceId, "payment source reference"),
    customerId: decryptOptional(input.stored.encryptedCustomerId, "provider customer reference"),
    buyerEmail: decryptOptional(input.stored.encryptedBuyerEmail, "buyer email"),
    storeCard: input.stored.storeCard,
    weekOf: storedTimestampToIso(input.stored.weekOf),
    combinedChargeGroupId: input.stored.combinedChargeGroupId,
    allocations: input.allocations,
    lineItems: input.lineItems,
  });
  const actualFingerprint = fingerprintInteractivePaymentSnapshot(snapshot);
  if (actualFingerprint !== input.stored.snapshotFingerprint) {
    throw new InteractivePaymentSnapshotValidationError(
      "interactive payment execution snapshot fingerprint mismatch",
    );
  }
  return snapshot;
}
