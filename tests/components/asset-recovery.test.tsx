import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAssetReleaseKey,
  isAssetLoadError,
  recoverFromAssetFailure,
  resetAssetRecoveryForTests,
} from "@/lib/asset-recovery";
import { isHandledPaymentError } from "@/lib/payment-user-error";

function storageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

afterEach(() => {
  resetAssetRecoveryForTests();
  vi.restoreAllMocks();
});

describe("client asset recovery", () => {
  it("recognizes dynamic-import and module MIME failures but not ordinary errors", () => {
    expect(isAssetLoadError(new TypeError("Failed to fetch dynamically imported module: /assets/page-abc.js"))).toBe(true);
    expect(isAssetLoadError(new Error("Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of text/html"))).toBe(true);
    expect(isAssetLoadError(new Error("Payment provider is temporarily unavailable"))).toBe(false);
  });

  it("uses the hashed entry path as the release guard key", () => {
    const entry = document.createElement("script");
    entry.type = "module";
    entry.src = "/assets/index-a1b2c3.js?cacheBust=old";
    document.head.appendChild(entry);

    expect(getAssetReleaseKey()).toBe("/assets/index-a1b2c3.js");
    entry.remove();
  });

  it("hard-refreshes once per release and falls back on the second failure", () => {
    const storage = storageStub();
    const reload = vi.fn();
    const error = new Error("Failed to fetch dynamically imported module: /assets/page-old.js");

    expect(recoverFromAssetFailure(error, { release: "/assets/index-new.js", storage, reload })).toBe("refreshing");
    expect(reload).toHaveBeenCalledOnce();
    expect(recoverFromAssetFailure(error, { release: "/assets/index-new.js", storage, reload })).toBe("fallback");
    expect(reload).toHaveBeenCalledOnce();
    expect(recoverFromAssetFailure(error, { release: "/assets/index-next.js", storage, reload })).toBe("refreshing");
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe("payment error telemetry classification", () => {
  it.each([
    [Object.assign(new Error("declined"), { code: "PAYMENT_DECLINED" }), true],
    [Object.assign(new Error("tokenization failed"), { code: "TOKENIZATION_ERROR" }), true],
    [Object.assign(new Error("card element missing"), { code: "INITIALIZATION_ERROR" }), false],
    [Object.assign(new Error("provider unavailable"), { status: 503 }), false],
    [Object.assign(new Error("transport unknown"), { code: "PAYMENT_FAILED" }), false],
  ])("classifies expected customer outcomes without reporting them", (error, expected) => {
    expect(isHandledPaymentError(error)).toBe(expected);
  });
});
