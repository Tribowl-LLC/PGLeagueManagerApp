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
 * cash/check, Clover, or Square deleted the payment). Provider
 * configuration errors propagate as `ProviderNotConfiguredError` so
 * the caller can map them to 422.
 */
async function resolveReceiptUrl(paymentId: number): Promise<{
  receiptUrl: string;
  receiptNumber: string | null;
} | null> {
  const payment = await storage.getPaymentById(paymentId);
  if (!payment) {
    return null;
  }

  // Cached path — every Square row written has these
  // populated at charge time, so this is the common case.
  if (payment.receiptUrl) {
    return {
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
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
    return null;
  }

  await storage.updatePayment(payment.id, {
    receiptUrl: verification.receiptUrl,
    receiptNumber: verification.receiptNumber ?? null,
  });

  return {
    receiptUrl: verification.receiptUrl,
    receiptNumber: verification.receiptNumber ?? null,
  };
}

router.get('/payments/:id/receipt', async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    if (isNaN(id)) {
      return sendError(res, 'Invalid payment ID', 400, 'INVALID_ID');
    }

    // Bowlers can fetch their own receipts; admins gated by org via
    // `hasAccessToPayment`. System admins implicitly pass.
    const hasAccess = await hasAccessToPayment(req, id);
    if (!hasAccess) {
      return sendError(res, "You don't have access to this payment", 403, 'FORBIDDEN');
    }

    const resolved = await resolveReceiptUrl(id);
    if (!resolved) {
      return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    }

    return sendSuccess(res, resolved);
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
    const id = parseInt(singleRouteParam(req.params.id));
    if (isNaN(id)) {
      return sendError(res, 'Invalid payment ID', 400, 'INVALID_ID');
    }

    if (req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin') {
      return sendError(res, 'Admin access required', 403, 'FORBIDDEN');
    }

    const parsed = resendBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 'A valid email address is required', 400, 'VALIDATION_ERROR');
    }
    const overrideEmail = parsed.data.email?.trim() || '';

    if (req.user.role !== 'system_admin') {
      const hasAccess = await hasAccessToPayment(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to this payment", 403, 'FORBIDDEN');
      }
    }

    const resolved = await resolveReceiptUrl(id);
    if (!resolved) {
      return sendError(res, 'No receipt available for this payment', 404, 'RECEIPT_UNAVAILABLE');
    }

    const payment = await storage.getPaymentById(id);
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
