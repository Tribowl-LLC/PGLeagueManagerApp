import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { appEnv, env } from "../../config.js";
import { createLogger } from "../../logger.js";
import { squareWebhookLimiter } from "../../middleware/rate-limit.js";
import { apiHeaders, securityHeaders } from "../../middleware/security.js";
import {
  WebhookDuplicateMismatchError,
  WebhookLocationMappingError,
  ingestSquareWebhookEvent,
  type IngestSquareWebhookEventInput,
  type IngestSquareWebhookEventResult,
} from "../../storage/webhook-events.js";
import {
  resolveSquareWebhookConfig,
  SQUARE_WEBHOOK_PATH,
  type SquareWebhookConfig,
} from "../../services/square-webhook-config.js";
import {
  normalizeSquareWebhookEvent,
  SquareWebhookPayloadError,
} from "../../services/square-webhook-event.js";
import { sendError, sendSuccess } from "../../utils/api.js";
import {
  processSquareWebhookEvent,
  type SquareWebhookProcessingResult,
} from "../../storage/square-webhook-processing.js";
import { notifyScheduledPaymentMutation } from "../../services/scheduled-payment-runtime.js";

const log = createLogger("SquareWebhook");

export const SQUARE_WEBHOOK_BODY_LIMIT_BYTES = 12 * 1024;
export const SQUARE_WEBHOOK_REQUEST_ID_HEADER = "X-Request-ID";
export const SQUARE_WEBHOOK_SIGNATURE_HEADER = "x-square-hmacsha256-signature";

const REQUEST_ID_LOCAL = "squareWebhookRequestId";
const APPLICATION_ID_LOCAL = "squareWebhookApplicationId";

function requestId(res: Response): string {
  const existing = res.locals[REQUEST_ID_LOCAL];
  if (typeof existing === "string") return existing;
  const generated = randomUUID();
  res.locals[REQUEST_ID_LOCAL] = generated;
  res.setHeader(SQUARE_WEBHOOK_REQUEST_ID_HEADER, generated);
  return generated;
}

function initializeRequest(_req: Request, res: Response, next: () => void): void {
  requestId(res);
  next();
}

function defaultConfig(): SquareWebhookConfig {
  return resolveSquareWebhookConfig({
    mode: env.SQUARE_WEBHOOK_MODE,
    notificationUrl: env.SQUARE_WEBHOOK_NOTIFICATION_URL,
    providerApiVersion: env.SQUARE_WEBHOOK_API_VERSION,
    signatureKeysJson: env.SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON,
    appDomain: env.APP_DOMAIN,
    appEnv,
  });
}

function decodePresentedSignature(value: string): Buffer | null {
  if (value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value ? decoded : null;
}

/** Verifies URL + exact raw bytes and returns the one matching application. */
export function verifySquareWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  config: SquareWebhookConfig,
): string | null {
  if (config.mode === "disabled" || !config.notificationUrl) return null;
  const presented = decodePresentedSignature(signatureHeader);
  if (!presented) return null;
  const matches: string[] = [];
  for (const subscription of config.subscriptions) {
    const expected = createHmac("sha256", subscription.signatureKey)
      .update(config.notificationUrl, "utf8")
      .update(rawBody)
      .digest();
    if (timingSafeEqual(expected, presented)) matches.push(subscription.applicationId);
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

interface RegisterSquareWebhookOptions {
  config?: SquareWebhookConfig;
  ingest?: (input: IngestSquareWebhookEventInput) => Promise<IngestSquareWebhookEventResult>;
  process?: (input: {
    organizationId: number;
    eventId: string;
    event: ReturnType<typeof normalizeSquareWebhookEvent>;
    processDisputes?: boolean;
  }) => Promise<SquareWebhookProcessingResult>;
  rearm?: () => Promise<void>;
}

const rawBodyParser = express.raw({
  inflate: false,
  limit: SQUARE_WEBHOOK_BODY_LIMIT_BYTES,
  type: () => true,
});

const rawBodyErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const shape = error && typeof error === "object"
    ? error as { status?: unknown; type?: unknown }
    : {};
  const tooLarge = shape.status === 413 || shape.type === "entity.too.large";
  log.warn("Square webhook request rejected", {
    event: "square_webhook_rejected",
    requestId: requestId(res),
    outcome: tooLarge ? "payload_too_large" : "body_read_failed",
  });
  sendError(
    res,
    tooLarge ? "Request body exceeds the allowed size" : "Request body could not be read",
    tooLarge ? 413 : 400,
    tooLarge ? "SQUARE_WEBHOOK_PAYLOAD_TOO_LARGE" : "SQUARE_WEBHOOK_BODY_INVALID",
  );
};

function rawBodyText(body: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function signatureGate(config: SquareWebhookConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const correlationId = requestId(res);
    if (config.mode === "disabled") {
      sendError(res, "Square webhook ingestion is disabled", 503, "SQUARE_WEBHOOK_DISABLED");
      return;
    }
    const signature = req.header(SQUARE_WEBHOOK_SIGNATURE_HEADER);
    if (!signature) {
      log.warn("Square webhook request rejected", {
        event: "square_webhook_rejected",
        requestId: correlationId,
        outcome: "signature_missing",
      });
      sendError(res, "Missing signature", 401, "SQUARE_WEBHOOK_SIGNATURE_MISSING");
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const providerApplicationId = verifySquareWebhookSignature(body, signature, config);
    if (!providerApplicationId) {
      log.warn("Square webhook request rejected", {
        event: "square_webhook_rejected",
        requestId: correlationId,
        outcome: "signature_invalid",
      });
      sendError(res, "Invalid signature", 403, "SQUARE_WEBHOOK_SIGNATURE_INVALID");
      return;
    }
    res.locals[APPLICATION_ID_LOCAL] = providerApplicationId;
    next();
  };
}

/**
 * Registers the one canonical public Square route before tenant resolution and
 * global JSON parsing. Processing remains inline, provider-I/O-free, and
 * explicitly gated by one of the reconciliation modes.
 */
export function registerSquareWebhookReceiver(
  app: Express,
  options: RegisterSquareWebhookOptions = {},
): void {
  const config = options.config ?? defaultConfig();
  const ingest = options.ingest ?? ingestSquareWebhookEvent;
  const process = options.process ?? processSquareWebhookEvent;
  const rearm = options.rearm ?? notifyScheduledPaymentMutation;

  app.post(
    SQUARE_WEBHOOK_PATH,
    securityHeaders,
    apiHeaders,
    initializeRequest,
    rawBodyParser,
    rawBodyErrorHandler,
    signatureGate(config),
    // The shared limiter can use PostgreSQL only after signature validation;
    // missing/invalid signatures perform no database work.
    squareWebhookLimiter,
    async (req: Request, res: Response) => {
      const correlationId = requestId(res);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const providerApplicationId = res.locals[APPLICATION_ID_LOCAL];
      if (typeof providerApplicationId !== "string") {
        sendError(res, "Invalid signature", 403, "SQUARE_WEBHOOK_SIGNATURE_INVALID");
        return;
      }
      if (!req.is("application/json")) {
        sendError(res, "Content-Type must be application/json", 415, "SQUARE_WEBHOOK_CONTENT_TYPE_INVALID");
        return;
      }
      const text = rawBodyText(body);
      if (text === null) {
        sendError(res, "Malformed JSON body", 400, "SQUARE_WEBHOOK_INVALID_JSON");
        return;
      }

      let normalized;
      try {
        normalized = normalizeSquareWebhookEvent(text);
      } catch (error) {
        const code = error instanceof SquareWebhookPayloadError ? error.code : "INVALID_ENVELOPE";
        log.warn("Square webhook request rejected", {
          event: "square_webhook_rejected",
          requestId: correlationId,
          outcome: code.toLowerCase(),
        });
        sendError(res, "Malformed webhook event", 400, "SQUARE_WEBHOOK_EVENT_INVALID");
        return;
      }

      try {
        const result = await ingest({
          ...normalized,
          providerApplicationId,
          providerApiVersion: config.providerApiVersion,
          payloadHash: createHash("sha256").update(body).digest("hex"),
          rawPayload: text,
        });
        log.info("Square webhook durably recorded", {
          event: "square_webhook_ingested",
          requestId: correlationId,
          eventType: normalized.eventType,
          duplicate: result.duplicate,
          status: result.event.status,
        });
        if (
          (config.mode === "reconcile_payments"
            || config.mode === "reconcile_payments_and_disputes")
          && !normalized.ignored
        ) {
          const processed = await process({
            organizationId: result.event.organizationId,
            eventId: result.event.id,
            event: normalized,
            processDisputes: config.mode === "reconcile_payments_and_disputes",
          });
          if (!processed.acknowledged) {
            sendError(res, "Webhook event processing will be retried", 503, "SQUARE_WEBHOOK_PROCESSING_RETRY");
            return;
          }
          if (processed.scheduledPaymentWakeRequired === true) {
            try {
              await rearm();
            } catch (error) {
              log.error("Square webhook scheduler rearm failed", {
                event: "square_webhook_rearm_failed",
                requestId: correlationId,
                eventType: normalized.eventType,
                errorName: error instanceof Error ? error.name : "UnknownError",
              });
            }
          }
          sendSuccess(res, {
            received: true,
            duplicate: result.duplicate,
            status: processed.status,
          });
          return;
        }
        sendSuccess(res, {
          received: true,
          duplicate: result.duplicate,
          status: result.event.status,
        });
      } catch (error) {
        if (error instanceof WebhookLocationMappingError) {
          log.warn("Square webhook mapping rejected", {
            event: "square_webhook_mapping_rejected",
            requestId: correlationId,
            eventType: normalized.eventType,
            code: error.code,
          });
          sendError(res, "Webhook location could not be resolved", 422, "SQUARE_WEBHOOK_MAPPING_FAILED");
          return;
        }
        if (error instanceof WebhookDuplicateMismatchError) {
          log.error("Square webhook duplicate evidence mismatch", {
            event: "square_webhook_duplicate_mismatch",
            requestId: correlationId,
            eventType: normalized.eventType,
          });
          sendError(res, "Webhook event identity conflict", 409, "SQUARE_WEBHOOK_EVENT_CONFLICT");
          return;
        }
        log.error("Square webhook durable ingestion failed", {
          event: "square_webhook_ingestion_failed",
          requestId: correlationId,
          eventType: normalized.eventType,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        sendError(res, "Webhook event was not recorded", 503, "SQUARE_WEBHOOK_INGESTION_FAILED");
      }
    },
  );
}
