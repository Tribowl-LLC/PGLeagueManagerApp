/**
 * Pure SendGrid signed Event Webhook contract coverage. The route receives
 * persistence callbacks so these tests never open a database transaction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expectErrorLog, getCapturedErrorLogs } from "../helpers/expected-error-logs";

process.env.DATABASE_URL ??= "postgres://sendgrid-webhook-fixture.invalid/fixture";
process.env.SESSION_SECRET ??= "sendgrid-webhook-fixture-session-secret";
process.env.FIELD_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const {
  registerSendgridWebhookReceiver,
  parseSendgridEvent,
  verifySendgridWebhookSignature,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  SENDGRID_WEBHOOK_PATH,
} = await import("../../server/routes/email/sendgrid-webhook");

const knownCorrelation = vi.fn();
const ingest = vi.fn();
const fixedNow = new Date("2026-09-10T12:00:00.000Z");
let server: Server;
let baseUrl: string;

function signBody(timestamp: string, body: string): string {
  const signer = createSign("sha256");
  signer.update(timestamp, "utf8");
  signer.update(body, "utf8");
  return signer.sign(privateKey).toString("base64");
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "delivered",
    timestamp: Math.floor(fixedNow.getTime() / 1000),
    sg_event_id: "sg-event-fixture-1",
    sg_message_id: "sg-message-fixture-1",
    email: "recipient@example.test",
    // SendGrid flattens v3 custom_args into each Event Webhook item.
    account_action_id: "41",
    account_delivery_job_id: "7",
    ...overrides,
  };
}

async function postSigned(body: string, timestamp = String(Math.floor(fixedNow.getTime() / 1000))) {
  return fetch(`${baseUrl}${SENDGRID_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SENDGRID_SIGNATURE_HEADER]: signBody(timestamp, body),
      [SENDGRID_TIMESTAMP_HEADER]: timestamp,
    },
    body,
  });
}

beforeAll(async () => {
  const app = express();
  registerSendgridWebhookReceiver(app, {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    now: () => fixedNow,
    isKnownCorrelation: (...args) => knownCorrelation(...args),
    ingest: (...args) => ingest(...args),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  knownCorrelation.mockReset();
  knownCorrelation.mockResolvedValue(true);
  ingest.mockReset();
  ingest.mockResolvedValue({ duplicate: false, ignored: false });
});

describe("signed SendGrid Event Webhook", () => {
  it("verifies the raw body and passes only safe correlation metadata to ingestion", async () => {
    const body = JSON.stringify([event()]);
    const response = await postSigned(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { acceptedCount: 1, ignoredCount: 0 },
    });
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: "sg-event-fixture-1",
      providerMessageId: "sg-message-fixture-1",
      accountActionId: 41,
      accountDeliveryJobId: 7,
      eventType: "delivered",
      providerEventAt: fixedNow.toISOString(),
    }));
    expect(ingest.mock.calls[0]?.[0]).not.toHaveProperty("email");
    expect(ingest.mock.calls[0]?.[0]).not.toHaveProperty("rawBody");
  });

  it("rejects an invalid signature and a stale timestamp before persistence", async () => {
    const body = JSON.stringify([event()]);
    const invalid = await fetch(`${baseUrl}${SENDGRID_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SENDGRID_SIGNATURE_HEADER]: "invalid",
        [SENDGRID_TIMESTAMP_HEADER]: String(Math.floor(fixedNow.getTime() / 1000)),
      },
      body,
    });
    expect(invalid.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();

    const staleTimestamp = String(Math.floor(fixedNow.getTime() / 1000) - 301);
    const stale = await postSigned(body, staleTimestamp);
    expect(stale.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects malformed signed JSON and ignores unknown correlations with 2xx", async () => {
    const malformed = await postSigned("[{not-json}");
    expect(malformed.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();

    knownCorrelation.mockResolvedValue(false);
    const unknown = await postSigned(JSON.stringify([event({ sg_event_id: "unknown-correlation" })]));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({
      success: true,
      data: { acceptedCount: 0, ignoredCount: 1 },
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns a retryable response when persistence fails without echoing the error", async () => {
    const providerSecret = "provider-body-secret";
    expectErrorLog(/SendGrid delivery event persistence failed/);
    ingest.mockRejectedValue({ code: providerSecret });
    const response = await postSigned(JSON.stringify([event({ sg_event_id: "persistence-error" })]));

    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ success: false, error: { code: "SENDGRID_WEBHOOK_RETRYABLE" } });
    expect(JSON.stringify(payload)).not.toContain(providerSecret);
    expect(getCapturedErrorLogs().join("\n")).not.toContain(providerSecret);
  });
});

describe("SendGrid event parsing and signature primitive", () => {
  it("accepts the supported event set and rejects unsupported events", () => {
    for (const eventType of ["processed", "delivered", "deferred", "bounce", "dropped"] as const) {
      expect(parseSendgridEvent(event({ event: eventType }))).not.toBeNull();
    }
    expect(parseSendgridEvent(event({ event: "open" }))).toBeNull();
    expect(parseSendgridEvent(event({
      custom_args: { account_action_id: "999", account_delivery_job_id: "999" },
    }))?.correlation).toEqual({ accountActionId: 41, accountDeliveryJobId: 7 });
  });

  it("requires the timestamp plus exact raw bytes for ECDSA verification", () => {
    const timestamp = String(Math.floor(fixedNow.getTime() / 1000));
    const body = JSON.stringify([event()]);
    expect(verifySendgridWebhookSignature(
      Buffer.from(body),
      signBody(timestamp, body),
      timestamp,
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      fixedNow,
    )).toBe(true);
    expect(verifySendgridWebhookSignature(
      Buffer.from(`${body} `),
      signBody(timestamp, body),
      timestamp,
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      fixedNow,
    )).toBe(false);
    expect(verifySendgridWebhookSignature(
      Buffer.from(body),
      signBody(timestamp, body),
      timestamp,
      publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      fixedNow,
    )).toBe(true);
  });
});
