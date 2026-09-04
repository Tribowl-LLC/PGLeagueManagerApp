import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeLogger } = vi.hoisted(() => ({
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../server/logger", () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));

// The app module only creates a pool at import time; this URL is never
// contacted because the test calls the isolated reporting helper directly.
process.env.DATABASE_URL ??= "postgres://test-only.invalid/leaguevault";
process.env.SESSION_SECRET ??= "test-only-session-secret";
process.env.FIELD_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.APP_ENV ??= "dev";
process.env.NODE_ENV ??= "test";

const { reportApplePayResumeFailure } = await import("../../server/app");

beforeEach(() => {
  for (const fn of Object.values(fakeLogger)) fn.mockReset();
});

describe("Apple Pay startup failure reporting", () => {
  it("captures the terminal error once while keeping SQL/provider details out of logs", () => {
    const databaseError = Object.assign(
      new Error("Failed query: UPDATE apple_pay_jobs /* provider token */"),
      { code: "57P03" },
    );

    reportApplePayResumeFailure(databaseError);

    expect(fakeLogger.captureException).toHaveBeenCalledOnce();
    expect(fakeLogger.captureException).toHaveBeenCalledWith(databaseError);
    expect(fakeLogger.error).toHaveBeenCalledOnce();
    expect(fakeLogger.error).toHaveBeenCalledWith("Apple Pay worker resume failed", {
      errorType: "Error",
      errorCode: "57P03",
    });
    expect(JSON.stringify(fakeLogger.error.mock.calls[0])).not.toContain("UPDATE apple_pay_jobs");
    expect(JSON.stringify(fakeLogger.error.mock.calls[0])).not.toContain("provider token");
  });
});
