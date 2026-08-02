import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SCHEDULED_PAYMENT_SNAPSHOT_VERSION,
  type ScheduledPaymentRequestKind,
} from "@shared/schema";
import { decrypt, encrypt } from "../utils/crypto";
import {
  canonicalizePaymentOperationInput,
  deriveSquareOperationIdempotencyKey,
} from "./payment-operation-idempotency";

export const SCHEDULED_PAYMENT_SNAPSHOT_FINGERPRINT_PREFIX = "lvpayexec:v1:" as const;

const allocationSchema = z.object({
  allocationIndex: z.number().int().min(0),
  bowlerId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  lineageAmountMinor: z.number().int().min(0).nullable(),
  prizeFundAmountMinor: z.number().int().min(0).nullable(),
  notes: z.string().max(500).nullable(),
  paidByUserId: z.number().int().positive().nullable(),
}).strict();

const lineItemSchema = z.object({
  lineItemIndex: z.number().int().min(0),
  catalogObjectId: z.string().min(1).max(255),
  quantity: z.string().regex(/^[1-9][0-9]*$/).max(32),
}).strict();

const semanticSnapshotSchema = z.object({
  snapshotVersion: z.literal(SCHEDULED_PAYMENT_SNAPSHOT_VERSION),
  organizationId: z.number().int().positive(),
  paymentScheduleId: z.number().int().positive(),
  billingCycleAt: z.string().datetime(),
  amountMinor: z.number().int().positive(),
  // Phase 2B scheduled execution is Square/USD only. The current Square
  // adapter fixes the request currency to USD, so accepting another value in
  // a supposedly immutable snapshot would misrepresent provider semantics.
  currency: z.string().regex(/^USD$/),
  providerName: z.string().regex(/^square$/),
  leagueId: z.number().int().positive(),
  locationId: z.number().int().positive().nullable(),
  providerLocationId: z.string().min(1).max(255).nullable(),
  requestKind: z.enum(["direct", "order"]),
  squarePaymentIdempotencyKey: z.string().min(1).max(45),
  squareOrderIdempotencyKey: z.string().min(1).max(45).nullable(),
  autocomplete: z.literal(true),
  storeCard: z.literal(false),
  sourceId: z.string().min(1),
  customerId: z.string().min(1).nullable(),
  buyerEmail: z.string().email().nullable(),
  isDoublePay: z.boolean(),
  deactivateScheduleOnPreparation: z.boolean(),
  paidInFullThresholdAmountMinor: z.number().int().positive().nullable(),
  seasonStartAt: z.string().datetime().nullable(),
  seasonEndAt: z.string().datetime().nullable(),
  allocations: z.array(allocationSchema).min(1),
  lineItems: z.array(lineItemSchema),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.requestKind === "order" && snapshot.lineItems.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lineItems"], message: "order requests require line items" });
  }
  if (snapshot.requestKind === "order" && snapshot.squareOrderIdempotencyKey === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["squareOrderIdempotencyKey"], message: "order requests require an order idempotency key" });
  }
  if (snapshot.requestKind === "direct" && snapshot.squareOrderIdempotencyKey !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["squareOrderIdempotencyKey"], message: "direct requests cannot include an order idempotency key" });
  }
  if (snapshot.requestKind === "direct" && snapshot.lineItems.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lineItems"], message: "direct requests cannot include line items" });
  }
  const allocationIndexes = snapshot.allocations.map((row) => row.allocationIndex);
  const lineItemIndexes = snapshot.lineItems.map((row) => row.lineItemIndex);
  if (allocationIndexes.some((value, index) => value !== index)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "allocation indexes must be contiguous" });
  }
  if (lineItemIndexes.some((value, index) => value !== index)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lineItems"], message: "line item indexes must be contiguous" });
  }
  const allocationTotal = snapshot.allocations.reduce((total, row) => total + row.amountMinor, 0);
  if (allocationTotal !== snapshot.amountMinor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "allocation total must match operation amount" });
  }
  if ((snapshot.seasonStartAt === null) !== (snapshot.seasonEndAt === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seasonStartAt"], message: "season bounds must both be present or absent" });
  }
});

export type ScheduledPaymentSemanticSnapshot = z.infer<typeof semanticSnapshotSchema>;

export interface StoredScheduledPaymentSnapshot {
  snapshotVersion: number;
  snapshotFingerprint: string;
  leagueId: number;
  locationId: number | null;
  providerLocationId: string | null;
  requestKind: ScheduledPaymentRequestKind;
  encryptedSourceId: string;
  encryptedCustomerId: string | null;
  encryptedBuyerEmail: string | null;
  isDoublePay: boolean;
  deactivateScheduleOnPreparation: boolean;
  paidInFullThresholdAmountMinor: number | null;
  seasonStartAt: string | null;
  seasonEndAt: string | null;
}

export class ScheduledPaymentSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledPaymentSnapshotValidationError";
  }
}

function normalize(snapshot: ScheduledPaymentSemanticSnapshot): ScheduledPaymentSemanticSnapshot {
  const parsed = semanticSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new ScheduledPaymentSnapshotValidationError("scheduled payment execution snapshot is invalid");
  }
  return {
    ...parsed.data,
    billingCycleAt: new Date(parsed.data.billingCycleAt).toISOString(),
    seasonStartAt: parsed.data.seasonStartAt === null ? null : new Date(parsed.data.seasonStartAt).toISOString(),
    seasonEndAt: parsed.data.seasonEndAt === null ? null : new Date(parsed.data.seasonEndAt).toISOString(),
  };
}

export function fingerprintScheduledPaymentSnapshot(snapshot: ScheduledPaymentSemanticSnapshot): string {
  const normalized = normalize(snapshot);
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput(normalized))
    .digest("hex");
  return `${SCHEDULED_PAYMENT_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}

export function encryptScheduledPaymentSnapshot(snapshot: ScheduledPaymentSemanticSnapshot): StoredScheduledPaymentSnapshot {
  const normalized = normalize(snapshot);
  return {
    snapshotVersion: normalized.snapshotVersion,
    snapshotFingerprint: fingerprintScheduledPaymentSnapshot(normalized),
    leagueId: normalized.leagueId,
    locationId: normalized.locationId,
    providerLocationId: normalized.providerLocationId,
    requestKind: normalized.requestKind,
    encryptedSourceId: encrypt(normalized.sourceId),
    encryptedCustomerId: normalized.customerId === null ? null : encrypt(normalized.customerId),
    encryptedBuyerEmail: normalized.buyerEmail === null ? null : encrypt(normalized.buyerEmail),
    isDoublePay: normalized.isDoublePay,
    deactivateScheduleOnPreparation: normalized.deactivateScheduleOnPreparation,
    paidInFullThresholdAmountMinor: normalized.paidInFullThresholdAmountMinor,
    seasonStartAt: normalized.seasonStartAt,
    seasonEndAt: normalized.seasonEndAt,
  };
}

function decryptRequired(ciphertext: string, label: string): string {
  const value = decrypt(ciphertext);
  if (value === null || value.length === 0) {
    throw new ScheduledPaymentSnapshotValidationError(`${label} could not be decrypted`);
  }
  return value;
}

function decryptOptional(ciphertext: string | null, label: string): string | null {
  return ciphertext === null ? null : decryptRequired(ciphertext, label);
}

export function reconstructScheduledPaymentSnapshot(input: {
  organizationId: number;
  paymentScheduleId: number;
  billingCycleAt: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  providerIdempotencyKey: string;
  stored: StoredScheduledPaymentSnapshot;
  allocations: ScheduledPaymentSemanticSnapshot["allocations"];
  lineItems: ScheduledPaymentSemanticSnapshot["lineItems"];
}): ScheduledPaymentSemanticSnapshot {
  if (input.stored.snapshotVersion !== SCHEDULED_PAYMENT_SNAPSHOT_VERSION) {
    throw new ScheduledPaymentSnapshotValidationError("scheduled payment snapshot version is unsupported");
  }
  const snapshot = normalize({
    snapshotVersion: SCHEDULED_PAYMENT_SNAPSHOT_VERSION,
    organizationId: input.organizationId,
    paymentScheduleId: input.paymentScheduleId,
    billingCycleAt: input.billingCycleAt,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    leagueId: input.stored.leagueId,
    locationId: input.stored.locationId,
    providerLocationId: input.stored.providerLocationId,
    requestKind: input.stored.requestKind,
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      input.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: input.stored.requestKind === "order"
      ? deriveSquareOperationIdempotencyKey(input.providerIdempotencyKey, "order")
      : null,
    autocomplete: true,
    storeCard: false,
    sourceId: decryptRequired(input.stored.encryptedSourceId, "payment source reference"),
    customerId: decryptOptional(input.stored.encryptedCustomerId, "provider customer reference"),
    buyerEmail: decryptOptional(input.stored.encryptedBuyerEmail, "buyer email"),
    isDoublePay: input.stored.isDoublePay,
    deactivateScheduleOnPreparation: input.stored.deactivateScheduleOnPreparation,
    paidInFullThresholdAmountMinor: input.stored.paidInFullThresholdAmountMinor,
    seasonStartAt: input.stored.seasonStartAt,
    seasonEndAt: input.stored.seasonEndAt,
    allocations: input.allocations,
    lineItems: input.lineItems,
  });
  const actualFingerprint = fingerprintScheduledPaymentSnapshot(snapshot);
  if (actualFingerprint !== input.stored.snapshotFingerprint) {
    throw new ScheduledPaymentSnapshotValidationError("scheduled payment execution snapshot fingerprint mismatch");
  }
  return snapshot;
}
