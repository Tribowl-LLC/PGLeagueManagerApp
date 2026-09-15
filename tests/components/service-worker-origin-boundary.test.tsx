import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchListener = (event: {
  request: { url: string; destination: string; mode: string };
  respondWith: ReturnType<typeof vi.fn>;
}) => void;

function loadFetchListener(fetchImpl = vi.fn(() => new Promise(() => {})), cachesImpl = {}): FetchListener {
  const listeners = new Map<string, (...args: never[]) => void>();
  const self = {
    location: { origin: "https://leaguevault.example" },
    addEventListener: (name: string, listener: (...args: never[]) => void) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  vm.runInNewContext(fs.readFileSync("client/public/sw.js", "utf8"), {
    self,
    caches: cachesImpl,
    URL,
    Response,
    fetch: fetchImpl,
  });
  return listeners.get("fetch") as FetchListener;
}

describe("service worker origin boundary", () => {
  it.each([
    ["https://web.squarecdn.com/v1/square.js", "script"],
    ["https://web.squarecdn.com/1.84.3/card-wrapper.css", "style"],
    ["https://fonts.example/provider.woff2", "font"],
  ])("leaves cross-origin provider assets to the browser: %s", (url, destination) => {
    const respondWith = vi.fn();
    loadFetchListener()({ request: { url, destination, mode: "cors" }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("continues to handle same-origin application assets", () => {
    const respondWith = vi.fn();
    loadFetchListener()({
      request: { url: "https://leaguevault.example/assets/app.js", destination: "script", mode: "cors" },
      respondWith,
    });
    expect(respondWith).toHaveBeenCalledOnce();
  });

  it("returns an uncached 503 API response for a network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const cachesMock = {
      match: vi.fn(),
      open: vi.fn(),
    };
    const respondWith = vi.fn();
    loadFetchListener(fetchMock, cachesMock)({
      request: { url: "https://leaguevault.example/api/payments", destination: "", mode: "cors" },
      respondWith,
    });

    const response = await respondWith.mock.calls[0][0];
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "NETWORK_UNAVAILABLE",
        message: "Unable to connect. Check your connection and try again.",
      },
    });
    expect(cachesMock.match).not.toHaveBeenCalled();
    expect(cachesMock.open).not.toHaveBeenCalled();
  });

  it("preserves abort and unexpected API fetch failures", async () => {
    const abortError = new DOMException("cancelled", "AbortError");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(new Error("unexpected failure"));
    const listener = loadFetchListener(fetchMock);

    const abortedRespondWith = vi.fn();
    listener({
      request: { url: "https://leaguevault.example/api/one", destination: "", mode: "cors" },
      respondWith: abortedRespondWith,
    });
    await expect(abortedRespondWith.mock.calls[0][0]).rejects.toBe(abortError);

    const unexpectedRespondWith = vi.fn();
    listener({
      request: { url: "https://leaguevault.example/api/two", destination: "", mode: "cors" },
      respondWith: unexpectedRespondWith,
    });
    await expect(unexpectedRespondWith.mock.calls[0][0]).rejects.toThrow("unexpected failure");
  });
});
