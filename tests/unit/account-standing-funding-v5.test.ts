import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FifoPaymentCandidate } from "../../server/services/automatic-fifo-allocation";
import { projectStandingAccountFundingTarget } from "../../server/services/account-payment-funding-targets";
import {
  ACCOUNT_STANDING_FUNDING_SNAPSHOT_FINGERPRINT_PREFIX,
  buildAccountStandingFundingSnapshot,
  fingerprintAccountStandingFundingSnapshot,
  reconstructAccountStandingFundingSnapshot,
  storeAccountStandingFundingSnapshot,
  type AccountStandingFundingOperationIdentity,
  type AccountStandingFundingSnapshotInput,
} from "../../server/services/account-standing-funding-snapshot";

const payerBowlerId = 101;
const partnerBowlerId = 202;
const consentId = randomUUID();
const triggerOccurrenceId = randomUUID();

function candidate(input: Partial<FifoPaymentCandidate> & Pick<FifoPaymentCandidate, "id" | "occurrenceId" | "outstandingMinor" | "effectiveCollectionAt">): FifoPaymentCandidate {
  return {
    id: input.id,
    occurrenceId: input.occurrenceId,
    outstandingMinor: input.outstandingMinor,
    effectiveCollectionAt: input.effectiveCollectionAt,
    dueAt: input.dueAt ?? input.effectiveCollectionAt,
    memberOrdinal: input.memberOrdinal ?? 0,
    billingOrdinal: input.billingOrdinal ?? 0,
    reservedMinor: input.reservedMinor ?? 0,
    reviewRequired: input.reviewRequired ?? false,
    pairedCollectionReady: input.pairedCollectionReady ?? false,
  };
}

function standingEvidence(overrides: Partial<AccountStandingFundingSnapshotInput["standingEvidence"]> = {}): AccountStandingFundingSnapshotInput["standingEvidence"] {
  return {
    consentId,
    consentVersion: 3,
    consentFingerprint: `lvstandingconsent:v1:${"a".repeat(64)}`,
    bindingEvidenceFingerprint: `lvstandingcutoff:v1:${"b".repeat(64)}`,
    cutoffAt: "2026-10-02T08:00:00.000Z",
    collectionMode: "weekly",
    triggerOccurrenceId,
    triggerOccurrenceRevision: 2,
    pairedOccurrenceId: null,
    collectionGroupId: null,
    collectionGroupRevision: null,
    collectionGroupFingerprint: null,
    triggerMemberId: null,
    pairedMemberId: null,
    collectionRequirementOccurrenceIds: [triggerOccurrenceId],
    ...overrides,
  };
}

function accountTarget(overrides: Partial<AccountStandingFundingSnapshotInput["recipientEvidence"][number]["target"]> = {}) {
  return {
    confirmedDebtMinor: 0,
    olderConfirmedDebtMinor: 0,
    availableCreditMinor: 0,
    creditAppliedToOlderDebtMinor: 0,
    olderConfirmedDebtRemainingMinor: 0,
    olderDebtReviewRequired: false,
    currentDebtReviewRequired: false,
    currentCollectionTargetMinor: 1_250,
    forecastCollectionTargetMinor: 1_250,
    newChargeMinor: 1_250,
    ...overrides,
  };
}

function snapshotInput(overrides: Partial<AccountStandingFundingSnapshotInput> = {}): AccountStandingFundingSnapshotInput {
  return {
    operationId: randomUUID(),
    organizationId: 8,
    leagueId: 12,
    payerBowlerId,
    amountMinor: 1_250,
    fundingPortions: [{ portionIndex: 0, creditedBowlerId: payerBowlerId, amountMinor: 1_250 }],
    recipientEvidence: [{
      recipientBowlerId: payerBowlerId,
      role: "self",
      paymentLinkId: null,
      linkFingerprint: null,
      target: accountTarget(),
    }],
    standingEvidence: standingEvidence(),
    currency: "USD",
    providerName: "square",
    providerIdempotencyKey: "lv-op-standing-v1-123456789",
    locationId: 4,
    providerLocationId: "sq-location-4",
    authorizingUserId: 22,
    ...overrides,
  };
}

function operation(value: AccountStandingFundingSnapshotInput): AccountStandingFundingOperationIdentity {
  return {
    id: value.operationId,
    operationType: "standing_autopay_charge",
    organizationId: value.organizationId,
    leagueId: value.leagueId,
    amountMinor: value.amountMinor,
    currency: value.currency,
    providerName: value.providerName,
    providerIdempotencyKey: value.providerIdempotencyKey,
    authorizingUserId: value.authorizingUserId,
  };
}

describe("account standing funding V5 snapshot", () => {
  it("round-trips one tender with separately owned recipient portions and no obligation reservations", () => {
    const input = snapshotInput({
      amountMinor: 1_500,
      fundingPortions: [{ portionIndex: 0, creditedBowlerId: partnerBowlerId, amountMinor: 1_500 }],
      recipientEvidence: [
        { recipientBowlerId: payerBowlerId, role: "self", paymentLinkId: null, linkFingerprint: null, target: accountTarget({ currentCollectionTargetMinor: 0, forecastCollectionTargetMinor: 0, newChargeMinor: 0 }) },
        { recipientBowlerId: partnerBowlerId, role: "partner", paymentLinkId: 77, linkFingerprint: `lvpartnerlink:v1:${"c".repeat(64)}`, target: accountTarget({ currentCollectionTargetMinor: 1_500, forecastCollectionTargetMinor: 1_500, newChargeMinor: 1_500 }) },
      ],
    });
    const built = buildAccountStandingFundingSnapshot({ id: input.operationId, providerIdempotencyKey: input.providerIdempotencyKey }, input);
    const stored = { ...storeAccountStandingFundingSnapshot(built), createdAt: "2026-10-02T08:00:00.000Z" };
    const restored = reconstructAccountStandingFundingSnapshot({ operation: operation(input), stored });

    expect(restored.kind).toBe("account_standing_funding");
    expect(restored.fundingPortions).toEqual([{ portionIndex: 0, creditedBowlerId: partnerBowlerId, amountMinor: 1_500 }]);
    expect(restored.payerBowlerId).toBe(payerBowlerId);
    expect(restored.allocations).toEqual([]);
    expect(restored.lineItems).toEqual([]);
    expect(stored.snapshotFingerprint).toMatch(new RegExp(`^${ACCOUNT_STANDING_FUNDING_SNAPSHOT_FINGERPRINT_PREFIX}[0-9a-f]{64}$`));
    expect(stored.sourceKind).toBeNull();
    expect(stored.encryptedSourceId).toBeNull();
    expect(stored.encryptedCustomerId).toBeNull();
  });

  it("allows forecast-only target evidence with no obligation IDs or future-week allocations", () => {
    const input = snapshotInput({
      standingEvidence: standingEvidence({ collectionRequirementOccurrenceIds: [triggerOccurrenceId] }),
    });
    const snapshot = buildAccountStandingFundingSnapshot({ id: input.operationId, providerIdempotencyKey: input.providerIdempotencyKey }, input);
    expect(snapshot.standingEvidence.collectionRequirementOccurrenceIds).toEqual([triggerOccurrenceId]);
    expect(Object.keys(snapshot)).not.toContain("obligationIds");
    expect(snapshot.fundingPortions[0]?.amountMinor).toBe(1_250);
  });

  it("rejects missing partner-link evidence, duplicate owners, and portion mismatch", () => {
    const valid = snapshotInput({
      amountMinor: 800,
      fundingPortions: [{ portionIndex: 0, creditedBowlerId: partnerBowlerId, amountMinor: 800 }],
      recipientEvidence: [{ recipientBowlerId: partnerBowlerId, role: "partner", paymentLinkId: 77, linkFingerprint: `lvpartnerlink:v1:${"d".repeat(64)}`, target: accountTarget({ currentCollectionTargetMinor: 800, forecastCollectionTargetMinor: 800, newChargeMinor: 800 }) }],
    });
    const authorizedPartnerEvidence = valid.recipientEvidence[0];
    if (!authorizedPartnerEvidence) throw new Error("partner fixture evidence is missing");
    expect(() => buildAccountStandingFundingSnapshot({ id: valid.operationId, providerIdempotencyKey: valid.providerIdempotencyKey }, {
      ...valid,
      recipientEvidence: [{ ...authorizedPartnerEvidence, paymentLinkId: null, linkFingerprint: null }],
    })).toThrow();
    expect(() => buildAccountStandingFundingSnapshot({ id: valid.operationId, providerIdempotencyKey: valid.providerIdempotencyKey }, {
      ...valid,
      fundingPortions: [
        { portionIndex: 0, creditedBowlerId: partnerBowlerId, amountMinor: 400 },
        { portionIndex: 1, creditedBowlerId: partnerBowlerId, amountMinor: 400 },
      ],
    })).toThrow();
    expect(() => buildAccountStandingFundingSnapshot({ id: valid.operationId, providerIdempotencyKey: valid.providerIdempotencyKey }, {
      ...valid,
      amountMinor: 900,
    })).toThrow();
    expect(() => buildAccountStandingFundingSnapshot({ id: valid.operationId, providerIdempotencyKey: valid.providerIdempotencyKey }, {
      ...valid,
      recipientEvidence: [{
        ...authorizedPartnerEvidence,
        target: { ...authorizedPartnerEvidence.target, currentCollectionTargetMinor: 1_500, newChargeMinor: 1_500 },
      }],
      fundingPortions: [{ portionIndex: 0, creditedBowlerId: partnerBowlerId, amountMinor: 1_500 }],
      amountMinor: 1_500,
    })).toThrow();
  });

  it("rejects fingerprint tampering and tenant/operation provenance mismatch", () => {
    const input = snapshotInput();
    const stored = { ...storeAccountStandingFundingSnapshot(input), createdAt: "2026-10-02T08:00:00.000Z" };
    expect(fingerprintAccountStandingFundingSnapshot(input)).toBe(fingerprintAccountStandingFundingSnapshot({ ...input }));
    expect(() => reconstructAccountStandingFundingSnapshot({
      operation: operation(input),
      stored: { ...stored, snapshotFingerprint: `lvstandingfunding:v1:${"f".repeat(64)}` },
    })).toThrow(/fingerprint/);
    expect(() => reconstructAccountStandingFundingSnapshot({
      operation: { ...operation(input), organizationId: 99 },
      stored,
    })).toThrow(/provenance/);
  });
});

describe("scoped standing account funding target", () => {
  it("collects a retained paired final plus the current week, then applies available credit once", () => {
    const pairedFinal = randomUUID();
    const currentWeek = randomUUID();
    const missedOrdinaryWeek = randomUUID();
    const result = projectStandingAccountFundingTarget({
      candidates: [
        candidate({ id: "final-fee", occurrenceId: pairedFinal, outstandingMinor: 2_500, effectiveCollectionAt: "2026-09-25T08:00:00.000Z", pairedCollectionReady: true, memberOrdinal: 1 }),
        candidate({ id: "current-fee", occurrenceId: currentWeek, outstandingMinor: 2_500, effectiveCollectionAt: "2026-10-02T08:00:00.000Z" }),
        candidate({ id: "missed-fee", occurrenceId: missedOrdinaryWeek, outstandingMinor: 2_500, effectiveCollectionAt: "2026-09-18T08:00:00.000Z" }),
      ],
      confirmedDebts: [],
      availableCreditMinor: 2_500,
      cutoffAt: "2026-10-02T08:00:00.000Z",
      collectionRequirementOccurrenceIds: [pairedFinal, currentWeek],
    });
    expect(result.currentCollectionTargetMinor).toBe(5_000);
    expect(result.forecastCollectionTargetMinor).toBe(5_000);
    expect(result.newChargeMinor).toBe(2_500);
  });

  it("spends existing credit on older confirmed debt before charging the current authorized target", () => {
    const oldDebtOccurrence = randomUUID();
    const currentOccurrence = randomUUID();
    const result = projectStandingAccountFundingTarget({
      candidates: [candidate({ id: "current", occurrenceId: currentOccurrence, outstandingMinor: 1_000, effectiveCollectionAt: "2026-10-02T08:00:00.000Z" })],
      confirmedDebts: [{ obligationId: "older-debt", occurrenceId: oldDebtOccurrence, outstandingMinor: 2_000, reviewRequired: false }],
      availableCreditMinor: 2_500,
      cutoffAt: "2026-10-02T08:00:00.000Z",
      collectionRequirementOccurrenceIds: [currentOccurrence],
    });
    expect(result.creditAppliedToOlderDebtMinor).toBe(2_000);
    expect(result.olderConfirmedDebtRemainingMinor).toBe(0);
    expect(result.newChargeMinor).toBe(500);
  });

  it("leaves uncovered older confirmed debt for manual or one-time handling", () => {
    const oldDebtOccurrence = randomUUID();
    const currentOccurrence = randomUUID();
    const result = projectStandingAccountFundingTarget({
      candidates: [candidate({ id: "current", occurrenceId: currentOccurrence, outstandingMinor: 1_000, effectiveCollectionAt: "2026-10-02T08:00:00.000Z" })],
      confirmedDebts: [{ obligationId: "older-debt", occurrenceId: oldDebtOccurrence, outstandingMinor: 3_000, reviewRequired: false }],
      availableCreditMinor: 2_500,
      cutoffAt: "2026-10-02T08:00:00.000Z",
      collectionRequirementOccurrenceIds: [currentOccurrence],
    });
    expect(result.olderConfirmedDebtRemainingMinor).toBe(500);
    expect(result.newChargeMinor).toBe(0);
  });

  it("stops on a review-held confirmed debt and does not catch up a missed ordinary forecast", () => {
    const heldDebtOccurrence = randomUUID();
    const dueForecast = randomUUID();
    const result = projectStandingAccountFundingTarget({
      candidates: [candidate({ id: "missed", occurrenceId: dueForecast, outstandingMinor: 4_000, effectiveCollectionAt: "2026-09-18T08:00:00.000Z" })],
      confirmedDebts: [{ obligationId: "held", occurrenceId: heldDebtOccurrence, outstandingMinor: 1_000, reviewRequired: true }],
      availableCreditMinor: 5_000,
      cutoffAt: "2026-10-02T08:00:00.000Z",
      collectionRequirementOccurrenceIds: [randomUUID()],
    });
    expect(result.olderDebtReviewRequired).toBe(true);
    expect(result.forecastCollectionTargetMinor).toBe(0);
    expect(result.newChargeMinor).toBe(0);
  });
});
