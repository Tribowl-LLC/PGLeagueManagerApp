import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalObligationBalance } from "../../server/services/refund-allocation-adjustments";
import { encryptRefundPaymentSnapshot, reconstructRefundPaymentSnapshot, type StoredRefundPaymentSnapshot } from "../../server/services/refund-payment-operation-snapshot";

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
});
