import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlerOccurrenceObligations, bowlerLeagues, bowlers, bowlerPaymentLinks, canonicalAutopayExecutionSnapshots, f3AutopayPlanProvenance,
  f3CollectionPolicies, f3PayerAuthorizations, financialActivations, leagueOccurrences,
  occurrenceCollectionPlanItems, occurrenceCollectionPlans, paymentOperationOccurrenceSnapshots,
  occurrenceCollectionPlanRevisions, paymentDisputes, paymentOccurrenceAllocations, paymentOperationOccurrenceSnapshotAllocations, paymentOperations, payments, locations, locationSquareCredentialsSchema,
} from "@shared/schema";
import { canonicalF3AutopayEnabled, canonicalF4AutopayExecutionEnabled } from "../config.js";
import { f3SemanticPlanFingerprint } from "@shared/f3-autopay-contract";
import { f4ExecutionSnapshotFingerprint, type F4ExecutionSnapshot, validateF4ExecutionSnapshot } from "@shared/f4-canonical-autopay-contract";
import { createOrGetCanonicalAutopayPaymentOperation, type PaymentOperationTransaction } from "../storage/payment-operations.js";
import { fingerprintPaymentOperationOccurrenceSnapshot, validatePaymentOperationOccurrenceSnapshot } from "./payment-operation-occurrence-snapshot.js";
import { requireLiveF1ActivationEvidence } from "./f3-workflow.js";

const PR2_AUTOPAY_ENABLED = false;

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
  // The legacy authorities are deliberately absent after migration 0032;
  // this function remains as a compatibility seam for PR2 only.
  if (!PR2_AUTOPAY_ENABLED || !canonicalF3AutopayEnabled || !canonicalF4AutopayExecutionEnabled) return { kind: "cancelled" };
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, input.d2PlanId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId))).limit(1).for("update");
    if (!plan) fail("PLAN_NOT_FOUND");
    const [prior] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.operationType, "canonical_autopay_charge"), eq(paymentOperations.canonicalPlanId, plan.id))).limit(1).for("share");
    if (prior) {
      const [priorSnapshot] = await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, prior.id), eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId), eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId))).limit(1).for("share");
      const [priorSupplement] = await tx.select().from(paymentOperationOccurrenceSnapshots).where(and(eq(paymentOperationOccurrenceSnapshots.operationId, prior.id), eq(paymentOperationOccurrenceSnapshots.organizationId, input.organizationId), eq(paymentOperationOccurrenceSnapshots.leagueId, input.leagueId))).limit(1).for("share");
      if (!priorSnapshot || !priorSupplement || priorSnapshot.d2PlanId !== plan.id || priorSnapshot.triggerOccurrenceId !== prior.triggerOccurrenceId || priorSnapshot.amountMinor !== prior.amountMinor || priorSnapshot.currency !== prior.currency || prior.authorizingUserId === null) fail("PRIOR_OPERATION_EVIDENCE_INVALID");
      const priorAllocations = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations).where(and(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, prior.id), eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId), eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId))).orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex));
      try {
        validateF4ExecutionSnapshot({ contractVersion: "canonical-autopay-execution/1", snapshotVersion: priorSnapshot.snapshotVersion, operationId: priorSnapshot.operationId, organizationId: priorSnapshot.organizationId, leagueId: priorSnapshot.leagueId, d2PlanId: priorSnapshot.d2PlanId, collectionPointOccurrenceId: priorSnapshot.collectionPointOccurrenceId, triggerOccurrenceId: priorSnapshot.triggerOccurrenceId, triggerStartAt: new Date(priorSnapshot.triggerStartAt).toISOString(), payerBowlerId: priorSnapshot.payerBowlerId, locationId: priorSnapshot.locationId, providerLocationId: priorSnapshot.providerLocationId, activationId: priorSnapshot.activationId, activationRevision: priorSnapshot.activationRevision, activationSourceFingerprint: priorSnapshot.activationSourceFingerprint, policyId: priorSnapshot.policyId, policyVersion: priorSnapshot.policyVersion, policyFingerprint: priorSnapshot.policyFingerprint, authorizationId: priorSnapshot.authorizationId, authorizationVersion: priorSnapshot.authorizationVersion, authorizationFingerprint: priorSnapshot.authorizationFingerprint, planVersion: priorSnapshot.planVersion, planFingerprint: priorSnapshot.planFingerprint, amountMinor: priorSnapshot.amountMinor, currency: priorSnapshot.currency, items: priorSnapshot.items, encryptedSourceId: priorSnapshot.encryptedSourceId, encryptedCustomerId: priorSnapshot.encryptedCustomerId, snapshotFingerprint: priorSnapshot.snapshotFingerprint });
        const priorSemantic = validatePaymentOperationOccurrenceSnapshot({ contractVersion: "payment-operation-occurrence-snapshot/1", snapshotVersion: priorSupplement.snapshotVersion, operationId: prior.id, operationType: "canonical_autopay_charge", organizationId: input.organizationId, leagueId: input.leagueId, amountMinor: prior.amountMinor, currency: prior.currency, allocations: priorAllocations.map((row) => ({ allocationIndex: row.allocationIndex, organizationId: row.organizationId, leagueId: row.leagueId, obligationId: row.obligationId, occurrenceId: row.occurrenceId, bowlerId: row.bowlerId, amountMinor: row.amountMinor, currency: row.currency })) });
        if (priorAllocations.length !== priorSupplement.allocationCount || fingerprintPaymentOperationOccurrenceSnapshot(priorSemantic) !== priorSupplement.snapshotFingerprint) fail("PRIOR_OPERATION_EVIDENCE_INVALID");
      } catch { fail("PRIOR_OPERATION_EVIDENCE_INVALID"); }
      return { kind: "existing" as const, operation: prior };
    }
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
    try {
      await requireLiveF1ActivationEvidence(tx, input, activation);
    } catch {
      fail("ACTIVATION_SOURCE_DRIFT");
    }
    const [blockedAuthorizationOperation] = await tx.select({ id: paymentOperations.id }).from(paymentOperations).innerJoin(canonicalAutopayExecutionSnapshots, and(eq(canonicalAutopayExecutionSnapshots.operationId, paymentOperations.id), eq(canonicalAutopayExecutionSnapshots.organizationId, paymentOperations.organizationId), eq(canonicalAutopayExecutionSnapshots.authorizationId, authorization.id))).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "canonical_autopay_charge"), inArray(paymentOperations.status, ["action_required", "leased", "provider_unknown", "reconciliation_required"]))).limit(1).for("share");
    if (blockedAuthorizationOperation) fail("AUTHORIZATION_BLOCKED");
    const [location] = await tx.select().from(locations).where(and(eq(locations.id, authorization.locationId), eq(locations.organizationId, input.organizationId))).limit(1).for("share");
    const locationCredentials = location ? locationSquareCredentialsSchema.safeParse(location.squareCredentials) : null;
    const providerLocationId = locationCredentials?.success ? locationCredentials.data?.locationId?.trim() ?? "" : "";
    if (!location || !providerLocationId) fail("LOCATION_EVIDENCE_INVALID");
    const itemRows = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.leagueId))).orderBy(asc(occurrenceCollectionPlanItems.itemIndex)).for("share");
    if (!itemRows.length || itemRows.some((item) => item.currency !== plan.currency)) fail("PLAN_ITEMS_INCOMPLETE");
    const items = itemRows.map((item) => ({ obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency, itemIndex: item.itemIndex }));
    const authorizedItems = authorization.authorizedItems.filter((item) => item.collectionPointOccurrenceId === provenance.collectionPointOccurrenceId).sort((a, b) => a.itemIndex - b.itemIndex);
    if (authorizedItems.length !== items.length || authorizedItems.some((authorizedItem, index) => {
      const item = items[index];
      // F3 authorization item indexes are global to the quote, while each
      // D2 collection-point plan stores a zero-based local order. Sorting the
      // exact point subset preserves consent order without treating that
      // harmless numbering boundary as semantic drift.
      return !item || authorizedItem.obligationId !== item.obligationId
        || authorizedItem.occurrenceId !== item.occurrenceId || authorizedItem.bowlerId !== item.bowlerId
        || authorizedItem.amountMinor !== item.amountMinor;
    }) || !authorization.collectionPointOccurrenceIds.includes(provenance.collectionPointOccurrenceId)) fail("AUTHORIZATION_ITEMS_DRIFT");
    const amountMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
    if (amountMinor <= 0) fail("PLAN_AMOUNT_INVALID");
    const obligationIds = items.map((item) => item.obligationId);
    const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligations.id, obligationIds),
    )).for("update");
    if (obligations.length !== items.length) fail("OBLIGATION_EVIDENCE_MISSING");
    const activeAllocations = await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status, refundedAt: payments.refundedAt, disputedAt: payments.disputedAt, paymentOperationId: payments.paymentOperationId }).from(paymentOccurrenceAllocations)
      .innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(
        eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
        eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
        inArray(paymentOccurrenceAllocations.obligationId, obligationIds),
        eq(paymentOccurrenceAllocations.state, "active"),
      )).for("share");
    const allocationOperationIds = [...new Set(activeAllocations.map((row) => row.paymentOperationId).filter((id): id is string => id !== null))];
    const disputedOperationIds = allocationOperationIds.length ? new Set((await tx.select({ operationId: paymentDisputes.paymentOperationId }).from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, allocationOperationIds)))).map((row) => row.operationId)) : new Set<string>();
    if (activeAllocations.some((row) => row.status !== "paid" || row.refundedAt !== null || row.disputedAt !== null || (row.paymentOperationId !== null && disputedOperationIds.has(row.paymentOperationId)))) fail("OBLIGATION_REVIEW_REQUIRED");
    const paid = activeAllocations.filter((row) => row.status === "paid").map(({ obligationId, amountMinor }) => ({ obligationId, amountMinor }));
    const reserved = await tx.select({ obligationId: paymentOperationOccurrenceSnapshotAllocations.obligationId, amountMinor: paymentOperationOccurrenceSnapshotAllocations.amountMinor }).from(paymentOperationOccurrenceSnapshotAllocations)
      .innerJoin(paymentOperations, and(eq(paymentOperations.id, paymentOperationOccurrenceSnapshotAllocations.operationId), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId)))
      .where(and(
        inArray(paymentOperationOccurrenceSnapshotAllocations.obligationId, obligationIds),
        inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"]),
      )).for("share");
    const otherPlanReservations = await tx.select({ obligationId: occurrenceCollectionPlanItems.obligationId, amountMinor: occurrenceCollectionPlanItems.amountMinor }).from(occurrenceCollectionPlanItems)
      .innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId), eq(occurrenceCollectionPlans.state, "ready")))
      .where(and(inArray(occurrenceCollectionPlanItems.obligationId, obligationIds), sql`${occurrenceCollectionPlanItems.planId} <> ${plan.id}`)).for("share");
    const totalByObligation = (rows: Array<{ obligationId: string; amountMinor: number }>) => rows.reduce((map, row) => map.set(row.obligationId, (map.get(row.obligationId) ?? 0) + row.amountMinor), new Map<string, number>());
    const paidByObligation = totalByObligation(paid);
    const reservedByObligation = totalByObligation([...reserved, ...otherPlanReservations]);
    const obligationById = new Map(obligations.map((row) => [row.id, row]));
    for (const item of items) {
      const obligation = obligationById.get(item.obligationId);
      const paidMinor = paidByObligation.get(item.obligationId) ?? 0;
      const reservedMinor = reservedByObligation.get(item.obligationId) ?? 0;
      if (!obligation || obligation.occurrenceId !== item.occurrenceId || obligation.bowlerId !== item.bowlerId
        || obligation.currency !== item.currency || ["voided", "settled", "refunded", "disputed", "review_required"].includes(obligation.state)
        || paidMinor + reservedMinor + item.amountMinor !== obligation.amountMinor
        || (paidMinor === 0 && obligation.state !== "open")
        || (paidMinor > 0 && paidMinor < obligation.amountMinor && obligation.state !== "partially_settled")) fail("OBLIGATION_BALANCE_DRIFT");
    }
    const bowlerIds = [...new Set(items.map((item) => item.bowlerId))];
    const memberships = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).where(and(eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, bowlerIds))).for("share");
    if (new Set(memberships.map((row) => row.bowlerId)).size !== bowlerIds.length) fail("ACTIVE_MEMBERSHIP_REQUIRED");
    const covered = new Set(authorization.coveredBowlerIds);
    const acceptedPartners = new Set(authorization.acceptedPartnerIds);
    if (bowlerIds.some((bowlerId) => !covered.has(bowlerId) || (bowlerId !== authorization.payerBowlerId && !acceptedPartners.has(bowlerId)))) fail("PARTNER_ACCEPTANCE_DRIFT");
    const links = await tx.select({ a: bowlerPaymentLinks.bowlerAId, b: bowlerPaymentLinks.bowlerBId }).from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), or(eq(bowlerPaymentLinks.bowlerAId, authorization.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, authorization.payerBowlerId)))).for("share");
    const linkedPartners = new Set(links.map((row) => row.a === authorization.payerBowlerId ? row.b : row.a));
    if (bowlerIds.some((bowlerId) => bowlerId !== authorization.payerBowlerId && !linkedPartners.has(bowlerId))) fail("PARTNER_ACCEPTANCE_DRIFT");
    const expectedPlanFingerprint = f3SemanticPlanFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: provenance.payerBowlerId, policyId: provenance.policyId, policyVersion: provenance.policyVersion, authorizationId: provenance.authorizationId, authorizationVersion: provenance.authorizationVersion, collectionPointOccurrenceId: provenance.collectionPointOccurrenceId, planVersion: provenance.planVersion, items: items.map(({ currency: _currency, ...item }) => ({ ...item, collectionPointOccurrenceId: provenance.collectionPointOccurrenceId })) });
    if (expectedPlanFingerprint !== provenance.planFingerprint || plan.triggerOccurrenceId !== provenance.collectionPointOccurrenceId) fail("PLAN_FINGERPRINT_DRIFT");
    const operation = await createOrGetCanonicalAutopayPaymentOperation({ organizationId: input.organizationId, leagueId: input.leagueId, d2PlanId: plan.id, triggerOccurrenceId: point.id, amountMinor, currency: plan.currency, providerName: "square", authorizingUserId: authorization.createdByUserId, now }, tx);
    const snapshotBase = { contractVersion: "canonical-autopay-execution/1" as const, snapshotVersion: 1 as const, operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, d2PlanId: plan.id, collectionPointOccurrenceId: provenance.collectionPointOccurrenceId, triggerOccurrenceId: point.id, triggerStartAt: new Date(point.startAt).toISOString(), payerBowlerId: provenance.payerBowlerId, locationId: authorization.locationId, providerLocationId, activationId: activation.id, activationRevision: activation.currentRevision, activationSourceFingerprint: activation.sourceFingerprint, policyId: policy.id, policyVersion: policy.policyVersion, policyFingerprint: policy.policyFingerprint, authorizationId: authorization.id, authorizationVersion: authorization.authorizationVersion, authorizationFingerprint: authorization.authorizationFingerprint, planVersion: provenance.planVersion, planFingerprint: provenance.planFingerprint, amountMinor, currency: plan.currency, items, encryptedSourceId: authorization.encryptedSourceId, encryptedCustomerId: authorization.encryptedCustomerId } satisfies Omit<F4ExecutionSnapshot, "snapshotFingerprint">;
    const snapshotFingerprint = f4ExecutionSnapshotFingerprint(snapshotBase);
    await tx.insert(canonicalAutopayExecutionSnapshots).values({ ...snapshotBase, snapshotFingerprint });
    const occurrenceSnapshot = { contractVersion: "payment-operation-occurrence-snapshot/1" as const, snapshotVersion: 1 as const, operationId: operation.id, operationType: "canonical_autopay_charge" as const, organizationId: input.organizationId, leagueId: input.leagueId, amountMinor, currency: plan.currency, allocations: items.map((item, allocationIndex) => ({ allocationIndex, organizationId: input.organizationId, leagueId: input.leagueId, obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency })) };
    await tx.insert(paymentOperationOccurrenceSnapshots).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(occurrenceSnapshot), amountMinor, currency: plan.currency, allocationCount: items.length });
    await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(items.map((item, allocationIndex) => ({ operationId: operation.id, allocationIndex, organizationId: input.organizationId, leagueId: input.leagueId, snapshotVersion: 1, obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency })));
    return { kind: "prepared" as const, operation };
    }, { isolationLevel: "serializable" });
  } catch (error) {
    if (!(error instanceof CanonicalAutopayPreparationError) || ["PLAN_NOT_FOUND", "F3_DISABLED", "F4_DISABLED"].includes(error.code)) throw error;
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
      const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, input.d2PlanId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId))).limit(1).for("update");
      if (plan?.state === "ready") await cancelPlan(tx, plan, error.code);
      return { kind: "cancelled" as const };
    }, { isolationLevel: "serializable" });
  }
}
