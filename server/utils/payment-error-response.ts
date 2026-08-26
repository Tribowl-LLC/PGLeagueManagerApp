/**
 * Shared payment-provider error mapping (task #605).
 *
 * interactive roster charge and refund
 * (server/routes/payments/payment-refunds.ts) routes already surface
 * the typed `PaymentProviderError.userMessage` + `code` so admins see
 * the actionable reason ("Your payment was declined.", "Invalid
 * payment information.", etc.) instead of a generic 500 wall. The
 * other payment-provider write routes (saving / removing cards on
 * file, the autopay job runner + schedule-execution path, the
 * customer-deletion path during account removal, and the
 * `POST /payments/:id/resend-receipt` route) used to wrap typed
 * provider failures in their own ad-hoc fallback strings — so an
 * admin debugging those flows still got an opaque "Failed to save
 * card" / "Failed to resend receipt" / `error.message` leak.
 *
 * This helper centralizes the three-branch shape so each call site
 * can collapse to a single `sendError(res, …)` (or equivalent
 * normalization for the non-HTTP autopay / account-deletion paths)
 * without forgetting the sanitizer or accidentally widening one
 * branch's behaviour.
 *
 * Three-branch contract pinned by the unit tests:
 *
 *   1. ProviderNotConfiguredError → 422 PROVIDER_NOT_CONFIGURED.
 *      The user-facing message is intentionally generic
 *      ("Payment provider is not configured for this location") so
 *      the underlying location id / processor name never leaks
 *      through `error.message`.
 *
 *   2. PaymentProviderError       → 500 with the typed `userMessage`
 *      + `code`. The userMessage is run through
 *      `sanitizePaymentUserMessage` as a final safety net so a
 *      mis-typed payload can never escape as JSON / stack-trace
 *      text.
 *
 *   3. Anything else              → 500 with the caller-supplied
 *      `fallbackMessage` + `fallbackCode`. The fallback message is
 *      ALSO sanitized so a future call site that accidentally
 *      forwards `error.message` here still can't leak provider
 *      jargon.
 */
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  sanitizePaymentUserMessage,
} from '../services/payment-errors';

export interface PaymentErrorResponse {
  status: number;
  userMessage: string;
  code: string;
}

export const PROVIDER_NOT_CONFIGURED_USER_MESSAGE =
  'Payment provider is not configured for this location';

export function buildPaymentErrorResponse(
  error: unknown,
  fallbackMessage: string,
  fallbackCode: string,
): PaymentErrorResponse {
  if (error instanceof ProviderNotConfiguredError) {
    return {
      status: 422,
      userMessage: PROVIDER_NOT_CONFIGURED_USER_MESSAGE,
      code: 'PROVIDER_NOT_CONFIGURED',
    };
  }
  if (error instanceof PaymentProviderError) {
    return {
      status: 500,
      userMessage: sanitizePaymentUserMessage(error.userMessage),
      code: error.code,
    };
  }
  return {
    status: 500,
    userMessage: sanitizePaymentUserMessage(fallbackMessage),
    code: fallbackCode,
  };
}
