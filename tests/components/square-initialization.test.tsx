import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadScript: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/utils", () => ({ loadScript: mocks.loadScript }));
vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import {
  initializeSquare,
  resetSquarePayments,
  SQUARE_INITIALIZATION_FALLBACK_MESSAGE,
} from "@/lib/square";

describe("Square initialization recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSquarePayments();
    window.Square = undefined;
    mocks.loadScript.mockReset();
    mocks.logger.error.mockReset();
    mocks.logger.warn.mockReset();
    mocks.logger.debug.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ appId: "sandbox-app", locationId: "LOC123" }), {
        headers: { "Content-Type": "application/json" },
      }),
    ));
  });

  afterEach(() => {
    resetSquarePayments();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reloads the SDK after a timed-out handshake instead of retrying the stale global", async () => {
    let scriptLoads = 0;
    let paymentInitializations = 0;
    mocks.loadScript.mockImplementation(async () => {
      scriptLoads += 1;
      const firstAttempt = scriptLoads === 1;
      Object.defineProperty(window, "Square", {
        configurable: true,
        value: {
          payments: vi.fn(() => {
            paymentInitializations += 1;
            return firstAttempt
              ? new Promise(() => {})
              : Promise.resolve({ card: vi.fn() });
          }),
        },
      });
    });

    const pending = initializeSquare(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual(expect.objectContaining({ card: expect.any(Function) }));

    expect(scriptLoads).toBe(2);
    expect(paymentInitializations).toBe(2);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("returns a stable fallback after bounded retries exhaust", async () => {
    mocks.loadScript.mockRejectedValue(new Error("network unavailable"));
    const pending = initializeSquare(1);
    const rejected = expect(pending).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);

    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Square",
      "Square initialization failed after bounded retries",
      expect.any(Error),
    );
  });

  it("keeps the newer location instance when an older initialization completes late", async () => {
    let resolveLocationOne: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("locationId=1")) {
        return new Promise<Response>((resolve) => {
          resolveLocationOne = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ appId: "sandbox-app-two", locationId: "LOC2" }), {
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const locationOnePayments = { card: vi.fn() };
    const locationTwoPayments = { card: vi.fn() };
    mocks.loadScript.mockImplementation(async () => {
      Object.defineProperty(window, "Square", {
        configurable: true,
        value: {
          payments: vi.fn((appId: string) => Promise.resolve(
            appId === "sandbox-app-one" ? locationOnePayments : locationTwoPayments,
          )),
        },
      });
    });

    const locationOne = initializeSquare(1);
    const locationTwo = initializeSquare(2);
    await expect(locationTwo).resolves.toBe(locationTwoPayments);
    expect(mocks.loadScript).toHaveBeenCalledOnce();

    resolveLocationOne?.(new Response(JSON.stringify({ appId: "sandbox-app-one", locationId: "LOC1" }), {
      headers: { "Content-Type": "application/json" },
    }));
    await expect(locationOne).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(initializeSquare(2)).resolves.toBe(locationTwoPayments);
    expect(mocks.loadScript).toHaveBeenCalledOnce();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("keeps the newer location instance when an older initialization rejects late", async () => {
    let rejectLocationOne: ((reason: Error) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("locationId=1")) {
        return new Promise<Response>((_resolve, reject) => {
          rejectLocationOne = reject;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ appId: "sandbox-app-two", locationId: "LOC2" }), {
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const locationTwoPayments = { card: vi.fn() };
    mocks.loadScript.mockImplementation(async () => {
      Object.defineProperty(window, "Square", {
        configurable: true,
        value: {
          payments: vi.fn(() => Promise.resolve(locationTwoPayments)),
        },
      });
    });

    const locationOne = initializeSquare(1);
    const locationTwo = initializeSquare(2);
    await expect(locationTwo).resolves.toBe(locationTwoPayments);
    expect(mocks.loadScript).toHaveBeenCalledOnce();

    rejectLocationOne?.(new Error("location one config unavailable"));
    await expect(locationOne).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(initializeSquare(2)).resolves.toBe(locationTwoPayments);
    expect(mocks.loadScript).toHaveBeenCalledOnce();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});
