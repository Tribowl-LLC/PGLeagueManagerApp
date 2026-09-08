import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPaymentIntent,
  clearPaymentIntent,
  interactivePaymentIntentScope,
  isValidPaymentRequestKey,
  paymentRequestHeaders,
  prepareRosterPaymentIntent,
} from '../../client/src/lib/payment-request-identity';

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      get length() { return values.size; },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
    },
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe('interactive payment request identity', () => {
  it('accepts only the bounded URL-safe key contract', () => {
    expect(isValidPaymentRequestKey('1234567890abcdef')).toBe(true);
    expect(isValidPaymentRequestKey('a'.repeat(109))).toBe(true);
    expect(isValidPaymentRequestKey('a'.repeat(110))).toBe(false);
    expect(isValidPaymentRequestKey('short')).toBe(false);
    expect(isValidPaymentRequestKey('1234567890 abcdef')).toBe(false);
    expect(isValidPaymentRequestKey('1234567890\nabcdef')).toBe(false);
    expect(isValidPaymentRequestKey('1234567890/abcdef')).toBe(false);
  });

  it('persists only the logical key and reuses it for the same intent', () => {
    const values = installStorage();
    const first = beginPaymentIntent('league-1:bowler-2:amount-3000');
    const retry = beginPaymentIntent('league-1:bowler-2:amount-3000');

    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(retry).toBe(first);
    expect([...values.values()]).toEqual([first]);
    expect([...values.keys()].join(' ')).not.toContain('cnon');

    clearPaymentIntent('league-1:bowler-2:amount-3000');
    expect(beginPaymentIntent('league-1:bowler-2:amount-3000')).not.toBe(first);
  });

  it('sends the key separately from the JSON request body', () => {
    expect(paymentRequestHeaders('00000000-0000-4000-8000-000000000004')).toEqual({
      'Content-Type': 'application/json',
      'Idempotency-Key': '00000000-0000-4000-8000-000000000004',
    });
  });

  it('uses only authenticated actor, tenant, league, and bowler identity', () => {
    const scope = interactivePaymentIntentScope({ actorUserId: 4, organizationId: 8, leagueId: 17, bowlerId: 42 });
    expect(scope).toContain('"actorUserId":4');
    expect(scope).toContain('"organizationId":8');
    expect(scope).toContain('"leagueId":17');
    expect(scope).toContain('"bowlerId":42');
    expect(scope).not.toMatch(/amount|fingerprint|card|token/i);
  });

  it('fails closed instead of replacing a malformed stored identity', () => {
    const values = installStorage();
    const scope = interactivePaymentIntentScope({ actorUserId: 4, organizationId: 8, leagueId: 17, bowlerId: 42 });
    values.set(`leaguevault:payment-intent:v1:${scope}`, 'malformed-key');
    expect(() => beginPaymentIntent(scope)).toThrow('Stored payment request identity is invalid');
  });

});
