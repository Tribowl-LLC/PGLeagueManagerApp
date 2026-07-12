/**
 * Payment record CRUD endpoints (mounted under /api/payments).
 *
 * Owns create / update / delete of payment rows. Refund handling lives in
 * `payment-refunds.ts` and listing/reporting lives in `payment-reports.ts`.
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { insertPaymentSchema, updatePaymentSchema } from "@shared/schema";
import { isCardPaymentType } from "@shared/schema/constants";
import { z } from "zod";
import { sendSuccess, sendError, handleZodError, sanitizePayment } from '../../utils/api.js';
import { singleRouteParam } from '../../utils/route-params';
import { hasAccessToPayment, hasAdminAccessToLeague, isSystemAdmin } from '../../utils/access-control.js';
import { paymentWriteLimiter } from '../../middleware/rate-limit.js';
import { differenceInWeeks } from 'date-fns';
import { paymentScheduler } from '../../services/payment-scheduler.js';
import { isTestKickSuppressed, PAYMENT_SCHEDULER_KICK_HEADER } from '../../utils/test-suppression';
import { db } from '../../db.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { payments as paymentsTable } from '@shared/schema';
import { createLogger } from '../../logger';
import { getPgErrorCode } from '../../utils/db-errors';

const log = createLogger("Payments");

const router = Router();

// Create new payment
router.post("/", paymentWriteLimiter, async (req, res) => {
  try {
    const payment = insertPaymentSchema.parse(req.body);

    // Validate check number if payment type is check
    if (payment.type === 'check' && !payment.checkNumber) {
      return sendError(res, 'Check number is required for check payments', 400, 'VALIDATION_ERROR');
    }
    
    const league = await storage.getLeague(payment.leagueId);
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    // Task #735: secretaries may record cash/check payments for their
    // granted league. `hasAdminAccessToLeague` covers system_admin,
    // org_admin (matching org), and active league-secretary grants —
    // and still respects the org-less deny rule.
    if (!(await hasAdminAccessToLeague(req, payment.leagueId))) {
      return sendError(res, "You don't have access to create payments for this league", 403, 'FORBIDDEN');
    }

    // Task #454: existence pre-check for the admin-supplied bowlerId.
    // Without this, a typoed or stale bowler id falls through to the
    // `payments.bowler_id -> bowlers.id` foreign-key constraint and
    // surfaces as a generic 500. The cross-org dimension is implicitly
    // covered: a bowler outside the league's org would still pass the
    // existence check here, but `requireOrganizationAccess` above has
    // already gated the *league*; the route only inserts payments for
    // a league the caller owns. The new check is purely the typo /
    // stale-id net mirroring the bowlers.ts (#422) reference fix.
    const targetBowler = await storage.getBowler(payment.bowlerId);
    if (!targetBowler) {
      return sendError(res, "Bowler not found", 404, 'NOT_FOUND');
    }

    // P1 security: having admin access to the league is NOT sufficient to
    // record a payment for an arbitrary bowler. The bowler must belong to
    // the league's organization AND be actively rostered in this league —
    // otherwise an admin/secretary could pair a legitimate league with a
    // non-rostered (or cross-org) bowler and corrupt balances/reports.
    if (targetBowler.organizationId !== league.organizationId) {
      return sendError(res, "Bowler is not in this league's organization", 403, 'FORBIDDEN');
    }
    if (!(await storage.isBowlerActiveInLeague(payment.bowlerId, payment.leagueId))) {
      return sendError(res, 'Bowler is not rostered in this league', 400, 'BOWLER_NOT_IN_LEAGUE');
    }

    if (payment.idempotencyKey) {
      const existing = await storage.getPaymentByIdempotencyKey(payment.idempotencyKey);
      if (existing && existing.leagueId === payment.leagueId) {
        log.info('Payment deduplicated by idempotency key:', { id: existing.id, idempotencyKey: payment.idempotencyKey });
        return sendSuccess(res, sanitizePayment(existing), 200);
      }
      if (existing) {
        return sendError(res, 'Duplicate idempotency key', 409, 'CONFLICT');
      }
    }

    const lineageAmount = (league.lineageFee != null && league.weeklyFee > 0)
      ? Math.round(payment.amount * league.lineageFee / league.weeklyFee)
      : undefined;
    const prizeFundAmount = (league.prizeFundFee != null && league.weeklyFee > 0)
      ? Math.round(payment.amount * league.prizeFundFee / league.weeklyFee)
      : undefined;

    let created;
    try {
      created = await storage.createPayment({
        ...payment,
        lineageAmount,
        prizeFundAmount,
        // do NOT auto-stamp the admin actor as payer here.
        // Admin-recorded cash/check entries must keep paidByUserId null
        // (the admin is recording, not paying). Only honor an explicit
        // paidByUserId provided by the caller (e.g. partner-pay surfaces
        // that already resolved the payer user).
        paidByUserId: payment.paidByUserId ?? null,
      });
    } catch (insertError: unknown) {
      if (
        payment.idempotencyKey &&
        getPgErrorCode(insertError) === '23505'
      ) {
        const existing = await storage.getPaymentByIdempotencyKey(payment.idempotencyKey);
        if (existing && existing.leagueId === payment.leagueId) {
          log.info('Payment deduplicated after race condition:', { id: existing.id, idempotencyKey: payment.idempotencyKey });
          return sendSuccess(res, sanitizePayment(existing), 200);
        }
        if (existing) {
          return sendError(res, 'Duplicate idempotency key', 409, 'CONFLICT');
        }
      }
      throw insertError;
    }

    if (payment.status === 'paid' && league.seasonStart && league.seasonEnd && league.weeklyFee) {
      try {
        const seasonStart = new Date(league.seasonStart);
        const seasonEnd = new Date(league.seasonEnd);
        const totalWeeks = Math.max(0, differenceInWeeks(seasonEnd, seasonStart));
        const fullSeasonAmount = league.weeklyFee * totalWeeks;

        if (fullSeasonAmount > 0) {
          const totalPaidResult = await db
            .select({ total: sql<number>`COALESCE(SUM(${paymentsTable.amount}), 0)` })
            .from(paymentsTable)
            .where(and(
              eq(paymentsTable.bowlerId, payment.bowlerId),
              eq(paymentsTable.leagueId, payment.leagueId),
              eq(paymentsTable.status, 'paid'),
              gte(paymentsTable.weekOf, seasonStart.toISOString()),
              lte(paymentsTable.weekOf, seasonEnd.toISOString())
            ));
          const totalPaid = Number(totalPaidResult[0]?.total || 0);

          if (totalPaid >= fullSeasonAmount) {
            const activeSchedule = await storage.getPaymentSchedule(payment.bowlerId, payment.leagueId);
            if (activeSchedule) {
              await storage.deactivatePaymentSchedule(activeSchedule.id, `paid_in_full:payment_id=${created.id}`);
              if (!isTestKickSuppressed(req, PAYMENT_SCHEDULER_KICK_HEADER)) {
                await paymentScheduler.removeSchedule(activeSchedule.id);
              }
              log.info(`Bowler ${payment.bowlerId} paid in full for league ${payment.leagueId}, auto-cancelled schedule ${activeSchedule.id}`);
            }
          }
        }
      } catch (pifError) {
        log.error('Error checking paid-in-full:', pifError);
      }
    }

    sendSuccess(res, sanitizePayment(created), 201);
  } catch (error) {
    log.error('Create error:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to create payment');
  }
});

// Update payment
router.patch("/:id", paymentWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    const parsed = updatePaymentSchema.parse(req.body);

    const update = Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, v === null ? undefined : v])
    ) as z.infer<typeof updatePaymentSchema>;

    // If updating to check payment type, ensure check number is provided
    if (update.type === 'check' && !update.checkNumber) {
      return sendError(res, 'Check number is required for check payments', 400, 'VALIDATION_ERROR');
    }
    
    // Check if user has access to this payment (system_admin, org_admin
    // of the payment's org, or a league secretary on the payment's league).
    if (!isSystemAdmin(req.user)) {
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

    // Card payments may only be deleted by org/system admins (not
    // secretaries) — the deletion of a card payment is a payment-
    // provider-touching surface that the task explicitly keeps out of
    // the secretary role.
    if (isCardPaymentType(payment.type) && req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin') {
      return sendError(res, "Only admins can delete card payments", 403, "FORBIDDEN");
    }

    if (!isSystemAdmin(req.user)) {
      const hasAccess = await hasAccessToPayment(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to delete this payment", 403, 'FORBIDDEN');
      }
    }

    await storage.deletePayment(id);

    sendSuccess(res, { message: "Payment deleted successfully" }, 200);
  } catch (error) {
    log.error('Delete error:', error);
    sendError(res, 'Failed to delete payment');
  }
});

export default router;
