import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPaymentOperationIdentity,
  canonicalizePaymentOperationInput,
  SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH,
  type StablePaymentOperationRequest,
} from "../../server/services/payment-operation-idempotency";

const scheduledRequest: StablePaymentOperationRequest = {
  organizationId: 41,
  operationType: "scheduled_charge",
  targetKey: "payment-schedule:72",
  paymentScheduleId: 72,
  billingCycleAt: "2026-09-01T23:30:00.000Z",
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
    const first = buildPaymentOperationIdentity(scheduledRequest);
    const second = buildPaymentOperationIdentity({ ...scheduledRequest, currency: "usd" });

    expect(second).toEqual(first);
    expect(first.requestFingerprint).toMatch(/^lvpayreq:v1:[0-9a-f]{64}$/);
    expect(first.providerIdempotencyKey).toMatch(/^lv-op1-sc-/);
    expect(first.providerIdempotencyKey.length)
      .toBeLessThanOrEqual(SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH);
  });

  it("separates billing cycles and operation types", () => {
    const cycleOne = buildPaymentOperationIdentity(scheduledRequest);
    const cycleTwo = buildPaymentOperationIdentity({
      ...scheduledRequest,
      billingCycleAt: "2026-09-08T23:30:00.000Z",
    });
    const interactive = buildPaymentOperationIdentity({
      organizationId: scheduledRequest.organizationId,
      operationType: "interactive_charge",
      targetKey: scheduledRequest.targetKey,
      paymentScheduleId: scheduledRequest.paymentScheduleId,
      amountMinor: scheduledRequest.amountMinor,
      currency: scheduledRequest.currency,
      providerName: scheduledRequest.providerName,
    });
    const refund = buildPaymentOperationIdentity({
      organizationId: scheduledRequest.organizationId,
      operationType: "refund",
      targetKey: "payment:991",
      amountMinor: scheduledRequest.amountMinor,
      currency: scheduledRequest.currency,
      providerName: scheduledRequest.providerName,
    });

    expect(cycleTwo.providerIdempotencyKey).not.toBe(cycleOne.providerIdempotencyKey);
    expect(interactive.providerIdempotencyKey).not.toBe(cycleOne.providerIdempotencyKey);
    expect(refund.providerIdempotencyKey).not.toBe(cycleOne.providerIdempotencyKey);
    expect(interactive.providerIdempotencyKey).toMatch(/^lv-op1-ic-/);
    expect(refund.providerIdempotencyKey).toMatch(/^lv-op1-rf-/);
    expect(interactive.providerIdempotencyKey.length).toBeLessThanOrEqual(45);
    expect(refund.providerIdempotencyKey.length).toBeLessThanOrEqual(45);
  });

  it.each([
    ["tenant", { organizationId: 42 }],
    ["target", { targetKey: "payment-schedule:73", paymentScheduleId: 73 }],
    ["amount", { amountMinor: 4_001 }],
    ["currency", { currency: "CAD" }],
    ["provider", { providerName: "other-provider" }],
  ] as const)("does not reuse identity when %s changes", (_label, change) => {
    const original = buildPaymentOperationIdentity(scheduledRequest);
    const changed = buildPaymentOperationIdentity({ ...scheduledRequest, ...change });
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
    expect(changed.providerIdempotencyKey).not.toBe(original.providerIdempotencyKey);
  });
});

describe("Phase 2A dormant boundary", () => {
  it.each([
    "server/services/payment-scheduler.ts",
    "server/services/payment-lifecycle.ts",
    "server/services/payment-execution.ts",
    "server/routes/payments-provider/charges.ts",
    "server/routes/payments/payment-refunds.ts",
    "server/index.ts",
  ])("does not wire the ledger into %s", (path) => {
    const source = readFileSync(resolve(path), "utf8");
    expect(source).not.toMatch(/payment-operation|paymentOperations/);
  });
});
