import type { ScheduledPaymentExecutionMode } from "../config";
import type { PaymentOperationWake } from "../storage/payment-operations";

const MAX_TIMER_DELAY_MS = 2_147_000_000;
type PaymentOperationTimer = ReturnType<typeof setTimeout>;
type PaymentOperationSetTimeout = (
  callback: () => void,
  delayMs: number,
) => PaymentOperationTimer;
type PaymentOperationClearTimeout = (timer: PaymentOperationTimer) => void;

export interface PaymentOperationWakeSchedulerDependencies<TWake extends { kind: string; dueAt: string } = PaymentOperationWake> {
  loadNextWake: () => Promise<TWake | undefined>;
  handleWake: (wake: TWake) => Promise<{ retryAfterMs?: number } | void>;
  now?: () => Date;
  setTimeoutFn?: PaymentOperationSetTimeout;
  clearTimeoutFn?: PaymentOperationClearTimeout;
  log?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

function wakeContext(input: unknown): Record<string, unknown> {
  const wake = input as { kind?: string; organizationId?: number; operationId?: string; operationType?: string; status?: string; attemptCount?: number; leagueId?: number; d2PlanId?: string; paymentScheduleId?: number };
  return wake.kind === "operation"
    ? {
      workKind: wake.kind,
      organizationId: wake.organizationId,
      operationId: wake.operationId,
      operationType: wake.operationType,
      status: wake.status,
      attemptCount: wake.attemptCount,
    }
    : wake.kind === "canonical_plan" ? {
      workKind: wake.kind,
      organizationId: wake.organizationId,
      leagueId: wake.leagueId,
      d2PlanId: wake.d2PlanId,
    } : {
      workKind: wake.kind,
      organizationId: wake.organizationId,
      paymentScheduleId: wake.paymentScheduleId,
    };
}

/** Exactly one wake for the earliest durable schedule or operation work. */
export class PaymentOperationWakeScheduler<TWake extends { kind: string; dueAt: string } = PaymentOperationWake> {
  private readonly now: () => Date;
  private readonly setTimeoutFn: PaymentOperationSetTimeout;
  private readonly clearTimeoutFn: PaymentOperationClearTimeout;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private mode: ScheduledPaymentExecutionMode = "legacy";
  private armPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: PaymentOperationWakeSchedulerDependencies<TWake>) {
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

  private async arm(previousDueSignature: string | undefined, minimumDelayMs = 0): Promise<void> {
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
        ...wakeContext(wake),
      });
      return;
    }
    const signature = `${wake.kind}:${"operationId" in wake ? wake.operationId : "consentId" in wake ? wake.consentId : "work"}:${dueMs}`;
    if (minimumDelayMs <= 0 && signature === previousDueSignature && dueMs <= this.now().getTime()) {
      // A handler must commit a state transition before returning. Refusing to
      // re-arm the identical overdue row prevents a malformed handler or a
      // paused executor from becoming a database hot loop.
      this.dependencies.log?.error("Payment operation wake made no durable progress; scheduler stopped", {
        ...wakeContext(wake),
      });
      return;
    }

    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(minimumDelayMs, dueMs - this.now().getTime(), 0),
    );
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.fire(wake, signature, generation);
    }, delayMs);
    this.dependencies.log?.info("Scheduled payment ledger wake armed", {
      ...wakeContext(wake),
      dueAt: wake.dueAt,
      delayMs,
    });
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private async fire(
    wake: TWake,
    signature: string,
    generation: number,
  ): Promise<void> {
    if (this.mode !== "ledger_execute" || generation !== this.generation) return;
    let retryAfterMs = 0;
    try {
      const result = await this.dependencies.handleWake(wake);
      retryAfterMs = Math.max(0, result?.retryAfterMs ?? 0);
    } catch (error) {
      this.dependencies.log?.error("Payment operation wake handler failed", {
        ...wakeContext(wake),
        name: error instanceof Error ? error.name : "UnknownError",
      });
      // A transient preparation or execution failure must not strand overdue
      // work, but this is a one-shot retry only after real due work—not an
      // empty database sweep.
      retryAfterMs = 60_000;
    }
    if (this.mode !== "ledger_execute" || generation !== this.generation) return;
    await this.arm(signature, retryAfterMs);
  }
}
