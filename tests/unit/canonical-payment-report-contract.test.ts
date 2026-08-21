import { describe, expect, it } from "vitest";
import {
  CANONICAL_PAYMENT_REPORT_CONTRACT,
  canonicalPaymentReportFingerprint,
  type CanonicalPaymentReport,
} from "@shared/canonical-payment-report";
import { paymentReceiptContract, PAYMENT_RECEIPT_CONTRACT } from "@shared/payment-receipt";
import { completeVersionedRevisionChains } from "../../server/services/canonical-payment-report";

const base: Omit<CanonicalPaymentReport, "fingerprint"> = {
  contractVersion: CANONICAL_PAYMENT_REPORT_CONTRACT,
  orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1",
  organizationId: 1,
  leagueId: 2,
  mode: "canonical_with_unlinked_history",
  authoritativeSource: "canonical",
  asOf: "2032-01-01T00:00:00.000Z",
  page: 1,
  limit: 50,
  totalRows: 0,
  totalTransactions: 0,
  totals: {
    grossConfirmedPaidMinor: 0,
    activeAllocatedMinor: 0,
    refundedMinor: 0,
    disputedReviewRequiredMinor: 0,
    reviewRequiredMinor: 0,
    unresolvedOperationMinor: 0,
    unallocatedLegacyMinor: 0,
  },
  rows: [],
  transactions: [],
  unlinkedHistory: [],
  paymentTiming: { paymentMode: "weekly", upfrontDueAt: null, source: "canonical_activation" },
};

describe("F5 canonical payment and receipt contracts", () => {
  it("fingerprints deterministic report ordering and changes on semantic data", () => {
    const fingerprint = canonicalPaymentReportFingerprint(base);
    expect(fingerprint).toMatch(/^lvpaymentreport:v1:[0-9a-f]{64}$/);
    expect(canonicalPaymentReportFingerprint(base)).toBe(fingerprint);
    expect(canonicalPaymentReportFingerprint({ ...base, totalRows: 1 })).not.toBe(fingerprint);
    expect(canonicalPaymentReportFingerprint({ ...base, asOf: "2033-01-01T00:00:00.000Z" })).toBe(fingerprint);
  });

  it("never infers email delivery from hosted receipt availability", () => {
    const receipt = paymentReceiptContract({ receiptUrl: "https://receipt.test/1", receiptNumber: "R-1" });
    expect(receipt.contractVersion).toBe(PAYMENT_RECEIPT_CONTRACT);
    expect(receipt.availability).toBe("available");
    expect(receipt.deliveryEvidence).toBe("delivery_not_recorded");
    expect(paymentReceiptContract({ receiptUrl: null, receiptNumber: null })).toMatchObject({
      availability: "unavailable",
      deliveryEvidence: "delivery_not_recorded",
    });
  });

  it.each([
    ["F1 eligibility", { state: "eligible", reason: "explicit_admin_selection" }],
    ["F1 assignment", { state: "assigned", teamId: 7, reason: "explicit_admin_selection" }],
    ["F3 policy", { contractVersion: "canonical-collection-policy/1", policy: { id: "policy-1", state: "approved", policyVersion: 1 }, occurrences: [{ occurrenceId: "occ-1", groupRole: "normal", itemIndex: 0 }] }],
    ["F3 authorization", { id: "auth-1", state: "authorized", payerBowlerId: 1, authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", bowlerId: 1, amountMinor: 500 }] }],
  ] as const)("rejects a consistently malformed historical %s snapshot", (_label, expected) => {
    const parent = { id: "parent-1", currentRevision: 2 };
    const malformed = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    const missingKey = Object.keys(malformed).find((key) => key !== "contractVersion") ?? Object.keys(malformed)[0];
    if (!missingKey) throw new Error("revision fixture has no semantic key");
    delete malformed[missingKey];
    const revisions = [
      { parentId: parent.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: malformed },
      { parentId: parent.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: malformed, afterSnapshot: expected },
    ];
    expect(completeVersionedRevisionChains([parent], revisions, () => expected)).toBe(false);
  });

  it.each([
    ["F1 eligibility", { state: "eligible", reason: "explicit_admin_selection" }, "state"],
    ["F1 assignment", { state: "assigned", teamId: 7, reason: "explicit_admin_selection" }, "state"],
    ["F3 policy", { contractVersion: "canonical-collection-policy/1", policy: { id: "policy-1", state: "approved", policyVersion: 1 }, occurrences: [{ occurrenceId: "occ-1", groupRole: "normal", itemIndex: 0 }] }, "contractVersion"],
    ["F3 authorization", { id: "auth-1", state: "authorized", payerBowlerId: 1, authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", bowlerId: 1, amountMinor: 500 }] }, "state"],
  ] as const)("rejects null in required historical %s snapshot fields", (_label, expected, requiredKey) => {
    const parent = { id: "parent-null", currentRevision: 2 };
    const malformed = { ...expected, [requiredKey]: null };
    const revisions = [
      { parentId: parent.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: malformed },
      { parentId: parent.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: malformed, afterSnapshot: expected },
    ];
    expect(completeVersionedRevisionChains([parent], revisions, () => expected)).toBe(false);
  });

  it.each([
    ["pairedOccurrenceId", { contractVersion: "canonical-collection-policy/1", policy: { approvedByUserId: null }, occurrences: [{ pairedOccurrenceId: null }] }, (snapshot: Record<string, unknown>) => { const occurrences = snapshot.occurrences as Array<Record<string, unknown>>; const first = occurrences[0]; if (first) first.pairedOccurrenceId = 123; }],
    ["approvedByUserId", { contractVersion: "canonical-collection-policy/1", policy: { approvedByUserId: null }, occurrences: [] }, (snapshot: Record<string, unknown>) => { const policy = snapshot.policy as Record<string, unknown>; policy.approvedByUserId = "wrong-type"; }],
    ["encryptedCustomerId", { id: "auth-1", state: "authorized", encryptedCustomerId: null, payerBowlerId: 1 }, (snapshot: Record<string, unknown>) => { snapshot.encryptedCustomerId = 123; }],
    ["eligibility state", { state: "eligible", reason: "explicit_admin_selection" }, (snapshot: Record<string, unknown>) => { snapshot.state = 42; }],
  ] as const)("rejects wrong primitive type in %s historical snapshot", (_field, expected, corrupt) => {
    const parent = { id: "parent-type", currentRevision: 2 };
    const malformed = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    corrupt(malformed);
    const revisions = [
      { parentId: parent.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: malformed },
      { parentId: parent.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: malformed, afterSnapshot: expected },
    ];
    expect(completeVersionedRevisionChains([parent], revisions, () => expected)).toBe(false);
  });

  it.each([
    [
      "empty acceptedPartnerIds rejects a malformed historical element",
      {
        id: "auth-array-empty",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1],
        collectionPointOccurrenceIds: ["occ-1"],
        authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.acceptedPartnerIds = [{}]; },
    ],
    [
      "typed acceptedPartnerIds rejects a malformed historical element",
      {
        id: "auth-array-typed",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [2],
        coveredBowlerIds: [1, 2],
        collectionPointOccurrenceIds: ["occ-1"],
        authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.acceptedPartnerIds = ["not-a-bowler-id"]; },
    ],
    [
      "nonempty coveredBowlerIds rejects a vacuous historical array",
      {
        id: "auth-array-vacuous",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1],
        collectionPointOccurrenceIds: ["occ-1"],
        authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.coveredBowlerIds = []; },
    ],
    [
      "collectionPointOccurrenceIds rejects a wrong historical element type",
      {
        id: "auth-array-occurrences",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1],
        collectionPointOccurrenceIds: ["occ-1"],
        authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.collectionPointOccurrenceIds = [123]; },
    ],
    [
      "authorizedItems rejects a malformed historical item",
      {
        id: "auth-array-items",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1],
        collectionPointOccurrenceIds: ["occ-1"],
        authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.authorizedItems = [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: "500", itemIndex: 0 }]; },
    ],
    [
      "policy collection points and occurrences reject malformed historical arrays",
      {
        contractVersion: "canonical-collection-policy/1",
        policy: { approvedByUserId: null },
        collectionPoints: [{ occurrenceId: "occ-1" }],
        occurrences: [{ occurrenceId: "occ-1", groupKey: "group-1", groupRole: "normal", pairedOccurrenceId: null, collectionPointOccurrenceId: "occ-1", itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => {
        snapshot.collectionPoints = [{ occurrenceId: 123 }];
        snapshot.occurrences = [{ occurrenceId: "occ-1", groupKey: "group-1", groupRole: 42, pairedOccurrenceId: null, collectionPointOccurrenceId: "occ-1", itemIndex: 0 }];
      },
    ],
  ] as const)("rejects %s", (_label, expected, corrupt) => {
    const parent = { id: "parent-array", currentRevision: 2 };
    const malformed = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    corrupt(malformed);
    const revisions = [
      { parentId: parent.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: malformed },
      { parentId: parent.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: malformed, afterSnapshot: expected },
    ];
    expect(completeVersionedRevisionChains([parent], revisions, () => expected)).toBe(false);
  });
});
