const EMAIL_MASK = "[redacted-email]";
const PHONE_MASK = "[redacted-phone]";
const TOKEN_MASK = "[redacted-token]";
const LINK_MASK = "[redacted-link]";

const MAX_STRING_LENGTH = 500;
const MAX_OBJECT_DEPTH = 4;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SENSITIVE_LINK_RE =
  /https?:\/\/[^\s'"<>]*(?:token|invite|reset|confirm|verify|auth|signature|code=)[^\s'"<>]*/gi;
const PROVIDER_TOKEN_RE =
  /\b(?:cnon|ccof|sq0[a-z]{3}|sqics|sqcsp)[:_-][A-Za-z0-9_.-]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]+/gi;
const PHONE_RE = /\+?\d[\d()\s.-]{6,}\d/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;

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

export function scrubAndTruncate(input: string): string {
  return truncate(scrubString(input));
}

export function scrubUrl(input: string): string {
  const queryIndex = input.indexOf("?");
  const fragmentIndex = input.indexOf("#");
  const firstSensitiveDelimiter = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), input.length);
  return scrubAndTruncate(input.slice(0, firstSensitiveDelimiter));
}

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

type SentryEventLike = {
  message?: unknown;
  exception?: { values?: Array<{ value?: unknown; type?: unknown }> };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: Array<{ message?: unknown; data?: unknown }>;
  request?: {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
  };
  user?: Record<string, unknown>;
  transaction?: unknown;
  spans?: SentrySpanLike[];
};

type SentrySpanLike = {
  description?: unknown;
  data?: Record<string, unknown>;
};

function isSensitiveSpanAttribute(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "url.query"
    || normalized.includes("cookie")
    || normalized.startsWith("http.request.header.")
    || normalized.startsWith("http.response.header.")
    || normalized.includes("request.body")
    || normalized.includes("response.body");
}

/** Remove request secrets and scrub remaining span text before trace export. */
export function scrubSentrySpan<T extends SentrySpanLike>(span: T): T {
  if (typeof span.description === "string") {
    span.description = scrubAndTruncate(span.description.replace(/\?[^\s]*/g, ""));
  }

  if (span.data) {
    for (const key of Object.keys(span.data)) {
      if (isSensitiveSpanAttribute(key)) {
        delete span.data[key];
        continue;
      }
      const value = span.data[key];
      span.data[key] = typeof value === "string" && ["url.full", "http.url"].includes(key.toLowerCase())
        ? scrubUrl(value)
        : scrubDeep(value);
    }
  }

  return span;
}

/** Privacy backstop shared by browser and server Sentry clients. */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  if (!event) return event;

  if (typeof event.message === "string") event.message = scrubString(event.message);

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (typeof exception.value === "string") exception.value = scrubString(exception.value);
    }
  }

  if (event.extra) event.extra = scrubDeep(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubDeep(event.contexts) as Record<string, unknown>;

  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (typeof breadcrumb.message === "string") breadcrumb.message = scrubString(breadcrumb.message);
      if (breadcrumb.data && typeof breadcrumb.data === "object") breadcrumb.data = scrubDeep(breadcrumb.data);
    }
  }

  if (event.request) {
    if (typeof event.request.url === "string") event.request.url = scrubUrl(event.request.url);
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    delete event.request.env;
  }

  if (event.user) {
    event.user = typeof event.user.id === "string" || typeof event.user.id === "number"
      ? { id: String(event.user.id) }
      : {};
  }

  if (typeof event.transaction === "string") {
    event.transaction = scrubAndTruncate(event.transaction.replace(/\?[^\s]*/g, ""));
  }

  if (event.spans) {
    for (const span of event.spans) scrubSentrySpan(span);
  }

  return event;
}
