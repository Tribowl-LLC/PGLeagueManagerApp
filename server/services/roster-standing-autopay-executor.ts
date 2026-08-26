import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { PAYMENT_OPERATION_MAX_ATTEMPTS, PAYMENT_OPERATION_MAX_LEASE_MS, type PaymentOperation } from "@shared/schema";
import { acquirePaymentOperationLease, acquireStandingAutopayDispatchCutoff, finalizePaymentOperationSuccess, getPaymentOperationForOrganization, recordPaymentOperationActionRequired, recordPaymentOperationFailedTerminal, recordPaymentOperationProviderUnknown, schedulePaymentOperationRetry } from "../storage/payment-operations.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { PaymentProviderError, ProviderNotConfiguredError, sanitizeProviderErrorCode, type PaymentProviderFailureDisposition } from "./payment-errors.js";
import { getStandingAutopayExecutionSnapshot, standingPaymentRows } from "./roster-standing-autopay.js";
import { PaymentOperationWakeScheduler } from "./payment-operation-wake-scheduler.js";
import { getNextStandingAutopayWake, type StandingAutopayWake } from "../storage/payment-operations.js";
import { createLogger } from "../logger.js";
import { rosterStandingAutopayEnabled, scheduledPaymentExecutionMode } from "../config.js";

const log = createLogger("RosterStandingAutopay");
const LEASE_OWNER = `standing-autopay:${hostname().replace(/[^A-Za-z0-9_.:-]/g, "-")}:${process.pid}:${randomUUID()}`.slice(0, 128);
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

function retryAt(attemptCount: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.max(0, attemptCount - 1))));
}

function disposition(error: unknown): PaymentProviderFailureDisposition {
  if (error instanceof PaymentProviderError) return error.disposition;
  if (error instanceof ProviderNotConfiguredError) return "configuration";
  return "provider_unknown";
}

function code(error: unknown): string {
  if (error instanceof PaymentProviderError) return error.providerCode;
  if (error instanceof ProviderNotConfiguredError) return error.providerCode;
  return "PROVIDER_UNKNOWN";
}

export class RosterStandingAutopayOperationExecutor {
  private readonly wakeScheduler: PaymentOperationWakeScheduler<StandingAutopayWake>;
  private readonly getProvider: typeof getPaymentProvider;

  constructor(dependencies: { getProvider?: typeof getPaymentProvider } = {}) {
    this.getProvider = dependencies.getProvider ?? getPaymentProvider;
    this.wakeScheduler = new PaymentOperationWakeScheduler({
      loadNextWake: getNextStandingAutopayWake,
      handleWake: (wake) => this.handleWake(wake),
      log,
    });
  }

  async start(): Promise<void> {
    if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") {
      log.info("Standing automatic-payment executor remains dormant", { enabled: rosterStandingAutopayEnabled, mode: scheduledPaymentExecutionMode });
      return;
    }
    await this.wakeScheduler.start("ledger_execute");
  }

  stop(): void { this.wakeScheduler.stop(); }
  async rearm(): Promise<void> { if (rosterStandingAutopayEnabled && scheduledPaymentExecutionMode === "ledger_execute") await this.wakeScheduler.rearm(); }

  async handleWake(wake: StandingAutopayWake): Promise<void> {
    if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") return;
    if (wake.kind === "standing_cutoff") {
      const { prepareStandingAutopayCutoff } = await import("./roster-standing-autopay.js");
      const operation = await prepareStandingAutopayCutoff({ organizationId: wake.organizationId, leagueId: wake.leagueId, consentId: wake.consentId, cutoffAt: wake.dueAt });
      if (operation) await this.execute({ organizationId: operation.organizationId, operationId: operation.id });
      return;
    }
    if (wake.kind !== "standing_operation") return;
    await this.execute({ organizationId: wake.organizationId, operationId: wake.operationId });
  }

  async execute(input: { organizationId: number; operationId: string; now?: Date }): Promise<PaymentOperation | undefined> {
    if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") return getPaymentOperationForOrganization(input.organizationId, input.operationId);
    const current = await getPaymentOperationForOrganization(input.organizationId, input.operationId);
    if (!current || current.operationType !== "standing_autopay_charge" || !["pending", "provider_unknown", "retry_scheduled", "leased"].includes(current.status)) return current;
    const operation = await acquirePaymentOperationLease({ organizationId: input.organizationId, operationId: input.operationId, leaseOwner: LEASE_OWNER, leaseDurationMs: PAYMENT_OPERATION_MAX_LEASE_MS, now: input.now ?? new Date() });
    if (!operation?.leaseToken) return getPaymentOperationForOrganization(input.organizationId, input.operationId);
    const leaseToken = operation.leaseToken;
    let snapshot;
    try {
      snapshot = await getStandingAutopayExecutionSnapshot({ organizationId: operation.organizationId, operationId: operation.id });
    } catch (error) {
      log.error("Standing automatic-payment snapshot could not be decoded", { operationId: operation.id, errorName: error instanceof Error ? error.name : "UnknownError" });
      return recordPaymentOperationFailedTerminal({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, errorClassification: "configuration", errorCode: "STANDING_SNAPSHOT_UNREADABLE", now: new Date() });
    }
    if (!snapshot || snapshot.operation.amountMinor !== snapshot.snapshot.amountMinor || snapshot.snapshot.snapshotKind !== "standing_autopay" || snapshot.operation.authorizingUserId === null) {
      return recordPaymentOperationFailedTerminal({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, errorClassification: "internal", errorCode: "STANDING_SNAPSHOT_INVALID", now: new Date() });
    }
    const sourceId = snapshot.sourceId;
    const customerId = snapshot.customerId;
    if (!sourceId || !customerId) {
      return recordPaymentOperationFailedTerminal({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, errorClassification: "configuration", errorCode: "STANDING_PAYMENT_METHOD_MISSING", now: new Date() });
    }
    let provider;
    try {
      provider = await this.getProvider(snapshot.locationId ?? null);
      const providerLocationId = typeof provider.getProviderLocationId === "function" ? (await provider.getProviderLocationId()).trim() : "";
      if (provider.providerName !== snapshot.binding.providerName || providerLocationId !== snapshot.binding.providerLocationId || !provider.validateCardId(sourceId) || !provider.hasCardOnFile || !(await provider.hasCardOnFile(customerId, sourceId))) throw new PaymentProviderError("The standing payment method is unavailable.", "PAYMENT_METHOD_INVALID", undefined, { disposition: "invalid_request", providerCode: "PAYMENT_METHOD_INVALID" });
    } catch (error) {
      return this.recordFailure(operation, leaseToken, error, false);
    }
    const cutoffClaimed = await acquireStandingAutopayDispatchCutoff({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, now: new Date() });
    if (!cutoffClaimed) return getPaymentOperationForOrganization(operation.organizationId, operation.id);
    let result;
    try {
      result = await provider.processPayment(sourceId, operation.amountMinor, false, customerId, undefined, { paymentKey: operation.providerIdempotencyKey, providerLocationId: snapshot.binding.providerLocationId, referenceId: operation.id });
      if (result.status !== "COMPLETED" || !result.id) throw new PaymentProviderError("The standing payment outcome could not be confirmed.", "PAYMENT_NOT_COMPLETED", undefined, { disposition: "provider_unknown", providerCode: "PAYMENT_NOT_COMPLETED", providerOrderId: result.orderId });
    } catch (error) {
      return this.recordFailure(operation, leaseToken, error, true);
    }
    try {
      return await finalizePaymentOperationSuccess({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, providerObjectId: result.id, providerOrderId: result.orderId, paymentRows: await standingPaymentRows({ organizationId: operation.organizationId, operationId: operation.id, providerPaymentId: result.id, providerName: operation.providerName, actorUserId: operation.authorizingUserId, receiptUrl: result.receiptUrl, receiptNumber: result.receiptNumber }), now: new Date() });
    } catch (error) {
      log.error("Standing automatic payment provider succeeded but local finalization needs recovery", { operationId: operation.id, organizationId: operation.organizationId, errorName: error instanceof Error ? error.name : "UnknownError" });
      throw error;
    }
  }

  private async recordFailure(operation: PaymentOperation, leaseToken: string, error: unknown, providerDispatchStarted: boolean): Promise<PaymentOperation> {
    const now = new Date();
    const providerDisposition = disposition(error);
    const errorCode = sanitizeProviderErrorCode(code(error), "STANDING_PAYMENT_FAILED");
    if (providerDispatchStarted && (providerDisposition === "provider_unknown" || providerDisposition === "transient")) {
      return recordPaymentOperationProviderUnknown({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, providerObjectId: null, providerOrderId: error instanceof PaymentProviderError ? error.providerOrderId ?? null : null, errorCode, recoveryAt: retryAt(operation.attemptCount, now), now });
    }
    if (providerDisposition === "action_required") return recordPaymentOperationActionRequired({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, providerOrderId: error instanceof PaymentProviderError ? error.providerOrderId ?? null : null, errorCode, now });
    if (providerDisposition === "provider_unknown" && providerDispatchStarted) return recordPaymentOperationProviderUnknown({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, errorCode, recoveryAt: retryAt(operation.attemptCount, now), now });
    if (providerDisposition === "transient") return schedulePaymentOperationRetry({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, errorCode, errorClassification: "transient", nextAttemptAt: retryAt(operation.attemptCount, now), now });
    return recordPaymentOperationFailedTerminal({ organizationId: operation.organizationId, operationId: operation.id, leaseToken, errorCode, errorClassification: providerDisposition === "configuration" ? "configuration" : "invalid_request", now });
  }
}

export const rosterStandingAutopayOperationExecutor = new RosterStandingAutopayOperationExecutor();
