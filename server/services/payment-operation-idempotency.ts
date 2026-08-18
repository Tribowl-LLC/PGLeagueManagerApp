import { createHash } from "node:crypto";
import type { PaymentOperationType } from "@shared/schema";
import type { PaymentRequestIdentity } from "./payment-provider";

export const PAYMENT_OPERATION_REQUEST_VERSION = 1 as const;
export const PAYMENT_OPERATION_FINGERPRINT_PREFIX = "lvpayreq:v1:" as const;
export const SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH = 45;
export const INTERACTIVE_REQUEST_KEY_MIN_LENGTH = 16;
export const INTERACTIVE_REQUEST_KEY_MAX_LENGTH = 109;

/**
 * Client-owned logical identities are deliberately narrower than the
 * provider's key alphabet. UUIDs and URL-safe retry keys are accepted, while
 * whitespace, control characters, and punctuation with ambiguous transport
 * escaping are rejected before an operation snapshot can be created.
 */
export function validateInteractiveRequestKey(value: string): string {
  if (
    value.length < INTERACTIVE_REQUEST_KEY_MIN_LENGTH
    || value.length > INTERACTIVE_REQUEST_KEY_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(
      `Idempotency-Key must be ${INTERACTIVE_REQUEST_KEY_MIN_LENGTH}-${INTERACTIVE_REQUEST_KEY_MAX_LENGTH} URL-safe ASCII characters`,
    );
  }
  return value;
}

export type SquareOperationIdempotencyDomain = "order" | "payment";

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

/**
 * Binds an occurrence-aware selection and its immutable base quote evidence to
 * the logical operation fingerprint. The provider idempotency key remains the
 * operation key, while same-key retries with changed F2 semantics conflict
 * before any live balance quote or provider work is attempted.
 */
export function fingerprintInteractiveOccurrenceIntent(input: {
  selections: Array<{ obligationId: string; amountMinor: number }>;
  quoteFingerprint: string;
}): string {
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput({
      selections: input.selections,
      quoteFingerprint: input.quoteFingerprint,
    }))
    .digest("hex");
  return `lvpayintent:v1:${digest}`;
}

export function bindInteractiveOccurrenceRequestFingerprint(
  baseRequestFingerprint: string,
  occurrenceIntentFingerprint?: string,
): string {
  if (!occurrenceIntentFingerprint) return baseRequestFingerprint;
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput({ baseRequestFingerprint, occurrenceIntentFingerprint }))
    .digest("hex");
  return `${PAYMENT_OPERATION_FINGERPRINT_PREFIX}${digest}`;
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

/**
 * Square order and payment requests are separate idempotency domains. Hashing
 * the stored logical-operation key with an explicit domain gives each request
 * an independent key without exceeding Square's 45-character ceiling or
 * appending a suffix to the already-42-character ledger key.
 */
export function deriveSquareOperationIdempotencyKey(
  providerIdempotencyKey: string,
  domain: SquareOperationIdempotencyDomain,
): string {
  if (
    providerIdempotencyKey.length === 0
    || providerIdempotencyKey.length > SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH
    || providerIdempotencyKey.trim() !== providerIdempotencyKey
  ) {
    throw new Error("provider idempotency key has an invalid format");
  }
  const digest = createHash("sha256")
    .update(`lv-square-request:v1\0${domain}\0${providerIdempotencyKey}`)
    .digest()
    .subarray(0, 24)
    .toString("base64url");
  const prefix = domain === "order" ? "lv-sq1-o-" : "lv-sq1-p-";
  const key = `${prefix}${digest}`;
  if (key.length > SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH) {
    throw new Error(`Square ${domain} idempotency key exceeds the provider limit`);
  }
  return key;
}

/**
 * Stable Square CreateCard identity for the optional pre-charge vault step.
 * It is derived from the durable operation identity, never from a one-time
 * source token, and remains within Square's 45-character limit.
 */
export function deriveSquareCardSaveIdempotencyKey(providerIdempotencyKey: string): string {
  if (
    providerIdempotencyKey.length === 0
    || providerIdempotencyKey.length > SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH
    || providerIdempotencyKey.trim() !== providerIdempotencyKey
  ) {
    throw new Error("provider idempotency key has an invalid format");
  }
  const digest = createHash("sha256")
    .update(`lv-square-request:v1\0card\0${providerIdempotencyKey}`)
    .digest()
    .subarray(0, 24)
    .toString("base64url");
  const key = `lv-sq1-c-${digest}`;
  if (key.length > SQUARE_OPERATION_IDEMPOTENCY_MAX_LENGTH) {
    throw new Error("Square card idempotency key exceeds the provider limit");
  }
  return key;
}

/** Single versioned Square identity constructor used by legacy and ledger. */
export function buildSquarePaymentRequestIdentity(input: {
  providerIdempotencyKey: string;
  requestKind: "direct" | "order";
  providerLocationId?: string | null;
}): PaymentRequestIdentity {
  return {
    paymentKey: deriveSquareOperationIdempotencyKey(input.providerIdempotencyKey, "payment"),
    orderKey: input.requestKind === "order"
      ? deriveSquareOperationIdempotencyKey(input.providerIdempotencyKey, "order")
      : undefined,
    providerLocationId: input.providerLocationId ?? undefined,
  };
}
