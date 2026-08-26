import {
  PAYMENT_OPERATION_MAX_ATTEMPTS,
  type PaymentOperation,
} from "@shared/schema";
import type { ScheduledPaymentExecutionMode } from "../config";
import { createLogger } from "../logger";
import {
  getNextPaymentOperationWake,
  recordExpiredPaymentOperationAttemptExhausted,
  type PaymentOperationWake,
} from "../storage/payment-operations";
import { PaymentOperationWakeScheduler } from "./payment-operation-wake-scheduler";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor";
import { refundPaymentOperationExecutor } from "./refund-payment-operation-executor";

const log = createLogger("PaymentOperationLedger");

export interface PaymentOperationRetryExecutorDependencies {
  now?: () => Date;
}

function operationContext(operation: PaymentOperation): Record<string, unknown> {
  return {
    organizationId: operation.organizationId,
    operationId: operation.id,
    status: operation.status,
    attemptCount: operation.attemptCount,
    leaseExpiresAt: operation.leaseExpiresAt,
    nextAttemptAt: operation.nextAttemptAt,
  };
}

/**
 * Wakes durable interactive and refund operations for retry/reconciliation.
 * Scheduled charges and the retired F3 plan executor are deliberately absent:
 * standing autopay has its own consent-scoped executor, and no other payment
 * operation may dispatch a provider charge.
 */
export class PaymentOperationRetryExecutor {
  private readonly now: () => Date;
  private readonly wakeScheduler: PaymentOperationWakeScheduler;

  constructor(dependencies: PaymentOperationRetryExecutorDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.wakeScheduler = new PaymentOperationWakeScheduler({
      loadNextWake: getNextPaymentOperationWake,
      handleWake: (wake) => this.handleWake(wake),
      now: this.now,
      log,
    });
  }

  async start(mode: ScheduledPaymentExecutionMode): Promise<void> {
    await this.wakeScheduler.start(mode);
  }

  stop(): void {
    this.wakeScheduler.stop();
  }

  async rearm(): Promise<void> {
    await this.wakeScheduler.rearm();
  }

  async handleWake(wake: PaymentOperationWake): Promise<{ retryAfterMs?: number } | void> {
    if (wake.status === "leased" && wake.attemptCount >= PAYMENT_OPERATION_MAX_ATTEMPTS) {
      const reconciled = await recordExpiredPaymentOperationAttemptExhausted({
        organizationId: wake.organizationId,
        operationId: wake.operationId,
        now: this.now(),
      });
      if (reconciled) {
        log.error("Payment operation requires provider reconciliation after an expired lease", {
          ...operationContext(reconciled),
          leaseRecoveryCount: reconciled.leaseRecoveryCount,
        });
      }
      return;
    }

    if (wake.operationType === "interactive_charge") {
      await interactivePaymentOperationExecutor.execute({
        organizationId: wake.organizationId,
        operationId: wake.operationId,
        now: this.now(),
      });
      return;
    }
    if (wake.operationType === "refund") {
      await refundPaymentOperationExecutor.execute({
        organizationId: wake.organizationId,
        operationId: wake.operationId,
        now: this.now(),
      });
      return;
    }

    // The wake query excludes standing-autopay operations and all retired
    // scheduled work. Keep this guard fail-closed if a malformed row appears.
    log.error("Unsupported payment operation reached the general executor", {
      organizationId: wake.organizationId,
      operationId: wake.operationId,
      operationType: wake.operationType,
    });
  }
}

export const paymentOperationRetryExecutor = new PaymentOperationRetryExecutor();
