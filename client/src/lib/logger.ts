import * as Sentry from "@sentry/react";
import {
  scrubAndTruncate,
  scrubString,
} from "@shared/telemetry-scrubber";

export { scrubDeep, scrubSentryEvent, scrubString } from "@shared/telemetry-scrubber";

// task #766: tiny client logging wrapper so SDK/provider/payment
// errors are reported consistently to Sentry, while raw `console`
// output is gated to non-production to reduce console noise. This is
// purely for diagnostics — user-facing toast sanitization stays
// separate and unchanged. Preserves the existing `[Scope]` prefix
// convention used across the client.
//
// task #770: this logger is the central funnel for every non-401
// API/query failure and for Square/wallet payment
// failures, so browser SDK and provider errors can carry request
// context, response bodies, emails, phone numbers, customer/card/
// payment IDs, tokens, and invite/reset/confirm links. Because a
// payments app must not let PII or secret-shaped strings leave the
// client unscrubbed, every value sent to Sentry is run through
// `sanitizeForTelemetry` (used by the logger) and `scrubSentryEvent`
// (a `beforeSend` backstop in `main.tsx`) so future call sites inherit
// redaction automatically. This is defensive hardening, not a fix for
// a confirmed leak.

const isDev = !import.meta.env.PROD;

function format(scope: string, message: string): string {
  return `[${scope}] ${message}`;
}

// ---------------------------------------------------------------------------
// Redaction scrubber (task #770)
// ---------------------------------------------------------------------------

// Scalar fields that are safe (and useful) to forward from an unknown
// error-shaped object without dumping the whole blob.
const SAFE_SCALAR_FIELDS = [
  "status",
  "statusText",
  "code",
  "name",
  "type",
] as const;

export interface SanitizedTelemetry {
  message: string;
  extra: Record<string, unknown>;
}

/**
 * Central sanitization layer for the client logger. Takes a message and
 * an optional unknown value (typically an `Error` or a thrown
 * provider/response object) and returns a scrubbed message plus a small
 * structured, safe `extra` payload. Never forwards whole unknown
 * objects wholesale.
 */
export function sanitizeForTelemetry(
  message: string,
  value?: unknown,
): SanitizedTelemetry {
  const safeMessage = scrubString(message);
  const extra: Record<string, unknown> = {};

  if (value === undefined) {
    return { message: safeMessage, extra };
  }

  if (value instanceof Error) {
    extra.errorName = value.name;
    if (value.message) extra.errorMessage = scrubAndTruncate(value.message);
    return { message: safeMessage, extra };
  }

  if (typeof value === "string") {
    extra.detail = scrubAndTruncate(value);
    return { message: safeMessage, extra };
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const field of SAFE_SCALAR_FIELDS) {
      const fieldValue = record[field];
      if (typeof fieldValue === "string") {
        extra[field] = scrubAndTruncate(fieldValue);
      } else if (typeof fieldValue === "number" || typeof fieldValue === "boolean") {
        extra[field] = fieldValue;
      }
    }
    return { message: safeMessage, extra };
  }

  extra.detail = scrubAndTruncate(String(value));
  return { message: safeMessage, extra };
}

function reportToSentry(
  level: "error" | "warning",
  scope: string,
  message: string,
  error?: unknown,
): void {
  const { message: safeMessage, extra } = sanitizeForTelemetry(
    format(scope, message),
    error,
  );

  if (error instanceof Error) {
    Sentry.captureException(error, {
      level,
      tags: { scope },
      extra: { message: safeMessage, ...extra },
    });
  } else if (error !== undefined) {
    Sentry.captureException(new Error(safeMessage), {
      level,
      tags: { scope },
      extra,
    });
  } else {
    Sentry.captureMessage(safeMessage, level);
  }
}

export const logger = {
  error(scope: string, message: string, error?: unknown): void {
    reportToSentry("error", scope, message, error);
    if (isDev) {
      if (error !== undefined) console.error(format(scope, message), error);
      else console.error(format(scope, message));
    }
  },

  warn(scope: string, message: string, error?: unknown): void {
    reportToSentry("warning", scope, message, error);
    if (isDev) {
      if (error !== undefined) console.warn(format(scope, message), error);
      else console.warn(format(scope, message));
    }
  },

  debug(scope: string, message: string, ...details: unknown[]): void {
    if (isDev) {
      console.debug(format(scope, message), ...details);
    }
  },
};
