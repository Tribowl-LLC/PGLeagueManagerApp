import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { bowlers, leagues, paymentAllocations, paymentDisputes, paymentObligations, paymentOperations, payments } from "@shared/schema";
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

function rowStatus(payment: typeof payments.$inferSelect, reviewRequired: boolean): CanonicalPaymentRow["status"] {
  if (reviewRequired) return "review_required";
  if (payment.disputeId) return "disputed";
  if (payment.refundedAt || payment.squareRefundId) return "refunded";
  if (payment.status === "paid") return "confirmed_paid";
  if (payment.status === "pending") return "pending";
  return "failed";
}

export async function readCanonicalPaymentReport(input: CanonicalPaymentReportInput): Promise<CanonicalPaymentReport> {
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (asOfResult.rows[0] as { as_of?: string } | undefined)?.as_of ?? new Date().toISOString();
    const [league] = await tx.select({ timezone: leagues.timezone }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league) throw new CanonicalPaymentReportIncompatibilityError("league not found");
    const conditions = [eq(payments.leagueId, input.leagueId)];
    if (input.bowlerId !== undefined) conditions.push(eq(payments.bowlerId, input.bowlerId));
    if (input.paymentId !== undefined) conditions.push(eq(payments.id, input.paymentId));
    const paymentRows = await tx.select().from(payments).innerJoin(bowlers, eq(bowlers.id, payments.bowlerId)).where(and(...conditions, eq(bowlers.organizationId, input.organizationId))).orderBy(desc(payments.weekOf), desc(payments.id));
    const allPayments = paymentRows.map((row) => row.payments);
    const paymentIds = allPayments.map((row) => row.id);
    const operationIds = allPayments.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []);
    const allocations = paymentIds.length === 0 ? [] : await tx.select({ allocation: paymentAllocations, obligation: paymentObligations }).from(paymentAllocations).innerJoin(paymentObligations, and(eq(paymentObligations.id, paymentAllocations.obligationId), eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId))).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), inArray(paymentAllocations.paymentId, paymentIds)));
    const operations = operationIds.length === 0 ? [] : await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), inArray(paymentOperations.id, operationIds)));
    const disputes = operationIds.length === 0 ? [] : await tx.select().from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, operationIds))).orderBy(desc(paymentDisputes.updatedAt));
    const rows: CanonicalPaymentRow[] = allPayments.map((payment) => {
      const linked = allocations.filter((candidate) => candidate.allocation.paymentId === payment.id);
      const operation = operations.find((candidate) => candidate.id === payment.paymentOperationId);
      const dispute = operation ? disputes.find((candidate) => candidate.paymentOperationId === operation.id) : undefined;
      const reviewRequired = linked.some((candidate) => candidate.allocation.reviewRequired) || Boolean(dispute && !["WON", "CLOSED"].includes(dispute.state));
      const allocationRows = linked.map((candidate) => ({ allocationId: candidate.allocation.id, obligationId: candidate.obligation.id, occurrenceId: candidate.obligation.occurrenceId, bowlerId: candidate.obligation.payerBowlerId, amountMinor: candidate.allocation.amountMinor, currency: candidate.allocation.currency, state: candidate.allocation.state === "active" ? "active" as const : "voided" as const }));
      const allocatedMinor = allocationRows.filter((candidate) => candidate.state === "active").reduce((sum, candidate) => sum + candidate.amountMinor, 0);
      const refundAmount = payment.refundedAt || payment.squareRefundId ? payment.amount : 0;
      const row: CanonicalPaymentRow = {
        paymentId: payment.id,
        leagueId: payment.leagueId,
        bowlerId: payment.bowlerId,
        amountMinor: payment.amount,
        currency: "USD",
        status: rowStatus(payment, reviewRequired),
        paymentType: payment.type === "cash" || payment.type === "check" ? payment.type : payment.type === "square" ? "square" : "credit_card",
        businessDate: payment.weekOf,
        authoritativeLocalDate: payment.weekOf.slice(0, 10),
        providerPaymentId: payment.providerPaymentId,
        paymentOperationId: payment.paymentOperationId,
        operationType: operation?.operationType ?? null,
        operationStatus: operation?.status ?? null,
        allocatedMinor,
        unallocatedMinor: Math.max(0, payment.amount - allocatedMinor),
        reviewRequired,
        source: linked.length > 0 ? "canonical_allocation" : "unlinked_legacy",
        unresolved: operation?.status === "provider_unknown" || operation?.status === "reconciliation_required",
        refund: { present: refundAmount > 0, amountMinor: refundAmount, providerRefundId: payment.squareRefundId },
        dispute: { present: Boolean(dispute || payment.disputeId), amountMinor: dispute?.amountMinor ?? (payment.disputeId ? payment.amount : 0), disputeId: dispute?.providerDisputeId ?? payment.disputeId, scope: "transaction", state: dispute?.state ?? null, reviewRequired },
        receipt: { contractVersion: "payment-receipt/1", availability: payment.receiptUrl ? "available" : "unavailable", receiptUrl: payment.receiptUrl, receiptNumber: payment.receiptNumber, deliveryEvidence: "delivery_not_recorded", source: linked.length > 0 ? "canonical_allocation" : "unlinked_legacy", refund: { present: refundAmount > 0, amountMinor: refundAmount, providerRefundId: payment.squareRefundId }, dispute: { present: Boolean(dispute || payment.disputeId), amountMinor: dispute?.amountMinor ?? 0, disputeId: dispute?.providerDisputeId ?? payment.disputeId, scope: "transaction", state: dispute?.state ?? null, reviewRequired } },
        allocations: allocationRows,
        sharedTransaction: payment.combinedChargeGroupId ? { groupKey: payment.combinedChargeGroupId, childCount: 0 } : null,
        initiatingPayerBowlerId: payment.paidByUserId ? payment.bowlerId : null,
      };
      return row;
    });
    const grouped = new Map<string, CanonicalPaymentRow[]>();
    for (const row of rows) grouped.set(row.sharedTransaction?.groupKey ?? `payment:${row.paymentId}`, [...(grouped.get(row.sharedTransaction?.groupKey ?? `payment:${row.paymentId}`) ?? []), row]);
    const transactions = [...grouped.entries()].map(([groupKey, groupedRows]) => ({ groupKey, paymentOperationId: groupedRows[0]?.paymentOperationId ?? null, combinedChargeGroupId: groupedRows[0]?.sharedTransaction?.groupKey ?? null, amountMinor: groupedRows.reduce((sum, row) => sum + row.amountMinor, 0), currency: "USD", paymentIds: groupedRows.flatMap((row) => row.paymentId ? [row.paymentId] : []), rows: groupedRows }));
    const totals: CanonicalPaymentReportTotals = {
      grossConfirmedPaidMinor: rows.filter((row) => row.status === "confirmed_paid" || row.status === "refunded" || row.status === "disputed").reduce((sum, row) => sum + row.amountMinor, 0),
      activeAllocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
      refundedMinor: rows.reduce((sum, row) => sum + row.refund.amountMinor, 0),
      disputedReviewRequiredMinor: rows.filter((row) => row.reviewRequired && row.dispute.present).reduce((sum, row) => sum + row.dispute.amountMinor, 0),
      reviewRequiredMinor: rows.filter((row) => row.reviewRequired).reduce((sum, row) => sum + row.amountMinor, 0),
      unresolvedOperationMinor: rows.filter((row) => row.unresolved).reduce((sum, row) => sum + row.amountMinor, 0),
      unallocatedLegacyMinor: rows.filter((row) => row.source === "unlinked_legacy").reduce((sum, row) => sum + row.unallocatedMinor, 0),
    };
    const reportWithoutFingerprint = { contractVersion: "canonical-payment-report/1" as const, orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, mode: rows.some((row) => row.source === "unlinked_legacy") ? "canonical_with_unlinked_history" as const : "canonical" as const, authoritativeSource: "canonical" as const, asOf, page, limit, totalRows: rows.length, totalTransactions: transactions.length, totals, rows: rows.slice((page - 1) * limit, page * limit), transactions: transactions.slice((page - 1) * limit, page * limit), unlinkedHistory: rows.filter((row) => row.source === "unlinked_legacy"), paymentTiming: { paymentMode: "weekly" as const, upfrontDueAt: null, timezone: league.timezone ?? "UTC", source: "legacy_league" as const } };
    return { ...reportWithoutFingerprint, fingerprint: canonicalPaymentReportFingerprint(reportWithoutFingerprint) };
  });
}

export async function readPaymentReceiptProjection(input: { organizationId: number; paymentId: number }) {
  const [paymentIdentity] = await db.select().from(payments).innerJoin(bowlers, eq(bowlers.id, payments.bowlerId)).where(and(eq(payments.id, input.paymentId), eq(bowlers.organizationId, input.organizationId))).limit(1);
  const paymentRecord = paymentIdentity?.payments;
  const report = await readCanonicalPaymentReport({ organizationId: input.organizationId, leagueId: paymentRecord?.leagueId ?? 0, paymentId: input.paymentId, page: 1, limit: 1 });
  const reportRow = report.rows[0];
  if (!paymentRecord || !reportRow) throw new CanonicalPaymentReportIncompatibilityError("payment not found");
  return { payment: paymentRecord, report, row: reportRow };
}
