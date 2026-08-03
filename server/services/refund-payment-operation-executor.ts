import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { PAYMENT_OPERATION_MAX_ATTEMPTS, PAYMENT_OPERATION_MAX_LEASE_MS, type PaymentOperation } from "@shared/schema";
import {
  acquirePaymentOperationLease,
  finalizeRefundPaymentOperationSuccess,
  getPaymentOperationForOrganization,
  getRefundPaymentOperationSnapshotForOrganization,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  recordPaymentOperationReconciliationRequired,
  schedulePaymentOperationRetry,
} from "../storage/payment-operations.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  sanitizeProviderErrorCode,
  type PaymentProviderFailureDisposition,
} from "./payment-errors.js";
import type { PaymentProvider, RefundResult } from "./payment-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("RefundPaymentLedger");
const LEASE_MS = Math.min(2 * 60_000, PAYMENT_OPERATION_MAX_LEASE_MS);
const DEFAULT_LEASE_OWNER = (`refund:${hostname()}:${process.pid}:${randomUUID()}`).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
const PENDING_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000, 3 * 86_400_000, 10 * 86_400_000];

function retryAt(attemptCount: number, now: Date): Date {
  const delay = Math.min(6 * 3_600_000, 60_000 * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + delay);
}

function pendingCheckAt(attemptCount: number, now: Date): Date {
  const index = Math.min(Math.max(0, attemptCount - 1), PENDING_DELAYS_MS.length - 1);
  return new Date(now.getTime() + (PENDING_DELAYS_MS[index] ?? PENDING_DELAYS_MS[0]));
}

function disposition(error: unknown, dispatched: boolean): PaymentProviderFailureDisposition {
  if (error instanceof PaymentProviderError) return error.disposition;
  if (error instanceof ProviderNotConfiguredError) return "configuration";
  return dispatched ? "provider_unknown" : "internal";
}

function errorCode(error: unknown): string {
  const raw = error instanceof PaymentProviderError || error instanceof ProviderNotConfiguredError
    ? error.providerCode
    : "PROVIDER_UNKNOWN";
  return sanitizeProviderErrorCode(raw, "REFUND_ERROR");
}

export interface RefundPaymentOperationExecutorDependencies {
  now?: () => Date;
  leaseOwner?: string;
  getProvider?: typeof getPaymentProvider;
  finalizeSuccess?: typeof finalizeRefundPaymentOperationSuccess;
}

export class RefundPaymentOperationExecutor {
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly getProvider: typeof getPaymentProvider;
  private readonly finalizeSuccess: typeof finalizeRefundPaymentOperationSuccess;

  constructor(dependencies: RefundPaymentOperationExecutorDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseOwner = dependencies.leaseOwner ?? DEFAULT_LEASE_OWNER;
    this.getProvider = dependencies.getProvider ?? getPaymentProvider;
    this.finalizeSuccess = dependencies.finalizeSuccess ?? finalizeRefundPaymentOperationSuccess;
  }

  async execute(input: { organizationId: number; operationId: string; now?: Date }): Promise<PaymentOperation | undefined> {
    const now = input.now ?? this.now();
    const operation = await acquirePaymentOperationLease({
      organizationId: input.organizationId,
      operationId: input.operationId,
      leaseOwner: this.leaseOwner,
      leaseDurationMs: LEASE_MS,
      now,
    });
    if (!operation?.leaseToken) return getPaymentOperationForOrganization(input.organizationId, input.operationId);
    return this.executeLeased(operation);
  }

  private async executeLeased(operation: PaymentOperation): Promise<PaymentOperation> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased refund operation has no fencing token");
    const snapshot = await getRefundPaymentOperationSnapshotForOrganization(operation.organizationId, operation.id);
    if (
      !snapshot
      || operation.operationType !== "refund"
      || snapshot.organizationId !== operation.organizationId
      || snapshot.amountMinor !== operation.amountMinor
      || snapshot.currency !== operation.currency
      || snapshot.providerName !== operation.providerName
    ) {
      return recordPaymentOperationFailedTerminal({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        errorClassification: "internal",
        errorCode: "SNAPSHOT_INVALID",
        now: this.now(),
      });
    }

    let provider: PaymentProvider;
    try {
      provider = await this.getProvider(snapshot.locationId);
      if (provider.providerName !== snapshot.providerName || provider.locationId !== snapshot.locationId) {
        throw new PaymentProviderError("Refund request is invalid.", "INVALID_REQUEST", undefined, {
          disposition: "invalid_request",
          providerCode: "SNAPSHOT_PROVIDER_MISMATCH",
        });
      }
    } catch (error) {
      return this.recordFailure(operation, error, false);
    }

    let result: RefundResult;
    try {
      if (operation.providerObjectId) {
        if (!provider.getRefund) {
          throw new PaymentProviderError("Refund status could not be confirmed.", "REFUND_STATUS_UNAVAILABLE", undefined, {
            disposition: "provider_unknown",
            providerCode: "REFUND_STATUS_UNAVAILABLE",
          });
        }
        result = await provider.getRefund(operation.providerObjectId);
      } else {
        result = await provider.refundPayment(
          snapshot.providerPaymentId,
          snapshot.amountMinor,
          snapshot.reason,
          operation.providerIdempotencyKey,
        );
      }
    } catch (error) {
      return this.recordFailure(operation, error, true);
    }

    if (!result.refundId) {
      return this.recordFailure(operation, new PaymentProviderError("Refund outcome could not be confirmed.", "MISSING_REFUND_ID", undefined, {
        disposition: "provider_unknown",
        providerCode: "MISSING_REFUND_ID",
      }), true);
    }
    if (operation.providerObjectId && result.refundId !== operation.providerObjectId) {
      return this.recordFailure(operation, new PaymentProviderError("Refund status could not be confirmed.", "REFUND_ID_MISMATCH", undefined, {
        disposition: "provider_unknown",
        providerCode: "REFUND_ID_MISMATCH",
      }), true, operation.providerObjectId);
    }
    const status = result.status.toUpperCase();
    if (status === "PENDING") return this.recordPending(operation, result.refundId);
    if (status === "REJECTED" || status === "FAILED") {
      return recordPaymentOperationFailedTerminal({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        providerObjectId: result.refundId,
        errorClassification: "invalid_request",
        errorCode: status === "REJECTED" ? "REFUND_REJECTED" : "REFUND_FAILED",
        now: this.now(),
      });
    }
    if (status !== "COMPLETED") {
      return this.recordFailure(operation, new PaymentProviderError("Refund outcome could not be confirmed.", "REFUND_STATUS_UNKNOWN", undefined, {
        disposition: "provider_unknown",
        providerCode: "REFUND_STATUS_UNKNOWN",
      }), true, result.refundId);
    }

    try {
      return (await this.finalizeSuccess({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        providerObjectId: result.refundId,
        now: this.now(),
      })).operation;
    } catch (error) {
      log.error("Refund local finalization failed; lease retained for same-key recovery", {
        organizationId: operation.organizationId,
        operationId: operation.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  private async recordPending(operation: PaymentOperation, refundId: string): Promise<PaymentOperation> {
    if (!operation.leaseToken) throw new Error("leased refund operation has no fencing token");
    if (operation.attemptCount >= PAYMENT_OPERATION_MAX_ATTEMPTS) {
      return recordPaymentOperationReconciliationRequired({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken: operation.leaseToken,
        providerObjectId: refundId,
        errorCode: "REFUND_PENDING_BEYOND_RECOVERY_WINDOW",
        now: this.now(),
      });
    }
    return schedulePaymentOperationRetry({
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken: operation.leaseToken,
      providerObjectId: refundId,
      nextAttemptAt: pendingCheckAt(operation.attemptCount, this.now()),
      errorClassification: "transient",
      errorCode: "REFUND_PENDING",
      now: this.now(),
    });
  }

  private async recordFailure(
    operation: PaymentOperation,
    error: unknown,
    dispatched: boolean,
    providerObjectId = operation.providerObjectId ?? undefined,
  ): Promise<PaymentOperation> {
    if (!operation.leaseToken) throw new Error("leased refund operation has no fencing token");
    const kind = disposition(error, dispatched);
    const common = {
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken: operation.leaseToken,
      providerObjectId,
      errorCode: errorCode(error),
      now: this.now(),
    };
    // Once Square has returned a refund ID, only a definite Square refund
    // status may terminalize the operation. Provider/configuration failures
    // while checking that ID remain recoverable, then require reconciliation.
    if (providerObjectId) {
      if (operation.attemptCount >= PAYMENT_OPERATION_MAX_ATTEMPTS) {
        return recordPaymentOperationReconciliationRequired({
          ...common,
          errorCode: "REFUND_STATUS_UNRESOLVED",
        });
      }
      return recordPaymentOperationProviderUnknown({
        ...common,
        recoveryAt: retryAt(operation.attemptCount, common.now),
      });
    }
    // Exhausting any provider call whose effect cannot be proved absent is
    // reconciliation work, never a confirmed refund failure.
    if (dispatched && operation.attemptCount >= PAYMENT_OPERATION_MAX_ATTEMPTS) {
      return recordPaymentOperationReconciliationRequired({
        ...common,
        errorCode: "PROVIDER_OUTCOME_UNCERTAIN",
      });
    }
    if (kind === "provider_unknown") return recordPaymentOperationProviderUnknown({
      ...common,
      recoveryAt: retryAt(operation.attemptCount, common.now),
    });
    if (kind === "transient") return schedulePaymentOperationRetry({
      ...common,
      nextAttemptAt: retryAt(operation.attemptCount, common.now),
      errorClassification: "transient",
    });
    if (kind === "action_required") return recordPaymentOperationActionRequired(common);
    return recordPaymentOperationFailedTerminal({ ...common, errorClassification: kind });
  }
}

export const refundPaymentOperationExecutor = new RefundPaymentOperationExecutor();
