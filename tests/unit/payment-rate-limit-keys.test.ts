import { describe, expect, it, vi } from "vitest";

const { limiterOptions } = vi.hoisted(() => ({
  limiterOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("express-rate-limit", () => ({
  default: (options: Record<string, unknown>) => {
    limiterOptions.push(options);
    return options;
  },
  ipKeyGenerator: (ip: string) => `ip:${ip}`,
}));
vi.mock("../../server/utils/rate-limit-store", () => ({
  createSharedRateLimitStore: (prefix: string) => ({ prefix }),
}));

await import("../../server/middleware/rate-limit");

function limiter(prefix: string) {
  const found = limiterOptions.find((options) => (options.store as { prefix: string }).prefix === prefix);
  if (!found) throw new Error(`no limiter uses the ${prefix} store`);
  return found as { max: number; windowMs: number; keyGenerator?: (req: unknown) => string };
}

describe("payment rate-limit budgets", () => {
  it.each([
    ["payment-write-user-60-15m", 60],
    ["payment-quote", 300],
  ])("%s allows %i requests per 15 minutes per signed-in account", (prefix, max) => {
    const options = limiter(prefix);

    expect(options.max).toBe(max);
    expect(options.windowMs).toBe(15 * 60 * 1000);
    // Two bowlers on one bowling center's network must not share a budget.
    expect(options.keyGenerator?.({ user: { id: 7 }, ip: "203.0.113.5" })).toBe("7");
    expect(options.keyGenerator?.({ user: { id: 8 }, ip: "203.0.113.5" })).toBe("8");
    expect(options.keyGenerator?.({ ip: "203.0.113.5" })).toBe("ip:203.0.113.5");
  });

  it("keeps quote and charge budgets in separate stores", () => {
    expect(limiter("payment-quote")).not.toBe(limiter("payment-write-user-60-15m"));
  });
});
