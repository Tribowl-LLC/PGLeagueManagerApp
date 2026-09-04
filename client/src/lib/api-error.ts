/**
 * Errors returned by the JSON API. Keeping the response status and stable
 * server code on one error type lets UI code make a deliberate distinction
 * between expected user-facing outcomes and unexpected failures.
 */
export interface ApiErrorOptions {
  message: string;
  status: number;
  statusText?: string;
  code?: string;
  retryAfterSeconds?: number | null;
}

export class ApiError extends Error {
  status: number;
  statusText?: string;
  code?: string;
  retryAfterSeconds?: number | null;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.statusText = options.statusText;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Statuses that represent a handled client/auth/business outcome. */
export const EXPECTED_API_ERROR_STATUSES = [
  400,
  401,
  403,
  409,
  422,
  429,
] as const;

/** Server failures for which repeating an idempotent read is generally safe. */
export const RETRYABLE_API_ERROR_STATUSES = [
  500,
  502,
  503,
  504,
] as const;

// A server-provided Retry-After value is useful, but an untrusted or stale
// header must not make a browser query sleep indefinitely.
export const MAX_API_RETRY_DELAY_MS = 5 * 60 * 1000;

export type ApiErrorClassification =
  | "aborted"
  | "expected-client"
  | "rate-limited"
  | "deterministic-client"
  | "retryable-server"
  | "transport"
  | "unexpected";

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;

  // A few older call sites only preserved the status in the conventional
  // `"429: ..."` message. Continue classifying those values correctly while
  // callers move to ApiError.
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const match = /^(\d{3})(?::|\s)/.exec(message);
    if (match) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

/** Abort is a control-flow outcome, not an application error. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}

/** Browser fetch reports network failures as TypeError (or NetworkError). */
export function isTransportError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof TypeError) return true;
  return error instanceof Error
    && ["NetworkError", "FetchError", "TimeoutError"].includes(error.name);
}

/**
 * Classify both ApiError instances and legacy error-shaped values. The
 * structural fallback keeps provider helpers that predate ApiError safe to
 * use while they migrate to the shared type.
 */
export function classifyApiError(error: unknown): ApiErrorClassification {
  if (isAbortError(error)) return "aborted";

  const status = getStatus(error);
  if (status === 429) return "rate-limited";
  if (EXPECTED_API_ERROR_STATUSES.includes(status as (typeof EXPECTED_API_ERROR_STATUSES)[number])) {
    return "expected-client";
  }
  if (RETRYABLE_API_ERROR_STATUSES.includes(status as (typeof RETRYABLE_API_ERROR_STATUSES)[number])) {
    return "retryable-server";
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return "deterministic-client";
  }
  if (isTransportError(error)) return "transport";
  return "unexpected";
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isExpectedApiError(error: unknown): boolean {
  return classifyApiError(error) === "expected-client"
    || classifyApiError(error) === "rate-limited";
}

export function shouldRetryApiQuery(failureCount: number, error: unknown): boolean {
  // One bounded retry is enough to cover a transient read failure without
  // turning an unavailable endpoint into a request storm.
  if (failureCount >= 1) return false;
  const classification = classifyApiError(error);
  return classification === "transport"
    || classification === "rate-limited"
    || classification === "retryable-server";
}

export function getApiRetryDelay(attemptIndex: number, error: unknown): number {
  const classification = classifyApiError(error);
  const retryAfterSeconds = classification === "rate-limited"
    ? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
    : undefined;
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(MAX_API_RETRY_DELAY_MS, retryAfterSeconds * 1000);
  }

  const safeAttemptIndex = Math.max(0, Math.floor(attemptIndex));
  return Math.min(MAX_API_RETRY_DELAY_MS, 1000 * 2 ** safeAttemptIndex);
}

type ApiErrorBody = {
  error?: { message?: unknown; code?: unknown } | string;
  message?: unknown;
};

function getApiErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as ApiErrorBody).error;
  if (typeof error === "object" && error !== null && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function getApiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const value = body as ApiErrorBody;
  if (typeof value.error === "object" && value.error !== null && typeof value.error.message === "string") {
    return value.error.message;
  }
  if (typeof value.error === "string") return value.error;
  if (typeof value.message === "string") return value.message;
  return fallback;
}

export function makeApiError(
  body: unknown,
  status: number,
  fallbackMessage: string,
  retryAfterSeconds?: number | null,
): ApiError {
  return new ApiError({
    message: getApiErrorMessage(body, fallbackMessage),
    status,
    code: getApiErrorCode(body),
    retryAfterSeconds,
  });
}
