import { describe, expect, it } from "vitest";
import { f3PolicyFingerprint, validateF3PolicyShape } from "@shared/f3-autopay-contract";
import { deriveF3ReadyPlan, F3ReadinessError } from "../../server/services/f3-canonical-autopay";

const occurrenceA = "00000000-0000-4000-8000-000000000001";
const occurrenceB = "00000000-0000-4000-8000-000000000002";
const activationId = "00000000-0000-4000-8000-000000000003";
const policyId = "00000000-0000-4000-8000-000000000004";

function policy() {
  return {
    organizationId: 1, leagueId: 2, activationId, activationRevision: 1,
    activationSourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`,
    policyVersion: 1, collectionPoints: [{ occurrenceId: occurrenceA }],
    occurrences: [{ occurrenceId: occurrenceA, groupKey: "normal", groupRole: "normal" as const, pairedOccurrenceId: null, collectionPoint: { occurrenceId: occurrenceA } }],
  };
}

describe("F3 canonical contracts", () => {
  it("fingerprints normalized policy order and rejects date-only pairing", () => {
    const value = policy();
    validateF3PolicyShape(value);
    expect(f3PolicyFingerprint(value)).toMatch(/^lvf3policy:v1:[0-9a-f]{64}$/);
    expect(() => validateF3PolicyShape({ ...value, occurrences: [{ ...value.occurrences[0], groupRole: "trigger", pairedOccurrenceId: occurrenceB }] })).toThrow();
  });

  it("derives exact remaining balance and fails closed for upfront/disabled", () => {
    const base = {
      organizationId: 1, leagueId: 2, f3Enabled: true,
      activation: { id: activationId, revision: 1, sourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`, complete: true },
      policy: { id: policyId, version: 1, state: "approved" as const, activationId, activationRevision: 1, activationSourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`, collectionPoints: [occurrenceA], occurrenceCollectionPoints: [{ occurrenceId: occurrenceA, collectionPointOccurrenceId: occurrenceA }] },
      authorization: { id: "00000000-0000-4000-8000-000000000005", version: 1, state: "authorized" as const, payerBowlerId: 10, policyId, policyVersion: 1, coveredBowlerIds: [10], collectionPointOccurrenceIds: [occurrenceA] },
      obligations: [{ obligationId: "00000000-0000-4000-8000-000000000006", occurrenceId: occurrenceA, bowlerId: 10, amountMinor: 1000, allocatedMinor: 250, reservedMinor: 100, currency: "USD", state: "partially_settled" as const, reviewRequired: false }],
    };
    expect(deriveF3ReadyPlan({ ...base, paymentMode: "weekly" })).toMatchObject({ totalAmountMinor: 650, items: [{ amountMinor: 650 }] });
    expect(() => deriveF3ReadyPlan({ ...base, paymentMode: "upfront" })).toThrowError(F3ReadinessError);
    expect(() => deriveF3ReadyPlan({ ...base, paymentMode: "weekly", obligations: [{ ...base.obligations[0], dueAt: new Date(Date.now() - 1_000).toISOString() }] })).toThrowError(F3ReadinessError);
    expect(() => deriveF3ReadyPlan({ ...base, paymentMode: "weekly", obligations: [...base.obligations, base.obligations[0]] })).toThrowError(F3ReadinessError);
  });

  it("requires reciprocal explicit double-pay pairing", () => {
    const value = policy();
    const pair = [
      { occurrenceId: occurrenceA, groupKey: "double", groupRole: "trigger" as const, pairedOccurrenceId: occurrenceB, collectionPoint: { occurrenceId: occurrenceA } },
      { occurrenceId: occurrenceB, groupKey: "double", groupRole: "paired" as const, pairedOccurrenceId: occurrenceA, collectionPoint: { occurrenceId: occurrenceA } },
    ];
    expect(() => validateF3PolicyShape({ ...value, collectionPoints: [{ occurrenceId: occurrenceA }, { occurrenceId: occurrenceB }], occurrences: pair })).not.toThrow();
    expect(() => validateF3PolicyShape({ ...value, collectionPoints: [{ occurrenceId: occurrenceA }, { occurrenceId: occurrenceB }], occurrences: [{ ...pair[0], pairedOccurrenceId: occurrenceA }, pair[1]] })).toThrow(/PAIR_REQUIRED|PAIR_MISMATCH/);
  });
});
