import { describe, expect, it, vi } from "vitest";
import { PaymentOperationWakeScheduler } from "../../server/services/payment-operation-wake-scheduler";

describe("standing automatic-payment wake isolation", () => {
  it("supports a separate cutoff/operation wake shape", async () => {
    const loadNextWake = vi.fn().mockResolvedValue({ kind: "standing_cutoff", organizationId: 7, leagueId: 11, consentId: "consent", dueAt: new Date(Date.now() + 60_000).toISOString() });
    const handleWake = vi.fn().mockResolvedValue(undefined);
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const clearTimeoutFn = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const scheduler = new PaymentOperationWakeScheduler({ loadNextWake, handleWake, setTimeoutFn, clearTimeoutFn });
    await scheduler.start("ledger_execute");
    expect(loadNextWake).toHaveBeenCalledTimes(1);
    expect(handleWake).not.toHaveBeenCalled();
    scheduler.stop();
  });
});
