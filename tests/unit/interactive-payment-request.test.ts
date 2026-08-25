import { describe, expect, it, beforeEach, vi } from 'vitest';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ csrfFetch: csrfFetchMock }));

import { buildInteractiveOccurrenceFields, interactiveIntentScopeSuffix, interactiveIntentSemanticKey } from '../../client/src/lib/interactive-payment-request';
import { paymentRequestWithRecovery } from '../../client/src/lib/payment-request-identity';

describe('interactive wallet request occurrence fields', () => {
  const selection = { obligationId: '44444444-4444-4444-8444-444444444444', amountMinor: 2000 };
  const fingerprint = `lvquote:v1:${'d'.repeat(64)}`;

  it('includes the selected intent for a member wallet single-bowler body', () => {
    expect({ sourceId: 'wallet-token', bowlerId: 7, ...buildInteractiveOccurrenceFields([selection], fingerprint) })
      .toMatchObject({ bowlerId: 7, occurrenceAllocations: [selection], occurrenceQuoteFingerprint: fingerprint });
  });

  it('includes the same selected intent for a member combined-wallet body', () => {
    expect({ payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }], ...buildInteractiveOccurrenceFields([selection], fingerprint) })
      .toMatchObject({ payees: expect.any(Array), occurrenceAllocations: [selection], occurrenceQuoteFingerprint: fingerprint });
  });

  it('includes the selected intent for an admin wallet body', () => {
    expect({ bowlerId: 9, ...buildInteractiveOccurrenceFields([selection], fingerprint) })
      .toMatchObject({ bowlerId: 9, occurrenceAllocations: [selection], occurrenceQuoteFingerprint: fingerprint });
  });

  it('never adds occurrence fields to auto-pay requests', () => {
    expect(buildInteractiveOccurrenceFields([selection], fingerprint, false)).toEqual({});
  });

  it('changes the local idempotency semantic key when selection or quote evidence changes', () => {
    const changedSelection = { ...selection, amountMinor: 1500 };
    expect(interactiveIntentSemanticKey([selection], fingerprint)).not.toBe(interactiveIntentSemanticKey([changedSelection], fingerprint));
    expect(interactiveIntentSemanticKey([selection], fingerprint)).not.toBe(interactiveIntentSemanticKey([selection], `${fingerprint.slice(0, -1)}e`));
  });

  it('preserves every pre-F2 scope exactly while suffixing canonical intents', () => {
    expect(interactiveIntentScopeSuffix(undefined, undefined)).toBe('');
    expect(interactiveIntentScopeSuffix([], undefined)).toBe('');
    const suffix = interactiveIntentScopeSuffix([selection], fingerprint);
    const legacyScopes = [
      'bowler:combined:11:4000:[{"bowlerId":7,"amount":2000},{"bowlerId":8,"amount":2000}]:false',
      'bowler:11:7:2000:saved',
      'bowler:11:7:2000:new:true',
      'bowler-wallet:11:7:2000',
      'bowler-wallet:combined:11:4000:8',
      'history-wallet:7:11:2000',
      'history:7:11:2000:saved',
      'history:7:11:2000:new:false',
      'admin:7:11:2000:new:false',
      'admin-wallet:7:11:2000',
    ];
    for (const scope of legacyScopes) expect(`${scope}${interactiveIntentScopeSuffix(undefined, undefined)}`).toBe(scope);
    expect(`bowler:11:7:2000:saved${suffix}`).toContain(`:saved:${fingerprint}`);
    expect(`admin-wallet:7:11:2000${suffix}`).toContain(`:2000:${fingerprint}`);
  });
});

describe('interactive request-key recovery', () => {
  beforeEach(() => csrfFetchMock.mockReset());

  it('reconciles a network-lost wallet request by the exact stored key without re-tokenizing', async () => {
    const recovered = new Response(null, { status: 200 });
    csrfFetchMock.mockResolvedValueOnce(recovered);
    const request = vi.fn().mockRejectedValueOnce(new Error('connection reset'));

    await expect(paymentRequestWithRecovery('request-key-123456', request)).resolves.toBe(recovered);
    expect(request).toHaveBeenCalledOnce();
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/payments-provider/payment-operations/recover', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(csrfFetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Idempotency-Key': 'request-key-123456' });
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
    csrfFetchMock.mockResolvedValueOnce(recovered);
    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.resolve(initial), 42, 11)).resolves.toBe(recovered);
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/financials/leagues/11/interactive-obligation-charge/2/operations/11111111-1111-4111-8111-111111111111/recover', expect.objectContaining({ method: 'POST' }));
  });

  it('hands a generic terminal success response to exact roster recovery', async () => {
    const generic = new Response(JSON.stringify({
      success: true,
      status: 'COMPLETED',
      id: 'sq_pay_123',
      operationId: '11111111-1111-4111-8111-111111111111',
    }), { status: 200 });
    const exact = new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
    } }), { status: 200 });
    csrfFetchMock.mockResolvedValueOnce(generic).mockResolvedValueOnce(exact);

    await expect(paymentRequestWithRecovery(
      'request-key-123456',
      () => Promise.reject(new Error('connection reset')),
      42,
      11,
    )).resolves.toBe(exact);
    expect(csrfFetchMock.mock.calls[1]?.[0]).toBe('/api/financials/leagues/11/interactive-obligation-charge/2/operations/11111111-1111-4111-8111-111111111111/recover');
  });

  it('extracts roster identity from a generic non-2xx operation detail', async () => {
    const generic = new Response(JSON.stringify({
      success: false,
      error: {
        code: 'RECONCILIATION_REQUIRED',
        message: 'Payment status is still being confirmed.',
        details: {
          operationId: '11111111-1111-4111-8111-111111111111',
          status: 'reconciliation_required',
        },
      },
    }), { status: 409 });
    const exact = new Response(JSON.stringify({ data: {
      contractVersion: 'interactive-obligation-recovery/1',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'reconciliation_required',
    } }), { status: 409 });
    csrfFetchMock.mockResolvedValueOnce(generic).mockResolvedValueOnce(exact);

    await expect(paymentRequestWithRecovery(
      'request-key-123456',
      () => Promise.resolve(new Response(null, { status: 409 })),
      42,
      11,
    )).resolves.toBe(exact);
    expect(csrfFetchMock.mock.calls[1]?.[0]).toContain('/operations/11111111-1111-4111-8111-111111111111/recover');
  });

  it.each(['STALE_QUOTE', 'INVALID_REQUEST'])('preserves an exact roster validation response when generic recovery has no durable identity (%s)', async (code) => {
    const initial = new Response(JSON.stringify({
      success: false,
      error: { code, message: code === 'STALE_QUOTE' ? 'The quote is no longer current.' : 'The payment request is invalid.' },
    }), { status: code === 'STALE_QUOTE' ? 409 : 400 });
    // A request-key lookup can legitimately return a generic not-found/error
    // response when no operation was dispatched. It must not replace the
    // exact validation response with a misleading recovery 404.
    csrfFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Payment operation not found' },
    }), { status: 404 }));

    const result = await paymentRequestWithRecovery(
      'request-key-123456',
      () => Promise.resolve(initial),
      42,
      11,
    );

    expect(result).toBe(initial);
    expect(result.status).toBe(code === 'STALE_QUOTE' ? 409 : 400);
    await expect(result.clone().json()).resolves.toMatchObject({ error: { code } });
    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    expect(csrfFetchMock.mock.calls[0]?.[0]).toBe('/api/payments-provider/payment-operations/recover');
  });

  it('includes explicit organization scope for an org-less scoped admin recovery', async () => {
    const recovered = new Response(null, { status: 202 });
    csrfFetchMock.mockResolvedValueOnce(recovered);
    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.reject(new Error('connection reset')), 42)).resolves.toBe(recovered);
    expect(csrfFetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ organizationId: 42 }));
  });
});
