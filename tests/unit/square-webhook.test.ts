import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { WebhookEvent } from "@shared/schema";
import type { SquareWebhookConfig } from "../../server/services/square-webhook-config";

process.env.DATABASE_URL ??= "postgres://fixture.invalid/fixture";
process.env.SESSION_SECRET ??= "square-webhook-unit-session-secret";
process.env.FIELD_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { fakeLogger, ingest, processEvent, rearm, downstreamTenantResolver } = vi.hoisted(() => ({
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  ingest: vi.fn(),
  processEvent: vi.fn(),
  rearm: vi.fn(),
  downstreamTenantResolver: vi.fn(),
}));

vi.mock("../../server/logger", () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));
vi.mock("../../server/storage/webhook-events", () => ({
  WebhookDuplicateMismatchError: class WebhookDuplicateMismatchError extends Error {},
  WebhookLocationMappingError: class WebhookLocationMappingError extends Error {},
  ingestSquareWebhookEvent: vi.fn(),
}));
vi.mock("../../server/storage/square-webhook-processing", () => ({
  processSquareWebhookEvent: vi.fn(),
}));

const {
  registerSquareWebhookReceiver,
  verifySquareWebhookSignature,
  SQUARE_WEBHOOK_BODY_LIMIT_BYTES,
  SQUARE_WEBHOOK_REQUEST_ID_HEADER,
  SQUARE_WEBHOOK_SIGNATURE_HEADER,
} = await import("../../server/routes/payments-provider/square-webhook");
const {
  SQUARE_WEBHOOK_PATH,
  SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
  resolveSquareWebhookConfig,
} = await import("../../server/services/square-webhook-config");
const {
  normalizeSquareWebhookEvent,
  SquareWebhookPayloadError,
} = await import(
  "../../server/services/square-webhook-event"
);
const { classifySquarePaymentWebhookOrigin } = await import(
  "../../server/services/square-webhook-event"
);

const originClassifier = vi.fn(classifySquarePaymentWebhookOrigin);
const databaseLimiter = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());

const notificationUrl = `https://hooks.example.test${SQUARE_WEBHOOK_PATH}`;
const applicationId = "sandbox-app-fixture";
const signatureKey = ["unit", "test", "only", "not", "a", "secret"].join("-");
const config: SquareWebhookConfig = {
  mode: "ingest_only",
  notificationUrl,
  providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
  subscriptions: [{ applicationId, signatureKey }],
};

function webhookEventFixture(status: "pending" | "ignored"): WebhookEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    provider: "square",
    providerEventId: "event-fixture-1",
    eventType: status === "ignored" ? "customer.updated" : "payment.updated",
    providerCreatedAt: "2026-08-03T12:00:00.000Z",
    receivedAt: "2026-08-03T12:00:01.000Z",
    organizationId: 1,
    locationId: 1,
    providerApplicationId: applicationId,
    providerMerchantId: "merchant-fixture-1",
    providerLocationId: "location-fixture-1",
    providerObjectType: status === "ignored" ? "customer" : "payment",
    providerObjectId: status === "ignored" ? "customer-fixture-1" : "payment-fixture-1",
    providerPaymentId: status === "ignored" ? null : "payment-fixture-1",
    providerObjectVersion: null,
    providerObjectUpdatedAt: null,
    providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
    payloadSchemaVersion: 1,
    payloadHash: "a".repeat(64),
    encryptedPayload: "encrypted-fixture",
    status,
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    errorClassification: status === "ignored" ? "processing" : null,
    errorCode: status === "ignored" ? "EVENT_TYPE_NOT_SUPPORTED" : null,
    processedAt: status === "ignored" ? "2026-08-03T12:00:01.000Z" : null,
    completedAt: status === "ignored" ? "2026-08-03T12:00:01.000Z" : null,
    updatedAt: "2026-08-03T12:00:01.000Z",
  };
}

function paymentEvent(
  eventId = "event-fixture-1",
  locationId = "location-fixture-1",
  origin: {
    amount?: number;
    applicationId?: string;
    referenceId?: string;
    sourceType?: string;
    squareProduct?: string;
  } = {},
) {
  return {
    merchant_id: "merchant-fixture-1",
    type: "payment.updated",
    event_id: eventId,
    created_at: "2026-08-03T12:00:00.000Z",
    data: {
      type: "payment",
      id: "payment-fixture-1",
      object: {
        payment: {
          id: "payment-fixture-1",
          updated_at: "2026-08-03T11:59:59.000Z",
          amount_money: { amount: 2500, currency: "USD" },
          status: "COMPLETED",
          location_id: locationId,
          ...(origin.amount === undefined
            ? {}
            : { amount_money: { amount: origin.amount, currency: "USD" } }),
          ...(origin.sourceType === undefined ? {} : { source_type: origin.sourceType }),
          ...(origin.referenceId === undefined ? {} : { reference_id: origin.referenceId }),
          ...(origin.applicationId === undefined && origin.squareProduct === undefined
            ? {}
            : { application_details: {
              ...(origin.applicationId === undefined ? {} : { application_id: origin.applicationId }),
              ...(origin.squareProduct === undefined ? {} : { square_product: origin.squareProduct }),
            } }),
        },
      },
    },
  };
}

function disputeEvent(
  eventId = "event-dispute-fixture-1",
  eventType: "dispute.created" | "dispute.state.updated" = "dispute.state.updated",
) {
  return {
    merchant_id: "merchant-fixture-1",
    type: eventType,
    event_id: eventId,
    created_at: "2026-08-03T12:00:00.000Z",
    data: {
      type: "dispute",
      id: "dispute-fixture-1",
      object: {
        dispute: {
          id: "dispute-fixture-1",
          location_id: "location-fixture-1",
          amount_money: { amount: 1250, currency: "USD" },
          disputed_payment: { payment_id: "payment-fixture-1" },
          reason: "DUPLICATE",
          state: "EVIDENCE_REQUIRED",
          due_at: "2026-08-10T12:00:00.000Z",
          card_brand: "VISA",
          brand_dispute_id: "brand-dispute-fixture-1",
          created_at: "2026-08-01T12:00:00.000Z",
          reported_at: "2026-08-02T12:00:00.000Z",
          updated_at: "2026-08-03T11:59:59.000Z",
          version: 3,
        },
      },
    },
  };
}

function refundEvent(eventId = "event-refund-fixture-1") {
  return {
    merchant_id: "merchant-fixture-1",
    type: "refund.updated",
    event_id: eventId,
    created_at: "2026-08-03T12:00:00.000Z",
    data: {
      type: "refund",
      id: "refund-fixture-1",
      object: { refund: {
        id: "refund-fixture-1",
        payment_id: "payment-fixture-1",
        location_id: "location-fixture-1",
        amount_money: { amount: 2500, currency: "USD" },
        status: "PENDING",
        updated_at: "2026-08-03T11:59:00.000Z",
        version: 4,
      } },
    },
  };
}

function sign(body: string, key = signatureKey, url = notificationUrl): string {
  return createHmac("sha256", key).update(url, "utf8").update(body, "utf8").digest("base64");
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", 1);
  registerSquareWebhookReceiver(app, {
    config,
    classifyOrigin: originClassifier,
    limiter: databaseLimiter,
    ingest,
  });
  app.use((_req, res) => {
    downstreamTenantResolver();
    res.status(204).end();
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  for (const fn of Object.values(fakeLogger)) fn.mockReset();
  ingest.mockReset();
  ingest.mockResolvedValue({
    event: webhookEventFixture("pending"),
    duplicate: false,
  });
  processEvent.mockReset();
  processEvent.mockResolvedValue({
    acknowledged: true,
    terminal: true,
    businessStateChanged: true,
    status: "processed",
    code: null,
    scheduledPaymentWakeRequired: true,
  });
  rearm.mockReset();
  rearm.mockResolvedValue(undefined);
  downstreamTenantResolver.mockReset();
  originClassifier.mockClear();
  databaseLimiter.mockClear();
});

async function post(body: string, options: {
  signature?: string | null;
  contentType?: string;
  ip?: string;
} = {}) {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
    "x-forwarded-for": options.ip ?? `203.0.113.${Math.floor(Math.random() * 180) + 20}`,
  };
  const signature = options.signature === undefined ? sign(body) : options.signature;
  if (signature !== null) headers[SQUARE_WEBHOOK_SIGNATURE_HEADER] = signature;
  return fetch(`${baseUrl}${SQUARE_WEBHOOK_PATH}`, { method: "POST", headers, body });
}

describe("Square webhook signature and raw-body boundary", () => {
  it("verifies the exact raw bytes and durably ingests before acknowledging", async () => {
    const body = ` ${JSON.stringify(paymentEvent())}\n`;
    const response = await post(body);

    expect(response.status).toBe(200);
    expect(response.headers.get(SQUARE_WEBHOOK_REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({
      providerApplicationId: applicationId,
      providerEventId: "event-fixture-1",
      providerLocationId: "location-fixture-1",
      providerObjectId: "payment-fixture-1",
      providerPaymentId: "payment-fixture-1",
      rawPayload: body,
      ignored: false,
    });
    expect(await response.json()).toEqual({
      success: true,
      data: { received: true, duplicate: false, status: "pending" },
    });
    expect(downstreamTenantResolver).not.toHaveBeenCalled();
  });

  it("rejects a one-byte body mutation before parsing or database work", async () => {
    const original = JSON.stringify(paymentEvent());
    const mutated = original.replace("2500", "2501");
    const response = await post(mutated, { signature: sign(original) });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("SQUARE_WEBHOOK_SIGNATURE_INVALID");
    expect(originClassifier).not.toHaveBeenCalled();
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
  });

  it("fails closed for a missing signature", async () => {
    const response = await post(JSON.stringify(paymentEvent()), { signature: null });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("SQUARE_WEBHOOK_SIGNATURE_MISSING");
    expect(originClassifier).not.toHaveBeenCalled();
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects the wrong notification URL or signature key", () => {
    const body = Buffer.from(JSON.stringify(paymentEvent()));
    expect(verifySquareWebhookSignature(body, sign(body.toString(), signatureKey, `${notificationUrl}/`), config)).toBeNull();
    expect(verifySquareWebhookSignature(body, sign(body.toString(), "different-fixture-key"), config)).toBeNull();
    expect(verifySquareWebhookSignature(body, sign(body.toString()), config)).toBe(applicationId);
  });

  it("does not acknowledge when durable ingestion fails", async () => {
    ingest.mockRejectedValueOnce(new Error("fixture database unavailable"));
    const response = await post(JSON.stringify(paymentEvent()));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SQUARE_WEBHOOK_INGESTION_FAILED");
  });

  it("returns idempotent success for a durable duplicate", async () => {
    ingest.mockResolvedValueOnce({
      event: webhookEventFixture("pending"),
      duplicate: true,
    });
    const response = await post(JSON.stringify(paymentEvent()));
    expect(response.status).toBe(200);
    expect((await response.json()).data.duplicate).toBe(true);
  });
});

describe("Square webhook in-memory origin prefilter", () => {
  const operationId = "00000000-0000-4000-8000-000000000123";

  it("acknowledges a signed Square POS payment without database-backed middleware", async () => {
    const body = JSON.stringify(paymentEvent(
      "event-pos-fixture",
      "location-fixture-1",
      { squareProduct: "SQUARE_POS" },
    ));
    const response = await post(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { received: true, duplicate: false, status: "ignored" },
    });
    expect(originClassifier).toHaveBeenCalledTimes(1);
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
    expect(downstreamTenantResolver).not.toHaveBeenCalled();
    const observations = JSON.stringify({
      info: fakeLogger.info.mock.calls,
      warn: fakeLogger.warn.mock.calls,
      error: fakeLogger.error.mock.calls,
    });
    expect(observations).not.toContain("event-pos-fixture");
    expect(observations).not.toContain("payment-fixture-1");
    expect(observations).not.toContain(body);
  });

  it("acknowledges a signed zero-dollar cash POS payment without full money normalization", async () => {
    const body = JSON.stringify(paymentEvent(
      "event-pos-zero-cash-fixture",
      "location-fixture-1",
      { amount: 0, sourceType: "CASH", squareProduct: "SQUARE_POS" },
    ));
    const response = await post(body);

    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("ignored");
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("uses the durable path when application and operation markers both match", async () => {
    const response = await post(JSON.stringify(paymentEvent(
      "event-owned-both-fixture",
      "location-fixture-1",
      { applicationId, referenceId: operationId, squareProduct: "ECOMMERCE_API" },
    )));

    expect(response.status).toBe(200);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("keeps matching-application payments compatible when reference_id is missing", async () => {
    const response = await post(JSON.stringify(paymentEvent(
      "event-owned-app-only-fixture",
      "location-fixture-1",
      { applicationId, squareProduct: "ECOMMERCE_API" },
    )));

    expect(response.status).toBe(200);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("uses the durable path for an operation UUID when application_id is missing", async () => {
    const response = await post(JSON.stringify(paymentEvent(
      "event-owned-reference-only-fixture",
      "location-fixture-1",
      { referenceId: operationId },
    )));

    expect(response.status).toBe(200);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("acknowledges an explicitly foreign application when no operation UUID is present", async () => {
    const response = await post(JSON.stringify(paymentEvent(
      "event-foreign-app-fixture",
      "location-fixture-1",
      { applicationId: "foreign-square-application-fixture", squareProduct: "ECOMMERCE_API" },
    )));

    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("ignored");
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("fails safe through durability when foreign-looking evidence conflicts with an operation UUID", async () => {
    const response = await post(JSON.stringify(paymentEvent(
      "event-conflicting-origin-fixture",
      "location-fixture-1",
      {
        applicationId: "foreign-square-application-fixture",
        referenceId: operationId,
        squareProduct: "SQUARE_POS",
      },
    )));

    expect(response.status).toBe(200);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("keeps marker-poor and unknown-origin historical payments ambiguous", async () => {
    const bodies = [
      paymentEvent("event-ambiguous-empty-fixture"),
      paymentEvent("event-ambiguous-ecommerce-fixture", "location-fixture-1", {
        squareProduct: "ECOMMERCE_API",
      }),
      paymentEvent("event-ambiguous-future-fixture", "location-fixture-1", {
        squareProduct: "FUTURE_SQUARE_PRODUCT",
      }),
    ];

    for (const event of bodies) {
      const response = await post(JSON.stringify(event));
      expect(response.status).toBe(200);
    }
    expect(databaseLimiter).toHaveBeenCalledTimes(3);
    expect(ingest).toHaveBeenCalledTimes(3);
  });

  it("does not apply the payment-origin filter to refunds or disputes", async () => {
    const bodies = [
      refundEvent(),
      disputeEvent("event-dispute-created-fixture", "dispute.created"),
      disputeEvent("event-dispute-updated-fixture", "dispute.state.updated"),
    ];

    for (const event of bodies) {
      const response = await post(JSON.stringify(event));
      expect(response.status).toBe(200);
    }
    expect(databaseLimiter).toHaveBeenCalledTimes(3);
    expect(ingest).toHaveBeenCalledTimes(3);
  });

  it("keeps a potentially owned malformed payment fail-closed", async () => {
    const response = await post(JSON.stringify(paymentEvent(
      "event-owned-zero-fixture",
      "location-fixture-1",
      { amount: 0, applicationId, referenceId: operationId },
    )));

    expect(response.status).toBe(400);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe("Square webhook parsing and log safety", () => {
  it("normalizes refund/payment/dispute freshness metadata without business mutations", () => {
    const refund = normalizeSquareWebhookEvent(JSON.stringify({
      merchant_id: "merchant-fixture-1",
      type: "refund.updated",
      event_id: "event-refund-fixture",
      created_at: "2026-08-03T12:00:00Z",
      data: {
        type: "refund",
        id: "refund-fixture-1",
        object: { refund: {
          id: "refund-fixture-1",
          payment_id: "payment-fixture-1",
          location_id: "location-fixture-1",
          amount_money: { amount: 2500, currency: "USD" },
          status: "PENDING",
          updated_at: "2026-08-03T11:59:00Z",
          version: 4,
        } },
      },
    }));
    expect(refund).toMatchObject({
      eventType: "refund.updated",
      providerObjectId: "refund-fixture-1",
      providerPaymentId: "payment-fixture-1",
      providerObjectVersion: 4,
      ignored: false,
    });
    const dispute = normalizeSquareWebhookEvent(JSON.stringify(disputeEvent()));
    expect(dispute).toMatchObject({
      eventType: "dispute.state.updated",
      providerObjectId: "dispute-fixture-1",
      providerPaymentId: "payment-fixture-1",
      providerObjectVersion: 3,
      providerStatus: "EVIDENCE_REQUIRED",
      amountMinor: 1250,
      dispute: {
        reason: "DUPLICATE",
        dueAt: "2026-08-10T12:00:00.000Z",
        cardBrand: "VISA",
        brandDisputeId: "brand-dispute-fixture-1",
        createdAt: "2026-08-01T12:00:00.000Z",
        reportedAt: "2026-08-02T12:00:00.000Z",
      },
    });
  });

  it("keeps unsupported event names out of operational logs", async () => {
    const body = JSON.stringify({
      merchant_id: "merchant-fixture-1",
      location_id: "location-fixture-1",
      type: "customer.updated",
      event_id: "event-unknown-log-fixture",
      created_at: "2026-08-03T12:00:00Z",
      data: { type: "customer", id: "customer-fixture-1", object: {} },
    });
    ingest.mockResolvedValueOnce({
      event: webhookEventFixture("ignored"),
      duplicate: false,
    });

    const response = await post(body);

    expect(response.status).toBe(200);
    expect(fakeLogger.info).toHaveBeenCalledWith(
      "Square webhook durably recorded",
      expect.objectContaining({ eventType: "other" }),
    );
  });

  it("marks an unexpected supported-version event ignored when it maps to one location", async () => {
    const body = JSON.stringify({
      merchant_id: "merchant-fixture-1",
      location_id: "location-fixture-1",
      type: "customer.updated",
      event_id: "event-unknown-fixture",
      created_at: "2026-08-03T12:00:00Z",
      data: { type: "customer", id: "customer-fixture-1", object: {} },
    });
    ingest.mockResolvedValueOnce({
      event: webhookEventFixture("ignored"),
      duplicate: false,
    });
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({
      eventType: "customer.updated",
      ignored: true,
    });
    expect((await response.json()).data.status).toBe("ignored");
  });

  it("rejects malformed signed JSON without logging body content", async () => {
    const sentinel = "SENTINEL_WEBHOOK_BODY_SECRET";
    const body = `{"token":"${sentinel}"`;
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    expect(databaseLimiter).not.toHaveBeenCalled();
    const observations = JSON.stringify({
      info: fakeLogger.info.mock.calls,
      warn: fakeLogger.warn.mock.calls,
      error: fakeLogger.error.mock.calls,
      response: await response.text(),
    });
    expect(observations).not.toContain(sentinel);
    expect(observations).not.toContain(signatureKey);
  });

  it("enforces the bounded raw body before signature parsing and does not log bytes", async () => {
    const sentinel = "SENTINEL_OVERSIZED_WEBHOOK_BODY";
    const body = sentinel + "x".repeat(SQUARE_WEBHOOK_BODY_LIMIT_BYTES);
    const response = await post(body, { contentType: "text/plain" });
    expect(response.status).toBe(413);
    const observations = JSON.stringify(fakeLogger.warn.mock.calls);
    expect(observations).not.toContain(sentinel);
    expect(observations).not.toContain(sign(body));
    expect(ingest).not.toHaveBeenCalled();
  });

  it("requires JSON content type only after a valid signature", async () => {
    const body = JSON.stringify(paymentEvent());
    const response = await post(body, { contentType: "text/plain" });
    expect(response.status).toBe(415);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("is registered before tenant resolution and the global JSON parser", () => {
    const source = readFileSync(new URL("../../server/app.ts", import.meta.url), "utf8");
    const receiverIndex = source.indexOf("registerSquareWebhookReceiver(app);");
    expect(receiverIndex).toBeGreaterThan(-1);
    expect(receiverIndex).toBeLessThan(source.indexOf("app.use(subdomainDetection);"));
    expect(receiverIndex).toBeLessThan(source.indexOf("limit: '256kb'"));
  });
});

describe("Square webhook rejection diagnostics", () => {
  function rejectedLog() {
    const call = [...fakeLogger.warn.mock.calls].reverse().find(([message, fields]) => (
      message === "Square webhook request rejected"
      && fields?.event === "square_webhook_rejected"
    ));
    expect(call).toBeDefined();
    return call?.[1] as Record<string, unknown>;
  }

  it("classifies origin-gate wrong data type without reaching the limiter", async () => {
    const event = paymentEvent();
    event.data.type = "order";
    const response = await post(JSON.stringify(event));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("SQUARE_WEBHOOK_EVENT_INVALID");
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      outcome: "invalid_event_object",
      stage: "origin_gate",
      reason: "wrong_data_type",
      eventType: "payment.updated",
    });
  });

  it("classifies a missing target object and preserves the 400 response", async () => {
    const event = paymentEvent();
    Object.assign(event.data, { object: {} });
    const response = await post(JSON.stringify(event));

    expect(response.status).toBe(400);
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "origin_gate",
      reason: "missing_target_object",
      eventType: "payment.updated",
    });
  });

  it("classifies an object ID mismatch before database work", async () => {
    const event = paymentEvent();
    event.data.object.payment.id = "different-payment-fixture";
    const response = await post(JSON.stringify(event));

    expect(response.status).toBe(400);
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "origin_gate",
      reason: "object_id_mismatch",
      eventType: "payment.updated",
    });
  });

  it("classifies an envelope/object location mismatch before database work", async () => {
    const event = paymentEvent();
    (event as typeof event & { location_id: string }).location_id = "other-location-fixture";
    const response = await post(JSON.stringify(event));

    expect(response.status).toBe(400);
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "origin_gate",
      reason: "location_mismatch",
      eventType: "payment.updated",
    });
  });

  it("classifies an owned zero-value payment during full normalization", async () => {
    const event = paymentEvent("event-owned-zero-diagnostic", "location-fixture-1", {
      amount: 0,
      applicationId,
    });
    const response = await post(JSON.stringify(event));

    expect(response.status).toBe(400);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "full_normalize",
      reason: "invalid_amount_currency",
      eventType: "payment.updated",
    });
  });

  it("classifies a required timestamp failure during full normalization", async () => {
    const event = paymentEvent("event-invalid-timestamp-diagnostic", "location-fixture-1", {
      applicationId,
    });
    event.data.object.payment.updated_at = "not-a-timestamp";
    const response = await post(JSON.stringify(event));

    expect(response.status).toBe(400);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "full_normalize",
      reason: "required_field_or_timestamp_invalid",
      eventType: "payment.updated",
    });
  });

  it("classifies unsupported events without a unique location", async () => {
    const response = await post(JSON.stringify({
      merchant_id: "merchant-fixture-1",
      type: "customer.updated",
      event_id: "event-unsupported-no-location",
      created_at: "2026-08-03T12:00:00Z",
      data: {
        type: "customer",
        id: "customer-fixture-1",
        object: { customer: { id: "customer-fixture-1" } },
      },
    }));

    expect(response.status).toBe(400);
    expect(databaseLimiter).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "full_normalize",
      reason: "unsupported_event_without_unique_location",
      eventType: "other",
    });
  });

  it("classifies invalid JSON and envelope failures without payload details", async () => {
    const malformedResponse = await post('{"type":"payment.updated"');
    expect(malformedResponse.status).toBe(400);
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "origin_gate",
      reason: "invalid_json",
      eventType: "other",
    });

    const envelopeResponse = await post(JSON.stringify({ type: "payment.updated" }));
    expect(envelopeResponse.status).toBe(400);
    expect(databaseLimiter).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(rejectedLog()).toMatchObject({
      stage: "origin_gate",
      reason: "invalid_envelope",
      eventType: "other",
    });

    const observations = JSON.stringify(fakeLogger.warn.mock.calls);
    expect(observations).not.toContain("payment-fixture-1");
    expect(observations).not.toContain("merchant-fixture-1");
  });

  it("exposes the fixed diagnostic metadata without changing the payload error contract", () => {
    const error = new SquareWebhookPayloadError("INVALID_EVENT_OBJECT", {
      stage: "origin_gate",
      reason: "wrong_data_type",
      eventType: "payment.updated",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("INVALID_EVENT_OBJECT");
    expect(error.message).toBe("INVALID_EVENT_OBJECT");
    expect(error.diagnosticStage).toBe("origin_gate");
    expect(error.diagnosticReason).toBe("wrong_data_type");
    expect(error.diagnosticEventType).toBe("payment.updated");
  });
});

describe("Square webhook reconciliation activation", () => {
  it("keeps ingest_only behavior dormant", async () => {
    const response = await post(JSON.stringify(paymentEvent()));
    expect(response.status).toBe(200);
    expect(processEvent).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
  });

  it("processes only after durable ingestion and rearms a committed mutation", async () => {
    const reconcileConfig: SquareWebhookConfig = { ...config, mode: "reconcile_payments" };
    const reconcileApp = express();
    registerSquareWebhookReceiver(reconcileApp, {
      config: reconcileConfig,
      limiter: databaseLimiter,
      ingest,
      process: processEvent,
      rearm,
    });
    const listener = await new Promise<Server>((resolve) => {
      const value = reconcileApp.listen(0, "127.0.0.1", () => resolve(value));
    });
    try {
      const body = JSON.stringify(paymentEvent());
      const response = await fetch(
        `http://127.0.0.1:${(listener.address() as AddressInfo).port}${SQUARE_WEBHOOK_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SQUARE_WEBHOOK_SIGNATURE_HEADER]: sign(body),
            "x-forwarded-for": "203.0.113.240",
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(ingest.mock.invocationCallOrder[0]).toBeLessThan(processEvent.mock.invocationCallOrder[0]);
      expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({
        eventId: webhookEventFixture("pending").id,
        organizationId: 1,
        processDisputes: false,
      }));
      expect(rearm).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("activates dispute reconciliation separately without waking payment recovery", async () => {
    processEvent.mockResolvedValueOnce({
      acknowledged: true,
      terminal: true,
      businessStateChanged: true,
      status: "processed",
      code: null,
      scheduledPaymentWakeRequired: false,
    });
    const reconcileApp = express();
    registerSquareWebhookReceiver(reconcileApp, {
      config: { ...config, mode: "reconcile_payments_and_disputes" },
      limiter: databaseLimiter,
      ingest,
      process: processEvent,
      rearm,
    });
    const listener = await new Promise<Server>((resolve) => {
      const value = reconcileApp.listen(0, "127.0.0.1", () => resolve(value));
    });
    try {
      const body = JSON.stringify(disputeEvent());
      const response = await fetch(
        `http://127.0.0.1:${(listener.address() as AddressInfo).port}${SQUARE_WEBHOOK_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SQUARE_WEBHOOK_SIGNATURE_HEADER]: sign(body),
            "x-forwarded-for": "203.0.113.243",
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({
        processDisputes: true,
        event: expect.objectContaining({
          eventType: "dispute.state.updated",
          providerPaymentId: "payment-fixture-1",
        }),
      }));
      expect(rearm).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns non-2xx for a durable nonterminal processing outcome", async () => {
    processEvent.mockResolvedValueOnce({
      acknowledged: false,
      terminal: false,
      businessStateChanged: false,
      status: "processing",
      code: "EVENT_NOT_DUE",
    });
    const reconcileApp = express();
    registerSquareWebhookReceiver(reconcileApp, {
      config: { ...config, mode: "reconcile_payments" },
      limiter: databaseLimiter,
      ingest,
      process: processEvent,
      rearm,
    });
    const listener = await new Promise<Server>((resolve) => {
      const value = reconcileApp.listen(0, "127.0.0.1", () => resolve(value));
    });
    try {
      const body = JSON.stringify(paymentEvent());
      const response = await fetch(
        `http://127.0.0.1:${(listener.address() as AddressInfo).port}${SQUARE_WEBHOOK_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SQUARE_WEBHOOK_SIGNATURE_HEADER]: sign(body),
            "x-forwarded-for": "203.0.113.241",
          },
          body,
        },
      );
      expect(response.status).toBe(503);
      expect(rearm).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("acknowledges a valid signed Square payment that is not owned by LeagueVault", async () => {
    processEvent.mockResolvedValueOnce({
      acknowledged: true,
      terminal: true,
      businessStateChanged: false,
      status: "ignored",
      code: "OPERATION_NOT_OWNED",
    });
    const reconcileApp = express();
    registerSquareWebhookReceiver(reconcileApp, {
      config: { ...config, mode: "reconcile_payments" },
      limiter: databaseLimiter,
      ingest,
      process: processEvent,
      rearm,
    });
    const listener = await new Promise<Server>((resolve) => {
      const value = reconcileApp.listen(0, "127.0.0.1", () => resolve(value));
    });
    try {
      const body = JSON.stringify(paymentEvent("event-unowned-payment"));
      const response = await fetch(
        `http://127.0.0.1:${(listener.address() as AddressInfo).port}${SQUARE_WEBHOOK_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SQUARE_WEBHOOK_SIGNATURE_HEADER]: sign(body),
            "x-forwarded-for": "203.0.113.242",
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: expect.objectContaining({
          eventType: "payment.updated",
          providerReferenceId: null,
        }),
      }));
      expect(rearm).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("Square webhook configuration", () => {
  it("defaults dormant and rejects unsafe ingest-only configuration", () => {
    expect(resolveSquareWebhookConfig({ appDomain: "leaguevault.app", appEnv: "prod" })).toEqual({
      mode: "disabled",
      notificationUrl: null,
      providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
      subscriptions: [],
    });
    expect(() => resolveSquareWebhookConfig({
      mode: "ingest_only",
      notificationUrl: `https://render-fixture.example${SQUARE_WEBHOOK_PATH}`,
      providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
      signatureKeysJson: JSON.stringify([{ applicationId, signatureKey }]),
      appDomain: "leaguevault.app",
      appEnv: "prod",
    })).toThrow("must use APP_DOMAIN");
  });

  it("accepts explicit reconciliation mode with the same signature boundary", () => {
    expect(resolveSquareWebhookConfig({
      mode: "reconcile_payments",
      notificationUrl,
      providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
      signatureKeysJson: JSON.stringify([{ applicationId, signatureKey }]),
      appDomain: "hooks.example.test",
      appEnv: "dev",
    }).mode).toBe("reconcile_payments");
    expect(resolveSquareWebhookConfig({
      mode: "reconcile_payments_and_disputes",
      notificationUrl,
      providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
      signatureKeysJson: JSON.stringify([{ applicationId, signatureKey }]),
      appDomain: "hooks.example.test",
      appEnv: "dev",
    }).mode).toBe("reconcile_payments_and_disputes");
  });
});
