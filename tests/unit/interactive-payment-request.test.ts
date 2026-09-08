import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ csrfFetch: csrfFetchMock }));

import {
  assertRosterPaymentSucceeded,
  beginPaymentIntent,
  clearPaymentIntent,
  clearPaymentIntentForRequestKey,
  interactivePaymentIntentScope,
  paymentRequestWithRecovery,
  prepareRosterPaymentIntent,
  rosterPaymentStatusMessage,
} from '../../client/src/lib/payment-request-identity';

describe('interactive request-key recovery', () => {
  const requestKey = '00000000-0000-4000-8000-000000000001';
  const legacyRequestKey = '00000000-0000-4000-8000-000000000002';
  const manualRequestKey = '00000000-0000-4000-8000-000000000003';
  const stableRequestKey = '00000000-0000-4000-8000-000000000004';
  const legacyPendingRequestKey = '00000000-0000-4000-8000-000000000005';

  beforeEach(() => csrfFetchMock.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const exactResponse = (status: string, httpStatus = 202) => new Response(JSON.stringify({
    data: {
      contractVersion: 'interactive-obligation-charge/2',
      operationId: '11111111-1111-4111-8111-111111111111',
      status,
    },
  }), { status: httpStatus });
  const noExistingOperation = () => new Response(null, { status: 404 });

  function installStorage() {
    const values = new Map<string, string>();
    const storage = {
      get length() { return values.size; },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
    };
    vi.stubGlobal('window', { localStorage: storage });
    return values;
  }

  it('keeps a network-lost request unresolved when no exact operation identity exists', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('connection reset'));

    await expect(paymentRequestWithRecovery(requestKey, request)).rejects.toThrow('connection reset');
    expect(request).toHaveBeenCalledOnce();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('recovers a network-lost canonical request by its exact request key', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('connection reset'));
    const recovered = new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
    } }), { status: 200 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(recovered);

    await expect(paymentRequestWithRecovery(requestKey, request, 11)).resolves.toBe(recovered);
    expect(csrfFetchMock).toHaveBeenCalledWith(
      '/api/financials/leagues/11/interactive-obligation-charge/2/recover-by-request-key',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestKey }),
      }),
    );
  });

  it.each(['pending', 'leased', 'provider_unknown', 'retry_scheduled'])('returns a pre-existing %s operation without invoking the charge callback', async (status) => {
    const request = vi.fn().mockResolvedValue(exactResponse('succeeded', 201));
    const existing = new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status,
    } }), { status: 200 });
    csrfFetchMock.mockResolvedValueOnce(existing);

    await expect(paymentRequestWithRecovery(requestKey, request, 11)).resolves.toBe(existing);
    expect(request).not.toHaveBeenCalled();
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it('preserves a transport error when the exact request key was never persisted', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('connection reset'));
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(noExistingOperation());

    await expect(paymentRequestWithRecovery(requestKey, request, 11)).rejects.toThrow('connection reset');
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not invoke recovery for an ordinary bounded API response', async () => {
    const response = new Response(null, { status: 409 });
    const request = vi.fn().mockResolvedValueOnce(response);

    await expect(paymentRequestWithRecovery(requestKey, request)).resolves.toBe(response);
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('reconciles a roster operation by operation id after local finalization reports review', async () => {
    const initial = new Response(JSON.stringify({ data: { contractVersion: 'interactive-obligation-charge/2', operationId: '11111111-1111-4111-8111-111111111111', status: 'reconciliation_required' } }), { status: 202 });
    const recovered = new Response(JSON.stringify({ data: { contractVersion: 'interactive-obligation-recovery/1', operationId: '11111111-1111-4111-8111-111111111111', status: 'succeeded' } }), { status: 200 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(recovered);
    await expect(paymentRequestWithRecovery(requestKey, () => Promise.resolve(initial), 11)).resolves.toBe(recovered);
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/financials/leagues/11/interactive-obligation-charge/2/operations/11111111-1111-4111-8111-111111111111/recover', expect.objectContaining({ method: 'POST' }));
  });

  it.each(['pending', 'provider_unknown', 'retry_scheduled'])('preserves exact %s without invoking roster recovery', async (status) => {
    const initial = exactResponse(status);
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery(
      requestKey,
      () => Promise.resolve(initial),
      11,
    )).resolves.toBe(initial);
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it('returns an exact succeeded response without another recovery request', async () => {
    const initial = exactResponse('succeeded', 201);
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery(requestKey, () => Promise.resolve(initial), 11)).resolves.toBe(initial);
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'provider_unknown', 'retry_scheduled'])('preserves generic %s operation state without exact recovery', async (status) => {
    const initial = new Response(JSON.stringify({
      success: true,
      operationId: '11111111-1111-4111-8111-111111111111',
      status,
    }), { status: 202 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery(requestKey, () => Promise.resolve(initial), 11)).resolves.toBe(initial);
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it.each(['failed_terminal', 'canceled', 'action_required'])('preserves exact terminal %s and rotates the browser intent', async (status) => {
    const values = installStorage();
    const scope = `roster:terminal:${status}`;
    const requestKey = beginPaymentIntent(scope);
    expect(values.size).toBe(1);
    const initial = exactResponse(status, 202);
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());

    await expect(paymentRequestWithRecovery(requestKey, () => Promise.resolve(initial), 11)).resolves.toBe(initial);
    expect(csrfFetchMock).toHaveBeenCalledOnce();
    expect(values.size).toBe(0);
    // A corrected retry gets a new idempotency key instead of replaying the
    // terminal operation with a changed card/source.
    expect(beginPaymentIntent(scope)).not.toBe(requestKey);
    expect(rosterPaymentStatusMessage(status)).toContain('not completed');
  });

  it('prepares a stable intent before a quote and leaves acknowledged outcomes for the active caller to clear', async () => {
    const values = installStorage();
    const scope = interactivePaymentIntentScope({ actorUserId: 4, organizationId: 8, leagueId: 11, bowlerId: 42 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    const first = await prepareRosterPaymentIntent(scope, 11);
    expect(first.outcome).toBe('new');
    const requestKey = first.requestKey;
    expect(values.size).toBe(1);

    csrfFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
    } }), { status: 200 }));
    const acknowledged = await prepareRosterPaymentIntent(scope, 11);
    expect(acknowledged.outcome).toBe('succeeded');
    expect(values.size).toBe(1);
    clearPaymentIntentForRequestKey(acknowledged.requestKey);
    expect(values.size).toBe(0);

    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    const fresh = await prepareRosterPaymentIntent(scope, 11);
    expect(fresh.outcome).toBe('new');
    expect(fresh.requestKey).not.toBe(requestKey);

    csrfFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'failed_terminal',
    } }), { status: 200 }));
    const terminal = await prepareRosterPaymentIntent(scope, 11);
    expect(terminal.outcome).toBe('terminal_failure');
    clearPaymentIntentForRequestKey(terminal.requestKey);
    expect(values.size).toBe(0);
  });

  it('recovers a deployed legacy card key with a changed quote before minting v2', async () => {
    const values = installStorage();
    const scope = interactivePaymentIntentScope({ actorUserId: 4, organizationId: 8, leagueId: 11, bowlerId: 42 });
    const legacyScope = 'make-payment-roster:11:42:8750:fingerprint:with:colon:new';
    const manualScope = 'admin:11:42:8750:manual:fingerprint:cash:new';
    values.set(`leaguevault:payment-intent:v1:${legacyScope}`, legacyRequestKey);
    values.set(`leaguevault:payment-intent:v1:${manualScope}`, manualRequestKey);
    const acknowledged = exactResponse('succeeded', 200);
    csrfFetchMock.mockResolvedValueOnce(acknowledged);

    const prepared = await prepareRosterPaymentIntent(scope, 11);

    expect(prepared).toMatchObject({ outcome: 'succeeded', requestKey: legacyRequestKey, scope: legacyScope });
    expect(csrfFetchMock).toHaveBeenCalledWith(
      '/api/financials/leagues/11/interactive-obligation-charge/2/recover-by-request-key',
      expect.objectContaining({ body: JSON.stringify({ requestKey: legacyRequestKey }) }),
    );
    expect(values.has(`leaguevault:payment-intent:v1:${scope}`)).toBe(false);
    expect(values.has(`leaguevault:payment-intent:v1:${manualScope}`)).toBe(true);
    if (!prepared.scope) throw new Error('legacy scope was not returned');
    clearPaymentIntent(prepared.scope, prepared.requestKey);
    expect(values.has(`leaguevault:payment-intent:v1:${legacyScope}`)).toBe(false);
  });

  it('does not bypass a legacy unresolved operation when v2 already exists', async () => {
    const values = installStorage();
    const scope = interactivePaymentIntentScope({ actorUserId: 4, organizationId: 8, leagueId: 11, bowlerId: 42 });
    const legacyScope = 'roster:11:42:5750:old:fingerprint:saved';
    values.set(`leaguevault:payment-intent:v1:${scope}`, stableRequestKey);
    values.set(`leaguevault:payment-intent:v1:${legacyScope}`, legacyPendingRequestKey);
    csrfFetchMock
      .mockResolvedValueOnce(noExistingOperation())
      .mockResolvedValueOnce(exactResponse('pending'));

    const prepared = await prepareRosterPaymentIntent(scope, 11);

    expect(prepared).toMatchObject({ outcome: 'unresolved', requestKey: legacyPendingRequestKey, scope: legacyScope, status: 'pending' });
    expect(values.has(`leaguevault:payment-intent:v1:${scope}`)).toBe(true);
    expect(values.has(`leaguevault:payment-intent:v1:${legacyScope}`)).toBe(true);
  });

  it('does not recursively recover an already-returned reconciliation response', async () => {
    const initial = exactResponse('reconciliation_required');
    const recovery = new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'reconciliation_required',
    } }), { status: 409 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(recovery);

    await expect(paymentRequestWithRecovery(requestKey, () => Promise.resolve(initial), 11)).resolves.toBe(recovery);
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['STALE_QUOTE', 'INVALID_REQUEST'])('preserves an exact roster validation response without generic recovery (%s)', async (code) => {
    const initial = new Response(JSON.stringify({
      success: false,
      error: { code, message: code === 'STALE_QUOTE' ? 'The quote is no longer current.' : 'The payment request is invalid.' },
    }), { status: code === 'STALE_QUOTE' ? 409 : 400 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    const result = await paymentRequestWithRecovery(
      requestKey,
      () => Promise.resolve(initial),
      11,
    );

    expect(result).toBe(initial);
    expect(result.status).toBe(code === 'STALE_QUOTE' ? 409 : 400);
    await expect(result.clone().json()).resolves.toMatchObject({ error: { code } });
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it('keeps a network-lost request unresolved when exact recovery finds no operation', async () => {
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery(
      requestKey,
      () => Promise.reject(new Error('connection reset')),
      11,
    )).rejects.toThrow('connection reset');
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
  });

  it('exposes state-specific recovery messages and only accepts succeeded', () => {
    expect(rosterPaymentStatusMessage('provider_unknown')).toContain('still being confirmed');
    expect(rosterPaymentStatusMessage('action_required')).toContain('not completed');
    expect(rosterPaymentStatusMessage('reconciliation_required')).toContain('reconciliation');
    expect(() => assertRosterPaymentSucceeded('failed_terminal')).toThrow('not completed');
    expect(() => assertRosterPaymentSucceeded('succeeded')).not.toThrow();
  });
});
