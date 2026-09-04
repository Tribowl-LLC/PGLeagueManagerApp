/**
 * Shared typed errors and the user-facing payment message sanitizer.
 *
 * Extracted from `payment-provider-factory.ts` to break the circular
 * import between the factory and its concrete providers
 * (square-provider). The factory imports the
 * concrete providers (to construct them), and the providers throw
 * these typed errors — putting them on the factory caused
 * `factory → provider → factory` cycles.
 *
 * The factory still re-exports the names from here for backwards
 * compatibility with the rest of the codebase.
 */

export class ProviderNotConfiguredError extends Error {
  public readonly code = 'PROVIDER_NOT_CONFIGURED';
  public readonly disposition = 'configuration' as const;
  public readonly providerCode = 'PROVIDER_NOT_CONFIGURED';

  constructor(reason: string, public readonly locationId: number | null) {
    super(reason);
    this.name = 'ProviderNotConfiguredError';
  }
}

export const PAYMENT_PROVIDER_FAILURE_DISPOSITIONS = [
  'provider_unknown',
  'transient',
  'action_required',
  'configuration',
  'invalid_request',
  'internal',
] as const;
export type PaymentProviderFailureDisposition =
  (typeof PAYMENT_PROVIDER_FAILURE_DISPOSITIONS)[number];

const HANDLED_PAYMENT_PROVIDER_CODES = new Set([
  'ACTION_REQUIRED',
  'CARD_DECLINED',
  'CARD_SAVE_REQUIRES_ACTION',
  'INVALID_REQUEST',
  'PAYMENT_DECLINED',
  'REFUND_DECLINED',
  'TOKENIZATION_ERROR',
]);

/**
 * Customer-action outcomes are part of the normal interactive payment
 * contract. They are returned to the UI for correction/retry and must not be
 * promoted to an error log or Sentry event. Provider outages, transport
 * ambiguity, and server failures intentionally remain reportable.
 */
export function isHandledPaymentProviderError(error: unknown): boolean {
  if (!(error instanceof PaymentProviderError)) return false;
  if (error.disposition === 'action_required' || error.disposition === 'invalid_request') return true;
  // Keep the code fallback for typed errors created at a boundary that does
  // not yet carry disposition metadata. These are still payer-correctable
  // outcomes; provider-unknown, configuration, and internal codes stay
  // reportable by default.
  return typeof error.code === 'string'
    && HANDLED_PAYMENT_PROVIDER_CODES.has(error.code.toUpperCase());
}

export interface PaymentProviderErrorMetadata {
  disposition?: PaymentProviderFailureDisposition;
  providerCode?: string;
  providerOrderId?: string;
}

export function sanitizeProviderErrorCode(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value.toUpperCase() : '';
  const normalizedFallback = fallback.toUpperCase();
  const safeFallback = /^[A-Z0-9][A-Z0-9_.:-]{0,127}$/.test(normalizedFallback)
    ? normalizedFallback
    : 'PROVIDER_ERROR';
  return /^[A-Z0-9][A-Z0-9_.:-]{0,127}$/.test(candidate) ? candidate : safeFallback;
}

/**
 * Typed error carrier for payment provider failures (task #514).
 *
 * Replaces the old "throw new Error(JSON.stringify({ error: { message,
 * code } }))" pattern in the Square provider — that round-tripped the
 * payload through `error.message` and forced the route to JSON.parse
 * it back out, which leaked raw JSON into the user-facing toast on
 * any parse mismatch.
 *
 * `userMessage` is the short, human-readable sentence safe to show
 * the user (e.g. "Your payment was declined. Please try a different
 * card."). `code` is the machine-readable error code we send back as
 * `error.code` in the API envelope. `detail` is the unsanitized
 * upstream provider detail (e.g. Square's `errors[0].detail`) — kept
 * for server-side logs only and NEVER shown to the user.
 *
 * `Error.message` is set to `userMessage` so server logs that print
 * `error.message` still see the friendly sentence rather than the
 * stringified payload.
 */
export class PaymentProviderError extends Error {
  public readonly userMessage: string;
  public readonly code: string;
  public readonly detail?: string;
  public readonly disposition: PaymentProviderFailureDisposition;
  public readonly providerCode: string;
  public readonly providerOrderId?: string;

  constructor(
    userMessage: string,
    code: string,
    detail?: string,
    metadata: PaymentProviderErrorMetadata = {},
  ) {
    super(userMessage);
    this.name = 'PaymentProviderError';
    this.userMessage = userMessage;
    this.code = code;
    this.detail = detail;
    this.disposition = metadata.disposition ?? 'internal';
    this.providerCode = sanitizeProviderErrorCode(metadata.providerCode, code);
    this.providerOrderId = metadata.providerOrderId;
  }
}

/**
 * Typed error for the "this card id is not on this customer's vault"
 * tenancy guard inside `disableCard` (task #620).
 */
export class CardOwnershipMismatchError extends Error {
  public readonly code = 'CARD_OWNERSHIP_MISMATCH';

  constructor(message = 'Card does not belong to this customer') {
    super(message);
    this.name = 'CardOwnershipMismatchError';
  }
}

/**
 * Generic, always-safe payment failure message for the user. Used as
 * the fallback whenever a candidate user-facing string fails the
 * sanitizer below.
 */
export const GENERIC_PAYMENT_USER_MESSAGE =
  'Payment could not be processed. Please try again.';

/**
 * Final safety net on the user-facing payment error string (task
 * #514). Returns the generic fallback whenever the candidate string
 * looks like it leaked through from a provider/SDK payload rather
 * than being a hand-authored sentence:
 *
 *   - empty / non-string / whitespace-only
 *   - starts with `{` or `[` (JSON object / array)
 *   - contains a newline (multi-line stack-trace fragment)
 *   - longer than 200 chars (likely raw provider detail)
 */
export function sanitizePaymentUserMessage(msg: unknown): string {
  if (typeof msg !== 'string') return GENERIC_PAYMENT_USER_MESSAGE;
  const trimmed = msg.trim();
  if (!trimmed) return GENERIC_PAYMENT_USER_MESSAGE;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return GENERIC_PAYMENT_USER_MESSAGE;
  if (trimmed.includes('\n') || trimmed.includes('\r')) return GENERIC_PAYMENT_USER_MESSAGE;
  if (trimmed.length > 200) return GENERIC_PAYMENT_USER_MESSAGE;
  return trimmed;
}
