/**
 * Charge execution + verification for the payments-provider router.
 *
 * Routes:
 *  - POST /payments
 *  - GET  /payments/:paymentId/verify
 */
import { Router } from 'express';
import crypto from 'crypto';
import { getEffectiveBowlingWeeks } from '@shared/schedule-utils';
import { storage } from '../../storage';
import { sendError } from '../../utils/api.js';
import { hasAccessToLeague, hasAccessToBowler, hasAccessToPayment, isOrgOrHigher } from '../../utils/access-control.js';
import { canUserPayForBowler } from '../../utils/bowler-payment-authz.js';
import { paymentLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';
import {
  getPaymentProvider,
  ProviderNotConfiguredError,
  PaymentProviderError,
  GENERIC_PAYMENT_USER_MESSAGE,
} from '../../services/payment-provider-factory';
import { buildPaymentErrorResponse } from '../../utils/payment-error-response.js';
import { computePaymentSplit, buildLineItems } from '../../services/payment-execution';
import { getProviderCustomerId, ensureProviderCustomer } from '../../services/payment-utils';
import { providerNameToPaymentType } from '@shared/schema/constants';
import { isDev } from '../../config';
import { getProviderForLeague } from './shared.js';

const log = createLogger('Payments');

const router = Router();

router.get('/payments/:paymentId/verify', async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== 'system_admin' && userRole !== 'org_admin') {
      return sendError(res, 'Admin access required', 403, 'FORBIDDEN');
    }

    const dbPayment = await storage.getPaymentById(parseInt(req.params.paymentId));
    if (!dbPayment) {
      return sendError(res, 'Payment not found', 404, 'NOT_FOUND');
    }

    if (userRole !== 'system_admin' && !await hasAccessToPayment(req, dbPayment.id)) {
      return sendError(res, 'Payment not found', 404, 'NOT_FOUND');
    }

    if (!dbPayment.providerPaymentId) {
      return res.json({
        dbPayment: { id: dbPayment.id, amount: dbPayment.amount, status: dbPayment.status, type: dbPayment.type, createdAt: dbPayment.createdAt },
        providerPayment: null,
        message: 'No payment ID associated with this payment (cash/check payment)',
      });
    }

    const provider = await getProviderForLeague(dbPayment.leagueId);
    let providerPayment = null;
    try {
      providerPayment = await provider.getPayment(dbPayment.providerPaymentId);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        log.warn('Payment verification: provider not configured', { leagueId: dbPayment.leagueId, paymentId: dbPayment.id });
      } else {
        throw e;
      }
    }

    if (isDev) log.info('Payment verification:', {
      dbPaymentId: dbPayment.id,
      providerPaymentId: dbPayment.providerPaymentId,
      providerFound: !!providerPayment,
      providerStatus: providerPayment?.status,
      dbStatus: dbPayment.status,
    });

    res.json({
      dbPayment: {
        id: dbPayment.id,
        amount: dbPayment.amount,
        status: dbPayment.status,
        type: dbPayment.type,
        providerPaymentId: dbPayment.providerPaymentId,
        createdAt: dbPayment.createdAt,
        bowlerId: dbPayment.bowlerId,
        leagueId: dbPayment.leagueId,
      },
      providerPayment: providerPayment,
      match: providerPayment ? {
        statusMatch: (dbPayment.status === 'paid' && providerPayment.status === 'COMPLETED') ||
                     (dbPayment.status !== 'paid' && providerPayment.status !== 'COMPLETED'),
        amountMatch: String(dbPayment.amount) === providerPayment.amountMoney.amount,
      } : null,
      message: providerPayment
        ? `Payment found: ${providerPayment.status}, $${(parseInt(providerPayment.amountMoney.amount) / 100).toFixed(2)}`
        : 'Payment NOT found — payment may have failed or been processed under different credentials',
    });
  } catch (error) {
    log.error('Payment verification error:', error);
    sendError(res, 'Failed to verify payment', 500);
  }
});

/**
 * Task #706 — Combined partner pay (one-time, all card modes).
 *
 * Accepts ONE provider charge for the full sum, then writes N
 * per-bowler payment rows (self + accepted-link partners) inside a
 * single DB transaction with a shared `combinedChargeGroupId`. Each
 * payee is independently authorized via canUserPayForBowler at
 * execution time so a since-revoked link can't keep being charged.
 *
 * Request body:
 *   {
 *     sourceId: string,                      // card token / saved card id / wallet token
 *     leagueId: number,
 *     payees: [{ bowlerId: number, amount: number }, ...],   // sum must equal `amount`
 *     amount: number,                        // total charged
 *     storeCard?: boolean,
 *     buyerEmail?: string,
 *   }
 */
router.post('/combined-payments', paymentLimiter, async (req, res) => {
  try {
    const { sourceId, amount, leagueId, payees } = req.body as {
      sourceId?: string;
      amount?: number;
      leagueId?: number;
      payees?: Array<{ bowlerId?: number; amount?: number }>;
      storeCard?: boolean;
      buyerEmail?: string;
    };

    if (!sourceId || !leagueId) {
      return sendError(res, 'Missing required payment fields', 400, 'VALIDATION_ERROR');
    }
    if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      return sendError(res, 'Amount must be a positive integer', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(payees) || payees.length === 0) {
      return sendError(res, 'payees must be a non-empty array', 400, 'VALIDATION_ERROR');
    }
    if (payees.length > 25) {
      return sendError(res, 'Too many payees in a single combined charge', 400, 'VALIDATION_ERROR');
    }

    // Normalize + dedupe.
    const seen = new Set<number>();
    const cleanPayees: Array<{ bowlerId: number; amount: number }> = [];
    for (const p of payees) {
      const bowlerId = Number(p?.bowlerId);
      const payeeAmount = Number(p?.amount);
      if (!Number.isInteger(bowlerId) || bowlerId <= 0) {
        return sendError(res, 'Each payee must have a positive integer bowlerId', 400, 'VALIDATION_ERROR');
      }
      if (!Number.isInteger(payeeAmount) || payeeAmount <= 0) {
        return sendError(res, 'Each payee amount must be a positive integer', 400, 'VALIDATION_ERROR');
      }
      if (seen.has(bowlerId)) {
        return sendError(res, 'Duplicate bowlerId in payees', 400, 'VALIDATION_ERROR');
      }
      seen.add(bowlerId);
      cleanPayees.push({ bowlerId, amount: payeeAmount });
    }

    const summed = cleanPayees.reduce((s, p) => s + p.amount, 0);
    if (summed !== amount) {
      return sendError(
        res,
        `payees amount sum (${summed}) must equal total amount (${amount})`,
        400,
        'VALIDATION_ERROR',
      );
    }

    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const league = await storage.getLeague(leagueId);
    if (!league) {
      return sendError(res, 'League not found', 404, 'NOT_FOUND');
    }
    if (!league.weeklyFee) {
      return sendError(res, 'League has no weekly fee configured', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    if (!league.seasonStart || !league.seasonEnd) {
      return sendError(res, 'League has no season dates configured', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    if (league.organizationId == null) {
      return sendError(res, 'League is not assigned to an organization', 400, 'LEAGUE_NOT_CONFIGURED');
    }

    const totalWeeks = league.totalBowlingWeeks != null
      ? getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? [])
      : Math.max(1, Math.ceil(
          (new Date(league.seasonEnd).getTime() - new Date(league.seasonStart).getTime()) /
            (7 * 24 * 60 * 60 * 1000),
        ));
    const fullSeasonAmount = league.weeklyFee * totalWeeks;

    // Authorize EACH payee independently. The actor must pass
    // canUserPayForBowler for every target — a since-revoked link or
    // cross-org payee aborts the whole batch (atomic).
    let payerBowlerId: number | undefined;
    for (const p of cleanPayees) {
      const authz = await canUserPayForBowler(req, p.bowlerId);
      if (!authz.allowed) {
        return sendError(res, `You don't have access to bowler ${p.bowlerId}`, 403, 'FORBIDDEN');
      }
      if (payerBowlerId === undefined) payerBowlerId = authz.payerBowlerId;
    }
    if (!payerBowlerId) {
      return sendError(res, 'Combined pay requires a payer bowler', 403, 'FORBIDDEN');
    }
    const payerBowler = await storage.getBowler(payerBowlerId);
    if (!payerBowler || payerBowler.organizationId !== league.organizationId) {
      return sendError(res, 'Payer bowler is not in the same org as this league', 403, 'FORBIDDEN');
    }

    // Per-payee remaining-balance check + verify each payee bowler
    // exists in the same org as the league.
    const payeeBowlers: Record<number, Awaited<ReturnType<typeof storage.getBowler>>> = {};
    for (const p of cleanPayees) {
      const b = await storage.getBowler(p.bowlerId);
      if (!b) return sendError(res, `Bowler ${p.bowlerId} not found`, 404, 'NOT_FOUND');
      if (b.organizationId !== league.organizationId) {
        return sendError(res, `Bowler ${p.bowlerId} is not in this league's organization`, 403, 'FORBIDDEN');
      }
      // P1 security: payee must be actively rostered in the selected
      // league, not merely in the same org. Otherwise an accepted payment
      // partner could push a charge onto a league the payee isn't in.
      if (!(await storage.isBowlerActiveInLeague(p.bowlerId, leagueId))) {
        return sendError(res, `Bowler ${p.bowlerId} is not rostered in this league`, 400, 'BOWLER_NOT_IN_LEAGUE');
      }
      payeeBowlers[p.bowlerId] = b;

      const existing = await storage.getPayments({
        bowlerId: p.bowlerId,
        leagueId,
        organizationId: league.organizationId,
      });
      const totalPaid = existing
        .filter((row) => row.status === 'paid')
        .reduce((s, r) => s + (r.amount || 0), 0);
      const remaining = Math.max(0, fullSeasonAmount - totalPaid);
      if (p.amount > remaining) {
        return sendError(
          res,
          `Amount for bowler ${p.bowlerId} ($${(p.amount / 100).toFixed(2)}) exceeds remaining balance ($${(remaining / 100).toFixed(2)})`,
          400,
          'AMOUNT_EXCEEDS_BALANCE',
        );
      }
    }

    const provider = await getPaymentProvider(league.locationId ?? null);

    const trimmedBuyerEmail = typeof req.body.buyerEmail === 'string'
      ? req.body.buyerEmail.trim()
      : '';
    const buyerEmail = payerBowler.email || trimmedBuyerEmail || undefined;
    if (provider.providerName === 'square' && !buyerEmail) {
      return sendError(
        res,
        'A buyer email is required for Square card payments so the receipt can be sent.',
        400,
        'BUYER_EMAIL_REQUIRED',
      );
    }

    // Vault belongs to the payer.
    let customerId = getProviderCustomerId(payerBowler, provider);
    if (req.body.storeCard && !customerId) {
      const bootstrapped = await ensureProviderCustomer(provider, payerBowler);
      if (bootstrapped) customerId = bootstrapped;
    }

    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`combined:${payerBowlerId}:${leagueId}:${amount}:${sourceId}:${cleanPayees.map((p) => `${p.bowlerId}=${p.amount}`).join(',')}`)
      .digest('hex');
    const truncatedIdempotencyKey = idempotencyKey.substring(0, 39);

    const existingFirst = await storage.getPaymentByIdempotencyKey(idempotencyKey);
    if (existingFirst && existingFirst.combinedChargeGroupId) {
      const groupRows = await storage.getPaymentsByCombinedGroupId(existingFirst.combinedChargeGroupId);
      return res.json({
        deduplicated: true,
        status: 'COMPLETED',
        id: existingFirst.providerPaymentId,
        combinedChargeGroupId: existingFirst.combinedChargeGroupId,
        rows: groupRows.map((r) => ({ id: r.id, bowlerId: r.bowlerId, amount: r.amount })),
      });
    }

    // ONE provider charge for the full total.
    const weeklyFee = league.weeklyFee || 0;
    const quantity = weeklyFee > 0 && amount % weeklyFee === 0 ? String(amount / weeklyFee) : '1';
    const lineItems = buildLineItems(league, quantity);

    let payment;
    if (lineItems.length > 0) {
      payment = await provider.createOrderWithPayment(
        sourceId,
        amount,
        lineItems,
        req.body.storeCard,
        customerId,
        buyerEmail,
        truncatedIdempotencyKey,
      );
    } else {
      payment = await provider.processPayment(
        sourceId,
        amount,
        req.body.storeCard,
        customerId,
        buyerEmail,
        truncatedIdempotencyKey,
      );
    }
    if (!payment?.id) {
      return sendError(res, 'Combined charge failed to return a payment id', 500, 'PAYMENT_ERROR');
    }

    let storedCardId: string | undefined;
    if (req.body.storeCard && customerId && sourceId && !provider.validateCardId(sourceId)) {
      try {
        const savedCard = await provider.saveCardOnFile(sourceId, customerId);
        if (savedCard?.id) {
          storedCardId = savedCard.id;
          try {
            await storage.updatePaymentScheduleCard(payerBowlerId, leagueId, savedCard.id);
          } catch {
            /* no schedule yet — fine */
          }
        }
      } catch (err) {
        log.error('combined-pay: failed to save card on file', err);
      }
    }

    // Insert N rows in a single DB transaction with the shared group id.
    const groupId = crypto.randomUUID();
    const weekOf = new Date();
    weekOf.setHours(0, 0, 0, 0);

    let createdRows: Array<{ id: number; bowlerId: number; amount: number }> = [];
    try {
      createdRows = await storage.createCombinedPayments(
        cleanPayees.map((p, idx) => {
          const { lineageAmount, prizeFundAmount } = computePaymentSplit(p.amount, league);
          return {
            bowlerId: p.bowlerId,
            leagueId,
            amount: p.amount,
            lineageAmount,
            prizeFundAmount,
            weekOf: weekOf.toISOString(),
            status: 'paid' as const,
            type: providerNameToPaymentType(provider.providerName),
            providerPaymentId: payment.id,
            receiptUrl: payment.receiptUrl,
            receiptNumber: payment.receiptNumber,
            receiptEmailMissing: false,
            // Only the first row carries the idempotency key (UNIQUE column).
            idempotencyKey: idx === 0 ? idempotencyKey : undefined,
            combinedChargeGroupId: groupId,
            paidByUserId: req.user?.id ?? null,
            notes: p.bowlerId === payerBowlerId
              ? 'Combined payment (self + partners)'
              : 'Combined payment (paid by partner)',
          };
        }),
      );
    } catch (insertErr) {
      // Best-effort refund the provider charge and bail.
      log.error('combined-pay: per-bowler insert failed, refunding provider charge', {
        groupId,
        providerPaymentId: payment.id,
        error: insertErr instanceof Error ? { name: insertErr.name, message: insertErr.message } : insertErr,
      });
      try {
        await provider.refundPayment(payment.id, amount);
      } catch (refundErr) {
        log.error('combined-pay: refund after insert-failure ALSO failed', {
          providerPaymentId: payment.id,
          error: refundErr instanceof Error ? { name: refundErr.name, message: refundErr.message } : refundErr,
        });
      }
      return sendError(res, 'Combined payment could not be recorded — the charge has been refunded.', 500, 'PAYMENT_RECORD_FAILED');
    }

    res.json({
      ...payment,
      combinedChargeGroupId: groupId,
      rows: createdRows,
      savedCardId: storedCardId ?? null,
    });
  } catch (error) {
    const errDetail = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') }
      : error;
    log.error('combined-pay: processing error', { error: errDetail });
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      GENERIC_PAYMENT_USER_MESSAGE,
      'PAYMENT_ERROR',
    );
    return sendError(res, userMessage, status, code);
  }
});

router.post('/payments', paymentLimiter, async (req, res) => {
  try {
    const { sourceId, amount, bowlerId, leagueId } = req.body;

    if (isDev) log.info('Payment request received:', {
      bowlerId,
      leagueId,
      amount,
      hasSourceId: !!sourceId,
      userId: req.user?.id,
    });

    if (!sourceId || !bowlerId || !leagueId) {
      return sendError(res, 'Missing required payment fields', 400, 'VALIDATION_ERROR');
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return sendError(res, 'Amount must be a positive number', 400, 'VALIDATION_ERROR');
    }

    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    // Authorize: self OR accepted-link partner OR org/system admin.
    // Non-admin bowlers must pass canUserPayForBowler — same-league
    // alone is NOT a valid pay path.
    const payAuthz = await canUserPayForBowler(req, bowlerId);
    let isAdminFallback = false;
    if (!payAuthz.allowed) {
      if (!req.user || !isOrgOrHigher(req.user)) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
      if (!await hasAccessToBowler(req, bowlerId)) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
      isAdminFallback = true;
    }
    // when the payer is a *different* bowler from the target
    // (partner pay), the saved-card / wallet customer id MUST come from
    // the PAYER's vault, not the target's — the card on file lives with
    // the payer. We resolve `payerBowler` here and use it below to
    // derive `customerId` instead of the target bowler.
    const isPartnerPay =
      !isAdminFallback &&
      payAuthz.payerBowlerId !== undefined &&
      payAuthz.payerBowlerId !== bowlerId;
    const payerBowler =
      isPartnerPay && payAuthz.payerBowlerId !== undefined
        ? await storage.getBowler(payAuthz.payerBowlerId)
        : null;
    if (isPartnerPay && !payerBowler) {
      return sendError(res, "Payer bowler not found", 404, 'NOT_FOUND');
    }

    const league = await storage.getLeague(leagueId);
    if (!league) {
      return sendError(res, 'League not found', 404, 'NOT_FOUND');
    }

    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) {
      return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
    }

    if (!league.weeklyFee) {
      return sendError(res, 'League has no weekly fee configured — cannot process payment', 400, 'LEAGUE_NOT_CONFIGURED');
    }

    if (!league.seasonStart || !league.seasonEnd) {
      return sendError(res, 'League has no season dates configured — cannot process payment', 400, 'LEAGUE_NOT_CONFIGURED');
    }

    const seasonStart = new Date(league.seasonStart);
    const seasonEnd = new Date(league.seasonEnd);
    let totalWeeks: number;
    if (league.totalBowlingWeeks != null) {
      totalWeeks = getEffectiveBowlingWeeks(
        league.totalBowlingWeeks,
        league.cancelledDates ?? []
      );
    } else {
      totalWeeks = Math.max(1, Math.ceil((seasonEnd.getTime() - seasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000)));
    }
    const fullSeasonAmount = league.weeklyFee * totalWeeks;

    if (league.organizationId == null) {
      return sendError(res, 'League is not assigned to an organization', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    // P1 security: the recipient bowler must belong to the league's org
    // AND be actively rostered in this league before we charge a card and
    // write a payment row for the (bowler, league) pair.
    if (bowler.organizationId !== league.organizationId) {
      return sendError(res, "Bowler is not in this league's organization", 403, 'FORBIDDEN');
    }
    if (!(await storage.isBowlerActiveInLeague(bowlerId, leagueId))) {
      return sendError(res, 'Bowler is not rostered in this league', 400, 'BOWLER_NOT_IN_LEAGUE');
    }
    const existingPayments = await storage.getPayments({ bowlerId, leagueId, organizationId: league.organizationId });
    const totalPaid = existingPayments
      .filter((p) => p.status === 'paid')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    const remainingBalance = Math.max(0, fullSeasonAmount - totalPaid);

    if (amount > remainingBalance) {
      return sendError(res, `Amount ($${(amount / 100).toFixed(2)}) exceeds remaining balance ($${(remainingBalance / 100).toFixed(2)})`, 400, 'AMOUNT_EXCEEDS_BALANCE');
    }

    const weekOf = new Date();
    weekOf.setHours(0, 0, 0, 0);

    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${bowlerId}:${leagueId}:${amount}:${sourceId}`)
      .digest('hex');

    const existingPayment = await storage.getPaymentByIdempotencyKey(idempotencyKey);
    const truncatedIdempotencyKey = idempotencyKey.substring(0, 39);
    if (existingPayment) {
      log.info('Payment deduplicated (same token resubmitted):', { dbPaymentId: existingPayment.id, providerPaymentId: existingPayment.providerPaymentId, bowlerId, leagueId, amount });
      return res.json({ dbPaymentId: existingPayment.id, id: existingPayment.providerPaymentId, status: 'COMPLETED', deduplicated: true });
    }

    const provider = await getPaymentProvider(league.locationId ?? null);

    // For partner-pay the saved-card / wallet customer id comes from
    // the payer's vault. Admin-fallback never carries a payer vault and
    // must not write into the recipient's vault.
    if (isAdminFallback && req.body.storeCard) {
      return sendError(
        res,
        "Admins cannot save a card to a bowler's vault from this checkout. Use the bowler's own dashboard or the admin manual-payment path.",
        403,
        'ADMIN_VAULT_WRITE_FORBIDDEN',
      );
    }
    const vaultBowler = isPartnerPay && payerBowler ? payerBowler : bowler;
    let customerId = isAdminFallback
      ? undefined
      : getProviderCustomerId(vaultBowler, provider);
    if (req.body.storeCard && !customerId) {
      const bootstrapped = await ensureProviderCustomer(provider, vaultBowler);
      if (bootstrapped) {
        customerId = bootstrapped;
      } else {
        log.warn('Cannot store card — bowler has no customer ID and bootstrap failed:', vaultBowler.id);
      }
    }

    const weeklyFee = league.weeklyFee || 0;
    const quantity = weeklyFee > 0 && amount % weeklyFee === 0
      ? String(amount / weeklyFee)
      : '1';
    const lineItems = buildLineItems(league, quantity);

    // bowler.email is the default; the checkout UI may
    // also pass an explicit `buyerEmail` in the body so a bowler with
    // no email on file can still capture one inline at payment time
    // and trigger Square's hosted receipt.
    const requestBuyerEmail = typeof req.body.buyerEmail === 'string'
      ? req.body.buyerEmail.trim()
      : '';
    const buyerEmail = bowler.email || requestBuyerEmail || undefined;

    // HARD-ENFORCE buyer email for interactive Square charges.
    // This route only handles user-driven checkouts (a sourceId from a card
    // form / Apple Pay / Google Pay), so we have a human who can supply an
    // email. Autopay (server/services/payment-execution.ts) is the only
    // unattended Square path and is allowed to warn+flag without an email.
    // The matching frontend forms make the inline "Email for receipt" field
    // required when bowler.email is missing; this is the server-side guard.
    if (provider.providerName === 'square' && !buyerEmail) {
      return sendError(
        res,
        "A buyer email is required for Square card payments so the receipt can be sent. Add an email to the bowler's profile or enter one at checkout.",
        400,
        'BUYER_EMAIL_REQUIRED',
      );
    }

    // when a bowler self-checks-out (their own user account
    // is linked to this bowler row) and supplies a brand-new email at
    // checkout, persist it to their profile. This means the very next
    // charge will already have an email on file — no inline prompt and
    // no need to use the admin Resend flow.
    const isSelfCheckout = !!req.user?.bowlerId && req.user.bowlerId === bowlerId;
    if (isSelfCheckout && !bowler.email && requestBuyerEmail) {
      try {
        await storage.updateBowler(bowlerId, { email: requestBuyerEmail });
      } catch (err) {
        // Non-fatal: payment must still proceed even if profile save
        // fails (validation, race, etc.). Log for ops visibility.
        log.warn('Failed to backfill bowler email at self-checkout', {
          bowlerId, error: err instanceof Error ? err.message : err,
        });
      }
    }

    if (isDev) log.info('Processing payment:', {
      bowlerId, leagueId, amount,
      locationId: league.locationId,
      provider: provider.providerName,
      hasLineItems: lineItems.length > 0,
      hasCustomerId: !!customerId,
    });

    let payment;
    let storedCardId: string | undefined;

    if (lineItems.length > 0) {
      payment = await provider.createOrderWithPayment(
        sourceId,
        amount,
        lineItems,
        req.body.storeCard,
        customerId,
        buyerEmail,
        truncatedIdempotencyKey
      );
    } else {
      payment = await provider.processPayment(
        sourceId,
        amount,
        req.body.storeCard,
        customerId,
        buyerEmail,
        truncatedIdempotencyKey,
      );
    }

    log.info('Payment completed:', {
      paymentId: payment.id,
      paymentStatus: payment.status,
      bowlerId, leagueId, amount,
    });

    if (req.body.storeCard && customerId && sourceId && !provider.validateCardId(sourceId)) {
      const cid = customerId;
      try {
        const savedCard = await provider.saveCardOnFile(sourceId, cid);
        if (savedCard?.id) {
          log.info('Card saved on file:', { success: true });
          storedCardId = savedCard.id;
          try {
            // Card saved against payer vault — schedule belongs to vault owner.
            await storage.updatePaymentScheduleCard(
              vaultBowler.id,
              leagueId,
              savedCard.id
            );
          } catch (schedError) {
            if (isDev) log.info('No payment schedule to update (normal for one-time payments)');
          }
        }
      } catch (error) {
        log.error('Failed to save card on file:', error);
      }
    }

    const { lineageAmount, prizeFundAmount } = computePaymentSplit(amount, league);

    // Capture Square's hosted-receipt fields. Interactive Square
    // charges are gated by BUYER_EMAIL_REQUIRED above, so by the
    // time we reach this insert `buyerEmail` is always present for
    // Square — receiptEmailMissing therefore stays false here and
    // is only set true on the unattended/autopay path.
    const dbPayment = await storage.createPayment({
      bowlerId,
      leagueId,
      amount,
      lineageAmount,
      prizeFundAmount,
      weekOf: weekOf.toISOString(),
      status: 'paid',
      type: providerNameToPaymentType(provider.providerName),
      providerPaymentId: payment.id,
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
      receiptEmailMissing: false,
      idempotencyKey,
      // only stamp paidByUserId when the actor is paying for
      // SOMEONE ELSE'S bowler (partner pay or admin-on-behalf). Self-pay
      // leaves it null because attribution would be redundant with the
      // bowler's own owning user.
      paidByUserId:
        isPartnerPay || (isAdminFallback && req.user?.bowlerId !== bowlerId)
          ? req.user?.id ?? null
          : null,
    });

    if (isDev) log.info('Payment recorded in DB:', {
      dbPaymentId: dbPayment.id,
      paymentId: payment.id,
      bowlerId, leagueId, amount,
    });

    res.json({
      ...payment,
      dbPaymentId: dbPayment.id,
      savedCardId: storedCardId ?? null,
    });
  } catch (error) {
    // Always log the full technical detail server-side, regardless of
    // which user-facing branch we take below. Includes the typed
    // `detail` (Square's raw `errors[0].detail`) when present, plus
    // any structured `errors[]` fields we can pull off a raw ApiError
    // that escaped the provider's own catch.
    const errDetail = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
    } : error;
    type ProviderErrorDetail = { detail?: string };
    const providerErrors: ProviderErrorDetail[] | undefined = (() => {
      if (!error || typeof error !== 'object') return undefined;
      const e = error as { errors?: unknown; body?: { errors?: unknown } };
      const found = e.errors ?? e.body?.errors;
      return Array.isArray(found) ? (found as ProviderErrorDetail[]) : undefined;
    })();
    log.error('Payment processing error:', {
      error: errDetail,
      providerErrors,
      typedCode: error instanceof PaymentProviderError ? error.code : undefined,
      typedDetail: error instanceof PaymentProviderError ? error.detail : undefined,
    });

    // task #514 / #605: only the typed `userMessage` is allowed
    // through to the client — Square's raw `providerErrors[0].detail`
    // is NOT forwarded as a user message anymore (it can contain
    // provider jargon like "Card was declined by the issuing bank for
    // reason CARD_DECLINED_VERIFICATION_REQUIRED"). The unrecognized
    // fallback is a single, friendly sentence. Mapping is delegated
    // to the shared helper so the refund / cards / autopay paths
    // can't drift from this contract.
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      GENERIC_PAYMENT_USER_MESSAGE,
      'PAYMENT_ERROR',
    );
    return sendError(res, userMessage, status, code);
  }
});

export default router;
