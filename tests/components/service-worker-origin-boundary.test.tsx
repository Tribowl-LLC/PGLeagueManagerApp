import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchListener = (event: {
  request: { url: string; destination: string; mode: string };
  respondWith: ReturnType<typeof vi.fn>;
}) => void;

function loadFetchListener(): FetchListener {
  const listeners = new Map<string, (...args: never[]) => void>();
  const self = {
    location: { origin: "https://leaguevault.example" },
    addEventListener: (name: string, listener: (...args: never[]) => void) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  vm.runInNewContext(fs.readFileSync("client/public/sw.js", "utf8"), {
    self,
    caches: {},
    URL,
    Response,
    fetch: vi.fn(() => new Promise(() => {})),
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
});
