import type { ScheduledPaymentExecutionMode } from "../config";
import type { PaymentOperationWake } from "../storage/payment-operations";

const MAX_TIMER_DELAY_MS = 2_147_000_000;
type PaymentOperationTimer = ReturnType<typeof setTimeout>;
type PaymentOperationSetTimeout = (
  callback: () => void,
  delayMs: number,
) => PaymentOperationTimer;
type PaymentOperationClearTimeout = (timer: PaymentOperationTimer) => void;

export interface PaymentOperationWakeSchedulerDependencies {
  loadNextWake: () => Promise<PaymentOperationWake | undefined>;
  handleWake: (wake: PaymentOperationWake) => Promise<void>;
  now?: () => Date;
  setTimeoutFn?: PaymentOperationSetTimeout;
  clearTimeoutFn?: PaymentOperationClearTimeout;
  log?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Dormant Phase 2B-1 one-shot wake infrastructure. Nothing constructs or
 * starts this class in production yet. Phase 2B-2 will wire it only after the
 * schedule cutover and provider-call gate are reviewed.
 */
export class PaymentOperationWakeScheduler {
  private readonly now: () => Date;
  private readonly setTimeoutFn: PaymentOperationSetTimeout;
  private readonly clearTimeoutFn: PaymentOperationClearTimeout;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private mode: ScheduledPaymentExecutionMode = "legacy";
  private armPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: PaymentOperationWakeSchedulerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.setTimeoutFn = dependencies.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = dependencies.clearTimeoutFn ?? clearTimeout;
  }

  async start(mode: ScheduledPaymentExecutionMode): Promise<void> {
    this.stop();
    this.mode = mode;
    if (mode !== "ledger_execute") {
      this.dependencies.log?.info("Payment operation wake scheduler remains dormant", { mode });
      return;
    }
    await this.rearm();
  }

  stop(): void {
    this.generation += 1;
    this.mode = "legacy";
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  /** Re-query after durable operation creation or a committed transition. */
  async rearm(): Promise<void> {
    if (this.mode !== "ledger_execute") return;
    if (this.armPromise !== null) return this.armPromise;
    this.armPromise = this.arm(undefined).finally(() => {
      this.armPromise = null;
    });
    return this.armPromise;
  }

  private async arm(previousDueSignature: string | undefined): Promise<void> {
    if (this.mode !== "ledger_execute") return;
    const generation = ++this.generation;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }

    const wake = await this.dependencies.loadNextWake();
    if (this.mode !== "ledger_execute" || generation !== this.generation || !wake) return;

    const dueMs = new Date(wake.dueAt).getTime();
    if (!Number.isFinite(dueMs)) {
      this.dependencies.log?.error("Payment operation wake has an invalid due timestamp", {
        operationId: wake.operationId,
      });
      return;
    }
    const signature = `${wake.operationId}:${wake.status}:${wake.attemptCount}:${dueMs}`;
    if (signature === previousDueSignature && dueMs <= this.now().getTime()) {
      // A handler must commit a state transition before returning. Refusing to
      // re-arm the identical overdue row prevents a malformed handler or a
      // paused executor from becoming a database hot loop.
      this.dependencies.log?.error("Payment operation wake made no durable progress; scheduler stopped", {
        operationId: wake.operationId,
        status: wake.status,
        attemptCount: wake.attemptCount,
      });
      return;
    }

    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, dueMs - this.now().getTime()),
    );
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.fire(wake, signature, generation);
    }, delayMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private async fire(
    wake: PaymentOperationWake,
    signature: string,
    generation: number,
  ): Promise<void> {
    if (this.mode !== "ledger_execute" || generation !== this.generation) return;
    try {
      await this.dependencies.handleWake(wake);
    } catch (error) {
      this.dependencies.log?.error("Payment operation wake handler failed", {
        operationId: wake.operationId,
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
    if (this.mode !== "ledger_execute" || generation !== this.generation) return;
    await this.arm(signature);
  }
}
