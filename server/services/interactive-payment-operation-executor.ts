import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  PAYMENT_OPERATION_MAX_LEASE_MS,
  type PaymentOperation,
} from "@shared/schema";
import { providerNameToPaymentType } from "@shared/schema/constants";
import {
  acquirePaymentOperationLease,
  finalizePaymentOperationSuccess,
  getInteractivePaymentOperationSnapshotForOrganization,
  getPaymentOperationForOrganization,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  schedulePaymentOperationRetry,
  type PaymentOperationLinkedPaymentInput,
} from "../storage/payment-operations.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  sanitizeProviderErrorCode,
  type PaymentProviderFailureDisposition,
} from "./payment-errors.js";
import { buildSquarePaymentRequestIdentity } from "./payment-operation-idempotency.js";
import type { PaymentProvider, PaymentResult } from "./payment-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("InteractivePaymentLedger");
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LEASE_OWNER = (
  `interactive-charge:${hostname().replace(/[^A-Za-z0-9_.:-]/g, "-")}:${process.pid}:${randomUUID()}`
).slice(0, 128);

export interface InteractivePaymentOperationExecutorDependencies {
  now?: () => Date;
  leaseOwner?: string;
  getProvider?: typeof getPaymentProvider;
  finalizeSuccess?: typeof finalizePaymentOperationSuccess;
}

function retryAt(attemptCount: number, now: Date): Date {
  const delay = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + delay);
}

function failureDisposition(
  error: unknown,
  providerDispatchStarted: boolean,
): PaymentProviderFailureDisposition {
  if (error instanceof PaymentProviderError) return error.disposition;
  if (error instanceof ProviderNotConfiguredError) return "configuration";
  return providerDispatchStarted ? "provider_unknown" : "internal";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PaymentProviderError) return error.providerCode;
  if (error instanceof ProviderNotConfiguredError) return error.providerCode;
  return "PROVIDER_UNKNOWN";
}

function paymentRows(
  operation: PaymentOperation,
  snapshot: NonNullable<Awaited<ReturnType<typeof getInteractivePaymentOperationSnapshotForOrganization>>>,
  result: PaymentResult,
): PaymentOperationLinkedPaymentInput[] {
  if (!result.id) return [];
  return snapshot.allocations.map((allocation) => ({
    allocationIndex: allocation.allocationIndex,
    values: {
      bowlerId: allocation.bowlerId,
      leagueId: snapshot.leagueId,
      amount: allocation.amountMinor,
      lineageAmount: allocation.lineageAmountMinor,
      prizeFundAmount: allocation.prizeFundAmountMinor,
      weekOf: allocation.weekOf,
      status: "paid" as const,
      type: providerNameToPaymentType(snapshot.providerName),
      providerPaymentId: result.id,
      receiptUrl: result.receiptUrl,
      receiptNumber: result.receiptNumber,
      receiptEmailMissing: snapshot.providerName === "square" && snapshot.buyerEmail === null,
      combinedChargeGroupId: snapshot.combinedChargeGroupId,
      idempotencyKey: allocation.allocationIndex === 0 ? operation.targetKey : undefined,
      notes: allocation.notes,
      paidByUserId: allocation.paidByUserId,
    },
  }));
}

function operationContext(operation: PaymentOperation): Record<string, unknown> {
  return {
    organizationId: operation.organizationId,
    operationId: operation.id,
    operationType: operation.operationType,
    attemptCount: operation.attemptCount,
  };
}

/**
 * Dormant Phase 3A-1 primitive. No route, startup hook, or wake dispatcher
 * imports this executor until the separately reviewed route cutover.
 */
export class InteractivePaymentOperationExecutor {
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly getProvider: typeof getPaymentProvider;
  private readonly finalizeSuccess: typeof finalizePaymentOperationSuccess;

  constructor(dependencies: InteractivePaymentOperationExecutorDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseOwner = dependencies.leaseOwner ?? DEFAULT_LEASE_OWNER;
    this.getProvider = dependencies.getProvider ?? getPaymentProvider;
    this.finalizeSuccess = dependencies.finalizeSuccess ?? finalizePaymentOperationSuccess;
  }

  async execute(input: {
    organizationId: number;
    operationId: string;
    now?: Date;
  }): Promise<PaymentOperation | undefined> {
    const now = input.now ?? this.now();
    const current = await getPaymentOperationForOrganization(input.organizationId, input.operationId);
    if (
      !current
      || current.operationType !== "interactive_charge"
      || !current.targetKey.startsWith("interactive-charge:")
    ) return current;
    if (!["pending", "provider_unknown", "retry_scheduled", "leased"].includes(current.status)) {
      return current;
    }

    const operation = await acquirePaymentOperationLease({
      organizationId: input.organizationId,
      operationId: input.operationId,
      leaseOwner: this.leaseOwner,
      leaseDurationMs: PAYMENT_OPERATION_MAX_LEASE_MS,
      now,
    });
    if (!operation?.leaseToken) {
      return getPaymentOperationForOrganization(input.organizationId, input.operationId);
    }
    return this.executeLeased(operation);
  }

  private async executeLeased(operation: PaymentOperation): Promise<PaymentOperation> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased interactive operation has no fencing token");
    const now = this.now();
    let snapshot: NonNullable<Awaited<ReturnType<typeof getInteractivePaymentOperationSnapshotForOrganization>>>;
    try {
      const loaded = await getInteractivePaymentOperationSnapshotForOrganization(
        operation.organizationId,
        operation.id,
      );
      if (!loaded) throw new Error("interactive operation snapshot is missing");
      if (
        loaded.organizationId !== operation.organizationId
        || loaded.amountMinor !== operation.amountMinor
        || loaded.currency !== operation.currency
        || loaded.providerName !== operation.providerName
      ) {
        throw new Error("interactive operation snapshot semantics do not match the operation");
      }
      snapshot = loaded;
    } catch (error) {
      log.error("Interactive operation snapshot failed closed", {
        ...operationContext(operation),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return recordPaymentOperationFailedTerminal({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        now,
        errorClassification: "internal",
        errorCode: "SNAPSHOT_INVALID",
      });
    }

    let provider: PaymentProvider;
    try {
      provider = await this.getProvider(snapshot.locationId);
      if (
        provider.providerName !== snapshot.providerName
        || provider.locationId !== snapshot.locationId
      ) {
        throw new PaymentProviderError(
          "Payment request is invalid.",
          "INVALID_REQUEST",
          undefined,
          { disposition: "invalid_request", providerCode: "SNAPSHOT_PROVIDER_MISMATCH" },
        );
      }
    } catch (error) {
      return this.recordFailure(operation, error, false);
    }

    let result: PaymentResult;
    try {
      const identity = buildSquarePaymentRequestIdentity({
        providerIdempotencyKey: operation.providerIdempotencyKey,
        requestKind: snapshot.requestKind,
        providerLocationId: snapshot.providerLocationId,
      });
      result = snapshot.requestKind === "order"
        ? await provider.createOrderWithPayment(
          snapshot.sourceId,
          snapshot.amountMinor,
          snapshot.lineItems,
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
      return this.recordFailure(operation, error, true);
    }

    // The provider call above occurs after lease acquisition has committed and
    // before this separate fenced finalization transaction. A local failure
    // retains the operation for same-key replay and never compensates with a
    // second provider operation.
    try {
      return await this.finalizeSuccess({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        providerObjectId: result.id,
        providerOrderId: result.orderId,
        paymentRows: paymentRows(operation, snapshot, result),
        now: this.now(),
      });
    } catch (error) {
      log.error("Interactive operation local finalization failed; lease retained for recovery", {
        ...operationContext(operation),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  private async recordFailure(
    operation: PaymentOperation,
    error: unknown,
    providerDispatchStarted: boolean,
  ): Promise<PaymentOperation> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased interactive operation has no fencing token");
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

    if (disposition === "provider_unknown") {
      return recordPaymentOperationProviderUnknown({
        ...common,
        recoveryAt: retryAt(operation.attemptCount, common.now),
      });
    }
    if (disposition === "transient") {
      return schedulePaymentOperationRetry({
        ...common,
        nextAttemptAt: retryAt(operation.attemptCount, common.now),
        errorClassification: "transient",
      });
    }
    if (disposition === "action_required") {
      return recordPaymentOperationActionRequired(common);
    }
    return recordPaymentOperationFailedTerminal({
      ...common,
      errorClassification: disposition,
    });
  }
}

export const interactivePaymentOperationExecutor = new InteractivePaymentOperationExecutor();
