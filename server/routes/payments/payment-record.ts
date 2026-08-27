/**
 * Generic payment mutation endpoints are retired. Canonical payments are
 * immutable tender parents; cash/check corrections use the tenant-scoped
 * whole-payment void endpoint and card corrections use refund/reconciliation.
 */
import { Router } from "express";
import { sendError } from "../../utils/api.js";
import { paymentWriteLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.patch("/:id", paymentWriteLimiter, (_req, res) =>
  sendError(res, "Payment records are immutable; use the whole-payment correction endpoint", 410, "PAYMENT_MUTATION_RETIRED"));
router.delete("/:id", paymentWriteLimiter, (_req, res) =>
  sendError(res, "Payment records are immutable; use the whole-payment correction endpoint", 410, "PAYMENT_MUTATION_RETIRED"));

export default router;
