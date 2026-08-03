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

const { fakeLogger, ingest, downstreamTenantResolver } = vi.hoisted(() => ({
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  ingest: vi.fn(),
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
const { normalizeSquareWebhookEvent } = await import(
  "../../server/services/square-webhook-event"
);

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

function paymentEvent(eventId = "event-fixture-1", locationId = "location-fixture-1") {
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
        },
      },
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
  registerSquareWebhookReceiver(app, { config, ingest });
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
  downstreamTenantResolver.mockReset();
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
    expect(ingest).not.toHaveBeenCalled();
  });

  it("fails closed for a missing signature", async () => {
    const response = await post(JSON.stringify(paymentEvent()), { signature: null });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("SQUARE_WEBHOOK_SIGNATURE_MISSING");
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
});
