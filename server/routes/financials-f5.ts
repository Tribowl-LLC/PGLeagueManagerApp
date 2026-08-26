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
import { canonicalPaymentReportFingerprint } from "@shared/canonical-payment-report";

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
  const effectiveOrganizationId = isSystemAdmin ? organizationId : req.user.organizationId;
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
    const redact = (row: typeof report.rows[number]) => {
      const ownAllocations = row.allocations.filter((allocation) => allocation.bowlerId === req.user?.bowlerId);
      const isInitiatingPayer = row.initiatingPayerBowlerId !== null
        && row.initiatingPayerBowlerId !== undefined
        && row.initiatingPayerBowlerId === req.user?.bowlerId;
      const visibleAllocations = isInitiatingPayer ? row.allocations : ownAllocations;
      const authorizedAmount = visibleAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const hasCanonicalOwnership = visibleAllocations.length > 0;
      const safeAmount = isInitiatingPayer ? row.amountMinor : (hasCanonicalOwnership ? authorizedAmount : row.amountMinor);
      const safeRefundAmount = isInitiatingPayer ? row.refund.amountMinor : 0;
      const safeDisputeAmount = isInitiatingPayer ? row.dispute.amountMinor : 0;
      const { initiatingPayerBowlerId: _initiatingPayerBowlerId, ...safeRow } = row;
      return {
      ...safeRow,
      bowlerId: req.user?.bowlerId ?? row.bowlerId,
      amountMinor: safeAmount,
      allocatedMinor: hasCanonicalOwnership ? authorizedAmount : Math.min(row.allocatedMinor, safeAmount),
      unallocatedMinor: hasCanonicalOwnership ? 0 : row.unallocatedMinor,
      providerPaymentId: null,
      paymentOperationId: null,
      operationType: null,
      operationStatus: null,
      sharedTransaction: null,
      allocations: visibleAllocations,
      refund: { ...row.refund, amountMinor: safeRefundAmount, providerRefundId: null },
      dispute: { ...row.dispute, amountMinor: safeDisputeAmount, disputeId: null },
      receipt: { ...row.receipt, paymentId: null, paymentOperationId: null, operationStatus: null, amountMinor: safeAmount, allocations: visibleAllocations, sharedTransaction: null, canResend: false, receiptUrl: null, receiptNumber: null, refund: { ...(row.receipt.refund ?? row.refund), amountMinor: safeRefundAmount, providerRefundId: null }, dispute: { ...(row.receipt.dispute ?? row.dispute), amountMinor: safeDisputeAmount, disputeId: null } },
    }; };
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
        return { ...transaction, groupKey: `transaction:${report.page}:${index + 1}`, paymentOperationId: null, combinedChargeGroupId: null, paymentIds: [], amountMinor, dispute, rows };
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
