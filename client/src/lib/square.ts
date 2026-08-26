import { loadScript } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { csrfFetch } from '@/lib/queryClient';
import { makeApiError, type ApiErrorLike } from "@/lib/provider-not-configured";

const SDK_LOAD_MAX_ATTEMPTS = 3;
const SDK_LOAD_RETRY_DELAY_MS = 1000;
const INIT_MAX_RETRIES = 2;
const INIT_RETRY_DELAY_MS = 2000;

interface SquareCustomer {
  id: string;
  name: string;
  email: string;
}

interface SquarePaymentRequestDetails {
  countryCode: string;
  currencyCode: string;
  total: { amount: string; label: string };
}

export interface SquarePaymentRequest {
  update(details: { total: { amount: string; label: string } }): void;
}

export interface SquareWalletPayment {
  attach(selectorOrElement: string | HTMLElement, options?: Record<string, unknown>): Promise<void>;
  tokenize(): Promise<TokenizeResult>;
  destroy(): void;
}

interface SquarePayments {
  card(options?: { style?: Record<string, Record<string, string>> }): Promise<SquareCard>;
  paymentRequest(details: SquarePaymentRequestDetails): SquarePaymentRequest;
  applePay(paymentRequest: SquarePaymentRequest): Promise<SquareWalletPayment>;
  googlePay(paymentRequest: SquarePaymentRequest): Promise<SquareWalletPayment>;
}

interface SquareCard {
  attach(selectorOrElement: string | HTMLElement): Promise<void>;
  tokenize(options?: Record<string, unknown>): Promise<TokenizeResult>;
  destroy(): void;
}

export interface TokenizeError {
  message: string;
  type?: string;
}

interface TokenizeResult {
  status: string;
  token?: string;
  errors?: TokenizeError[];
}

interface SquareConfigResponse {
  appId: string;
  locationId?: string;
}

declare global {
  interface Window {
    Square?: {
      payments?: (appId: string, locationId: string) => Promise<SquarePayments>;
    };
  }
}

let payments: SquarePayments | null = null;
let squareConfig: { appId: string; locationId: string } | null = null;
let squareConfigLocationId: number | null | undefined = undefined;
let preWarmedCard: SquareCard | null = null;

const cardStyle = {
  input: {
    backgroundColor: '#FFFFFF',
    fontSize: '14px',
    color: '#333333',
  },
  'input.is-focus': {
    backgroundColor: '#FAFAFA',
  },
  '.input-container': {
    borderColor: '#DDDDDD',
  },
  '.input-container.is-focus': {
    borderColor: '#888888',
  },
  '.input-container.is-error': {
    borderColor: '#CC0023',
  },
};

export function getPreWarmedCard(): SquareCard | null {
  const card = preWarmedCard;
  preWarmedCard = null;
  return card;
}

export { cardStyle };

export function resetSquarePayments() {
  payments = null;
  squareConfig = null;
  squareConfigLocationId = undefined;
}

async function getSquareConfig(locationId?: number | null): Promise<{ appId: string; locationId: string }> {
  // Return cached config only if the location matches
  if (squareConfig && squareConfigLocationId === (locationId ?? null)) return squareConfig;

  const url = locationId ? `/api/payments-provider/config?locationId=${locationId}` : '/api/payments-provider/config';
  let data: SquareConfigResponse;
  try {
    const res = await fetch(url);
    data = await res.json() as SquareConfigResponse;
  } catch (err) {
    logger.error('Square', 'Failed to fetch config from server', err);
    throw new Error('Payment is temporarily unavailable. Please try again or contact support.');
  }

  if (!data.appId) {
    logger.error('Square', 'Server returned no appId in config response');
    throw new Error('Payment is temporarily unavailable. Please try again or contact support.');
  }

  squareConfig = { appId: data.appId, locationId: data.locationId || '' };
  squareConfigLocationId = locationId ?? null;
  return squareConfig;
}

function getSdkUrl(appId: string): string {
  const isProduction = appId.length > 0 && !appId.includes('sandbox-');
  return isProduction
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";
}

export async function initializeSquare(locationId?: number | null): Promise<SquarePayments> {
  try {
    // Reset if the location has changed
    if (payments && squareConfigLocationId !== (locationId ?? null)) {
      payments = null;
      squareConfig = null;
    }

    if (payments && window.Square?.payments) {
      return payments;
    }

    payments = null;

    const config = await getSquareConfig(locationId);
    const sdkUrl = getSdkUrl(config.appId);
    const isProduction = config.appId.length > 0 && !config.appId.includes('sandbox-');


    if (window.Square && !window.Square.payments) {
      document.querySelectorAll('script[src*="square.js"]').forEach(script => script.remove());
      (window as { Square?: typeof window.Square }).Square = undefined;
    }

    const existingSdkScript = document.querySelector('script[src*="square"]') as HTMLScriptElement | null;
    if (existingSdkScript && existingSdkScript.src !== sdkUrl) {
      existingSdkScript.remove();
      (window as { Square?: typeof window.Square }).Square = undefined;
    }

    if (window.Square?.payments) {
      try {
        payments = await window.Square.payments(config.appId, config.locationId);
        return payments;
      } catch (initError) {
        logger.error('Square', 'Failed to initialize with existing SDK, will reload', initError);
        document.querySelectorAll('script[src*="square.js"]').forEach(script => script.remove());
        (window as { Square?: typeof window.Square }).Square = undefined;
      }
    }

    const SQUARE_INIT_TIMEOUT_PROD_MS = 15000;
    const SQUARE_INIT_TIMEOUT_DEV_MS = 10000;
    const timeoutMs = isProduction ? SQUARE_INIT_TIMEOUT_PROD_MS : SQUARE_INIT_TIMEOUT_DEV_MS;
    const timeoutPromise = new Promise<SquarePayments>((_, reject) => {
      setTimeout(() => reject(new Error(`Square initialization timed out after ${timeoutMs/1000} seconds`)), timeoutMs);
    });

    const initializeFunction = async () => {
      let scriptLoaded = false;
      let attempts = 0;
      let lastError;

      while (!scriptLoaded && attempts < SDK_LOAD_MAX_ATTEMPTS) {
        attempts++;
        try {
          await loadScript(sdkUrl);
          scriptLoaded = true;
        } catch (err) {
          lastError = err;
          logger.error('Square', `Failed to load SDK on attempt ${attempts}/${SDK_LOAD_MAX_ATTEMPTS}`, err);
          if (attempts < SDK_LOAD_MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, SDK_LOAD_RETRY_DELAY_MS));
          }
        }
      }

      if (!scriptLoaded) {
        throw lastError || new Error("Failed to load Square SDK after multiple attempts");
      }

      if (!window.Square?.payments) {
        throw new Error("Square SDK failed to initialize properly");
      }

      try {
        payments = await window.Square.payments(config.appId, config.locationId);
        return payments;
      } catch (initError) {
        logger.error('Square', 'Failed to initialize payments with credentials', initError);
        const errorMessage = initError instanceof Error ? initError.message : String(initError);
        if (errorMessage.includes('location_id') || errorMessage.includes('invalid location')) {
          throw new Error(`Square location ID issue: ${errorMessage}`);
        } else if (errorMessage.includes('application_id') || errorMessage.includes('app_id')) {
          throw new Error(`Square application ID issue: ${errorMessage}`);
        } else if (errorMessage.includes('unauthorized') || errorMessage.includes('not authorized')) {
          throw new Error(`Square authorization issue: ${errorMessage}`);
        }
        throw initError;
      }
    };

    let attemptCount = 0;

    while (attemptCount <= INIT_MAX_RETRIES) {
      try {
        const result = await Promise.race([
          initializeFunction(),
          timeoutPromise
        ]);
        return result;
      } catch (error) {
        attemptCount++;
        if (attemptCount <= INIT_MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, INIT_RETRY_DELAY_MS));
        } else {
          logger.error('Square', 'All initialization attempts failed');
          throw error;
        }
      }
    }

    throw new Error("Square initialization failed after multiple attempts");
  } catch (error) {
    logger.error('Square', 'Critical error during Square initialization', error);
    payments = null;
    throw error;
  }
}

// task #514: tokenizeCard now throws plain Errors with `.code`
// attached. The previous JSON-stringified message round-trip leaked
// `{"error":{"message":...}}` into the user-visible toast whenever
// the consumer's parse-back step missed.
function makePaymentError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export async function tokenizeCard(
  // task #546: accept the absent-card states honestly so the
  // defensive `if (!cardInstance)` guard isn't dead code per the
  // type system. Callers that already hold a non-null card see no
  // behavior change; tests can pass `null` without a double-cast.
  cardInstance: SquareCard | null | undefined,
): Promise<string> {
  if (!cardInstance) {
    throw makePaymentError('Card element not initialized', 'INITIALIZATION_ERROR');
  }
  // task #546: wrap the SDK call so any thrown SDK error (network
  // glitch, init race, raw `Square API Error: ...` strings) gets
  // collapsed into the same friendly `TOKENIZATION_ERROR` shape as
  // the `status !== 'OK'` path. Without this guard, raw SDK jargon
  // could land in a user-facing toast.
  let result;
  try {
    result = await cardInstance.tokenize();
  } catch {
    throw makePaymentError('Please check your card details and try again.', 'TOKENIZATION_ERROR');
  }
  if (result.status === 'OK' && result.token) {
    return result.token;
  }
  throw makePaymentError('Please check your card details and try again.', 'TOKENIZATION_ERROR');
}

export async function createSquareCustomer(name: string, email: string, teamId: number): Promise<SquareCustomer> {
  try {
    const response = await csrfFetch('/api/payments-provider/customers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, email, teamId }),
    });

    if (!response.ok) {
      // Parse JSON defensively, falling back to the raw
      // text body for non-JSON responses (so we surface upstream
      // proxy/HTML error pages cleanly), and always attach a
      // `CUSTOMER_CREATION_FAILED` fallback `.code` when the body
      // didn't carry a structured one. The raw text body is the
      // user-visible message — no "Failed to create Square customer:"
      // prefix is added.
      let errorBody: unknown = null;
      let responseTextFallback: string | null = null;
      try {
        errorBody = await response.clone().json();
      } catch {
        errorBody = null;
        try {
          responseTextFallback = await response.text();
        } catch {
          responseTextFallback = null;
        }
      }
      const fallbackMessage =
        (responseTextFallback ?? '').trim() || 'Customer creation failed';
      const err = makeApiError(errorBody, response.status, fallbackMessage);
      if (!err.code) err.code = 'CUSTOMER_CREATION_FAILED';
      throw err;
    }

    const customer = await response.json();
    return customer;
  } catch (error) {
    // task #545: re-throw any already-typed API error verbatim so its
    // `.code` (e.g. PROVIDER_NOT_CONFIGURED) and `.status` survive.
    // Unexpected failures are wrapped as `CUSTOMER_CREATION_FAILED`.
    if (error instanceof Error && (error as ApiErrorLike).code) {
      throw error;
    }
    if (error instanceof Error && error.message) {
      const wrapped = new Error(error.message) as ApiErrorLike;
      wrapped.code = 'CUSTOMER_CREATION_FAILED';
      throw wrapped;
    }
    const generic = new Error(
      'Unable to create customer. Please try again later.',
    ) as ApiErrorLike;
    generic.code = 'CUSTOMER_CREATION_FAILED';
    throw generic;
  }
}

export function getSquareCustomerUrl(customerId: string): string {
  return `https://app.squareup.com/dashboard/customers/directory/customer/${customerId}`;
}
