import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import {
  initializeSquare,
  resetSquarePaymentsForTests,
  SQUARE_INITIALIZATION_FALLBACK_MESSAGE,
} from "@/lib/square";

const configResponse = (appId: string, locationId: string) =>
  new Response(JSON.stringify({ appId, locationId }), {
    headers: { "Content-Type": "application/json" },
  });

const paymentSet = () => ({
  card: vi.fn(),
  paymentRequest: vi.fn(),
  applePay: vi.fn(),
  googlePay: vi.fn(),
});

async function currentSquareScript(): Promise<HTMLScriptElement> {
  await vi.waitFor(() => {
    expect(document.querySelector('script[src*="square.js"]')).not.toBeNull();
  });
  return document.querySelector('script[src*="square.js"]') as HTMLScriptElement;
}

describe("Square initialization ownership", () => {
  beforeEach(() => {
    resetSquarePaymentsForTests();
    document.querySelectorAll('script[src*="square.js"]').forEach((script) => script.remove());
    window.Square = undefined;
    mocks.logger.error.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(configResponse("sandbox-app", "LOC123")));
  });

  afterEach(() => {
    resetSquarePaymentsForTests();
    document.querySelectorAll('script[src*="square.js"]').forEach((script) => script.remove());
    window.Square = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shares one SDK load and one payments instance across concurrent consumers", async () => {
    const payments = paymentSet();
    const paymentsFactory = vi.fn().mockResolvedValue(payments);
    const cardConsumer = initializeSquare(1);
    const walletConsumer = initializeSquare(1);
    const script = await currentSquareScript();
    window.Square = { payments: paymentsFactory };
    script.dispatchEvent(new Event("load"));

    await expect(cardConsumer).resolves.toBe(payments);
    await expect(walletConsumer).resolves.toBe(payments);
    expect(document.querySelectorAll('script[src*="square.js"]')).toHaveLength(1);
    expect(paymentsFactory).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("supports overlapping locations without allowing one to invalidate the other", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url.includes("locationId=1")
        ? configResponse("sandbox-app", "LOC1")
        : configResponse("sandbox-app", "LOC2"),
    )));
    const one = paymentSet();
    const two = paymentSet();
    const paymentsFactory = vi.fn((_appId: string, locationId: string) =>
      Promise.resolve(locationId === "LOC1" ? one : two));
    const locationOne = initializeSquare(1);
    const locationTwo = initializeSquare(2);
    const script = await currentSquareScript();
    window.Square = { payments: paymentsFactory };
    script.dispatchEvent(new Event("load"));

    await expect(locationOne).resolves.toBe(one);
    await expect(locationTwo).resolves.toBe(two);
    expect(paymentsFactory).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('script[src*="square.js"]')).toHaveLength(1);
  });

  it("retries only an explicit script network failure", async () => {
    vi.useFakeTimers();
    const pending = initializeSquare(1);
    const first = await currentSquareScript();
    first.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(500);

    const second = await currentSquareScript();
    expect(second).not.toBe(first);
    const payments = paymentSet();
    window.Square = { payments: vi.fn().mockResolvedValue(payments) };
    second.dispatchEvent(new Event("load"));
    await expect(pending).resolves.toBe(payments);
  });

  it("does not reinject an SDK that evaluated without its payments API", async () => {
    const pending = initializeSquare(1);
    const script = await currentSquareScript();
    script.dispatchEvent(new Event("load"));

    await expect(pending).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    await expect(initializeSquare(1)).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    expect(document.querySelectorAll('script[src*="square.js"]')).toHaveLength(1);
    expect(mocks.logger.error).toHaveBeenCalledOnce();
  });

  it("retries a settled payments handshake without reloading the SDK", async () => {
    vi.useFakeTimers();
    const payments = paymentSet();
    const paymentsFactory = vi.fn()
      .mockRejectedValueOnce(new Error("temporary provider handshake failure"))
      .mockResolvedValue(payments);
    window.Square = { payments: paymentsFactory };

    const pending = initializeSquare(1);
    await vi.advanceTimersByTimeAsync(750);
    await expect(pending).resolves.toBe(payments);
    expect(paymentsFactory).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('script[src*="square.js"]')).toHaveLength(0);
  });

  it("does not overlap a payments factory that times out", async () => {
    vi.useFakeTimers();
    const paymentsFactory = vi.fn(() => new Promise<ReturnType<typeof paymentSet>>(() => {}));
    window.Square = { payments: paymentsFactory };

    const pending = initializeSquare(1);
    const rejected = expect(pending).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    await expect(initializeSquare(1)).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    expect(paymentsFactory).toHaveBeenCalledOnce();
  });

  it("fails closed when a page attempts to mix sandbox and production SDKs", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url.includes("locationId=1")
        ? configResponse("sandbox-app", "LOC1")
        : configResponse("production-app", "LOC2"),
    )));
    const locationOne = initializeSquare(1);
    const first = await currentSquareScript();
    const payments = paymentSet();
    window.Square = { payments: vi.fn().mockResolvedValue(payments) };
    first.dispatchEvent(new Event("load"));
    await expect(locationOne).resolves.toBe(payments);

    await expect(initializeSquare(2)).rejects.toThrow(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    expect(document.querySelectorAll('script[src*="square.js"]')).toHaveLength(1);
  });
});
