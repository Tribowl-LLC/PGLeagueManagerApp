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

/**
 * Remove every browser intent carrying a request key. This is used only for
 * terminal provider outcomes (failed_terminal/canceled); an unresolved
 * provider outcome must keep its original idempotency key so a retry cannot
 * accidentally create a second charge.
 */
export function clearPaymentIntentForRequestKey(requestKey: string): void {
  if (typeof window === 'undefined') return;
  const browserStorage = window.localStorage;
  const matchingKeys: string[] = [];
  for (let index = 0; index < browserStorage.length; index += 1) {
    const key = browserStorage.key(index);
    if (key?.startsWith(STORAGE_PREFIX) && browserStorage.getItem(key) === requestKey) {
      matchingKeys.push(key);
    }
  }
  for (const key of matchingKeys) browserStorage.removeItem(key);
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

/** Terminal roster outcomes that are safe to retry with a new source/key. */
export function isTerminalRosterPaymentFailure(status: unknown): boolean {
  return status === 'failed_terminal' || status === 'canceled' || status === 'action_required';
}

/**
 * Return the user-facing meaning of an exact roster operation state. A
 * `null` result is the only successful state; all other states intentionally
 * remain explicit so callers do not turn pending/provider-unknown evidence
 * into a misleading generic failure.
 */
export function rosterPaymentStatusMessage(status: unknown): string | null {
  switch (status) {
    case 'succeeded':
      return null;
    case 'reconciliation_required':
      return 'Your payment reached the provider but still needs reconciliation. Use payment recovery before trying again.';
    case 'pending':
    case 'provider_unknown':
    case 'retry_scheduled':
      return 'Your payment is still being confirmed. Use payment recovery before trying another card.';
    case 'action_required':
    case 'failed_terminal':
    case 'canceled':
      return 'Your payment was not completed. Try another payment method.';
    default:
      return 'Your payment is not confirmed yet. Use payment recovery before trying again.';
  }
}

export function assertRosterPaymentSucceeded(status: unknown): void {
  const message = rosterPaymentStatusMessage(status);
  if (message) throw new Error(message);
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
  type ResponseDecision = 'success' | 'recover' | 'preserve' | 'terminal_failure' | 'unknown';
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
  const classifyRosterResponse = (operation: RecoveryOperation): ResponseDecision => {
    const status = operation.status?.toLowerCase();
    if (operation.contractVersion === 'interactive-obligation-charge/2') {
      if (status === 'succeeded') return 'success';
      if (status === 'reconciliation_required') return 'recover';
      if (isTerminalRosterPaymentFailure(status)) return 'terminal_failure';
      // The charge contract intentionally returns pending/provider_unknown/
      // and retry_scheduled as-is. They are not safe to replay. An
      // action_required result is terminal in this ledger (there is no
      // challenge/resume contract), so it is handled above.
      return 'preserve';
    }
    // An operation-id recovery response has already passed through the exact
    // recovery endpoint. Do not call that endpoint recursively when it still
    // reports reconciliation_required.
    if (operation.contractVersion === 'interactive-obligation-recovery/1') {
      if (status === 'succeeded') return 'success';
      if (isTerminalRosterPaymentFailure(status)) return 'terminal_failure';
      return 'preserve';
    }
    if (status === 'completed' || status === 'succeeded') return 'recover';
    if (status === 'reconciliation_required') return 'recover';
    if (isTerminalRosterPaymentFailure(status)) return 'terminal_failure';
    return operation.operationId ? 'preserve' : 'unknown';
  };
  const reconcileRosterResponse = async (response: Response): Promise<Response> => {
    if (rosterLeagueId === undefined) return response;
    const operation = await readRecoveryOperation(response);
    const decision = classifyRosterResponse(operation);
    if (decision === 'terminal_failure') {
      clearPaymentIntentForRequestKey(requestKey);
      return response;
    }
    if (decision !== 'recover' || !operation.operationId) return response;
    // Generic terminal provider success and exact reconciliation_required
    // responses are handed to the operation-id finalizer. Pending,
    // provider_unknown, retry_scheduled, and an already completed exact
    // recovery response are returned unchanged. action_required is terminal
    // and has already had its browser intent cleared above.
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
      const initialOperation = await readRecoveryOperation(initial);
      const initialDecision = classifyRosterResponse(initialOperation);
      // Exact roster responses already carry the authoritative operation
      // state. Do not replace a pending/unknown/action-required/terminal
      // response with a generic request-key 404.
      if (initialDecision !== 'unknown') return await reconcileRosterResponse(initial);
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
