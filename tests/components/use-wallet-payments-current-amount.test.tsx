import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWalletPayments } from "@/hooks/use-wallet-payments";

const mocks = vi.hoisted(() => ({
  initializeSquare: vi.fn(),
}));

vi.mock("@/lib/square", () => ({
  initializeSquare: mocks.initializeSquare,
}));

describe("useWalletPayments current amount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.initializeSquare.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes a delayed wallet request with the latest amount", async () => {
    const paymentRequest = vi.fn(() => ({ update: vi.fn() }));
    mocks.initializeSquare.mockResolvedValue({
      paymentRequest,
      applePay: vi.fn().mockRejectedValue(new Error("unavailable")),
      googlePay: vi.fn().mockRejectedValue(new Error("unavailable")),
    });

    const { rerender, unmount } = renderHook(
      ({ amountCents }) => useWalletPayments({
        locationId: 1,
        amountCents,
        enabled: true,
        onTokenReceived: vi.fn(),
        onError: vi.fn(),
      }),
      { initialProps: { amountCents: 1_000 } },
    );

    rerender({ amountCents: 3_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(paymentRequest).toHaveBeenCalledWith(expect.objectContaining({
      total: { amount: "30.00", label: "Total" },
    }));
    unmount();
  });
});
