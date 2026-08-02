import { describe, expect, it, vi } from 'vitest';
import { PaymentOperationWakeScheduler } from '../../server/services/payment-operation-wake-scheduler';
import type { PaymentOperationWake } from '../../server/storage/payment-operations';

const wake: Extract<PaymentOperationWake, { kind: 'operation' }> = {
  kind: 'operation',
  operationId: '00000000-0000-4000-8000-000000000001',
  organizationId: 1,
  operationType: 'scheduled_charge',
  status: 'pending',
  attemptCount: 0,
  dueAt: '2032-01-01T00:00:10.000Z',
};

describe('scheduled ledger one-shot wake scheduler', () => {
  it.each(['legacy', 'ledger_paused'] as const)(
    '%s performs no queue query and creates no timer',
    async (mode) => {
      const loadNextWake = vi.fn();
      const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) =>
        setTimeout(callback, delayMs));
      const scheduler = new PaymentOperationWakeScheduler({
        loadNextWake,
        handleWake: vi.fn(),
        setTimeoutFn,
      });

      await scheduler.start(mode);
      await scheduler.rearm();

      expect(loadNextWake).not.toHaveBeenCalled();
      expect(setTimeoutFn).not.toHaveBeenCalled();
    },
  );

  it('arms only the earliest returned work and remains idle for an empty queue', async () => {
    const loadNextWake = vi.fn()
      .mockResolvedValueOnce(wake)
      .mockResolvedValueOnce(undefined);
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs));
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake,
      handleWake: vi.fn(),
      now: () => new Date('2032-01-01T00:00:00.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
    });

    await scheduler.start('ledger_execute');
    expect(loadNextWake).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 10_000);

    await scheduler.rearm();
    expect(loadNextWake).toHaveBeenCalledTimes(2);
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('arms future schedule preparation even when there are no operations', async () => {
    const scheduleWake: PaymentOperationWake = {
      kind: 'schedule',
      organizationId: 8,
      paymentScheduleId: 44,
      dueAt: '2032-01-01T00:00:30.000Z',
    };
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs));
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake: vi.fn().mockResolvedValue(scheduleWake),
      handleWake: vi.fn(),
      now: () => new Date('2032-01-01T00:00:00.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
    });

    await scheduler.start('ledger_execute');
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 30_000);
    scheduler.stop();
  });

  it('clamps a long future wake to a safe JavaScript timer delay', async () => {
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs));
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake: vi.fn().mockResolvedValue({
        ...wake,
        dueAt: '2033-01-01T00:00:00.000Z',
      }),
      handleWake: vi.fn(),
      now: () => new Date('2032-01-01T00:00:00.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
    });

    await scheduler.start('ledger_execute');
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 2_147_000_000);
    scheduler.stop();
  });

  it('cannot be rearmed after stop without a new explicit execute start', async () => {
    const loadNextWake = vi.fn().mockResolvedValue(wake);
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs));
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake,
      handleWake: vi.fn(),
      now: () => new Date('2032-01-01T00:00:00.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
    });

    await scheduler.start('ledger_execute');
    scheduler.stop();
    await scheduler.rearm();

    expect(loadNextWake).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
  });

  it('executes once, then re-queries only after the handler commits progress', async () => {
    const progressed: Extract<PaymentOperationWake, { kind: 'operation' }> = {
      ...wake,
      status: 'retry_scheduled',
      attemptCount: 1,
      dueAt: '2032-01-01T00:01:00.000Z',
    };
    const loadNextWake = vi.fn()
      .mockResolvedValueOnce(wake)
      .mockResolvedValueOnce(progressed);
    let timerCallback: (() => void) | undefined;
    const setTimeoutFn = vi.fn((callback: () => void) => {
      timerCallback = callback;
      return setTimeout(() => undefined, 60_000);
    });
    const handleWake = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake,
      handleWake,
      now: () => new Date('2032-01-01T00:00:10.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
    });

    await scheduler.start('ledger_execute');
    expect(timerCallback).toBeDefined();
    timerCallback?.();
    await vi.waitFor(() => expect(handleWake).toHaveBeenCalledWith(wake));
    await vi.waitFor(() => expect(loadNextWake).toHaveBeenCalledTimes(2));
    expect(setTimeoutFn).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('stops instead of hot-looping when an overdue wake makes no durable progress', async () => {
    const overdue = { ...wake, dueAt: '2031-12-31T23:59:59.000Z' };
    const loadNextWake = vi.fn().mockResolvedValue(overdue);
    let timerCallback: (() => void) | undefined;
    const setTimeoutFn = vi.fn((callback: () => void) => {
      timerCallback = callback;
      return setTimeout(() => undefined, 60_000);
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake,
      handleWake: vi.fn().mockResolvedValue(undefined),
      now: () => new Date('2032-01-01T00:00:00.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
      log,
    });

    await scheduler.start('ledger_execute');
    timerCallback?.();
    await vi.waitFor(() => expect(loadNextWake).toHaveBeenCalledTimes(2));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('no durable progress'),
      expect.objectContaining({ operationId: wake.operationId }),
    );
  });

  it('uses one bounded retry after a due-work handler failure', async () => {
    const overdue = { ...wake, dueAt: '2031-12-31T23:59:59.000Z' };
    const loadNextWake = vi.fn().mockResolvedValue(overdue);
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const setTimeoutFn = vi.fn((callback: () => void, delayMs: number) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return setTimeout(() => undefined, 60_000);
    });
    const scheduler = new PaymentOperationWakeScheduler({
      loadNextWake,
      handleWake: vi.fn().mockRejectedValue(new Error('transient preparation failure')),
      now: () => new Date('2032-01-01T00:00:00.000Z'),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(clearTimeout),
    });

    await scheduler.start('ledger_execute');
    callbacks[0]?.();
    await vi.waitFor(() => expect(setTimeoutFn).toHaveBeenCalledTimes(2));
    expect(delays).toEqual([0, 60_000]);
    scheduler.stop();
  });
});
