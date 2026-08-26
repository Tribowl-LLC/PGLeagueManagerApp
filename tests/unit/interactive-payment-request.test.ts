import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ csrfFetch: csrfFetchMock }));

import {
  assertRosterPaymentSucceeded,
  beginPaymentIntent,
  paymentRequestWithRecovery,
  rosterPaymentStatusMessage,
} from '../../client/src/lib/payment-request-identity';

describe('interactive request-key recovery', () => {
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

    await expect(paymentRequestWithRecovery('request-key-123456', request)).rejects.toThrow('connection reset');
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

    await expect(paymentRequestWithRecovery('request-key-123456', request, 11)).resolves.toBe(recovered);
    expect(csrfFetchMock).toHaveBeenCalledWith(
      '/api/financials/leagues/11/interactive-obligation-charge/2/recover-by-request-key',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestKey: 'request-key-123456' }),
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

    await expect(paymentRequestWithRecovery('request-key-123456', request, 11)).resolves.toBe(existing);
    expect(request).not.toHaveBeenCalled();
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it('preserves a transport error when the exact request key was never persisted', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('connection reset'));
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(noExistingOperation());

    await expect(paymentRequestWithRecovery('request-key-123456', request, 11)).rejects.toThrow('connection reset');
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not invoke recovery for an ordinary bounded API response', async () => {
    const response = new Response(null, { status: 409 });
    const request = vi.fn().mockResolvedValueOnce(response);

    await expect(paymentRequestWithRecovery('request-key-123456', request)).resolves.toBe(response);
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('reconciles a roster operation by operation id after local finalization reports review', async () => {
    const initial = new Response(JSON.stringify({ data: { contractVersion: 'interactive-obligation-charge/2', operationId: '11111111-1111-4111-8111-111111111111', status: 'reconciliation_required' } }), { status: 202 });
    const recovered = new Response(JSON.stringify({ data: { contractVersion: 'interactive-obligation-recovery/1', operationId: '11111111-1111-4111-8111-111111111111', status: 'succeeded' } }), { status: 200 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(recovered);
    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.resolve(initial), 11)).resolves.toBe(recovered);
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/financials/leagues/11/interactive-obligation-charge/2/operations/11111111-1111-4111-8111-111111111111/recover', expect.objectContaining({ method: 'POST' }));
  });

  it.each(['pending', 'provider_unknown', 'retry_scheduled'])('preserves exact %s without invoking roster recovery', async (status) => {
    const initial = exactResponse(status);
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery(
      'request-key-123456',
      () => Promise.resolve(initial),
      11,
    )).resolves.toBe(initial);
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it('returns an exact succeeded response without another recovery request', async () => {
    const initial = exactResponse('succeeded', 201);
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.resolve(initial), 11)).resolves.toBe(initial);
    expect(csrfFetchMock).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'provider_unknown', 'retry_scheduled'])('preserves generic %s operation state without exact recovery', async (status) => {
    const initial = new Response(JSON.stringify({
      success: true,
      operationId: '11111111-1111-4111-8111-111111111111',
      status,
    }), { status: 202 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.resolve(initial), 11)).resolves.toBe(initial);
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

  it('does not recursively recover an already-returned reconciliation response', async () => {
    const initial = exactResponse('reconciliation_required');
    const recovery = new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'reconciliation_required',
    } }), { status: 409 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation()).mockResolvedValueOnce(recovery);

    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.resolve(initial), 11)).resolves.toBe(recovery);
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['STALE_QUOTE', 'INVALID_REQUEST'])('preserves an exact roster validation response without generic recovery (%s)', async (code) => {
    const initial = new Response(JSON.stringify({
      success: false,
      error: { code, message: code === 'STALE_QUOTE' ? 'The quote is no longer current.' : 'The payment request is invalid.' },
    }), { status: code === 'STALE_QUOTE' ? 409 : 400 });
    csrfFetchMock.mockResolvedValueOnce(noExistingOperation());
    const result = await paymentRequestWithRecovery(
      'request-key-123456',
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
      'request-key-123456',
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
