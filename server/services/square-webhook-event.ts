import { z } from "zod";

export const SQUARE_WEBHOOK_EVENT_TYPES = [
  "refund.updated",
  "payment.updated",
  "dispute.created",
  "dispute.state.updated",
] as const;

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

export class SquareWebhookPayloadError extends Error {
  constructor(readonly code: "INVALID_JSON" | "INVALID_ENVELOPE" | "INVALID_EVENT_OBJECT") {
    super(code);
    this.name = "SquareWebhookPayloadError";
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

function assertEnvelopeLocation(envelopeLocation: string | undefined, objectLocation: string): void {
  if (envelopeLocation !== undefined && envelopeLocation !== objectLocation) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
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

function parseEnvelope(rawBody: string): z.infer<typeof envelopeSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new SquareWebhookPayloadError("INVALID_JSON");
  }
  const envelopeResult = envelopeSchema.safeParse(decoded);
  if (!envelopeResult.success) throw new SquareWebhookPayloadError("INVALID_ENVELOPE");
  return envelopeResult.data;
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
  const envelope = parseEnvelope(rawBody);
  if (envelope.type !== "payment.updated") return "not_payment";
  if (envelope.data.type !== "payment") {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
  }
  const result = paymentOriginSchema.safeParse(envelope.data.object.payment);
  if (!result.success || result.data.id !== envelope.data.id) {
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
  }
  assertEnvelopeLocation(envelope.location_id, result.data.location_id);

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
  const envelope = parseEnvelope(rawBody);
  const common = {
    providerEventId: envelope.event_id,
    eventType: envelope.type,
    providerCreatedAt: iso(envelope.created_at),
    providerMerchantId: envelope.merchant_id,
  };

  if (envelope.type === "refund.updated") {
    if (envelope.data.type !== "refund") throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
    const result = refundSchema.safeParse(envelope.data.object.refund);
    if (!result.success || result.data.id !== envelope.data.id) {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
    }
    assertEnvelopeLocation(envelope.location_id, result.data.location_id);
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
    if (envelope.data.type !== "payment") throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
    const result = paymentSchema.safeParse(envelope.data.object.payment);
    if (!result.success || result.data.id !== envelope.data.id) {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
    }
    assertEnvelopeLocation(envelope.location_id, result.data.location_id);
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
    if (envelope.data.type !== "dispute") throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
    const result = disputeSchema.safeParse(envelope.data.object.dispute);
    if (!result.success || result.data.id !== envelope.data.id) {
      throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
    }
    assertEnvelopeLocation(envelope.location_id, result.data.location_id);
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
    throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
  }
  const providerLocationId = findUnknownLocation(envelope.location_id, envelope.data.object);
  if (!providerLocationId) throw new SquareWebhookPayloadError("INVALID_EVENT_OBJECT");
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
