import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ initializeSquare: vi.fn() }));
vi.mock("@/lib/square", () => ({ initializeSquare: mocks.initializeSquare }));

import { useWalletPayments } from "@/hooks/use-wallet-payments";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const options = (locationId: number) => ({
  locationId,
  amountCents: 1_000,
  enabled: true,
  onTokenReceived: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn(),
});

describe("useWalletPayments initialization lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.initializeSquare.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("destroys a stale Apple Pay instance when location changes during attach", async () => {
    const attachment = deferred();
    const applePay = { attach: vi.fn(() => attachment.promise), tokenize: vi.fn(), destroy: vi.fn() };
    mocks.initializeSquare.mockResolvedValue({
      paymentRequest: vi.fn(() => ({ update: vi.fn() })),
      applePay: vi.fn().mockResolvedValue(applePay),
      googlePay: vi.fn().mockRejectedValue(new Error("unavailable")),
    });
    const { result, rerender } = renderHook(
      ({ locationId }) => useWalletPayments(options(locationId)),
      { initialProps: { locationId: 1 } },
    );
    const container = document.createElement("div");
    result.current.applePayRef.current = container;
    act(() => { vi.advanceTimersByTime(400); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(applePay.attach).toHaveBeenCalledOnce();

    rerender({ locationId: 2 });
    attachment.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(applePay.destroy).toHaveBeenCalledOnce();
    expect(result.current.applePayAvailable).toBe(false);
  });

  it("destroys a stale Google Pay instance when location changes during attach", async () => {
    vi.stubGlobal("PaymentRequest", function PaymentRequest() {});
    Object.defineProperty(window, "PaymentRequest", {
      configurable: true,
      value: function PaymentRequest() {},
    });
    const attachment = deferred();
    const googlePay = { attach: vi.fn(() => attachment.promise), tokenize: vi.fn(), destroy: vi.fn() };
    mocks.initializeSquare.mockResolvedValue({
      paymentRequest: vi.fn(() => ({ update: vi.fn() })),
      applePay: vi.fn().mockRejectedValue(new Error("unavailable")),
      googlePay: vi.fn().mockResolvedValue(googlePay),
    });
    const { result, rerender } = renderHook(
      ({ locationId }) => useWalletPayments(options(locationId)),
      { initialProps: { locationId: 1 } },
    );
    const container = document.createElement("div");
    result.current.googlePayRef.current = container;
    act(() => { vi.advanceTimersByTime(400); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(googlePay.attach).toHaveBeenCalledOnce();

    rerender({ locationId: 2 });
    attachment.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(googlePay.destroy).toHaveBeenCalledOnce();
    expect(result.current.googlePayAvailable).toBe(false);
  });
});
