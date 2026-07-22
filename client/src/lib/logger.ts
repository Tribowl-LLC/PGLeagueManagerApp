import * as Sentry from "@sentry/react";

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

const EMAIL_MASK = "[redacted-email]";
const PHONE_MASK = "[redacted-phone]";
const TOKEN_MASK = "[redacted-token]";
const LINK_MASK = "[redacted-link]";

const MAX_STRING_LENGTH = 500;
const MAX_OBJECT_DEPTH = 4;

// Order matters: links and emails are scrubbed before the generic
// token/phone passes so their constituent characters aren't partially
// masked by a later, broader rule.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// URLs that carry invite/reset/confirm/verify/auth tokens either as a
// path segment or a query parameter. The whole URL is replaced because
// the sensitive material can live anywhere in it.
const SENSITIVE_LINK_RE =
  /https?:\/\/[^\s'"<>]*(?:token|invite|reset|confirm|verify|auth|signature|code=)[^\s'"<>]*/gi;

// Provider ID / nonce / secret shapes:
//   - Square nonces / card-on-file refs: cnon:..., ccof:...
//   - Square app/access/refresh secrets: sq0xxx-...
//   - Bearer-style tokens
const PROVIDER_TOKEN_RE =
  /\b(?:cnon|ccof|sq0[a-z]{3}|sqics|sqcsp)[:_-][A-Za-z0-9_.-]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]+/gi;

// Phone-like runs: an optional +, then a leading digit, then at least 6
// digit/separator characters, then a trailing digit. Requires enough
// length that years/short codes (e.g. "2026", "1.0.0") don't match.
const PHONE_RE = /\+?\d[\d()\s.-]{6,}\d/g;

// Generic long opaque identifiers / secrets: 24+ char runs of
// token-shaped characters. Catches customer/card/payment IDs and
// API-key-shaped strings that don't match a more specific rule above.
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Mask PII and secret-shaped substrings in a single string. Pure and
 * idempotent enough for telemetry use (re-running on already-masked
 * text leaves the `[redacted-*]` placeholders intact).
 */
export function scrubString(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(SENSITIVE_LINK_RE, LINK_MASK);
  out = out.replace(EMAIL_RE, EMAIL_MASK);
  out = out.replace(PROVIDER_TOKEN_RE, TOKEN_MASK);
  out = out.replace(BEARER_RE, TOKEN_MASK);
  out = out.replace(PHONE_RE, PHONE_MASK);
  out = out.replace(LONG_TOKEN_RE, TOKEN_MASK);
  return out;
}

function truncate(input: string): string {
  if (input.length <= MAX_STRING_LENGTH) return input;
  return `${input.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
}

function scrubAndTruncate(input: string): string {
  return truncate(scrubString(input));
}

/**
 * Recursively scrub an arbitrary value for inclusion in Sentry `extra`
 * / `contexts` / breadcrumb data. Strings are masked + truncated,
 * objects/arrays are walked up to a bounded depth, and anything deeper
 * (or otherwise unserializable) is collapsed to a safe placeholder so a
 * raw response body / large blob never leaves the client wholesale.
 */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubAndTruncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_OBJECT_DEPTH) return "[redacted-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => scrubDeep(item, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubAndTruncate(value.message),
    };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(val, depth + 1);
    }
    return out;
  }
  return scrubAndTruncate(String(value));
}

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

type SentryEventLike = {
  message?: unknown;
  exception?: { values?: Array<{ value?: unknown; type?: unknown }> };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: Array<{ message?: unknown; data?: unknown }>;
};

/**
 * `beforeSend` backstop: apply the same redaction to an outgoing Sentry
 * event's message, exception values, extra, contexts, and breadcrumbs
 * so captures that don't originate from this logger are still scrubbed.
 * Shares `scrubString` / `scrubDeep` with the logger to avoid drift.
 */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  if (!event) return event;

  if (typeof event.message === "string") {
    event.message = scrubString(event.message);
  }

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") ex.value = scrubString(ex.value);
    }
  }

  if (event.extra) {
    event.extra = scrubDeep(event.extra) as Record<string, unknown>;
  }

  if (event.contexts) {
    event.contexts = scrubDeep(event.contexts) as Record<string, unknown>;
  }

  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (typeof crumb.message === "string") {
        crumb.message = scrubString(crumb.message);
      }
      if (crumb.data && typeof crumb.data === "object") {
        crumb.data = scrubDeep(crumb.data);
      }
    }
  }

  return event;
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
