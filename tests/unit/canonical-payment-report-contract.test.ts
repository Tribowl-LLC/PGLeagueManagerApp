import { describe, expect, it } from "vitest";
import {
  CANONICAL_PAYMENT_REPORT_CONTRACT,
  canonicalPaymentReportFingerprint,
  type CanonicalPaymentReport,
} from "@shared/canonical-payment-report";
import { paymentReceiptContract, PAYMENT_RECEIPT_CONTRACT } from "@shared/payment-receipt";
import { completeF3AuthorizationRevisionChains, completeF3PolicyRevisionChains, completeVersionedRevisionChains } from "../../server/services/canonical-payment-report";

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

const revisionOccurrenceOne = "00000000-0000-4000-8000-000000000001";
const revisionOccurrenceTwo = "00000000-0000-4000-8000-000000000002";
const revisionObligationOne = "00000000-0000-4000-8000-000000000011";
const revisionObligationTwo = "00000000-0000-4000-8000-000000000012";

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
      "acceptedPartnerIds rejects duplicate historical IDs",
      {
        id: "auth-array-duplicate",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [2, 3],
        coveredBowlerIds: [1, 2, 3],
        collectionPointOccurrenceIds: ["occ-1"],
        authorizedItems: [{ obligationId: "ob-1", occurrenceId: "occ-1", collectionPointOccurrenceId: "occ-1", bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.acceptedPartnerIds = [2, 2]; },
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
        collectionPoints: [{ occurrenceId: revisionOccurrenceOne }],
        occurrences: [{ occurrenceId: revisionOccurrenceOne, groupKey: "group-1", groupRole: "normal", pairedOccurrenceId: null, collectionPointOccurrenceId: revisionOccurrenceOne, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => {
        snapshot.collectionPoints = [{ occurrenceId: 123 }];
        snapshot.occurrences = [{ occurrenceId: revisionOccurrenceOne, groupKey: "group-1", groupRole: 42, pairedOccurrenceId: null, collectionPointOccurrenceId: revisionOccurrenceOne, itemIndex: 0 }];
      },
    ],
    [
      "collection point IDs reject invalid UUID history",
      {
        id: "auth-array-uuid",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1],
        collectionPointOccurrenceIds: [revisionOccurrenceOne],
        authorizedItems: [{ obligationId: revisionObligationOne, occurrenceId: revisionOccurrenceOne, collectionPointOccurrenceId: revisionOccurrenceOne, bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.collectionPointOccurrenceIds = ["not-a-uuid"]; },
    ],
    [
      "authorized item IDs reject invalid UUID history",
      {
        id: "auth-array-item-uuid",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1],
        collectionPointOccurrenceIds: [revisionOccurrenceOne],
        authorizedItems: [{ obligationId: revisionObligationOne, occurrenceId: revisionOccurrenceOne, collectionPointOccurrenceId: revisionOccurrenceOne, bowlerId: 1, amountMinor: 500, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.authorizedItems = [{ obligationId: "not-an-obligation-uuid", occurrenceId: revisionOccurrenceOne, collectionPointOccurrenceId: revisionOccurrenceOne, bowlerId: 1, amountMinor: 500, itemIndex: 0 }]; },
    ],
    [
      "authorized item order rejects duplicate or noncanonical indexes",
      {
        id: "auth-array-item-order",
        state: "authorized",
        payerBowlerId: 1,
        acceptedPartnerIds: [],
        coveredBowlerIds: [1, 2],
        collectionPointOccurrenceIds: [revisionOccurrenceOne, revisionOccurrenceTwo],
        authorizedItems: [
          { obligationId: revisionObligationOne, occurrenceId: revisionOccurrenceOne, collectionPointOccurrenceId: revisionOccurrenceOne, bowlerId: 1, amountMinor: 500, itemIndex: 0 },
          { obligationId: revisionObligationTwo, occurrenceId: revisionOccurrenceTwo, collectionPointOccurrenceId: revisionOccurrenceTwo, bowlerId: 2, amountMinor: 600, itemIndex: 1 },
        ],
      },
      (snapshot: Record<string, unknown>) => { snapshot.authorizedItems = [{ obligationId: revisionObligationOne, occurrenceId: revisionOccurrenceOne, collectionPointOccurrenceId: revisionOccurrenceOne, bowlerId: 1, amountMinor: 500, itemIndex: 0 }, { obligationId: revisionObligationTwo, occurrenceId: revisionOccurrenceTwo, collectionPointOccurrenceId: revisionOccurrenceTwo, bowlerId: 2, amountMinor: 600, itemIndex: 2 }]; },
    ],
    [
      "policy occurrence role and group key reject invalid history",
      {
        contractVersion: "canonical-collection-policy/1",
        policy: { approvedByUserId: null },
        collectionPoints: [{ occurrenceId: revisionOccurrenceOne }],
        occurrences: [{ occurrenceId: revisionOccurrenceOne, groupKey: "group-1", groupRole: "normal", pairedOccurrenceId: null, collectionPointOccurrenceId: revisionOccurrenceOne, itemIndex: 0 }],
      },
      (snapshot: Record<string, unknown>) => { snapshot.occurrences = [{ occurrenceId: revisionOccurrenceOne, groupKey: " ", groupRole: "invalid", pairedOccurrenceId: null, collectionPointOccurrenceId: revisionOccurrenceOne, itemIndex: 0 }]; },
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

  it("accepts the approved F3 policy lifecycle and rejects an immutable historical rewrite", () => {
    const policyId = "00000000-0000-4000-8000-000000000101";
    const expected = {
      contractVersion: "canonical-collection-policy/1",
      policy: {
        id: policyId,
        organizationId: 1,
        leagueId: 2,
        activationId: "00000000-0000-4000-8000-000000000102",
        activationRevision: 1,
        activationSourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`,
        policyVersion: 1,
        policyFingerprint: `lvf3policy:v1:${"b".repeat(64)}`,
        commandKey: "policy-command-1",
        state: "superseded",
        currentRevision: 3,
        collectionPoints: [{ occurrenceId: revisionOccurrenceOne }],
        approvedByUserId: 9,
        approvedAt: "2030-01-02T00:00:00.000Z",
      },
      occurrences: [{ occurrenceId: revisionOccurrenceOne, groupKey: "group-1", groupRole: "normal", pairedOccurrenceId: null, collectionPointOccurrenceId: revisionOccurrenceOne, itemIndex: 0 }],
    };
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const draft = { ...expected, policy: { ...expected.policy, state: "draft", currentRevision: 1, approvedByUserId: null, approvedAt: null } };
    const approved = { ...expected, policy: { ...expected.policy, state: "approved", currentRevision: 2 } };
    const parent = { id: policyId, currentRevision: 3 };
    const revisions = [
      { parentId: policyId, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: draft },
      { parentId: policyId, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: draft, afterSnapshot: approved },
      { parentId: policyId, revisionNumber: 3, snapshotSchemaVersion: 1, beforeSnapshot: approved, afterSnapshot: expected },
    ];
    expect(completeF3PolicyRevisionChains([parent], revisions, () => expected)).toBe(true);

    const approvedAtRevisionOne = clone(approved);
    approvedAtRevisionOne.policy.currentRevision = 1;
    expect(completeF3PolicyRevisionChains(
      [{ id: policyId, currentRevision: 1 }],
      [{ parentId: policyId, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: approvedAtRevisionOne }],
      () => approvedAtRevisionOne,
    )).toBe(false);

    const rewritten = clone(draft);
    rewritten.policy.policyFingerprint = `lvf3policy:v1:${"c".repeat(64)}`;
    const rewrittenRevisions = [
      { ...revisions[0], afterSnapshot: rewritten },
      { ...revisions[1], beforeSnapshot: rewritten },
      revisions[2],
    ];
    expect(completeVersionedRevisionChains([parent], rewrittenRevisions, () => expected)).toBe(true);
    expect(completeF3PolicyRevisionChains([parent], rewrittenRevisions, () => expected)).toBe(false);
  });

  it("accepts authorized-to-superseded F3 auth and rejects immutable consent rewrites", () => {
    const authId = "00000000-0000-4000-8000-000000000201";
    const expected = {
      id: authId,
      organizationId: 1,
      leagueId: 2,
      payerBowlerId: 7,
      policyId: "00000000-0000-4000-8000-000000000202",
      policyVersion: 1,
      authorizationVersion: 1,
      authorizationFingerprint: `lvf3auth:v1:${"a".repeat(64)}`,
      preauthorizationQuoteFingerprint: `lvf3quote:v1:${"b".repeat(64)}`,
      authorizedItems: [{ obligationId: revisionObligationOne, occurrenceId: revisionOccurrenceOne, bowlerId: 7, collectionPointOccurrenceId: revisionOccurrenceOne, amountMinor: 500, itemIndex: 0 }],
      commandKey: "auth-command-1",
      coveredBowlerIds: [7, 8],
      acceptedPartnerIds: [8],
      collectionPointOccurrenceIds: [revisionOccurrenceOne],
      locationId: 4,
      encryptedSourceId: "encrypted-source",
      encryptedCustomerId: "encrypted-customer",
      paymentMethodFingerprint: "c".repeat(64),
      timing: "at_collection_point",
      state: "superseded",
      currentRevision: 2,
      createdByUserId: 9,
      authorizedAt: "2030-01-02T00:00:00.000Z",
      revokedAt: null,
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const authorized = clone(expected);
    authorized.state = "authorized";
    authorized.currentRevision = 1;
    const parent = { id: authId, currentRevision: 2 };
    const revisions = [
      { parentId: authId, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: authorized },
      { parentId: authId, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: authorized, afterSnapshot: expected },
    ];
    expect(completeF3AuthorizationRevisionChains([parent], revisions, () => expected)).toBe(true);

    const rewritten = clone(authorized);
    rewritten.payerBowlerId = 99;
    const rewrittenRevisions = [
      { ...revisions[0], afterSnapshot: rewritten },
      { ...revisions[1], beforeSnapshot: rewritten },
      revisions[1],
    ].slice(0, 2);
    expect(completeVersionedRevisionChains([parent], rewrittenRevisions, () => expected)).toBe(true);
    expect(completeF3AuthorizationRevisionChains([parent], rewrittenRevisions, () => expected)).toBe(false);
  });
});
