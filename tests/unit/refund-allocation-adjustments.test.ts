import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalObligationBalance } from "../../server/services/refund-allocation-adjustments";
import {
  encryptRefundPaymentSnapshot,
  reconstructRefundPaymentSnapshot,
  REFUND_PAYMENT_SNAPSHOT_V3_FINGERPRINT_PREFIX,
  type StoredRefundPaymentSnapshot,
} from "../../server/services/refund-payment-operation-snapshot";

// Snapshot encryption is exercised here with a deterministic disposable test
// key; this pure codec suite does not rely on local or production secrets.
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);

describe("canonical refund allocation balances", () => {
  it("reopens the exact refunded amount for a still-owed refund", () => {
    expect(canonicalObligationBalance({
      amountMinor: 3_000,
      state: "settled",
      grossAllocatedMinor: 3_000,
      adjustments: [{ amountMinor: 2_000, disposition: "still_owed" }],
    })).toMatchObject({
      grossAllocatedMinor: 3_000,
      refundedMinor: 2_000,
      effectiveAllocatedMinor: 1_000,
      waivedMinor: 0,
      outstandingMinor: 2_000,
      stillOwed: true,
    });
  });

  it("waives only the refunded portion without counting it as paid", () => {
    expect(canonicalObligationBalance({
      amountMinor: 3_000,
      state: "partially_settled",
      grossAllocatedMinor: 3_000,
      adjustments: [{ amountMinor: 2_000, disposition: "waived" }],
    })).toMatchObject({
      effectiveAllocatedMinor: 1_000,
      waivedMinor: 2_000,
      outstandingMinor: 0,
      stillOwed: false,
    });
  });

  it("keeps a voided obligation at zero regardless of retained tender evidence", () => {
    expect(canonicalObligationBalance({
      amountMinor: 3_000,
      state: "voided",
      grossAllocatedMinor: 3_000,
      adjustments: [{ amountMinor: 3_000, disposition: "still_owed" }],
    })).toMatchObject({ outstandingMinor: 0, stillOwed: false });
  });

  it("fails closed when a loaded refund snapshot fingerprint does not match its contents", () => {
    const allocationId = randomUUID();
    const semantic = {
      snapshotVersion: 2 as const,
      organizationId: 1,
      amountMinor: 2_000,
      currency: "USD" as const,
      providerName: "square" as const,
      paymentId: 1,
      leagueId: 1,
      locationId: 1,
      providerPaymentId: "square-payment-fixture",
      reason: "Refund fixture",
      requestedReason: "Refund fixture",
      requestedByUserId: 1,
      requestedByRole: "org_admin" as const,
      requestedByOrganizationId: 1,
      disposition: "still_owed" as const,
      allocations: [{ allocationId, obligationId: randomUUID(), amountMinor: 2_000, currency: "USD" as const }],
    };
    const stored = encryptRefundPaymentSnapshot(semantic) as StoredRefundPaymentSnapshot;
    expect(reconstructRefundPaymentSnapshot({ organizationId: 1, amountMinor: 2_000, currency: "USD", providerName: "square", stored })).toEqual(semantic);
    expect(() => reconstructRefundPaymentSnapshot({
      organizationId: 1,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
      stored: { ...stored, snapshotFingerprint: `${stored.snapshotFingerprint.slice(0, -1)}${stored.snapshotFingerprint.endsWith("0") ? "1" : "0"}` },
    })).toThrow("refund payment snapshot fingerprint does not match its immutable contents");
  });

  it("round-trips a full-tender refund of entirely unused owned credit", () => {
    const semantic = {
      snapshotVersion: 3 as const,
      organizationId: 1,
      amountMinor: 2_000,
      currency: "USD" as const,
      providerName: "square" as const,
      paymentId: 18,
      leagueId: 4,
      locationId: 2,
      providerPaymentId: "square-owned-credit-fixture",
      reason: "Unused credit refund",
      requestedReason: "Unused credit refund",
      requestedByUserId: 3,
      requestedByRole: "org_admin" as const,
      requestedByOrganizationId: 1,
      disposition: "still_owed" as const,
      allocations: [],
      fundingSnapshot: [{
        fundingId: randomUUID(),
        paymentId: 18,
        creditedBowlerId: 101,
        fundingAmountMinor: 2_000,
        unusedCreditMinor: 2_000,
        currency: "USD" as const,
      }],
    };

    const stored = encryptRefundPaymentSnapshot(semantic) as StoredRefundPaymentSnapshot;
    expect(stored.snapshotFingerprint).toMatch(new RegExp(`^${REFUND_PAYMENT_SNAPSHOT_V3_FINGERPRINT_PREFIX}[0-9a-f]{64}$`));
    expect(reconstructRefundPaymentSnapshot({
      organizationId: 1,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
      stored,
    })).toEqual(semantic);
  });

  it("round-trips spent and unused portions across a combined recipient tender", () => {
    const semantic = {
      snapshotVersion: 3 as const,
      organizationId: 1,
      amountMinor: 1_500,
      currency: "USD" as const,
      providerName: "square" as const,
      paymentId: 19,
      leagueId: 4,
      locationId: 2,
      providerPaymentId: "square-owned-combined-fixture",
      reason: "Combined refund",
      requestedReason: "Combined refund",
      requestedByUserId: 3,
      requestedByRole: "org_admin" as const,
      requestedByOrganizationId: 1,
      disposition: "waived" as const,
      allocations: [{ allocationId: randomUUID(), obligationId: randomUUID(), amountMinor: 800, currency: "USD" as const }],
      fundingSnapshot: [
        { fundingId: randomUUID(), paymentId: 19, creditedBowlerId: 101, fundingAmountMinor: 1_000, unusedCreditMinor: 200, currency: "USD" as const },
        { fundingId: randomUUID(), paymentId: 19, creditedBowlerId: 202, fundingAmountMinor: 500, unusedCreditMinor: 500, currency: "USD" as const },
      ],
    };

    const stored = encryptRefundPaymentSnapshot(semantic) as StoredRefundPaymentSnapshot;
    expect(reconstructRefundPaymentSnapshot({
      organizationId: 1,
      amountMinor: 1_500,
      currency: "USD",
      providerName: "square",
      stored,
    })).toEqual(semantic);
  });

  it("rejects owned refund snapshots that do not conserve the full tender", () => {
    const malformed = {
      snapshotVersion: 3 as const,
      organizationId: 1,
      amountMinor: 2_000,
      currency: "USD" as const,
      providerName: "square" as const,
      paymentId: 20,
      leagueId: 4,
      locationId: 2,
      providerPaymentId: "square-owned-invalid-fixture",
      reason: "Invalid split",
      requestedReason: "Invalid split",
      requestedByUserId: 3,
      requestedByRole: "org_admin" as const,
      requestedByOrganizationId: 1,
      disposition: "still_owed" as const,
      allocations: [{ allocationId: randomUUID(), obligationId: randomUUID(), amountMinor: 1_000, currency: "USD" as const }],
      fundingSnapshot: [{
        fundingId: randomUUID(),
        paymentId: 20,
        creditedBowlerId: 101,
        fundingAmountMinor: 2_000,
        unusedCreditMinor: 500,
        currency: "USD" as const,
      }],
    };

    expect(() => encryptRefundPaymentSnapshot(malformed)).toThrow();
  });
});
