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
  type RecoveryOperation = {
    contractVersion?: string;
    operationId?: string;
    status?: string;
  };
  const readRecoveryOperation = async (response: Response): Promise<RecoveryOperation> => {
    const body = await response.clone().json().catch(() => null) as {
      data?: RecoveryOperation;
      error?: { details?: RecoveryOperation };
      operationId?: string;
      status?: string;
    } | null;
    // The exact roster route returns `{ data: ... }`, while the retained
    // request-key recovery route returns a top-level operation status. Both
    // identify the same durable operation when operationId is present.
    return body?.data ?? body?.error?.details ?? body ?? {};
  };
  const reconcileRosterResponse = async (response: Response): Promise<Response> => {
    if (rosterLeagueId === undefined) return response;
    const operation = await readRecoveryOperation(response);
    if (!operation?.operationId) return response;
    // The retained generic route represents a terminal provider success as
    // `{ status: 'COMPLETED', id, operationId }`. Hand that durable identity
    // to the roster finalizer too; the operation-id path is idempotent and
    // closes the gap where generic ledger success preceded local allocation.
    const exactResponse = operation.contractVersion === 'interactive-obligation-charge/2';
    if (exactResponse && operation.status === 'succeeded') return response;
    const recovered = await recoverRosterPaymentOperation(rosterLeagueId, operation.operationId).catch(() => null);
    // A roster recovery may deliberately return 409/202 while preserving the
    // durable operation identity and reconciliation status. Keep that exact
    // response so callers never mistake a generic provider response for a
    // confirmed local allocation; only the exact terminal `succeeded` status
    // is accepted by checkout callers.
    return recovered ?? response;
  };
  try {
    const initial = await request();
    if (rosterLeagueId !== undefined && !initial.ok) {
      // A provider-success/local-finalization failure is commonly surfaced
      // as 409/202 after dispatch. Re-read the durable request-key operation
      // before exposing that non-terminal response to the caller. If the
      // retained recovery route has no operation identity, it cannot prove
      // that the request belongs to this roster checkout; preserve the
      // original exact response (including STALE_QUOTE/INVALID_REQUEST).
      const recovered = await recoverPaymentIntent(requestKey, organizationId).catch(() => null);
      if (recovered) {
        const operation = await readRecoveryOperation(recovered);
        if (operation.operationId) return await reconcileRosterResponse(recovered);
        return initial;
      }
    }
    return await reconcileRosterResponse(initial);
  } catch (error) {
    const recovered = await recoverPaymentIntent(requestKey, organizationId).catch(() => null);
    if (!recovered) throw error;
    return await reconcileRosterResponse(recovered);
  }
}
