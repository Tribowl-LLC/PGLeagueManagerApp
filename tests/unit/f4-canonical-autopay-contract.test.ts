import { describe, expect, it } from "vitest";
import {
  canonicalAutopayProviderIdempotencyKey,
  canonicalAutopayTargetKey,
  f4ExecutionSnapshotFingerprint,
  validateF4ExecutionSnapshot,
} from "@shared/f4-canonical-autopay-contract";

const base = {
  contractVersion: "canonical-autopay-execution/1" as const,
  snapshotVersion: 1 as const,
  operationId: "00000000-0000-4000-8000-000000000001",
  organizationId: 1,
  leagueId: 2,
  d2PlanId: "00000000-0000-4000-8000-000000000002",
  collectionPointOccurrenceId: "00000000-0000-4000-8000-000000000003",
  triggerOccurrenceId: "00000000-0000-4000-8000-000000000003",
  payerBowlerId: 3,
  locationId: 4,
  providerLocationId: "L1",
  activationId: "00000000-0000-4000-8000-000000000004",
  activationRevision: 1,
  activationSourceFingerprint: "lvfinancialsource:v1:" + "a".repeat(64),
  policyId: "00000000-0000-4000-8000-000000000005",
  policyVersion: 1,
  policyFingerprint: "lvf3policy:v1:" + "b".repeat(64),
  authorizationId: "00000000-0000-4000-8000-000000000006",
  authorizationVersion: 1,
  authorizationFingerprint: "lvf3auth:v1:" + "c".repeat(64),
  planVersion: 1,
  planFingerprint: "lvf3plan:v1:" + "d".repeat(64),
  amountMinor: 1000,
  currency: "USD",
  items: [{ obligationId: "00000000-0000-4000-8000-000000000007", occurrenceId: "00000000-0000-4000-8000-000000000003", bowlerId: 3, amountMinor: 1000, currency: "USD", itemIndex: 0 }],
  encryptedSourceId: "v1:test-ciphertext",
  encryptedCustomerId: null,
};

describe("F4 canonical autopay identity and immutable snapshot", () => {
  it("uses a plan-only target and a distinct bounded provider key", () => {
    const target = canonicalAutopayTargetKey(base.d2PlanId);
    const key = canonicalAutopayProviderIdempotencyKey({ organizationId: 1, d2PlanId: base.d2PlanId, amountMinor: 1000, currency: "usd", providerName: "square" });
    expect(target).toBe(`canonical-autopay-plan:${base.d2PlanId}`);
    expect(key.startsWith("lv-f4-pay-")).toBe(true);
    expect(key.length).toBeLessThanOrEqual(45);
  });

  it("rejects allocation total and tamper/fingerprint changes", () => {
    const fingerprint = f4ExecutionSnapshotFingerprint(base);
    expect(validateF4ExecutionSnapshot({ ...base, snapshotFingerprint: fingerprint }).snapshotFingerprint).toBe(fingerprint);
    expect(() => f4ExecutionSnapshotFingerprint({ ...base, amountMinor: 999 })).toThrow();
    expect(() => validateF4ExecutionSnapshot({ ...base, snapshotFingerprint: fingerprint, items: [{ ...base.items[0], amountMinor: 999 }] })).toThrow();
  });
});
