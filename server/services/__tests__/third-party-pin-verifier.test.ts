import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task #651 — Generic third-party SDK pin verifier framework.
 *
 * Exercises the registry / memoization / outcome-routing helpers in
 * `server/services/third-party-pin-verifier.ts` in isolation from
 * any provider's specific probe. Per-provider verifier tests live
 * next to their probes (Square: `square-version-runtime-guard.test.ts`;
 * Clover / SendGrid: `third-party-pins.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../logger', () => ({
  createLogger: () => mocks.log,
}));

const {
  registerThirdPartyPin,
  verifyThirdPartyPin,
  verifyAllThirdPartyPins,
  makeDefaultPinOnResult,
  _resetThirdPartyPinsForTests,
  _setThirdPartyPinProbeForTests,
  _getRegisteredPinProvidersForTests,
} = await import('../third-party-pin-verifier');

describe('third-party pin verifier framework (task #651)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetThirdPartyPinsForTests();
  });

  it('routes a matching probe outcome through onResult with ok:true and the captured value', async () => {
    const onResult = vi.fn();
    registerThirdPartyPin({
      provider: 'unit-test-match',
      pinName: 'X-Pin',
      expected: 'v1',
      probe: async () => ({ ok: true, actual: 'v1' }),
      runbook: 'docs/x.md',
      onResult,
    });

    const outcome = await verifyThirdPartyPin('unit-test-match');

    expect(outcome).toEqual({
      provider: 'unit-test-match',
      pinName: 'X-Pin',
      expected: 'v1',
      actual: 'v1',
      ok: true,
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(outcome);
  });

  it('routes a drift outcome through onResult with ok:false and the wrong captured value', async () => {
    const onResult = vi.fn();
    registerThirdPartyPin({
      provider: 'unit-test-drift',
      pinName: 'X-Pin',
      expected: 'v1',
      probe: async () => ({ ok: false, actual: 'v2', reason: 'drift' }),
      runbook: 'docs/x.md',
      onResult,
    });

    const outcome = await verifyThirdPartyPin('unit-test-drift');

    expect(outcome.ok).toBe(false);
    expect(outcome.actual).toBe('v2');
    expect(onResult).toHaveBeenCalledWith(outcome);
  });

  it('treats a throwing probe as non-conclusive (ok:true, actual:undefined) and warns', async () => {
    const onResult = vi.fn();
    registerThirdPartyPin({
      provider: 'unit-test-throw',
      pinName: 'X-Pin',
      expected: 'v1',
      probe: async () => {
        throw new Error('probe blew up');
      },
      runbook: 'docs/x.md',
      onResult,
    });

    const outcome = await verifyThirdPartyPin('unit-test-throw');

    expect(outcome).toEqual({
      provider: 'unit-test-throw',
      pinName: 'X-Pin',
      expected: 'v1',
      actual: undefined,
      ok: true,
    });
    // The throw is logged so a probe bug isn't invisible, but we
    // do NOT page — that would be a fail-shut on a probe bug, not
    // on real drift.
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('probe threw'),
      expect.objectContaining({ error: 'probe blew up' }),
    );
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it('memoizes the outcome per provider so the probe runs at most once', async () => {
    const probe = vi.fn(async () => ({ ok: true as const, actual: 'v1' }));
    registerThirdPartyPin({
      provider: 'unit-test-memo',
      pinName: 'X-Pin',
      expected: 'v1',
      probe,
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });

    const [a, b, c] = await Promise.all([
      verifyThirdPartyPin('unit-test-memo'),
      verifyThirdPartyPin('unit-test-memo'),
      verifyThirdPartyPin('unit-test-memo'),
    ]);
    const d = await verifyThirdPartyPin('unit-test-memo');

    expect(probe).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });

  it('throws a descriptive error when asked to verify an unregistered provider', async () => {
    await expect(verifyThirdPartyPin('does-not-exist')).rejects.toThrow(
      /No third-party pin verifier registered for provider 'does-not-exist'/,
    );
  });

  it('verifyAllThirdPartyPins runs every registered verifier and returns one outcome per provider', async () => {
    registerThirdPartyPin({
      provider: 'unit-test-all-a',
      pinName: 'A',
      expected: 'va',
      probe: async () => ({ ok: true, actual: 'va' }),
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });
    registerThirdPartyPin({
      provider: 'unit-test-all-b',
      pinName: 'B',
      expected: 'vb',
      probe: async () => ({ ok: false, actual: 'wrong', reason: 'drift' }),
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });

    const outcomes = await verifyAllThirdPartyPins();
    const byProvider = Object.fromEntries(outcomes.map((o) => [o.provider, o]));
    expect(byProvider['unit-test-all-a']).toMatchObject({ ok: true, actual: 'va' });
    expect(byProvider['unit-test-all-b']).toMatchObject({ ok: false, actual: 'wrong' });
  });

  it('re-registering the same provider replaces the previous verifier and drops the memoized outcome', async () => {
    const firstProbe = vi.fn(async () => ({ ok: true as const, actual: 'first' }));
    registerThirdPartyPin({
      provider: 'unit-test-re-reg',
      pinName: 'X',
      expected: 'first',
      probe: firstProbe,
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });
    const before = await verifyThirdPartyPin('unit-test-re-reg');
    expect(before.actual).toBe('first');

    const secondProbe = vi.fn(async () => ({ ok: true as const, actual: 'second' }));
    registerThirdPartyPin({
      provider: 'unit-test-re-reg',
      pinName: 'X',
      expected: 'second',
      probe: secondProbe,
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });
    const after = await verifyThirdPartyPin('unit-test-re-reg');
    expect(after.actual).toBe('second');
    expect(secondProbe).toHaveBeenCalledTimes(1);
  });

  it('_setThirdPartyPinProbeForTests swaps the probe and clears the memoized outcome', async () => {
    registerThirdPartyPin({
      provider: 'unit-test-seam',
      pinName: 'X',
      expected: 'v1',
      probe: async () => ({ ok: true, actual: 'v1' }),
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });
    const first = await verifyThirdPartyPin('unit-test-seam');
    expect(first).toMatchObject({ ok: true, actual: 'v1' });

    _setThirdPartyPinProbeForTests('unit-test-seam', async () => ({
      ok: false,
      actual: 'drifted',
      reason: 'drift',
    }));
    const second = await verifyThirdPartyPin('unit-test-seam');
    expect(second).toMatchObject({ ok: false, actual: 'drifted' });

    // `null` restores the registered default probe and again drops
    // the memoized outcome.
    _setThirdPartyPinProbeForTests('unit-test-seam', null);
    const third = await verifyThirdPartyPin('unit-test-seam');
    expect(third).toMatchObject({ ok: true, actual: 'v1' });
  });

  it('_getRegisteredPinProvidersForTests returns the list of registered provider keys', () => {
    registerThirdPartyPin({
      provider: 'unit-test-list-a',
      pinName: 'A',
      expected: 'x',
      probe: async () => ({ ok: true, actual: 'x' }),
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });
    registerThirdPartyPin({
      provider: 'unit-test-list-b',
      pinName: 'B',
      expected: 'x',
      probe: async () => ({ ok: true, actual: 'x' }),
      runbook: 'docs/x.md',
      onResult: () => undefined,
    });
    const providers = _getRegisteredPinProvidersForTests();
    expect(providers).toEqual(expect.arrayContaining(['unit-test-list-a', 'unit-test-list-b']));
  });

  describe('makeDefaultPinOnResult', () => {
    it('emits an info line on match', () => {
      const onResult = makeDefaultPinOnResult({
        loggerName: 'TestLogger',
        runbook: 'docs/x.md#anchor',
        remediation: 'rollback the bump',
      });
      onResult({
        provider: 'foo',
        pinName: 'Bar',
        expected: 'v1',
        actual: 'v1',
        ok: true,
      });
      expect(mocks.log.info).toHaveBeenCalledWith(
        expect.stringContaining('foo Bar verified at runtime'),
        expect.objectContaining({ actual: 'v1', expected: 'v1' }),
      );
      expect(mocks.log.error).not.toHaveBeenCalled();
    });

    it('emits an info line (NOT an error) on a non-conclusive probe', () => {
      const onResult = makeDefaultPinOnResult({
        loggerName: 'TestLogger',
        runbook: 'docs/x.md#anchor',
        remediation: 'rollback the bump',
      });
      onResult({
        provider: 'foo',
        pinName: 'Bar',
        expected: 'v1',
        actual: undefined,
        ok: true,
      });
      expect(mocks.log.info).toHaveBeenCalledWith(
        expect.stringContaining('runtime pin check skipped'),
      );
      expect(mocks.log.error).not.toHaveBeenCalled();
    });

    it('emits a [PAGE]-prefixed structured error line on drift', () => {
      const onResult = makeDefaultPinOnResult({
        loggerName: 'TestLogger',
        runbook: 'docs/x.md#anchor',
        remediation: 'rollback the bump',
      });
      onResult({
        provider: 'foo',
        pinName: 'Bar',
        expected: 'v1',
        actual: 'v2',
        ok: false,
      });
      expect(mocks.log.error).toHaveBeenCalledTimes(1);
      const [message, payload] = mocks.log.error.mock.calls[0] ?? [];
      // Same `[PAGE]` prefix convention as Square's task #627 line so
      // a single grep covers every paging-priority pin alert.
      expect(message).toMatch(/^\[PAGE\] /);
      expect(message).toMatch(/foo Bar drift detected at runtime/);
      expect(payload).toMatchObject({
        provider: 'foo',
        pinName: 'Bar',
        expected: 'v1',
        actual: 'v2',
        runbook: 'docs/x.md#anchor',
        remediation: 'rollback the bump',
      });
    });

    it('serializes a missing captured value as null (not undefined) so the JSON sink round-trips cleanly', () => {
      const onResult = makeDefaultPinOnResult({
        loggerName: 'TestLogger',
        runbook: 'docs/x.md#anchor',
        remediation: 'rollback the bump',
      });
      onResult({
        provider: 'foo',
        pinName: 'Bar',
        expected: 'v1',
        actual: undefined,
        ok: false,
      });
      const [, payload] = mocks.log.error.mock.calls[0] ?? [];
      expect(payload).toMatchObject({ actual: null });
    });
  });
});
