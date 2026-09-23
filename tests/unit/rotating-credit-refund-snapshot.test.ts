import { describe, expect, it } from "vitest";
import {
  createRotatingCreditRefundSnapshot,
  fingerprintRotatingCreditRefundSnapshot,
  reconstructRotatingCreditRefundSnapshot,
} from "../../server/services/rotating-credit-refund-snapshot";
import { isRotatingCreditFinalizationRecoveryEligible } from "../../server/services/rotating-credit-recovery-contract";
import { fingerprintRotatingCreditOperationSnapshot } from "../../server/services/rotating-credit-operation-snapshot";

describe("rotating credit refund snapshots", () => {
  const snapshotInput = {
    organizationId: 14,
    leagueId: 28,
    fundingId: "b27bb3f2-542f-46ef-8f1d-1908f27ab839",
    paymentId: 501,
    bowlerId: 82,
    amountMinor: 1_000,
    currency: "USD" as const,
    providerName: "square" as const,
    providerPaymentId: "square-payment-refund-fixture",
    locationId: 73,
    reason: "Unused rotating share credit",
  };

  it("reconstructs the exact persisted semantic fingerprint without hashing wrapper metadata", () => {
    const semantic = createRotatingCreditRefundSnapshot(snapshotInput);
    const stored = {
      organizationId: semantic.organizationId,
      leagueId: semantic.leagueId,
      fundingId: semantic.fundingId,
      paymentId: semantic.paymentId,
      bowlerId: semantic.bowlerId,
      amountMinor: semantic.amountMinor,
      currency: semantic.currency,
      providerPaymentId: semantic.providerPaymentId,
      locationId: semantic.locationId,
      reason: semantic.reason,
      snapshotFingerprint: semantic.snapshotFingerprint,
    };
    const operation = {
      organizationId: semantic.organizationId,
      leagueId: semantic.leagueId,
      operationType: "refund" as const,
      providerName: "square",
      amountMinor: semantic.amountMinor,
      currency: "USD",
    };

    expect(fingerprintRotatingCreditRefundSnapshot(semantic)).toBe(semantic.snapshotFingerprint);
    expect(reconstructRotatingCreditRefundSnapshot({ operation, stored })).toEqual(semantic);
  });

  it("rejects snapshot tampering", () => {
    const semantic = createRotatingCreditRefundSnapshot(snapshotInput);
    const stored = {
      organizationId: semantic.organizationId,
      leagueId: semantic.leagueId,
      fundingId: semantic.fundingId,
      paymentId: semantic.paymentId,
      bowlerId: semantic.bowlerId,
      amountMinor: semantic.amountMinor + 1,
      currency: semantic.currency,
      providerPaymentId: semantic.providerPaymentId,
      locationId: semantic.locationId,
      reason: semantic.reason,
      snapshotFingerprint: semantic.snapshotFingerprint,
    };
    const operation = {
      organizationId: semantic.organizationId,
      leagueId: semantic.leagueId,
      operationType: "refund" as const,
      providerName: "square",
      amountMinor: semantic.amountMinor,
      currency: "USD",
    };

    expect(() => reconstructRotatingCreditRefundSnapshot({ operation, stored })).toThrow();
  });
});

describe("rotating credit charge recovery gate", () => {
  it("recovers only known local finalization failures, never provider-unknown outcomes with an object id", () => {
    expect(isRotatingCreditFinalizationRecoveryEligible({
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "PAYMENT_EVIDENCE_INCOMPLETE",
      providerObjectId: "square-payment-unknown",
    })).toBe(true);

    expect(isRotatingCreditFinalizationRecoveryEligible({
      status: "reconciliation_required",
      errorClassification: "provider_unknown",
      errorCode: "PROVIDER_OUTCOME_UNCERTAIN",
      providerObjectId: "square-payment-unresolved",
    })).toBe(false);

    expect(isRotatingCreditFinalizationRecoveryEligible({
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "SNAPSHOT_INVALID",
      providerObjectId: "square-payment-unresolved",
    })).toBe(false);
  });
});

describe("rotating credit charge execution identity", () => {
  const snapshot = {
    snapshotVersion: 1 as const,
    organizationId: 14,
    leagueId: 28,
    bowlerId: 82,
    amountMinor: 3_750,
    currency: "USD" as const,
    shareCount: 3,
    providerName: "square",
    locationId: 73,
    providerLocationId: null,
    sourceKind: "new_card" as const,
    sourceId: "cnon:rotating-credit-test-source",
    customerId: null,
    buyerEmail: null,
    quoteFingerprint: `lvrotcrquote:v1:${"a".repeat(64)}`,
    idempotencyKey: "rotating-credit-request-key",
  };

  it("binds amount, share count, quote, source, and request key into recovery semantics", () => {
    const fingerprint = fingerprintRotatingCreditOperationSnapshot(snapshot);

    expect(fingerprint).toMatch(/^lvrotcrexec:v1:[0-9a-f]{64}$/);
    expect(fingerprintRotatingCreditOperationSnapshot({ ...snapshot, amountMinor: 3_751 })).not.toBe(fingerprint);
    expect(fingerprintRotatingCreditOperationSnapshot({ ...snapshot, shareCount: 2 })).not.toBe(fingerprint);
    expect(fingerprintRotatingCreditOperationSnapshot({ ...snapshot, idempotencyKey: "different-credit-request-key" })).not.toBe(fingerprint);
  });
});
