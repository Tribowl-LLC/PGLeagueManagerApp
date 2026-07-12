/**
 * Payment refund endpoints (mounted under /api/payments). Square only
 * auto-emails a refund receipt when the original payment carried a
 * buyerEmailAddress, so rows with `receiptEmailMissing: true` get a
 * UI notice (refund-payment-dialog.tsx) prompting an admin resend.
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { isCardPaymentType } from "@shared/schema/constants";
import { sendSuccess, sendError, sanitizePayment } from '../../utils/api.js';
import { singleRouteParam } from '../../utils/route-params';
import { getPaymentProvider } from '../../services/payment-provider-factory';
import { buildPaymentErrorResponse } from '../../utils/payment-error-response.js';
import { hasAccessToPayment, hasAdminAccessToLeague, isSystemAdmin, isOrgOrHigher } from '../../utils/access-control.js';
import { paymentWriteLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';

const log = createLogger("Payments");

const router = Router();

router.post("/:id/refund", paymentWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    if (isNaN(id)) {
      return sendError(res, "Invalid payment ID", 400, "INVALID_ID");
    }

    if (!req.user) {
      return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
    }

    const payment = await storage.getPaymentById(id);
    if (!payment) {
      return sendError(res, "Payment not found", 404, "NOT_FOUND");
    }

    if (payment.status === 'refunded') {
      return sendError(res, "Payment has already been refunded", 400, "ALREADY_REFUNDED");
    }

    if (payment.status !== 'paid') {
      return sendError(res, "Only paid payments can be refunded", 400, "INVALID_STATUS");
    }

    if (!isCardPaymentType(payment.type)) {
      return sendError(res, "Only card payments can be refunded", 400, "INVALID_TYPE");
    }

    // Task #735: refunds are an admin-tier action. Allow system_admin,
    // org_admin (gated on payment access), or a league secretary with
    // an active grant for this payment's league. Plain users (and
    // non-secretary "user" role accounts) remain denied.
    if (isSystemAdmin(req.user)) {
      // ok — system_admin bypasses payment-level access check (legacy behaviour)
    } else if (isOrgOrHigher(req.user)) {
      const hasAccess = await hasAccessToPayment(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to refund this payment", 403, "FORBIDDEN");
      }
    } else {
      const isSecretary = await hasAdminAccessToLeague(req, payment.leagueId);
      if (!isSecretary) {
        return sendError(res, "Only admins can process refunds", 403, "FORBIDDEN");
      }
    }

    const { reason } = req.body || {};
    let providerRefundId: string | undefined;

    const providerPaymentRef = payment.cloverChargeId || payment.providerPaymentId;
    if (providerPaymentRef && isCardPaymentType(payment.type)) {
      const league = await storage.getLeague(payment.leagueId);
      const locationId = league?.locationId ?? null;
      const provider = await getPaymentProvider(locationId);
      const refundResult = await provider.refundPayment(providerPaymentRef, payment.amount, reason);
      providerRefundId = refundResult.refundId;
    }

    const refunded = await storage.refundPayment(id, providerRefundId, reason);
    sendSuccess(res, sanitizePayment(refunded));
  } catch (error) {
    log.error('Refund error:', error);

    // Mirror the charge route (server/routes/payments-provider/charges.ts):
    // surface the provider's typed `userMessage` + `code` so admins see
    // the actionable reason ("Your payment was declined…", "Refund could
    // not be processed.", etc.) instead of the generic "Failed to process
    // refund" wall. The shared helper pins the three-branch shape
    // (ProviderNotConfiguredError → 422, PaymentProviderError → 500
    // with typed message + code, anything else → 500 with the
    // sanitized fallback) — see server/utils/payment-error-response.ts.
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      'Failed to process refund',
      'REFUND_ERROR',
    );
    sendError(res, userMessage, status, code);
  }
});

export default router;
