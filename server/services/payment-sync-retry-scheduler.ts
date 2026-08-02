import { and, asc, isNotNull, lt } from 'drizzle-orm';
import { bowlers, PAYMENT_SYNC_MAX_ATTEMPTS } from '@shared/schema';
import { db } from '../db';
import { createLogger } from '../logger';

const log = createLogger('PaymentSyncRetryScheduler');

export const PAYMENT_SYNC_LOOKUP_RETRY_MS = 60_000;
export const PAYMENT_SYNC_EXECUTION_RETRY_MS = 60_000;

type RetrySweepRunner = () => Promise<unknown>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface PaymentSyncRetrySchedulerDeps {
  findNextRetryAt: () => Promise<Date | null>;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
}

const defaultDeps: PaymentSyncRetrySchedulerDeps = {
  findNextRetryAt: async () => {
    const [next] = await db
      .select({ nextRetryAt: bowlers.paymentSyncNextRetryAt })
      .from(bowlers)
      .where(and(
        isNotNull(bowlers.paymentSyncPendingAt),
        isNotNull(bowlers.paymentSyncNextRetryAt),
        lt(bowlers.paymentSyncAttempts, PAYMENT_SYNC_MAX_ATTEMPTS),
      ))
      .orderBy(asc(bowlers.paymentSyncNextRetryAt))
      .limit(1);

    if (!next?.nextRetryAt) return null;
    const parsed = new Date(next.nextRetryAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Earliest payment-sync retry has an invalid due timestamp');
    }
    return parsed;
  },
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * Process-local, one-shot timer for the durable payment-sync queue.
 * PostgreSQL is the source of truth; this class only remembers when the next
 * indexed lookup says the process should wake.
 */
export class PaymentSyncRetryScheduler {
  private active = false;
  private timer: TimerHandle | null = null;
  private runner: RetrySweepRunner | null = null;
  private sweepInFlight = false;
  private refreshInFlight: Promise<void> | null = null;
  private refreshRequested = false;

  constructor(private readonly deps: PaymentSyncRetrySchedulerDeps = defaultDeps) {}

  async start(runner: RetrySweepRunner): Promise<void> {
    this.stop();
    this.active = true;
    this.runner = runner;
    log.info('Starting next-due payment-sync retry scheduler', {
      maxAttempts: PAYMENT_SYNC_MAX_ATTEMPTS,
    });
    await this.refresh();
  }

  stop(): void {
    this.active = false;
    this.runner = null;
    this.refreshRequested = false;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
      log.info('Payment-sync retry scheduler stopped');
    }
  }

  /** Coalesces concurrent foreground state changes into one indexed lookup. */
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.refreshInFlight !== null) {
      this.refreshRequested = true;
      return this.refreshInFlight;
    }

    let currentPromise: Promise<void>;
    currentPromise = (async () => {
      do {
        this.refreshRequested = false;
        await this.refreshOnce();
      } while (this.active && this.refreshRequested);
    })().finally(() => {
      if (this.refreshInFlight === currentPromise) {
        this.refreshInFlight = null;
      }
    });
    this.refreshInFlight = currentPromise;
    return currentPromise;
  }

  notifyChanged(): void {
    if (!this.active) return;
    if (this.sweepInFlight) {
      // The sweep's finally block always refreshes after every candidate has
      // settled, so foreground-style notifications emitted by the sync helper
      // during the sweep need no per-row database lookup.
      this.refreshRequested = true;
      return;
    }
    void this.refresh();
  }

  private async refreshOnce(): Promise<void> {
    try {
      const nextRetryAt = await this.deps.findNextRetryAt();
      if (!this.active) return;
      if (nextRetryAt === null) {
        this.clearArmedTimer();
        return;
      }
      this.armAt(nextRetryAt.getTime(), () => this.runDueSweep());
    } catch (error) {
      if (!this.active) return;
      log.error('Failed to determine next payment-sync retry', {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
      });
      // A failed lookup is not an empty queue. Retry the lookup once via a
      // one-shot timer; a successful empty lookup clears it permanently.
      this.armAt(
        this.deps.now() + PAYMENT_SYNC_LOOKUP_RETRY_MS,
        () => this.refresh(),
      );
    }
  }

  private clearArmedTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private armAt(targetAtMs: number, callback: () => Promise<void>): void {
    this.clearArmedTimer();
    const delayMs = Math.max(0, targetAtMs - this.deps.now());
    let handle: TimerHandle;
    handle = this.deps.setTimer(() => {
      if (this.timer === handle) this.timer = null;
      void callback();
    }, delayMs);
    this.timer = handle;
    if (handle && typeof handle === 'object' && 'unref' in handle) {
      handle.unref();
    }
  }

  private async runDueSweep(): Promise<void> {
    if (!this.active || this.runner === null) return;
    if (this.sweepInFlight) {
      await this.refresh();
      return;
    }

    this.sweepInFlight = true;
    let executionFailed = false;
    try {
      await this.runner();
    } catch (error) {
      executionFailed = true;
      log.error('Payment-sync retry execution failed', {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
      });
    } finally {
      this.sweepInFlight = false;
      if (executionFailed && this.active) {
        // Avoid a zero-delay loop if the due row remains unchanged after an
        // execution failure. This remains a one-shot recovery timer.
        this.armAt(
          this.deps.now() + PAYMENT_SYNC_EXECUTION_RETRY_MS,
          () => this.refresh(),
        );
      } else {
        await this.refresh();
      }
    }
  }
}

const scheduler = new PaymentSyncRetryScheduler();

export function startPaymentSyncRetryScheduler(runner: RetrySweepRunner): Promise<void> {
  return scheduler.start(runner);
}

export function stopPaymentSyncRetryScheduler(): void {
  scheduler.stop();
}

/**
 * Signal that foreground work created, moved, cleared, or parked a durable
 * retry. The active process performs one indexed lookup; no timer is created
 * when the queue is empty.
 */
export function notifyPaymentSyncRetryChanged(): void {
  scheduler.notifyChanged();
}
