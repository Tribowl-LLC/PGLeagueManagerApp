import { createLogger } from "../logger.js";
import { getNextPasswordResetDeliveryAt } from "../storage/account-action-delivery-jobs.js";

const log = createLogger("AccountActionDeliveryScheduler");

export const ACCOUNT_ACTION_DELIVERY_LOOKUP_RETRY_MS = 60_000;
export const ACCOUNT_ACTION_DELIVERY_EXECUTION_RETRY_MS = 60_000;
/** Also wakes an otherwise idle instance to recover an expired lease. */
export const ACCOUNT_ACTION_DELIVERY_SAFETY_SWEEP_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface AccountActionDeliverySchedulerDependencies {
  findNextDueAt: () => Promise<Date | null>;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
  log?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

const defaultDependencies: AccountActionDeliverySchedulerDependencies = {
  findNextDueAt: getNextPasswordResetDeliveryAt,
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  log,
};

type SchedulerRunner = () => Promise<unknown>;

/**
 * Process-local one-shot wakeup for the durable delivery queue. PostgreSQL is
 * authoritative; this timer only avoids polling an empty queue and can be
 * recreated by every app instance after a restart.
 */
export class AccountActionDeliveryScheduler {
  private active = false;
  private timer: TimerHandle | null = null;
  private runner: SchedulerRunner | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshRequested = false;
  private sweepInFlight = false;

  constructor(private readonly dependencies: AccountActionDeliverySchedulerDependencies = defaultDependencies) {}

  async start(runner: SchedulerRunner): Promise<void> {
    this.stop();
    this.active = true;
    this.runner = runner;
    this.dependencies.log?.info("Starting account-action delivery scheduler");
    await this.refresh();
  }

  stop(): void {
    this.active = false;
    this.runner = null;
    this.refreshRequested = false;
    if (this.timer !== null) {
      this.dependencies.clearTimer(this.timer);
      this.timer = null;
      this.dependencies.log?.info("Account-action delivery scheduler stopped");
    }
  }

  notifyChanged(): void {
    if (!this.active) return;
    if (this.sweepInFlight) {
      this.refreshRequested = true;
      return;
    }
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.refreshInFlight !== null) {
      this.refreshRequested = true;
      return this.refreshInFlight;
    }
    let current: Promise<void>;
    current = (async () => {
      do {
        this.refreshRequested = false;
        await this.refreshOnce();
      } while (this.active && this.refreshRequested);
    })().finally(() => {
      if (this.refreshInFlight === current) this.refreshInFlight = null;
    });
    this.refreshInFlight = current;
    return current;
  }

  private async refreshOnce(): Promise<void> {
    try {
      const nextDueAt = await this.dependencies.findNextDueAt();
      if (!this.active) return;
      if (nextDueAt === null) {
        this.armAt(
          this.dependencies.now() + ACCOUNT_ACTION_DELIVERY_SAFETY_SWEEP_MS,
          () => this.runDueSweep(),
        );
        return;
      }
      const dueMs = nextDueAt.getTime();
      if (!Number.isFinite(dueMs)) throw new Error("Invalid account-action delivery due timestamp");
      // Bound the recovery interval even when the next retry is far in the
      // future. This lets any instance recover a dead sibling's lease without
      // relying on the process that enqueued the intent to wake successfully.
      this.armAt(
        Math.min(dueMs, this.dependencies.now() + ACCOUNT_ACTION_DELIVERY_SAFETY_SWEEP_MS),
        () => this.runDueSweep(),
      );
    } catch (error) {
      if (!this.active) return;
      this.dependencies.log?.error("Failed to determine next account-action delivery", {
        errorCode: error instanceof Error ? error.name : "lookup_error",
      });
      this.armAt(this.dependencies.now() + ACCOUNT_ACTION_DELIVERY_LOOKUP_RETRY_MS, () => this.refresh());
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.dependencies.clearTimer(this.timer);
    this.timer = null;
  }

  private armAt(targetAtMs: number, callback: () => Promise<void>): void {
    this.clearTimer();
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, targetAtMs - this.dependencies.now()),
    );
    let handle: TimerHandle;
    handle = this.dependencies.setTimer(() => {
      if (this.timer === handle) this.timer = null;
      void callback();
    }, delayMs);
    this.timer = handle;
    if (handle && typeof handle === "object" && "unref" in handle) handle.unref();
  }

  private async runDueSweep(): Promise<void> {
    if (!this.active || this.runner === null) return;
    if (this.sweepInFlight) {
      await this.refresh();
      return;
    }
    this.sweepInFlight = true;
    let failed = false;
    try {
      await this.runner();
    } catch (error) {
      failed = true;
      this.dependencies.log?.error("Account-action delivery sweep failed", {
        errorCode: error instanceof Error ? error.name : "execution_error",
      });
    } finally {
      this.sweepInFlight = false;
      if (this.active) {
        if (failed) {
          this.armAt(
            this.dependencies.now() + ACCOUNT_ACTION_DELIVERY_EXECUTION_RETRY_MS,
            () => this.refresh(),
          );
        } else {
          await this.refresh();
        }
      }
    }
  }
}

const scheduler = new AccountActionDeliveryScheduler();

export function startAccountActionDeliveryScheduler(runner: SchedulerRunner): Promise<void> {
  return scheduler.start(runner);
}

export function stopAccountActionDeliveryScheduler(): void {
  scheduler.stop();
}

export function notifyAccountActionDeliveryChanged(): void {
  scheduler.notifyChanged();
}
