import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DiagnosticState = {
  user: unknown;
  level?: string;
  tags: Array<[string, string]>;
};

const mocks = vi.hoisted(() => ({
  initializeSquare: vi.fn(),
  captureMessage: vi.fn(),
  scopes: [] as DiagnosticState[],
}));

vi.mock("@/lib/square", () => ({ initializeSquare: mocks.initializeSquare }));
vi.mock("@sentry/react", () => ({
  captureMessage: mocks.captureMessage,
  withScope: (callback: (scope: {
    setUser: (user: unknown) => void;
    setLevel: (level: string) => void;
    setTag: (key: string, value: string) => void;
  }) => void) => {
    const state: DiagnosticState = { user: undefined, tags: [] };
    mocks.scopes.push(state);
    callback({
      setUser: (user) => { state.user = user; },
      setLevel: (level) => { state.level = level; },
      setTag: (key, value) => { state.tags.push([key, value]); },
    });
  },
}));

import { useWalletPayments } from "@/hooks/use-wallet-payments";

const defaultOptions = {
  locationId: 1,
  amountCents: 1_000,
  enabled: true,
};

type WalletCallbacks = {
  onPaymentStarted?: () => void | boolean;
  onTokenReceived?: (token: string, walletType: "apple_pay" | "google_pay") => Promise<void>;
  onError?: (error: string) => void;
};

async function renderReadyWallet(
  applePay: { tokenize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> },
  callbacks: WalletCallbacks = {},
) {
  mocks.initializeSquare.mockResolvedValue({
    paymentRequest: vi.fn(() => ({ update: vi.fn() })),
    applePay: vi.fn().mockResolvedValue(applePay),
    googlePay: vi.fn().mockRejectedValue(new Error("unavailable")),
  });
  const onTokenReceived = callbacks.onTokenReceived ?? vi.fn().mockResolvedValue(undefined);
  const onError = callbacks.onError ?? vi.fn();
  const hook = renderHook(() => useWalletPayments({
    ...defaultOptions,
    ...callbacks,
    onTokenReceived,
    onError,
  }));
  act(() => { vi.advanceTimersByTime(400); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { ...hook, onError, onTokenReceived };
}

function diagnosticTags(state: DiagnosticState): Record<string, string> {
  return Object.fromEntries(state.tags);
}

describe("useWalletPayments Apple Pay diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.initializeSquare.mockReset();
    mocks.captureMessage.mockReset().mockReturnValue("sentry-event");
    mocks.scopes.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "TokenizationError",
      type: "TOKENIZATION_IN_PROCESS",
      expectedName: "TokenizationError",
      expectedType: "TOKENIZATION_IN_PROCESS",
    },
    {
      name: "PrivateMerchantValidationError",
      type: "private-error-detail",
      expectedName: "unknown",
      expectedType: "unknown",
    },
  ])("reports only allowlisted failure classifications ($expectedName / $expectedType)", async ({ name, type, expectedName, expectedType }) => {
    const privateMessage = "private merchant validation response";
    const failure = Object.assign(new Error(privateMessage), {
      name,
      errors: [{ type, message: privateMessage }],
    });
    const applePay = { tokenize: vi.fn().mockRejectedValue(failure), destroy: vi.fn() };
    const { result, onError, onTokenReceived } = await renderReadyWallet(applePay);

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(mocks.captureMessage).toHaveBeenCalledTimes(2);
    expect(mocks.captureMessage).toHaveBeenNthCalledWith(1, "Apple Pay wallet outcome");
    expect(mocks.captureMessage).toHaveBeenNthCalledWith(2, "Apple Pay wallet outcome");
    expect(mocks.scopes.map(diagnosticTags)).toEqual([
      {
        wallet_payment_method: "apple_pay",
        wallet_payment_stage: "tokenize_started",
      },
      {
        wallet_payment_method: "apple_pay",
        wallet_payment_stage: "tokenize_failed",
        wallet_error_name: expectedName,
        wallet_error_type: expectedType,
      },
    ]);
    expect(mocks.scopes.map((scope) => scope.level)).toEqual(["info", "warning"]);
    expect(mocks.scopes.every((scope) => scope.user === null)).toBe(true);
    expect(JSON.stringify({ calls: mocks.captureMessage.mock.calls, scopes: mocks.scopes }))
      .not.toContain(privateMessage);
    expect(JSON.stringify({ calls: mocks.captureMessage.mock.calls, scopes: mocks.scopes }))
      .not.toContain("private-error-detail");
    expect(onError).toHaveBeenCalledWith(privateMessage);
    expect(onTokenReceived).not.toHaveBeenCalled();
  });

  it("records a cancel result as an ambiguous dismissal without changing UI behavior", async () => {
    const onError = vi.fn();
    const onTokenReceived = vi.fn();
    const applePay = {
      tokenize: vi.fn().mockResolvedValue({ status: "Cancel" }),
      destroy: vi.fn(),
    };
    const { result } = await renderReadyWallet(applePay, { onError, onTokenReceived });

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(mocks.scopes.map(diagnosticTags).map((tags) => tags.wallet_payment_stage))
      .toEqual(["tokenize_started", "dismissed"]);
    expect(mocks.scopes.map((scope) => scope.level)).toEqual(["info", "info"]);
    expect(onError).not.toHaveBeenCalled();
    expect(onTokenReceived).not.toHaveBeenCalled();
  });

  it("records abort-like rejection as an ambiguous dismissal", async () => {
    const onError = vi.fn();
    const onTokenReceived = vi.fn();
    const applePay = {
      tokenize: vi.fn().mockRejectedValue(new Error("wallet flow aborted")),
      destroy: vi.fn(),
    };
    const { result } = await renderReadyWallet(applePay, { onError, onTokenReceived });

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(mocks.scopes.map(diagnosticTags).map((tags) => tags.wallet_payment_stage))
      .toEqual(["tokenize_started", "dismissed"]);
    expect(onError).not.toHaveBeenCalled();
    expect(onTokenReceived).not.toHaveBeenCalled();
  });

  it("starts Square synchronously before reporting and reports success before downstream work", async () => {
    const token = "cnon:demo";
    const downstreamMessage = "downstream callback detail";
    const onTokenReceived = vi.fn().mockRejectedValue(new Error(downstreamMessage));
    const onError = vi.fn();
    const tokenize = vi.fn().mockResolvedValue({ status: "OK", token });
    const applePay = { tokenize, destroy: vi.fn() };
    const onPaymentStarted = vi.fn().mockReturnValue(true);
    const { result } = await renderReadyWallet(applePay, {
      onPaymentStarted,
      onTokenReceived,
      onError,
    });

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(onPaymentStarted.mock.invocationCallOrder[0]).toBeLessThan(tokenize.mock.invocationCallOrder[0]);
    expect(tokenize.mock.invocationCallOrder[0]).toBeLessThan(mocks.captureMessage.mock.invocationCallOrder[0]);
    expect(mocks.captureMessage.mock.invocationCallOrder[1]).toBeLessThan(onTokenReceived.mock.invocationCallOrder[0]);
    expect(onTokenReceived).toHaveBeenCalledWith(token, "apple_pay");
    expect(mocks.scopes.map(diagnosticTags).map((tags) => tags.wallet_payment_stage))
      .toEqual(["tokenize_started", "token_received"]);
    expect(JSON.stringify({ calls: mocks.captureMessage.mock.calls, scopes: mocks.scopes }))
      .not.toContain(token);
    expect(JSON.stringify({ calls: mocks.captureMessage.mock.calls, scopes: mocks.scopes }))
      .not.toContain(downstreamMessage);
    expect(onError).toHaveBeenCalledWith(downstreamMessage);
    expect(diagnosticTags(mocks.scopes[1])).not.toHaveProperty("wallet_error_name");
  });

  it("does not invoke the charge callback when tokenization returns no token", async () => {
    const onTokenReceived = vi.fn();
    const onError = vi.fn();
    const applePay = {
      tokenize: vi.fn().mockResolvedValue({ status: "OK" }),
      destroy: vi.fn(),
    };
    const { result } = await renderReadyWallet(applePay, { onTokenReceived, onError });

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(onTokenReceived).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Apple Pay payment was not completed");
    expect(mocks.scopes.map(diagnosticTags).map((tags) => tags.wallet_payment_stage))
      .toEqual(["tokenize_started", "tokenize_failed"]);
  });

  it("reports a synchronous tokenize throw without claiming a session started", async () => {
    const onError = vi.fn();
    const applePay = {
      tokenize: vi.fn(() => { throw Object.assign(new Error("wallet SDK failed"), { name: "UnexpectedError" }); }),
      destroy: vi.fn(),
    };
    const { result } = await renderReadyWallet(applePay, { onError });

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(mocks.scopes.map(diagnosticTags)).toEqual([{
      wallet_payment_method: "apple_pay",
      wallet_payment_stage: "tokenize_failed",
      wallet_error_name: "UnexpectedError",
      wallet_error_type: "unknown",
    }]);
    expect(onError).toHaveBeenCalledWith("wallet SDK failed");
  });

  it("keeps failure reporting intact if Sentry capture throws", async () => {
    mocks.captureMessage.mockImplementation(() => { throw new Error("Sentry unavailable"); });
    const onTokenReceived = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const applePay = {
      tokenize: vi.fn().mockRejectedValue(new Error("wallet tokenization failed")),
      destroy: vi.fn(),
    };
    const { result } = await renderReadyWallet(applePay, { onTokenReceived, onError });

    await act(async () => { await result.current.handleApplePayClick(); });
    expect(onError).toHaveBeenCalledWith("wallet tokenization failed");
    expect(mocks.captureMessage).toHaveBeenCalledTimes(2);
    expect(onTokenReceived).not.toHaveBeenCalled();
  });

  it("keeps token forwarding intact if Sentry capture throws on start and success", async () => {
    mocks.captureMessage.mockImplementation(() => { throw new Error("Sentry unavailable"); });
    const onTokenReceived = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const applePay = {
      tokenize: vi.fn().mockResolvedValue({ status: "OK", token: "cnon:demo" }),
      destroy: vi.fn(),
    };
    const { result } = await renderReadyWallet(applePay, { onTokenReceived, onError });

    await act(async () => { await result.current.handleApplePayClick(); });

    expect(applePay.tokenize).toHaveBeenCalledOnce();
    expect(onTokenReceived).toHaveBeenCalledWith("cnon:demo", "apple_pay");
    expect(onError).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledTimes(2);
  });
});
