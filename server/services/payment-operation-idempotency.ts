import { createHash } from "node:crypto";
import type { PaymentOperationType } from "@shared/schema";

export const PAYMENT_OPERATION_REQUEST_VERSION = 1 as const;
export const PAYMENT_OPERATION_FINGERPRINT_PREFIX = "lvpayreq:v1:" as const;
export const SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH = 45;

const KEY_PREFIX_BY_TYPE: Record<PaymentOperationType, string> = {
  scheduled_charge: "lv-op1-sc-",
  interactive_charge: "lv-op1-ic-",
  refund: "lv-op1-rf-",
};

export interface StablePaymentOperationRequest {
  organizationId: number;
  operationType: PaymentOperationType;
  targetKey: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  paymentScheduleId?: number | null;
  billingCycleAt?: string | Date | null;
}

export interface NormalizedPaymentOperationRequest {
  requestVersion: typeof PAYMENT_OPERATION_REQUEST_VERSION;
  organizationId: number;
  operationType: PaymentOperationType;
  targetKey: string;
  paymentScheduleId: number | null;
  billingCycleAt: string | null;
  amountMinor: number;
  currency: string;
  providerName: string;
}

export interface PaymentOperationIdentity {
  normalizedRequest: NormalizedPaymentOperationRequest;
  requestFingerprint: string;
  providerIdempotencyKey: string;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function requireUnpaddedToken(
  value: string,
  label: string,
  pattern: RegExp,
  maxLength: number,
): string {
  if (value.length === 0 || value.length > maxLength || value.trim() !== value || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function normalizeUtcTimestamp(value: string | Date, label: string): string {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

/** Deterministic JSON for the small immutable request object. */
export function canonicalizePaymentOperationInput(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizePaymentOperationInput(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => (
    `${JSON.stringify(key)}:${canonicalizePaymentOperationInput(item)}`
  )).join(",")}}`;
}

export function normalizePaymentOperationRequest(
  request: StablePaymentOperationRequest,
): NormalizedPaymentOperationRequest {
  requirePositiveInteger(request.organizationId, "organizationId");
  requirePositiveInteger(request.amountMinor, "amountMinor");

  const targetKey = requireUnpaddedToken(
    request.targetKey,
    "targetKey",
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
    128,
  );
  const providerName = requireUnpaddedToken(
    request.providerName,
    "providerName",
    /^[a-z0-9][a-z0-9_-]*$/,
    32,
  );
  const currency = request.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("currency must be a three-letter ISO-style code");
  }

  const paymentScheduleId = request.paymentScheduleId ?? null;
  if (paymentScheduleId !== null) {
    requirePositiveInteger(paymentScheduleId, "paymentScheduleId");
  }
  const billingCycleAt = request.billingCycleAt == null
    ? null
    : normalizeUtcTimestamp(request.billingCycleAt, "billingCycleAt");

  if (request.operationType === "scheduled_charge") {
    if (paymentScheduleId === null || billingCycleAt === null) {
      throw new Error("scheduled charges require a payment schedule and billing cycle");
    }
  } else if (billingCycleAt !== null) {
    throw new Error("billingCycleAt is reserved for scheduled charges");
  }

  return {
    requestVersion: PAYMENT_OPERATION_REQUEST_VERSION,
    organizationId: request.organizationId,
    operationType: request.operationType,
    targetKey,
    paymentScheduleId,
    billingCycleAt,
    amountMinor: request.amountMinor,
    currency,
    providerName,
  };
}

/**
 * Produces the durable request fingerprint and the exact provider key that
 * every retry must reuse. The key carries 192 hash bits and stays below
 * Square's 45-character limit for every operation type.
 */
export function buildPaymentOperationIdentity(
  request: StablePaymentOperationRequest,
): PaymentOperationIdentity {
  const normalizedRequest = normalizePaymentOperationRequest(request);
  const canonical = canonicalizePaymentOperationInput(normalizedRequest);
  const digest = createHash("sha256").update(canonical).digest();
  const requestFingerprint = `${PAYMENT_OPERATION_FINGERPRINT_PREFIX}${digest.toString("hex")}`;
  const providerIdempotencyKey = `${KEY_PREFIX_BY_TYPE[request.operationType]}${digest.subarray(0, 24).toString("base64url")}`;

  if (providerIdempotencyKey.length > SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH) {
    throw new Error(
      `provider idempotency key exceeds ${SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH} characters`,
    );
  }

  return {
    normalizedRequest,
    requestFingerprint,
    providerIdempotencyKey,
  };
}
