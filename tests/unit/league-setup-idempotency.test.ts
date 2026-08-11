import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupIdempotencyKeyRetainer } from "@/pages/league-view-page/fall-draft-secure-id";

describe("league setup idempotency keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retains a secure key for an exact semantic retry and rotates it after a change or reset", () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000003");
    vi.stubGlobal("crypto", { randomUUID });
    const retainer = createSetupIdempotencyKeyRetainer();
    const first = retainer.keyFor({ paymentMode: "weekly", schedule: { dates: ["2032-08-01"] } });
    expect(retainer.keyFor({ schedule: { dates: ["2032-08-01"] }, paymentMode: "weekly" })).toBe(first);
    const changed = retainer.keyFor({ paymentMode: "upfront", schedule: { dates: ["2032-08-01"] } });
    expect(changed).not.toBe(first);
    retainer.reset();
    expect(retainer.keyFor({ paymentMode: "upfront", schedule: { dates: ["2032-08-01"] } })).not.toBe(changed);
    expect(randomUUID).toHaveBeenCalledTimes(3);
  });

  it("fails closed when no cryptographically secure browser API is available", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createSetupIdempotencyKeyRetainer().keyFor({ name: "Fall" }))
      .toThrow(/Secure identifier generation is unavailable/);
  });
});
