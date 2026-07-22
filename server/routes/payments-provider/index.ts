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

router.use(chargesRouter);
router.use(customersRouter);
router.use(catalogRouter);
router.use(cardsRouter);
router.use(applePayRouter);
router.use(configRouter);
router.use(receiptsRouter);

export default router;
