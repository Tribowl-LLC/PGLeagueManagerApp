import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  PAYMENT_OPERATION_MAX_ATTEMPTS,
  PAYMENT_OPERATION_MAX_LEASE_MS,
  type PaymentOperation,
} from "@shared/schema";
import { providerNameToPaymentType } from "@shared/schema/constants";
import type { ScheduledPaymentExecutionMode } from "../config";
import { createLogger } from "../logger";
import {
  acquirePaymentOperationLease,
  acquireScheduledPaymentOperationDispatchCutoff,
  finalizePaymentOperationSuccess,
  getNextPaymentOperationWake,
  getPaymentOperationForOrganization,
  getScheduledPaymentOperationSnapshotForOrganization,
  isScheduledPaymentProviderLocationCurrent,
  recordExpiredPaymentOperationAttemptExhausted,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  schedulePaymentOperationRetry,
  type PaymentOperationLinkedPaymentInput,
  type PaymentOperationWake,
} from "../storage/payment-operations";
import type { ScheduledPaymentSemanticSnapshot } from "./scheduled-payment-operation-snapshot";
import { getPaymentProvider } from "./payment-provider-factory";
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  sanitizeProviderErrorCode,
  type PaymentProviderFailureDisposition,
} from "./payment-errors";
import type { PaymentProvider, PaymentResult } from "./payment-provider";
import { PaymentOperationWakeScheduler } from "./payment-operation-wake-scheduler";
import { prepareScheduledPaymentCycle } from "./scheduled-payment-operation-preparation";
import { autopaySetupOperationExecutor } from "./autopay-setup-operation-executor";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor";
import { refundPaymentOperationExecutor } from "./refund-payment-operation-executor";
import { GENERAL_INTERACTIVE_TARGET_PREFIX } from "../storage/payment-operations";

const log = createLogger("ScheduledPaymentLedger");
const LEASE_DURATION_MS = PAYMENT_OPERATION_MAX_LEASE_MS;
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
// Automatic collection is intentionally a PR2 capability. PR1 must not
// dispatch a provider charge from either a legacy schedule or an abandoned
// F3/D2/F4 plan while those authorities are being retired.
const ROSTER_PAYMENT_AUTOPAY_ENABLED = false;

export interface ScheduledPaymentOperationExecutorDependencies {
  now?: () => Date;
  leaseOwner?: string;
  getProvider?: typeof getPaymentProvider;
  finalizeSuccess?: typeof finalizePaymentOperationSuccess;
}

function retryAt(attemptCount: number, now: Date): Date {
  const delay = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + delay);
}

function operationContext(operation: PaymentOperation): Record<string, unknown> {
  return {
    organizationId: operation.organizationId,
    operationId: operation.id,
    scheduleId: operation.paymentScheduleId,
    status: operation.status,
    attemptCount: operation.attemptCount,
    leaseExpiresAt: operation.leaseExpiresAt,
    nextAttemptAt: operation.nextAttemptAt,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PaymentProviderError) return error.providerCode;
  if (error instanceof ProviderNotConfiguredError) return error.providerCode;
  return "PROVIDER_UNKNOWN";
}

function failureDisposition(
  error: unknown,
  providerDispatchStarted: boolean,
): PaymentProviderFailureDisposition {
  if (error instanceof PaymentProviderError) return error.disposition;
  if (error instanceof ProviderNotConfiguredError) return "configuration";
  return providerDispatchStarted ? "provider_unknown" : "internal";
}

function paymentRows(
  snapshot: ScheduledPaymentSemanticSnapshot,
  result: PaymentResult,
  operationId: string,
): PaymentOperationLinkedPaymentInput[] {
  const combinedChargeGroupId = snapshot.allocations.length > 1 ? operationId : null;
  return snapshot.allocations.map((allocation) => ({
    allocationIndex: allocation.allocationIndex,
    values: {
      bowlerId: allocation.bowlerId,
      leagueId: snapshot.leagueId,
      amount: allocation.amountMinor,
      lineageAmount: allocation.lineageAmountMinor,
      prizeFundAmount: allocation.prizeFundAmountMinor,
      weekOf: snapshot.billingCycleAt,
      status: "paid",
      type: providerNameToPaymentType(snapshot.providerName),
      providerPaymentId: result.id,
      receiptUrl: result.receiptUrl,
      receiptNumber: result.receiptNumber,
      receiptEmailMissing: snapshot.providerName === "square" && snapshot.buyerEmail === null,
      notes: allocation.notes,
      paidByUserId: allocation.paidByUserId,
      combinedChargeGroupId,
    },
  }));
}

function payerFailureRow(
  snapshot: ScheduledPaymentSemanticSnapshot,
  errorCode: string,
): PaymentOperationLinkedPaymentInput[] {
  const payer = snapshot.allocations[0];
  if (!payer) return [];
  return [{
    allocationIndex: 0,
    values: {
      bowlerId: payer.bowlerId,
      leagueId: snapshot.leagueId,
      amount: payer.amountMinor,
      lineageAmount: payer.lineageAmountMinor,
      prizeFundAmount: payer.prizeFundAmountMinor,
      weekOf: snapshot.billingCycleAt,
      status: "failed",
      type: providerNameToPaymentType(snapshot.providerName),
      notes: `Scheduled payment failed (${errorCode})`,
      paidByUserId: payer.paidByUserId,
      combinedChargeGroupId: null,
    },
  }];
}

export class ScheduledPaymentOperationExecutor {
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly getProvider: typeof getPaymentProvider;
  private readonly finalizeSuccess: typeof finalizePaymentOperationSuccess;
  private readonly wakeScheduler: PaymentOperationWakeScheduler;

  constructor(dependencies: ScheduledPaymentOperationExecutorDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseOwner = dependencies.leaseOwner
      ?? `scheduled-ledger:${hostname().replace(/[^A-Za-z0-9_.:-]/g, "-")}:${process.pid}:${randomUUID()}`.slice(0, 128);
    this.getProvider = dependencies.getProvider ?? getPaymentProvider;
    this.finalizeSuccess = dependencies.finalizeSuccess ?? finalizePaymentOperationSuccess;
    this.wakeScheduler = new PaymentOperationWakeScheduler({
      loadNextWake: getNextPaymentOperationWake,
      handleWake: (wake) => this.handleWake(wake),
      now: this.now,
      log,
    });
  }

  async start(mode: ScheduledPaymentExecutionMode): Promise<void> {
    if (!ROSTER_PAYMENT_AUTOPAY_ENABLED) {
      log.info("Automatic collection is dormant until PR2", { mode });
      return;
    }
    await this.wakeScheduler.start(mode);
  }

  stop(): void {
    this.wakeScheduler.stop();
  }

  async rearm(): Promise<void> {
    if (!ROSTER_PAYMENT_AUTOPAY_ENABLED) return;
    await this.wakeScheduler.rearm();
  }

  async handleWake(wake: PaymentOperationWake): Promise<{ retryAfterMs?: number } | void> {
    if (!ROSTER_PAYMENT_AUTOPAY_ENABLED) {
      log.info("Automatic collection wake ignored until PR2", { organizationId: wake.organizationId, kind: wake.kind });
      return;
    }
    if (wake.kind === "schedule") {
      const prepared = await prepareScheduledPaymentCycle({
        paymentScheduleId: wake.paymentScheduleId,
        billingCycleAt: wake.dueAt,
        now: this.now(),
      });
      log.info("Scheduled cycle preparation completed", {
        organizationId: wake.organizationId,
        paymentScheduleId: wake.paymentScheduleId,
        result: prepared.kind,
        operationId: "operation" in prepared ? prepared.operation.id : undefined,
      });
      return;
    }

    if (wake.kind === "canonical_plan") {
      log.info("Canonical automatic collection wake ignored until PR2", { organizationId: wake.organizationId, leagueId: wake.leagueId });
      return;
    }

    if (wake.status === "leased" && wake.attemptCount >= PAYMENT_OPERATION_MAX_ATTEMPTS) {
      const reconciled = await recordExpiredPaymentOperationAttemptExhausted({
        organizationId: wake.organizationId,
        operationId: wake.operationId,
        now: this.now(),
      });
      if (reconciled) {
        log.error("Scheduled operation requires provider reconciliation after an expired lease", {
          ...operationContext(reconciled),
          leaseRecoveryCount: reconciled.leaseRecoveryCount,
        });
      }
      return;
    }

    if (wake.operationType === "interactive_charge") {
      const operation = await getPaymentOperationForOrganization(
        wake.organizationId,
        wake.operationId,
      );
      if (operation?.targetKey.startsWith(GENERAL_INTERACTIVE_TARGET_PREFIX)) {
        await interactivePaymentOperationExecutor.execute({
          organizationId: wake.organizationId,
          operationId: wake.operationId,
          now: this.now(),
        });
      } else {
        await autopaySetupOperationExecutor.execute({
          organizationId: wake.organizationId,
          operationId: wake.operationId,
        });
      }
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
    if (wake.operationType === "canonical_autopay_charge") {
      log.info("Canonical automatic collection operation ignored until PR2", { organizationId: wake.organizationId, operationId: wake.operationId });
      return;
    }
    if (wake.operationType !== "scheduled_charge") {
      log.error("Unsupported payment operation type reached the automatic executor", {
        organizationId: wake.organizationId,
        operationId: wake.operationId,
        operationType: wake.operationType,
      });
      return;
    }

    const operation = await acquirePaymentOperationLease({
      organizationId: wake.organizationId,
      operationId: wake.operationId,
      leaseOwner: this.leaseOwner,
      leaseDurationMs: LEASE_DURATION_MS,
      now: this.now(),
    });
    if (!operation?.leaseToken) return;

    log.info("Scheduled operation lease acquired", {
      ...operationContext(operation),
      recovered: operation.leaseRecoveryCount > 0,
      leaseRecoveryCount: operation.leaseRecoveryCount,
    });
    await this.executeLeased(operation);
  }

  private async executeLeased(operation: PaymentOperation): Promise<void> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased scheduled operation has no fencing token");

    let snapshot: ScheduledPaymentSemanticSnapshot;
    try {
      const loaded = await getScheduledPaymentOperationSnapshotForOrganization(
        operation.organizationId,
        operation.id,
      );
      if (!loaded) throw new Error("scheduled operation snapshot is missing");
      if (
        loaded.organizationId !== operation.organizationId
        || loaded.paymentScheduleId !== operation.paymentScheduleId
        || loaded.amountMinor !== operation.amountMinor
        || loaded.currency !== operation.currency
        || loaded.providerName !== operation.providerName
      ) {
        throw new Error("scheduled operation snapshot semantics do not match the operation");
      }
      snapshot = loaded;
    } catch {
      await recordPaymentOperationFailedTerminal({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        now: this.now(),
        errorClassification: "internal",
        errorCode: "SNAPSHOT_INVALID",
      });
      log.error("Scheduled operation snapshot failed closed", operationContext(operation));
      return;
    }

    // Seller-location identity is immutable operation evidence. Resolve the
    // current credential through the same tenant scope before acquiring the
    // dispatch cutoff or obtaining a provider; relocation fails closed with
    // zero provider-side calls.
    if (!(await isScheduledPaymentProviderLocationCurrent({
      organizationId: operation.organizationId,
      locationId: snapshot.locationId,
      providerLocationId: snapshot.providerLocationId,
    }))) {
      await recordPaymentOperationFailedTerminal({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        now: this.now(),
        errorClassification: "invalid_request",
        errorCode: "PROVIDER_LOCATION_DRIFT",
      });
      return;
    }

    let provider: PaymentProvider;
    try {
      provider = await this.getProvider(snapshot.locationId);
      if (
        provider.providerName !== snapshot.providerName
        || provider.locationId !== snapshot.locationId
        || !provider.validateCardId(snapshot.sourceId)
      ) {
        throw new PaymentProviderError(
          "Payment request is invalid.",
          "INVALID_REQUEST",
          undefined,
          { disposition: "invalid_request", providerCode: "SNAPSHOT_PROVIDER_MISMATCH" },
        );
      }
    } catch (error) {
      await this.recordFailure(operation, snapshot, error, false);
      return;
    }

    // Cancellation and dispatch share the league advisory lock. Claim the
    // exact provider window only after all local snapshot checks pass; a
    // cancellation committed first therefore returns here without any
    // provider call, while claim-first remains recoverable by this ledger's
    // existing provider idempotency/reconciliation path.
    if (!(await acquireScheduledPaymentOperationDispatchCutoff({
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken,
      now: this.now(),
    }))) return;

    let result: PaymentResult;
    try {
      const identity = {
        paymentKey: snapshot.squarePaymentIdempotencyKey,
        orderKey: snapshot.squareOrderIdempotencyKey ?? undefined,
        providerLocationId: snapshot.providerLocationId ?? undefined,
        referenceId: operation.id,
      };
      result = snapshot.requestKind === "order"
        ? await provider.createOrderWithPayment(
          snapshot.sourceId,
          snapshot.amountMinor,
          snapshot.lineItems.map(({ catalogObjectId, quantity }) => ({ catalogObjectId, quantity })),
          snapshot.storeCard,
          snapshot.customerId ?? undefined,
          snapshot.buyerEmail ?? undefined,
          identity,
        )
        : await provider.processPayment(
          snapshot.sourceId,
          snapshot.amountMinor,
          snapshot.storeCard,
          snapshot.customerId ?? undefined,
          snapshot.buyerEmail ?? undefined,
          identity,
        );
      if (!result.id) {
        throw new PaymentProviderError(
          "Payment outcome could not be confirmed.",
          "MISSING_PAYMENT_ID",
          undefined,
          {
            disposition: "provider_unknown",
            providerCode: "MISSING_PAYMENT_ID",
            providerOrderId: result.orderId,
          },
        );
      }
    } catch (error) {
      await this.recordFailure(operation, snapshot, error, true);
      return;
    }

    // This transaction is intentionally after the provider await. A failure
    // here leaves the lease intact; expiration replays the identical Square
    // keys and never issues compensation refunds.
    try {
      const completed = await this.finalizeSuccess({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        providerObjectId: result.id,
        providerOrderId: result.orderId,
        paymentRows: paymentRows(snapshot, result, operation.id),
        now: this.now(),
      });
      log.info("Scheduled operation completed", {
        ...operationContext(completed),
        allocationCount: snapshot.allocations.length,
      });
    } catch (error) {
      log.error("Scheduled operation local finalization failed; lease retained for recovery", {
        ...operationContext(operation),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  private async recordFailure(
    operation: PaymentOperation,
    snapshot: ScheduledPaymentSemanticSnapshot,
    error: unknown,
    providerDispatchStarted: boolean,
  ): Promise<void> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased scheduled operation has no fencing token");
    const disposition = failureDisposition(error, providerDispatchStarted);
    const errorCode = sanitizeProviderErrorCode(safeErrorCode(error), "PROVIDER_ERROR");
    const providerOrderId = error instanceof PaymentProviderError ? error.providerOrderId : undefined;
    const common = {
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken,
      providerOrderId,
      errorCode,
      now: this.now(),
    };

    let updated: PaymentOperation;
    if (disposition === "provider_unknown") {
      updated = await recordPaymentOperationProviderUnknown({
        ...common,
        recoveryAt: retryAt(operation.attemptCount, common.now),
      });
    } else if (disposition === "transient") {
      updated = await schedulePaymentOperationRetry({
        ...common,
        nextAttemptAt: retryAt(operation.attemptCount, common.now),
        errorClassification: "transient",
        failedPaymentRows: payerFailureRow(snapshot, errorCode),
      });
    } else if (disposition === "action_required") {
      updated = await recordPaymentOperationActionRequired({
        ...common,
        failedPaymentRows: payerFailureRow(snapshot, errorCode),
      });
    } else {
      updated = await recordPaymentOperationFailedTerminal({
        ...common,
        errorClassification: disposition,
        failedPaymentRows: payerFailureRow(snapshot, errorCode),
      });
    }
    log.error("Scheduled operation provider attempt recorded", {
      ...operationContext(updated),
      errorClassification: updated.errorClassification,
      errorCode: updated.errorCode,
      automaticExecutionStopped: updated.status === "reconciliation_required",
    });
  }
}

export const scheduledPaymentOperationExecutor = new ScheduledPaymentOperationExecutor();
