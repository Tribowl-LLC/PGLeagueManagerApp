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
  isSessionExpiredError,
} from "@/lib/api-error";
import { logger } from "@/lib/logger";
import { queryClient, resetSessionExpiryRedirect, throwIfResNotOk } from "@/lib/queryClient";
import { financialReadErrorMessage } from "@/lib/financial-utils";

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

  it("recognizes only the first-party expired-session contract", () => {
    expect(isSessionExpiredError(new ApiError({ message: "signed out", status: 401, code: "AUTH_REQUIRED" }))).toBe(true);
    expect(isSessionExpiredError(new ApiError({ message: "provider rejected", status: 401 }))).toBe(false);
    expect(isSessionExpiredError(new ApiError({ message: "wrong password", status: 401, code: "INVALID_CREDENTIALS" }))).toBe(false);
    expect(isSessionExpiredError(new ApiError({ message: "auth required", status: 403, code: "AUTH_REQUIRED" }))).toBe(false);
  });

  it("preserves AUTH_REQUIRED details and redirects once per source location", async () => {
    const replace = vi.fn();
    queryClient.setQueryData(["/api/user"], { data: { id: 9 } });
    vi.stubGlobal("window", {
      location: { pathname: "/reports", search: "", replace },
    });
    const response = () => new Response(JSON.stringify({
      error: { message: "Not authenticated", code: "AUTH_REQUIRED" },
    }), { status: 401, headers: { "content-type": "application/json" } });

    await expect(throwIfResNotOk(response())).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    await expect(throwIfResNotOk(response())).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/login?reason=session-expired");

    resetSessionExpiryRedirect();
    const providerReplace = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/payments", search: "", replace: providerReplace } });
    await expect(throwIfResNotOk(new Response(JSON.stringify({
      error: { message: "Invalid provider credentials", code: "INVALID_CREDENTIALS" },
    }), { status: 401, headers: { "content-type": "application/json" } }))).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
    expect(providerReplace).not.toHaveBeenCalled();
  });

  it("uses the expired-session redirect for a cached root session and plain login for anonymous root", async () => {
    const rootReplace = vi.fn();
    queryClient.setQueryData(["/api/user"], { data: { id: 17 } });
    vi.stubGlobal("window", {
      location: { pathname: "/", search: "", replace: rootReplace },
    });
    await expect(throwIfResNotOk(new Response(JSON.stringify({
      error: { message: "Not authenticated", code: "AUTH_REQUIRED" },
    }), { status: 401, headers: { "content-type": "application/json" } }))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(rootReplace).toHaveBeenCalledWith("/login?reason=session-expired");

    resetSessionExpiryRedirect();
    queryClient.clear();
    const anonymousReplace = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/", search: "", replace: anonymousReplace },
    });
    await expect(throwIfResNotOk(new Response(JSON.stringify({
      error: { message: "Not authenticated", code: "AUTH_REQUIRED" },
    }), { status: 401, headers: { "content-type": "application/json" } }))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(anonymousReplace).toHaveBeenCalledWith("/login");
  });

  it.each(["/reports", "/unknown-route"])("uses plain login for an anonymous AUTH_REQUIRED response at %s", async (path) => {
    const replace = vi.fn();
    queryClient.clear();
    resetSessionExpiryRedirect();
    vi.stubGlobal("window", {
      location: { pathname: path, search: "", replace },
    });
    await expect(throwIfResNotOk(new Response(JSON.stringify({
      error: { message: "Not authenticated", code: "AUTH_REQUIRED" },
    }), { status: 401, headers: { "content-type": "application/json" } }))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it.each(["/login", "/sign-up"])("does not redirect a public route for its background AUTH_REQUIRED response at %s", async (path) => {
    const replace = vi.fn();
    queryClient.clear();
    resetSessionExpiryRedirect();
    vi.stubGlobal("window", {
      location: { pathname: path, search: "", replace },
    });
    await expect(throwIfResNotOk(new Response(JSON.stringify({
      error: { message: "Not authenticated", code: "AUTH_REQUIRED" },
    }), { status: 401, headers: { "content-type": "application/json" } }))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps financial read copy specific to conflict versus availability", () => {
    expect(financialReadErrorMessage(new ApiError({ message: "conflict", status: 409 }))).toMatch(/requires review/i);
    expect(financialReadErrorMessage(new ApiError({ message: "forbidden", status: 403 }))).toMatch(/permission/i);
    expect(financialReadErrorMessage(new ApiError({ message: "down", status: 503 }))).toMatch(/temporarily unavailable/i);
    expect(financialReadErrorMessage(new ApiError({ message: "wrong auth", status: 401, code: "INVALID_CREDENTIALS" }))).not.toMatch(/session expired/i);
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
