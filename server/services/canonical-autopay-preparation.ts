import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlerOccurrenceObligations, canonicalAutopayExecutionSnapshots, f3AutopayPlanProvenance,
  f3CollectionPolicies, f3PayerAuthorizations, financialActivations, leagueOccurrences,
  occurrenceCollectionPlanItems, occurrenceCollectionPlans, paymentOperationOccurrenceSnapshots,
  occurrenceCollectionPlanRevisions, paymentOperationOccurrenceSnapshotAllocations, paymentOperations, locations, locationSquareCredentialsSchema,
} from "@shared/schema";
import { canonicalF3AutopayEnabled, canonicalF4AutopayExecutionEnabled } from "../config.js";
import { f3SemanticPlanFingerprint } from "@shared/f3-autopay-contract";
import { f4ExecutionSnapshotFingerprint, type F4ExecutionSnapshot } from "@shared/f4-canonical-autopay-contract";
import { createOrGetCanonicalAutopayPaymentOperation, type PaymentOperationTransaction } from "../storage/payment-operations.js";
import { fingerprintPaymentOperationOccurrenceSnapshot } from "./payment-operation-occurrence-snapshot.js";

export class CanonicalAutopayPreparationError extends Error {
  constructor(public readonly code: string, message = "Canonical auto-pay preparation is unavailable") { super(message); this.name = "CanonicalAutopayPreparationError"; }
}

type F4Tx = PaymentOperationTransaction;
function fail(code: string): never { throw new CanonicalAutopayPreparationError(code); }

async function cancelPlan(tx: F4Tx, plan: typeof occurrenceCollectionPlans.$inferSelect, reason: string) {
  const nextRevision = plan.currentRevision + 1;
  const [cancelled] = await tx.update(occurrenceCollectionPlans).set({ state: "cancelled", currentRevision: nextRevision, updatedAt: new Date().toISOString() }).where(and(eq(occurrenceCollectionPlans.id, plan.id), eq(occurrenceCollectionPlans.organizationId, plan.organizationId), eq(occurrenceCollectionPlans.leagueId, plan.leagueId), eq(occurrenceCollectionPlans.currentRevision, plan.currentRevision), eq(occurrenceCollectionPlans.state, "ready"))).returning();
  if (cancelled) {
    const items = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, plan.organizationId), eq(occurrenceCollectionPlanItems.leagueId, plan.leagueId)));
    await tx.insert(occurrenceCollectionPlanRevisions).values({ organizationId: plan.organizationId, leagueId: plan.leagueId, planId: plan.id, revisionNumber: nextRevision, snapshotSchemaVersion: 1, beforeSnapshot: { state: plan.state, plan, items }, afterSnapshot: { state: "cancelled", reason, plan: cancelled, items }, recordedByUserId: plan.recordedByUserId });
  }
  return cancelled;
}

/** Prepare one exact F3/D2 plan. The transaction contains no provider I/O. */
export async function prepareCanonicalAutopayPlan(input: { organizationId: number; leagueId: number; d2PlanId: string; now?: Date }): Promise<{ kind: "prepared" | "existing" | "cancelled"; operation?: typeof paymentOperations.$inferSelect }> {
  if (!canonicalF3AutopayEnabled || !canonicalF4AutopayExecutionEnabled) return { kind: "cancelled" };
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, input.d2PlanId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId))).limit(1).for("update");
    if (!plan) fail("PLAN_NOT_FOUND");
    const [prior] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.operationType, "canonical_autopay_charge"), eq(paymentOperations.canonicalPlanId, plan.id))).limit(1).for("share");
    if (prior) return { kind: "existing" as const, operation: prior };
    if (plan.state !== "ready" || !plan.triggerOccurrenceId) return { kind: "cancelled" as const };
    const [point] = await tx.select().from(leagueOccurrences).where(and(eq(leagueOccurrences.id, plan.triggerOccurrenceId), eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId))).limit(1).for("share");
    if (!point || !["published", "locked"].includes(point.lifecycle) || !["scheduled", "completed"].includes(point.status)) { await cancelPlan(tx, plan, "trigger_occurrence_not_published"); return { kind: "cancelled" as const }; }
    if (new Date(point.startAt).getTime() > now.getTime()) return { kind: "cancelled" as const };
    const [provenance] = await tx.select().from(f3AutopayPlanProvenance).where(and(eq(f3AutopayPlanProvenance.d2PlanId, plan.id), eq(f3AutopayPlanProvenance.organizationId, input.organizationId), eq(f3AutopayPlanProvenance.leagueId, input.leagueId))).limit(1).for("share");
    if (!provenance) fail("PROVENANCE_MISSING");
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, provenance.policyId), eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), eq(f3CollectionPolicies.state, "approved"), eq(f3CollectionPolicies.policyVersion, provenance.policyVersion))).limit(1).for("share");
    const [authorization] = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.id, provenance.authorizationId), eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.state, "authorized"), eq(f3PayerAuthorizations.authorizationVersion, provenance.authorizationVersion))).limit(1).for("share");
    const [activation] = await tx.select().from(financialActivations).where(and(eq(financialActivations.id, provenance.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.currentRevision, provenance.activationRevision), eq(financialActivations.sourceFingerprint, provenance.activationSourceFingerprint), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1).for("share");
    if (!policy || !authorization || !activation || authorization.locationId === null) fail("F3_EVIDENCE_DRIFT");
    const [location] = await tx.select().from(locations).where(and(eq(locations.id, authorization.locationId), eq(locations.organizationId, input.organizationId))).limit(1).for("share");
    const locationCredentials = location ? locationSquareCredentialsSchema.safeParse(location.squareCredentials) : null;
    const providerLocationId = locationCredentials?.success ? locationCredentials.data?.locationId?.trim() ?? "" : "";
    if (!location || !providerLocationId) fail("LOCATION_EVIDENCE_INVALID");
    const itemRows = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.leagueId))).orderBy(asc(occurrenceCollectionPlanItems.itemIndex)).for("share");
    if (!itemRows.length || itemRows.some((item) => item.currency !== plan.currency)) fail("PLAN_ITEMS_INCOMPLETE");
    const items = itemRows.map((item) => ({ obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency, itemIndex: item.itemIndex }));
    const amountMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
    if (amountMinor <= 0) fail("PLAN_AMOUNT_INVALID");
    const expectedPlanFingerprint = f3SemanticPlanFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: provenance.payerBowlerId, policyId: provenance.policyId, policyVersion: provenance.policyVersion, authorizationId: provenance.authorizationId, authorizationVersion: provenance.authorizationVersion, collectionPointOccurrenceId: provenance.collectionPointOccurrenceId, planVersion: provenance.planVersion, items: items.map(({ currency: _currency, ...item }) => ({ ...item, collectionPointOccurrenceId: provenance.collectionPointOccurrenceId })) });
    if (expectedPlanFingerprint !== provenance.planFingerprint || plan.triggerOccurrenceId !== provenance.collectionPointOccurrenceId) fail("PLAN_FINGERPRINT_DRIFT");
    const operation = await createOrGetCanonicalAutopayPaymentOperation({ organizationId: input.organizationId, leagueId: input.leagueId, d2PlanId: plan.id, triggerOccurrenceId: point.id, amountMinor, currency: plan.currency, providerName: "square", now }, tx);
    const snapshotBase = { contractVersion: "canonical-autopay-execution/1" as const, snapshotVersion: 1 as const, operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, d2PlanId: plan.id, collectionPointOccurrenceId: provenance.collectionPointOccurrenceId, triggerOccurrenceId: point.id, payerBowlerId: provenance.payerBowlerId, locationId: authorization.locationId, providerLocationId, activationId: activation.id, activationRevision: activation.currentRevision, activationSourceFingerprint: activation.sourceFingerprint, policyId: policy.id, policyVersion: policy.policyVersion, policyFingerprint: policy.policyFingerprint, authorizationId: authorization.id, authorizationVersion: authorization.authorizationVersion, authorizationFingerprint: authorization.authorizationFingerprint, planVersion: provenance.planVersion, planFingerprint: provenance.planFingerprint, amountMinor, currency: plan.currency, items, encryptedSourceId: authorization.encryptedSourceId, encryptedCustomerId: authorization.encryptedCustomerId } satisfies Omit<F4ExecutionSnapshot, "snapshotFingerprint">;
    const snapshotFingerprint = f4ExecutionSnapshotFingerprint(snapshotBase);
    await tx.insert(canonicalAutopayExecutionSnapshots).values({ ...snapshotBase, snapshotFingerprint });
    const occurrenceSnapshot = { contractVersion: "payment-operation-occurrence-snapshot/1" as const, snapshotVersion: 1 as const, operationId: operation.id, operationType: "canonical_autopay_charge" as const, organizationId: input.organizationId, leagueId: input.leagueId, amountMinor, currency: plan.currency, allocations: items.map((item, allocationIndex) => ({ allocationIndex, organizationId: input.organizationId, leagueId: input.leagueId, obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency })) };
    await tx.insert(paymentOperationOccurrenceSnapshots).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(occurrenceSnapshot), amountMinor, currency: plan.currency, allocationCount: items.length });
    await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(items.map((item, allocationIndex) => ({ operationId: operation.id, allocationIndex, organizationId: input.organizationId, leagueId: input.leagueId, snapshotVersion: 1, obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency })));
    return { kind: "prepared" as const, operation };
  }, { isolationLevel: "serializable" });
}
