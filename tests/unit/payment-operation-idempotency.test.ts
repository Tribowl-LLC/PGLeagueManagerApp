import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPaymentOperationIdentity,
  canonicalizePaymentOperationInput,
  deriveSquareOperationIdempotencyKey,
  SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH,
  type StablePaymentOperationRequest,
} from "../../server/services/payment-operation-idempotency";

const interactiveRequest: StablePaymentOperationRequest = {
  organizationId: 41,
  operationType: "interactive_charge",
  targetKey: "interactive-charge:test-request",
  amountMinor: 4_000,
  currency: "USD",
  providerName: "square",
};

describe("payment operation stable identity", () => {
  it("canonicalizes object keys deterministically", () => {
    expect(canonicalizePaymentOperationInput({ z: 1, nested: { b: 2, a: 3 } }))
      .toBe(canonicalizePaymentOperationInput({ nested: { a: 3, b: 2 }, z: 1 }));
  });

  it("returns the same fingerprint and key for the same immutable request", () => {
    const first = buildPaymentOperationIdentity(interactiveRequest);
    const second = buildPaymentOperationIdentity({ ...interactiveRequest, currency: "usd" });

    expect(second).toEqual(first);
    expect(first.requestFingerprint).toMatch(/^lvpayreq:v1:[0-9a-f]{64}$/);
    expect(first.providerIdempotencyKey).toMatch(/^lv-op1-ic-/);
    expect(first.providerIdempotencyKey.length)
      .toBeLessThanOrEqual(SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH);
  });

  it("separates operation types and targets", () => {
    const cycleOne = buildPaymentOperationIdentity(interactiveRequest);
    const interactive = buildPaymentOperationIdentity({
      ...interactiveRequest,
      targetKey: "interactive-charge:other-request",
    });
    const refund = buildPaymentOperationIdentity({
      organizationId: interactiveRequest.organizationId,
      operationType: "refund",
      targetKey: "payment:991",
      amountMinor: interactiveRequest.amountMinor,
      currency: interactiveRequest.currency,
      providerName: interactiveRequest.providerName,
    });

    expect(interactive.providerIdempotencyKey).not.toBe(cycleOne.providerIdempotencyKey);
    expect(refund.providerIdempotencyKey).not.toBe(cycleOne.providerIdempotencyKey);
    expect(interactive.providerIdempotencyKey).toMatch(/^lv-op1-ic-/);
    expect(refund.providerIdempotencyKey).toMatch(/^lv-op1-rf-/);
    expect(interactive.providerIdempotencyKey.length).toBeLessThanOrEqual(45);
    expect(refund.providerIdempotencyKey.length).toBeLessThanOrEqual(45);
  });

  it("derives independent deterministic Square order and payment keys within 45 characters", () => {
    const logical = buildPaymentOperationIdentity(interactiveRequest).providerIdempotencyKey;
    const order = deriveSquareOperationIdempotencyKey(logical, "order");
    const payment = deriveSquareOperationIdempotencyKey(logical, "payment");

    expect(order).toMatch(/^lv-sq1-o-/);
    expect(payment).toMatch(/^lv-sq1-p-/);
    expect(order).not.toBe(payment);
    expect(order).toBe(deriveSquareOperationIdempotencyKey(logical, "order"));
    expect(payment).toBe(deriveSquareOperationIdempotencyKey(logical, "payment"));
    expect(order.length).toBeLessThanOrEqual(45);
    expect(payment.length).toBeLessThanOrEqual(45);
    expect(order).not.toContain(`${logical}-order`);
    expect(payment).not.toContain(`${logical}-pay`);
  });

  it.each([
    ["tenant", { organizationId: 42 }],
    ["target", { targetKey: "interactive-charge:other-request" }],
    ["amount", { amountMinor: 4_001 }],
    ["currency", { currency: "CAD" }],
    ["provider", { providerName: "other-provider" }],
  ] as const)("does not reuse identity when %s changes", (_label, change) => {
    const original = buildPaymentOperationIdentity(interactiveRequest);
    const changed = buildPaymentOperationIdentity({ ...interactiveRequest, ...change });
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
    expect(changed.providerIdempotencyKey).not.toBe(original.providerIdempotencyKey);
  });
});

describe("payment operation routing boundaries", () => {
  it("wires refunds through durable preparation and execution", () => {
    const source = readFileSync(resolve("server/routes/payments/payment-refunds.ts"), "utf8");
    expect(source).toContain("prepareRefundPaymentOperation");
    expect(source).toContain("refundPaymentOperationExecutor");
    expect(source).not.toContain(".refundPayment(");
  });

  it("dispatches refund recovery through the existing one-shot operation wake", () => {
    const source = readFileSync(resolve("server/services/payment-operation-retry-executor.ts"), "utf8");
    expect(source).toContain('wake.operationType === "refund"');
    expect(source).toContain("refundPaymentOperationExecutor.execute");
  });

  it("keeps transaction-capable finalization independent from provider refunds", () => {
    const source = readFileSync(resolve("server/storage/payment-operations.ts"), "utf8");
    expect(source).not.toMatch(/\.refundPayment\(|payment-provider|square-payments/);
  });
});
