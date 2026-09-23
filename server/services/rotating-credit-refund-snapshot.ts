import { createHash } from "node:crypto";
import type { PaymentOperation } from "@shared/schema";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";

export interface RotatingCreditRefundSnapshotInput {
  organizationId: number;
  leagueId: number;
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
  currency: "USD";
  providerName: "square";
  providerPaymentId: string;
  locationId: number;
  reason: string;
}

export interface RotatingCreditRefundSemanticSnapshot extends RotatingCreditRefundSnapshotInput {
  kind: "rotating_credit_refund";
  snapshotVersion: 1;
  snapshotFingerprint: string;
}

export type StoredRotatingCreditRefundSnapshot = Omit<RotatingCreditRefundSemanticSnapshot, "kind" | "snapshotVersion" | "currency" | "locationId" | "providerName">
  & { currency: string; locationId: number | null };

export function fingerprintRotatingCreditRefundSnapshot(input: RotatingCreditRefundSnapshotInput): string {
  const semantic = {
    contract: "rotating-credit-refund-exec/1",
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    fundingId: input.fundingId,
    paymentId: input.paymentId,
    bowlerId: input.bowlerId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    providerPaymentId: input.providerPaymentId,
    locationId: input.locationId,
    reason: input.reason,
  };
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput(semantic))
    .digest("hex");
  return `lvrotcrrefundexec:v1:${digest}`;
}

export function createRotatingCreditRefundSnapshot(
  input: RotatingCreditRefundSnapshotInput,
): RotatingCreditRefundSemanticSnapshot {
  return {
    kind: "rotating_credit_refund",
    snapshotVersion: 1,
    ...input,
    snapshotFingerprint: fingerprintRotatingCreditRefundSnapshot(input),
  };
}

export function reconstructRotatingCreditRefundSnapshot(input: {
  operation: Pick<PaymentOperation, "organizationId" | "leagueId" | "operationType" | "providerName" | "amountMinor" | "currency">;
  stored: StoredRotatingCreditRefundSnapshot;
}): RotatingCreditRefundSemanticSnapshot {
  const { operation, stored } = input;
  if (stored.currency !== "USD" || stored.locationId === null) {
    throw new Error("Rotating credit refund snapshot has invalid currency or location");
  }
  const snapshot = createRotatingCreditRefundSnapshot({
    organizationId: stored.organizationId,
    leagueId: stored.leagueId,
    fundingId: stored.fundingId,
    paymentId: stored.paymentId,
    bowlerId: stored.bowlerId,
    amountMinor: stored.amountMinor,
    currency: "USD",
    providerName: "square",
    providerPaymentId: stored.providerPaymentId,
    locationId: stored.locationId,
    reason: stored.reason,
  });
  if (stored.snapshotFingerprint !== snapshot.snapshotFingerprint
    || operation.organizationId !== snapshot.organizationId
    || operation.leagueId !== snapshot.leagueId
    || operation.operationType !== "refund"
    || operation.providerName !== snapshot.providerName
    || operation.amountMinor !== snapshot.amountMinor
    || operation.currency !== snapshot.currency) {
    throw new Error("Rotating credit refund snapshot does not match its operation");
  }
  return snapshot;
}
