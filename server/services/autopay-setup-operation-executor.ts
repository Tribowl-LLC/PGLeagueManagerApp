import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  PAYMENT_OPERATION_MAX_LEASE_MS,
  type AutopaySetupRequest,
  type PaymentOperation,
} from "@shared/schema";
import { providerNameToPaymentType } from "@shared/schema/constants";
import {
  acquirePaymentOperationLease,
  acquireInteractivePaymentOperationDispatchCutoff,
  getPaymentOperationForOrganization,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  schedulePaymentOperationRetry,
  type PaymentOperationLinkedPaymentInput,
} from "../storage/payment-operations.js";
import {
  finalizeAutopaySetupOperationSuccess,
  getAutopaySetupRequestByOperationForOrganization,
} from "../storage/autopay-setup-requests.js";
import { decrypt } from "../utils/crypto.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  sanitizeProviderErrorCode,
  type PaymentProviderFailureDisposition,
} from "./payment-errors.js";
import { buildSquarePaymentRequestIdentity } from "./payment-operation-idempotency.js";
import type { PaymentProvider, PaymentResult } from "./payment-provider.js";

const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LEASE_OWNER = (
  `autopay-setup:${hostname().replace(/[^A-Za-z0-9_.:-]/g, "-")}:${process.pid}:${randomUUID()}`
).slice(0, 128);

export interface AutopaySetupOperationExecutorDependencies {
  now?: () => Date;
  leaseOwner?: string;
  getProvider?: typeof getPaymentProvider;
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

function executionFields(request: AutopaySetupRequest): {
  sourceId: string;
  customerId: string | null;
  buyerEmail: string | null;
} {
  const sourceId = decrypt(request.encryptedSourceId);
  const customerId = request.encryptedCustomerId === null
    ? null
    : decrypt(request.encryptedCustomerId);
  const buyerEmail = request.encryptedBuyerEmail === null
    ? null
    : decrypt(request.encryptedBuyerEmail);
  if (
    !sourceId
    || (request.encryptedCustomerId !== null && !customerId)
    || (request.encryptedBuyerEmail !== null && !buyerEmail)
    || createHash("sha256").update(sourceId).digest("hex")
      !== request.snapshot.sourceFingerprint
  ) {
    throw new Error("auto-pay setup execution fields failed integrity verification");
  }
  return { sourceId, customerId, buyerEmail };
}

function successRows(
  request: AutopaySetupRequest,
  result: PaymentResult,
): PaymentOperationLinkedPaymentInput[] {
  const groupId = request.snapshot.allocations.length > 1
    ? request.paymentOperationId
    : null;
  return request.snapshot.allocations.map((allocation) => ({
    allocationIndex: allocation.allocationIndex,
    values: {
      bowlerId: allocation.bowlerId,
      leagueId: request.leagueId,
      amount: allocation.amountMinor,
      lineageAmount: allocation.lineageAmountMinor,
      prizeFundAmount: allocation.prizeFundAmountMinor,
      weekOf: allocation.occurrenceAt,
      status: "paid",
      type: providerNameToPaymentType(request.snapshot.providerName),
      providerPaymentId: result.id,
      receiptUrl: result.receiptUrl,
      receiptNumber: result.receiptNumber,
      receiptEmailMissing: request.snapshot.providerName === "square"
        && request.encryptedBuyerEmail === null,
      notes: allocation.notes,
      paidByUserId: allocation.paidByUserId,
      combinedChargeGroupId: groupId,
    },
  }));
}

function failureRows(
  request: AutopaySetupRequest,
  errorCode: string,
): PaymentOperationLinkedPaymentInput[] {
  const allocation = request.snapshot.allocations[0];
  if (!allocation) return [];
  return [{
    allocationIndex: 0,
    values: {
      bowlerId: request.payerBowlerId,
      leagueId: request.leagueId,
      amount: request.snapshot.immediateAmountMinor,
      lineageAmount: null,
      prizeFundAmount: null,
      weekOf: allocation.occurrenceAt,
      status: "failed",
      type: providerNameToPaymentType(request.snapshot.providerName),
      notes: `Auto-pay setup payment failed (${errorCode})`,
      paidByUserId: null,
      combinedChargeGroupId: null,
    },
  }];
}

export class AutopaySetupOperationExecutor {
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly getProvider: typeof getPaymentProvider;

  constructor(dependencies: AutopaySetupOperationExecutorDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseOwner = dependencies.leaseOwner ?? DEFAULT_LEASE_OWNER;
    this.getProvider = dependencies.getProvider ?? getPaymentProvider;
  }

  async execute(input: {
    organizationId: number;
    operationId: string;
    now?: Date;
  }): Promise<PaymentOperation | undefined> {
    const now = input.now ?? this.now();
    const current = await getPaymentOperationForOrganization(
      input.organizationId,
      input.operationId,
    );
    if (!current || current.operationType !== "interactive_charge") return current;
    if (
      !["pending", "provider_unknown", "retry_scheduled", "leased"].includes(current.status)
    ) {
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
    return this.executeLeased(operation, now);
  }

  private async executeLeased(operation: PaymentOperation, now: Date): Promise<PaymentOperation> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased auto-pay setup operation has no fencing token");
    const request = await getAutopaySetupRequestByOperationForOrganization(
      operation.organizationId,
      operation.id,
    );
    if (
      !request
      || request.workflowStatus !== "pending"
      || request.paymentOperationId !== operation.id
      || request.snapshot.immediateAmountMinor !== operation.amountMinor
      || request.snapshot.providerName !== operation.providerName
      || request.snapshot.currency !== operation.currency
      || request.snapshot.requestKind === null
    ) {
      return recordPaymentOperationFailedTerminal({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        now,
        errorClassification: "internal",
        errorCode: "SETUP_SNAPSHOT_INVALID",
      });
    }

    let provider: PaymentProvider;
    let fields: ReturnType<typeof executionFields>;
    try {
      fields = executionFields(request);
      provider = await this.getProvider(request.snapshot.locationId);
      if (
        provider.providerName !== request.snapshot.providerName
        || provider.locationId !== request.snapshot.locationId
        || !provider.validateCardId(fields.sourceId)
      ) {
        throw new PaymentProviderError(
          "Payment request is invalid.",
          "INVALID_REQUEST",
          undefined,
          { disposition: "invalid_request", providerCode: "SETUP_PROVIDER_MISMATCH" },
        );
      }
    } catch (error) {
      return this.recordFailure(operation, request, error, false, now);
    }

    let result: PaymentResult;
    try {
      const cutoff = await acquireInteractivePaymentOperationDispatchCutoff({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        now,
      });
      // Setup operations created before the F2 occurrence supplement remain
      // on the historical path; canonical supplements require the cutoff.
      if (cutoff === false) {
        return (await getPaymentOperationForOrganization(operation.organizationId, operation.id)) ?? operation;
      }
      const identity = buildSquarePaymentRequestIdentity({
        providerIdempotencyKey: operation.providerIdempotencyKey,
        requestKind: request.snapshot.requestKind,
      });
      identity.referenceId = operation.id;
      result = request.snapshot.requestKind === "order"
        ? await provider.createOrderWithPayment(
          fields.sourceId,
          request.snapshot.immediateAmountMinor,
          request.snapshot.lineItems,
          false,
          fields.customerId ?? undefined,
          fields.buyerEmail ?? undefined,
          identity,
        )
        : await provider.processPayment(
          fields.sourceId,
          request.snapshot.immediateAmountMinor,
          false,
          fields.customerId ?? undefined,
          fields.buyerEmail ?? undefined,
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
      return this.recordFailure(operation, request, error, true, now);
    }

    const finalized = await finalizeAutopaySetupOperationSuccess({
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken,
      providerObjectId: result.id,
      providerOrderId: result.orderId,
      paymentRows: successRows(request, result),
      now,
    });
    return finalized.operation;
  }

  private async recordFailure(
    operation: PaymentOperation,
    request: AutopaySetupRequest,
    error: unknown,
    providerDispatchStarted: boolean,
    now: Date,
  ): Promise<PaymentOperation> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased auto-pay setup operation has no fencing token");
    const disposition = failureDisposition(error, providerDispatchStarted);
    const errorCode = sanitizeProviderErrorCode(safeErrorCode(error), "PROVIDER_ERROR");
    const providerOrderId = error instanceof PaymentProviderError
      ? error.providerOrderId
      : undefined;
    const common = {
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken,
      providerOrderId,
      errorCode,
      now,
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
        failedPaymentRows: failureRows(request, errorCode),
      });
    }
    if (disposition === "action_required") {
      return recordPaymentOperationActionRequired({
        ...common,
        failedPaymentRows: failureRows(request, errorCode),
      });
    }
    return recordPaymentOperationFailedTerminal({
      ...common,
      errorClassification: disposition,
      failedPaymentRows: failureRows(request, errorCode),
    });
  }
}

export const autopaySetupOperationExecutor = new AutopaySetupOperationExecutor();
