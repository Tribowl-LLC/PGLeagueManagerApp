import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  paymentAllocations,
  paymentDisputes,
  paymentObligations,
  paymentOperations,
  payments,
  occurrencePaymentResponsibilities,
  refundAllocationAdjustments,
  refundPaymentOperationSnapshots,
  rotatingOccurrenceAssignments,
  teamPaymentSlots,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { resolvePaymentObligationOwnersInTransaction } from "./roster-obligation-owners.js";

export interface ConfirmedRotatingObligationForCredit {
  organizationId: number;
  leagueId: number;
  obligationId: string;
  responsibilityId: string;
  assignmentId: string;
  actualBowlerId: number;
  owner: { kind: "team"; teamId: number };
  teamId: number;
  slotIndex: number;
  occurrenceId: string;
  occurrenceLocalDate: string;
  occurrenceStartAt: string;
  plannedOrdinal: number | null;
  billingOrdinal: number;
  component: "full" | "lineage" | "prize";
  amountMinor: number;
  currency: "USD";
  dueAt: string;
  pastDueAt: string;
  state: "open" | "partially_settled";
  grossAllocatedMinor: number;
  allocatedMinor: number;
  refundedMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
  reviewRequired: boolean;
}

/**
 * Resolve only current, confirmed, team-owned rotating obligations. The
 * caller holds the organization/league lock before using this result to
 * apply credit. Historical payer IDs and responsibility kinds are not
 * ownership evidence: converted Main rows remain responsibilityKind=main,
 * so current slot kind plus the owner sidecar are authoritative.
 */
export async function readConfirmedRotatingObligationsForCredit(
  tx: PaymentOperationTransaction,
  scope: { organizationId: number; leagueId: number; bowlerId: number },
): Promise<ConfirmedRotatingObligationForCredit[]> {
  const slots = await tx.select({
    id: teamPaymentSlots.id,
    teamId: teamPaymentSlots.teamId,
    slotIndex: teamPaymentSlots.slotIndex,
  }).from(teamPaymentSlots).where(and(
    eq(teamPaymentSlots.organizationId, scope.organizationId),
    eq(teamPaymentSlots.leagueId, scope.leagueId),
    eq(teamPaymentSlots.occupant, "rotating"),
  ));
  if (slots.length === 0) return [];
  // Once a date is confirmed, the append-only assignment is the evidence for
  // who bowled it. Current league membership and rotation-pool membership are
  // eligibility inputs for future assignments, but must not hide an existing
  // open obligation if an administrator removes that eligibility later.
  const rotatingTeamIds = [...new Set(slots.map((slot) => slot.teamId))];

  const occurrences = await tx.select({
    id: leagueOccurrences.id,
    startAt: leagueOccurrences.startAt,
    occurrenceLocalDate: leagueOccurrences.authoritativeLocalDate,
    plannedOrdinal: leagueOccurrences.plannedOrdinal,
  }).from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, scope.organizationId),
    eq(leagueOccurrences.leagueId, scope.leagueId),
    inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
    inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
  ));
  if (occurrences.length === 0) return [];
  const occurrenceIds = occurrences.map((row) => row.id);
  const billingTerms = await tx.select({
    occurrenceId: leagueOccurrenceBillingTerms.occurrenceId,
    billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal,
  }).from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, scope.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, scope.leagueId),
    eq(leagueOccurrenceBillingTerms.state, "published"),
    inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
  ));
  const billingByOccurrence = new Map<string, number>();
  for (const row of billingTerms) {
    if (row.billingOrdinal === null || billingByOccurrence.has(row.occurrenceId)) continue;
    billingByOccurrence.set(row.occurrenceId, row.billingOrdinal);
  }

  const responsibilities = await tx.select({
    id: occurrencePaymentResponsibilities.id,
    occurrenceId: occurrencePaymentResponsibilities.occurrenceId,
    teamId: occurrencePaymentResponsibilities.teamId,
    slotIndex: occurrencePaymentResponsibilities.slotIndex,
  }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, scope.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, scope.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
    inArray(occurrencePaymentResponsibilities.occurrenceId, occurrenceIds),
    inArray(occurrencePaymentResponsibilities.teamId, rotatingTeamIds),
  ));
  const rotatingSlotKeys = new Set(slots.map((slot) => `${slot.teamId}:${slot.slotIndex}`));
  const currentResponsibilities = responsibilities.filter((row) => rotatingSlotKeys.has(`${row.teamId}:${row.slotIndex}`));
  if (currentResponsibilities.length === 0) return [];
  const assignments = await tx.select().from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, scope.organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, scope.leagueId),
    inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceIds),
    inArray(rotatingOccurrenceAssignments.teamId, rotatingTeamIds),
  )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version));
  const assignmentByKey = new Map<string, typeof assignments[number]>();
  for (const assignment of assignments) {
    const key = `${assignment.occurrenceId}:${assignment.teamId}:${assignment.slotIndex}`;
    if (!assignmentByKey.has(key)) assignmentByKey.set(key, assignment);
  }
  const matched = currentResponsibilities.flatMap((responsibility) => {
    const assignment = assignmentByKey.get(`${responsibility.occurrenceId}:${responsibility.teamId}:${responsibility.slotIndex}`);
    if (!assignment || assignment.responsibilityId !== responsibility.id || assignment.actualBowlerId !== scope.bowlerId) return [];
    return [{ responsibility, assignment }];
  });
  if (matched.length === 0) return [];
  const respIds = matched.map(({ responsibility }) => responsibility.id);
  const obligationRows = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, scope.organizationId),
    eq(paymentObligations.leagueId, scope.leagueId),
    inArray(paymentObligations.responsibilityId, respIds),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
  )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.occurrenceId), asc(paymentObligations.id));
  if (obligationRows.length === 0) return [];
  const ownerByObligation = await resolvePaymentObligationOwnersInTransaction(tx, {
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    obligations: obligationRows,
  });
  const obligationIds = obligationRows.map((row) => row.id);
  const allocations = await tx.select({
    id: paymentAllocations.id,
    paymentId: paymentAllocations.paymentId,
    obligationId: paymentAllocations.obligationId,
    amountMinor: paymentAllocations.amountMinor,
    reviewRequired: paymentAllocations.reviewRequired,
  }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, scope.organizationId),
    eq(paymentAllocations.leagueId, scope.leagueId),
    eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, obligationIds),
  ));
  const allocationIds = allocations.map((row) => row.id);
  const adjustments = allocationIds.length === 0 ? [] : await tx.select({
    sourceAllocationId: refundAllocationAdjustments.sourceAllocationId,
    amountMinor: refundAllocationAdjustments.amountMinor,
    disposition: refundAllocationAdjustments.disposition,
  }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, scope.organizationId),
    eq(refundAllocationAdjustments.leagueId, scope.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocationIds),
  ));
  const adjustmentsByAllocation = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const paymentIds = [...new Set(allocations.map((row) => row.paymentId))];
  const sourcePayments = paymentIds.length === 0 ? [] : await tx.select({
    id: payments.id,
    status: payments.status,
    disputeId: payments.disputeId,
    disputedAt: payments.disputedAt,
    paymentOperationId: payments.paymentOperationId,
  }).from(payments).where(and(
    eq(payments.organizationId, scope.organizationId),
    eq(payments.leagueId, scope.leagueId),
    inArray(payments.id, paymentIds),
  ));
  const paymentById = new Map(sourcePayments.map((row) => [row.id, row]));
  const operationIds = [...new Set(sourcePayments.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []))];
  const disputeOperations = operationIds.length === 0 ? [] : await tx.select({ operationId: paymentDisputes.paymentOperationId })
    .from(paymentDisputes)
    .where(and(
      eq(paymentDisputes.organizationId, scope.organizationId),
      inArray(paymentDisputes.paymentOperationId, operationIds),
      sql`${paymentDisputes.state} NOT IN ('WON', 'INQUIRY_CLOSED')`,
    ));
  const disputedOperationIds = new Set(disputeOperations.map((row) => row.operationId));
  const operations = operationIds.length === 0 ? [] : await tx.select({ id: paymentOperations.id, status: paymentOperations.status })
    .from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, scope.organizationId),
      eq(paymentOperations.leagueId, scope.leagueId),
      inArray(paymentOperations.id, operationIds),
    ));
  const operationById = new Map(operations.map((row) => [row.id, row]));
  const unresolvedRefundPayments = paymentIds.length === 0 ? [] : await tx.select({ paymentId: refundPaymentOperationSnapshots.paymentId })
    .from(refundPaymentOperationSnapshots)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, scope.organizationId),
      eq(paymentOperations.leagueId, scope.leagueId),
    )).where(and(
      eq(refundPaymentOperationSnapshots.leagueId, scope.leagueId),
      inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
      inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"] as const),
    ));
  const heldPaymentIds = new Set(unresolvedRefundPayments.map((row) => row.paymentId));
  const allocationsByObligation = new Map<string, typeof allocations>();
  for (const allocation of allocations) {
    allocationsByObligation.set(allocation.obligationId, [...(allocationsByObligation.get(allocation.obligationId) ?? []), allocation]);
  }
  const responsibilityById = new Map(currentResponsibilities.map((row) => [row.id, row]));
  const matchedByResponsibilityId = new Map(matched.map(({ responsibility, assignment }) => [responsibility.id, assignment]));
  const occurrenceById = new Map(occurrences.map((row) => [row.id, row]));
  const result: ConfirmedRotatingObligationForCredit[] = [];
  for (const obligation of obligationRows) {
    const owner = ownerByObligation.get(obligation.id);
    const responsibility = responsibilityById.get(obligation.responsibilityId);
    const assignment = matchedByResponsibilityId.get(obligation.responsibilityId);
    const occurrence = occurrenceById.get(obligation.occurrenceId);
    const billingOrdinal = billingByOccurrence.get(obligation.occurrenceId);
    if (!owner || owner.kind !== "team" || !responsibility || !assignment || !occurrence) continue;
    if (owner.teamId !== responsibility.teamId || assignment.actualBowlerId !== scope.bowlerId) continue;
    if (billingOrdinal === undefined || occurrence.occurrenceLocalDate === null) {
      throw new Error("ROTATING_BILLING_ORDER_MISSING");
    }
    if (obligation.state !== "open" && obligation.state !== "partially_settled") {
      throw new Error("ROTATING_OBLIGATION_STATE_INVALID");
    }
    const linked = allocationsByObligation.get(obligation.id) ?? [];
    const balance = canonicalObligationBalance({
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      grossAllocatedMinor: linked.reduce((sum, row) => sum + row.amountMinor, 0),
      adjustments: linked.flatMap((row) => {
        const adjustment = adjustmentsByAllocation.get(row.id);
        return adjustment ? [{ amountMinor: adjustment.amountMinor, disposition: adjustment.disposition }] : [];
      }),
    });
    if (balance.outstandingMinor <= 0) continue;
    let reviewRequired = linked.some((row) => row.reviewRequired);
    for (const allocation of linked) {
      const payment = paymentById.get(allocation.paymentId);
      if (!payment) {
        reviewRequired = true;
        continue;
      }
      if (payment.disputeId !== null || payment.disputedAt !== null || payment.status === "disputed") reviewRequired = true;
      if (payment.paymentOperationId) {
        const operation = operationById.get(payment.paymentOperationId);
        if (!operation || operation.status !== "succeeded" || disputedOperationIds.has(payment.paymentOperationId)) reviewRequired = true;
      }
      if (heldPaymentIds.has(payment.id)) reviewRequired = true;
    }
    result.push({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      obligationId: obligation.id,
      responsibilityId: responsibility.id,
      assignmentId: assignment.id,
      actualBowlerId: scope.bowlerId,
      owner,
      teamId: responsibility.teamId,
      slotIndex: responsibility.slotIndex,
      occurrenceId: occurrence.id,
      occurrenceLocalDate: occurrence.occurrenceLocalDate,
      occurrenceStartAt: occurrence.startAt,
      plannedOrdinal: occurrence.plannedOrdinal,
      billingOrdinal,
      component: obligation.component,
      amountMinor: obligation.amountMinor,
      currency: "USD",
      dueAt: obligation.dueAt,
      pastDueAt: obligation.pastDueAt,
      state: obligation.state,
      grossAllocatedMinor: balance.grossAllocatedMinor,
      allocatedMinor: balance.effectiveAllocatedMinor,
      refundedMinor: balance.refundedMinor,
      waivedMinor: balance.waivedMinor,
      outstandingMinor: balance.outstandingMinor,
      reviewRequired,
    });
  }
  return result.sort((a, b) => a.billingOrdinal - b.billingOrdinal
    || a.occurrenceLocalDate.localeCompare(b.occurrenceLocalDate)
    || a.occurrenceId.localeCompare(b.occurrenceId)
    || a.obligationId.localeCompare(b.obligationId));
}
