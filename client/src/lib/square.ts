import { logger } from "@/lib/logger";
import { csrfFetch } from '@/lib/queryClient';
import { makeApiError, type ApiErrorLike } from "@/lib/provider-not-configured";

const SDK_NETWORK_MAX_ATTEMPTS = 2;
const SDK_NETWORK_RETRY_DELAY_MS = 500;
const PAYMENTS_INIT_MAX_ATTEMPTS = 3;
const PAYMENTS_INIT_RETRY_DELAY_MS = 750;
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

type LocationKey = number | null;

class SquareConfigUnavailableError extends Error {}

const paymentsByLocation = new Map<LocationKey, SquarePayments>();
const configByLocation = new Map<LocationKey, { appId: string; locationId: string }>();
const initializationByLocation = new Map<LocationKey, Promise<SquarePayments>>();
let preWarmedCard: SquareCard | null = null;
let sdkLoadPromise: Promise<NonNullable<typeof window.Square>> | null = null;
let sdkLoadUrl: string | null = null;

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

/** Test-only state reset. Production components must never tear down shared SDK state. */
export function resetSquarePaymentsForTests() {
  paymentsByLocation.clear();
  configByLocation.clear();
  initializationByLocation.clear();
  sdkLoadPromise = null;
  sdkLoadUrl = null;
}

/**
 * Drop only one location's credential-bound objects. The page-stable SDK
 * remains owned by the loader; changing between sandbox and production is the
 * sole case that requires a browser reload because both SDKs share a global.
 */
export function refreshSquarePaymentConfiguration(
  locationId: number,
  previousAppId: string | null,
  nextAppId: string | null,
): { reloadRequired: boolean } {
  paymentsByLocation.delete(locationId);
  configByLocation.delete(locationId);
  initializationByLocation.delete(locationId);
  const reloadRequired = Boolean(
    previousAppId && nextAppId && getSdkUrl(previousAppId) !== getSdkUrl(nextAppId),
  );
  return { reloadRequired };
}

async function getSquareConfig(locationId: LocationKey): Promise<{ appId: string; locationId: string }> {
  const cached = configByLocation.get(locationId);
  if (cached) return cached;

  const url = locationId ? `/api/payments-provider/config?locationId=${locationId}` : '/api/payments-provider/config';
  let data: SquareConfigResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Square config request failed with status ${res.status}`);
    data = await res.json() as SquareConfigResponse;
  } catch (err) {
    throw new SquareConfigUnavailableError(
      err instanceof Error ? err.message : 'Square config request failed',
    );
  }

  if (!data.appId) {
    logger.error('Square', 'Server returned no appId in config response');
    throw new Error('Payment is temporarily unavailable. Please try again or contact support.');
  }

  const config = { appId: data.appId, locationId: data.locationId || '' };
  configByLocation.set(locationId, config);
  return config;
}

function getSdkUrl(appId: string): string {
  const isProduction = appId.length > 0 && !appId.includes('sandbox-');
  return isProduction
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SquareInitializationTimeoutError extends Error {}

/** Race one provider attempt without leaving an already-fired timer behind. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new SquareInitializationTimeoutError(
          `Square initialization timed out after ${timeoutMs / 1000} seconds`,
        )),
        timeoutMs,
      );
      promise.then(resolve, reject);
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function scriptUrl(script: HTMLScriptElement): string {
  return new URL(script.src, window.location.href).href;
}

function loadSquareScript(sdkUrl: string, timeoutMs: number): Promise<NonNullable<typeof window.Square>> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sdkUrl;
    script.type = 'text/javascript';
    script.async = true;
    script.dataset.squareSdk = 'true';

    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timeout = undefined;
      reject(new Error(`Square SDK load timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    const finish = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    };

    script.onload = () => {
      finish();
      const sdk = window.Square;
      if (!sdk?.payments) {
        // Evaluation completed, so reinjecting the same SDK can execute two
        // copies against shared browser globals. Recovery is a page reload.
        reject(new Error('Square SDK loaded without exposing its payments API'));
        return;
      }
      resolve(sdk);
    };
    script.onerror = () => {
      finish();
      script.remove();
      reject(new Error(`Failed to load Square SDK from ${sdkUrl}`));
    };
    document.head.appendChild(script);
  });
}

async function loadSquareSdk(sdkUrl: string, timeoutMs: number): Promise<NonNullable<typeof window.Square>> {
  const requestedUrl = new URL(sdkUrl, window.location.href).href;
  const existingScript = document.querySelector('script[src*="square.js"]') as HTMLScriptElement | null;
  if (existingScript && scriptUrl(existingScript) !== requestedUrl) {
    throw new Error('Square SDK environment changed; reload the page before taking payment');
  }
  if (sdkLoadUrl && sdkLoadUrl !== requestedUrl) {
    throw new Error('Square SDK environment changed; reload the page before taking payment');
  }
  if (window.Square?.payments) {
    sdkLoadUrl = requestedUrl;
    return window.Square;
  }
  if (sdkLoadPromise) return sdkLoadPromise;
  if (existingScript) {
    throw new Error('Square SDK script is present but unavailable; reload the page before taking payment');
  }

  sdkLoadUrl = requestedUrl;
  sdkLoadPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SDK_NETWORK_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await loadSquareScript(requestedUrl, timeoutMs);
      } catch (error) {
        lastError = error;
        // Only an explicit network load failure removes its own failed tag.
        // A timeout or evaluated-but-invalid SDK remains terminal for this page.
        const failedTag = document.querySelector('script[data-square-sdk="true"]');
        if (failedTag || attempt === SDK_NETWORK_MAX_ATTEMPTS) break;
        await wait(SDK_NETWORK_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Failed to load Square SDK');
  })();
  return sdkLoadPromise;
}

async function initializeSquareInternal(locationId: LocationKey): Promise<SquarePayments> {
  const config = await getSquareConfig(locationId);
  const sdkUrl = getSdkUrl(config.appId);
  const isProduction = config.appId.length > 0 && !config.appId.includes('sandbox-');
  const timeoutMs = isProduction ? SQUARE_INIT_TIMEOUT_PROD_MS : SQUARE_INIT_TIMEOUT_DEV_MS;
  const sdk = await loadSquareSdk(sdkUrl, timeoutMs);
  const paymentsFactory = sdk.payments;
  if (!paymentsFactory) throw new Error('Square SDK payments API became unavailable');

  let lastError: unknown;
  for (let attempt = 1; attempt <= PAYMENTS_INIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withTimeout(paymentsFactory(config.appId, config.locationId), timeoutMs);
    } catch (error) {
      lastError = error;
      // A timed-out factory may still be executing inside the opaque SDK.
      // Starting another would overlap it, so only settled rejections retry.
      if (error instanceof SquareInitializationTimeoutError || attempt === PAYMENTS_INIT_MAX_ATTEMPTS) break;
      await wait(PAYMENTS_INIT_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Square payments initialization failed');
}

export async function initializeSquare(locationId?: number | null): Promise<SquarePayments> {
  const normalizedLocationId = locationId ?? null;
  const cached = paymentsByLocation.get(normalizedLocationId);
  if (cached) return cached;
  const pending = initializationByLocation.get(normalizedLocationId);
  if (pending) return pending;

  let promise: Promise<SquarePayments>;
  promise = initializeSquareInternal(normalizedLocationId)
    .then((result) => {
      paymentsByLocation.set(normalizedLocationId, result);
      return result;
    })
    .catch((error: unknown) => {
      // Configuration transport failures happen before any opaque SDK work.
      // Releasing this entry lets a later explicit mount retry safely.
      if (
        error instanceof SquareConfigUnavailableError &&
        initializationByLocation.get(normalizedLocationId) === promise
      ) {
        initializationByLocation.delete(normalizedLocationId);
      }
      logger.error('Square', 'Square initialization failed', error);
      throw new Error(SQUARE_INITIALIZATION_FALLBACK_MESSAGE);
    });
  // Keep pending and terminally rejected promises stable for the lifetime of
  // the page. The internal handshake owns bounded settled-error retries, while
  // a timeout never starts an overlapping opaque SDK operation.
  initializationByLocation.set(normalizedLocationId, promise);
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
