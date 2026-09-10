import { createPublicKey, createVerify } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createLogger } from "../../logger.js";
import {
  ingestAccountEmailDeliveryEvent,
  isKnownAccountEmailDeliveryCorrelation,
  type AccountEmailDeliveryCorrelation,
  type IngestAccountEmailDeliveryEventInput,
  type IngestAccountEmailDeliveryEventResult,
} from "../../storage/account-email-delivery-events.js";
import {
  ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES,
  type AccountEmailDeliveryEventType,
} from "@shared/schema/account-email-delivery-events";
import { getPgErrorCode } from "../../utils/db-errors.js";

const log = createLogger("SendgridWebhook");

export const SENDGRID_WEBHOOK_PATH = "/api/email/sendgrid/webhook";
export const SENDGRID_SIGNATURE_HEADER = "x-twilio-email-event-webhook-signature";
export const SENDGRID_TIMESTAMP_HEADER = "x-twilio-email-event-webhook-timestamp";
export const SENDGRID_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
export const SENDGRID_WEBHOOK_BODY_LIMIT = 256 * 1024;

type SendgridEventPayload = {
  event?: unknown;
  timestamp?: unknown;
  sg_event_id?: unknown;
  sg_message_id?: unknown;
  custom_args?: unknown;
  account_action_id?: unknown;
  account_delivery_job_id?: unknown;
  [key: string]: unknown;
};

export interface SendgridWebhookOptions {
  /** SendGrid's public signing key, normally supplied from server config. */
  publicKey?: string;
  maxAgeSeconds?: number;
  now?: () => Date;
  isKnownCorrelation?: (
    correlation: AccountEmailDeliveryCorrelation,
  ) => Promise<boolean> | boolean;
  ingest?: (
    input: IngestAccountEmailDeliveryEventInput,
  ) => Promise<IngestAccountEmailDeliveryEventResult>;
}

export interface ParsedSendgridEvent {
  providerEventId: string;
  providerMessageId: string | null;
  eventType: AccountEmailDeliveryEventType;
  providerEventAt: string;
  correlation: AccountEmailDeliveryCorrelation;
}

function decodeSignature(value: string): Buffer | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
  ) return null;
  const decoded = Buffer.from(trimmed, "base64");
  return decoded.length > 0 && decoded.toString("base64") === trimmed ? decoded : null;
}

function parseTimestamp(value: string, now: Date, maxAgeSeconds: number): boolean {
  if (!/^\d{1,12}$/.test(value)) return false;
  const timestamp = Number(value);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Number.isSafeInteger(timestamp)
    && Number.isSafeInteger(nowSeconds)
    && Math.abs(nowSeconds - timestamp) <= maxAgeSeconds;
}

/**
 * Verifies the signed Event Webhook using the exact SendGrid contract:
 * SHA-256 is calculated over timestamp bytes followed by the raw payload
 * bytes, then the resulting ECDSA signature is checked with SendGrid's public
 * key. The raw body must be supplied unchanged; parsing/re-serializing JSON
 * before this function would invalidate an otherwise valid signature.
 *
 * See Twilio SendGrid's Signed Event Webhook documentation:
 * https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
 */
export function verifySendgridWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  timestampHeader: string,
  publicKey: string,
  now = new Date(),
  maxAgeSeconds = SENDGRID_WEBHOOK_MAX_AGE_SECONDS,
): boolean {
  if (!publicKey.trim() || !parseTimestamp(timestampHeader, now, maxAgeSeconds)) return false;
  const signature = decodeSignature(signatureHeader);
  if (!signature) return false;

  try {
    const verifier = createVerify("sha256");
    verifier.update(Buffer.from(timestampHeader, "utf8"));
    verifier.update(rawBody);
    verifier.end();
    // SendGrid's UI has supplied the verification key as both PEM and
    // base64-encoded DER over time. The official Node helper consumes PEM;
    // accepting the equivalent SPKI DER form keeps the deployment secret
    // format lossless without weakening key parsing.
    const verificationKey = publicKey.includes("-----BEGIN")
      ? publicKey
      : createPublicKey({
        key: Buffer.from(publicKey.replace(/\s+/g, ""), "base64"),
        format: "der",
        type: "spki",
      });
    return verifier.verify(verificationKey, signature);
  } catch {
    // Invalid public keys and malformed signatures are untrusted input.
    return false;
  }
}

function rawBodyText(rawBody: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return null;
  }
}

function positiveActionId(value: unknown): number | null {
  const asString = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d{1,12}$/.test(asString)) return null;
  const id = Number(asString);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function deliveryJobId(value: unknown): number | null {
  const id = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d{1,12}$/.test(id)) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function eventType(value: unknown): AccountEmailDeliveryEventType | null {
  return typeof value === "string"
    && (ACCOUNT_EMAIL_DELIVERY_EVENT_TYPES as readonly string[]).includes(value)
    ? value as AccountEmailDeliveryEventType
    : null;
}

function providerEventId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 100 ? id : null;
}

function providerMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 255 ? id : null;
}

function providerEventAt(value: unknown): string | null {
  if (
    (typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && !/^\d{1,12}$/.test(value.trim()))
  ) return null;
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseSendgridEvent(value: unknown): ParsedSendgridEvent | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as SendgridEventPayload;
  const type = eventType(payload.event);
  const id = providerEventId(payload.sg_event_id);
  const at = providerEventAt(payload.timestamp);
  // v3 `custom_args` are returned as top-level fields in Event Webhook
  // entries. Keep accepting a nested object as a compatibility aid for
  // fixtures and alternate SendGrid integrations.
  const payloadRecord = payload as Record<string, unknown>;
  const args = payload.custom_args;
  const customArgs = args && typeof args === "object"
    // Prefer SendGrid's flattened v3 fields when both representations are
    // present. The nested shape is compatibility-only and must not be able
    // to override the provider's actual event fields.
    ? { ...(args as Record<string, unknown>), ...payloadRecord }
    : payloadRecord;
  const accountActionId = positiveActionId(customArgs.account_action_id);
  const accountDeliveryJobId = deliveryJobId(customArgs.account_delivery_job_id);
  const messageId = providerMessageId(payload.sg_message_id);
  if (!type || !id || !at || accountActionId === null || accountDeliveryJobId === null) return null;

  return {
    providerEventId: id,
    providerMessageId: messageId,
    eventType: type,
    providerEventAt: at,
    correlation: { accountActionId, accountDeliveryJobId },
  };
}

const rawBodyParser = express.raw({
  inflate: false,
  limit: SENDGRID_WEBHOOK_BODY_LIMIT,
  type: "application/json",
});

const rawBodyErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error && typeof error === "object" && (error as { status?: unknown }).status === 413
    ? 413
    : 400;
  res.status(status).json({
    success: false,
    error: {
      code: status === 413 ? "SENDGRID_WEBHOOK_PAYLOAD_TOO_LARGE" : "SENDGRID_WEBHOOK_BODY_INVALID",
      message: status === 413 ? "Request body exceeds the allowed size" : "Request body could not be read",
    },
  });
};

function defaultPublicKey(): string {
  return process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim() ?? "";
}

/** Register the signed, raw-body SendGrid Event Webhook before JSON parsing. */
export function registerSendgridWebhookReceiver(
  app: Express,
  options: SendgridWebhookOptions = {},
): void {
  const publicKey = options.publicKey ?? defaultPublicKey();
  const maxAgeSeconds = options.maxAgeSeconds ?? SENDGRID_WEBHOOK_MAX_AGE_SECONDS;
  const now = options.now ?? (() => new Date());
  const isKnownCorrelation = options.isKnownCorrelation ?? isKnownAccountEmailDeliveryCorrelation;
  const ingest = options.ingest ?? ingestAccountEmailDeliveryEvent;

  app.post(
    SENDGRID_WEBHOOK_PATH,
    rawBodyParser,
    rawBodyErrorHandler,
    async (req: Request, res: Response, _next: NextFunction) => {
      if (!req.is("application/json") || !Buffer.isBuffer(req.body)) {
        res.status(415).json({
          success: false,
          error: { code: "SENDGRID_WEBHOOK_CONTENT_TYPE_INVALID", message: "Content-Type must be application/json" },
        });
        return;
      }

      const signature = req.header(SENDGRID_SIGNATURE_HEADER);
      const timestamp = req.header(SENDGRID_TIMESTAMP_HEADER);
      if (!signature || !timestamp) {
        res.status(401).json({
          success: false,
          error: { code: "SENDGRID_WEBHOOK_SIGNATURE_MISSING", message: "Missing SendGrid webhook signature" },
        });
        return;
      }
      if (!verifySendgridWebhookSignature(req.body, signature, timestamp, publicKey, now(), maxAgeSeconds)) {
        res.status(403).json({
          success: false,
          error: { code: "SENDGRID_WEBHOOK_SIGNATURE_INVALID", message: "Invalid SendGrid webhook signature" },
        });
        return;
      }

      const text = rawBodyText(req.body);
      if (text === null) {
        res.status(400).json({
          success: false,
          error: { code: "SENDGRID_WEBHOOK_BODY_INVALID", message: "Malformed webhook body" },
        });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        res.status(400).json({
          success: false,
          error: { code: "SENDGRID_WEBHOOK_BODY_INVALID", message: "Malformed webhook body" },
        });
        return;
      }
      if (!Array.isArray(payload)) {
        res.status(400).json({
          success: false,
          error: { code: "SENDGRID_WEBHOOK_BODY_INVALID", message: "Webhook body must be an event array" },
        });
        return;
      }

      let acceptedCount = 0;
      let ignoredCount = 0;
      try {
        for (const rawEvent of payload) {
          const event = parseSendgridEvent(rawEvent);
          if (!event || !(await isKnownCorrelation(event.correlation))) {
            ignoredCount += 1;
            continue;
          }

          const result = await ingest({
            providerEventId: event.providerEventId,
            providerMessageId: event.providerMessageId,
            accountActionId: event.correlation.accountActionId,
            accountDeliveryJobId: event.correlation.accountDeliveryJobId,
            eventType: event.eventType,
            providerEventAt: event.providerEventAt,
          });
          if (result.ignored) ignoredCount += 1;
          else acceptedCount += 1;
        }
      } catch (error) {
        // SQLSTATE is bounded diagnostic metadata. Avoid logging arbitrary
        // `error.code` values because a provider or database wrapper could
        // put request data in that field.
        const pgCode = getPgErrorCode(error);
        const errorCode = typeof pgCode === "string" && /^[0-9A-Z]{5}$/.test(pgCode)
          ? pgCode
          : "delivery_event_persistence_error";
        log.error("SendGrid delivery event persistence failed", { errorCode });
        res.status(503).json({
          success: false,
          error: {
            code: "SENDGRID_WEBHOOK_RETRYABLE",
            message: "Delivery events could not be recorded; retry the webhook",
          },
        });
        return;
      }

      log.info("SendGrid delivery events received", {
        acceptedCount,
        ignoredCount,
      });
      res.status(200).json({
        success: true,
        data: { received: true, acceptedCount, ignoredCount },
      });
    },
  );
}
