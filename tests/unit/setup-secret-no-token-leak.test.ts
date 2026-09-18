/**
 * Regression test for task #396 — sibling of
 * `tests/unit/csrf-no-token-leak.test.ts`.
 *
 * `checkSetupSecret` in `server/routes/setup-admin.ts` is the only
 * authentication factor for the disaster-recovery bootstrap endpoints
 * (`/api/setup/create-first-admin`, `/api/setup/first-system-admin/:id`).
 * `SETUP_SECRET` is set out-of-band by the operator running `curl`
 * against a fresh DB; if it ever ends up in the production log sink
 * an operator with log access could rerun those endpoints. So this
 * test pins the contract: every reject branch in the secret check
 * may emit log lines, but none of them may interpolate the secret
 * (or an 8-byte prefix of it) at any log level.
 *
 * The test mocks the logger so we can capture every line emitted,
 * exercises every reject branch with a known secret value, and
 * delegates the leak assertion to the shared helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  assertNoTokenLeak as sharedAssertNoTokenLeak,
  type CapturedLogLine,
} from '../helpers/no-token-leak';

const captured: CapturedLogLine[] = [];

function record(level: string) {
  return (message: string, ...args: unknown[]) => {
    const tail = args.length > 0 ? ' ' + JSON.stringify(args) : '';
    captured.push({ level, line: `${message}${tail}` });
  };
}

vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  }),
}));

// A representative 48-byte secret (the same shape the operator-facing
// docs recommend: `openssl rand -base64 48`). Length is well above
// MIN_SETUP_SECRET_LENGTH so nothing in the validator complains.
//
// Hoisted via `vi.hoisted` so the value is available inside the
// `vi.mock('../../server/config', ...)` factory below — vi.mock is
// hoisted above top-level `const` declarations and cannot otherwise
// reference them.
const { SETUP_SECRET, WRONG_SECRET } = vi.hoisted(() => ({
  SETUP_SECRET:
    'kQv3vJm2pX9sR7wT0aB4cD6eF8gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0aB1cD2eF',
  WRONG_SECRET: 'definitely-wrong-secret-with-its-own-distinct-bytes-X',
}));

vi.mock('../../server/config', () => ({
  env: { SETUP_SECRET },
  isDev: true,
  isProdLike: false,
}));

// Pulled in AFTER the mocks so the mocked logger / config are wired.
import { checkSetupSecret } from '../../server/routes/setup-admin';

function makeReq(headerValue: string | string[] | undefined): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (headerValue !== undefined) headers['x-setup-secret'] = headerValue;
  return { headers } as unknown as Request;
}

function makeRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function assertNoSecretLeak() {
  sharedAssertNoTokenLeak(captured, { full: [SETUP_SECRET, WRONG_SECRET] });
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('checkSetupSecret does not leak the setup secret to logs', () => {
  it('rejects a missing header without leaking the configured secret', () => {
    const ok = checkSetupSecret(makeReq(undefined), makeRes());
    expect(ok).toBe(false);
    assertNoSecretLeak();
  });

  it('rejects a wrong single-string header without leaking either secret', () => {
    const ok = checkSetupSecret(makeReq(WRONG_SECRET), makeRes());
    expect(ok).toBe(false);
    assertNoSecretLeak();
  });

  it('rejects the comma-joined "<real>, trailing" wire shape without leaking either secret', () => {
    // Defense-in-depth: even when the real secret appears FIRST in the
    // collapsed string, the header normalization treats the joined
    // string as a single value (and so safeTokenCompare rejects it).
    // The reject branch must not include the joined string in any log.
    const ok = checkSetupSecret(makeReq(`${SETUP_SECRET}, trailing`), makeRes());
    expect(ok).toBe(false);
    assertNoSecretLeak();
  });

  it('rejects a string[] header with a bogus first element without leaking the real secret', () => {
    const ok = checkSetupSecret(
      makeReq(['bogus-first', SETUP_SECRET]),
      makeRes(),
    );
    expect(ok).toBe(false);
    assertNoSecretLeak();
  });

  it('passes the gate on the correct secret without emitting a log line at all', () => {
    const ok = checkSetupSecret(makeReq(SETUP_SECRET), makeRes());
    expect(ok).toBe(true);
    // The success path must stay silent. If a future change starts
    // logging on success, this assertion forces the test to be
    // updated alongside that change so the new line can be reviewed
    // for leak risk.
    expect(captured).toEqual([]);
  });
});

describe('checkSetupSecret with SETUP_SECRET unset', () => {
  // Re-mock config so the disabled-endpoint branch fires. We need a
  // separate `vi.doMock` + dynamic re-import so the mock applies
  // BEFORE the module factory runs again.
  it('returns the disabled-endpoint reject without leaking anything', async () => {
    vi.resetModules();
    vi.doMock('../../server/config', () => ({
      env: { SETUP_SECRET: undefined },
      isDev: true,
      isProdLike: false,
    }));
    vi.doMock('../../server/logger', () => ({
      createLogger: () => ({
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        debug: record('debug'),
      }),
    }));
    captured.length = 0;
    const { checkSetupSecret: freshCheck } = await import(
      '../../server/routes/setup-admin'
    );
    const ok = freshCheck(makeReq(SETUP_SECRET), makeRes());
    expect(ok).toBe(false);
    // The disabled-endpoint branch hits `sendError` only — no log
    // line is emitted today. Pin that explicitly so a future change
    // that adds e.g. `log.warn('Setup secret missing', { provided })`
    // is forced to reckon with this contract before merging.
    assertNoSecretLeak();
  });
});
