import type { Logger } from "../logger.js";
import { isHandledPaymentProviderError } from "./payment-errors.js";

/**
 * Report one provider failure at the operation boundary. Declines and other
 * payer-correctable outcomes are deliberately omitted; the server logger's
 * error-object dedupe preserves exactly-once reporting for the remaining
 * Error/cause chain when a failure crosses another boundary.
 */
export function captureUnexpectedPaymentProviderError(
  log: Pick<Logger, "captureException">,
  error: unknown,
): void {
  if (!isHandledPaymentProviderError(error)) log.captureException(error);
}
