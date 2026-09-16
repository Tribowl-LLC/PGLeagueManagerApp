import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expectErrorLog } from "../helpers/expected-error-logs";

process.env.DATABASE_URL ??= "postgres://email-alert-fixture.invalid/fixture";
process.env.SESSION_SECRET ??= "email-alert-fixture-session-secret";
process.env.FIELD_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const {
  parseSendgridDeliveryAlert,
  registerSendgridWebhookReceiver,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  SENDGRID_WEBHOOK_PATH,
} = await import("../../server/routes/email/sendgrid-webhook");

const fixedNow = new Date("2026-09-16T01:00:00.000Z");
const timestamp = String(Math.floor(fixedNow.getTime() / 1000));
const knownCorrelation = vi.fn();
const ingest = vi.fn();
const ingestAlert = vi.fn();
let server: Server;
let baseUrl: string;

function signBody(body: string, signedTimestamp = timestamp): string {
  const signer = createSign("sha256");
  signer.update(signedTimestamp, "utf8");
  signer.update(body, "utf8");
  return signer.sign(privateKey).toString("base64");
}

function failure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "bounce",
    timestamp: Math.floor(fixedNow.getTime() / 1000),
    sg_event_id: "alert-event-fixture-1",
    sg_message_id: "alert-message-fixture-1",
    email: "recipient@example.test",
    reason: "550 5.1.1 no such user",
    status: "5.1.1",
    ip: "192.0.2.10",
    account_action_id: "41",
    account_delivery_job_id: "7",
    ...overrides,
  };
}

async function postSigned(
  body: string,
  signature = signBody(body),
  signedTimestamp = timestamp,
): Promise<Response> {
  return fetch(`${baseUrl}${SENDGRID_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SENDGRID_SIGNATURE_HEADER]: signature,
      [SENDGRID_TIMESTAMP_HEADER]: signedTimestamp,
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
    ingestAlert: (...args) => ingestAlert(...args),
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
  knownCorrelation.mockReset().mockResolvedValue(false);
  ingest.mockReset().mockResolvedValue({ duplicate: false, ignored: false });
  ingestAlert.mockReset().mockResolvedValue({ duplicate: false });
});

describe("SendGrid delivery alert parser", () => {
  it("parses numeric epoch timestamps and returns only sanitized operational metadata", () => {
    expect(parseSendgridDeliveryAlert(failure())).toEqual({
      providerEventId: "alert-event-fixture-1",
      providerMessageId: "alert-message-fixture-1",
      recipientEmail: "recipient@example.test",
      eventType: "bounce",
      failureType: "bounce",
      reasonCode: "recipient_address_invalid",
      bounceClassification: null,
      smtpStatus: "5.1.1",
      sendingIp: "192.0.2.10",
      providerEventAt: fixedNow.toISOString(),
    });
  });

  it("requires a bounded valid recipient and ignores malformed or unsupported events", () => {
    expect(parseSendgridDeliveryAlert(failure({ email: "not-an-email" }))).toBeNull();
    expect(parseSendgridDeliveryAlert(failure({ email: "bad\u0000@example.test" }))).toBeNull();
    expect(parseSendgridDeliveryAlert(failure({ event: "delivered" }))).toBeNull();
    expect(parseSendgridDeliveryAlert(failure({ timestamp: "not-an-epoch" }))).toBeNull();
    expect(parseSendgridDeliveryAlert(failure({ bounce_classification: "constructor" }))).toMatchObject({
      bounceClassification: null,
    });
  });

  it("separates IP blocklist evidence from generic policy blocking and preserves dropped type", () => {
    expect(parseSendgridDeliveryAlert(failure({
      reason: "BL000100: recipient server uses DNSBL",
      type: "blocked",
    }))).toMatchObject({ failureType: "blocked", reasonCode: "sending_ip_blocklisted" });
    expect(parseSendgridDeliveryAlert(failure({
      reason: "message blocked by spam policy",
      type: "blocked",
    }))).toMatchObject({ failureType: "blocked", reasonCode: "policy_rejection" });
    expect(parseSendgridDeliveryAlert(failure({
      event: "dropped",
      reason: "550 5.1.1 no such user",
    }))?.failureType).toBe("dropped");
  });

  it("normalizes SendGrid Frequency/Volume classification to the stable key", () => {
    expect(parseSendgridDeliveryAlert(failure({
      bounce_classification: "Frequency/Volume",
    }))?.bounceClassification).toBe("frequency_volume");
    expect(parseSendgridDeliveryAlert(failure({
      bounce_classification: "frequency-volume",
    }))?.bounceClassification).toBe("frequency_volume");
  });
});

describe("signed webhook alert ingestion", () => {
  it("records a failure alert even when its account correlation is unknown", async () => {
    const response = await postSigned(JSON.stringify([failure()]));
    expect(response.status).toBe(200);
    expect(ingestAlert).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: "alert-event-fixture-1",
      recipientEmail: "recipient@example.test",
      reasonCode: "recipient_address_invalid",
    }));
    expect(ingest).not.toHaveBeenCalled();
  });

  it("runs the existing correlated ingester alongside the global alert ingester", async () => {
    knownCorrelation.mockResolvedValue(true);
    const response = await postSigned(JSON.stringify([failure({ sg_event_id: "alert-correlated-fixture" })]));
    expect(response.status).toBe(200);
    expect(ingestAlert).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: "alert-correlated-fixture",
      eventType: "bounce",
    }));
  });

  it("returns 503 and stores nothing when alert persistence fails", async () => {
    const providerSecret = "provider-alert-body-secret";
    expectErrorLog(/SendGrid delivery event persistence failed/);
    ingestAlert.mockRejectedValue({ code: providerSecret });
    const response = await postSigned(JSON.stringify([failure({ sg_event_id: "alert-persistence-error" })]));
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ success: false, error: { code: "SENDGRID_WEBHOOK_RETRYABLE" } });
    expect(JSON.stringify(payload)).not.toContain(providerSecret);
  });

  it("rejects a stale signed batch before either ingester is called", async () => {
    const staleTimestamp = String(Number(timestamp) - 301);
    const body = JSON.stringify([failure({ sg_event_id: "alert-stale-fixture" })]);
    const response = await postSigned(body, signBody(body, staleTimestamp), staleTimestamp);
    expect(response.status).toBe(403);
    expect(ingestAlert).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("keeps authenticated duplicate delivery idempotent and rejects forged signatures before ingestion", async () => {
    const body = JSON.stringify([failure({ sg_event_id: "alert-duplicate-fixture" })]);
    const first = await postSigned(body);
    const second = await postSigned(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ingestAlert).toHaveBeenCalledTimes(2);

    ingestAlert.mockClear();
    const forged = await postSigned(body, "forged-signature");
    expect(forged.status).toBe(403);
    expect(ingestAlert).not.toHaveBeenCalled();
  });
});
