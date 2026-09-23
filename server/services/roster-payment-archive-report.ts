import { aliasedTable, and, asc, desc, eq, exists, inArray, sql, or } from "drizzle-orm";
import { db } from "../db.js";
import { bowlers, leagueOccurrences, leagues, paymentAllocationCorrections, paymentAllocations, paymentDisputes, paymentObligations, paymentOperations, paymentOperationRosterSnapshots, paymentOperationRosterSnapshotItems, paymentVoids, payments, refundAllocationAdjustments, rotatingCreditApplications, rotatingCreditApplicationReversals, rotatingCreditFundings, rotatingCreditPaymentOperationSnapshots, rotatingCreditRefundOperationSnapshots, rotatingCreditRefunds, type PaymentAllocationCorrection } from "@shared/schema";
import type { CanonicalPaymentReport, CanonicalPaymentRow, CanonicalPaymentReportTotals } from "@shared/canonical-payment-report";
import { canonicalCreditFundingSource, canonicalPaymentReportFingerprint } from "@shared/canonical-payment-report";
import { paymentVisibilityCondition } from "../storage/payments.js";

export class CanonicalPaymentReportIncompatibilityError extends Error {}

export interface CanonicalPaymentReportInput {
  organizationId: number;
  leagueId: number;
  bowlerId?: number;
  paymentId?: number;
  page?: number;
  limit?: number;
}

type CorrectionAllocationEvidence = {
  allocation: typeof paymentAllocations.$inferSelect;
  obligation: typeof paymentObligations.$inferSelect;
};

type CorrectionSnapshotEvidence = {
  snapshot: typeof paymentOperationRosterSnapshots.$inferSelect;
  item: typeof paymentOperationRosterSnapshotItems.$inferSelect;
};

/**
 * A corrected Square payment keeps its original operation snapshot immutable.
 * The report therefore validates the source against the original finalized
 * item, then validates the active replacement against the transformed item
 * set. Any mismatch remains unresolved and is never projected as paid.
 */
function validateHistoricalSquareCorrection(input: {
  payment: typeof payments.$inferSelect;
  operation: typeof paymentOperations.$inferSelect | undefined;
  linked: CorrectionAllocationEvidence[];
  corrections: PaymentAllocationCorrection[];
  expectedSnapshots: CorrectionSnapshotEvidence[];
}): { valid: boolean; sourceAllocationIds: Set<string> } {
  const sourceAllocationIds = new Set(input.corrections.map((row) => row.sourceAllocationId));
  if (input.corrections.length === 0
    || input.payment.type !== "square"
    || !input.operation
    || input.operation.status !== "succeeded"
    || input.operation.operationType === "refund"
    || input.operation.amountMinor !== input.payment.amount
    || input.operation.currency !== input.payment.currency
    || input.operation.providerObjectId === null
    || input.operation.providerObjectId !== input.payment.providerPaymentId) {
    return { valid: false, sourceAllocationIds };
  }

  const allocationById = new Map(input.linked.map((row) => [row.allocation.id, row]));
  const sourceObligationIds = new Set<string>();
  const targetObligationIds = new Set<string>();
  const replacementAllocationIds = new Set<string>();
  for (const correction of input.corrections) {
    const source = allocationById.get(correction.sourceAllocationId);
    const replacement = allocationById.get(correction.replacementAllocationId);
    if (correction.organizationId !== input.payment.organizationId
      || correction.leagueId !== input.payment.leagueId
      || correction.paymentId !== input.payment.id
      || correction.currency !== input.payment.currency
      || correction.reason.trim().length === 0
      || !source
      || source.allocation.paymentId !== input.payment.id
      || source.allocation.organizationId !== input.payment.organizationId
      || source.allocation.leagueId !== input.payment.leagueId
      || source.allocation.state !== "voided"
      || source.allocation.allocationKind !== "ordinary"
      || source.allocation.amountMinor !== correction.amountMinor
      || source.allocation.currency !== correction.currency
      || source.allocation.obligationId !== correction.sourceObligationId
      || !replacement
      || replacement.allocation.id === source.allocation.id
      || replacement.allocation.paymentId !== input.payment.id
      || replacement.allocation.organizationId !== input.payment.organizationId
      || replacement.allocation.leagueId !== input.payment.leagueId
      || replacement.allocation.state !== "active"
      || replacement.allocation.allocationKind !== "ordinary"
      || replacement.allocation.amountMinor !== correction.amountMinor
      || replacement.allocation.currency !== correction.currency
      || replacement.allocation.obligationId !== correction.targetObligationId
      || sourceObligationIds.has(correction.sourceObligationId)
      || targetObligationIds.has(correction.targetObligationId)
      || replacementAllocationIds.has(correction.replacementAllocationId)
      || correction.sourceObligationId === correction.targetObligationId) {
      return { valid: false, sourceAllocationIds };
    }
    sourceObligationIds.add(correction.sourceObligationId);
    targetObligationIds.add(correction.targetObligationId);
    replacementAllocationIds.add(correction.replacementAllocationId);
  }

  const ordinaryVoided = input.linked.filter((row) => row.allocation.state === "voided" && row.allocation.allocationKind === "ordinary");
  if (ordinaryVoided.length !== input.corrections.length
    || ordinaryVoided.some((row) => !sourceAllocationIds.has(row.allocation.id))) {
    return { valid: false, sourceAllocationIds };
  }
  if (input.expectedSnapshots.length === 0
    || input.expectedSnapshots.some((row) => row.item.state !== "finalized")) {
    return { valid: false, sourceAllocationIds };
  }

  const expected = input.expectedSnapshots.map((row) => {
    const correction = input.corrections.find((candidate) => candidate.sourceObligationId === row.item.obligationId);
    return {
      obligationId: correction?.targetObligationId ?? row.item.obligationId,
      amountMinor: row.item.amountMinor,
      currency: row.snapshot.currency,
    };
  });
  const active = input.linked
    .filter((row) => row.allocation.state === "active")
    .map((row) => ({ obligationId: row.allocation.obligationId, amountMinor: row.allocation.amountMinor, currency: row.allocation.currency }));
  if (active.length !== expected.length) return { valid: false, sourceAllocationIds };
  const unmatched = [...active];
  for (const expectedRow of expected) {
    const index = unmatched.findIndex((row) => row.obligationId === expectedRow.obligationId
      && row.amountMinor === expectedRow.amountMinor
      && row.currency === expectedRow.currency);
    if (index < 0) return { valid: false, sourceAllocationIds };
    unmatched.splice(index, 1);
  }
  return { valid: unmatched.length === 0, sourceAllocationIds };
}

function rowStatus(payment: typeof payments.$inferSelect, reviewRequired: boolean, corrected: boolean): CanonicalPaymentRow["status"] {
  // An unproven manual correction remains review-required. A proven
  // same-parent Square correction is represented by the active replacement
  // set and can retain the provider payment's confirmed-paid status.
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
    // Fetch the tenant/league tender set before applying a bowler filter. A
    // combined charge is owned by its payer at the parent row, while a
    // recipient owns only the child allocation(s); filtering the parent here
    // would hide partner-paid balances from the recipient's history.
    const conditions = [eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId)];
    if (input.bowlerId !== undefined) {
      const bowlerPaymentScope = or(
        eq(payments.bowlerId, input.bowlerId),
        exists(tx.select({ id: paymentAllocations.id }).from(paymentAllocations).innerJoin(paymentObligations, and(
          eq(paymentObligations.id, paymentAllocations.obligationId),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
        )).where(and(
          eq(paymentAllocations.paymentId, payments.id),
          eq(paymentAllocations.organizationId, input.organizationId),
          eq(paymentAllocations.leagueId, input.leagueId),
          eq(paymentObligations.payerBowlerId, input.bowlerId),
        )),
        ),
      );
      if (bowlerPaymentScope) conditions.push(bowlerPaymentScope);
    }
    if (input.paymentId !== undefined) conditions.push(eq(payments.id, input.paymentId));
    const paymentRows = await tx.select().from(payments).innerJoin(bowlers, eq(bowlers.id, payments.bowlerId)).where(and(...conditions, paymentVisibilityCondition(), eq(bowlers.organizationId, input.organizationId))).orderBy(desc(payments.createdAt), desc(payments.id));
    const allPayments = paymentRows.map((row) => row.payments);
    const paymentIds = allPayments.map((row) => row.id);
    const operationIds = allPayments.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []);
    const payerNameById = new Map(paymentRows.map((row) => [row.payments.bowlerId, row.bowlers.name]));
    const fundingRows = paymentIds.length === 0 ? [] : await tx.select().from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
      inArray(rotatingCreditFundings.paymentId, paymentIds),
    ));
    const fundingByPaymentId = new Map(fundingRows.map((row) => [row.paymentId, row]));
    const creditRefundRows = fundingRows.length === 0 ? [] : await tx.select().from(rotatingCreditRefunds).where(and(
      eq(rotatingCreditRefunds.organizationId, input.organizationId),
      eq(rotatingCreditRefunds.leagueId, input.leagueId),
      inArray(rotatingCreditRefunds.fundingId, fundingRows.map((row) => row.id)),
    )).orderBy(asc(rotatingCreditRefunds.createdAt), asc(rotatingCreditRefunds.id));
    const creditRefundOperationIds = [...new Set(creditRefundRows.flatMap((row) => row.refundOperationId ? [row.refundOperationId] : []))];
    const creditRefundOperations = creditRefundOperationIds.length === 0 ? [] : await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      inArray(paymentOperations.id, creditRefundOperationIds),
    ));
    const creditRefundOperationById = new Map(creditRefundOperations.map((row) => [row.id, row]));
    const creditRefundSnapshots = creditRefundOperationIds.length === 0 ? [] : await tx.select().from(rotatingCreditRefundOperationSnapshots).where(and(
      eq(rotatingCreditRefundOperationSnapshots.organizationId, input.organizationId),
      eq(rotatingCreditRefundOperationSnapshots.leagueId, input.leagueId),
      inArray(rotatingCreditRefundOperationSnapshots.operationId, creditRefundOperationIds),
    ));
    const creditRefundSnapshotByOperationId = new Map(creditRefundSnapshots.map((row) => [row.operationId, row]));
    const creditRefundsByFundingId = new Map<string, typeof creditRefundRows>();
    for (const row of creditRefundRows) {
      creditRefundsByFundingId.set(row.fundingId, [...(creditRefundsByFundingId.get(row.fundingId) ?? []), row]);
    }
    const creditOperationSnapshots = operationIds.length === 0 ? [] : await tx.select().from(rotatingCreditPaymentOperationSnapshots).where(and(
      eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
      eq(rotatingCreditPaymentOperationSnapshots.leagueId, input.leagueId),
      inArray(rotatingCreditPaymentOperationSnapshots.operationId, operationIds),
    ));
    const creditSnapshotByOperationId = new Map(creditOperationSnapshots.map((row) => [row.operationId, row]));
    const allocations = paymentIds.length === 0 ? [] : await tx.select({
      allocation: paymentAllocations,
      obligation: paymentObligations,
      occurrence: leagueOccurrences,
      recipient: { id: bowlers.id, name: bowlers.name },
      creditApplication: rotatingCreditApplications,
    }).from(paymentAllocations)
      .innerJoin(paymentObligations, and(
        eq(paymentObligations.id, paymentAllocations.obligationId),
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
      ))
      .leftJoin(rotatingCreditApplications, and(
        eq(rotatingCreditApplications.allocationId, paymentAllocations.id),
        eq(rotatingCreditApplications.organizationId, input.organizationId),
        eq(rotatingCreditApplications.leagueId, input.leagueId),
      ))
      .innerJoin(leagueOccurrences, and(
        eq(leagueOccurrences.id, paymentObligations.occurrenceId),
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
      ))
      .leftJoin(bowlers, and(
        eq(bowlers.id, sql<number>`COALESCE(${rotatingCreditApplications.actualBowlerId}, ${paymentObligations.payerBowlerId})`),
        eq(bowlers.organizationId, input.organizationId),
      ))
      .where(and(
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
        inArray(paymentAllocations.paymentId, paymentIds),
      )).orderBy(asc(leagueOccurrences.authoritativeLocalDate), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentAllocations.id));
    if (allocations.some((row) => row.recipient === null || row.recipient.id === null)) {
      throw new CanonicalPaymentReportIncompatibilityError("an allocation is missing payer or confirmed participant identity");
    }
    const creditApplicationIds = allocations.flatMap((row) => row.creditApplication ? [row.creditApplication.id] : []);
    const creditReversals = creditApplicationIds.length === 0 ? [] : await tx.select().from(rotatingCreditApplicationReversals).where(and(
      eq(rotatingCreditApplicationReversals.organizationId, input.organizationId),
      eq(rotatingCreditApplicationReversals.leagueId, input.leagueId),
      inArray(rotatingCreditApplicationReversals.applicationId, creditApplicationIds),
    ));
    const creditReversalByApplicationId = new Map(creditReversals.map((row) => [row.applicationId, row]));
    const allocationIds = allocations.map((row) => row.allocation.id);
    const refundAdjustments = allocationIds.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocationIds),
      ));
    const refundAdjustmentByAllocationId = new Map(refundAdjustments.map((row) => [row.sourceAllocationId, row]));
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
    const allocationCorrections = paymentIds.length === 0 ? [] : await tx.select().from(paymentAllocationCorrections).where(and(
      eq(paymentAllocationCorrections.organizationId, input.organizationId),
      eq(paymentAllocationCorrections.leagueId, input.leagueId),
      inArray(paymentAllocationCorrections.paymentId, paymentIds),
    ));
    const correctionsByPaymentId = new Map<number, PaymentAllocationCorrection[]>();
    for (const correction of allocationCorrections) {
      correctionsByPaymentId.set(correction.paymentId, [...(correctionsByPaymentId.get(correction.paymentId) ?? []), correction]);
    }
    const disputes = operationIds.length === 0 ? [] : await tx.select().from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, operationIds))).orderBy(desc(paymentDisputes.updatedAt));
    const visiblePayments = input.bowlerId === undefined
      ? allPayments
      : allPayments.filter((payment) => payment.bowlerId === input.bowlerId || allocations.some((candidate) => candidate.allocation.paymentId === payment.id && candidate.recipient?.id === input.bowlerId));
    const rows: CanonicalPaymentRow[] = visiblePayments.map((payment) => {
      const linked = allocations.filter((candidate) => candidate.allocation.paymentId === payment.id);
      const funding = fundingByPaymentId.get(payment.id);
      const isCreditFunding = funding !== undefined;
      const refundRowsForFunding = funding ? creditRefundsByFundingId.get(funding.id) ?? [] : [];
      if (linked.length === 0 && payment.paymentOperationId === null && !isCreditFunding) {
        throw new CanonicalPaymentReportIncompatibilityError("payment has no canonical allocation evidence");
      }
      const operation = operations.find((candidate) => candidate.id === payment.paymentOperationId);
      const creditSnapshot = payment.paymentOperationId === null ? undefined : creditSnapshotByOperationId.get(payment.paymentOperationId);
      const dispute = operation ? disputes.find((candidate) => candidate.paymentOperationId === operation.id) : undefined;
      const voidEvidence = voids.find((candidate) => candidate.paymentId === payment.id);
      // A provider operation is not confirmed financial evidence until its
      // immutable roster reservation has an active canonical allocation. A
      // payment row can exist after provider success but before (or instead
      // of) local allocation finalization; keep its operation identity for
      // recovery, but fail closed in F5 rather than counting it as paid.
      const expectedSnapshots = payment.paymentOperationId !== null
        ? operationSnapshotItems.filter((candidate) => candidate.item.operationId === payment.paymentOperationId)
        : [];
      const historicalCorrection = validateHistoricalSquareCorrection({
        payment,
        operation,
        linked: linked.map((candidate) => ({ allocation: candidate.allocation, obligation: candidate.obligation })),
        corrections: correctionsByPaymentId.get(payment.id) ?? [],
        expectedSnapshots,
      });
      const ordinaryVoidedAllocation = linked.some((candidate) => candidate.allocation.state === "voided"
        && !(isCreditFunding && candidate.creditApplication && creditReversalByApplicationId.has(candidate.creditApplication.id))
        && !historicalCorrection.sourceAllocationIds.has(candidate.allocation.id));
      const corrected = Boolean(voidEvidence) || (ordinaryVoidedAllocation && !historicalCorrection.valid);
      // Every operation-linked parent must reconcile to every immutable
      // snapshot item and matching active allocation.
      const activeLinked = linked.filter((candidate) => candidate.allocation.state === "active");
      const activeTotal = activeLinked.reduce((sum, candidate) => sum + candidate.allocation.amountMinor, 0);
      const validFundingIdentity = funding !== undefined
        && funding.organizationId === payment.organizationId
        && funding.leagueId === payment.leagueId
        && funding.bowlerId === payment.bowlerId
        && funding.amountMinor === payment.amount
        && funding.currency === payment.currency
        && ((funding.fundingKind === "provider" && (payment.type === "square" || payment.type === "credit_card"))
          || (funding.fundingKind === "cash" && payment.type === "cash")
          || (funding.fundingKind === "check" && payment.type === "check"));
      const validCreditChildren = isCreditFunding && linked.every((candidate) => {
        const application = candidate.creditApplication;
        if (!funding || !application
          || application.fundingId !== funding.id
          || application.paymentId !== payment.id
          || application.organizationId !== input.organizationId
          || application.leagueId !== input.leagueId
          || application.actualBowlerId !== candidate.recipient?.id
          || application.obligationId !== candidate.obligation.id
          || application.occurrenceId !== candidate.obligation.occurrenceId
          || application.amountMinor !== candidate.allocation.amountMinor
          || application.currency !== candidate.allocation.currency) return false;
        const reversal = creditReversalByApplicationId.get(application.id);
        if (candidate.allocation.state === "active") return reversal === undefined;
        return reversal !== undefined
          && reversal.organizationId === input.organizationId
          && reversal.leagueId === input.leagueId
          && reversal.fundingPaymentId === payment.id
          && reversal.allocationId === candidate.allocation.id
          && reversal.obligationId === candidate.obligation.id
          && reversal.assignmentId === application.assignmentId
          && reversal.bowlerId === application.actualBowlerId
          && reversal.amountMinor === candidate.allocation.amountMinor;
      });
      const validProviderCreditOperation = payment.paymentOperationId === null
        ? funding?.fundingKind !== "provider"
        : Boolean(creditSnapshot
          && operation
          && operation.operationType === "interactive_charge"
          && operation.status === "succeeded"
          && operation.amountMinor === payment.amount
          && operation.providerObjectId === payment.providerPaymentId
          && creditSnapshot.bowlerId === funding?.bowlerId
          && creditSnapshot.amountMinor === payment.amount
          && creditSnapshot.currency === payment.currency);
      let completedCreditRefundMinor = 0;
      let heldCreditRefundMinor = 0;
      let creditRefundReviewRequired = false;
      const completedProviderRefundIds: string[] = [];
      for (const refund of refundRowsForFunding) {
        if (!funding
          || refund.organizationId !== input.organizationId
          || refund.leagueId !== input.leagueId
          || refund.fundingId !== funding.id
          || refund.paymentId !== payment.id
          || refund.bowlerId !== funding.bowlerId
          || refund.amountMinor <= 0
          || refund.currency !== payment.currency
          || refund.reason.trim().length === 0) {
          throw new CanonicalPaymentReportIncompatibilityError("credit refund identity does not match its funding tender");
        }
        if (refund.refundKind === "cash" || refund.refundKind === "check") {
          if (refund.refundOperationId !== null
            || refund.issuedAt === null
            || !refund.reference?.trim()
            || !refund.actorUserId) {
            throw new CanonicalPaymentReportIncompatibilityError("manual credit refund is missing issuance evidence");
          }
          completedCreditRefundMinor += refund.amountMinor;
          continue;
        }
        const refundOperation = refund.refundOperationId ? creditRefundOperationById.get(refund.refundOperationId) : undefined;
        const refundSnapshot = refund.refundOperationId ? creditRefundSnapshotByOperationId.get(refund.refundOperationId) : undefined;
        if (!refundOperation || !refundSnapshot
          || refundOperation.operationType !== "refund"
          || refundOperation.amountMinor !== refund.amountMinor
          || refundSnapshot.fundingId !== funding.id
          || refundSnapshot.paymentId !== payment.id
          || refundSnapshot.bowlerId !== funding.bowlerId
          || refundSnapshot.amountMinor !== refund.amountMinor
          || refundSnapshot.currency !== payment.currency
          || refundSnapshot.providerPaymentId !== payment.providerPaymentId
          || refundSnapshot.reason !== refund.reason) {
          throw new CanonicalPaymentReportIncompatibilityError("provider credit refund does not match its immutable operation snapshot");
        }
        if (["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"].includes(refundOperation.status)) {
          heldCreditRefundMinor += refund.amountMinor;
          creditRefundReviewRequired = true;
        } else if (refundOperation.status === "action_required") {
          const confirmedNoRefund = refundOperation.providerObjectId === null
            && refundOperation.errorClassification === "hard_decline"
            && refundOperation.errorCode === "REFUND_DECLINED";
          if (!confirmedNoRefund) {
            heldCreditRefundMinor += refund.amountMinor;
            creditRefundReviewRequired = true;
          }
        } else if (refundOperation.status === "succeeded") {
          if (!refundOperation.providerObjectId) {
            throw new CanonicalPaymentReportIncompatibilityError("completed provider credit refund is missing its provider identity");
          }
          completedCreditRefundMinor += refund.amountMinor;
          completedProviderRefundIds.push(refundOperation.providerObjectId);
        } else if (refundOperation.status === "failed_terminal") {
          const confirmedNoRefund = refundOperation.errorClassification === "invalid_request"
            && (refundOperation.errorCode === "REFUND_REJECTED" || refundOperation.errorCode === "REFUND_FAILED");
          if (refundOperation.providerObjectId !== null && !confirmedNoRefund) {
            heldCreditRefundMinor += refund.amountMinor;
            creditRefundReviewRequired = true;
          }
        } else if (refundOperation.status === "canceled") {
          if (refundOperation.providerObjectId !== null) {
            heldCreditRefundMinor += refund.amountMinor;
            creditRefundReviewRequired = true;
          }
        } else {
          throw new CanonicalPaymentReportIncompatibilityError("provider credit refund has an unsupported operation state");
        }
      }
      if (activeTotal + completedCreditRefundMinor + heldCreditRefundMinor > payment.amount) {
        throw new CanonicalPaymentReportIncompatibilityError("credit applications and refunds exceed their original tender");
      }
      const remainingCreditMinor = isCreditFunding
        ? payment.amount - activeTotal - completedCreditRefundMinor - heldCreditRefundMinor
        : 0;
      const creditRefundSummary = isCreditFunding ? {
        completedAmountMinor: completedCreditRefundMinor,
        heldAmountMinor: heldCreditRefundMinor,
        reviewRequired: creditRefundReviewRequired,
        providerRefundIds: [...new Set(completedProviderRefundIds)],
      } : undefined;
      const invalidCreditFunding = isCreditFunding && (!validFundingIdentity
        || !validCreditChildren
        || activeTotal > payment.amount
        || !validProviderCreditOperation);
      const invalidCanonicalAllocation = isCreditFunding
        ? invalidCreditFunding
        : payment.paymentOperationId !== null && (
        expectedSnapshots.length === 0
        || (!historicalCorrection.valid && expectedSnapshots.some((expected) => expected.item.state !== "finalized" || !activeLinked.some((candidate) => candidate.allocation.obligationId === expected.item.obligationId && candidate.allocation.amountMinor === expected.item.amountMinor && candidate.allocation.currency === expected.snapshot.currency)))
        || activeLinked.length !== expectedSnapshots.length
        || !operation
        || operation.status !== "succeeded"
        || operation.amountMinor !== payment.amount
        || activeTotal !== payment.amount
        || payment.providerPaymentId !== operation.providerObjectId
      );
      const reviewRequired = invalidCanonicalAllocation
        || linked.some((candidate) => candidate.allocation.reviewRequired)
        || creditRefundReviewRequired
        || Boolean(dispute && !["WON", "INQUIRY_CLOSED"].includes(dispute.state));
      const allocationRows = linked.map((candidate) => {
        if (candidate.recipient === null || candidate.recipient.id === null) {
          throw new CanonicalPaymentReportIncompatibilityError("an allocation is missing payer or confirmed participant identity");
        }
        const adjustment = refundAdjustmentByAllocationId.get(candidate.allocation.id);
        return {
          allocationId: candidate.allocation.id,
          obligationId: candidate.obligation.id,
          occurrenceId: candidate.obligation.occurrenceId,
          occurrenceLocalDate: candidate.occurrence.authoritativeLocalDate,
          plannedOrdinal: candidate.occurrence.plannedOrdinal,
          bowlerId: candidate.recipient.id,
          bowlerName: candidate.recipient.name,
          amountMinor: candidate.allocation.amountMinor,
          refundedMinor: adjustment?.amountMinor ?? 0,
          effectiveAmountMinor: candidate.allocation.state === "active" ? Math.max(0, candidate.allocation.amountMinor - (adjustment?.amountMinor ?? 0)) : 0,
          refundDisposition: adjustment?.disposition ?? null,
          currency: candidate.allocation.currency,
          state: candidate.allocation.state === "active" ? "active" as const : "voided" as const,
        };
      });
      const allocatedMinor = allocationRows.filter((candidate) => candidate.state === "active").reduce((sum, candidate) => sum + candidate.amountMinor, 0);
      const refundedAllocationMinor = allocationRows.filter((candidate) => candidate.state === "active").reduce((sum, candidate) => sum + candidate.refundedMinor, 0);
      const waivedMinor = allocationRows.filter((candidate) => candidate.state === "active" && candidate.refundDisposition === "waived").reduce((sum, candidate) => sum + candidate.refundedMinor, 0);
      const effectiveAllocatedMinor = allocationRows.reduce((sum, candidate) => sum + (candidate.effectiveAmountMinor ?? 0), 0);
      const manualGrossMismatch = !voidEvidence && !isCreditFunding && payment.paymentOperationId === null && allocatedMinor !== payment.amount;
      const refundAmount = isCreditFunding
        ? completedCreditRefundMinor
        : payment.refundedAt || payment.squareRefundId ? payment.amount : 0;
      const providerRefundId = isCreditFunding
        ? completedProviderRefundIds.length === 1 ? completedProviderRefundIds[0] : null
        : payment.squareRefundId;
      const canonicalDate = leagueLocalDate(payment.createdAt, league.timezone);
      const evidenceSource: CanonicalPaymentRow["source"] = invalidCanonicalAllocation || manualGrossMismatch
        ? "unresolved_operation"
        : isCreditFunding
          ? canonicalCreditFundingSource({
            amountMinor: payment.amount,
            allocatedMinor: activeTotal,
            completedRefundMinor: completedCreditRefundMinor,
            heldRefundMinor: heldCreditRefundMinor,
          })
          : linked.length === 0
            ? "unresolved_operation"
            : "canonical_allocation";
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
        grossAllocatedMinor: allocatedMinor,
        refundedAllocationMinor,
        waivedMinor,
        effectiveAllocatedMinor,
        unallocatedMinor: isCreditFunding ? Math.max(0, remainingCreditMinor) : Math.max(0, payment.amount - allocatedMinor),
        reviewRequired: reviewRequired || manualGrossMismatch,
        source: evidenceSource,
        unresolved: invalidCanonicalAllocation || manualGrossMismatch || creditRefundReviewRequired || operation?.status === "provider_unknown" || operation?.status === "reconciliation_required",
        refund: { present: refundAmount > 0, amountMinor: refundAmount, providerRefundId },
        creditRefunds: creditRefundSummary,
        dispute: { present: Boolean(dispute || payment.disputeId), amountMinor: dispute?.amountMinor ?? (payment.disputeId ? payment.amount : 0), disputeId: dispute?.providerDisputeId ?? payment.disputeId, scope: "transaction", state: dispute?.state ?? null, reviewRequired },
        receipt: { contractVersion: "payment-receipt/1", availability: payment.receiptUrl ? "available" : "unavailable", receiptUrl: payment.receiptUrl, receiptNumber: payment.receiptNumber, deliveryEvidence: "delivery_not_recorded", source: evidenceSource, refund: { present: refundAmount > 0, amountMinor: refundAmount, providerRefundId }, dispute: { present: Boolean(dispute || payment.disputeId), amountMinor: dispute?.amountMinor ?? 0, disputeId: dispute?.providerDisputeId ?? payment.disputeId, scope: "transaction", state: dispute?.state ?? null, reviewRequired } },
        allocations: allocationRows,
        correctionEvidence: voidEvidence ? { status: "voided", voidId: voidEvidence.id } : undefined,
        sharedTransaction: null,
        // paidByUserId is a users.id actor and must never be interpreted as a
        // bowler identity. The recipient/payer comes from the canonical
        // tender parent; receipt authorization separately checks the
        // payment actor against users.id.
        initiatingPayerBowlerId: payment.bowlerId,
        paidByName: payerNameById.get(payment.bowlerId) ?? null,
      };
      return row;
    });
    const operationOnlyEvidence = input.paymentId === undefined ? await tx.select({ operation: paymentOperations, snapshot: paymentOperationRosterSnapshots, item: paymentOperationRosterSnapshotItems, obligation: paymentObligations, occurrence: leagueOccurrences, recipient: { id: bowlers.id, name: bowlers.name } })
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
      .innerJoin(leagueOccurrences, and(
        eq(leagueOccurrences.id, paymentObligations.occurrenceId),
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
      ))
      .innerJoin(bowlers, and(
        eq(bowlers.id, paymentObligations.payerBowlerId),
        eq(bowlers.organizationId, input.organizationId),
      ))
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
        inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"] as const),
        input.bowlerId === undefined ? sql`true` : exists((() => {
          const candidateSnapshot = aliasedTable(paymentOperationRosterSnapshots, "candidate_operation_snapshot");
          const candidateItem = aliasedTable(paymentOperationRosterSnapshotItems, "candidate_operation_snapshot_item");
          const candidateObligation = aliasedTable(paymentObligations, "candidate_operation_obligation");
          return tx.select({ id: candidateItem.operationId }).from(candidateItem)
            .innerJoin(candidateSnapshot, and(
              eq(candidateSnapshot.operationId, candidateItem.operationId),
              eq(candidateSnapshot.organizationId, input.organizationId),
              eq(candidateSnapshot.leagueId, input.leagueId),
            ))
            .innerJoin(candidateObligation, and(
              eq(candidateObligation.id, candidateItem.obligationId),
              eq(candidateObligation.organizationId, input.organizationId),
              eq(candidateObligation.leagueId, input.leagueId),
            ))
            .where(and(
              eq(candidateItem.operationId, paymentOperations.id),
              or(eq(candidateSnapshot.payerBowlerId, input.bowlerId), eq(candidateObligation.payerBowlerId, input.bowlerId)),
            ));
        })()),
      )) : [];
    const operationPayerIds = [...new Set(operationOnlyEvidence.flatMap((evidence) => evidence.snapshot.payerBowlerId ? [evidence.snapshot.payerBowlerId] : []))];
    if (operationPayerIds.length > 0) {
      const operationPayers = await tx.select({ id: bowlers.id, name: bowlers.name }).from(bowlers).where(and(eq(bowlers.organizationId, input.organizationId), inArray(bowlers.id, operationPayerIds)));
      for (const payer of operationPayers) payerNameById.set(payer.id, payer.name);
    }
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
      const operationPayerBowlerId = snapshot.payerBowlerId ?? first.obligation.payerBowlerId;
      if (operationPayerBowlerId === null) throw new CanonicalPaymentReportIncompatibilityError("a pending operation has no bowler-owned payer");
      const operationRow: CanonicalPaymentRow = {
        paymentId: null,
        leagueId: input.leagueId,
        bowlerId: operationPayerBowlerId,
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
        grossAllocatedMinor: 0,
        refundedAllocationMinor: 0,
        waivedMinor: 0,
        effectiveAllocatedMinor: 0,
        unallocatedMinor: snapshot.amountMinor,
        reviewRequired: unresolved,
        source: "unresolved_operation",
        unresolved: true,
        refund: { present: false, amountMinor: 0, providerRefundId: null },
        dispute: { present: false, amountMinor: 0, disputeId: null, scope: "transaction", state: null, reviewRequired: unresolved },
        receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded", source: "unresolved_operation", refund: { present: false, amountMinor: 0, providerRefundId: null }, dispute: { present: false, amountMinor: 0, disputeId: null, scope: "transaction", state: null, reviewRequired: unresolved } },
        allocations: evidenceRows.map((row) => {
          if (row.obligation.payerBowlerId === null) throw new CanonicalPaymentReportIncompatibilityError("a pending operation contains team-owned liability");
          return { allocationId: null, obligationId: row.obligation.id, occurrenceId: row.obligation.occurrenceId, occurrenceLocalDate: row.occurrence.authoritativeLocalDate, plannedOrdinal: row.occurrence.plannedOrdinal, bowlerId: row.obligation.payerBowlerId, bowlerName: row.recipient.name, amountMinor: row.item.amountMinor, currency: row.item.state === "released" ? "USD" : snapshot.currency, state: null };
        }),
        sharedTransaction: null,
        initiatingPayerBowlerId: operationPayerBowlerId,
        paidByName: payerNameById.get(operationPayerBowlerId) ?? null,
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
    const scopedTotals = rows.map((row) => {
      const payerOwnsTender = input.bowlerId === undefined || (row.initiatingPayerBowlerId ?? row.bowlerId) === input.bowlerId;
      const scopedAllocations = payerOwnsTender
        ? row.allocations
        : row.allocations.filter((allocation) => allocation.bowlerId === input.bowlerId && allocation.state !== "voided");
      const activeScopedAllocations = scopedAllocations.filter((allocation) => allocation.state === "active");
      const scopedAmount = payerOwnsTender ? row.amountMinor : scopedAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const scopedRefund = payerOwnsTender ? row.refund.amountMinor : scopedAllocations.reduce((sum, allocation) => sum + (allocation.refundedMinor ?? 0), 0);
      const scopedRefundedAllocation = payerOwnsTender
        ? (row.refundedAllocationMinor ?? 0)
        : activeScopedAllocations.reduce((sum, allocation) => sum + (allocation.refundedMinor ?? 0), 0);
      const scopedEffective = payerOwnsTender
        ? (row.effectiveAllocatedMinor ?? row.allocatedMinor)
        : activeScopedAllocations.reduce((sum, allocation) => sum + (allocation.effectiveAmountMinor ?? allocation.amountMinor), 0);
      const scopedAllocated = payerOwnsTender ? row.allocatedMinor : activeScopedAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const scopedDispute = payerOwnsTender ? row.dispute.amountMinor : 0;
      return { row, scopedAmount, scopedRefund, scopedRefundedAllocation, scopedEffective, scopedAllocated, scopedDispute };
    });
    const totals: CanonicalPaymentReportTotals = {
      grossConfirmedPaidMinor: scopedTotals.filter(({ row }) => row.status === "confirmed_paid" || row.status === "refunded" || row.status === "disputed").reduce((sum, item) => sum + item.scopedAmount, 0),
      activeAllocatedMinor: scopedTotals.reduce((sum, item) => sum + item.scopedAllocated, 0),
      refundedMinor: scopedTotals.reduce((sum, item) => sum + item.scopedRefund, 0),
      refundedAllocationMinor: scopedTotals.reduce((sum, item) => sum + item.scopedRefundedAllocation, 0),
      waivedMinor: scopedTotals.reduce((sum, item) => sum + (item.row.initiatingPayerBowlerId === input.bowlerId || input.bowlerId === undefined
        ? (item.row.waivedMinor ?? 0)
        : item.row.allocations.filter((allocation) => allocation.bowlerId === input.bowlerId && allocation.state !== "voided" && allocation.refundDisposition === "waived").reduce((inner, allocation) => inner + (allocation.refundedMinor ?? 0), 0)), 0),
      effectiveAllocatedMinor: scopedTotals.reduce((sum, item) => sum + item.scopedEffective, 0),
      disputedReviewRequiredMinor: scopedTotals.filter(({ row }) => row.reviewRequired).reduce((sum, item) => sum + item.scopedDispute, 0),
      reviewRequiredMinor: scopedTotals.filter(({ row }) => row.reviewRequired).reduce((sum, item) => sum + item.scopedAmount, 0),
      unresolvedOperationMinor: scopedTotals.filter(({ row }) => row.unresolved).reduce((sum, item) => sum + item.scopedAmount, 0),
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
  const [paymentIdentity] = await db.select().from(payments).innerJoin(bowlers, eq(bowlers.id, payments.bowlerId)).where(and(
    eq(payments.id, input.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(bowlers.organizationId, input.organizationId),
    paymentVisibilityCondition(),
  )).limit(1);
  const paymentRecord = paymentIdentity?.payments;
  if (!paymentRecord) throw new CanonicalPaymentReportIncompatibilityError("payment not found");
  const report = await readCanonicalPaymentReport({ organizationId: input.organizationId, leagueId: paymentRecord.leagueId, paymentId: input.paymentId, page: 1, limit: 1 });
  const reportRow = report.rows[0];
  if (!reportRow) throw new CanonicalPaymentReportIncompatibilityError("payment not found");
  return { payment: paymentRecord, report, row: reportRow };
}
