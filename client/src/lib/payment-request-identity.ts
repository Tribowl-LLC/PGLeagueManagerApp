import { csrfFetch } from '@/lib/queryClient';

export const PAYMENT_IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const PAYMENT_REQUEST_KEY_MIN_LENGTH = 16;
export const PAYMENT_REQUEST_KEY_MAX_LENGTH = 109;

const STORAGE_PREFIX = 'leaguevault:payment-intent:v1:';

export function isValidPaymentRequestKey(value: string): boolean {
  return value.length >= PAYMENT_REQUEST_KEY_MIN_LENGTH
    && value.length <= PAYMENT_REQUEST_KEY_MAX_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('Secure payment request identity generation is unavailable');
}

/**
 * Gets the retry identity for one exact checkout intent, creating and
 * persisting it before any card or wallet tokenization occurs. The scope is
 * made from server-authoritative checkout semantics; provider source tokens
 * are intentionally never part of it or stored in browser storage.
 */
export function beginPaymentIntent(scope: string): string {
  if (!scope || scope.includes('\u0000')) {
    throw new Error('Payment intent scope is invalid');
  }
  const browserStorage = typeof window === 'undefined' ? null : window.localStorage;
  if (!browserStorage) return generateUuid();
  const key = storageKey(scope);
  const existing = browserStorage.getItem(key);
  if (existing && isValidPaymentRequestKey(existing)) return existing;
  const requestKey = generateUuid();
  browserStorage.setItem(key, requestKey);
  return requestKey;
}

export function clearPaymentIntent(scope: string): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(scope));
}

export function paymentRequestHeaders(requestKey: string): Record<string, string> {
  if (!isValidPaymentRequestKey(requestKey)) {
    throw new Error('Payment request identity is invalid');
  }
  return {
    'Content-Type': 'application/json',
    [PAYMENT_IDEMPOTENCY_KEY_HEADER]: requestKey,
  };
}

export async function recoverPaymentIntent(requestKey: string, organizationId?: number | null): Promise<Response> {
  return csrfFetch('/api/payments-provider/payment-operations/recover', {
    method: 'POST',
    headers: paymentRequestHeaders(requestKey),
    body: JSON.stringify(organizationId ? { organizationId } : {}),
  });
}

/** Reconcile an exact roster operation by its durable operation identity. */
export async function recoverRosterPaymentOperation(leagueId: number, operationId: string): Promise<Response> {
  return csrfFetch(`/api/financials/leagues/${leagueId}/interactive-obligation-charge/2/operations/${encodeURIComponent(operationId)}/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * Reconcile a durable payment operation when the request carrying a provider
 * token is lost to a network failure. The request key is the only recovery
 * input; callers must not mint or tokenize a replacement payment here.
 */
export async function paymentRequestWithRecovery(
  requestKey: string,
  request: () => Promise<Response>,
  organizationId?: number | null,
  rosterLeagueId?: number,
): Promise<Response> {
  try {
    const response = await request();
    if (rosterLeagueId !== undefined) {
      const body = await response.clone().json().catch(() => null) as { data?: { contractVersion?: string; operationId?: string; status?: string } } | null;
      const operation = body?.data;
      if (operation?.contractVersion === 'interactive-obligation-charge/2'
        && operation.operationId
        && operation.status === 'reconciliation_required') {
        const recovered = await recoverRosterPaymentOperation(rosterLeagueId, operation.operationId).catch(() => null);
        if (recovered?.ok) return recovered;
      }
    }
    return response;
  } catch (error) {
    const recovered = await recoverPaymentIntent(requestKey, organizationId).catch(() => null);
    if (!recovered) throw error;
    return recovered;
  }
}
