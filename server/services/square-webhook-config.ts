import { z } from "zod";

export const SQUARE_WEBHOOK_MODES = [
  "disabled",
  "ingest_only",
  "reconcile_payments",
  "reconcile_payments_and_disputes",
] as const;
export type SquareWebhookMode = (typeof SQUARE_WEBHOOK_MODES)[number];

export const SQUARE_WEBHOOK_SUPPORTED_API_VERSION = "2026-05-20" as const;
export const SQUARE_WEBHOOK_PATH = "/api/payments-provider/webhooks/square" as const;

export interface SquareWebhookSubscriptionSecret {
  applicationId: string;
  signatureKey: string;
}

export interface SquareWebhookConfig {
  mode: SquareWebhookMode;
  notificationUrl: string | null;
  providerApiVersion: typeof SQUARE_WEBHOOK_SUPPORTED_API_VERSION;
  subscriptions: readonly SquareWebhookSubscriptionSecret[];
}

interface SquareWebhookConfigInput {
  mode?: string;
  notificationUrl?: string;
  providerApiVersion?: string;
  signatureKeysJson?: string;
  appDomain: string;
  appEnv: string;
}

const subscriptionSchema = z.object({
  applicationId: z.string().trim().min(1).max(255),
  signatureKey: z.string().trim().min(16).max(512),
}).strict();

function parseSubscriptions(value: string | undefined): SquareWebhookSubscriptionSecret[] {
  if (!value) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON must be valid JSON");
  }
  const parsed = z.array(subscriptionSchema).min(1).max(100).safeParse(decoded);
  if (!parsed.success) {
    throw new Error("SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON has an invalid structure");
  }
  const seen = new Set<string>();
  for (const subscription of parsed.data) {
    if (seen.has(subscription.applicationId)) {
      throw new Error("SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON contains a duplicate applicationId");
    }
    seen.add(subscription.applicationId);
  }
  return parsed.data;
}

function validateNotificationUrl(
  value: string | undefined,
  input: Pick<SquareWebhookConfigInput, "appDomain" | "appEnv">,
): string {
  if (!value) throw new Error("SQUARE_WEBHOOK_NOTIFICATION_URL is required in an enabled mode");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SQUARE_WEBHOOK_NOTIFICATION_URL must be an absolute URL");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname !== SQUARE_WEBHOOK_PATH
  ) {
    throw new Error(
      `SQUARE_WEBHOOK_NOTIFICATION_URL must be an exact HTTPS URL ending in ${SQUARE_WEBHOOK_PATH}`,
    );
  }
  if (input.appEnv === "prod" && parsed.hostname.toLowerCase() !== input.appDomain.toLowerCase()) {
    throw new Error("SQUARE_WEBHOOK_NOTIFICATION_URL must use APP_DOMAIN in production");
  }
  return parsed.href;
}

/**
 * Resolves the process-level Square subscription boundary. Signature keys are
 * application/subscription secrets, not tenant/location credentials. They
 * remain out of the database and are never included in errors or logs.
 */
export function resolveSquareWebhookConfig(input: SquareWebhookConfigInput): SquareWebhookConfig {
  const modeResult = z.enum(SQUARE_WEBHOOK_MODES).safeParse(input.mode ?? "disabled");
  if (!modeResult.success) {
    throw new Error(
      "SQUARE_WEBHOOK_MODE must be disabled, ingest_only, reconcile_payments, or reconcile_payments_and_disputes",
    );
  }
  if (modeResult.data === "disabled") {
    return {
      mode: "disabled",
      notificationUrl: null,
      providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
      subscriptions: [],
    };
  }
  if (input.providerApiVersion !== SQUARE_WEBHOOK_SUPPORTED_API_VERSION) {
    throw new Error(
      `SQUARE_WEBHOOK_API_VERSION must be ${SQUARE_WEBHOOK_SUPPORTED_API_VERSION} in an enabled mode`,
    );
  }
  const subscriptions = parseSubscriptions(input.signatureKeysJson);
  if (subscriptions.length === 0) {
    throw new Error("SQUARE_WEBHOOK_SIGNATURE_KEYS_JSON is required in an enabled mode");
  }
  return {
    mode: modeResult.data,
    notificationUrl: validateNotificationUrl(input.notificationUrl, input),
    providerApiVersion: SQUARE_WEBHOOK_SUPPORTED_API_VERSION,
    subscriptions,
  };
}
