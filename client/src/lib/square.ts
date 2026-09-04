import { loadScript } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { csrfFetch } from '@/lib/queryClient';
import { makeApiError, type ApiErrorLike } from "@/lib/provider-not-configured";

const SDK_LOAD_MAX_ATTEMPTS = 3;
const SDK_LOAD_RETRY_DELAY_MS = 1000;
const INIT_MAX_RETRIES = 2;
const INIT_RETRY_DELAY_MS = 2000;
const SQUARE_INIT_TIMEOUT_PROD_MS = 15000;
const SQUARE_INIT_TIMEOUT_DEV_MS = 10000;
export const SQUARE_INITIALIZATION_FALLBACK_MESSAGE =
  'Credit card payment form unavailable. Please try again or choose a different payment method.';

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
let initializationPromise: Promise<SquarePayments> | null = null;
let initializationLocationId: number | null | undefined = undefined;
let initializationGeneration = 0;

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
  initializationGeneration += 1;
  initializationPromise = null;
  initializationLocationId = undefined;
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

function removeSquareSdk(): void {
  document.querySelectorAll('script[src*="square.js"]').forEach((script) => script.remove());
  (window as { Square?: typeof window.Square }).Square = undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race one provider attempt without leaving an already-fired timer behind. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Square initialization timed out after ${timeoutMs / 1000} seconds`)),
        timeoutMs,
      );
      promise.then(resolve, reject);
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isCurrentInitialization(generation: number): boolean {
  return generation === initializationGeneration;
}

async function initializeSquareAttempt(
  config: { appId: string; locationId: string },
  sdkUrl: string,
  timeoutMs: number,
  generation: number,
  allowExistingSdk: boolean,
): Promise<SquarePayments> {
  if (!isCurrentInitialization(generation)) throw new Error('Square initialization was superseded');

  if (allowExistingSdk && window.Square?.payments) {
    try {
      return await withTimeout(
        window.Square.payments(config.appId, config.locationId),
        timeoutMs,
      );
    } catch {
      // A rejected or hung SDK instance is not reusable. Remove both its
      // script tag and global before the next bounded attempt.
      removeSquareSdk();
    }
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= SDK_LOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      await withTimeout(loadScript(sdkUrl), timeoutMs);
      if (!window.Square?.payments) throw new Error('Square SDK failed to initialize properly');
      return await withTimeout(
        window.Square.payments(config.appId, config.locationId),
        timeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (attempt < SDK_LOAD_MAX_ATTEMPTS) {
        removeSquareSdk();
        await wait(SDK_LOAD_RETRY_DELAY_MS);
        if (!isCurrentInitialization(generation)) {
          throw new Error('Square initialization was superseded');
        }
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to load Square SDK after multiple attempts');
}

async function initializeSquareInternal(
  locationId: number | null,
  generation: number,
): Promise<SquarePayments> {
  const config = await getSquareConfig(locationId);
  const sdkUrl = getSdkUrl(config.appId);
  const isProduction = config.appId.length > 0 && !config.appId.includes('sandbox-');
  const timeoutMs = isProduction ? SQUARE_INIT_TIMEOUT_PROD_MS : SQUARE_INIT_TIMEOUT_DEV_MS;
  const existingSdkScript = document.querySelector('script[src*="square.js"]') as HTMLScriptElement | null;
  if (existingSdkScript && existingSdkScript.src !== sdkUrl) removeSquareSdk();
  let lastError: unknown;

  for (let attempt = 0; attempt <= INIT_MAX_RETRIES; attempt += 1) {
    if (!isCurrentInitialization(generation)) throw new Error('Square initialization was superseded');
    if (attempt > 0) {
      // Reinitialize the provider from a clean SDK state after a timeout or
      // rejected credential handshake. This is the missing step that made
      // the old retry loop race the same broken global instance.
      removeSquareSdk();
      await wait(INIT_RETRY_DELAY_MS * attempt);
      if (!isCurrentInitialization(generation)) {
        throw new Error('Square initialization was superseded');
      }
    }
    try {
      const result = await initializeSquareAttempt(
        config,
        sdkUrl,
        timeoutMs,
        generation,
        attempt === 0,
      );
      if (!isCurrentInitialization(generation)) throw new Error('Square initialization was superseded');
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Square initialization failed after multiple attempts');
}

export async function initializeSquare(locationId?: number | null): Promise<SquarePayments> {
  const normalizedLocationId = locationId ?? null;

  if (payments && squareConfigLocationId === normalizedLocationId && window.Square?.payments) {
    return payments;
  }
  if (initializationPromise && initializationLocationId === normalizedLocationId) {
    return initializationPromise;
  }

  // A location switch invalidates a prior in-flight initialization as well
  // as the successful instance cache. The generation check prevents the old
  // promise from writing its result after this call starts.
  if (initializationPromise) {
    initializationGeneration += 1;
    initializationPromise = null;
    initializationLocationId = undefined;
    payments = null;
    squareConfig = null;
  }

  const generation = initializationGeneration;
  const promise = initializeSquareInternal(normalizedLocationId, generation)
    .then((result) => {
      if (!isCurrentInitialization(generation)) throw new Error('Square initialization was superseded');
      payments = result;
      return result;
    })
    .catch((error: unknown) => {
      payments = null;
      if (isCurrentInitialization(generation)) {
        // Provider/transport failures are reportable, but callers get a
        // stable UI message rather than a raw timeout or SDK payload.
        logger.error('Square', 'Square initialization failed after bounded retries', error);
      }
      throw new Error(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    });
  initializationPromise = promise;
  initializationLocationId = normalizedLocationId;
  promise.then(
    () => {
      if (initializationPromise === promise) {
        initializationPromise = null;
        initializationLocationId = undefined;
      }
    },
    () => {
      if (initializationPromise === promise) {
        initializationPromise = null;
        initializationLocationId = undefined;
      }
    },
  );
  return promise;
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
