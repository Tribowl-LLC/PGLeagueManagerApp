import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  PAYMENT_OPERATION_MAX_LEASE_MS,
  type PaymentOperation,
} from "@shared/schema";
import { providerNameToPaymentType } from "@shared/schema/constants";
import {
  acquirePaymentOperationLease,
  acquireInteractivePaymentOperationDispatchCutoff,
  finalizeInteractiveCardSave,
  finalizePaymentOperationSuccess,
  getRosterOperationSnapshotForOrganization,
  getInteractiveCardSaveResponse,
  getPaymentOperationForOrganization,
  recordInteractiveCardSaveFailure,
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
  snapshot: NonNullable<Awaited<ReturnType<typeof getRosterOperationSnapshotForOrganization>>>,
  result: PaymentResult,
): PaymentOperationLinkedPaymentInput[] {
  if (!result.id) return [];
  const first = snapshot.allocations[0];
  if (!first) return [];
  // A provider transaction is one tender regardless of how many canonical
  // obligations it settles. Allocations remain the internal breakdown.
  return [{
    allocationIndex: 0,
    values: {
      organizationId: operation.organizationId,
      bowlerId: snapshot.payerBowlerId ?? first.bowlerId,
      leagueId: snapshot.leagueId,
      amount: operation.amountMinor,
      status: "paid" as const,
      type: providerNameToPaymentType(snapshot.providerName),
      providerPaymentId: result.id,
      receiptUrl: result.receiptUrl,
      receiptNumber: result.receiptNumber,
      receiptEmailMissing: snapshot.providerName === "square" && snapshot.buyerEmail === null,
      idempotencyKey: operation.id,
      notes: `Roster payment (${snapshot.allocations.length} allocation${snapshot.allocations.length === 1 ? "" : "s"})`,
      paidByUserId: first.paidByUserId,
    },
  }];
}

function operationContext(operation: PaymentOperation): Record<string, unknown> {
  return {
    organizationId: operation.organizationId,
    operationId: operation.id,
    operationType: operation.operationType,
    attemptCount: operation.attemptCount,
  };
}

function nonCompletedPaymentResultError(result: PaymentResult): PaymentProviderError {
  const definiteFailure = result.status === "FAILED" || result.status === "CANCELED";
  return new PaymentProviderError(
    "Payment outcome was not completed.",
    "PAYMENT_NOT_COMPLETED",
    undefined,
    {
      disposition: definiteFailure ? "action_required" : "provider_unknown",
      providerCode: "PAYMENT_NOT_COMPLETED",
      providerOrderId: result.orderId,
    },
  );
}

/**
 * Durable executor for general interactive charges. The route performs
 * immutable preparation, while this class owns lease-fenced provider
 * dispatch and atomic local finalization.
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
    let snapshot: NonNullable<Awaited<ReturnType<typeof getRosterOperationSnapshotForOrganization>>>;
    try {
      const loaded = await getRosterOperationSnapshotForOrganization(
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
    let paymentSourceId = snapshot.sourceId;
    let paymentStoreCard = snapshot.storeCard;
    let dispatchCutoffClaimed = false;
    const claimDispatchCutoff = async (): Promise<boolean> => {
      if (dispatchCutoffClaimed) return true;
      const cutoff = await acquireInteractivePaymentOperationDispatchCutoff({
        organizationId: operation.organizationId,
        operationId: operation.id,
        leaseToken,
        now: this.now(),
      });
      dispatchCutoffClaimed = cutoff === null || cutoff;
      return dispatchCutoffClaimed;
    };

    const sourceIsProviderCard = provider.validateCardId(snapshot.sourceId);
    if (
      (snapshot.sourceKind === "new_card" || snapshot.sourceKind === "wallet")
      && sourceIsProviderCard
    ) {
      const error = new PaymentProviderError(
        "The payment source does not match the selected payment method.",
        "PAYMENT_SOURCE_KIND_MISMATCH",
        undefined,
        { disposition: "invalid_request", providerCode: "PAYMENT_SOURCE_KIND_MISMATCH" },
      );
      return snapshot.sourceKind === "new_card" && snapshot.storeCard
        ? this.recordCardSaveFailureAndPaymentFailure(operation, error, false)
        : this.recordFailure(operation, error, false);
    }

    const requiresSavedCardOwnership = snapshot.sourceKind === "saved_card";

    if (requiresSavedCardOwnership && !snapshot.customerId) {
      return this.recordFailure(
        operation,
        new PaymentProviderError(
          "The saved payment method is not available for this payer.",
          "SAVED_CARD_CUSTOMER_REQUIRED",
          undefined,
          { disposition: "invalid_request", providerCode: "SAVED_CARD_CUSTOMER_REQUIRED" },
        ),
        false,
      );
    }

    if (snapshot.sourceKind === "saved_card" && !sourceIsProviderCard) {
      return this.recordFailure(
        operation,
        new PaymentProviderError(
          "The saved payment method is invalid.",
          "INVALID_SAVED_CARD",
          undefined,
          { disposition: "invalid_request", providerCode: "INVALID_SAVED_CARD" },
        ),
        false,
      );
    }

    if (requiresSavedCardOwnership) {
      if (!provider.hasCardOnFile) {
        return this.recordFailure(
          operation,
          new PaymentProviderError(
            "The saved payment method could not be verified.",
            "STRICT_CARD_OWNERSHIP_UNAVAILABLE",
            undefined,
            {
              disposition: "internal",
              providerCode: "STRICT_CARD_OWNERSHIP_UNAVAILABLE",
            },
          ),
          false,
        );
      }
      let cardBelongsToCustomer: boolean;
      try {
        cardBelongsToCustomer = await provider.hasCardOnFile(
          snapshot.customerId ?? "",
          snapshot.sourceId,
        );
      } catch (error) {
        return this.recordFailure(operation, error, true);
      }
      if (!cardBelongsToCustomer) {
        return this.recordFailure(
          operation,
          new PaymentProviderError(
            "The saved payment method is not available for this payer.",
            "SAVED_CARD_OWNERSHIP_MISMATCH",
            undefined,
            { disposition: "invalid_request", providerCode: "SAVED_CARD_OWNERSHIP_MISMATCH" },
          ),
          false,
        );
      }
      // A saved-card source is already vaulted; never pass the historical
      // save-card intent through to the charge provider.
      paymentStoreCard = false;
    }

    if (snapshot.storeCard && snapshot.sourceKind === "new_card") {
      if (!snapshot.customerId) {
        return this.recordCardSaveFailureAndPaymentFailure(
          operation,
          new PaymentProviderError(
            "The card could not be prepared for payment.",
            "CARD_CUSTOMER_REQUIRED",
            undefined,
            { disposition: "invalid_request", providerCode: "CARD_CUSTOMER_REQUIRED" },
          ),
          false,
        );
      }

      if (operation.cardSaveStatus === "saved") {
        const saved = getInteractiveCardSaveResponse(operation);
        if (!saved.savedCardId) {
          return this.recordFailure(
            operation,
            new PaymentProviderError(
              "The saved card could not be recovered.",
              "CARD_SAVE_RESULT_UNAVAILABLE",
              undefined,
              { disposition: "provider_unknown", providerCode: "CARD_SAVE_RESULT_UNAVAILABLE" },
            ),
            false,
          );
        }
        paymentSourceId = saved.savedCardId;
      } else {
        if (operation.cardSaveStatus !== "pending" || !operation.cardSaveProviderIdempotencyKey) {
          return this.recordFailure(
            operation,
            new PaymentProviderError(
              "The card could not be prepared for payment.",
              "CARD_SAVE_STATE_INVALID",
              undefined,
              { disposition: "internal", providerCode: "CARD_SAVE_STATE_INVALID" },
            ),
            false,
          );
        }
        let savedCard: Awaited<ReturnType<PaymentProvider["saveCardOnFile"]>>;
        try {
          // The cutoff is the transactionally locked boundary between local
          // validation and every provider-side mutation. Cancellation that
          // commits first makes this operation ineligible without invoking
          // the provider; claim-first preserves the exact request identity.
          if (!(await claimDispatchCutoff())) {
            return (await getPaymentOperationForOrganization(operation.organizationId, operation.id)) ?? operation;
          }
          savedCard = await provider.saveCardOnFile(
            snapshot.sourceId,
            snapshot.customerId,
            operation.cardSaveProviderIdempotencyKey,
          );
          if (!savedCard?.id) {
            throw new PaymentProviderError(
              "The card could not be saved before payment.",
              "CARD_SAVE_RESULT_UNKNOWN",
              undefined,
              { disposition: "provider_unknown", providerCode: "CARD_SAVE_RESULT_UNKNOWN" },
            );
          }
        } catch (error) {
          const disposition = failureDisposition(error, true);
          if (!["provider_unknown", "transient"].includes(disposition)) {
            return this.recordCardSaveFailureAndPaymentFailure(operation, error);
          }
          return this.recordFailure(operation, error, true);
        }
        // A database failure here is intentionally allowed to escape with the
        // lease retained. Recovery retries the exact CreateCard key and no
        // payment request is dispatched until the selected ID is persisted.
        await finalizeInteractiveCardSave({
          organizationId: operation.organizationId,
          operationId: operation.id,
          leaseToken,
          savedCardId: savedCard.id,
          now: this.now(),
        });
        paymentSourceId = savedCard.id;
      }
      // CreatePayment must consume the saved-card ID. The historical boolean
      // parameter is intentionally false because vaulting is complete.
      paymentStoreCard = false;
    }

    try {
      if (!(await claimDispatchCutoff())) {
        return (await getPaymentOperationForOrganization(operation.organizationId, operation.id)) ?? operation;
      }
      const identity = {
        paymentKey: snapshot.squarePaymentIdempotencyKey,
        orderKey: snapshot.squareOrderIdempotencyKey ?? undefined,
        providerLocationId: snapshot.providerLocationId ?? undefined,
        referenceId: operation.id,
      };
      result = snapshot.requestKind === "order"
        ? await provider.createOrderWithPayment(
          paymentSourceId,
          snapshot.amountMinor,
          snapshot.lineItems.map(({ catalogObjectId, quantity }) => ({ catalogObjectId, quantity })),
          paymentStoreCard,
          snapshot.customerId ?? undefined,
          snapshot.buyerEmail ?? undefined,
          identity,
        )
        : await provider.processPayment(
          paymentSourceId,
          snapshot.amountMinor,
          paymentStoreCard,
          snapshot.customerId ?? undefined,
          snapshot.buyerEmail ?? undefined,
          identity,
        );
      if (result.status !== "COMPLETED") {
        throw nonCompletedPaymentResultError(result);
      }
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

  private async recordCardSaveFailureAndPaymentFailure(
    operation: PaymentOperation,
    error: unknown,
    providerDispatchStarted = true,
  ): Promise<PaymentOperation> {
    const leaseToken = operation.leaseToken;
    if (!leaseToken) throw new Error("leased interactive operation has no fencing token");
    const errorCode = sanitizeProviderErrorCode(safeErrorCode(error), "CARD_SAVE_FAILED");
    await recordInteractiveCardSaveFailure({
      organizationId: operation.organizationId,
      operationId: operation.id,
      leaseToken,
      errorCode,
      now: this.now(),
    });
    return this.recordFailure(operation, error, providerDispatchStarted);
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
