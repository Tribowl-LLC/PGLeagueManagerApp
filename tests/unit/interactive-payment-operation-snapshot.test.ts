import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPaymentOperationIdentity,
  deriveSquareOperationIdempotencyKey,
} from "../../server/services/payment-operation-idempotency";
import {
  InteractivePaymentSnapshotValidationError,
  encryptInteractivePaymentSnapshot,
  fingerprintInteractivePaymentSnapshot,
  reconstructInteractivePaymentSnapshot,
  type InteractivePaymentSemanticSnapshot,
} from "../../server/services/interactive-payment-operation-snapshot";
import { expectErrorLog } from "../helpers/expected-error-logs";

const previousEncryptionKey = process.env.FIELD_ENCRYPTION_KEY;
const fieldEncryptionKey = "7f".repeat(32);

function makeSnapshot(): {
  snapshot: InteractivePaymentSemanticSnapshot;
  providerIdempotencyKey: string;
} {
  const identity = buildPaymentOperationIdentity({
    organizationId: 41,
    operationType: "interactive_charge",
    targetKey: "interactive-charge:request-1",
    amountMinor: 8_000,
    currency: "USD",
    providerName: "square",
  });
  return {
    providerIdempotencyKey: identity.providerIdempotencyKey,
    snapshot: {
      snapshotVersion: 1,
      organizationId: 41,
      amountMinor: 8_000,
      currency: "USD",
      providerName: "square",
      leagueId: 17,
      locationId: 9,
      providerLocationId: "SQUARE_LOCATION_A",
      payerBowlerId: 100,
      requestKind: "order",
      squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
        identity.providerIdempotencyKey,
        "payment",
      ),
      squareOrderIdempotencyKey: deriveSquareOperationIdempotencyKey(
        identity.providerIdempotencyKey,
        "order",
      ),
      sourceId: "ccof:immutable-source-reference",
      customerId: "CUSTOMER_REFERENCE_A",
      buyerEmail: "buyer@example.test",
      storeCard: true,
      weekOf: "2026-11-01T00:00:00.000Z",
      combinedChargeGroupId: "combined-operation-group",
      allocations: [
        {
          allocationIndex: 0,
          bowlerId: 100,
          amountMinor: 4_000,
          lineageAmountMinor: 2_000,
          prizeFundAmountMinor: 2_000,
          weekOf: "2026-11-01T00:00:00.000Z",
          notes: "Combined payment (self + partners)",
          paidByUserId: 501,
        },
        {
          allocationIndex: 1,
          bowlerId: 101,
          amountMinor: 4_000,
          lineageAmountMinor: 2_000,
          prizeFundAmountMinor: 2_000,
          weekOf: "2026-11-01T00:00:00.000Z",
          notes: "Combined payment (paid by partner)",
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

describe("interactive payment immutable execution snapshots", () => {
  it("encrypts sensitive references and reconstructs the exact ordered request", () => {
    const { snapshot, providerIdempotencyKey } = makeSnapshot();
    const stored = encryptInteractivePaymentSnapshot(snapshot);

    expect(stored.encryptedSourceId).not.toContain(snapshot.sourceId);
    expect(stored.encryptedCustomerId).not.toContain(snapshot.customerId ?? "");
    expect(stored.encryptedBuyerEmail).not.toContain(snapshot.buyerEmail ?? "");

    const reconstructed = reconstructInteractivePaymentSnapshot({
      organizationId: snapshot.organizationId,
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
    const first = encryptInteractivePaymentSnapshot(snapshot);
    const second = encryptInteractivePaymentSnapshot(snapshot);
    expect(second.encryptedSourceId).not.toBe(first.encryptedSourceId);
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
  });

  it.each([
    ["tenant", (value: InteractivePaymentSemanticSnapshot) => ({ ...value, organizationId: 42 })],
    ["location", (value: InteractivePaymentSemanticSnapshot) => ({ ...value, locationId: 10 })],
    ["charge kind", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      requestKind: "direct" as const,
      squareOrderIdempotencyKey: null,
      lineItems: [],
    })],
    ["amount", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      amountMinor: 8_001,
      allocations: [{ ...value.allocations[0], amountMinor: 4_001 }, value.allocations[1]],
    })],
    ["source", (value: InteractivePaymentSemanticSnapshot) => ({ ...value, sourceId: "ccof:changed" })],
    ["customer", (value: InteractivePaymentSemanticSnapshot) => ({ ...value, customerId: "CUSTOMER_REFERENCE_B" })],
    ["buyer email", (value: InteractivePaymentSemanticSnapshot) => ({ ...value, buyerEmail: "other@example.test" })],
    ["save-card intent", (value: InteractivePaymentSemanticSnapshot) => ({ ...value, storeCard: false })],
    ["allocation order", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      allocations: [
        { ...value.allocations[1], allocationIndex: 0 },
        { ...value.allocations[0], allocationIndex: 1 },
      ],
    })],
    ["line-item order", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      lineItems: [
        { ...value.lineItems[1], lineItemIndex: 0 },
        { ...value.lineItems[0], lineItemIndex: 1 },
      ],
    })],
  ] as const)("changes the fingerprint when %s changes", (_label, mutate) => {
    const { snapshot } = makeSnapshot();
    const changed = mutate(snapshot);
    expect(fingerprintInteractivePaymentSnapshot(changed)).not.toBe(
      fingerprintInteractivePaymentSnapshot(snapshot),
    );
  });

  it.each([
    ["allocation total", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      allocations: [{ ...value.allocations[0], amountMinor: 3_999 }, value.allocations[1]],
    })],
    ["allocation order", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      allocations: [
        value.allocations[1],
        value.allocations[0],
      ],
    })],
    ["line-item order", (value: InteractivePaymentSemanticSnapshot) => ({
      ...value,
      lineItems: [{ ...value.lineItems[1], lineItemIndex: 1 }, value.lineItems[0]],
    })],
  ] as const)("rejects invalid %s instead of normalizing it", (_label, mutate) => {
    expect(() => fingerprintInteractivePaymentSnapshot(mutate(makeSnapshot().snapshot)))
      .toThrow(InteractivePaymentSnapshotValidationError);
  });

  it("fails closed when encrypted execution material is tampered", () => {
    const { snapshot, providerIdempotencyKey } = makeSnapshot();
    const stored = encryptInteractivePaymentSnapshot(snapshot);
    stored.encryptedSourceId = `${stored.encryptedSourceId}00`;
    expectErrorLog("Decryption failed");
    expect(() => reconstructInteractivePaymentSnapshot({
      organizationId: snapshot.organizationId,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      providerName: snapshot.providerName,
      providerIdempotencyKey,
      stored,
      allocations: snapshot.allocations,
      lineItems: snapshot.lineItems,
    })).toThrow(InteractivePaymentSnapshotValidationError);
  });
});
