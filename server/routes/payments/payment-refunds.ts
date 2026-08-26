/** Durable, tenant-scoped full refunds for paid provider card rows. */
import { Router, type Response } from "express";
import type { PaymentOperation } from "@shared/schema";
import { storage } from "../../storage";
import { sendSuccess, sendError, sanitizePayment } from "../../utils/api.js";
import { singleRouteParam } from "../../utils/route-params.js";
import { paymentWriteLimiter } from "../../middleware/rate-limit.js";
import { createLogger } from "../../logger.js";
import {
  PaymentOperationImmutableMismatchError,
  PaymentOperationValidationError,
  retryRefundPaymentOperationAfterConfigurationFailure,
} from "../../storage/payment-operations.js";
import {
  prepareRefundPaymentOperation,
  RefundPreparationError,
} from "../../services/refund-payment-operation-preparation.js";
import { refundPaymentOperationExecutor } from "../../services/refund-payment-operation-executor.js";
import { scheduledPaymentOperationExecutor } from "../../services/scheduled-payment-operation-executor.js";

const log = createLogger("Payments");
const router = Router();

function operationIsDue(operation: PaymentOperation, now = new Date()): boolean {
  return operation.status === "pending"
    || (operation.nextAttemptAt !== null && new Date(operation.nextAttemptAt).getTime() <= now.getTime())
    || (operation.status === "leased" && operation.leaseExpiresAt !== null
      && new Date(operation.leaseExpiresAt).getTime() <= now.getTime());
}

function operationStatus(operation: PaymentOperation) {
  return {
    operationId: operation.id,
    status: operation.status,
    providerRefundId: operation.providerObjectId,
    retryAt: operation.nextAttemptAt,
    attemptCount: operation.attemptCount,
  };
}

async function respondWithRefundOperation(
  res: Response,
  organizationId: number,
  paymentId: number,
  operation: PaymentOperation,
): Promise<void> {
  let current = operation;
  if (current.status === "failed_terminal" && current.errorClassification === "configuration") {
    current = await retryRefundPaymentOperationAfterConfigurationFailure({
      organizationId,
      operationId: current.id,
    }) ?? current;
  }
  if (operationIsDue(current)) {
    current = await refundPaymentOperationExecutor.execute({
      organizationId,
      operationId: current.id,
    }) ?? current;
  }
  if (current.status === "succeeded") {
    // A provider-confirmed refund may finish after archive.  Resolve the
    // retained payment only through the operation's tenant scope; ordinary
    // product reads intentionally continue hiding retired legacy rows.
    const payment = typeof storage.getPaymentEvidenceByIdForOrganization === "function"
      ? await storage.getPaymentEvidenceByIdForOrganization(paymentId, organizationId)
      : await storage.getPaymentById(paymentId);
    if (!payment || payment.status !== "refunded" || payment.squareRefundId !== current.providerObjectId) {
      throw new Error("completed refund operation is missing its local payment result");
    }
    sendSuccess(res, sanitizePayment(payment));
    return;
  }
  if (current.errorClassification === "configuration") {
    sendError(
      res,
      "Square configuration needs attention for this location. Update it in Settings before the refund can continue.",
      422,
      "PROVIDER_NOT_CONFIGURED",
      operationStatus(current),
    );
    return;
  }
  if (current.status === "action_required") {
    sendError(
      res,
      "The refund was declined by the payment provider. Review the decline in Square before trying again.",
      422,
      current.errorCode ?? "REFUND_DECLINED",
      operationStatus(current),
    );
    return;
  }
  if (current.status === "failed_terminal") {
    const invalid = current.errorClassification === "invalid_request";
    sendError(
      res,
      invalid ? "The refund could not be completed for this payment." : "Failed to process refund",
      invalid ? 400 : 500,
      current.errorCode ?? "REFUND_ERROR",
      operationStatus(current),
    );
    return;
  }
  res.status(202).json({
    success: true,
    data: {
      ...operationStatus(current),
      message: current.status === "reconciliation_required"
        ? "The refund outcome is unresolved and requires reconciliation."
        : "The refund is processing. Do not submit a new refund.",
    },
  });
}

router.post("/:id/refund", paymentWriteLimiter, async (req, res) => {
  const id = Number.parseInt(singleRouteParam(req.params.id), 10);
  if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, "Invalid payment ID", 400, "INVALID_ID");
  if (!req.user) return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");
  if (req.user.role !== "org_admin" && req.user.role !== "system_admin") {
    return sendError(res, "Only admins can process refunds", 403, "FORBIDDEN");
  }

  let prepared = false;
  try {
    const { operation, snapshot } = await prepareRefundPaymentOperation({
      paymentId: id,
      reason: req.body?.reason,
      requestedByUserId: req.user.id,
      requestedByRole: req.user.role,
      requestedByOrganizationId: req.user.organizationId ?? null,
    });
    prepared = true;
    await respondWithRefundOperation(res, snapshot.organizationId, id, operation);
  } catch (error) {
    if (error instanceof RefundPreparationError) {
      return sendError(res, error.message, error.statusCode, error.code);
    }
    if (error instanceof PaymentOperationImmutableMismatchError) {
      return sendError(res, "This payment already has a refund request with different details.", 409, "REFUND_CONFLICT");
    }
    if (error instanceof PaymentOperationValidationError) {
      return sendError(res, "The refund request could not be prepared.", 400, "VALIDATION_ERROR");
    }
    log.error("Refund operation failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return sendError(res, "Failed to process refund", 500, "REFUND_ERROR");
  } finally {
    if (prepared) {
      try {
        await scheduledPaymentOperationExecutor.rearm();
      } catch (error) {
        log.error("Refund operation wake rearm failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      }
    }
  }
});

export default router;
