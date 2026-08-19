import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canonicalAutopayExecutionSnapshots, f3PayerAuthorizations, leagueOccurrences, occurrenceCollectionPlans, paymentOperations, providerNameToPaymentType } from "@shared/schema";
import { db } from "../db.js";
import { decrypt } from "../utils/crypto.js";
import { canonicalF4AutopayExecutionEnabled } from "../config.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { PaymentProviderError, ProviderNotConfiguredError, sanitizeProviderErrorCode } from "./payment-errors.js";
import { acquirePaymentOperationLease, finalizePaymentOperationSuccess, recordPaymentOperationActionRequired, recordPaymentOperationFailedTerminal, recordPaymentOperationProviderUnknown, schedulePaymentOperationRetry, type PaymentOperationLinkedPaymentInput } from "../storage/payment-operations.js";

const LEASE_MS = 15 * 60 * 1000;
const leaseOwner = `canonical-autopay:${hostname().replace(/[^A-Za-z0-9_.:-]/g, "-")}:${process.pid}:${randomUUID()}`.slice(0, 128);

export async function executeCanonicalAutopayOperation(input: { organizationId: number; operationId: string; now?: Date }): Promise<void> {
  if (!canonicalF4AutopayExecutionEnabled) return;
  const now = input.now ?? new Date();
  const operation = await acquirePaymentOperationLease({ organizationId: input.organizationId, operationId: input.operationId, leaseOwner, leaseDurationMs: LEASE_MS, now });
  if (!operation?.leaseToken) return;
  const [snapshot] = await db.select().from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, operation.id), eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId))).limit(1);
  if (!snapshot) { await recordPaymentOperationFailedTerminal({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: "internal", errorCode: "F4_SNAPSHOT_MISSING", now }); return; }
  const [evidence] = await db.select({ planState: occurrenceCollectionPlans.state, authState: f3PayerAuthorizations.state, occurrenceLifecycle: leagueOccurrences.lifecycle, occurrenceStatus: leagueOccurrences.status }).from(canonicalAutopayExecutionSnapshots).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, canonicalAutopayExecutionSnapshots.d2PlanId), eq(occurrenceCollectionPlans.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(occurrenceCollectionPlans.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(f3PayerAuthorizations, and(eq(f3PayerAuthorizations.id, canonicalAutopayExecutionSnapshots.authorizationId), eq(f3PayerAuthorizations.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(f3PayerAuthorizations.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).innerJoin(leagueOccurrences, and(eq(leagueOccurrences.id, canonicalAutopayExecutionSnapshots.triggerOccurrenceId), eq(leagueOccurrences.organizationId, canonicalAutopayExecutionSnapshots.organizationId), eq(leagueOccurrences.leagueId, canonicalAutopayExecutionSnapshots.leagueId))).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, operation.id), eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId))).limit(1);
  if (!evidence || evidence.planState !== "ready" || evidence.authState !== "authorized" || !["published", "locked"].includes(evidence.occurrenceLifecycle) || !["scheduled", "completed"].includes(evidence.occurrenceStatus)) { await recordPaymentOperationFailedTerminal({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: "invalid_request", errorCode: "F4_EVIDENCE_DRIFT", now }); return; }
  const sourceId = decrypt(snapshot.encryptedSourceId);
  const customerId = snapshot.encryptedCustomerId ? decrypt(snapshot.encryptedCustomerId) : null;
  if (!sourceId || (snapshot.encryptedCustomerId && !customerId)) { await recordPaymentOperationFailedTerminal({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: "invalid_request", errorCode: "F4_AUTHORIZATION_EVIDENCE_INVALID", now }); return; }
  let provider;
  try {
    provider = await getPaymentProvider(snapshot.locationId);
    if (provider.providerName !== operation.providerName || !provider.validateCardId(sourceId)) throw new PaymentProviderError("Payment request is invalid.", "INVALID_REQUEST", undefined, { disposition: "invalid_request", providerCode: "F4_CARD_INVALID" });
    if (provider.hasCardOnFile && customerId && !(await provider.hasCardOnFile(customerId, sourceId))) throw new PaymentProviderError("Payment request is invalid.", "INVALID_REQUEST", undefined, { disposition: "invalid_request", providerCode: "F4_CARD_OWNERSHIP_DRIFT" });
    const result = await provider.processPayment(sourceId, operation.amountMinor, false, customerId ?? undefined, undefined, { paymentKey: operation.providerIdempotencyKey, providerLocationId: snapshot.providerLocationId === "pending" ? undefined : snapshot.providerLocationId, referenceId: operation.id });
    if (!result.id) throw new PaymentProviderError("Payment outcome could not be confirmed.", "MISSING_PAYMENT_ID", undefined, { disposition: "provider_unknown", providerCode: "MISSING_PAYMENT_ID" });
    const rows: PaymentOperationLinkedPaymentInput[] = [];
    const byBowler = new Map<number, number>();
    for (const item of snapshot.items as Array<{ bowlerId: number; amountMinor: number }>) byBowler.set(item.bowlerId, (byBowler.get(item.bowlerId) ?? 0) + item.amountMinor);
    [...byBowler.entries()].sort(([a], [b]) => a - b).forEach(([bowlerId, amount], allocationIndex) => rows.push({ allocationIndex, values: { bowlerId, leagueId: snapshot.leagueId, amount, lineageAmount: amount, prizeFundAmount: 0, weekOf: snapshot.createdAt, status: "paid", type: providerNameToPaymentType(operation.providerName), providerPaymentId: result.id, receiptUrl: result.receiptUrl, receiptNumber: result.receiptNumber, receiptEmailMissing: false, notes: null, paidByUserId: null, combinedChargeGroupId: byBowler.size > 1 ? operation.id : null } }));
    await finalizePaymentOperationSuccess({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, providerObjectId: result.id, providerOrderId: result.orderId, paymentRows: rows, now });
  } catch (error) {
    const disposition = error instanceof PaymentProviderError ? error.disposition : error instanceof ProviderNotConfiguredError ? "configuration" : "provider_unknown";
    const code = sanitizeProviderErrorCode(error instanceof PaymentProviderError || error instanceof ProviderNotConfiguredError ? error.providerCode : "F4_PROVIDER_UNKNOWN", "F4_PROVIDER_UNKNOWN");
    if (disposition === "provider_unknown") await recordPaymentOperationProviderUnknown({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: code, recoveryAt: new Date(now.getTime() + 60_000), now });
    else if (disposition === "transient") await schedulePaymentOperationRetry({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: "transient", errorCode: code, nextAttemptAt: new Date(now.getTime() + 60_000), now });
    else if (disposition === "action_required") await recordPaymentOperationActionRequired({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorCode: code, now });
    else await recordPaymentOperationFailedTerminal({ organizationId: input.organizationId, operationId: operation.id, leaseToken: operation.leaseToken, errorClassification: disposition === "configuration" ? "configuration" : "invalid_request", errorCode: code, now });
  }
}
