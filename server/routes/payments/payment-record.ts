/**
 * Payment record CRUD endpoints (mounted under /api/payments).
 *
 * Owns correction-safe update / delete of non-allocation payment rows.
 * Canonical payment creation lives in `roster-payments.ts`; refund handling
 * lives in `payment-refunds.ts` and listing/reporting in `payment-reports.ts`.
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { updatePaymentSchema } from "@shared/schema";
import { isCardPaymentType } from "@shared/schema/constants";
import { z } from "zod";
import { sendSuccess, sendError, handleZodError, sanitizePayment } from '../../utils/api.js';
import { singleRouteParam } from '../../utils/route-params';
import { hasAccessToPayment, hasPaymentManagerAccessToPayment, isPaymentManager, isSystemAdmin } from '../../utils/access-control.js';
import { paymentWriteLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';
import { PaymentDisputeEvidenceExistsError, PaymentEvidenceImmutableError, PaymentOccurrenceEvidenceExistsError } from '../../storage/payments.js';

const log = createLogger("Payments");

const router = Router();

// Update payment
router.patch("/:id", paymentWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    const parsed = updatePaymentSchema.parse(req.body);

    const update = Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, v === null ? undefined : v])
    ) as z.infer<typeof updatePaymentSchema>;

    const existingPayment = await storage.getPaymentById(id);
    if (isPaymentManager(req.user)) {
      // Payment ownership is immutable from the bookkeeping surface.  The
      // current update schema does not expose leagueId/bowlerId, but reject
      // those keys explicitly as well so a future schema extension cannot
      // let a location-scoped operator move a row across a league or bowler
      // boundary without a corresponding scoped authorization check.
      const allowedFields = new Set(['amount', 'weekOf', 'type', 'checkNumber', 'notes']);
      if (req.body && typeof req.body === 'object'
        && Object.keys(req.body as Record<string, unknown>).some((field) => !allowedFields.has(field))) {
        return sendError(res, 'Payment managers may edit cash/check bookkeeping fields only', 403, 'FORBIDDEN');
      }
      if (!existingPayment || !(await hasPaymentManagerAccessToPayment(req, id))) {
        return sendError(res, "You don't have access to update this payment", 403, 'FORBIDDEN');
      }
      if (isCardPaymentType(existingPayment.type) || (update.type !== undefined && isCardPaymentType(update.type))) {
        return sendError(res, 'Payment managers may update cash or check payments only', 403, 'FORBIDDEN');
      }
    }

    // If updating to check payment type, ensure check number is provided
    if (update.type === 'check' && !update.checkNumber) {
      return sendError(res, 'Check number is required for check payments', 400, 'VALIDATION_ERROR');
    }
    
    // Check if the user is a system administrator or an organization
    // administrator for the payment's organization.
    if (!isSystemAdmin(req.user) && !isPaymentManager(req.user)) {
      const hasAccess = await hasAccessToPayment(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to update this payment", 403, 'FORBIDDEN');
      }
    }

    const updated = await storage.updatePayment(id, update);
    if (!updated) {
      return sendError(res, "Payment not found", 404, "NOT_FOUND");
    }

    sendSuccess(res, sanitizePayment(updated));
  } catch (error) {
    log.error('Update error:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    if (error instanceof PaymentEvidenceImmutableError) {
      return sendError(res, 'Payment evidence is immutable', 409, 'PAYMENT_EVIDENCE_RETAINED');
    }
    sendError(res, 'Failed to update payment');
  }
});

// Delete payment
router.delete("/:id", paymentWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    if (isNaN(id)) {
      return sendError(res, "Invalid payment ID", 400, "INVALID_ID");
    }

    const payment = await storage.getPaymentById(id);
    if (!payment) {
      return sendError(res, "Payment not found", 404, "NOT_FOUND");
    }

    // Card payments may only be deleted by organization or system administrators.
    if (isCardPaymentType(payment.type) && req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin') {
      return sendError(res, "Only admins can delete card payments", 403, "FORBIDDEN");
    }

    if (isPaymentManager(req.user) && !(await hasPaymentManagerAccessToPayment(req, id))) {
      return sendError(res, "You don't have access to delete this payment", 403, 'FORBIDDEN');
    }

    if (!isSystemAdmin(req.user) && !isPaymentManager(req.user)) {
      const hasAccess = await hasAccessToPayment(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to delete this payment", 403, 'FORBIDDEN');
      }
    }

    await storage.deletePayment(id);

    sendSuccess(res, { message: "Payment deleted successfully" }, 200);
  } catch (error) {
    if (error instanceof PaymentDisputeEvidenceExistsError) {
      return sendError(
        res,
        error.message,
        409,
        'PAYMENT_DISPUTE_EVIDENCE_EXISTS',
      );
    }
    if (error instanceof PaymentOccurrenceEvidenceExistsError) {
      return sendError(res, 'This payment is retained as occurrence allocation evidence and cannot be deleted.', 409, 'PAYMENT_EVIDENCE_RETAINED');
    }
    log.error('Delete error:', error);
    sendError(res, 'Failed to delete payment');
  }
});

export default router;
