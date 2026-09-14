import { createHash } from "node:crypto";
import { z } from "zod";
import { decrypt, encrypt } from "../utils/crypto.js";
import { buildSquarePaymentRequestIdentity, canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import type { RosterOperationRequestKind, RosterOperationSourceKind } from "@shared/schema";

export const INTERACTIVE_PARTNER_SNAPSHOT_VERSION = 3 as const;
export const INTERACTIVE_PARTNER_QUOTE_FINGERPRINT_PREFIX = "lvpartnerquote:v3:" as const;
export const INTERACTIVE_PARTNER_SNAPSHOT_FINGERPRINT_PREFIX = "lvpartnerexec:v3:" as const;

const allocationSchema = z.object({
  allocationIndex: z.number().int().min(0),
  bowlerId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  notes: z.string().max(500).nullable(),
  paidByUserId: z.number().int().positive().nullable(),
  obligationId: z.string().uuid(),
  responsibilityId: z.string().uuid(),
  responsibilityVersion: z.number().int().positive(),
}).strict();

const lineItemSchema = z.object({
  lineItemIndex: z.number().int().min(0),
  catalogObjectId: z.string().min(1).max(255),
  quantity: z.string().regex(/^[1-9][0-9]*$/).max(32),
}).strict();

export const partnerEvidenceSchema = z.object({
  recipientBowlerId: z.number().int().positive(),
  role: z.enum(["self", "partner"]),
  paymentLinkId: z.number().int().positive().nullable(),
  linkFingerprint: z.string().regex(/^lvpartnerlink:v1:[0-9a-f]{64}$/).nullable(),
  selectedWeeks: z.number().int().positive().max(1000),
  fullBalance: z.boolean(),
}).strict().superRefine((row, ctx) => {
  if (row.role === "self" && (row.paymentLinkId !== null || row.linkFingerprint !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentLinkId"], message: "self evidence cannot contain a payment link" });
  }
  if (row.role === "partner" && (row.paymentLinkId === null || row.linkFingerprint === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentLinkId"], message: "partner evidence requires a payment link" });
  }
});

const semanticSnapshotSchema = z.object({
  snapshotVersion: z.literal(INTERACTIVE_PARTNER_SNAPSHOT_VERSION),
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
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]),
  quoteFingerprint: z.string().regex(/^lvpartnerquote:v3:[0-9a-f]{64}$/),
  // This is authoritative server-derived evidence, not a client request. Do
  // not introduce a smaller combined-checkout cap than the obligation source;
  // the provider's existing catalog line-item limit remains separate.
  allocations: z.array(allocationSchema).min(1),
  lineItems: z.array(lineItemSchema).max(25),
  partnerEvidence: z.array(partnerEvidenceSchema).min(1).max(200),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.requestKind === "order" && snapshot.lineItems.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lineItems"], message: "order requests require line items" });
  if (snapshot.requestKind === "order" && snapshot.providerLocationId === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerLocationId"], message: "order requests require a provider location" });
  if (snapshot.requestKind === "direct" && snapshot.squareOrderIdempotencyKey !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["squareOrderIdempotencyKey"], message: "direct requests cannot include an order idempotency key" });
  if (snapshot.requestKind === "direct" && snapshot.providerLocationId !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerLocationId"], message: "direct requests cannot include a provider location" });
  if (snapshot.requestKind === "direct" && snapshot.lineItems.length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lineItems"], message: "direct requests cannot include line items" });
  if (snapshot.sourceKind === "wallet" && snapshot.storeCard) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storeCard"], message: "wallet sources cannot be vaulted" });
  const indexes = snapshot.allocations.map((row) => row.allocationIndex);
  if (indexes.some((value, index) => value !== index)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "allocation indexes must be contiguous and ordered" });
  const total = snapshot.allocations.reduce((sum, row) => sum + row.amountMinor, 0);
  if (total !== snapshot.amountMinor) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: "allocation total must match operation amount" });
  const evidenceIds = new Set(snapshot.partnerEvidence.map((row) => row.recipientBowlerId));
  if (evidenceIds.size !== snapshot.partnerEvidence.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partnerEvidence"], message: "partner evidence recipients must be unique" });
  const selfEvidence = snapshot.partnerEvidence.filter((row) => row.role === "self");
  if (selfEvidence.length > 1 || (selfEvidence.length === 1 && selfEvidence[0]?.recipientBowlerId !== snapshot.payerBowlerId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partnerEvidence"], message: "self evidence, when present, must identify the payer" });
  if (snapshot.partnerEvidence.some((row) => row.role === "partner" && row.recipientBowlerId === snapshot.payerBowlerId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partnerEvidence"], message: "payer cannot also be a partner evidence row" });
  for (const allocation of snapshot.allocations) if (!evidenceIds.has(allocation.bowlerId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partnerEvidence"], message: "allocation recipient evidence is missing" });
});

export type InteractivePartnerPaymentSnapshot = z.infer<typeof semanticSnapshotSchema>;
export type InteractivePartnerPaymentAllocation = InteractivePartnerPaymentSnapshot["allocations"][number];
export type InteractivePartnerPaymentEvidence = InteractivePartnerPaymentSnapshot["partnerEvidence"][number];

export interface StoredInteractivePartnerPaymentSnapshot {
  snapshotVersion: number;
  snapshotFingerprint: string;
  leagueId: number;
  locationId: number | null;
  providerLocationId: string | null;
  payerBowlerId: number;
  requestKind: RosterOperationRequestKind;
  encryptedSourceId: string;
  encryptedCustomerId: string | null;
  encryptedBuyerEmail: string | null;
  storeCard: boolean;
  sourceKind: RosterOperationSourceKind | null;
  quoteFingerprint: string;
  partnerEvidence: unknown[];
}

export class InteractivePartnerSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "InteractivePartnerSnapshotValidationError"; }
}

function normalize(snapshot: InteractivePartnerPaymentSnapshot): InteractivePartnerPaymentSnapshot {
  const parsed = semanticSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new InteractivePartnerSnapshotValidationError("interactive partner snapshot is invalid", { cause: parsed.error });
  return parsed.data;
}

export function fingerprintInteractivePartnerSnapshot(snapshot: InteractivePartnerPaymentSnapshot): string {
  const normalized = normalize(snapshot);
  return `${INTERACTIVE_PARTNER_SNAPSHOT_FINGERPRINT_PREFIX}${createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex")}`;
}

export function encryptInteractivePartnerSnapshot(snapshot: InteractivePartnerPaymentSnapshot): StoredInteractivePartnerPaymentSnapshot {
  const normalized = normalize(snapshot);
  return {
    snapshotVersion: 3,
    snapshotFingerprint: fingerprintInteractivePartnerSnapshot(normalized),
    leagueId: normalized.leagueId,
    locationId: normalized.locationId,
    providerLocationId: normalized.providerLocationId,
    payerBowlerId: normalized.payerBowlerId,
    requestKind: normalized.requestKind,
    encryptedSourceId: encrypt(normalized.sourceId),
    encryptedCustomerId: normalized.customerId === null ? null : encrypt(normalized.customerId),
    encryptedBuyerEmail: normalized.buyerEmail === null ? null : encrypt(normalized.buyerEmail),
    storeCard: normalized.storeCard,
    sourceKind: normalized.sourceKind,
    quoteFingerprint: normalized.quoteFingerprint,
    partnerEvidence: normalized.partnerEvidence,
  };
}

function required(ciphertext: string, label: string): string {
  const value = decrypt(ciphertext);
  if (!value) throw new InteractivePartnerSnapshotValidationError(`${label} could not be decrypted`);
  return value;
}

export function reconstructInteractivePartnerSnapshot(input: {
  organizationId: number;
  amountMinor: number;
  currency: string;
  providerName: string;
  providerIdempotencyKey: string;
  stored: StoredInteractivePartnerPaymentSnapshot;
  allocations: InteractivePartnerPaymentAllocation[];
  lineItems: InteractivePartnerPaymentSnapshot["lineItems"];
}): InteractivePartnerPaymentSnapshot {
  if (input.stored.snapshotVersion !== 3) throw new InteractivePartnerSnapshotValidationError("interactive partner snapshot version is unsupported");
  const identity = buildSquarePaymentRequestIdentity({ providerIdempotencyKey: input.providerIdempotencyKey, requestKind: input.stored.requestKind, providerLocationId: input.stored.providerLocationId });
  const parsed = normalize({
    snapshotVersion: 3,
    organizationId: input.organizationId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    leagueId: input.stored.leagueId,
    locationId: input.stored.locationId,
    providerLocationId: input.stored.providerLocationId,
    payerBowlerId: input.stored.payerBowlerId,
    requestKind: input.stored.requestKind,
    squarePaymentIdempotencyKey: identity.paymentKey,
    squareOrderIdempotencyKey: input.stored.requestKind === "order" ? identity.orderKey ?? null : null,
    sourceId: required(input.stored.encryptedSourceId, "payment source reference"),
    customerId: input.stored.encryptedCustomerId === null ? null : required(input.stored.encryptedCustomerId, "provider customer reference"),
    buyerEmail: input.stored.encryptedBuyerEmail === null ? null : required(input.stored.encryptedBuyerEmail, "buyer email"),
    storeCard: input.stored.storeCard,
    sourceKind: input.stored.sourceKind ?? (() => { throw new InteractivePartnerSnapshotValidationError("source kind is missing"); })(),
    quoteFingerprint: input.stored.quoteFingerprint,
    allocations: input.allocations,
    lineItems: input.lineItems,
    partnerEvidence: z.array(partnerEvidenceSchema).parse(input.stored.partnerEvidence),
  });
  if (fingerprintInteractivePartnerSnapshot(parsed) !== input.stored.snapshotFingerprint) throw new InteractivePartnerSnapshotValidationError("interactive partner snapshot fingerprint mismatch");
  return parsed;
}
