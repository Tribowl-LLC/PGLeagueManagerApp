import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountActionDeliveryScheduler,
  ACCOUNT_ACTION_DELIVERY_EXECUTION_RETRY_MS,
  ACCOUNT_ACTION_DELIVERY_LOOKUP_RETRY_MS,
  ACCOUNT_ACTION_DELIVERY_SAFETY_SWEEP_MS,
  type AccountActionDeliverySchedulerDependencies,
} from "../../server/services/account-action-delivery-scheduler";

const START = new Date("2030-01-01T00:00:00.000Z");

function dependencies(
  findNextDueAt: AccountActionDeliverySchedulerDependencies["findNextDueAt"],
): AccountActionDeliverySchedulerDependencies {
  return {
    findNextDueAt,
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    log: { info: vi.fn(), error: vi.fn() },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountActionDeliveryScheduler", () => {
  it("keeps an empty queue idle while retaining a bounded recovery sweep", async () => {
    const findNextDueAt = vi.fn().mockResolvedValue(null);
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AccountActionDeliveryScheduler(dependencies(findNextDueAt));

    await scheduler.start(runSweep);
    expect(findNextDueAt).toHaveBeenCalledTimes(1);
    expect(runSweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ACCOUNT_ACTION_DELIVERY_SAFETY_SWEEP_MS);
    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(findNextDueAt).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("runs due work and schedules from the durable queue again", async () => {
    const findNextDueAt = vi.fn()
      .mockResolvedValueOnce(new Date(START.getTime() + 60_000))
      .mockResolvedValueOnce(null);
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AccountActionDeliveryScheduler(dependencies(findNextDueAt));

    await scheduler.start(runSweep);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runSweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(findNextDueAt).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("moves a future wakeup earlier after a durable enqueue notification", async () => {
    const findNextDueAt = vi.fn()
      .mockResolvedValueOnce(new Date(START.getTime() + 5 * 60_000))
      .mockResolvedValueOnce(new Date(START.getTime() + 60_000))
      .mockResolvedValueOnce(null);
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AccountActionDeliveryScheduler(dependencies(findNextDueAt));

    await scheduler.start(runSweep);
    scheduler.notifyChanged();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(findNextDueAt).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("retries a failed lookup and a failed sweep on bounded timers", async () => {
    const findNextDueAt = vi.fn()
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const runSweep = vi.fn()
      .mockRejectedValueOnce(new Error("temporary worker outage"))
      .mockResolvedValue(undefined);
    const scheduler = new AccountActionDeliveryScheduler(dependencies(findNextDueAt));

    await scheduler.start(runSweep);
    await vi.advanceTimersByTimeAsync(ACCOUNT_ACTION_DELIVERY_LOOKUP_RETRY_MS);
    expect(findNextDueAt).toHaveBeenCalledTimes(2);
    expect(runSweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ACCOUNT_ACTION_DELIVERY_SAFETY_SWEEP_MS);
    expect(runSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ACCOUNT_ACTION_DELIVERY_EXECUTION_RETRY_MS);
    expect(findNextDueAt).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("cancels a scheduled callback on stop", async () => {
    const findNextDueAt = vi.fn().mockResolvedValue(new Date(START.getTime() + 60_000));
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AccountActionDeliveryScheduler(dependencies(findNextDueAt));

    await scheduler.start(runSweep);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runSweep).not.toHaveBeenCalled();
    expect(findNextDueAt).toHaveBeenCalledTimes(1);
  });
});
