/**
 * Frontend mirror of the server-side `sanitizePaymentUserMessage`
 * helper (task #514). Single function that decides what string a
 * payment-failure toast actually shows the user.
 *
 * Use it everywhere a payment-related catch block builds a toast
 * description from `error.message`. It guarantees that even if a new
 * code path forgets to map its error to a friendly sentence — or if a
 * legacy JSON-encoded payload sneaks through — the user sees a clean
 * sentence instead of `{...}`, a stack-trace fragment, or raw provider
 * jargon.
 *
 * Rules (kept intentionally identical to the server-side sanitizer):
 *   - non-string / null / undefined / whitespace-only -> generic
 *   - starts with `{` or `[` (JSON-shaped)              -> generic
 *   - contains a newline (multi-line stack frame)       -> generic
 *   - longer than 200 chars (likely raw provider detail) -> generic
 */
export const GENERIC_PAYMENT_ERROR_MESSAGE =
  'Payment could not be processed. Please try again.';

/**
 * Payment failures that are an expected part of the customer interaction.
 *
 * These failures are shown in the payment UI, but are not application
 * incidents: a customer entering an invalid card, cancelling verification,
 * or receiving a terminal decline is expected behaviour. Keep this list
 * deliberately narrow; provider outages, transport failures, and unknown
 * server errors must still reach telemetry.
 */
const HANDLED_PAYMENT_ERROR_CODES = new Set([
  'ACTION_REQUIRED',
  'CARD_DECLINED',
  'CARD_VERIFICATION_REQUIRED',
  'CUSTOMER_ACTION_REQUIRED',
  'INVALID_AMOUNT',
  'INVALID_REQUEST',
  'PAYMENT_DECLINED',
  'PAYMENT_INCOMPLETE',
  'REFUND_DECLINED',
  'TOKENIZATION_ERROR',
]);

function readPaymentErrorProperty(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
  return (error as Record<string, unknown>)[key];
}

/**
 * Returns true when the failure can be resolved by the payer (or by trying
 * the payment again from the UI) and should therefore not be sent to Sentry.
 * The error itself is never forwarded to the logger, which also keeps card
 * and provider details out of development console output.
 */
export function isHandledPaymentError(error: unknown): boolean {
  const code = readPaymentErrorProperty(error, 'code');
  const status = readPaymentErrorProperty(error, 'status');
  if (typeof code === 'string' && HANDLED_PAYMENT_ERROR_CODES.has(code.toUpperCase())) {
    return true;
  }
  // Square uses HTTP 402 for a card/terminal decline and 400 for an
  // actionable validation error.  Authentication, rate limits, and 5xx
  // responses are intentionally not included: those indicate an outage or
  // provider/server problem and should be reported.
  if (status === 400 || status === 402) return true;

  const message = readPaymentErrorProperty(error, 'message');
  if (typeof message !== 'string') return false;
  return /(?:check your card details|card (?:was )?declined|payment (?:was )?declined|customer action required|verification required|tokeniz(?:ation|e))/i.test(message);
}

export function sanitizePaymentErrorMessage(
  input: unknown,
  fallback: string = GENERIC_PAYMENT_ERROR_MESSAGE,
): string {
  let msg: string | undefined;
  if (input instanceof Error) {
    msg = input.message;
  } else if (typeof input === 'string') {
    msg = input;
  }
  if (typeof msg !== 'string') return fallback;
  const trimmed = msg.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return fallback;
  if (trimmed.includes('\n') || trimmed.includes('\r')) return fallback;
  if (trimmed.length > 200) return fallback;
  return trimmed;
}
