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
  amount: z.union([z.number().int(), z.bigint()]),
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
});

const disputeSchema = z.object({
  id: safeProviderString,
  location_id: safeProviderString,
  amount_money: moneySchema,
  disputed_payment: z.object({ payment_id: safeProviderString }),
  state: z.string().trim().min(1).max(50),
  updated_at: timestampSchema.optional(),
  version: z.number().int().positive().optional(),
});

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
}

export class SquareWebhookPayloadError extends Error {
  constructor(readonly code: "INVALID_JSON" | "INVALID_ENVELOPE" | "INVALID_EVENT_OBJECT") {
    super(code);
    this.name = "SquareWebhookPayloadError";
  }
}

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

/** Parses a signature-verified Square body into non-sensitive inbox metadata. */
export function normalizeSquareWebhookEvent(rawBody: string): NormalizedSquareWebhookEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new SquareWebhookPayloadError("INVALID_JSON");
  }
  const envelopeResult = envelopeSchema.safeParse(decoded);
  if (!envelopeResult.success) throw new SquareWebhookPayloadError("INVALID_ENVELOPE");
  const envelope = envelopeResult.data;
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
  };
}
