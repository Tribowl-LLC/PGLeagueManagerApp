import { createPublicKey, createVerify } from "node:crypto";
import { isIP } from "node:net";
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
import {
  ingestEmailDeliveryAlert,
  type IngestEmailDeliveryAlertInput,
  type IngestEmailDeliveryAlertResult,
} from "../../storage/email-delivery-alerts.js";
import {
  type EmailDeliveryAlertBounceClassification,
  type EmailDeliveryAlertEventType,
  type EmailDeliveryAlertFailureType,
  type EmailDeliveryAlertReasonCode,
} from "@shared/schema/email-delivery-alerts";

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
  ingestAlert?: (
    input: IngestEmailDeliveryAlertInput,
  ) => Promise<IngestEmailDeliveryAlertResult>;
}

export interface ParsedSendgridEvent {
  providerEventId: string;
  providerMessageId: string | null;
  eventType: AccountEmailDeliveryEventType;
  providerEventAt: string;
  correlation: AccountEmailDeliveryCorrelation;
}

export interface ParsedSendgridDeliveryAlert {
  providerEventId: string;
  providerMessageId: string | null;
  recipientEmail: string;
  eventType: EmailDeliveryAlertEventType;
  failureType: EmailDeliveryAlertFailureType;
  reasonCode: EmailDeliveryAlertReasonCode;
  bounceClassification: EmailDeliveryAlertBounceClassification | null;
  smtpStatus: string | null;
  sendingIp: string | null;
  providerEventAt: string;
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
  return id.length > 0 && id.length <= 100 && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
}

function providerMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 255 && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
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

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0
    && result.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(result)
    ? result
    : null;
}

function recipientEmail(value: unknown): string | null {
  const email = boundedString(value, 320);
  // This is intentionally a bounded provider-payload guard rather than a
  // permissive parser. The schema applies the same basic shape at rest.
  return email
    && !/[\u0000-\u001f\u007f]/.test(email)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

function normalizedFailureText(payload: SendgridEventPayload): string {
  const reasonFields = [
    payload.reason,
    payload.response,
    payload.type,
  ];
  const fields = reasonFields.some((field) => typeof field === "string" && field.trim().length > 0)
    ? reasonFields
    : [payload.status, payload.event];
  return fields
    .filter((field): field is string | number => typeof field === "string" || typeof field === "number")
    .map((field) => String(field).slice(0, 512))
    .join(" ")
    .toLowerCase();
}

function bounceClassification(value: unknown): EmailDeliveryAlertBounceClassification | null {
  const raw = boundedString(value, 64);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[\/\s-]+/g, "_").replace(/_+/g, "_");
  const aliases: Record<string, EmailDeliveryAlertBounceClassification> = {
    invalid_address: "invalid_address",
    invalidaddress: "invalid_address",
    technical: "technical",
    content: "content",
    reputation: "reputation",
    mailbox_unavailable: "mailbox_unavailable",
    mailboxunavailable: "mailbox_unavailable",
    frequency_volume: "frequency_volume",
    frequencyvolume: "frequency_volume",
    unclassified: "unclassified",
  };
  return Object.hasOwn(aliases, normalized) ? aliases[normalized] : null;
}

function smtpStatus(value: unknown): string | null {
  const raw = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : boundedString(value, 32);
  if (!raw) return null;
  // SendGrid supplies either a three-digit SMTP status (`550`) or an
  // enhanced status (`5.1.1`). Keep only that code-shaped metadata.
  return /^(?:[2-5]\d{2}|[2-5]\.\d{1,3}\.\d{1,3})$/.test(raw) ? raw : null;
}

function sendingIp(value: unknown): string | null {
  const ip = boundedString(value, 45);
  return ip && isIP(ip) !== 0 ? ip : null;
}

function deriveAlertReason(
  payload: SendgridEventPayload,
  eventType: EmailDeliveryAlertEventType,
): { reasonCode: EmailDeliveryAlertReasonCode; failureType: EmailDeliveryAlertFailureType } {
  const text = normalizedFailureText(payload);
  const ipBlocklisted = /\b(?:dnsbl|rbl|blocklist(?:ed)?|bl\d{6})\b/.test(text);
  const bounceType = typeof payload.type === "string" ? payload.type.trim().toLowerCase() : "";
  const explicitlyBlocked = eventType === "bounce" && bounceType === "blocked";
  const failureType = eventType === "dropped"
    ? "dropped"
    : ipBlocklisted || explicitlyBlocked
      ? "blocked"
      : "bounce";
  if (ipBlocklisted) return { reasonCode: "sending_ip_blocklisted", failureType };
  if (/mailbox\s+(?:is\s+)?full|over\s+quota|quota\s+(?:has\s+been\s+)?exceeded/.test(text)) {
    return { reasonCode: "mailbox_full", failureType };
  }
  if (/invalid\s+(?:e[- ]?mail\s+)?address|no\s+such\s+user|user\s+unknown|recipient.*(?:not\s+found|unknown)|5\.1\./.test(text)) {
    return { reasonCode: "recipient_address_invalid", failureType };
  }
  if (/policy|spam|prohibited|content|blocked|5\.7\./.test(text)) {
    return { reasonCode: "policy_rejection", failureType };
  }
  if (/(?:^|\s)4\d{2}(?:\s|$)|\b4\.\d{1,3}\.\d{1,3}\b|temporary|temporar|defer/.test(text)) {
    return { reasonCode: "temporary_failure", failureType };
  }
  if (eventType === "dropped") {
    return { reasonCode: "provider_dropped", failureType: "dropped" };
  }
  return { reasonCode: "unknown_failure", failureType };
}

/**
 * Parse the provider-neutral operational alert independently of application
 * correlation. SendGrid can report a failed message before custom args exist,
 * so this parser deliberately requires only failure identity, recipient, and
 * the provider timestamp.
 */
export function parseSendgridDeliveryAlert(value: unknown): ParsedSendgridDeliveryAlert | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as SendgridEventPayload;
  const event = payload.event;
  if (event !== "bounce" && event !== "dropped") return null;
  const providerEventIdValue = providerEventId(payload.sg_event_id);
  const providerEventAtValue = providerEventAt(payload.timestamp);
  const recipient = recipientEmail(payload.email ?? payload.to);
  if (!providerEventIdValue || !providerEventAtValue || !recipient) return null;

  const eventType = event;
  const derived = deriveAlertReason(payload, eventType);
  const classification = bounceClassification(payload.bounce_classification ?? payload.bounceClassification);
  const status = smtpStatus(payload.status ?? payload.smtp_status ?? payload.smtpStatus);
  const ip = sendingIp(payload.ip ?? payload.sending_ip ?? payload.sendingIp);
  return {
    providerEventId: providerEventIdValue,
    providerMessageId: providerMessageId(payload.sg_message_id),
    recipientEmail: recipient,
    eventType,
    failureType: derived.failureType,
    reasonCode: derived.reasonCode,
    bounceClassification: classification,
    smtpStatus: status,
    sendingIp: ip,
    providerEventAt: providerEventAtValue,
  };
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
  const ingestAlert = options.ingestAlert ?? ingestEmailDeliveryAlert;

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
          const alert = parseSendgridDeliveryAlert(rawEvent);
          let accepted = false;
          let ignored = false;

          // Ingest the independent operational alert first. This path does
          // not require custom args or any tenant mapping, which preserves a
          // failure event even when its account action is unknown.
          if (alert) {
            const alertResult = await ingestAlert({
              providerEventId: alert.providerEventId,
              providerMessageId: alert.providerMessageId,
              recipientEmail: alert.recipientEmail,
              eventType: alert.eventType,
              failureType: alert.failureType,
              reasonCode: alert.reasonCode,
              bounceClassification: alert.bounceClassification,
              smtpStatus: alert.smtpStatus,
              sendingIp: alert.sendingIp,
              providerEventAt: alert.providerEventAt,
            });
            accepted = true;
            // Duplicate alerts are still accepted: SendGrid retries must be
            // acknowledged once the durable idempotency key is present.
            void alertResult;
          }

          if (event) {
            if (await isKnownCorrelation(event.correlation)) {
              const result = await ingest({
                providerEventId: event.providerEventId,
                providerMessageId: event.providerMessageId,
                accountActionId: event.correlation.accountActionId,
                accountDeliveryJobId: event.correlation.accountDeliveryJobId,
                eventType: event.eventType,
                providerEventAt: event.providerEventAt,
              });
              if (result.ignored) ignored = true;
              else accepted = true;
            } else {
              // Unknown correlation is expected for older, expired, or
              // provider-replayed actions. It must not hide an alert parsed
              // from the same failure event.
              ignored = true;
            }
          }

          if (accepted) acceptedCount += 1;
          else if (ignored || !alert) ignoredCount += 1;
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
