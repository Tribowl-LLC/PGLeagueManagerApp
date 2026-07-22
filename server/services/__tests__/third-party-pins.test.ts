import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task #651 — SendGrid pin verifier registration.
 *
 * Square's verifier has its own dedicated test
 * (`square-version-runtime-guard.test.ts`) that asserts on its
 * legacy log format from task #627. The other providers all
 * use the framework's `makeDefaultPinOnResult` helper, so this file
 * exercises each one's probe + onResult routing through the shared
 * registry.
 */

const mocks = vi.hoisted(() => ({
  loggers: new Map<string, { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('../../logger', () => ({
  createLogger: (name: string) => {
    const existing = mocks.loggers.get(name);
    if (existing) return existing;
    const fresh = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mocks.loggers.set(name, fresh);
    return fresh;
  },
}));

vi.mock('../../storage', () => ({
  storage: {},
}));

await import('../third-party-pins');
const {
  verifyThirdPartyPin,
  _resetThirdPartyPinsForTests,
  _setThirdPartyPinProbeForTests,
  _getRegisteredPinProvidersForTests,
} = await import('../third-party-pin-verifier');

function loggerCalls(name: string): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const l = mocks.loggers.get(name);
  if (!l) throw new Error(`logger '${name}' not yet created — provider didn't register?`);
  return l;
}

describe('third-party pin registrations (task #651)', () => {
  beforeEach(() => {
    _resetThirdPartyPinsForTests();
    for (const l of mocks.loggers.values()) {
      l.info.mockClear();
      l.warn.mockClear();
      l.error.mockClear();
      l.debug.mockClear();
    }
  });

  it('registers every expected provider in the shared registry at import time', () => {
    const providers = _getRegisteredPinProvidersForTests();
    // The Square verifier registers itself when `third-party-pins`
    // imports `square-provider` for its side-effect; the other two
    // register directly inside `third-party-pins`.
    expect(providers).toEqual(expect.arrayContaining(['square', 'sendgrid']));
  });

  describe('SendGrid SDK major + base URL verifier', () => {
    it('passes against the installed @sendgrid/mail (currently major 8 + api.sendgrid.com)', async () => {
      const outcome = await verifyThirdPartyPin('sendgrid');
      expect(outcome).toMatchObject({
        provider: 'sendgrid',
        ok: true,
        actual: '8|https://api.sendgrid.com/',
        expected: '8|https://api.sendgrid.com/',
      });
      expect(loggerCalls('Email').error).not.toHaveBeenCalled();
    });

    it('emits a [PAGE]-prefixed structured error on a major-version drift', async () => {
      _setThirdPartyPinProbeForTests('sendgrid', async () => ({
        ok: false,
        actual: '9|https://api.sendgrid.com/',
        reason: 'drift',
      }));

      const outcome = await verifyThirdPartyPin('sendgrid');
      expect(outcome.ok).toBe(false);

      const error = loggerCalls('Email').error;
      expect(error).toHaveBeenCalledTimes(1);
      const [message, payload] = error.mock.calls[0] ?? [];
      expect(message).toMatch(/^\[PAGE\] /);
      expect(message).toMatch(/sendgrid SDK major \+ API base URL drift/);
      expect(payload).toMatchObject({
        provider: 'sendgrid',
        expected: '8|https://api.sendgrid.com/',
        actual: '9|https://api.sendgrid.com/',
        runbook: 'docs/third-party-pins.md#sendgrid',
      });
    });

    it('emits a [PAGE]-prefixed structured error when the SDK base URL drifts (e.g. EU region or Twilio-Email)', async () => {
      _setThirdPartyPinProbeForTests('sendgrid', async () => ({
        ok: false,
        actual: '8|https://api.eu.sendgrid.com/',
        reason: 'drift',
      }));

      const outcome = await verifyThirdPartyPin('sendgrid');
      expect(outcome.ok).toBe(false);

      const error = loggerCalls('Email').error;
      const [, payload] = error.mock.calls[0] ?? [];
      expect(payload).toMatchObject({
        actual: '8|https://api.eu.sendgrid.com/',
      });
    });
  });
});
