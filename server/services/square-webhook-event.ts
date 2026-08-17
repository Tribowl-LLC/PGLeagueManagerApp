import { z } from "zod";

export const SQUARE_WEBHOOK_EVENT_TYPES = [
  "refund.updated",
  "payment.updated",
  "dispute.created",
  "dispute.state.updated",
] as const;

export const SQUARE_WEBHOOK_DIAGNOSTIC_STAGES = [
  "origin_gate",
  "full_normalize",
] as const;
export type SquareWebhookDiagnosticStage = (typeof SQUARE_WEBHOOK_DIAGNOSTIC_STAGES)[number];

export const SQUARE_WEBHOOK_DIAGNOSTIC_REASONS = [
  "invalid_json",
  "invalid_envelope",
  "wrong_data_type",
  "missing_target_object",
  "object_id_mismatch",
  "location_mismatch",
  "invalid_amount_currency",
  "required_field_or_timestamp_invalid",
  "unsupported_event_without_unique_location",
] as const;
export type SquareWebhookDiagnosticReason = (typeof SQUARE_WEBHOOK_DIAGNOSTIC_REASONS)[number];

export type SquareWebhookDiagnosticEventType = (typeof SQUARE_WEBHOOK_EVENT_TYPES)[number] | "other";

const supportedTypes = new Set<string>(SQUARE_WEBHOOK_EVENT_TYPES);
const safeProviderString = z.string().trim().min(1).max(255).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "contains control characters",
);
const eventTypeSchema = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/);
const timestampSchema = z.string().trim().min(1).max(64).refine(
  (value) => Number.isFinite(new Date(value).getTime()),
  "invalid timestamp",
);

const envelopeSchema = z.object({
  merchant_id: safeProviderString,
  location_id: safeProviderString.optional(),
  type: eventTypeSchema,
  event_id: safeProviderString,
  created_at: timestampSchema,
  data: z.object({
    type: safeProviderString,
    id: safeProviderString,
    object: z.record(z.string(), z.unknown()),
  }),
});

const moneySchema = z.object({
  amount: z.number().int().positive().max(2_147_483_647),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
});

const refundSchema = z.object({
  id: safeProviderString,
  payment_id: safeProviderString,
  location_id: safeProviderString,
  status: z.string().trim().min(1).max(50),
  amount_money: moneySchema,
  updated_at: timestampSchema.optional(),
  version: z.number().int().positive().optional(),
});

const paymentSchema = z.object({
  id: safeProviderString,
  location_id: safeProviderString,
  status: z.string().trim().min(1).max(50),
  amount_money: moneySchema,
  updated_at: timestampSchema.optional(),
  order_id: safeProviderString.optional(),
  reference_id: z.string().trim().min(1).max(40).optional(),
  receipt_url: z.string().url().max(2048).optional(),
  receipt_number: z.string().trim().min(1).max(32).optional(),
});

const paymentOriginSchema = z.object({
  id: safeProviderString,
  location_id: safeProviderString,
  reference_id: z.string().trim().min(1).max(40).nullish(),
  application_details: z.object({
    application_id: safeProviderString.nullish(),
    square_product: safeProviderString.nullish(),
  }).nullish(),
});

// LeagueVault creates Payments through the e-commerce API. These named
// first-party Square surfaces are therefore affirmative foreign-origin
// evidence when both LeagueVault markers are absent. OTHER, ECOMMERCE_API,
// and future values stay ambiguous and take the durable path.
const DEFINITELY_UNRELATED_SQUARE_PRODUCTS = new Set([
  "APPOINTMENTS",
  "INVOICES",
  "ONLINE_STORE",
  "RESTAURANTS",
  "RETAIL",
  "SQUARE_POS",
  "TERMINAL_API",
  "VIRTUAL_TERMINAL",
]);

const PAYMENT_OPERATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const disputeSchema = z.object({
  id: safeProviderString,
  location_id: safeProviderString,
  amount_money: moneySchema,
  disputed_payment: z.object({ payment_id: safeProviderString }),
  reason: safeProviderString,
  state: z.string().trim().min(1).max(50),
  due_at: timestampSchema.nullish(),
  card_brand: safeProviderString.nullish(),
  brand_dispute_id: safeProviderString.nullish(),
  created_at: timestampSchema,
  reported_at: timestampSchema.nullish(),
  updated_at: timestampSchema,
  version: z.number().int().positive(),
});

export interface NormalizedSquareDisputeEvidence {
  reason: string;
  dueAt: string | null;
  cardBrand: string | null;
  brandDisputeId: string | null;
  createdAt: string;
  reportedAt: string | null;
}

export interface NormalizedSquareWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerCreatedAt: string;
  providerMerchantId: string;
  providerLocationId: string;
  providerObjectType: string;
  providerObjectId: string;
  providerPaymentId: string | null;
  providerObjectVersion: number | null;
  providerObjectUpdatedAt: string | null;
  ignored: boolean;
  providerStatus: string | null;
  amountMinor: number | null;
  currency: string | null;
  providerOrderId: string | null;
  providerReferenceId: string | null;
  receiptUrl: string | null;
  receiptNumber: string | null;
  dispute: NormalizedSquareDisputeEvidence | null;
}

export function squareWebhookDiagnosticEventType(value: unknown): SquareWebhookDiagnosticEventType {
  return typeof value === "string" && supportedTypes.has(value)
    ? value as SquareWebhookDiagnosticEventType
    : "other";
}

export class SquareWebhookPayloadError extends Error {
  readonly diagnosticStage: SquareWebhookDiagnosticStage;
  readonly diagnosticReason: SquareWebhookDiagnosticReason;
  readonly diagnosticEventType: SquareWebhookDiagnosticEventType;

  constructor(
    readonly code: "INVALID_JSON" | "INVALID_ENVELOPE" | "INVALID_EVENT_OBJECT",
    diagnostics: {
      stage?: SquareWebhookDiagnosticStage;
      reason?: SquareWebhookDiagnosticReason;
      eventType?: SquareWebhookDiagnosticEventType;
    } = {},
  ) {
    super(code);
    this.name = "SquareWebhookPayloadError";
    this.diagnosticStage = diagnostics.stage ?? "full_normalize";
    this.diagnosticReason = diagnostics.reason
      ?? (code === "INVALID_JSON" ? "invalid_json" : "invalid_envelope");
    this.diagnosticEventType = diagnostics.eventType ?? "other";
  }
}

export type SquarePaymentWebhookOrigin =
  | "not_payment"
  | "potentially_owned"
  | "ambiguous"
  | "definitely_unrelated";

function iso(value: string): string {
  return new Date(value).toISOString();
}

function assertEnvelopeLocation(
  envelopeLocation: string | undefined,
  objectLocation: string,
  stage: SquareWebhookDiagnosticStage,
  eventType: SquareWebhookDiagnosticEventType,
): void {
  if (envelopeLocation !== undefined && envelopeLocation !== objectLocation) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage,
      reason: "location_mismatch",
      eventType,
    });
  }
}

function findUnknownLocation(
  envelopeLocation: string | undefined,
  object: Record<string, unknown>,
): string | undefined {
  const objectLocations = Object.values(object)
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object")
    .map((value) => value.location_id)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const distinct = new Set(objectLocations);
  if (envelopeLocation) distinct.add(envelopeLocation);
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

function hasConflictingLocations(
  envelopeLocation: string | undefined,
  object: Record<string, unknown>,
): boolean {
  const objectLocations = Object.values(object)
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object")
    .map((value) => value.location_id)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const distinct = new Set(objectLocations);
  if (envelopeLocation) distinct.add(envelopeLocation);
  return distinct.size > 1;
}

function parseEnvelope(
  rawBody: string,
  stage: SquareWebhookDiagnosticStage,
): z.infer<typeof envelopeSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new SquareWebhookPayloadError("INVALID_JSON", {
      stage,
      reason: "invalid_json",
    });
  }
  const envelopeResult = envelopeSchema.safeParse(decoded);
  if (!envelopeResult.success) {
    throw new SquareWebhookPayloadError("INVALID_ENVELOPE", {
      stage,
      reason: "invalid_envelope",
    });
  }
  return envelopeResult.data;
}

type ObjectValidationKind = "payment" | "refund" | "dispute" | "payment_origin";

function targetObject(
  envelope: z.infer<typeof envelopeSchema>,
  key: "payment" | "refund" | "dispute",
  stage: SquareWebhookDiagnosticStage,
  eventType: SquareWebhookDiagnosticEventType,
): Record<string, unknown> {
  const value = envelope.data.object[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage,
      reason: "missing_target_object",
      eventType,
    });
  }
  return value as Record<string, unknown>;
}

function isValidTimestamp(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 64
    && Number.isFinite(new Date(value).getTime());
}

function hasInvalidMoney(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  const money = value as Record<string, unknown>;
  return typeof money.amount !== "number"
    || !Number.isInteger(money.amount)
    || money.amount <= 0
    || money.amount > 2_147_483_647
    || typeof money.currency !== "string"
    || !/^[A-Z]{3}$/.test(money.currency.trim());
}

function objectFailureReason(
  object: Record<string, unknown>,
  dataId: string,
  kind: ObjectValidationKind,
): SquareWebhookDiagnosticReason {
  if (typeof object.id === "string" && object.id !== dataId) return "object_id_mismatch";
  if (kind !== "payment_origin" && hasInvalidMoney(object.amount_money)) {
    return object.amount_money === undefined
      ? "required_field_or_timestamp_invalid"
      : "invalid_amount_currency";
  }
  if (kind === "payment_origin") {
    return "required_field_or_timestamp_invalid";
  }
  if (typeof object.updated_at === "string" && !isValidTimestamp(object.updated_at)) {
    return "required_field_or_timestamp_invalid";
  }
  if (kind === "dispute") {
    if (typeof object.created_at !== "string" || !isValidTimestamp(object.created_at)) {
      return "required_field_or_timestamp_invalid";
    }
    if (object.reported_at !== undefined && object.reported_at !== null
      && !isValidTimestamp(object.reported_at)) {
      return "required_field_or_timestamp_invalid";
    }
  }
  return "required_field_or_timestamp_invalid";
}

function invalidKnownObject(
  object: Record<string, unknown>,
  dataId: string,
  kind: ObjectValidationKind,
  stage: SquareWebhookDiagnosticStage,
  eventType: SquareWebhookDiagnosticEventType,
): SquareWebhookPayloadError {
  return new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
    stage,
    reason: objectFailureReason(object, dataId, kind),
    eventType,
  });
}

export function isPaymentOperationReference(value: string): boolean {
  return PAYMENT_OPERATION_UUID.test(value);
}

/**
 * Uses only bounded, signature-verified origin evidence. It deliberately does
 * not inspect status or money, so a foreign zero-dollar POS payment can be
 * acknowledged without invoking database-backed middleware.
 */
export function classifySquarePaymentWebhookOrigin(
  rawBody: string,
  leagueVaultApplicationId: string,
): SquarePaymentWebhookOrigin {
  const stage = "origin_gate" as const;
  const envelope = parseEnvelope(rawBody, stage);
  if (envelope.type !== "payment.updated") return "not_payment";
  const eventType = squareWebhookDiagnosticEventType(envelope.type);
  if (envelope.data.type !== "payment") {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage,
      reason: "wrong_data_type",
      eventType,
    });
  }
  const paymentObject = targetObject(envelope, "payment", stage, eventType);
  const result = paymentOriginSchema.safeParse(paymentObject);
  if (!result.success) {
    throw invalidKnownObject(paymentObject, envelope.data.id, "payment_origin", stage, eventType);
  }
  if (result.data.id !== envelope.data.id) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage,
      reason: "object_id_mismatch",
      eventType,
    });
  }
  assertEnvelopeLocation(envelope.location_id, result.data.location_id, stage, eventType);

  const applicationId = result.data.application_details?.application_id ?? null;
  const squareProduct = result.data.application_details?.square_product ?? null;
  const referenceId = result.data.reference_id ?? null;
  const hasOperationReference = referenceId !== null && isPaymentOperationReference(referenceId);

  if (applicationId === leagueVaultApplicationId || hasOperationReference) {
    return "potentially_owned";
  }
  if (applicationId !== null) return "definitely_unrelated";
  if (
    squareProduct !== null
    && DEFINITELY_UNRELATED_SQUARE_PRODUCTS.has(squareProduct)
  ) {
    return "definitely_unrelated";
  }
  return "ambiguous";
}

/** Parses a signature-verified Square body into non-sensitive inbox metadata. */
export function normalizeSquareWebhookEvent(rawBody: string): NormalizedSquareWebhookEvent {
  const stage = "full_normalize" as const;
  const envelope = parseEnvelope(rawBody, stage);
  const eventType = squareWebhookDiagnosticEventType(envelope.type);
  const common = {
    providerEventId: envelope.event_id,
    eventType: envelope.type,
    providerCreatedAt: iso(envelope.created_at),
    providerMerchantId: envelope.merchant_id,
  };

  if (envelope.type === "refund.updated") {
    if (envelope.data.type !== "refund") {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
        stage,
        reason: "wrong_data_type",
        eventType,
      });
    }
    const refundObject = targetObject(envelope, "refund", stage, eventType);
    const result = refundSchema.safeParse(refundObject);
    if (!result.success) {
      throw invalidKnownObject(refundObject, envelope.data.id, "refund", stage, eventType);
    }
    if (result.data.id !== envelope.data.id) {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
        stage,
        reason: "object_id_mismatch",
        eventType,
      });
    }
    assertEnvelopeLocation(envelope.location_id, result.data.location_id, stage, eventType);
    return {
      ...common,
      providerLocationId: result.data.location_id,
      providerObjectType: "refund",
      providerObjectId: result.data.id,
      providerPaymentId: result.data.payment_id,
      providerObjectVersion: result.data.version ?? null,
      providerObjectUpdatedAt: result.data.updated_at ? iso(result.data.updated_at) : null,
      ignored: false,
      providerStatus: result.data.status,
      amountMinor: Number(result.data.amount_money.amount),
      currency: result.data.amount_money.currency,
      providerOrderId: null,
      providerReferenceId: null,
      receiptUrl: null,
      receiptNumber: null,
      dispute: null,
    };
  }

  if (envelope.type === "payment.updated") {
    if (envelope.data.type !== "payment") {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
        stage,
        reason: "wrong_data_type",
        eventType,
      });
    }
    const paymentObject = targetObject(envelope, "payment", stage, eventType);
    const result = paymentSchema.safeParse(paymentObject);
    if (!result.success) {
      throw invalidKnownObject(paymentObject, envelope.data.id, "payment", stage, eventType);
    }
    if (result.data.id !== envelope.data.id) {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
        stage,
        reason: "object_id_mismatch",
        eventType,
      });
    }
    assertEnvelopeLocation(envelope.location_id, result.data.location_id, stage, eventType);
    return {
      ...common,
      providerLocationId: result.data.location_id,
      providerObjectType: "payment",
      providerObjectId: result.data.id,
      providerPaymentId: result.data.id,
      providerObjectVersion: null,
      providerObjectUpdatedAt: result.data.updated_at ? iso(result.data.updated_at) : null,
      ignored: false,
      providerStatus: result.data.status,
      amountMinor: Number(result.data.amount_money.amount),
      currency: result.data.amount_money.currency,
      providerOrderId: result.data.order_id ?? null,
      providerReferenceId: result.data.reference_id ?? null,
      receiptUrl: result.data.receipt_url ?? null,
      receiptNumber: result.data.receipt_number ?? null,
      dispute: null,
    };
  }

  if (envelope.type === "dispute.created" || envelope.type === "dispute.state.updated") {
    if (envelope.data.type !== "dispute") {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
        stage,
        reason: "wrong_data_type",
        eventType,
      });
    }
    const disputeObject = targetObject(envelope, "dispute", stage, eventType);
    const result = disputeSchema.safeParse(disputeObject);
    if (!result.success) {
      throw invalidKnownObject(disputeObject, envelope.data.id, "dispute", stage, eventType);
    }
    if (result.data.id !== envelope.data.id) {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
        stage,
        reason: "object_id_mismatch",
        eventType,
      });
    }
    assertEnvelopeLocation(envelope.location_id, result.data.location_id, stage, eventType);
    return {
      ...common,
      providerLocationId: result.data.location_id,
      providerObjectType: "dispute",
      providerObjectId: result.data.id,
      providerPaymentId: result.data.disputed_payment.payment_id,
      providerObjectVersion: result.data.version ?? null,
      providerObjectUpdatedAt: result.data.updated_at ? iso(result.data.updated_at) : null,
      ignored: false,
      providerStatus: result.data.state,
      amountMinor: Number(result.data.amount_money.amount),
      currency: result.data.amount_money.currency,
      providerOrderId: null,
      providerReferenceId: null,
      receiptUrl: null,
      receiptNumber: null,
      dispute: {
        reason: result.data.reason,
        dueAt: result.data.due_at ? iso(result.data.due_at) : null,
        cardBrand: result.data.card_brand ?? null,
        brandDisputeId: result.data.brand_dispute_id ?? null,
        createdAt: iso(result.data.created_at),
        reportedAt: result.data.reported_at ? iso(result.data.reported_at) : null,
      },
    };
  }

  if (supportedTypes.has(envelope.type)) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage,
      reason: "required_field_or_timestamp_invalid",
      eventType,
    });
  }
  const providerLocationId = findUnknownLocation(envelope.location_id, envelope.data.object);
  if (!providerLocationId) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage,
      reason: hasConflictingLocations(envelope.location_id, envelope.data.object)
        ? "location_mismatch"
        : "unsupported_event_without_unique_location",
      eventType: "other",
    });
  }
  return {
    ...common,
    providerLocationId,
    providerObjectType: envelope.data.type,
    providerObjectId: envelope.data.id,
    providerPaymentId: null,
    providerObjectVersion: null,
    providerObjectUpdatedAt: null,
    ignored: true,
    providerStatus: null,
    amountMinor: null,
    currency: null,
    providerOrderId: null,
    providerReferenceId: null,
    receiptUrl: null,
    receiptNumber: null,
    dispute: null,
  };
}
