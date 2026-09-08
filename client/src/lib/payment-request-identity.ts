import { csrfFetch } from '@/lib/queryClient';

export const PAYMENT_IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const PAYMENT_REQUEST_KEY_MIN_LENGTH = 16;
export const PAYMENT_REQUEST_KEY_MAX_LENGTH = 109;

const STORAGE_PREFIX = 'leaguevault:payment-intent:v1:';

export interface InteractivePaymentIntentScope {
  actorUserId: number;
  organizationId: number;
  leagueId: number;
  bowlerId: number;
}

/**
 * Browser identity for one interactive checkout actor and payer.  Amount,
 * quote fingerprint, card mode, and provider source tokens deliberately do
 * not participate: those values may change while an unresolved operation is
 * being recovered after a reload.
 */
export function interactivePaymentIntentScope(input: InteractivePaymentIntentScope): string {
  return JSON.stringify({
    version: 2,
    kind: 'interactive-roster',
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
  });
}

export function isValidPaymentRequestKey(value: string): boolean {
  return value.length >= PAYMENT_REQUEST_KEY_MIN_LENGTH
    && value.length <= PAYMENT_REQUEST_KEY_MAX_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    throw new Error('Payment request identity storage is unavailable');
  }
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
  const storage = browserStorage();
  if (!storage) return generateUuid();
  const key = storageKey(scope);
  const existing = storage.getItem(key);
  if (existing) {
    if (isValidPaymentRequestKey(existing)) return existing;
    throw new Error('Stored payment request identity is invalid');
  }
  const requestKey = generateUuid();
  try {
    storage.setItem(key, requestKey);
  } catch {
    throw new Error('Payment request identity could not be persisted');
  }
  return requestKey;
}

/** Return an exact stored identity without minting one for a read-only probe. */
export function getPaymentIntent(scope: string): string | null {
  if (!scope || scope.includes('\u0000')) throw new Error('Payment intent scope is invalid');
  const storage = browserStorage();
  if (!storage) return null;
  const existing = storage.getItem(storageKey(scope));
  if (!existing) return null;
  if (!isValidPaymentRequestKey(existing)) throw new Error('Stored payment request identity is invalid');
  return existing;
}

export function clearPaymentIntent(scope: string): void {
  try {
    const storage = browserStorage();
    storage?.removeItem(storageKey(scope));
  } catch {
    // A failed cleanup is safe: the next recovery probe will still find the
    // acknowledged/terminal operation and will never submit a second charge.
  }
}

/**
 * Remove every browser intent carrying a request key. This is used only after
 * an active caller has acknowledged a succeeded or terminal provider outcome;
 * a cancelled recovery probe must leave the key available for the next probe.
 */
export function clearPaymentIntentForRequestKey(requestKey: string): void {
  try {
    const storage = browserStorage();
    if (!storage) return;
    const matchingKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) && storage.getItem(key) === requestKey) {
        matchingKeys.push(key);
      }
    }
    for (const key of matchingKeys) {
      try { storage.removeItem(key); } catch { /* see clearPaymentIntent */ }
    }
  } catch {
    // A failed cleanup is safe: the next recovery probe remains authoritative.
  }
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

/** Reconcile an exact roster operation by its durable operation identity. */
export async function recoverRosterPaymentOperation(leagueId: number, operationId: string): Promise<Response> {
  return csrfFetch(`/api/financials/leagues/${leagueId}/interactive-obligation-charge/2/operations/${encodeURIComponent(operationId)}/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Recover a canonical interactive operation by its exact request identity
 * after the charge response was lost before the operation ID reached the
 * browser. The server scopes this lookup to the current tenant, league, and
 * authorizing user and never receives or replays a provider source token. */
export async function recoverRosterPaymentOperationByRequestKey(leagueId: number, requestKey: string): Promise<Response> {
  return csrfFetch(`/api/financials/leagues/${leagueId}/interactive-obligation-charge/2/recover-by-request-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestKey }),
  });
}

type RecoveryOperation = {
  contractVersion?: string;
  operationId?: string;
  status?: string;
};

type ResponseDecision = 'success' | 'recover' | 'preserve' | 'terminal_failure' | 'unknown';

async function readRecoveryOperation(response: Response): Promise<RecoveryOperation> {
  const body = await response.clone().json().catch(() => null) as {
    data?: RecoveryOperation;
    error?: { details?: RecoveryOperation };
    operationId?: string;
    status?: string;
  } | null;
  return body?.data ?? body?.error?.details ?? body ?? {};
}

function classifyRosterResponse(operation: RecoveryOperation): ResponseDecision {
  const status = operation.status?.toLowerCase();
  if (operation.contractVersion === 'interactive-obligation-charge/2') {
    if (status === 'succeeded') return 'success';
    if (status === 'reconciliation_required') return 'recover';
    if (isTerminalRosterPaymentFailure(status)) return 'terminal_failure';
    return 'preserve';
  }
  if (operation.contractVersion === 'interactive-obligation-recovery/1') {
    if (status === 'succeeded') return 'success';
    if (isTerminalRosterPaymentFailure(status)) return 'terminal_failure';
    return 'preserve';
  }
  if (status === 'completed' || status === 'succeeded') return 'recover';
  if (status === 'reconciliation_required') return 'recover';
  if (isTerminalRosterPaymentFailure(status)) return 'terminal_failure';
  return operation.operationId ? 'preserve' : 'unknown';
}

async function reconcileRosterResponse(
  response: Response,
  rosterLeagueId?: number,
): Promise<{ response: Response; operation: RecoveryOperation; decision: ResponseDecision }> {
  const operation = await readRecoveryOperation(response);
  const decision = classifyRosterResponse(operation);
  if (rosterLeagueId === undefined || decision !== 'recover' || !operation.operationId) {
    return { response, operation, decision };
  }
  const recovered = await recoverRosterPaymentOperation(rosterLeagueId, operation.operationId).catch(() => null);
  const finalResponse = recovered ?? response;
  const finalOperation = recovered ? await readRecoveryOperation(recovered) : operation;
  const finalDecision = recovered ? classifyRosterResponse(finalOperation) : decision;
  return { response: finalResponse, operation: finalOperation, decision: finalDecision };
}

export type PreparedRosterPaymentIntent = {
  requestKey: string;
  outcome: 'none' | 'new' | 'succeeded' | 'unresolved' | 'terminal_failure';
  response?: Response;
  status?: string;
};

/**
 * Probe an existing browser intent before obtaining a quote or tokenizing a
 * source. A 404 is the only indication that a newly persisted key may submit;
 * every other response remains authoritative and prevents a replacement.
 */
export async function prepareRosterPaymentIntent(
  scope: string,
  leagueId: number,
  options: { createIfMissing?: boolean } = {},
): Promise<PreparedRosterPaymentIntent> {
  const stored = getPaymentIntent(scope);
  if (!stored && options.createIfMissing === false) return { requestKey: '', outcome: 'none' };
  const requestKey = stored ?? beginPaymentIntent(scope);
  const existing = await recoverRosterPaymentOperationByRequestKey(leagueId, requestKey);
  if (existing.status === 404) return { requestKey, outcome: 'new' };

  const reconciled = await reconcileRosterResponse(existing, leagueId);
  const status = reconciled.operation.status;
  if (reconciled.decision === 'success') {
    return { requestKey, outcome: 'succeeded', response: reconciled.response, status };
  }
  if (reconciled.decision === 'terminal_failure') {
    return { requestKey, outcome: 'terminal_failure', response: reconciled.response, status };
  }
  return { requestKey, outcome: 'unresolved', response: reconciled.response, status };
}

/**
 * Reconcile a durable payment operation when the request carrying a provider
 * token is lost to a network failure. The request key is the only recovery
 * input; callers must not mint or tokenize a replacement payment here.
 */
export async function paymentRequestWithRecovery(
  requestKey: string,
  request: () => Promise<Response>,
  rosterLeagueId?: number,
): Promise<Response> {
  const reconcile = async (response: Response): Promise<Response> => {
    const reconciled = await reconcileRosterResponse(response, rosterLeagueId);
    if (reconciled.decision === 'terminal_failure') clearPaymentIntentForRequestKey(requestKey);
    return reconciled.response;
  };

  // Before tokenized-source submission, ask the server whether this exact
  // request key already owns a durable operation. Only a scoped 404 means the
  // key is new. Any other response is authoritative and returned without
  // invoking the charge callback, so retries cannot submit a fresh source
  // under a pending/leased/provider-unknown operation.
  if (rosterLeagueId !== undefined) {
    const existing = await recoverRosterPaymentOperationByRequestKey(rosterLeagueId, requestKey);
    if (existing.status !== 404) return await reconcile(existing);
  }

  try {
    const initial = await request();
    if (rosterLeagueId !== undefined && !initial.ok) {
      const initialOperation = await readRecoveryOperation(initial);
      const initialDecision = classifyRosterResponse(initialOperation);
      // Exact roster responses already carry the authoritative operation
      // state. Do not replace a pending/unknown/action-required/terminal
      // response with a generic request-key 404.
      if (initialDecision !== 'unknown') return await reconcile(initial);
      // Exact roster errors already contain the authoritative contract
      // outcome. Never fall back to a broad request-key recovery endpoint.
    }
    return await reconcile(initial);
  } catch (error) {
    // A transport failure has no response or operation identity, but the
    // exact request key can still identify a server-created operation. Ask
    // the canonical, tenant/league/user-scoped recovery route to finalize
    // that operation without sending another provider request. A 404 means
    // the request never reached the server, so preserve the original error.
    if (rosterLeagueId !== undefined) {
      const recovered = await recoverRosterPaymentOperationByRequestKey(rosterLeagueId, requestKey).catch(() => null);
      if (recovered && recovered.status !== 404) return await reconcile(recovered);
    }
    throw error;
  }
}
