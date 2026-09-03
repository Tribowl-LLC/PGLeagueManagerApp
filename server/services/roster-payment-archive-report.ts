import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { bowlers, leagueOccurrences, leagues, paymentAllocations, paymentDisputes, paymentObligations, paymentOperations, paymentOperationRosterSnapshots, paymentOperationRosterSnapshotItems, paymentVoids, payments } from "@shared/schema";
import type { CanonicalPaymentReport, CanonicalPaymentRow, CanonicalPaymentReportTotals } from "@shared/canonical-payment-report";
import { canonicalPaymentReportFingerprint } from "@shared/canonical-payment-report";

export class CanonicalPaymentReportIncompatibilityError extends Error {}

export interface CanonicalPaymentReportInput {
  organizationId: number;
  leagueId: number;
  bowlerId?: number;
  paymentId?: number;
  page?: number;
  limit?: number;
}

function rowStatus(payment: typeof payments.$inferSelect, reviewRequired: boolean, corrected: boolean): CanonicalPaymentRow["status"] {
  // A manual correction is append-only evidence: the original payment row is
  // retained, but its canonical allocation is voided and superseded. Do not
  // count that archived row as a second settled payment in report totals.
  if (corrected) return "review_required";
  if (reviewRequired) return "review_required";
  if (payment.disputeId) return "disputed";
  if (payment.refundedAt || payment.squareRefundId) return "refunded";
  if (payment.status === "paid") return "confirmed_paid";
  if (payment.status === "pending") return "pending";
  return "failed";
}

function leagueLocalDate(instant: string, timezone: string | null): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

function canonicalOperationType(value: string | null | undefined): CanonicalPaymentRow["operationType"] {
  if (value === null || value === undefined) return null;
  if (value === "interactive_charge" || value === "refund" || value === "standing_autopay_charge") return value;
  throw new CanonicalPaymentReportIncompatibilityError("payment operation uses a retired execution type");
}

export async function readCanonicalPaymentReport(input: CanonicalPaymentReportInput): Promise<CanonicalPaymentReport> {
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  type ReportExecutor = Pick<typeof db, "execute" | "select">;
  const read = async (tx: ReportExecutor): Promise<CanonicalPaymentReport> => {
    let asOf = new Date().toISOString();
    if (typeof tx.execute === "function") {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
      asOf = (asOfResult.rows[0] as { as_of?: string } | undefined)?.as_of ?? asOf;
    }
    const [league] = await tx.select({ timezone: leagues.timezone, paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league) throw new CanonicalPaymentReportIncompatibilityError("league not found");
    const [upfrontEvidence] = league.paymentMode === "upfront"
      ? await tx.select({ dueAt: paymentObligations.dueAt }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        sql`${paymentObligations.pastDueAt} = ${paymentObligations.dueAt}`,
      )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.id)).limit(1)
      : [];
    const upfrontDueAt = upfrontEvidence?.dueAt ? new Date(upfrontEvidence.dueAt).toISOString() : null;
    const timezone = league.timezone ?? "UTC";
    const conditions = [eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId)];
    if (input.bowlerId !== undefined) conditions.push(eq(payments.bowlerId, input.bowlerId));
    if (input.paymentId !== undefined) conditions.push(eq(payments.id, input.paymentId));
    const paymentRows = await tx.select().from(payments).innerJoin(bowlers, eq(bowlers.id, payments.bowlerId)).where(and(...conditions, eq(bowlers.organizationId, input.organizationId))).orderBy(desc(payments.createdAt), desc(payments.id));
    const allPayments = paymentRows.map((row) => row.payments);
    const paymentIds = allPayments.map((row) => row.id);
    const operationIds = allPayments.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []);
    const allocations = paymentIds.length === 0 ? [] : await tx.select({ allocation: paymentAllocations, obligation: paymentObligations, occurrence: leagueOccurrences }).from(paymentAllocations).innerJoin(paymentObligations, and(eq(paymentObligations.id, paymentAllocations.obligationId), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId))).innerJoin(leagueOccurrences, and(eq(leagueOccurrences.id, paymentObligations.occurrenceId), eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId))).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), inArray(paymentAllocations.paymentId, paymentIds))).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentAllocations.id));
    const operations = operationIds.length === 0 ? [] : await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), inArray(paymentOperations.id, operationIds)));
    const voids = paymentIds.length === 0 ? [] : await tx.select().from(paymentVoids).where(and(eq(paymentVoids.organizationId, input.organizationId), eq(paymentVoids.leagueId, input.leagueId), inArray(paymentVoids.paymentId, paymentIds)));
    const operationSnapshotItems = operationIds.length === 0 ? [] : await tx.select({ snapshot: paymentOperationRosterSnapshots, item: paymentOperationRosterSnapshotItems }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentOperationRosterSnapshots, and(
      eq(paymentOperationRosterSnapshots.operationId, paymentOperationRosterSnapshotItems.operationId),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.operationId, operationIds),
    ));
    const disputes = operationIds.length === 0 ? [] : await tx.select().from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, operationIds))).orderBy(desc(paymentDisputes.updatedAt));
    const rows: CanonicalPaymentRow[] = allPayments.map((payment) => {
      const linked = allocations.filter((candidate) => candidate.allocation.paymentId === payment.id);
      if (linked.length === 0 && payment.paymentOperationId === null) {
        throw new CanonicalPaymentReportIncompatibilityError("payment has no canonical allocation evidence");
      }
      const operation = operations.find((candidate) => candidate.id === payment.paymentOperationId);
      const dispute = operation ? disputes.find((candidate) => candidate.paymentOperationId === operation.id) : undefined;
      const voidEvidence = voids.find((candidate) => candidate.paymentId === payment.id);
      const corrected = Boolean(voidEvidence) || linked.some((candidate) => candidate.allocation.state === "voided");
      // A provider operation is not confirmed financial evidence until its
      // immutable roster reservation has an active canonical allocation. A
      // payment row can exist after provider success but before (or instead
      // of) local allocation finalization; keep its operation identity for
      // recovery, but fail closed in F5 rather than counting it as paid.
      const expectedSnapshots = payment.paymentOperationId !== null
        ? operationSnapshotItems.filter((candidate) => candidate.item.operationId === payment.paymentOperationId)
        : [];
      // Every operation-linked parent must reconcile to every immutable
      // snapshot item and matching active allocation.
      const activeLinked = linked.filter((candidate) => candidate.allocation.state === "active");
      const activeTotal = activeLinked.reduce((sum, candidate) => sum + candidate.allocation.amountMinor, 0);
      const invalidCanonicalAllocation = payment.paymentOperationId !== null && (
        expectedSnapshots.length === 0
        || expectedSnapshots.some((expected) => expected.item.state !== "finalized" || !activeLinked.some((candidate) => candidate.allocation.obligationId === expected.item.obligationId && candidate.allocation.amountMinor === expected.item.amountMinor && candidate.allocation.currency === expected.snapshot.currency))
        || activeLinked.length !== expectedSnapshots.length
        || !operation
        || operation.status !== "succeeded"
        || operation.amountMinor !== payment.amount
        || activeTotal !== payment.amount
        || payment.providerPaymentId !== operation.providerObjectId
      );
      const reviewRequired = invalidCanonicalAllocation
        || linked.some((candidate) => candidate.allocation.reviewRequired)
        || Boolean(dispute && !["WON", "CLOSED"].includes(dispute.state));
      const allocationRows = linked.map((candidate) => ({ allocationId: candidate.allocation.id, obligationId: candidate.obligation.id, occurrenceId: candidate.obligation.occurrenceId, occurrenceLocalDate: candidate.occurrence.authoritativeLocalDate, bowlerId: candidate.obligation.payerBowlerId, amountMinor: candidate.allocation.amountMinor, currency: candidate.allocation.currency, state: candidate.allocation.state === "active" ? "active" as const : "voided" as const }));
      const allocatedMinor = allocationRows.filter((candidate) => candidate.state === "active").reduce((sum, candidate) => sum + candidate.amountMinor, 0);
      const manualGrossMismatch = !voidEvidence && payment.paymentOperationId === null && allocatedMinor !== payment.amount;
      const refundAmount = payment.refundedAt || payment.squareRefundId ? payment.amount : 0;
      const canonicalDate = leagueLocalDate(payment.createdAt, league.timezone);
      const row: CanonicalPaymentRow = {
        paymentId: payment.id,
        leagueId: payment.leagueId,
        bowlerId: payment.bowlerId,
        amountMinor: payment.amount,
        currency: payment.currency,
        status: rowStatus(payment, reviewRequired, corrected),
        paymentType: payment.type === "cash" || payment.type === "check" ? payment.type : payment.type === "square" ? "square" : "credit_card",
        businessDate: canonicalDate,
        authoritativeLocalDate: canonicalDate,
        providerPaymentId: payment.providerPaymentId,
        paymentOperationId: payment.paymentOperationId,
        operationType: canonicalOperationType(operation?.operationType),
        operationStatus: operation?.status ?? null,
        allocatedMinor,
        unallocatedMinor: Math.max(0, payment.amount - allocatedMinor),
        reviewRequired: reviewRequired || manualGrossMismatch,
        source: invalidCanonicalAllocation || linked.length === 0 || manualGrossMismatch ? "unresolved_operation" : "canonical_allocation",
        unresolved: invalidCanonicalAllocation || manualGrossMismatch || operation?.status === "provider_unknown" || operation?.status === "reconciliation_required",
        refund: { present: refundAmount > 0, amountMinor: refundAmount, providerRefundId: payment.squareRefundId },
        dispute: { present: Boolean(dispute || payment.disputeId), amountMinor: dispute?.amountMinor ?? (payment.disputeId ? payment.amount : 0), disputeId: dispute?.providerDisputeId ?? payment.disputeId, scope: "transaction", state: dispute?.state ?? null, reviewRequired },
        receipt: { contractVersion: "payment-receipt/1", availability: payment.receiptUrl ? "available" : "unavailable", receiptUrl: payment.receiptUrl, receiptNumber: payment.receiptNumber, deliveryEvidence: "delivery_not_recorded", source: invalidCanonicalAllocation || linked.length === 0 ? "unresolved_operation" : "canonical_allocation", refund: { present: refundAmount > 0, amountMinor: refundAmount, providerRefundId: payment.squareRefundId }, dispute: { present: Boolean(dispute || payment.disputeId), amountMinor: dispute?.amountMinor ?? 0, disputeId: dispute?.providerDisputeId ?? payment.disputeId, scope: "transaction", state: dispute?.state ?? null, reviewRequired } },
        allocations: allocationRows,
        correctionEvidence: voidEvidence ? { status: "voided", voidId: voidEvidence.id } : undefined,
        sharedTransaction: null,
        // paidByUserId is a users.id actor and must never be interpreted as a
        // bowler identity. The recipient/payer comes from the canonical
        // tender parent; receipt authorization separately checks the
        // payment actor against users.id.
        initiatingPayerBowlerId: payment.bowlerId,
      };
      return row;
    });
    const operationOnlyEvidence = input.paymentId === undefined ? await tx.select({ operation: paymentOperations, snapshot: paymentOperationRosterSnapshots, item: paymentOperationRosterSnapshotItems, obligation: paymentObligations })
      .from(paymentOperations)
      .innerJoin(paymentOperationRosterSnapshots, and(
        eq(paymentOperationRosterSnapshots.operationId, paymentOperations.id),
        eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      ))
      .innerJoin(paymentOperationRosterSnapshotItems, and(
        eq(paymentOperationRosterSnapshotItems.operationId, paymentOperations.id),
        eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      ))
      .innerJoin(paymentObligations, and(
        eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId),
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
      ))
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
        inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"] as const),
        input.bowlerId === undefined ? sql`true` : eq(paymentObligations.payerBowlerId, input.bowlerId),
      )) : [];
    const operationOnlyById = new Map<string, typeof operationOnlyEvidence>();
    for (const evidence of operationOnlyEvidence) operationOnlyById.set(evidence.operation.id, [...(operationOnlyById.get(evidence.operation.id) ?? []), evidence]);
    for (const evidenceRows of operationOnlyById.values()) {
      const first = evidenceRows[0];
      if (!first || operationIds.includes(first.operation.id)) continue;
      const operation = first.operation;
      const snapshot = first.snapshot;
      const dueAt = evidenceRows.map((row) => row.obligation.dueAt).sort()[0] ?? operation.createdAt;
      const authoritativeLocalDate = leagueLocalDate(dueAt, league.timezone);
      const unresolved = operation.status === "provider_unknown" || operation.status === "reconciliation_required";
      const operationRow: CanonicalPaymentRow = {
        paymentId: null,
        leagueId: input.leagueId,
        bowlerId: first.obligation.payerBowlerId,
        amountMinor: snapshot.amountMinor,
        currency: snapshot.currency,
        status: unresolved ? "unresolved" : "pending",
        paymentType: "credit_card",
        businessDate: authoritativeLocalDate,
        authoritativeLocalDate,
        providerPaymentId: operation.providerObjectId,
        paymentOperationId: operation.id,
        operationType: canonicalOperationType(operation.operationType),
        operationStatus: operation.status,
        allocatedMinor: 0,
        unallocatedMinor: snapshot.amountMinor,
        reviewRequired: unresolved,
        source: "unresolved_operation",
        unresolved: true,
        refund: { present: false, amountMinor: 0, providerRefundId: null },
        dispute: { present: false, amountMinor: 0, disputeId: null, scope: "transaction", state: null, reviewRequired: unresolved },
        receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded", source: "unresolved_operation", refund: { present: false, amountMinor: 0, providerRefundId: null }, dispute: { present: false, amountMinor: 0, disputeId: null, scope: "transaction", state: null, reviewRequired: unresolved } },
        allocations: evidenceRows.map((row) => ({ allocationId: null, obligationId: row.obligation.id, occurrenceId: row.obligation.occurrenceId, bowlerId: row.obligation.payerBowlerId, amountMinor: row.item.amountMinor, currency: row.item.state === "released" ? "USD" : snapshot.currency, state: null })),
        sharedTransaction: null,
        initiatingPayerBowlerId: first.obligation.payerBowlerId,
      };
      rows.push(operationRow);
    }
    rows.sort((left, right) => left.businessDate.localeCompare(right.businessDate)
      || left.bowlerId - right.bowlerId
      || (left.allocations[0]?.occurrenceId ?? "").localeCompare(right.allocations[0]?.occurrenceId ?? "")
      || (left.allocations[0]?.allocationId ?? "").localeCompare(right.allocations[0]?.allocationId ?? "")
      || (left.paymentId ?? Number.MAX_SAFE_INTEGER) - (right.paymentId ?? Number.MAX_SAFE_INTEGER));
    const grouped = new Map<string, CanonicalPaymentRow[]>();
    for (const row of rows) {
      const groupKey = row.sharedTransaction?.groupKey
        ?? (row.paymentOperationId ? `operation:${row.paymentOperationId}` : `payment:${row.paymentId}`);
      grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), row]);
    }
    const transactions = [...grouped.entries()].map(([groupKey, groupedRows]) => ({ groupKey, paymentOperationId: groupedRows[0]?.paymentOperationId ?? null, amountMinor: groupedRows.reduce((sum, row) => sum + row.amountMinor, 0), currency: "USD", paymentIds: groupedRows.flatMap((row) => row.paymentId ? [row.paymentId] : []), rows: groupedRows }));
    const totals: CanonicalPaymentReportTotals = {
      grossConfirmedPaidMinor: rows.filter((row) => row.status === "confirmed_paid" || row.status === "refunded" || row.status === "disputed").reduce((sum, row) => sum + row.amountMinor, 0),
      activeAllocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
      refundedMinor: rows.reduce((sum, row) => sum + row.refund.amountMinor, 0),
      disputedReviewRequiredMinor: rows.filter((row) => row.reviewRequired && row.dispute.present).reduce((sum, row) => sum + row.dispute.amountMinor, 0),
      reviewRequiredMinor: rows.filter((row) => row.reviewRequired).reduce((sum, row) => sum + row.amountMinor, 0),
      unresolvedOperationMinor: rows.filter((row) => row.unresolved).reduce((sum, row) => sum + row.amountMinor, 0),
    };
    const reportWithoutFingerprint = { contractVersion: "canonical-payment-report/2" as const, orderVersion: "league,business-date,bowler,occurrence,allocation,payment/2" as const, organizationId: input.organizationId, leagueId: input.leagueId, mode: "canonical" as const, authoritativeSource: "canonical" as const, asOf, page, limit, totalRows: rows.length, totalTransactions: transactions.length, totals, rows: rows.slice((page - 1) * limit, page * limit), transactions: transactions.slice((page - 1) * limit, page * limit), paymentTiming: { paymentMode: league.paymentMode === "upfront" ? "upfront" as const : "weekly" as const, upfrontDueAt, upfrontDueAtLocal: upfrontDueAt ? leagueLocalDate(upfrontDueAt, timezone) : null, timezone, source: "canonical" as const } };
    return { ...reportWithoutFingerprint, fingerprint: canonicalPaymentReportFingerprint(reportWithoutFingerprint) };
  };
  // Production always supplies a transaction-capable Drizzle database. A few
  // retained receipt-route unit tests intentionally use a minimal db double;
  // preserve their query contract without weakening the production
  // repeatable-read boundary.
  if (typeof db.transaction !== "function") return read(db);
  return db.transaction((tx) => read(tx));
}

export async function readPaymentReceiptProjection(input: { organizationId: number; paymentId: number }) {
    const [paymentIdentity] = await db.select().from(payments).innerJoin(bowlers, eq(bowlers.id, payments.bowlerId)).where(and(eq(payments.id, input.paymentId), eq(payments.organizationId, input.organizationId), eq(bowlers.organizationId, input.organizationId))).limit(1);
  const paymentRecord = paymentIdentity?.payments;
  const report = await readCanonicalPaymentReport({ organizationId: input.organizationId, leagueId: paymentRecord?.leagueId ?? 0, paymentId: input.paymentId, page: 1, limit: 1 });
  const reportRow = report.rows[0];
  if (!paymentRecord || !reportRow) throw new CanonicalPaymentReportIncompatibilityError("payment not found");
  return { payment: paymentRecord, report, row: reportRow };
}
