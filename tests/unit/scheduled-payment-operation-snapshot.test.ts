import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPaymentOperationIdentity,
  deriveSquareOperationIdempotencyKey,
} from "../../server/services/payment-operation-idempotency";
import {
  ScheduledPaymentSnapshotValidationError,
  encryptScheduledPaymentSnapshot,
  fingerprintScheduledPaymentSnapshot,
  reconstructScheduledPaymentSnapshot,
  type ScheduledPaymentSemanticSnapshot,
} from "../../server/services/scheduled-payment-operation-snapshot";
import { expectErrorLog } from "../helpers/expected-error-logs";

const previousEncryptionKey = process.env.FIELD_ENCRYPTION_KEY;
const fieldEncryptionKey = "7f".repeat(32);

function makeSnapshot(): {
  snapshot: ScheduledPaymentSemanticSnapshot;
  providerIdempotencyKey: string;
} {
  const identity = buildPaymentOperationIdentity({
    organizationId: 41,
    operationType: "scheduled_charge",
    targetKey: "payment-schedule:72",
    paymentScheduleId: 72,
    billingCycleAt: "2026-11-01T05:30:00.000Z",
    amountMinor: 8_000,
    currency: "USD",
    providerName: "square",
  });
  return {
    providerIdempotencyKey: identity.providerIdempotencyKey,
    snapshot: {
      snapshotVersion: 1,
      organizationId: 41,
      paymentScheduleId: 72,
      billingCycleAt: "2026-11-01T05:30:00.000Z",
      amountMinor: 8_000,
      currency: "USD",
      providerName: "square",
      leagueId: 17,
      locationId: 9,
      providerLocationId: "SQUARE_LOCATION_A",
      requestKind: "order",
      squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
        identity.providerIdempotencyKey,
        "payment",
      ),
      squareOrderIdempotencyKey: deriveSquareOperationIdempotencyKey(
        identity.providerIdempotencyKey,
        "order",
      ),
      autocomplete: true,
      storeCard: false,
      sourceId: "ccof:immutable-source-reference",
      customerId: "CUSTOMER_REFERENCE_A",
      buyerEmail: "buyer@example.test",
      isDoublePay: true,
      deactivateScheduleOnPreparation: false,
      paidInFullThresholdAmountMinor: 24_000,
      seasonStartAt: "2026-09-01T00:00:00.000Z",
      seasonEndAt: "2026-12-01T00:00:00.000Z",
      allocations: [
        {
          allocationIndex: 0,
          bowlerId: 100,
          amountMinor: 4_000,
          lineageAmountMinor: 2_000,
          prizeFundAmountMinor: 2_000,
          notes: "Double-pay week (combined autopay self)",
          paidByUserId: 501,
        },
        {
          allocationIndex: 1,
          bowlerId: 101,
          amountMinor: 4_000,
          lineageAmountMinor: 2_000,
          prizeFundAmountMinor: 2_000,
          notes: "Combined autopay (paid by partner)",
          paidByUserId: 501,
        },
      ],
      lineItems: [
        { lineItemIndex: 0, catalogObjectId: "LINEAGE_VARIATION_A", quantity: "4" },
        { lineItemIndex: 1, catalogObjectId: "PRIZE_VARIATION_A", quantity: "4" },
      ],
    },
  };
}

beforeAll(() => {
  process.env.FIELD_ENCRYPTION_KEY = fieldEncryptionKey;
});

afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = previousEncryptionKey;
});

describe("scheduled payment immutable execution snapshots", () => {
  it("encrypts sensitive references and reconstructs the exact semantic request", () => {
    const { snapshot, providerIdempotencyKey } = makeSnapshot();
    const stored = encryptScheduledPaymentSnapshot(snapshot);

    expect(stored.encryptedSourceId).not.toContain(snapshot.sourceId);
    expect(stored.encryptedCustomerId).not.toContain(snapshot.customerId ?? "");
    expect(stored.encryptedBuyerEmail).not.toContain(snapshot.buyerEmail ?? "");

    const reconstructed = reconstructScheduledPaymentSnapshot({
      organizationId: snapshot.organizationId,
      paymentScheduleId: snapshot.paymentScheduleId,
      billingCycleAt: snapshot.billingCycleAt,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      providerName: snapshot.providerName,
      providerIdempotencyKey,
      stored,
      allocations: snapshot.allocations,
      lineItems: snapshot.lineItems,
    });
    expect(reconstructed).toEqual(snapshot);
  });

  it("uses randomized ciphertext without changing the semantic fingerprint", () => {
    const { snapshot } = makeSnapshot();
    const first = encryptScheduledPaymentSnapshot(snapshot);
    const second = encryptScheduledPaymentSnapshot(snapshot);
    expect(second.encryptedSourceId).not.toBe(first.encryptedSourceId);
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
  });

  it.each([
    ["billing cycle", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, billingCycleAt: "2026-11-08T06:30:00.000Z" })],
    ["amount", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, amountMinor: 8_001, allocations: [{ ...value.allocations[0], amountMinor: 4_001 }, value.allocations[1]] })],
    ["source", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, sourceId: "ccof:changed" })],
    ["customer", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, customerId: "CUSTOMER_REFERENCE_B" })],
    ["buyer email", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, buyerEmail: "other@example.test" })],
    ["league", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, leagueId: 18 })],
    ["internal location", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, locationId: 10 })],
    ["provider location", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, providerLocationId: "SQUARE_LOCATION_B" })],
    ["payment idempotency key", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, squarePaymentIdempotencyKey: "different-payment-key" })],
    ["order idempotency key", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, squareOrderIdempotencyKey: "different-order-key" })],
    ["request kind", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, requestKind: "direct" as const, squareOrderIdempotencyKey: null, lineItems: [] })],
    ["catalog id", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, lineItems: [{ ...value.lineItems[0], catalogObjectId: "LINEAGE_VARIATION_B" }, value.lineItems[1]] })],
    ["quantity", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, lineItems: [{ ...value.lineItems[0], quantity: "5" }, value.lineItems[1]] })],
    ["allocation", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, allocations: [{ ...value.allocations[0], bowlerId: 102 }, value.allocations[1]] })],
    ["allocation split", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, allocations: [{ ...value.allocations[0], lineageAmountMinor: 1_999, prizeFundAmountMinor: 2_001 }, value.allocations[1]] })],
    ["double-pay marker", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, isDoublePay: false })],
    ["paid-in-full threshold", (value: ScheduledPaymentSemanticSnapshot) => ({ ...value, paidInFullThresholdAmountMinor: 28_000 })],
  ] as const)("changes the fingerprint when %s changes", (_label, mutate) => {
    const { snapshot } = makeSnapshot();
    const changed = mutate(snapshot);
    expect(fingerprintScheduledPaymentSnapshot(changed)).not.toBe(
      fingerprintScheduledPaymentSnapshot(snapshot),
    );
  });

  it.each([
    ["autocomplete", { autocomplete: false }],
    ["store-card", { storeCard: true }],
    ["currency", { currency: "CAD" }],
    ["provider", { providerName: "other" }],
  ])("fails closed instead of accepting changed %s semantics", (_label, change) => {
    const { snapshot } = makeSnapshot();
    expect(() => fingerprintScheduledPaymentSnapshot({
      ...snapshot,
      ...change,
    } as ScheduledPaymentSemanticSnapshot)).toThrow(ScheduledPaymentSnapshotValidationError);
  });

  it("fails closed when encrypted execution material is tampered", () => {
    expectErrorLog("[Crypto] Decryption failed");
    const { snapshot, providerIdempotencyKey } = makeSnapshot();
    const stored = encryptScheduledPaymentSnapshot(snapshot);
    stored.encryptedSourceId = `${stored.encryptedSourceId}00`;
    expect(() => reconstructScheduledPaymentSnapshot({
      organizationId: snapshot.organizationId,
      paymentScheduleId: snapshot.paymentScheduleId,
      billingCycleAt: snapshot.billingCycleAt,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      providerName: snapshot.providerName,
      providerIdempotencyKey,
      stored,
      allocations: snapshot.allocations,
      lineItems: snapshot.lineItems,
    })).toThrow(ScheduledPaymentSnapshotValidationError);
  });
});
