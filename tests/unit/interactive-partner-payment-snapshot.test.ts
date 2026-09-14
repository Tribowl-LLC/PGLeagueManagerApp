import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptRosterOperationSnapshot,
  fingerprintRosterOperationSnapshot,
  type RosterOperationSemanticSnapshot,
} from "../../server/services/roster-operation-snapshot";
import {
  encryptInteractivePartnerSnapshot,
  fingerprintInteractivePartnerSnapshot,
  reconstructInteractivePartnerSnapshot,
  InteractivePartnerSnapshotValidationError,
  type InteractivePartnerPaymentSnapshot,
} from "../../server/services/interactive-partner-payment-snapshot";
import { buildSquarePaymentRequestIdentity } from "../../server/services/payment-operation-idempotency";

const uuid = () => randomUUID();
const quoteFingerprint = `lvpartnerquote:v3:${"a".repeat(64)}`;
const providerIdempotencyKey = "interactive-partner-provider-key";

function allocation(
  index: number,
  bowlerId: number,
  amountMinor: number,
): InteractivePartnerPaymentSnapshot["allocations"][number] {
  return {
    allocationIndex: index,
    bowlerId,
    amountMinor,
    notes: `allocation-${index}`,
    paidByUserId: 17,
    obligationId: uuid(),
    responsibilityId: uuid(),
    responsibilityVersion: 1,
  };
}

function partnerSnapshot(overrides: Partial<InteractivePartnerPaymentSnapshot> = {}): InteractivePartnerPaymentSnapshot {
  const allocations = [allocation(0, 202, 400), allocation(1, 202, 600)];
  return {
    snapshotVersion: 3,
    organizationId: 9,
    amountMinor: 1_000,
    currency: "USD",
    providerName: "square",
    leagueId: 11,
    locationId: 13,
    providerLocationId: null,
    payerBowlerId: 101,
    requestKind: "direct",
    squarePaymentIdempotencyKey: buildSquarePaymentRequestIdentity({
      providerIdempotencyKey,
      requestKind: "direct",
      providerLocationId: null,
    }).paymentKey,
    squareOrderIdempotencyKey: null,
    sourceId: "cnon:snapshot-test",
    customerId: "customer-snapshot-test",
    buyerEmail: "payer@example.test",
    storeCard: false,
    sourceKind: "new_card",
    quoteFingerprint,
    allocations,
    lineItems: [],
    partnerEvidence: [{
      recipientBowlerId: 202,
      role: "partner",
      paymentLinkId: 77,
      linkFingerprint: `lvpartnerlink:v1:${"b".repeat(64)}`,
      selectedWeeks: 2,
      fullBalance: false,
    }],
    ...overrides,
  };
}

function legacySnapshot(): RosterOperationSemanticSnapshot {
  return {
    snapshotVersion: 2,
    organizationId: 9,
    amountMinor: 1_000,
    currency: "USD",
    providerName: "square",
    leagueId: 11,
    locationId: 13,
    providerLocationId: null,
    payerBowlerId: 101,
    requestKind: "direct",
    squarePaymentIdempotencyKey: "lv-op1-ic-payment-key",
    squareOrderIdempotencyKey: null,
    sourceId: "cnon:legacy-snapshot-test",
    customerId: "customer-snapshot-test",
    buyerEmail: "payer@example.test",
    storeCard: false,
    sourceKind: "new_card",
    quoteFingerprint: `lvrosterquote:v1:${"c".repeat(64)}`,
    allocations: [{
      allocationIndex: 0,
      bowlerId: 101,
      amountMinor: 1_000,
      notes: "legacy allocation",
      paidByUserId: null,
      obligationId: uuid(),
      responsibilityId: uuid(),
      responsibilityVersion: 1,
    }],
    lineItems: [],
  };
}

describe("interactive partner payment snapshots", () => {
  it("keeps the v2 snapshot codec available and does not accept v2 as v3", () => {
    const legacy = legacySnapshot();
    expect(fingerprintRosterOperationSnapshot(legacy)).toMatch(/^lvrosterexec:v1:[0-9a-f]{64}$/);
    expect(() => fingerprintInteractivePartnerSnapshot(legacy as never)).toThrow(InteractivePartnerSnapshotValidationError);

    const encryptedLegacy = encryptRosterOperationSnapshot(legacy);
    expect(encryptedLegacy.snapshotVersion).toBe(2);
    expect(encryptedLegacy.snapshotFingerprint).toMatch(/^lvrosterexec:v1:/);
  });

  it("records only the selected partner in partner-only evidence and round-trips all encrypted fields", () => {
    const snapshot = partnerSnapshot();
    const stored = encryptInteractivePartnerSnapshot(snapshot);
    const reconstructed = reconstructInteractivePartnerSnapshot({
      organizationId: snapshot.organizationId,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      providerName: snapshot.providerName,
      providerIdempotencyKey,
      stored,
      allocations: snapshot.allocations,
      lineItems: snapshot.lineItems,
    });

    expect(stored.partnerEvidence).toEqual(snapshot.partnerEvidence);
    expect(stored.encryptedSourceId).not.toBe(snapshot.sourceId);
    expect(reconstructed).toEqual({
      ...snapshot,
      squarePaymentIdempotencyKey: buildSquarePaymentRequestIdentity({
        providerIdempotencyKey,
        requestKind: "direct",
        providerLocationId: null,
      }).paymentKey,
    });
    expect(fingerprintInteractivePartnerSnapshot(reconstructed)).toBe(stored.snapshotFingerprint);
    expect(reconstructed.partnerEvidence).toHaveLength(1);
    expect(reconstructed.partnerEvidence[0]).toMatchObject({ role: "partner", recipientBowlerId: 202 });
  });

  it("allows payer self-only evidence and never requires a synthetic self row for partners", () => {
    const self = partnerSnapshot({
      allocations: [allocation(0, 101, 1_000)],
      partnerEvidence: [{
        recipientBowlerId: 101,
        role: "self",
        paymentLinkId: null,
        linkFingerprint: null,
        selectedWeeks: 3,
        fullBalance: true,
      }],
    });
    expect(() => fingerprintInteractivePartnerSnapshot(self)).not.toThrow();

    const partnerOnly = partnerSnapshot();
    expect(partnerOnly.partnerEvidence.some((row) => row.role === "self")).toBe(false);
    expect(() => fingerprintInteractivePartnerSnapshot(partnerOnly)).not.toThrow();
  });

  it("supports more than 25 obligations while preserving exact total and allocation reconstruction", () => {
    const allocations = Array.from({ length: 26 }, (_, index) => allocation(index, 202, 100));
    const snapshot = partnerSnapshot({ amountMinor: 2_600, allocations });
    const stored = encryptInteractivePartnerSnapshot(snapshot);
    const reconstructed = reconstructInteractivePartnerSnapshot({
      organizationId: snapshot.organizationId,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      providerName: snapshot.providerName,
      providerIdempotencyKey,
      stored,
      allocations,
      lineItems: [],
    });

    expect(reconstructed.allocations).toHaveLength(26);
    expect(reconstructed.allocations.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(2_600);
    expect(reconstructed.partnerEvidence).toEqual(snapshot.partnerEvidence);
  });

  it("rejects missing or unrelated selected-recipient evidence before fingerprinting", () => {
    const missingRecipient = partnerSnapshot({
      partnerEvidence: [{
        recipientBowlerId: 303,
        role: "partner",
        paymentLinkId: 78,
        linkFingerprint: `lvpartnerlink:v1:${"d".repeat(64)}`,
        selectedWeeks: 1,
        fullBalance: false,
      }],
    });
    expect(() => fingerprintInteractivePartnerSnapshot(missingRecipient)).toThrow(InteractivePartnerSnapshotValidationError);

    const duplicateEvidence = partnerSnapshot({
      partnerEvidence: [
        ...partnerSnapshot().partnerEvidence,
        {
          recipientBowlerId: 202,
          role: "partner",
          paymentLinkId: 79,
          linkFingerprint: `lvpartnerlink:v1:${"e".repeat(64)}`,
          selectedWeeks: 3,
          fullBalance: true,
        },
      ],
    });
    expect(() => fingerprintInteractivePartnerSnapshot(duplicateEvidence)).toThrow(InteractivePartnerSnapshotValidationError);
  });
});
