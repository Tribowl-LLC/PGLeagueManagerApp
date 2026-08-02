import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PaymentSyncRetryScheduler,
  type PaymentSyncRetrySchedulerDeps,
} from '../../server/services/payment-sync-retry-scheduler';

const START = new Date('2026-08-01T12:00:00.000Z');

function deps(findNextRetryAt: PaymentSyncRetrySchedulerDeps['findNextRetryAt']): PaymentSyncRetrySchedulerDeps {
  return {
    findNextRetryAt,
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PaymentSyncRetryScheduler', () => {
  it('queries once at startup and performs no empty polling or timer work', async () => {
    const findNextRetryAt = vi.fn().mockResolvedValue(null);
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PaymentSyncRetryScheduler(deps(findNextRetryAt));

    await scheduler.start(runSweep);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(findNextRetryAt).toHaveBeenCalledTimes(1);
    expect(runSweep).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('runs a due retry once and then re-arms from durable state', async () => {
    const findNextRetryAt = vi.fn()
      .mockResolvedValueOnce(new Date(START.getTime() + 60_000))
      .mockResolvedValueOnce(null);
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PaymentSyncRetryScheduler(deps(findNextRetryAt));

    await scheduler.start(runSweep);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runSweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(findNextRetryAt).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('moves the timer earlier when foreground work changes the queue', async () => {
    const findNextRetryAt = vi.fn()
      .mockResolvedValueOnce(new Date(START.getTime() + 5 * 60_000))
      .mockResolvedValueOnce(new Date(START.getTime() + 60_000))
      .mockResolvedValueOnce(null);
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PaymentSyncRetryScheduler(deps(findNextRetryAt));

    await scheduler.start(runSweep);
    scheduler.notifyChanged();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(findNextRetryAt).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('recovers a durable pending retry when a replacement process starts', async () => {
    const durableDueAt = new Date(START.getTime() + 30_000);
    const firstLookup = vi.fn().mockResolvedValue(durableDueAt);
    const first = new PaymentSyncRetryScheduler(deps(firstLookup));
    await first.start(vi.fn().mockResolvedValue(undefined));
    first.stop();

    const replacementLookup = vi.fn()
      .mockResolvedValueOnce(durableDueAt)
      .mockResolvedValueOnce(null);
    const replacementRun = vi.fn().mockResolvedValue(undefined);
    const replacement = new PaymentSyncRetryScheduler(deps(replacementLookup));
    await replacement.start(replacementRun);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replacementLookup).toHaveBeenCalledTimes(2);
    expect(replacementRun).toHaveBeenCalledTimes(1);
    replacement.stop();
  });
});
