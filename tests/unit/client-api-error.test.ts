import { afterEach, describe, expect, it, vi } from "vitest";

const { captureException, captureMessage } = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("@sentry/react", () => ({
  captureException,
  captureMessage,
}));

import {
  ApiError,
  classifyApiError,
  isAbortError,
  isExpectedApiError,
  getApiRetryDelay,
  MAX_API_RETRY_DELAY_MS,
  makeApiError,
  shouldRetryApiQuery,
} from "@/lib/api-error";
import { logger } from "@/lib/logger";
import { queryClient } from "@/lib/queryClient";

afterEach(() => {
  captureException.mockClear();
  captureMessage.mockClear();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("client API error classification", () => {
  it.each([400, 401, 403, 409, 422])(
    "treats HTTP %s as an expected client outcome",
    (status) => {
      const error = new ApiError({ message: "handled", status });
      expect(classifyApiError(error)).toBe("expected-client");
      expect(isExpectedApiError(error)).toBe(true);
      expect(shouldRetryApiQuery(0, error)).toBe(false);
    },
  );

  it("keeps rate limits expected while allowing one bounded read retry", () => {
    const error = new ApiError({
      message: "slow down",
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(classifyApiError(error)).toBe("rate-limited");
    expect(isExpectedApiError(error)).toBe(true);
    expect(shouldRetryApiQuery(0, error)).toBe(true);
    expect(shouldRetryApiQuery(1, error)).toBe(false);
  });

  it.each([500, 502, 503, 504])(
    "retries one read after retryable server status %s",
    (status) => {
      const error = new ApiError({ message: "temporary", status });
      expect(classifyApiError(error)).toBe("retryable-server");
      expect(shouldRetryApiQuery(0, error)).toBe(true);
      expect(shouldRetryApiQuery(1, error)).toBe(false);
    },
  );

  it("does not retry deterministic client failures or arbitrary errors", () => {
    expect(shouldRetryApiQuery(0, new ApiError({ message: "missing", status: 404 }))).toBe(false);
    expect(shouldRetryApiQuery(0, new Error("application failure"))).toBe(false);
    expect(shouldRetryApiQuery(0, new TypeError("network failure"))).toBe(true);
  });

  it("uses a bounded Retry-After delay for rate-limited reads", () => {
    expect(getApiRetryDelay(0, new ApiError({
      message: "slow down",
      status: 429,
      retryAfterSeconds: 17,
    }))).toBe(17_000);
    expect(getApiRetryDelay(0, new ApiError({
      message: "stale header",
      status: 429,
      retryAfterSeconds: MAX_API_RETRY_DELAY_MS / 1000 + 60,
    }))).toBe(MAX_API_RETRY_DELAY_MS);
    expect(getApiRetryDelay(0, new ApiError({ message: "no header", status: 429 }))).toBe(1_000);
  });

  it("ignores aborted requests and preserves structured response details", () => {
    const aborted = new DOMException("cancelled", "AbortError");
    expect(isAbortError(aborted)).toBe(true);
    expect(classifyApiError(aborted)).toBe("aborted");
    expect(shouldRetryApiQuery(0, aborted)).toBe(false);

    const error = makeApiError(
      { error: { code: "DUPLICATE_EMAIL", message: "Email already registered" } },
      400,
      "Registration failed",
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("DUPLICATE_EMAIL");
    expect(error.status).toBe(400);
    expect(error.message).toBe("Email already registered");
  });

  it("does not report expected API outcomes or aborted requests to Sentry", () => {
    logger.error("API", "validation failed", new ApiError({ message: "bad input", status: 422 }));
    logger.error("API", "request cancelled", new DOMException("cancelled", "AbortError"));
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();

    logger.error("API", "server failed", new ApiError({ message: "temporary", status: 500 }));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("reports a read only after retries are exhausted, not on a transient attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryClient.fetchQuery({
      queryKey: ["/api/retry-then-success"],
      retryDelay: () => 0,
    })).resolves.toEqual({ success: true, data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports one exhausted read failure after its bounded retry", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryClient.fetchQuery({
      queryKey: ["/api/retry-exhausted"],
      retryDelay: () => 0,
    })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
