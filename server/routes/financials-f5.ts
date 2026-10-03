import { Router } from "express";
import { parseOptionalIntParam, sendError, sendSuccess } from "../utils/api.js";
import {
  hasAdminAccessToLeague,
  hasPaymentManagerAccessToLeague,
  isPaymentManager,
} from "../utils/access-control.js";
import { storage } from "../storage/index.js";
import {
  CanonicalPaymentReportIncompatibilityError,
  readCanonicalPaymentReport,
} from "../services/roster-payment-archive-report.js";
import { canonicalCreditFundingSource, canonicalPaymentReportFingerprint, type CanonicalPaymentAppliedToRow } from "@shared/canonical-payment-report";

const router = Router();

function positiveQuery(value: unknown): number | undefined | null {
  const parsed = parseOptionalIntParam(value);
  if (parsed === undefined) return undefined;
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

function pageQuery(value: unknown, fallback: number): number | undefined | null {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Keep the ordinary-reader projection in one pure function so the API and
 * the evidence dialog can be regression-tested against the same response
 * shape. The full allocation rows remain an admin/reconciliation concern.
 */
export function redactCanonicalPaymentRow(row: Awaited<ReturnType<typeof readCanonicalPaymentReport>>["rows"][number], viewerBowlerId: number | null | undefined) {
  const ownAllocations = row.allocations.filter((allocation) => allocation.bowlerId === viewerBowlerId);
  const ownFundingPortions = (row.fundingPortions ?? []).filter((portion) => portion.creditedBowlerId === viewerBowlerId);
  const isFundingOwner = ownFundingPortions.length > 0;
  const isInitiatingPayer = row.initiatingPayerBowlerId !== null
    && row.initiatingPayerBowlerId !== undefined
    && row.initiatingPayerBowlerId === viewerBowlerId;
  const fundingRecipientIds = (row.fundingPortions ?? []).flatMap((portion) => portion.creditedBowlerId === undefined ? [] : [portion.creditedBowlerId]);
  const allRecipientIds = [...row.allocations.map((allocation) => allocation.bowlerId), ...fundingRecipientIds];
  const isSelfOnlyPayment = isInitiatingPayer
    && row.allocations.length > 0
    && row.allocations.every((allocation) => allocation.bowlerId === viewerBowlerId)
    && fundingRecipientIds.every((bowlerId) => bowlerId === viewerBowlerId);
  const visibleAllocations = isInitiatingPayer ? row.allocations : ownAllocations;
  const nonVoidedVisibleAllocations = visibleAllocations.filter((allocation) => allocation.state !== "voided");
  const activeVisibleAllocations = visibleAllocations.filter((allocation) => allocation.state === "active");
  const authorizedAmount = activeVisibleAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  const visibleTenderAmount = nonVoidedVisibleAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  const authorizedRefundedAmount = activeVisibleAllocations.reduce((sum, allocation) => sum + (allocation.refundedMinor ?? 0), 0);
  const authorizedWaivedAmount = activeVisibleAllocations.reduce((sum, allocation) => sum + (allocation.refundDisposition === "waived" ? (allocation.refundedMinor ?? 0) : 0), 0);
  const authorizedEffectiveAmount = activeVisibleAllocations.reduce((sum, allocation) => sum + (allocation.effectiveAmountMinor ?? allocation.amountMinor), 0);
  const hasCanonicalOwnership = activeVisibleAllocations.length > 0;
  const ownFundingAmount = ownFundingPortions.reduce((sum, portion) => sum + portion.amountMinor, 0);
  const ownFundingAvailable = ownFundingPortions.reduce((sum, portion) => sum + portion.availableMinor, 0);
  const ownFundingRefunded = ownFundingPortions.reduce((sum, portion) => sum + portion.refundedCreditMinor, 0);
  const ownFundingTotalRefunded = ownFundingPortions.reduce((sum, portion) => sum + portion.totalRefundedMinor, 0);
  const ownFundingHeld = ownFundingPortions.reduce((sum, portion) => sum + portion.heldCreditMinor, 0);
  const safeAmount = isInitiatingPayer ? row.amountMinor : isFundingOwner ? ownFundingAmount : visibleTenderAmount;
  const safeRefundAmount = isInitiatingPayer ? row.refund.amountMinor : isFundingOwner ? ownFundingTotalRefunded : authorizedRefundedAmount;
  const safeRefundPresent = isInitiatingPayer
    ? row.refund.present
    : isFundingOwner ? ownFundingTotalRefunded > 0 : authorizedRefundedAmount > 0;
  const safeDisputeAmount = isInitiatingPayer ? row.dispute.amountMinor : 0;
  const safeUnresolved = isInitiatingPayer
    ? row.unresolved
    : isFundingOwner ? ownFundingPortions.some((portion) => portion.reviewRequired) : false;
  const canOpenReceipt = isInitiatingPayer
    && row.paymentId !== null
    && ["confirmed_paid", "refunded", "disputed"].includes(row.status);
  const hasMultipleRecipients = isInitiatingPayer
    ? new Set(allRecipientIds).size > 1
    : undefined;
  const {
    initiatingPayerBowlerId: _initiatingPayerBowlerId,
    hasMultipleRecipients: _hasMultipleRecipients,
    paidByName: _paidByName,
    creditRefunds,
    fundingPortions: _fundingPortions,
    correctionEvidence,
    ...safeRow
  } = row;
  const appliedTo: CanonicalPaymentAppliedToRow[] = visibleAllocations.map((allocation) => ({
    plannedOrdinal: allocation.plannedOrdinal ?? null,
    occurrenceLocalDate: allocation.occurrenceLocalDate ?? null,
    amountMinor: allocation.amountMinor,
    ...(isInitiatingPayer && allocation.bowlerName ? { bowlerName: allocation.bowlerName } : {}),
    refundedMinor: allocation.refundedMinor ?? 0,
    ...(allocation.effectiveAmountMinor === undefined ? {} : { effectiveAmountMinor: allocation.effectiveAmountMinor }),
    refundDisposition: allocation.refundDisposition ?? null,
    ...(isSelfOnlyPayment && allocation.isFinalPairedWeek === true ? { isFinalPairedWeek: true } : {}),
    ...(isSelfOnlyPayment && allocation.isFullyCoveredWeek === true ? { isFullyCoveredWeek: true } : {}),
    currency: allocation.currency,
    state: allocation.state,
  }));
  const safeFundingPortions = ownFundingPortions.map((portion) => ({
    amountMinor: portion.amountMinor,
    availableMinor: portion.availableMinor,
    appliedMinor: portion.appliedMinor,
    refundedCreditMinor: portion.refundedCreditMinor,
    totalRefundedMinor: portion.totalRefundedMinor,
    heldCreditMinor: portion.heldCreditMinor,
    reviewRequired: portion.reviewRequired,
  }));
  const ownActiveAllocated = activeVisibleAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  const scopedSource = isInitiatingPayer
    ? row.source
    : isFundingOwner
      ? ownActiveAllocated > 0
        ? "canonical_allocation"
        : ownFundingAvailable > 0
          ? "prepaid_credit"
          : ownFundingHeld > 0
            ? "held_credit"
            : ownFundingRefunded === ownFundingAmount && ownFundingAmount > 0
              ? "refunded_credit"
              : ownFundingPortions.some((portion) => portion.appliedMinor > 0)
                ? "canonical_allocation"
                : "refunded_credit"
      : visibleAllocations.length > 0 ? "canonical_allocation" : "unresolved_operation";
  const scopedCreditRefunds = isFundingOwner && !isInitiatingPayer ? {
    completedAmountMinor: ownFundingRefunded,
    heldAmountMinor: ownFundingHeld,
    reviewRequired: ownFundingPortions.some((portion) => portion.reviewRequired),
    providerRefundIds: [] as string[],
  } : undefined;
  return {
    ...safeRow,
    bowlerId: viewerBowlerId ?? row.bowlerId,
    amountMinor: safeAmount,
    allocatedMinor: hasCanonicalOwnership ? authorizedAmount : isFundingOwner ? 0 : Math.min(row.allocatedMinor, safeAmount),
    grossAllocatedMinor: hasCanonicalOwnership ? authorizedAmount : isFundingOwner ? 0 : Math.min(row.grossAllocatedMinor ?? row.allocatedMinor, safeAmount),
    refundedAllocationMinor: authorizedRefundedAmount,
    waivedMinor: authorizedWaivedAmount,
    effectiveAllocatedMinor: authorizedEffectiveAmount,
    unallocatedMinor: isInitiatingPayer ? row.unallocatedMinor : isFundingOwner ? ownFundingAvailable : 0,
    providerPaymentId: null,
    paymentOperationId: null,
    operationType: null,
    operationStatus: null,
    paidByName: isInitiatingPayer ? row.paidByName ?? null : null,
    source: scopedSource,
    unresolved: safeUnresolved,
    reviewRequired: isInitiatingPayer ? row.reviewRequired : isFundingOwner ? ownFundingPortions.some((portion) => portion.reviewRequired) : false,
    sharedTransaction: null,
    // Allocation IDs/obligation identities are audit-only. Ordinary
    // payment history receives the tender summary and balance, never the
    // internal child allocation evidence or interactive controls.
    allocations: [],
    appliedTo,
    fundingPortions: safeFundingPortions,
    hasMultipleRecipients: hasMultipleRecipients ?? false,
    isSelfOnlyPayment,
    ...(isInitiatingPayer && creditRefunds ? { creditRefunds } : {}),
    ...(scopedCreditRefunds ? { creditRefunds: scopedCreditRefunds } : {}),
    refund: { ...row.refund, present: safeRefundPresent, amountMinor: safeRefundAmount, providerRefundId: null },
    dispute: { ...row.dispute, amountMinor: safeDisputeAmount, disputeId: null },
    receipt: { ...row.receipt, source: scopedSource, availability: isInitiatingPayer ? row.receipt.availability : "unavailable", canOpenReceipt, paymentId: null, paymentOperationId: null, operationStatus: null, amountMinor: safeAmount, allocations: [], sharedTransaction: null, canResend: false, receiptUrl: null, receiptNumber: null, refund: { ...(row.receipt.refund ?? row.refund), present: safeRefundPresent, amountMinor: safeRefundAmount, providerRefundId: null }, dispute: { ...(row.receipt.dispute ?? row.dispute), amountMinor: safeDisputeAmount, disputeId: null }, unresolved: safeUnresolved },
    ...(isInitiatingPayer && correctionEvidence ? { correctionEvidence } : {}),
  };
}

router.get("/payments", async (req, res) => {
  const organizationId = positiveQuery(req.query.organizationId);
  const leagueId = positiveQuery(req.query.leagueId);
  const requestedBowlerId = positiveQuery(req.query.bowlerId);
  const page = pageQuery(req.query.page, 1);
  const limit = pageQuery(req.query.limit, 50);
  if (organizationId === null || leagueId === null || requestedBowlerId === null || page === null || limit === null) {
    return sendError(res, "Invalid financial report scope", 400, "INVALID_SCOPE");
  }
  if (leagueId === undefined) return sendError(res, "League scope is required", 400, "INVALID_SCOPE");
  if (!req.user) return sendError(res, "Not found", 404, "NOT_FOUND");

  const isSystemAdmin = req.user.role === "system_admin";
  const effectiveOrganizationId = req.organizationContextId
    ?? (isSystemAdmin ? organizationId : req.user.organizationId);
  if (!effectiveOrganizationId || (organizationId !== undefined && organizationId !== effectiveOrganizationId)) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId !== effectiveOrganizationId) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  const adminAccess = await hasAdminAccessToLeague(req, leagueId);
  const paymentManagerAccess = await hasPaymentManagerAccessToLeague(req, leagueId);
  const privileged = isSystemAdmin || adminAccess || paymentManagerAccess;
  const bowlerId: number | undefined = privileged ? requestedBowlerId ?? undefined : req.user.bowlerId ?? undefined;
  if (!privileged && (!bowlerId || (requestedBowlerId !== undefined && requestedBowlerId !== bowlerId))) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  if (isPaymentManager(req.user) && !paymentManagerAccess && !isSystemAdmin) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }

  try {
    const report = await readCanonicalPaymentReport({
      organizationId: effectiveOrganizationId,
      leagueId,
      bowlerId,
      page,
      limit,
    });
    if (privileged) return sendSuccess(res, report);
    // Ordinary users receive their authorized financial rows and safe status
    // labels only. Provider IDs, operation IDs, and immutable execution
    // internals stay within admin/reconciliation scopes.
    const redact = (row: typeof report.rows[number]) => redactCanonicalPaymentRow(row, req.user?.bowlerId);
    const redactedReport = {
      ...report,
      rows: report.rows.map(redact),
      transactions: report.transactions.map((transaction, index) => {
        const rows = transaction.rows.map(redact);
        const amountMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);
        const initiatingPayer = transaction.rows.some((row) => row.initiatingPayerBowlerId === req.user?.bowlerId);
        const dispute = transaction.dispute
          ? { ...transaction.dispute, amountMinor: initiatingPayer ? transaction.dispute.amountMinor : 0, disputeId: null }
          : undefined;
        return { ...transaction, groupKey: `transaction:${report.page}:${index + 1}`, paymentOperationId: null, paymentIds: [], amountMinor, dispute, rows };
      }),
    };
    // `readCanonicalPaymentReport` computes these aggregates over the full
    // authorized tenant/league/bowler scope, not over the selected page.
    // Keep that scope for ordinary readers; only transaction-level dispute
    // amount is withheld because a partner has no exact child apportionment.
    // Totals are already computed by the service over the full authorized
    // scope, including durable F2 paidByUser and F4 payer evidence. Never
    // derive them from the current page.
    redactedReport.totals = report.totals;
    const { fingerprint: _privilegedFingerprint, ...redactedSemantic } = redactedReport;
    return sendSuccess(res, { ...redactedReport, fingerprint: canonicalPaymentReportFingerprint(redactedSemantic) });
  } catch (error) {
    if (error instanceof CanonicalPaymentReportIncompatibilityError) {
      return sendError(res, "Financial evidence requires review", 409, "FINANCIAL_EVIDENCE_INCOMPATIBLE");
    }
    return sendError(res, "Unable to read payment evidence", 500, "INTERNAL_ERROR");
  }
});

export default router;
