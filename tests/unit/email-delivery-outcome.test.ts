import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitEmailDelivery,
  DEFAULT_EMAIL_DELIVERY_TIMEOUT_MS,
} from "../../server/services/email-delivery-outcome";

afterEach(() => vi.useRealTimers());

describe("awaitEmailDelivery", () => {
  it("maps an accepted provider result", async () => {
    await expect(awaitEmailDelivery(async () => true)).resolves.toBe("accepted");
  });

  it("maps false and thrown provider results without rejecting the caller", async () => {
    await expect(awaitEmailDelivery(async () => false)).resolves.toBe("not_sent");
    await expect(awaitEmailDelivery(async () => {
      throw new Error("provider unavailable");
    })).resolves.toBe("not_sent");
  });

  it("returns unknown at the deadline and observes a late rejection", async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const late = new Promise<boolean>((_resolve, reject) => { rejectLate = reject; });
    const result = awaitEmailDelivery(() => late, 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe("unknown");
    // The helper attaches a rejection handler before returning unknown, so a
    // provider that settles after the HTTP deadline cannot become unhandled.
    rejectLate(new Error("late provider failure"));
    await Promise.resolve();
  });

  it("uses the documented default timeout", () => {
    expect(DEFAULT_EMAIL_DELIVERY_TIMEOUT_MS).toBe(5_000);
  });
});
