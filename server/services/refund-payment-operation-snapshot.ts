import { createHash } from "node:crypto";
import { z } from "zod";
import { REFUND_PAYMENT_SNAPSHOT_VERSION } from "@shared/schema";
import { decrypt, encrypt } from "../utils/crypto.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";

export const REFUND_PAYMENT_SNAPSHOT_FINGERPRINT_PREFIX = "lvpayexecrf:v1:" as const;

const semanticSnapshotSchema = z.object({
  snapshotVersion: z.literal(REFUND_PAYMENT_SNAPSHOT_VERSION),
  organizationId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  currency: z.literal("USD"),
  providerName: z.literal("square"),
  paymentId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  providerPaymentId: z.string().min(1).max(255),
  reason: z.string().trim().min(1).max(192),
  requestedReason: z.string().trim().min(1).max(192).nullable(),
  requestedByUserId: z.number().int().positive(),
  requestedByRole: z.enum(["org_admin", "system_admin"]),
  requestedByOrganizationId: z.number().int().positive().nullable(),
}).strict();

export type RefundPaymentSemanticSnapshot = z.infer<typeof semanticSnapshotSchema>;

export interface StoredRefundPaymentSnapshot {
  snapshotVersion: number;
  snapshotFingerprint: string;
  paymentId: number;
  leagueId: number;
  locationId: number;
  encryptedProviderPaymentId: string;
  reason: string;
  requestedReason: string | null;
  requestedByUserId: number;
  requestedByRole: string;
  requestedByOrganizationId: number | null;
}

export function validateRefundPaymentSnapshot(value: unknown): RefundPaymentSemanticSnapshot {
  return semanticSnapshotSchema.parse(value);
}

export function fingerprintRefundPaymentSnapshot(snapshot: RefundPaymentSemanticSnapshot): string {
  const validated = validateRefundPaymentSnapshot(snapshot);
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput(validated))
    .digest("hex");
  return `${REFUND_PAYMENT_SNAPSHOT_FINGERPRINT_PREFIX}${digest}`;
}

export function encryptRefundPaymentSnapshot(snapshot: RefundPaymentSemanticSnapshot) {
  const validated = validateRefundPaymentSnapshot(snapshot);
  return {
    snapshotVersion: validated.snapshotVersion,
    snapshotFingerprint: fingerprintRefundPaymentSnapshot(validated),
    paymentId: validated.paymentId,
    leagueId: validated.leagueId,
    locationId: validated.locationId,
    encryptedProviderPaymentId: encrypt(validated.providerPaymentId),
    reason: validated.reason,
    requestedReason: validated.requestedReason,
    requestedByUserId: validated.requestedByUserId,
    requestedByRole: validated.requestedByRole,
    requestedByOrganizationId: validated.requestedByOrganizationId,
  };
}

export function reconstructRefundPaymentSnapshot(input: {
  organizationId: number;
  amountMinor: number;
  currency: string;
  providerName: string;
  stored: StoredRefundPaymentSnapshot;
}): RefundPaymentSemanticSnapshot {
  const providerPaymentId = decrypt(input.stored.encryptedProviderPaymentId);
  if (!providerPaymentId) throw new Error("refund provider payment identity could not be decrypted");
  return validateRefundPaymentSnapshot({
    snapshotVersion: input.stored.snapshotVersion,
    organizationId: input.organizationId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    paymentId: input.stored.paymentId,
    leagueId: input.stored.leagueId,
    locationId: input.stored.locationId,
    providerPaymentId,
    reason: input.stored.reason,
    requestedReason: input.stored.requestedReason,
    requestedByUserId: input.stored.requestedByUserId,
    requestedByRole: input.stored.requestedByRole,
    requestedByOrganizationId: input.stored.requestedByOrganizationId,
  });
}

export function refundReplaySemanticsMatch(
  left: RefundPaymentSemanticSnapshot,
  right: RefundPaymentSemanticSnapshot,
): boolean {
  return left.organizationId === right.organizationId
    && left.amountMinor === right.amountMinor
    && left.currency === right.currency
    && left.providerName === right.providerName
    && left.paymentId === right.paymentId
    && left.leagueId === right.leagueId
    && left.locationId === right.locationId
    && left.providerPaymentId === right.providerPaymentId
    && left.reason === right.reason
    && left.requestedReason === right.requestedReason;
}
