import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../client/src/main.tsx", import.meta.url), "utf8");

describe("asset recovery and Sentry startup ordering", () => {
  it("installs recovery before Sentry GlobalHandlers and filters its first event", () => {
    expect(mainSource.indexOf("installAssetRecoveryHandlers();")).toBeLessThan(mainSource.indexOf("Sentry.init("));
    expect(mainSource).toContain("shouldSuppressAssetTelemetry(event)");
  });
});
