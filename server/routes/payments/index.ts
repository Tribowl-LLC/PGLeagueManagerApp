/**
 * Payment DB CRUD router (mounted at /api/payments).
 *
 * Owns the **persistence side** of payments: list, correction-safe update,
 * delete, and refund of payment rows. Canonical payment creation is composed
 * in the roster-finance router. The router is composed of focused sub-routers:
 *   - `payment-reports.ts`  — list/filter endpoint used by reporting views
 *   - `payment-record.ts`   — correction-safe update / delete payment rows
 *   - `payment-refunds.ts`  — refund flow (delegates to the payment provider)
 *
 * For provider-side execution (charging cards, customers, catalog, wallets,
 * card vault), see `payments-provider/` mounted at /api/payments-provider.
 */
import { Router } from 'express';
import paymentReportsRouter from './payment-reports.js';
import paymentRecordRouter from './payment-record.js';
import paymentRefundsRouter from './payment-refunds.js';

const router = Router();

router.use('/', paymentReportsRouter);
router.use('/', paymentRecordRouter);
router.use('/', paymentRefundsRouter);

export default router;
