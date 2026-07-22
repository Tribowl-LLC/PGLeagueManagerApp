/**
 * Clover Ecommerce webhook receiver (task #577).
 *
 * The disabled Square tripwire is registered separately and earlier in
 * `server/app.ts` so it can enforce its small body limit without the global
 * JSON parser capturing raw payload bytes.
 *
 * Mounted at `/api/payments-provider/webhooks` from
 * `server/routes/index.ts` BEFORE the session-auth middleware so real
 * Clover traffic (which has no browser session) can reach it. The
 * matching CSRF EXEMPT_PATHS entry is in `server/middleware/csrf.ts`.
 *
 * Because the path is unauthenticated, every request is verified via
 * HMAC-SHA256 over the raw body using `CLOVER_WEBHOOK_SIGNING_SECRET`.
 * The raw body is captured by the `verify` hook on `express.json()` in
 * `server/index.ts`. Requests with a missing or mismatched signature
 * are rejected with 401 BEFORE any storage lookup.
 *
 * Branches:
 *   - refund.created / refund.updated / refund.succeeded /
 *     charge.refunded → mark row `status='refunded'`, persist provider
 *     refund id (column is named `squareRefundId` for legacy reasons —
 *     see `storage.refundPayment`), stamp `refundedAt`. Already-refunded
 *     rows are a 200 no-op so duplicate / out-of-order replays don't
 *     re-stamp `refundedAt`.
 *   - refund.failed → 200 ack, log only. No schema column for refund
 *     failures today.
 *   - dispute.created / charge.dispute.created / chargeback.created →
 *     mark row `status='disputed'`, persist `disputeId`, stamp
 *     `disputedAt`. Already-disputed rows are a 200 no-op so duplicate /
 *     out-of-order replays don't re-stamp `disputedAt`. A dispute on an
 *     unknown / refunded row is logged and acked without mutation.
 *   - unknown / missing type, missing or unknown charge id → 200 ack
 *     (4xx would make Clover replay forever).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { storage } from '../../storage';
import { sendError, sendSuccess } from '../../utils/api.js';
import { createLogger } from '../../logger';

const log = createLogger('CloverWebhook');

const REFUND_SETTLED_TYPES = new Set([
  'refund.created',
  'refund.updated',
  'refund.succeeded',
  'charge.refunded',
]);

const REFUND_FAILED_TYPES = new Set([
  'refund.failed',
]);

const DISPUTE_TYPES = new Set([
  'dispute.created',
  'charge.dispute.created',
  'chargeback.created',
]);

const SIGNATURE_HEADER = 'x-clover-signature';
const SIGNATURE_ALGORITHM = 'sha256';

/**
 * Probe seam for the third-party pin verifier (task #651). Re-derives
 * the signature scheme literal directly from the constants the
 * receiver actually uses, so a hand-edit to `SIGNATURE_HEADER` /
 * `SIGNATURE_ALGORITHM` immediately drifts from the pinned value
 * registered in `server/services/third-party-pins.ts`. Production
 * code never calls this.
 */
export function describeCloverSignatureSchemeForPinVerifier(): string {
  return `hmac-${SIGNATURE_ALGORITHM}(${SIGNATURE_HEADER})`;
}

interface CloverWebhookEventObject {
  id?: string;
  charge?: string;
  amount?: number;
  reason?: string;
  status?: string;
}

interface CloverWebhookEvent {
  id?: string;
  type?: string;
  data?: { object?: CloverWebhookEventObject };
}

/**
 * HMAC-SHA256 signature gate. Constant-time comparison so a timing
 * side-channel cannot leak the secret one byte at a time.
 *
 * Test-only escape hatch: when `CLOVER_WEBHOOK_SIGNING_SECRET` is unset
 * AND `NODE_ENV === 'test'`, signature verification is skipped so unit
 * tests can post events without managing a fake secret. In production
 * the secret is required (an unset secret means every webhook is 503'd).
 */
function verifyCloverSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CLOVER_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'test') {
      return next();
    }
    log.error('CLOVER_WEBHOOK_SIGNING_SECRET is not set — rejecting webhook');
    sendError(res, 'Webhook signing secret not configured', 503, 'WEBHOOK_NOT_CONFIGURED');
    return;
  }
  const presented = req.header(SIGNATURE_HEADER);
  if (!presented) {
    log.warn('Clover webhook missing signature header');
    sendError(res, 'Missing signature', 401, 'WEBHOOK_SIGNATURE_MISSING');
    return;
  }
  const raw = req.rawBody;
  if (!raw) {
    log.error('Clover webhook raw body unavailable — express.json verify hook may be misconfigured');
    sendError(res, 'Cannot verify signature', 500, 'WEBHOOK_RAW_BODY_MISSING');
    return;
  }
  const expected = createHmac(SIGNATURE_ALGORITHM, secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    log.warn('Clover webhook signature mismatch');
    sendError(res, 'Invalid signature', 401, 'WEBHOOK_SIGNATURE_INVALID');
    return;
  }
  next();
}

const router = Router();

router.post('/clover', verifyCloverSignature, async (req, res) => {
  const event = (req.body ?? {}) as CloverWebhookEvent;
  const eventType = event.type;
  const eventId = event.id;
  const obj = event.data?.object ?? {};
  const chargeId = obj.charge;
  const refundOrDisputeId = obj.id;

  if (!eventType) {
    log.warn('Clover webhook missing type — ignoring', { eventId });
    return sendSuccess(res, { received: true, ignored: 'missing_type' });
  }

  if (REFUND_SETTLED_TYPES.has(eventType)) {
    if (!chargeId) {
      log.warn('Clover refund webhook missing charge id', { eventType, eventId });
      return sendSuccess(res, { received: true, ignored: 'missing_charge' });
    }
    const payment = await storage.getPaymentByCloverChargeId(chargeId);
    if (!payment) {
      log.warn('Clover refund webhook for unknown charge', { eventType, eventId, chargeId });
      return sendSuccess(res, { received: true, ignored: 'unknown_charge' });
    }
    if (payment.status === 'refunded') {
      log.info('Clover refund webhook for already-refunded payment — skipping', {
        eventType, eventId, chargeId, paymentId: payment.id,
      });
      return sendSuccess(res, {
        received: true,
        ignored: 'already_refunded',
        paymentId: payment.id,
      });
    }
    const updated = await storage.refundPayment(
      payment.id,
      refundOrDisputeId,
      obj.reason ?? 'Refund settled via Clover webhook',
    );
    log.info('Clover refund webhook applied', {
      eventType, eventId, chargeId, paymentId: payment.id, refundId: refundOrDisputeId,
    });
    return sendSuccess(res, {
      received: true,
      action: 'refund_settled',
      paymentId: payment.id,
      status: updated.status,
      refundedAt: updated.refundedAt,
    });
  }

  if (REFUND_FAILED_TYPES.has(eventType)) {
    log.warn('Clover refund failed webhook — ack only', { eventType, eventId, chargeId });
    return sendSuccess(res, { received: true, ignored: 'refund_failed_logged' });
  }

  if (DISPUTE_TYPES.has(eventType)) {
    if (!chargeId) {
      log.warn('Clover dispute webhook missing charge id', { eventType, eventId });
      return sendSuccess(res, { received: true, ignored: 'missing_charge' });
    }
    const payment = await storage.getPaymentByCloverChargeId(chargeId);
    if (!payment) {
      log.warn('Clover dispute webhook for unknown charge', { eventType, eventId, chargeId });
      return sendSuccess(res, { received: true, ignored: 'unknown_charge' });
    }
    if (payment.status === 'disputed') {
      log.info('Clover dispute webhook for already-disputed payment — skipping', {
        eventType, eventId, chargeId, paymentId: payment.id,
      });
      return sendSuccess(res, {
        received: true,
        ignored: 'already_disputed',
        paymentId: payment.id,
      });
    }
    if (payment.status === 'refunded') {
      // Out-of-order replay: a dispute event arriving after the row has
      // already been refunded should not silently overwrite the terminal
      // `refunded` state. Ack and ignore.
      log.warn('Clover dispute webhook for already-refunded payment — skipping', {
        eventType, eventId, chargeId, paymentId: payment.id,
      });
      return sendSuccess(res, {
        received: true,
        ignored: 'already_refunded',
        paymentId: payment.id,
      });
    }
    if (!refundOrDisputeId) {
      log.warn('Clover dispute webhook missing dispute id', {
        eventType, eventId, chargeId, paymentId: payment.id,
      });
      return sendSuccess(res, { received: true, ignored: 'missing_dispute_id' });
    }
    const updated = await storage.openDispute(payment.id, refundOrDisputeId);
    log.warn('Clover dispute webhook applied', {
      eventType, eventId, chargeId, paymentId: payment.id, disputeId: refundOrDisputeId,
    });
    return sendSuccess(res, {
      received: true,
      action: 'dispute_opened',
      paymentId: payment.id,
      status: updated.status,
      disputedAt: updated.disputedAt,
    });
  }

  log.info('Clover webhook ignored unknown event type', { eventType, eventId });
  return sendSuccess(res, { received: true, ignored: 'unknown_event_type' });
});

export default router;
