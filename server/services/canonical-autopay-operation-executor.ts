import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canonicalAutopayExecutionSnapshots, f3AutopayPlanProvenance, f3CollectionPolicies, f3PayerAuthorizations, financialActivations, leagueOccurrences, locations, locationSquareCredentialsSchema, occurrenceCollectionPlans, paymentOperations, providerNameToPaymentType } from "@shared/schema";
import { db } from "../db.js";
import { decrypt } from "../utils/crypto.js";
import { canonicalF4AutopayExecutionEnabled } from "../config.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { PaymentProviderError, ProviderNotConfiguredError, sanitizeProviderErrorCode } from "./payment-errors.js";
import { acquireCanonicalAutopayDispatchCutoff, acquirePaymentOperationLease, finalizePaymentOperationSuccess, recordCanonicalAutopayPreDispatchFailure, recordPaymentOperationActionRequired, recordPaymentOperationConfigurationRetry, recordPaymentOperationFailedTerminal, recordPaymentOperationProviderUnknown, recordPaymentOperationReconciliationRequired, schedulePaymentOperationRetry, type PaymentOperationLinkedPaymentInput } from "../storage/payment-operations.js";
import { canonicalProviderResultDisposition, canonicalRetryAt } from "@shared/f4-canonical-autopay-contract";
import { requireLiveF1ActivationEvidence } from "./f3-workflow.js";

const LEASE_MS = 15 * 60 * 1000;
const leaseOwner = `canonical-autopay:${hostname().replace(/[^A-Za-z0-9_.:-]/g, "-")}:${process.pid}:${randomUUID()}`.slice(0, 128);

export async function executeCanonicalAutopayOperation(input: { organizationId: number; operationId: string; now?: Date }): Promise<void> {
  if (!canonicalF4AutopayExecutionEnabled) return;
  const now = input.now ?? new Date();
  const operation = await acquirePaymentOperationLease({ organizationId: input.organizationId, operationId: input.operationId, leaseOwner, leaseDurationMs: LEASE_MS, now });
  if (!operation?.leaseToken) return;
  if (operation.dispatchClaimedAt) {
    await recordPaymentOperationReconciliationRequired({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_DISPATCH_LEASE_EXPIRED", now });
    return;
  }
  const [snapshot] = await db.select().from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, operation.id), eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId))).limit(1);
  if (!snapshot) { await recordCanonicalAutopayPreDispatchFailure({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_SNAPSHOT_MISSING", now }); return; }
  const [evidence] = await db.select({ planState: occurrenceCollectionPlans.state, authState: f3PayerAuthorizations.state, authVersion: f3PayerAuthorizations.authorizationVersion, authFingerprint: f3PayerAuthorizations.authorizationFingerprint, authSource: f3PayerAuthorizations.encryptedSourceId, authCustomer: f3PayerAuthorizations.encryptedCustomerId, provenancePlanVersion: f3AutopayPlanProvenance.planVersion, provenancePlanFingerprint: f3AutopayPlanProvenance.planFingerprint, policyState: f3CollectionPolicies.state, policyVersion: f3CollectionPolicies.policyVersion, policyFingerprint: f3CollectionPolicies.policyFingerprint, activationState: financialActivations.state, activationRevision: financialActivations.currentRevision, activationSourceFingerprint: financialActivations.sourceFingerprint, occurrenceLifecycle: leagueOccurrences.lifecycle, occurrenceStatus: leagueOccurrences.status, occurrenceStartAt: leagueOccurrences.startAt }).from(canonicalAutopayExecutionSnapshots).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, canonicalAutopayExecutionSnapshots.d2PlanId), eq(occurrenceCollectionPlans.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(occurrenceCollectionPlans.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(f3AutopayPlanProvenance, and(eq(f3AutopayPlanProvenance.d2PlanId, canonicalAutopayExecutionSnapshots.d2PlanId), eq(f3AutopayPlanProvenance.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(f3AutopayPlanProvenance.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(f3CollectionPolicies, and(eq(f3CollectionPolicies.id, canonicalAutopayExecutionSnapshots.policyId), eq(f3CollectionPolicies.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(f3CollectionPolicies.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(financialActivations, and(eq(financialActivations.id, canonicalAutopayExecutionSnapshots.activationId), eq(financialActivations.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(financialActivations.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(f3PayerAuthorizations, and(eq(f3PayerAuthorizations.id, canonicalAutopayExecutionSnapshots.authorizationId), eq(f3PayerAuthorizations.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(f3PayerAuthorizations.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(leagueOccurrences, and(eq(leagueOccurrences.id, canonicalAutopayExecutionSnapshots.triggerOccurrenceId), eq(leagueOccurrences.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(leagueOccurrences.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, operation.id), eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId))).limit(1);
  let activationSourceCompatible = false;
  if (evidence) {
    try {
      await db.transaction(async (tx) => {
        const [activation] = await tx.select().from(financialActivations).where(and(eq(financialActivations.id, snapshot.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, snapshot.leagueId))).limit(1);
        if (!activation) throw new Error("activation missing");
        await requireLiveF1ActivationEvidence(tx, { organizationId: input.organizationId, leagueId: snapshot.leagueId }, activation);
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      activationSourceCompatible = true;
    } catch {
      activationSourceCompatible = false;
    }
  }
  const [authActor] = await db.select({ createdByUserId: f3PayerAuthorizations.createdByUserId }).from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.id, snapshot.authorizationId), eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, snapshot.leagueId))).limit(1);
  if (!evidence || !activationSourceCompatible || authActor?.createdByUserId !== operation.authorizingUserId || evidence.planState !== "ready" || evidence.authState !== "authorized" || evidence.authVersion !== snapshot.authorizationVersion || evidence.authFingerprint !== snapshot.authorizationFingerprint || evidence.authSource !== snapshot.encryptedSourceId || evidence.authCustomer !== snapshot.encryptedCustomerId || evidence.provenancePlanVersion !== snapshot.planVersion || evidence.provenancePlanFingerprint !== snapshot.planFingerprint || evidence.policyState !== "approved" || evidence.policyVersion !== snapshot.policyVersion || evidence.policyFingerprint !== snapshot.policyFingerprint || evidence.activationState !== "active" || evidence.activationRevision !== snapshot.activationRevision || evidence.activationSourceFingerprint !== snapshot.activationSourceFingerprint || !["published", "locked"].includes(evidence.occurrenceLifecycle) || !["scheduled", "completed"].includes(evidence.occurrenceStatus) || new Date(evidence.occurrenceStartAt).toISOString() !== new Date(snapshot.triggerStartAt).toISOString() || now.getTime() < new Date(snapshot.triggerStartAt).getTime()) { await recordCanonicalAutopayPreDispatchFailure({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_EVIDENCE_DRIFT", now }); return; }
  let sourceId: string | null;
  let customerId: string | null;
  try {
    sourceId = decrypt(snapshot.encryptedSourceId);
    customerId = snapshot.encryptedCustomerId ? decrypt(snapshot.encryptedCustomerId) : null;
  } catch {
    await recordCanonicalAutopayPreDispatchFailure({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_AUTHORIZATION_EVIDENCE_INVALID", now });
    return;
  }
  if (!sourceId || (snapshot.encryptedCustomerId && !customerId)) { await recordCanonicalAutopayPreDispatchFailure({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_AUTHORIZATION_EVIDENCE_INVALID", now }); return; }
  if (!customerId) { await recordPaymentOperationActionRequired({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_CUSTOMER_EVIDENCE_MISSING", now }); return; }
  const [currentLocation] = await db.select({ squareCredentials: locations.squareCredentials }).from(locations).where(and(eq(locations.id, snapshot.locationId), eq(locations.organizationId, input.organizationId))).limit(1);
  const currentCredentials = currentLocation ? locationSquareCredentialsSchema.safeParse(currentLocation.squareCredentials) : null;
  if (!currentCredentials?.success || currentCredentials.data?.locationId !== snapshot.providerLocationId) { await recordCanonicalAutopayPreDispatchFailure({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_PROVIDER_LOCATION_DRIFT", now }); return; }
  if (operation.leagueId === null || !(await acquireCanonicalAutopayDispatchCutoff({ organizationId: input.organizationId, leagueId: operation.leagueId, operationId: operation.id, leaseToken: operation.leaseToken, now }))) {
    await recordCanonicalAutopayPreDispatchFailure({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: "F4_DISPATCH_CUTOFF_LOST", now });
    return;
  }
  let provider;
  let providerObjectId: string | undefined;
  let providerOrderId: string | undefined;
  let paymentRows: PaymentOperationLinkedPaymentInput[] = [];
  let providerSucceeded = false;
  let providerDispatchStarted = false;
  try {
    provider = await getPaymentProvider(snapshot.locationId);
    if (provider.providerName !== operation.providerName || !provider.validateCardId(sourceId)) throw new PaymentProviderError("Payment request is invalid.", "INVALID_REQUEST", undefined, { disposition: "invalid_request", providerCode: "F4_CARD_INVALID" });
    if (!provider.hasCardOnFile || !(await provider.hasCardOnFile(customerId, sourceId))) throw new PaymentProviderError("Payment request is invalid.", "INVALID_REQUEST", undefined, { disposition: "action_required", providerCode: "F4_CARD_OWNERSHIP_DRIFT" });
    providerDispatchStarted = true;
    const result = await provider.processPayment(sourceId, operation.amountMinor, false, customerId ?? undefined, undefined, { paymentKey: operation.providerIdempotencyKey, providerLocationId: snapshot.providerLocationId, referenceId: operation.id });
    if (result.status !== "COMPLETED") {
      const outcome = canonicalProviderResultDisposition(result.status ?? "");
      if (outcome === "completed") throw new Error("unreachable provider outcome");
      throw new PaymentProviderError("Payment outcome was not completed.", "PAYMENT_NOT_COMPLETED", undefined, { disposition: outcome, providerCode: "PAYMENT_NOT_COMPLETED", providerOrderId: result.orderId });
    }
    if (!result.id) throw new PaymentProviderError("Payment outcome could not be confirmed.", "MISSING_PAYMENT_ID", undefined, { disposition: "provider_unknown", providerCode: "MISSING_PAYMENT_ID" });
    providerObjectId = result.id;
    providerOrderId = result.orderId;
    const byBowler = new Map<number, number>();
    for (const item of snapshot.items as Array<{ bowlerId: number; amountMinor: number }>) byBowler.set(item.bowlerId, (byBowler.get(item.bowlerId) ?? 0) + item.amountMinor);
    [...byBowler.entries()].sort(([a], [b]) => a - b).forEach(([bowlerId, amount], allocationIndex) => paymentRows.push({ allocationIndex, values: { bowlerId, leagueId: snapshot.leagueId, amount, lineageAmount: null, prizeFundAmount: null, weekOf: snapshot.triggerStartAt, status: "paid", type: providerNameToPaymentType(operation.providerName), providerPaymentId: result.id, receiptUrl: result.receiptUrl, receiptNumber: result.receiptNumber, receiptEmailMissing: true, notes: null, paidByUserId: operation.authorizingUserId, combinedChargeGroupId: byBowler.size > 1 ? operation.id : null } }));
    providerSucceeded = true;
  } catch (error) {
    const disposition = error instanceof PaymentProviderError ? error.disposition : error instanceof ProviderNotConfiguredError || (error instanceof Error && error.name === "ProviderNotConfiguredError") ? "configuration" : providerDispatchStarted ? "provider_unknown" : "invalid_request";
    const code = sanitizeProviderErrorCode(error instanceof PaymentProviderError || error instanceof ProviderNotConfiguredError ? error.providerCode : "F4_PROVIDER_UNKNOWN", "F4_PROVIDER_UNKNOWN");
    if (disposition === "provider_unknown") await recordPaymentOperationProviderUnknown({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: code, recoveryAt: canonicalRetryAt(operation.attemptCount, now), now });
    else if (disposition === "transient") await schedulePaymentOperationRetry({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: "transient", errorCode: code, nextAttemptAt: canonicalRetryAt(operation.attemptCount, now), now });
    else if (disposition === "action_required") await recordPaymentOperationActionRequired({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: code, now });
    else if (disposition === "configuration") await recordPaymentOperationConfigurationRetry({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: code, recoveryAt: canonicalRetryAt(operation.attemptCount, now), now });
    else await recordPaymentOperationFailedTerminal({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: disposition === "invalid_request" ? "invalid_request" : "internal", errorCode: code, now });
  }
  if (!providerSucceeded || !providerObjectId) return;
  try {
    await finalizePaymentOperationSuccess({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, providerObjectId, providerOrderId, paymentRows, now });
  } catch (error) {
    // Provider success is deliberately not reclassified. The lease, exact
    // provider object, and idempotency key remain recoverable for explicit
    // reconciliation or a same-key retry.
    try {
      await recordPaymentOperationReconciliationRequired({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, providerObjectId, providerOrderId, errorCode: "F4_LOCAL_FINALIZATION_REQUIRED", now });
    } catch {
      // Preserve the original fencing state if reconciliation bookkeeping
      // itself is unavailable; the next explicit recovery can use the lease.
    }
    return;
  }
}
