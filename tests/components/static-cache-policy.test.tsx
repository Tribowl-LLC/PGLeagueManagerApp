import { describe, expect, it, vi } from "vitest";
import { setStaticCacheHeaders } from "../../server/static-cache-policy";

describe("static cache policy", () => {
  it.each(["/build/index.html", "/build/sw.js", "C:\\build\\sw.js"])(
    "serves deploy entrypoint %s without caching",
    (filePath) => {
      const setHeader = vi.fn();
      setStaticCacheHeaders({ setHeader }, filePath);
      expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    },
  );

  it("keeps hashed assets on the static middleware's immutable policy", () => {
    const setHeader = vi.fn();
    setStaticCacheHeaders({ setHeader }, "/build/assets/app-abc123.js");
    expect(setHeader).not.toHaveBeenCalled();
  });
});
