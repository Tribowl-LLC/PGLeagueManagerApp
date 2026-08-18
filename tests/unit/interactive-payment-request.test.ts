import { describe, expect, it, beforeEach, vi } from 'vitest';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ csrfFetch: csrfFetchMock }));

import { buildInteractiveOccurrenceFields, interactiveIntentSemanticKey } from '../../client/src/lib/interactive-payment-request';
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

  it('includes explicit organization scope for an org-less scoped admin recovery', async () => {
    const recovered = new Response(null, { status: 202 });
    csrfFetchMock.mockResolvedValueOnce(recovered);
    await expect(paymentRequestWithRecovery('request-key-123456', () => Promise.reject(new Error('connection reset')), 42)).resolves.toBe(recovered);
    expect(csrfFetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ organizationId: 42 }));
  });
});
