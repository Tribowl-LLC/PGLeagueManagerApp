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

  constructor(reason: string, public readonly locationId: number | null) {
    super(reason);
    this.name = 'ProviderNotConfiguredError';
  }
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

  constructor(userMessage: string, code: string, detail?: string) {
    super(userMessage);
    this.name = 'PaymentProviderError';
    this.userMessage = userMessage;
    this.code = code;
    this.detail = detail;
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
