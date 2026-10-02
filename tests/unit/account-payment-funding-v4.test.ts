import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountPaymentFundingChargeRequestV4Schema,
  accountPaymentFundingQuoteResponseV4Schema,
  accountPaymentFundingQuoteRequestV4Schema,
  accountPaymentParticipantsResponseV4Schema,
  resolveAccountPaymentFundingChargeAmountV4,
} from "@shared/account-payment-v4-contract";
import {
  encryptAccountPaymentOperationSnapshot,
  fingerprintAccountPaymentOperationSnapshot,
  reconstructAccountPaymentOperationSnapshot,
  type AccountPaymentOperationIdentity,
  type AccountPaymentOperationSnapshotInput,
} from "../../server/services/account-payment-operation-snapshot";

process.env.FIELD_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const quoteFingerprint = `lvaccountfundquote:v4:${"a".repeat(64)}`;
const acceptedPartnerLinkFingerprint = `lvpartnerlink:v1:${"b".repeat(64)}`;

function snapshot(overrides: Partial<AccountPaymentOperationSnapshotInput> = {}): AccountPaymentOperationSnapshotInput {
  return {
    operationId: randomUUID(),
    organizationId: 8,
    leagueId: 12,
    payerBowlerId: 101,
    amountMinor: 1_250,
    fundingPortions: [{ portionIndex: 0, creditedBowlerId: 101, amountMinor: 1_250 }],
    recipientEvidence: [{ recipientBowlerId: 101, role: "self", paymentLinkId: null, linkFingerprint: null }],
    currency: "USD",
    providerName: "square",
    providerIdempotencyKey: "lv-op1-ic-account-funding-123456",
    locationId: 4,
    providerLocationId: null,
    authorizingUserId: 22,
    sourceKind: "new_card",
    sourceId: "cnon:account-funding-test",
    customerId: null,
    buyerEmail: "payer@example.test",
    storeCard: false,
    quoteFingerprint,
    ...overrides,
  };
}

function operation(value: AccountPaymentOperationSnapshotInput): AccountPaymentOperationIdentity {
  return {
    id: value.operationId,
    operationType: "interactive_charge",
    organizationId: value.organizationId,
    leagueId: value.leagueId,
    amountMinor: value.amountMinor,
    currency: value.currency,
    providerName: value.providerName,
    providerIdempotencyKey: value.providerIdempotencyKey,
    authorizingUserId: value.authorizingUserId,
  };
}

function partnerEvidence(recipientBowlerId = 202) {
  return {
    recipientBowlerId,
    role: "partner" as const,
    paymentLinkId: 77,
    linkFingerprint: acceptedPartnerLinkFingerprint,
  };
}

function twoRecipientSnapshot(): AccountPaymentOperationSnapshotInput {
  return snapshot({
    amountMinor: 1_500,
    fundingPortions: [
      { portionIndex: 0, creditedBowlerId: 101, amountMinor: 700 },
      { portionIndex: 1, creditedBowlerId: 202, amountMinor: 800 },
    ],
    recipientEvidence: [
      { recipientBowlerId: 101, role: "self", paymentLinkId: null, linkFingerprint: null },
      partnerEvidence(),
    ],
  });
}

function quoteRecipient(input: {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  selection: { kind: "explicit_amount"; amountMinor: number } | { kind: "confirmed_debt_balance" } | { kind: "forecast_collection_target"; scope?: "current_collection" | "selected_weeks" | "full_season"; weeks?: number };
  confirmedDebtMinor: number;
  availableCreditMinor: number;
  forecastCollectionTargetMinor: number;
  providerChargeAmountMinor: number;
}) {
  return input;
}

describe("account payment funding V4 contract and operation snapshots", () => {
  it("discovers legacy mode without changing V3 participant semantics", () => {
    expect(accountPaymentParticipantsResponseV4Schema.safeParse({
      contractVersion: "interactive-payment-participants/4",
      organizationId: 8,
      leagueId: 12,
      payerBowlerId: 101,
      accountingMode: "legacy_roster_v3",
    }).success).toBe(true);
  });

  it("separates confirmed debt, available credit, and forecast without requiring a self portion", () => {
    const response = {
      contractVersion: "interactive-payment-participants/4",
      organizationId: 8,
      leagueId: 12,
      payerBowlerId: 101,
      accountingMode: "confirmed_account_v4",
      paymentMode: "weekly",
      recipients: [{
        bowlerId: 202,
        name: "Partner",
        role: "partner",
        confirmedDebtMinor: 900,
        availableCreditMinor: 1_200,
        forecastTargets: {
          currentCollectionMinor: 1_500,
          selectedWeeks: [{ weeks: 1, amountMinor: 1_500 }, { weeks: 2, amountMinor: 3_000 }],
          fullSeasonMinor: 8_000,
        },
      }],
    };
    expect(accountPaymentParticipantsResponseV4Schema.safeParse(response).success).toBe(true);
    expect(accountPaymentParticipantsResponseV4Schema.safeParse({
      ...response,
      recipients: [{ ...response.recipients[0], role: "self" }],
    }).success).toBe(false);
    expect(accountPaymentParticipantsResponseV4Schema.safeParse({
      ...response,
      recipients: [response.recipients[0], response.recipients[0]],
    }).success).toBe(false);
  });

  it("keeps explicit recipient portions exact while presets apply that recipient's credit once", () => {
    expect(resolveAccountPaymentFundingChargeAmountV4({
      selection: { kind: "explicit_amount", amountMinor: 1_250 },
      confirmedDebtMinor: 3_000,
      availableCreditMinor: 900,
      forecastCollectionTargetMinor: 2_500,
    })).toBe(1_250);
    expect(resolveAccountPaymentFundingChargeAmountV4({
      selection: { kind: "confirmed_debt_balance" },
      confirmedDebtMinor: 3_000,
      availableCreditMinor: 900,
      forecastCollectionTargetMinor: 2_500,
    })).toBe(2_100);
    expect(resolveAccountPaymentFundingChargeAmountV4({
      selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 2 },
      confirmedDebtMinor: 3_000,
      availableCreditMinor: 3_000,
      forecastCollectionTargetMinor: 2_500,
    })).toBe(0);
  });

  it("quotes separate payer and partner balances and conserves one aggregate provider charge", () => {
    const response = {
      contractVersion: "account-payment-funding-quote/4",
      organizationId: 8,
      leagueId: 12,
      payerBowlerId: 101,
      currency: "USD",
      recipients: [
        quoteRecipient({
          bowlerId: 101,
          name: "Payer",
          role: "self",
          selection: { kind: "explicit_amount", amountMinor: 700 },
          confirmedDebtMinor: 3_000,
          availableCreditMinor: 900,
          forecastCollectionTargetMinor: 2_500,
          providerChargeAmountMinor: 700,
        }),
        quoteRecipient({
          bowlerId: 202,
          name: "Partner",
          role: "partner",
          selection: { kind: "confirmed_debt_balance" },
          confirmedDebtMinor: 1_500,
          availableCreditMinor: 300,
          forecastCollectionTargetMinor: 2_000,
          providerChargeAmountMinor: 1_200,
        }),
      ],
      providerChargeAmountMinor: 1_900,
      quoteFingerprint,
    };
    expect(accountPaymentFundingQuoteResponseV4Schema.safeParse(response).success).toBe(true);
    expect(accountPaymentFundingQuoteResponseV4Schema.safeParse({ ...response, providerChargeAmountMinor: 700 }).success).toBe(false);
    expect(accountPaymentFundingQuoteResponseV4Schema.safeParse({
      ...response,
      recipients: response.recipients.map((recipient) => ({ ...recipient, coveredWeeks: ["not confirmed"] })),
    }).success).toBe(false);

    const partnerOnly = {
      ...response,
      recipients: [response.recipients[1]],
      providerChargeAmountMinor: 1_200,
    };
    expect(accountPaymentFundingQuoteResponseV4Schema.safeParse(partnerOnly).success).toBe(true);
  });

  it("validates unique recipient selections and keeps tenant identity server-owned", () => {
    const request = {
      recipients: [
        { bowlerId: 101, selection: { kind: "explicit_amount", amountMinor: 700 } },
        { bowlerId: 202, selection: { kind: "forecast_collection_target" } },
      ],
    };
    expect(accountPaymentFundingQuoteRequestV4Schema.safeParse(request).success).toBe(true);
    expect(accountPaymentFundingQuoteRequestV4Schema.safeParse({ ...request, organizationId: 8 }).success).toBe(false);
    expect(accountPaymentFundingQuoteRequestV4Schema.safeParse({ ...request, recipients: [request.recipients[0], request.recipients[0]] }).success).toBe(false);

    const charge = {
      ...request,
      sourceId: "cnon:test-token",
      sourceKind: "new_card",
      storeCard: false,
      idempotencyKey: "account-funding-request-0001",
      quoteFingerprint,
    };
    expect(accountPaymentFundingChargeRequestV4Schema.safeParse(charge).success).toBe(true);
    expect(accountPaymentFundingChargeRequestV4Schema.safeParse({ ...charge, organizationId: 8 }).success).toBe(false);
    expect(accountPaymentFundingChargeRequestV4Schema.safeParse({ ...charge, sourceKind: "wallet", storeCard: true }).success).toBe(false);
    expect(accountPaymentFundingQuoteRequestV4Schema.safeParse({ recipients: [{ bowlerId: 202, selection: { kind: "forecast_collection_target", scope: "selected_weeks" } }] }).success).toBe(false);
    expect(accountPaymentFundingQuoteRequestV4Schema.safeParse({ recipients: [{ bowlerId: 202, selection: { kind: "forecast_collection_target", scope: "current_collection", weeks: 1 } }] }).success).toBe(false);
  });

  it("round-trips one combined tender and immutable payer/partner credit portions with zero obligation allocations", () => {
    const value = twoRecipientSnapshot();
    const encrypted = encryptAccountPaymentOperationSnapshot(value);
    const reconstructed = reconstructAccountPaymentOperationSnapshot({ operation: operation(value), stored: { ...encrypted, createdAt: new Date().toISOString() } });

    expect(encrypted.snapshotFingerprint).toMatch(/^lvaccountfunding:v4:[0-9a-f]{64}$/);
    expect(encrypted.encryptedSourceId).not.toBe(value.sourceId);
    expect(reconstructed).toMatchObject({
      operationId: value.operationId,
      organizationId: value.organizationId,
      leagueId: value.leagueId,
      payerBowlerId: 101,
      amountMinor: 1_500,
      fundingPortions: [
        { portionIndex: 0, creditedBowlerId: 101, amountMinor: 700 },
        { portionIndex: 1, creditedBowlerId: 202, amountMinor: 800 },
      ],
      recipientEvidence: value.recipientEvidence,
      sourceId: value.sourceId,
      kind: "account_funding",
      allocations: [],
      lineItems: [],
    });
    expect(reconstructed.snapshotFingerprint).toBe(encrypted.snapshotFingerprint);
  });

  it("retains the single-owner funding shape as a one-portion receipt", () => {
    const value = snapshot();
    const stored = { ...encryptAccountPaymentOperationSnapshot(value), createdAt: new Date().toISOString() };
    const reconstructed = reconstructAccountPaymentOperationSnapshot({ operation: operation(value), stored });
    expect(reconstructed.fundingPortions).toEqual([{ portionIndex: 0, creditedBowlerId: 101, amountMinor: value.amountMinor }]);
    expect(reconstructed.allocations).toEqual([]);
  });

  it("supports partner-only funding while retaining the original payer separately", () => {
    const value = snapshot({
      amountMinor: 1_250,
      fundingPortions: [{ portionIndex: 0, creditedBowlerId: 202, amountMinor: 1_250 }],
      recipientEvidence: [partnerEvidence()],
    });
    const reconstructed = reconstructAccountPaymentOperationSnapshot({
      operation: operation(value),
      stored: { ...encryptAccountPaymentOperationSnapshot(value), createdAt: new Date().toISOString() },
    });
    expect(reconstructed.payerBowlerId).toBe(101);
    expect(reconstructed.fundingPortions).toEqual([{ portionIndex: 0, creditedBowlerId: 202, amountMinor: 1_250 }]);
    expect(reconstructed.recipientEvidence).toEqual([partnerEvidence()]);
  });

  it("rejects nonconserving, duplicate, misordered, or unauthorised recipient portions", () => {
    const value = twoRecipientSnapshot();
    const payerPortion = value.fundingPortions[0];
    const partnerPortion = value.fundingPortions[1];
    const payerEvidence = value.recipientEvidence[0];
    if (!payerPortion || !partnerPortion || !payerEvidence) throw new Error("test fixture is missing expected recipient evidence");
    const mutations: Array<Partial<AccountPaymentOperationSnapshotInput>> = [
      { fundingPortions: [{ portionIndex: 0, creditedBowlerId: 101, amountMinor: 1_499 }, partnerPortion] },
      { fundingPortions: [payerPortion, { portionIndex: 1, creditedBowlerId: 101, amountMinor: 800 }] },
      { fundingPortions: [{ portionIndex: 1, creditedBowlerId: 101, amountMinor: 700 }, partnerPortion] },
      { recipientEvidence: [payerEvidence] },
      { recipientEvidence: [payerEvidence, partnerEvidence(303)] },
      { recipientEvidence: [{ recipientBowlerId: 202, role: "partner", paymentLinkId: null, linkFingerprint: null }] },
      { recipientEvidence: [{ recipientBowlerId: 202, role: "self", paymentLinkId: null, linkFingerprint: null }] },
    ];
    for (const mutation of mutations) {
      expect(() => encryptAccountPaymentOperationSnapshot({ ...value, ...mutation })).toThrow();
    }
  });

  it("fingerprints operation provenance and rejects snapshot or provider identity tampering", () => {
    const value = twoRecipientSnapshot();
    const encrypted = encryptAccountPaymentOperationSnapshot(value);
    const stored = { ...encrypted, createdAt: new Date().toISOString() };
    const expected = operation(value);
    const reordered: AccountPaymentOperationSnapshotInput = {
      quoteFingerprint: value.quoteFingerprint,
      storeCard: value.storeCard,
      buyerEmail: value.buyerEmail,
      customerId: value.customerId,
      sourceId: value.sourceId,
      sourceKind: value.sourceKind,
      authorizingUserId: value.authorizingUserId,
      providerLocationId: value.providerLocationId,
      locationId: value.locationId,
      providerIdempotencyKey: value.providerIdempotencyKey,
      providerName: value.providerName,
      currency: value.currency,
      fundingPortions: value.fundingPortions,
      recipientEvidence: value.recipientEvidence,
      amountMinor: value.amountMinor,
      payerBowlerId: value.payerBowlerId,
      leagueId: value.leagueId,
      organizationId: value.organizationId,
      operationId: value.operationId,
    };
    expect(fingerprintAccountPaymentOperationSnapshot(reordered)).toBe(fingerprintAccountPaymentOperationSnapshot(value));
    expect(reconstructAccountPaymentOperationSnapshot({ operation: expected, stored }).snapshotFingerprint)
      .toBe(reconstructAccountPaymentOperationSnapshot({ operation: expected, stored }).snapshotFingerprint);

    for (const alteredOperation of [
      { ...expected, organizationId: expected.organizationId + 1 },
      { ...expected, leagueId: expected.leagueId === null ? 1 : expected.leagueId + 1 },
      { ...expected, amountMinor: expected.amountMinor + 1 },
      { ...expected, providerName: "other-provider" },
      { ...expected, authorizingUserId: expected.authorizingUserId === null ? 1 : expected.authorizingUserId + 1 },
      { ...expected, providerIdempotencyKey: `${expected.providerIdempotencyKey}-changed` },
    ]) {
      expect(() => reconstructAccountPaymentOperationSnapshot({ operation: alteredOperation, stored })).toThrow();
    }

    const tamperedEvidence = {
      ...stored,
      recipientEvidence: [stored.recipientEvidence[0], { ...stored.recipientEvidence[1], linkFingerprint: `lvpartnerlink:v1:${"c".repeat(64)}` }],
    };
    expect(() => reconstructAccountPaymentOperationSnapshot({ operation: expected, stored: tamperedEvidence })).toThrow(/fingerprint/);
  });
});
