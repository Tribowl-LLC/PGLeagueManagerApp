/**
 * Square hosted-receipt endpoints.
 *  - GET  /payments/:id/receipt         bowler/admin: lazy-fetch + cache
 *  - POST /payments/:id/resend-receipt  admin only: re-email receipt link
 */
import { Router } from 'express';
import { z } from 'zod';
import { storage } from '../../storage';
import { sendError, sendSuccess } from '../../utils/api.js';
import { singleRouteParam } from '../../utils/route-params';
import { hasAccessToPayment } from '../../utils/access-control.js';
import * as accessControl from '../../utils/access-control.js';
import { paymentWriteLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../../services/payment-provider-factory';
import { buildPaymentErrorResponse } from '../../utils/payment-error-response.js';
import { sendReceiptResendEmail } from '../../services/email';
import { paymentReceiptContract, type PaymentReceiptContract } from '@shared/payment-receipt';
import { CanonicalPaymentReportIncompatibilityError, readPaymentReceiptProjection } from '../../services/canonical-payment-report.js';

const log = createLogger('PaymentReceipts');

const router = Router();

// `email` is OPTIONAL. When omitted (or
// blank), the resend endpoint falls back to the bowler's email on
// file. Admins only need to type an explicit address when sending to
// a different email than the one stored on the bowler row. An empty
// or whitespace-only string is treated as "no override".
const resendBodySchema = z.object({
  email: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Must be a valid email address',
    }),
});

/**
 * Resolve the receipt URL for a payment, lazily backfilling the row
 * from the provider's GetPayment when the URL hasn't been cached yet.
 *
 * Returns `null` only when the receipt is genuinely unavailable (e.g.
 * cash/check, or Square deleted the payment). Provider
 * configuration errors propagate as `ProviderNotConfiguredError` so
 * the caller can map them to 422.
 */
async function resolveReceiptUrl(paymentId: number, organizationId?: number): Promise<{
  receiptUrl: string | null;
  receiptNumber: string | null;
  receipt: PaymentReceiptContract;
} | null> {
  const payment = organizationId && typeof storage.getPaymentByIdForOrganization === "function"
    ? await storage.getPaymentByIdForOrganization(paymentId, organizationId)
    : await storage.getPaymentById(paymentId);
  if (!payment) {
    return null;
  }

  // Cached path — every Square row written has these
  // populated at charge time, so this is the common case.
  if (payment.receiptUrl) {
    return {
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
      receipt: paymentReceiptContract(payment),
    };
  }

  // No provider payment id means cash/check/manual — there's no
  // hosted receipt to fetch.
  if (!payment.providerPaymentId) {
    return null;
  }

  // Lazy backfill: ask the provider, then cache the result back to
  // the row so subsequent calls hit the cached path.
  const league = await storage.getLeague(payment.leagueId);
  const provider = await getPaymentProvider(league?.locationId ?? null);
  const verification = await provider.getPayment(payment.providerPaymentId);
  if (!verification?.receiptUrl) {
    return { receiptUrl: null, receiptNumber: verification?.receiptNumber ?? null, receipt: paymentReceiptContract({ receiptUrl: null, receiptNumber: verification?.receiptNumber ?? null }) };
  }

  const paymentOrganizationId = league?.organizationId;
  if (paymentOrganizationId === null || paymentOrganizationId === undefined) {
    return null;
  }
  if (typeof storage.updatePaymentReceiptCacheForOrganization === "function") {
    await storage.updatePaymentReceiptCacheForOrganization(payment.id, paymentOrganizationId, {
      receiptUrl: verification.receiptUrl,
      receiptNumber: verification.receiptNumber ?? null,
    });
  } else {
    // Compatibility only for older test doubles; production storage always
    // exposes the tenant-scoped helper above.
    await storage.updatePayment(payment.id, {
      receiptUrl: verification.receiptUrl,
      receiptNumber: verification.receiptNumber ?? null,
    });
  }

  return {
    receiptUrl: verification.receiptUrl,
    receiptNumber: verification.receiptNumber ?? null,
    receipt: paymentReceiptContract({
      receiptUrl: verification.receiptUrl ?? null,
      receiptNumber: verification.receiptNumber ?? null,
    }),
  };
}

async function buildReceiptEvidence(paymentId: number, organizationId: number, viewer: Express.User): Promise<{ evidence: PaymentReceiptContract; sharedReceiptAllowed: boolean } | null> {
  const paymentScope = await storage.getPaymentByIdForOrganization(paymentId, organizationId);
  const scopedLeague = paymentScope ? await storage.getLeague(paymentScope.leagueId) : undefined;
  const projection = await readPaymentReceiptProjection({ organizationId, paymentId });
  const { payment, report, row } = projection;
  const transaction = report.transactions.find((candidate) => candidate.rows.some((candidateRow) => candidateRow.paymentId === payment.id));
  const adminPrivilege = viewer.role === 'system_admin' || viewer.role === 'org_admin' || viewer.role === 'payment_manager';
  const initiatingPayer = payment.paidByUserId === viewer.id || (row.initiatingPayerBowlerId !== null && row.initiatingPayerBowlerId !== undefined && row.initiatingPayerBowlerId === viewer.bowlerId);
  const hasOtherActiveAllocation = row.allocations.some((allocation) => allocation.state === 'active' && allocation.bowlerId !== payment.bowlerId);
  const sharedAllowed = adminPrivilege || initiatingPayer || (row.paymentOperationId === null && !hasOtherActiveAllocation && viewer.bowlerId === payment.bowlerId);
  const evidenceAllocations = row.allocations.map((allocation) => ({ ...allocation, source: row.source }));
  const visibleAllocations = sharedAllowed ? evidenceAllocations : evidenceAllocations.filter((allocation) => allocation.bowlerId === viewer.bowlerId);
  const transactionDispute = transaction?.dispute ?? row.dispute;
  const visibleDispute = {
    ...transactionDispute,
    amountMinor: sharedAllowed ? transactionDispute.amountMinor : 0,
    disputeId: adminPrivilege ? transactionDispute.disputeId : null,
  };
  const visibleRefund = {
    ...row.refund,
    amountMinor: sharedAllowed ? row.refund.amountMinor : 0,
    providerRefundId: adminPrivilege ? row.refund.providerRefundId : null,
  };
  const sharedTransaction = sharedAllowed
    ? (transaction ? { groupKey: transaction.groupKey, childCount: transaction.rows.length } : row.sharedTransaction ?? null)
    : null;
  const receiptUrl = sharedAllowed ? payment.receiptUrl : null;
  const receiptNumber = sharedAllowed ? payment.receiptNumber : null;
  const evidence = paymentReceiptContract({
    receiptUrl,
    receiptNumber,
    organizationId,
    leagueId: payment.leagueId,
    paymentId: payment.id,
    paymentOperationId: adminPrivilege ? row.paymentOperationId : null,
    operationStatus: adminPrivilege ? row.operationStatus : null,
    amountMinor: sharedAllowed ? row.amountMinor : visibleAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
    currency: row.currency,
    evidenceStatus: row.status,
    source: row.source,
    allocations: visibleAllocations,
    refund: visibleRefund,
    dispute: visibleDispute,
    unresolved: row.unresolved,
    sharedTransaction,
    paymentTiming: report.paymentTiming,
    ...(row.collectionEvidence ? { collectionEvidence: row.collectionEvidence } : {}),
    canResend: adminPrivilege && Boolean(receiptUrl),
  });
  return { evidence, sharedReceiptAllowed: sharedAllowed };
}

router.get('/payments/:id/receipt', async (req, res) => {
  try {
    if (!req.user) return sendError(res, 'Not found', 404, 'NOT_FOUND');
    const requestedOrganizationId = req.query.organizationId === undefined ? undefined : Number(req.query.organizationId);
    if (req.user.role === 'system_admin' && (typeof requestedOrganizationId !== 'number' || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) {
      return sendError(res, 'Organization scope is required', 400, 'INVALID_SCOPE');
    }
    const effectiveOrganizationId = req.user.role === 'system_admin' ? requestedOrganizationId : req.user.organizationId;
    const id = parseInt(singleRouteParam(req.params.id));
    if (isNaN(id)) {
      return sendError(res, 'Invalid payment ID', 400, 'INVALID_ID');
    }

    let readAccess: typeof hasAccessToPayment = hasAccessToPayment;
    try {
      const candidate = accessControl.hasReceiptReadAccessToPayment;
      if (typeof candidate === "function") readAccess = candidate;
    } catch {
      // Older route test doubles do not expose the read-only helper; the
      // mutation-safe admin helper remains the fail-closed compatibility path.
    }
    if (!(await readAccess(req, id))) {
      return sendError(res, "You don't have access to this payment", 403, 'FORBIDDEN');
    }

    const organizationId = effectiveOrganizationId;
    const evidenceResult = organizationId && typeof storage.getPaymentByIdForOrganization === "function"
      ? await buildReceiptEvidence(id, organizationId, req.user)
      : null;
    if (!evidenceResult) {
      return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    }
    const { evidence, sharedReceiptAllowed } = evidenceResult;
    const resolved = sharedReceiptAllowed
      ? await resolveReceiptUrl(id, effectiveOrganizationId ?? undefined)
      : null;
    if (!evidence && !resolved) return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    const responseEvidence = evidence
      ? (resolved && sharedReceiptAllowed
        ? { ...evidence, availability: resolved.receiptUrl ? 'available' as const : 'unavailable' as const, receiptUrl: resolved.receiptUrl, receiptNumber: resolved.receiptNumber }
        : evidence)
      : resolved?.receipt;
    if (!responseEvidence) return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    if (sharedReceiptAllowed && !responseEvidence.receiptUrl && !resolved) return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    return sendSuccess(res, {
      ...responseEvidence,
      // Preserve the existing flat fields for current clients while the
      // versioned receipt contract is adopted by F5 consumers.
      receiptUrl: responseEvidence.receiptUrl,
      receiptNumber: responseEvidence.receiptNumber,
    });
  } catch (error) {
    if (error instanceof CanonicalPaymentReportIncompatibilityError || (error instanceof Error && error.message.includes('canonical receipt evidence'))) {
      return sendError(res, 'Financial evidence requires review', 409, 'FINANCIAL_EVIDENCE_INCOMPATIBLE');
    }
    if (error instanceof ProviderNotConfiguredError) {
      return sendError(res, 'Payment provider not configured for this location', 422, 'PROVIDER_NOT_CONFIGURED');
    }
    log.error('Failed to resolve receipt URL', error);
    return sendError(res, 'Failed to fetch receipt');
  }
});

router.post('/payments/:id/resend-receipt', paymentWriteLimiter, async (req, res) => {
  try {
    if (!req.user) return sendError(res, 'Not found', 404, 'NOT_FOUND');
    const requestedOrganizationId = req.query.organizationId === undefined ? undefined : Number(req.query.organizationId);
    if (req.user.role === 'system_admin' && (typeof requestedOrganizationId !== 'number' || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) {
      return sendError(res, 'Organization scope is required', 400, 'INVALID_SCOPE');
    }
    const effectiveOrganizationId = req.user.role === 'system_admin' ? requestedOrganizationId : req.user.organizationId;
    const id = parseInt(singleRouteParam(req.params.id));
    if (isNaN(id)) {
      return sendError(res, 'Invalid payment ID', 400, 'INVALID_ID');
    }

    if (req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin' && (req.user?.role as string | undefined) !== 'payment_manager') {
      return sendError(res, 'Admin access required', 403, 'FORBIDDEN');
    }

    const parsed = resendBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 'A valid email address is required', 400, 'VALIDATION_ERROR');
    }
    const overrideEmail = parsed.data.email?.trim() || '';

    if (req.user?.role !== 'system_admin') {
      const hasAccess = await hasAccessToPayment(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to this payment", 403, 'FORBIDDEN');
      }
    }

    const resolved = await resolveReceiptUrl(id, effectiveOrganizationId ?? undefined);
    if (!resolved) {
      return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    }
    if (!resolved.receiptUrl) {
      return sendError(res, 'No hosted receipt is available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    }

    const payment = req.user?.organizationId && typeof storage.getPaymentByIdForOrganization === "function"
      ? await storage.getPaymentByIdForOrganization(id, req.user.organizationId)
      : await storage.getPaymentById(id);
    if (!payment) {
      return sendError(res, 'Payment not found', 404, 'NOT_FOUND');
    }
    const league = await storage.getLeague(payment.leagueId);
    const organization = league?.organizationId
      ? await storage.getOrganization(league.organizationId)
      : null;

    // default to the bowler's on-file
    // email when the admin didn't supply an override. Only fall
    // through to NO_TARGET_EMAIL when neither side has an address.
    const bowler = await storage.getBowler(payment.bowlerId);
    const targetEmail = overrideEmail || bowler?.email || '';
    if (!targetEmail) {
      return sendError(
        res,
        'No email address available for this bowler. Add one to their profile or supply one in the request body.',
        400,
        'NO_TARGET_EMAIL',
      );
    }

    const sent = await sendReceiptResendEmail(targetEmail, {
      receiptUrl: resolved.receiptUrl,
      receiptNumber: resolved.receiptNumber,
      amountCents: payment.amount,
      leagueName: league?.name ?? null,
      organizationName: organization?.name ?? null,
    });

    if (!sent) {
      return sendError(res, 'Email service unavailable — receipt was not resent', 502, 'EMAIL_FAILED');
    }

    log.info('Receipt resent', { paymentId: id, by: req.user?.id });
    return sendSuccess(res, { sent: true });
  } catch (error) {
    log.error('Failed to resend receipt', error);
    // The lazy-backfill leg of the resend flow can call into Square's
    // GetPayment, which may throw a typed PaymentProviderError if the
    // provider rejects the lookup (e.g. credentials revoked).
    // Surface that typed reason via the shared helper instead of
    // collapsing every failure into "Failed to resend receipt".
    // Task #605.
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      'Failed to resend receipt',
      'RESEND_RECEIPT_ERROR',
    );
    return sendError(res, userMessage, status, code);
  }
});

export default router;
