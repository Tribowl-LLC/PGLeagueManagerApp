import { describe, expect, it } from "vitest";
import {
  PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
  PaymentOperationOccurrenceSnapshotValidationError,
  fingerprintPaymentOperationOccurrenceSnapshot,
  validatePaymentOperationOccurrenceSnapshot,
  type PaymentOperationOccurrenceSnapshotV1,
} from "../../server/services/payment-operation-occurrence-snapshot";

const occurrenceA = "10000000-0000-4000-8000-000000000001";
const occurrenceB = "10000000-0000-4000-8000-000000000002";
const obligationA = "20000000-0000-4000-8000-000000000001";
const obligationB = "20000000-0000-4000-8000-000000000002";

function snapshot(): PaymentOperationOccurrenceSnapshotV1 {
  return {
    contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
    snapshotVersion: 1,
    operationId: "30000000-0000-4000-8000-000000000001",
    operationType: "interactive_charge",
    organizationId: 7,
    leagueId: 11,
    amountMinor: 1_000,
    currency: "USD",
    allocations: [
      {
        allocationIndex: 0,
        organizationId: 7,
        leagueId: 11,
        occurrenceId: occurrenceA,
        bowlerId: 19,
        obligationId: obligationA,
        amountMinor: 500,
        currency: "USD",
      },
      {
        allocationIndex: 1,
        organizationId: 7,
        leagueId: 11,
        occurrenceId: occurrenceB,
        bowlerId: 19,
        obligationId: obligationB,
        amountMinor: 500,
        currency: "USD",
      },
    ],
  };
}

describe("dormant payment-operation occurrence snapshots", () => {
  it("allows one bowler across different real occurrences without weakening current snapshot rules", () => {
    const parsed = validatePaymentOperationOccurrenceSnapshot(snapshot());
    expect(parsed.allocations.map((allocation) => allocation.bowlerId)).toEqual([19, 19]);
    expect(new Set(parsed.allocations.map((allocation) => allocation.occurrenceId)).size).toBe(2);
    expect(fingerprintPaymentOperationOccurrenceSnapshot(parsed)).toMatch(/^lvpayocc:v1:[0-9a-f]{64}$/);
  });

  it("dispatches by explicit version and enforces v1 tenant, currency, total, order, and obligation uniqueness", () => {
    const base = snapshot();
    const invalid = [
      { ...base, snapshotVersion: 2 },
      { ...base, amountMinor: 999 },
      { ...base, allocations: base.allocations.map((allocation, index) => ({
        ...allocation,
        allocationIndex: 1 - index,
      })) },
      { ...base, allocations: [
        base.allocations[0],
        { ...base.allocations[1], obligationId: obligationA },
      ] },
      { ...base, allocations: [
        base.allocations[0],
        { ...base.allocations[1], organizationId: 8 },
      ] },
      { ...base, allocations: [
        base.allocations[0],
        { ...base.allocations[1], currency: "CAD" },
      ] },
    ];
    for (const input of invalid) {
      expect(() => validatePaymentOperationOccurrenceSnapshot(input))
        .toThrow(PaymentOperationOccurrenceSnapshotValidationError);
    }
  });

  it("produces a deterministic version-specific fingerprint", () => {
    const first = fingerprintPaymentOperationOccurrenceSnapshot(snapshot());
    const second = fingerprintPaymentOperationOccurrenceSnapshot(snapshot());
    expect(second).toBe(first);
    expect(fingerprintPaymentOperationOccurrenceSnapshot({
      ...snapshot(),
      operationType: "scheduled_charge",
    })).not.toBe(first);
  });
});
