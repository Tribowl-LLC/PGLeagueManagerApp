import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlerOccurrenceObligationRevisions,
  bowlerOccurrenceObligations,
  bowlers,
  canonicalAutopayExecutionSnapshots,
  financialActivationRevisions,
  leagueOccurrences,
  leagues,
  paymentDisputes,
  paymentOccurrenceAllocationRevisions,
  paymentOccurrenceAllocations,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperationOccurrenceSnapshots,
  paymentOperations,
  payments,
  type Payment,
} from "@shared/schema";
import {
  canonicalPaymentReportFingerprint,
  type CanonicalPaymentReport,
  type CanonicalPaymentReportMode,
  type CanonicalPaymentRow,
  type CanonicalPaymentTransactionGroup,
} from "@shared/canonical-payment-report";
import { paymentReceiptContract } from "@shared/payment-receipt";

export const F5_PAGE_DEFAULT = 50;
export const F5_PAGE_MAX = 200;

export class CanonicalPaymentReportIncompatibilityError extends Error {
  constructor() {
    super("canonical payment evidence is incompatible");
    this.name = "CanonicalPaymentReportIncompatibilityError";
  }
}

export interface CanonicalPaymentReportInput {
  organizationId: number;
  leagueId: number;
  bowlerId?: number;
  page?: number;
  limit?: number;
}

type Allocation = typeof paymentOccurrenceAllocations.$inferSelect;
type Operation = typeof paymentOperations.$inferSelect;

const unresolvedOperationStatuses = new Set([
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "action_required",
  "reconciliation_required",
]);

function safePage(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function safeLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, F5_PAGE_MAX)
    : F5_PAGE_DEFAULT;
}

function localBusinessDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year") ?? "0000"}-${byType.get("month") ?? "00"}-${byType.get("day") ?? "00"}`;
}

function ids<T extends { id: string }>(rows: T[]): string[] {
  return [...new Set(rows.map((row) => row.id))];
}

function revisionCoverage<T extends { id: string; currentRevision: number }>(
  parents: T[],
  revisions: Array<{ parentId: string; revisionNumber: number }>,
): boolean {
  const byParent = new Map<string, Set<number>>();
  for (const revision of revisions) {
    const set = byParent.get(revision.parentId) ?? new Set<number>();
    set.add(revision.revisionNumber);
    byParent.set(revision.parentId, set);
  }
  return parents.every((parent) => {
    const set = byParent.get(parent.id);
    if (!set || set.size !== parent.currentRevision) return false;
    for (let revision = 1; revision <= parent.currentRevision; revision += 1) {
      if (!set.has(revision)) return false;
    }
    return true;
  });
}

function statusForPayment(payment: Payment, operation: Operation | undefined, disputed: boolean): CanonicalPaymentRow["status"] {
  if (payment.status === "refunded") return "refunded";
  if (payment.status === "disputed" || disputed) return "disputed";
  if (operation && unresolvedOperationStatuses.has(operation.status)) return "unresolved";
  if (payment.status === "paid") return "confirmed_paid";
  if (payment.status === "pending") return "pending";
  if (payment.status === "failed") return "failed";
  return "review_required";
}

function groupKey(payment: Payment): { key: string; operationId: string | null; combinedId: string | null } {
  if (payment.paymentOperationId) return { key: `operation:${payment.paymentOperationId}`, operationId: payment.paymentOperationId, combinedId: null };
  if (payment.combinedChargeGroupId) return { key: `combined:${payment.combinedChargeGroupId}`, operationId: null, combinedId: payment.combinedChargeGroupId };
  return { key: `payment:${payment.id}`, operationId: null, combinedId: null };
}

function buildTransactions(rows: CanonicalPaymentRow[], paymentsById: Map<number, Payment>, operationsById: Map<string, Operation>): CanonicalPaymentTransactionGroup[] {
  const groups = new Map<string, CanonicalPaymentTransactionGroup>();
  for (const row of rows) {
    const payment = row.paymentId === null ? undefined : paymentsById.get(row.paymentId);
    const identity = payment
      ? groupKey(payment)
      : { key: `operation:${row.paymentOperationId ?? row.paymentId ?? row.bowlerId}`, operationId: row.paymentOperationId, combinedId: null };
    const existing = groups.get(identity.key);
    if (existing) {
      if (!existing.paymentOperationId) existing.amountMinor += row.amountMinor;
      if (row.paymentId !== null) existing.paymentIds = [...new Set([...existing.paymentIds, row.paymentId])].sort((a, b) => a - b);
      existing.rows.push(row);
    } else {
      groups.set(identity.key, {
        groupKey: identity.key,
        paymentOperationId: identity.operationId,
        combinedChargeGroupId: identity.combinedId,
        amountMinor: identity.operationId ? (operationsById.get(identity.operationId)?.amountMinor ?? row.amountMinor) : row.amountMinor,
        currency: row.currency,
        paymentIds: row.paymentId === null ? [] : [row.paymentId],
        rows: [row],
      });
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftRow = left.rows[0];
    const rightRow = right.rows[0];
    return leftRow.authoritativeLocalDate.localeCompare(rightRow.authoritativeLocalDate)
      || leftRow.bowlerId - rightRow.bowlerId
      || left.groupKey.localeCompare(right.groupKey);
  });
}

export async function readCanonicalPaymentReport(input: CanonicalPaymentReportInput): Promise<CanonicalPaymentReport> {
  const page = safePage(input.page);
  const limit = safeLimit(input.limit);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const asOf = String((asOfResult.rows[0] as { now?: string } | undefined)?.now ?? new Date().toISOString());

    const [league] = await tx.select({ id: leagues.id, organizationId: leagues.organizationId, timezone: leagues.timezone })
      .from(leagues)
      .where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId)))
      .limit(1);
    if (!league) throw new CanonicalPaymentReportIncompatibilityError();

    const [activation] = await tx.execute(sql`
      SELECT id, completeness_marker, current_revision
      FROM financial_activations
      WHERE organization_id = ${input.organizationId}
        AND league_id = ${input.leagueId}
        AND state = 'active'
      LIMIT 1
    `).then((result) => result.rows as Array<{ id: string; completeness_marker: boolean; current_revision: number }>);

    const [partialEvidence] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM bowler_occurrence_obligations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plans WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plan_items WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM payment_occurrence_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (!activation && partialEvidence?.present) throw new CanonicalPaymentReportIncompatibilityError();
    if (activation && activation.completeness_marker !== true) throw new CanonicalPaymentReportIncompatibilityError();
    if (activation) {
      const activationRevisions = await tx.select({
        parentId: financialActivationRevisions.activationId,
        revisionNumber: financialActivationRevisions.revisionNumber,
      }).from(financialActivationRevisions).where(and(
        eq(financialActivationRevisions.organizationId, input.organizationId),
        eq(financialActivationRevisions.leagueId, input.leagueId),
        eq(financialActivationRevisions.activationId, activation.id),
      ));
      if (activationRevisions.length !== activation.current_revision
        || new Set(activationRevisions.map((row) => row.revisionNumber)).size !== activation.current_revision
        || !Array.from({ length: activation.current_revision }, (_, index) => index + 1)
          .every((revision) => activationRevisions.some((row) => row.revisionNumber === revision))) {
        throw new CanonicalPaymentReportIncompatibilityError();
      }
    }

    // Read the complete tenant/league transaction before applying the caller's
    // bowler projection. Combined charges are conserved at operation scope;
    // filtering first would make each participant appear to underpay.
    const paymentWhere = [eq(payments.leagueId, input.leagueId)];
    const paymentRows = await tx.select({ payment: payments }).from(payments)
      .innerJoin(bowlers, eq(bowlers.id, payments.bowlerId))
      .where(and(eq(payments.leagueId, input.leagueId), eq(bowlers.organizationId, input.organizationId)))
      .orderBy(asc(payments.weekOf), asc(payments.bowlerId), asc(payments.id))
      .then((rows) => rows.map((row) => row.payment));
    const paymentsById = new Map(paymentRows.map((payment) => [payment.id, payment]));
    const paymentIds = paymentRows.map((payment) => payment.id);
    const paymentBowlerIds = [...new Set(paymentRows.map((payment) => payment.bowlerId))];
    if (paymentBowlerIds.length > 0) {
      const scopedBowlers = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
        eq(bowlers.organizationId, input.organizationId),
        inArray(bowlers.id, paymentBowlerIds),
      ));
      if (scopedBowlers.length !== paymentBowlerIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    }
    const allocations = paymentIds.length === 0 ? [] : await tx.select().from(paymentOccurrenceAllocations).where(and(
      eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
      eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
      inArray(paymentOccurrenceAllocations.paymentId, paymentIds),
    )).orderBy(asc(paymentOccurrenceAllocations.occurrenceId), asc(paymentOccurrenceAllocations.bowlerId), asc(paymentOccurrenceAllocations.id));
    const allocationIds = allocations.map((allocation) => allocation.id);
    const obligationIds = ids(allocations.map((allocation) => ({ id: allocation.obligationId })));
    const obligations = obligationIds.length === 0 ? [] : await tx.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligations.id, obligationIds),
    ));
    if (obligations.length !== obligationIds.length) throw new CanonicalPaymentReportIncompatibilityError();

    const obligationRevisions = obligationIds.length === 0 ? [] : await tx.select({
      parentId: bowlerOccurrenceObligationRevisions.obligationId,
      revisionNumber: bowlerOccurrenceObligationRevisions.revisionNumber,
    }).from(bowlerOccurrenceObligationRevisions).where(and(
      eq(bowlerOccurrenceObligationRevisions.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligationRevisions.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligationRevisions.obligationId, obligationIds),
    ));
    if (obligations.length > 0 && !revisionCoverage(obligations, obligationRevisions)) throw new CanonicalPaymentReportIncompatibilityError();

    const allocationRevisions = allocationIds.length === 0 ? [] : await tx.select({
      parentId: paymentOccurrenceAllocationRevisions.allocationId,
      revisionNumber: paymentOccurrenceAllocationRevisions.revisionNumber,
    }).from(paymentOccurrenceAllocationRevisions).where(and(
      eq(paymentOccurrenceAllocationRevisions.organizationId, input.organizationId),
      eq(paymentOccurrenceAllocationRevisions.leagueId, input.leagueId),
      inArray(paymentOccurrenceAllocationRevisions.allocationId, allocationIds),
    ));
    if (allocations.length > 0 && !revisionCoverage(allocations, allocationRevisions)) throw new CanonicalPaymentReportIncompatibilityError();

    const linkedOperationIds = [...new Set(paymentRows.map((payment) => payment.paymentOperationId).filter((id): id is string => id !== null))];
    const operationIds = linkedOperationIds;
    const operations = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      inArray(paymentOperations.id, operationIds.length > 0 ? operationIds : ["00000000-0000-0000-0000-000000000000"]),
    ));
    if (operations.length !== operationIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
    if (paymentRows.some((payment) => payment.paymentOperationId && !allocations.some((allocation) => allocation.paymentId === payment.id))) {
      throw new CanonicalPaymentReportIncompatibilityError();
    }
    for (const operation of operations) {
      const linkedAmount = paymentRows.filter((payment) => payment.paymentOperationId === operation.id).reduce((sum, payment) => sum + payment.amount, 0);
      if (linkedAmount > 0 && linkedAmount !== operation.amountMinor) throw new CanonicalPaymentReportIncompatibilityError();
    }

    // An uncertain/action-required F4 operation can be durable before its
    // payment rows are inserted. Keep that evidence visible without treating
    // it as paid. Its tenant/league row and immutable snapshots are the only
    // source of identity; no provider lookup or amount inference is allowed.
    const unresolvedOperations = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      sql`${paymentOperations.status} IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')`,
    ));
    const allOperations = [...new Map([...operations, ...unresolvedOperations].map((operation) => [operation.id, operation])).values()];
    const allOperationsById = new Map(allOperations.map((operation) => [operation.id, operation]));
    const allOperationIds = allOperations.map((operation) => operation.id);

    const occurrenceIds = [...new Set(allocations.map((allocation) => allocation.occurrenceId))];
    const occurrences = occurrenceIds.length === 0 ? [] : await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt })
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.id, occurrenceIds),
      ));
    if (occurrences.length !== occurrenceIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    const occurrenceStartById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.startAt]));

    const disputedOperationIds = allOperationIds.length === 0 ? new Set<string>() : new Set((await tx.select({ operationId: paymentDisputes.paymentOperationId })
      .from(paymentDisputes)
      .where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, allOperationIds))))
      .map((row) => row.operationId));
    const allocationsByPayment = new Map<number, Allocation[]>();
    for (const allocation of allocations) allocationsByPayment.set(allocation.paymentId, [...(allocationsByPayment.get(allocation.paymentId) ?? []), allocation]);
    for (const payment of paymentRows) {
      const paymentAllocations = allocationsByPayment.get(payment.id) ?? [];
      if (paymentAllocations.length === 0) continue;
      const activeAllocated = paymentAllocations
        .filter((allocation) => allocation.state === "active")
        .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      if (activeAllocated !== payment.amount) throw new CanonicalPaymentReportIncompatibilityError();
    }

    if (activation) {
      const canonicalOperationIds = allOperations.filter((operation) => operation.operationType === "canonical_autopay_charge").map((operation) => operation.id);
      if (canonicalOperationIds.length > 0) {
        const snapshots = await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(
          eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId),
          eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId),
          inArray(canonicalAutopayExecutionSnapshots.operationId, canonicalOperationIds),
        ));
        if (snapshots.length !== canonicalOperationIds.length) throw new CanonicalPaymentReportIncompatibilityError();
        for (const snapshot of snapshots) {
          const operation = operationsById.get(snapshot.operationId);
          if (!operation
            || operation.operationType !== "canonical_autopay_charge"
            || operation.leagueId !== snapshot.leagueId
            || operation.canonicalPlanId !== snapshot.d2PlanId
            || operation.triggerOccurrenceId !== snapshot.triggerOccurrenceId
            || operation.amountMinor !== snapshot.amountMinor
            || operation.currency !== snapshot.currency
            || snapshot.snapshotVersion !== 1
            || !Array.isArray(snapshot.items)) {
            throw new CanonicalPaymentReportIncompatibilityError();
          }
        }
      }
      const occurrenceSnapshots = allOperationIds.length === 0 ? [] : await tx.select().from(paymentOperationOccurrenceSnapshots).where(and(
        eq(paymentOperationOccurrenceSnapshots.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshots.leagueId, input.leagueId),
        inArray(paymentOperationOccurrenceSnapshots.operationId, allOperationIds),
      ));
      const occurrenceSnapshotAllocations = allOperationIds.length === 0 ? [] : await tx.select().from(paymentOperationOccurrenceSnapshotAllocations).where(and(
        eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
        inArray(paymentOperationOccurrenceSnapshotAllocations.operationId, allOperationIds),
      ));
      for (const snapshot of occurrenceSnapshots) {
        const snapshotRows = occurrenceSnapshotAllocations.filter((row) => row.operationId === snapshot.operationId);
        const operation = operationsById.get(snapshot.operationId);
        if (!operation
          || snapshot.snapshotVersion !== 1
          || snapshot.leagueId !== input.leagueId
          || snapshot.currency !== operation.currency
          || snapshot.amountMinor !== operation.amountMinor
          || snapshotRows.length !== snapshot.allocationCount
          || snapshotRows.reduce((sum, row) => sum + row.amountMinor, 0) !== snapshot.amountMinor
          || snapshotRows.some((row) => row.currency !== snapshot.currency || row.leagueId !== snapshot.leagueId)) {
          throw new CanonicalPaymentReportIncompatibilityError();
        }
      }
    }

    const allocationsByObligation = new Map<string, Allocation[]>();
    for (const allocation of allocations) allocationsByObligation.set(allocation.obligationId, [...(allocationsByObligation.get(allocation.obligationId) ?? []), allocation]);
    for (const obligation of obligations) {
      const allocated = (allocationsByObligation.get(obligation.id) ?? [])
        .filter((allocation) => allocation.state === "active")
        .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const expectedState = obligation.state === "voided"
        ? "voided"
        : allocated === 0
          ? "open"
          : allocated === obligation.amountMinor
            ? "settled"
            : allocated < obligation.amountMinor
              ? "partially_settled"
              : "invalid";
      if (expectedState === "invalid" || expectedState !== obligation.state) throw new CanonicalPaymentReportIncompatibilityError();
    }

    const rows: CanonicalPaymentRow[] = paymentRows.map((payment) => {
      const paymentAllocations = allocationsByPayment.get(payment.id) ?? [];
      const operation = payment.paymentOperationId ? operationsById.get(payment.paymentOperationId) : undefined;
      const startTimes = paymentAllocations.map((allocation) => occurrenceStartById.get(allocation.occurrenceId)).filter((value): value is string => !!value).sort();
      const businessDate = startTimes[0] ?? payment.weekOf;
      const refund = { present: payment.status === "refunded" || payment.squareRefundId !== null, amountMinor: payment.status === "refunded" ? payment.amount : 0, providerRefundId: payment.squareRefundId };
      const dispute = { present: payment.status === "disputed" || !!operation && disputedOperationIds.has(operation.id), amountMinor: (payment.status === "disputed" || !!operation && disputedOperationIds.has(operation.id)) ? payment.amount : 0, disputeId: payment.disputeId };
      const unresolved = !!operation && unresolvedOperationStatuses.has(operation.status);
      const reviewRequired = dispute.present || (payment.status !== "paid" && payment.status !== "pending") || unresolved;
      const status = statusForPayment(payment, operation, disputedOperationIds.has(operation?.id ?? ""));
      return {
        paymentId: payment.id,
        leagueId: payment.leagueId,
        bowlerId: payment.bowlerId,
        amountMinor: payment.amount,
        currency: "USD",
        status,
        paymentType: payment.type,
        businessDate,
        authoritativeLocalDate: startTimes[0] ? localBusinessDate(startTimes[0], league.timezone ?? "UTC") : localBusinessDate(payment.weekOf, league.timezone ?? "UTC"),
        providerPaymentId: payment.providerPaymentId,
        paymentOperationId: payment.paymentOperationId,
        operationType: operation?.operationType ?? null,
        operationStatus: operation?.status ?? null,
        allocatedMinor: paymentAllocations.filter((allocation) => allocation.state === "active").reduce((sum, allocation) => sum + allocation.amountMinor, 0),
        unallocatedMinor: Math.max(0, payment.amount - paymentAllocations.filter((allocation) => allocation.state === "active").reduce((sum, allocation) => sum + allocation.amountMinor, 0)),
        reviewRequired,
        source: paymentAllocations.length > 0 ? "canonical_allocation" : "unlinked_legacy",
        refund,
        dispute,
        unresolved,
        receipt: paymentReceiptContract({
          receiptUrl: payment.receiptUrl,
          receiptNumber: payment.receiptNumber,
          organizationId: input.organizationId,
          leagueId: payment.leagueId,
          paymentId: payment.id,
          paymentOperationId: payment.paymentOperationId,
          operationStatus: operation?.status ?? null,
          amountMinor: payment.amount,
          currency: "USD",
          evidenceStatus: status,
          source: paymentAllocations.length > 0 ? "canonical_allocation" : "unlinked_legacy",
          allocations: paymentAllocations.map((allocation) => ({ allocationId: allocation.id, obligationId: allocation.obligationId, occurrenceId: allocation.occurrenceId, bowlerId: allocation.bowlerId, amountMinor: allocation.amountMinor, currency: allocation.currency, state: allocation.state, source: "canonical_allocation" as const })),
          refund,
          dispute,
          unresolved,
          sharedTransaction: operation ? { groupKey: `operation:${operation.id}`, childCount: paymentRows.filter((row) => row.paymentOperationId === operation.id).length } : null,
        }),
        allocations: paymentAllocations.map((allocation) => ({
          allocationId: allocation.id,
          obligationId: allocation.obligationId,
          occurrenceId: allocation.occurrenceId,
          bowlerId: allocation.bowlerId,
          amountMinor: allocation.amountMinor,
          currency: allocation.currency,
          state: allocation.state,
          source: "canonical_allocation",
        })),
      };
    });

    for (const operation of allOperations) {
      if (!unresolvedOperationStatuses.has(operation.status) || paymentRows.some((payment) => payment.paymentOperationId === operation.id)) continue;
      const snapshot = (await tx.select().from(paymentOperationOccurrenceSnapshots).where(and(
        eq(paymentOperationOccurrenceSnapshots.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshots.leagueId, input.leagueId),
        eq(paymentOperationOccurrenceSnapshots.operationId, operation.id),
      )).then((found) => found[0]));
      const canonicalSnapshot = operation.operationType === "canonical_autopay_charge"
        ? (await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(
          eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId),
          eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId),
          eq(canonicalAutopayExecutionSnapshots.operationId, operation.id),
        )).then((found) => found[0]))
        : undefined;
      if (operation.operationType !== "canonical_autopay_charge" && !snapshot) continue;
      if (operation.operationType === "canonical_autopay_charge" && !canonicalSnapshot) throw new CanonicalPaymentReportIncompatibilityError();
      const snapshotAllocationRows = snapshot
        ? await tx.select().from(paymentOperationOccurrenceSnapshotAllocations).where(and(
          eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
          eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
          eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id),
        ))
        : [];
      const businessDate = canonicalSnapshot?.triggerStartAt ?? snapshot?.createdAt ?? operation.createdAt;
      const unresolvedBowlerId = canonicalSnapshot?.payerBowlerId ?? snapshotAllocationRows[0]?.bowlerId ?? 0;
      rows.push({
        paymentId: null,
        leagueId: input.leagueId,
        bowlerId: unresolvedBowlerId,
        amountMinor: operation.amountMinor,
        currency: operation.currency,
        status: "unresolved",
        paymentType: "square",
        businessDate,
        authoritativeLocalDate: localBusinessDate(businessDate, league.timezone ?? "UTC"),
        providerPaymentId: operation.providerObjectId,
        paymentOperationId: operation.id,
        operationType: operation.operationType,
        operationStatus: operation.status,
        allocatedMinor: 0,
        unallocatedMinor: operation.amountMinor,
        reviewRequired: true,
        source: "unresolved_operation",
        refund: { present: false, amountMinor: 0, providerRefundId: null },
        dispute: { present: false, amountMinor: 0, disputeId: null },
        unresolved: true,
        receipt: paymentReceiptContract({ receiptUrl: null, receiptNumber: null }),
        allocations: [],
      });
    }

    const canonicalRows = activation ? rows.filter((row) => row.source !== "unlinked_legacy") : [];
    const unlinkedHistory = rows.filter((row) => row.source === "unlinked_legacy");
    const mode: CanonicalPaymentReportMode = activation
      ? (unlinkedHistory.length > 0 ? "canonical_with_unlinked_history" : "canonical")
      : "legacy_fallback";
    const reportRows = activation ? canonicalRows : rows;
    const visibleRows = input.bowlerId === undefined
      ? reportRows
      : reportRows.filter((row) => row.bowlerId === input.bowlerId || row.allocations.some((allocation) => allocation.bowlerId === input.bowlerId));
    const visibleUnlinkedHistory = input.bowlerId === undefined
      ? unlinkedHistory
      : unlinkedHistory.filter((row) => row.bowlerId === input.bowlerId);
    const totals = {
      grossConfirmedPaidMinor: visibleRows.filter((row) => row.status === "confirmed_paid").reduce((sum, row) => sum + row.amountMinor, 0),
      activeAllocatedMinor: visibleRows.reduce((sum, row) => sum + row.allocatedMinor, 0),
      refundedMinor: visibleRows.filter((row) => row.refund.present).reduce((sum, row) => sum + row.refund.amountMinor, 0),
      disputedReviewRequiredMinor: visibleRows.filter((row) => row.dispute.present).reduce((sum, row) => sum + row.dispute.amountMinor, 0),
      reviewRequiredMinor: visibleRows.filter((row) => row.reviewRequired && !row.dispute.present && !row.unresolved).reduce((sum, row) => sum + row.amountMinor, 0),
      unresolvedOperationMinor: visibleRows.filter((row) => row.unresolved).reduce((sum, row) => sum + row.amountMinor, 0),
      unallocatedLegacyMinor: visibleUnlinkedHistory.filter((row) => row.status === "confirmed_paid").reduce((sum, row) => sum + row.amountMinor, 0),
    };
    const offset = (page - 1) * limit;
    const sortedRows = [...visibleRows].sort((left, right) => left.authoritativeLocalDate.localeCompare(right.authoritativeLocalDate) || left.bowlerId - right.bowlerId || String(left.paymentOperationId ?? left.paymentId).localeCompare(String(right.paymentOperationId ?? right.paymentId)));
    const allTransactions = buildTransactions(sortedRows, paymentsById, allOperationsById);
    const pagedTransactions = allTransactions.slice(offset, offset + limit);
    const pagedRows = pagedTransactions.flatMap((transaction) => transaction.rows);
    const pagedUnlinkedHistory = visibleUnlinkedHistory.slice(offset, offset + limit);
    const withoutFingerprint = {
      contractVersion: "canonical-payment-report/1" as const,
      orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      mode,
      authoritativeSource: activation ? "canonical" as const : "legacy_helper" as const,
      asOf,
      page,
      limit,
      totalRows: visibleRows.length,
      totalTransactions: allTransactions.length,
      totals,
      rows: pagedRows,
      transactions: pagedTransactions,
      unlinkedHistory: pagedUnlinkedHistory,
    };
    return { ...withoutFingerprint, fingerprint: canonicalPaymentReportFingerprint(withoutFingerprint) };
  });
}
