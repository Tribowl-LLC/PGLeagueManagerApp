/**
 * Payment provider router (mounted at /api/payments-provider).
 *
 * Owns the **execution side** of payments: charging the payment provider
 * (Square), customer create/update, catalog, card vault, wallet
 * domain registration, and idempotent payment recording for live charges.
 *
 * For straight DB CRUD over the payments table (list/update/delete/refund),
 * see `../payments.ts` mounted at /api/payments.
 *
 * This file is a thin composition module: each concern lives in its own
 * sub-router under this folder and is mounted onto the same root router so
 * the public `/api/payments-provider/*` URL surface is unchanged.
 */
import { Router } from 'express';
import { requireAuthenticated } from './shared.js';
import { isPaymentManager } from '../../utils/access-control.js';
import { sendError } from '../../utils/api.js';
import chargesRouter from './charges.js';
import customersRouter from './customers.js';
import catalogRouter from './catalog.js';
import cardsRouter from './cards.js';
import applePayRouter from './apple-pay.js';
import configRouter from './config.js';
import receiptsRouter from './receipts.js';
// the app level from `server/routes/index.ts` on the more specific
// path `/api/payments-provider/webhooks` (which Express routes BEFORE
// `/api/payments-provider` because it is registered first).

const router = Router();

router.use(requireAuthenticated);

// Payment managers have a deliberately narrow provider surface: they may
// read saved cards and resend hosted receipts, but may not charge cards,
// mutate the vault, configure providers/catalogs, or run customer/autopay
// operations. Keep this deny-by-default at the composition boundary so a new
// provider sub-route cannot accidentally widen the role.
router.use((req, res, next) => {
  if (!isPaymentManager(req.user)) return next();
  const path = req.path;
  const allowedRead = req.method === 'GET' && /^\/cards\/\d+$/.test(path);
  const allowedResend = req.method === 'POST' && /^\/payments\/\d+\/resend-receipt$/.test(path);
  const allowedReceiptRead = req.method === 'GET' && /^\/payments\/\d+\/receipt$/.test(path);
  if (allowedRead || allowedResend || allowedReceiptRead) return next();
  return sendError(res, 'Payment manager provider access is restricted', 403, 'FORBIDDEN');
});

router.use(chargesRouter);
router.use(customersRouter);
router.use(catalogRouter);
router.use(cardsRouter);
router.use(applePayRouter);
router.use(configRouter);
router.use(receiptsRouter);

export default router;
