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
import { paymentWriteLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../../services/payment-provider-factory';
import { buildPaymentErrorResponse } from '../../utils/payment-error-response.js';
import { sendReceiptResendEmail } from '../../services/email';
import { paymentReceiptContract, type PaymentReceiptContract } from '@shared/payment-receipt';
import { db } from '../../db.js';
import { and, eq, inArray } from 'drizzle-orm';
import { leagues, paymentOccurrenceAllocations, paymentOperations } from '@shared/schema';

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

async function buildReceiptEvidence(paymentId: number, organizationId: number, viewer: Express.User): Promise<PaymentReceiptContract | null> {
  const payment = await storage.getPaymentByIdForOrganization(paymentId, organizationId);
  if (!payment) return null;
  const [league] = await db.select({ organizationId: leagues.organizationId }).from(leagues)
    .where(and(eq(leagues.id, payment.leagueId), eq(leagues.organizationId, organizationId))).limit(1);
  if (!league) return null;
  const allocations = await db.select().from(paymentOccurrenceAllocations).where(and(
    eq(paymentOccurrenceAllocations.organizationId, organizationId),
    eq(paymentOccurrenceAllocations.leagueId, payment.leagueId),
    eq(paymentOccurrenceAllocations.paymentId, payment.id),
  ));
  const [operation] = payment.paymentOperationId ? await db.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, organizationId),
    eq(paymentOperations.leagueId, payment.leagueId),
    eq(paymentOperations.id, payment.paymentOperationId),
  )).limit(1) : [];
  const privileged = viewer.role === 'system_admin' || viewer.role === 'org_admin' || viewer.role === 'payment_manager' || payment.paidByUserId === viewer.id;
  const ownAllocation = viewer.bowlerId ? allocations.filter((allocation) => allocation.bowlerId === viewer.bowlerId) : [];
  const visibleAllocations = privileged || viewer.bowlerId === payment.bowlerId ? allocations : ownAllocation;
  const shared = operation ? { groupKey: `operation:${operation.id}`, childCount: (await storage.getPaymentsByPaymentOperationId(organizationId, operation.id)).length } : null;
  const unresolved = !!operation && ['pending', 'leased', 'provider_unknown', 'retry_scheduled', 'action_required', 'reconciliation_required'].includes(operation.status);
  return paymentReceiptContract({
    receiptUrl: privileged || viewer.bowlerId === payment.bowlerId ? payment.receiptUrl : null,
    receiptNumber: privileged || viewer.bowlerId === payment.bowlerId ? payment.receiptNumber : null,
    organizationId,
    leagueId: payment.leagueId,
    paymentId: payment.id,
    paymentOperationId: privileged ? payment.paymentOperationId : null,
    operationStatus: privileged ? operation?.status ?? null : null,
    amountMinor: privileged || viewer.bowlerId === payment.bowlerId ? payment.amount : visibleAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
    currency: 'USD',
    evidenceStatus: unresolved ? 'unresolved' : payment.status === 'paid' ? 'confirmed_paid' : payment.status === 'refunded' ? 'refunded' : payment.status === 'disputed' ? 'disputed' : 'review_required',
    source: allocations.length > 0 ? 'canonical_allocation' : 'unlinked_legacy',
    allocations: visibleAllocations.map((allocation) => ({ allocationId: allocation.id, obligationId: allocation.obligationId, occurrenceId: allocation.occurrenceId, bowlerId: allocation.bowlerId, amountMinor: allocation.amountMinor, currency: allocation.currency, state: allocation.state, source: 'canonical_allocation' as const })),
    refund: { present: payment.status === 'refunded' || payment.squareRefundId !== null, amountMinor: payment.status === 'refunded' ? payment.amount : 0, providerRefundId: payment.squareRefundId },
    dispute: { present: payment.status === 'disputed' || !!payment.disputeId, amountMinor: payment.status === 'disputed' ? payment.amount : 0, disputeId: payment.disputeId },
    unresolved,
    sharedTransaction: privileged || viewer.bowlerId === payment.bowlerId ? shared : null,
    canResend: privileged && Boolean(payment.receiptUrl),
  });
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

    // Bowlers can fetch their own receipts; admins gated by org via
    // `hasAccessToPayment`. System admins implicitly pass.
    let hasAccess = await hasAccessToPayment(req, id);
    if (!hasAccess && req.user.bowlerId && req.user.organizationId) {
      const [ownAllocation] = await db.select({ id: paymentOccurrenceAllocations.id })
        .from(paymentOccurrenceAllocations)
        .where(and(
          eq(paymentOccurrenceAllocations.organizationId, req.user.organizationId),
          eq(paymentOccurrenceAllocations.paymentId, id),
          eq(paymentOccurrenceAllocations.bowlerId, req.user.bowlerId),
        )).limit(1);
      hasAccess = Boolean(ownAllocation);
    }
    if (!hasAccess) {
      return sendError(res, "You don't have access to this payment", 403, 'FORBIDDEN');
    }

    const resolved = await resolveReceiptUrl(id, effectiveOrganizationId ?? undefined);
    if (!resolved) {
      return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    }
    const organizationId = effectiveOrganizationId;
    const evidence = organizationId && typeof storage.getPaymentByIdForOrganization === "function"
      ? await buildReceiptEvidence(id, organizationId, req.user)
      : null;
    return sendSuccess(res, {
      ...(evidence ?? resolved.receipt),
      // Preserve the existing flat fields for current clients while the
      // versioned receipt contract is adopted by F5 consumers.
      receiptUrl: resolved.receiptUrl,
      receiptNumber: resolved.receiptNumber,
    });
  } catch (error) {
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
