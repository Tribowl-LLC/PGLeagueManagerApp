/**
 * Regression test for task #396 — sibling of
 * `tests/unit/csrf-no-token-leak.test.ts` covering the
 * `server/routes/auth.ts` handlers listed in the task brief:
 *
 *   - POST /api/auth/login          (passport LocalStrategy)
 *   - POST /api/auth/set-password   (single-use invite / reset token)
 *   - POST /api/auth/forgot-password (issues a single-use reset token)
 *
 * Same threat model as the CSRF test: an operator who flips
 * `LOG_LEVEL=debug` for an incident must not end up shipping live
 * passwords (login attempts) or single-use reset / invite tokens
 * (set-password / forgot-password) to the production log sink, where
 * they would be replayable by anyone with log access.
 *
 * Strategy: mount the real `registerAuthRoutes` on an isolated
 * express app with all external deps mocked (storage, email, db,
 * passport-local, rate-limit), drive every reject branch with known
 * secret bytes, and assert via the shared `assertNoTokenLeak` helper
 * that no captured log line contains those bytes (or an 8-byte
 * prefix of them).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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

// --- External dep mocks. Hoisted by vitest. ----------------------

const mockGetUserByEmail = vi.fn();
const mockGetAccountActionByToken = vi.fn();
const mockConsumeAccountAction = vi.fn();
const mockIssueAccountAction = vi.fn();
const mockUpdateAccountActionDeliveryStatus = vi.fn(async () => undefined);
const mockFallbackSend = vi.fn(async () => true);
const mockGetOrganization = vi.fn(async () => null);

vi.mock('../../server/storage', () => ({
  storage: {
    getUserByEmail: (...a: unknown[]) =>
      mockGetUserByEmail.apply(null, a as never),
    getAccountActionByToken: (...a: unknown[]) =>
      mockGetAccountActionByToken.apply(null, a as never),
    consumeAccountActionAndSetPassword: (...a: unknown[]) =>
      mockConsumeAccountAction.apply(null, a as never),
    issueAccountAction: (...a: unknown[]) =>
      mockIssueAccountAction.apply(null, a as never),
    updateAccountActionDeliveryStatus: (...a: unknown[]) =>
      mockUpdateAccountActionDeliveryStatus.apply(null, a as never),
    getOrganization: (...a: unknown[]) =>
      mockGetOrganization.apply(null, a as never),
    // Defensively stub the surfaces auth.ts also touches in success
    // branches we don't drive here, so an accidental reachable path
    // can't blow up with a TypeError that masks the real assertion.
    createUser: vi.fn(async () => ({ id: 1, email: 'x@y.z', name: 'x' })),
    getBowlerByEmail: vi.fn(async () => null),
    getBowlerByEmailSystemAdmin: vi.fn(async () => null),
    isBowlerLinked: vi.fn(async () => false),
    linkUserToBowler: vi.fn(async () => undefined),
    getBowlerLeagues: vi.fn(async () => []),
    getLeague: vi.fn(async () => null),
    setUserOrganization: vi.fn(async () => undefined),
    updateUser: vi.fn(async () => undefined),
    clearUserInviteToken: vi.fn(async () => undefined),
    invalidatePendingEmailChangeRequestsForUser: vi.fn(async () => 0),
    getBowler: vi.fn(async () => null),
    updateBowler: vi.fn(async () => undefined),
    getUser: vi.fn(async () => null),
  },
}));

vi.mock('../../server/storage/account-action-requests.js', () => ({
  withAccountActionDeliveryLock: async (
    _userId: number,
    _action: string,
    operation: () => Promise<unknown>,
  ) => operation(),
}));

vi.mock('../../server/services/identity-link.js', () => ({
  linkUserToBowler: vi.fn(async () => ({ user: null, bowler: null, oldBowler: null, event: null })),
  isIdentityLinkError: () => false,
}));

const mockSendTemplatedEmail = vi.fn(async () => true);
const mockSendPasswordChangedNotification = vi.fn(async () => true);

vi.mock('../../server/services/email', () => ({
  sendTemplatedEmail: (...a: unknown[]) =>
    mockSendTemplatedEmail.apply(null, a as never),
  sendPasswordChangedNotification: (...a: unknown[]) =>
    mockSendPasswordChangedNotification.apply(null, a as never),
  getBaseUrl: () => 'https://test.example',
  // Used by some success branches we don't drive but defensively stubbed.
  sendPasswordResetFallbackEmail: (...a: unknown[]) => mockFallbackSend.apply(null, a as never),
  // Pulled in transitively via bowler-resync → square-provider →
  // square-catalog-cap-alerts. We don't drive this branch in this
  // test; defensive stub keeps the module graph resolvable.
  sendSquareCatalogCapAlert: vi.fn(async () => undefined),
}));

vi.mock('../../server/services/email.js', () => ({
  sendTemplatedEmail: (...a: unknown[]) =>
    mockSendTemplatedEmail.apply(null, a as never),
  sendPasswordChangedNotification: (...a: unknown[]) =>
    mockSendPasswordChangedNotification.apply(null, a as never),
  getBaseUrl: () => 'https://test.example',
  sendPasswordResetFallbackEmail: (...a: unknown[]) => mockFallbackSend.apply(null, a as never),
  sendSquareCatalogCapAlert: vi.fn(async () => undefined),
}));

vi.mock('../../server/auth', () => ({
  destroyOtherSessionsForUser: vi.fn(async () => 0),
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  safeTokenCompare: (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' && a === b,
}));

vi.mock('../../server/middleware/subdomain', () => ({
  checkUserBelongsToOrg: vi.fn(async () => true),
}));

vi.mock('../../server/middleware/csrf', () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Bypass rate limiters — rate-limit behaviour is covered elsewhere; we
// only care about the no-leak contract on the reject branches.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

// Stub passport so we can drive the LocalStrategy-failure paths
// without booting express-session. The handler in `routes/auth.ts`
// invokes the callback directly with `(err, user, info)`, so we
// shape `passport.authenticate` to call our handler with controllable
// inputs.
const passportAuthState: {
  err?: unknown;
  user?: Express.User | false;
  info?: { message?: string };
} = {};

vi.mock('passport', () => ({
  default: {
    authenticate:
      (_strategy: string, cb: (err: unknown, user: Express.User | false, info?: { message?: string }) => void) =>
      (_req: Request, _res: Response, _next: NextFunction) => {
        cb(passportAuthState.err, passportAuthState.user ?? false, passportAuthState.info);
      },
  },
}));

vi.mock('../../server/utils/rate-limit-store', () => ({
  createSharedRateLimitStore: () => undefined,
}));

vi.mock('../../server/config', () => ({
  isDev: true,
  env: {},
}));

// Now import the real router with all of its deps mocked.
const { registerAuthRoutes } = await import('../../server/routes/auth');

// --- Test express app harness ------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Minimal session shim so any handler that reaches `req.session`
  // (e.g. `req.login`) doesn't crash. Since we drive only reject
  // branches plus a success path that's already mocked at the
  // strategy level, this is enough.
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {};
    (req as unknown as { login: (u: unknown, cb: (err: unknown) => void) => void }).login =
      (_u, cb) => cb(null);
    Object.defineProperty(req, 'ip', { value: '198.51.100.42', configurable: true });
    next();
  });
  registerAuthRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  captured.length = 0;
  passportAuthState.err = undefined;
  passportAuthState.user = false;
  passportAuthState.info = undefined;
  mockGetAccountActionByToken.mockReset();
  mockConsumeAccountAction.mockReset();
  mockIssueAccountAction.mockReset();
  mockUpdateAccountActionDeliveryStatus.mockClear();
  mockFallbackSend.mockReset();
  mockFallbackSend.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Known secret bytes ------------------------------------------

// 32-byte hex token (matches `randomBytes(32).toString('hex')`).
const RESET_TOKEN = 'ab12cd34ef56gh78ij90kl12mn34op56qr78st90uv12wx34yz56AB78CD90EF12';
// A second token with no bytes in common — drives the safeTokenCompare
// mismatch branch on set-password without false-positive overlap.
const STORED_TOKEN = '0123456789abcdef'.repeat(4);
const LOGIN_PASSWORD = 'CorrectHorseBatteryStaple-2026!';
const LOGIN_PASSWORD_2 = 'AnotherUniqueSecretPwForFlush-XYZ-2026';

function assertNoSecretLeak(extra: string[] = []) {
  sharedAssertNoTokenLeak(captured, {
    full: [RESET_TOKEN, STORED_TOKEN, LOGIN_PASSWORD, LOGIN_PASSWORD_2, ...extra],
  });
}

// ------------------------------------------------------------------
//                            login
// ------------------------------------------------------------------

describe('POST /api/auth/login does not leak the password to logs', () => {
  it('rejects bad credentials without leaking the password attempt', async () => {
    passportAuthState.user = false;
    passportAuthState.info = { message: 'Invalid email or password' };

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'who@vitest.local', password: LOGIN_PASSWORD }),
    });
    expect(res.status).toBe(401);
    assertNoSecretLeak();
  });

  it('does not leak the password attempt when the LocalStrategy throws', async () => {
    // The handler logs `log.error('Login error:', err)`. If a future
    // change ever passed `req.body` (or the password field) into that
    // error context, this assertion would catch the regression — even
    // though today the synthesized error has no token material.
    passportAuthState.err = new Error('synthetic strategy failure (no password inside)');

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'who@vitest.local', password: LOGIN_PASSWORD_2 }),
    });
    expect(res.status).toBe(500);
    assertNoSecretLeak();
  });
});

// ------------------------------------------------------------------
//                          set-password
// ------------------------------------------------------------------

describe('POST /api/auth/set-password does not leak the reset/invite token to logs', () => {
  it('rejects an unknown token without leaking the request token bytes', async () => {
    mockGetAccountActionByToken.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/api/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: RESET_TOKEN, password: 'NewSecurePw!2026XX' }),
    });
    expect(res.status).toBe(400);
    assertNoSecretLeak();
  });

  it('rejects a token that does not constant-time-match the stored hash without leaking either token', async () => {
    mockGetAccountActionByToken.mockResolvedValueOnce({
      request: {
        id: 7,
        action: 'password_reset',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      user: {
        id: 7,
        email: 'leak-test@vitest.local',
        name: 'Leak Test',
      },
    });

    const res = await fetch(`${baseUrl}/api/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: RESET_TOKEN, password: 'NewSecurePw!2026XX' }),
    });
    expect(res.status).toBe(400);
    assertNoSecretLeak();
  });

  it('rejects an expired token without leaking the request token bytes', async () => {
    mockGetAccountActionByToken.mockResolvedValueOnce({
      request: {
        id: 7,
        action: 'password_reset',
        status: 'expired',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      user: {
        id: 7,
        email: 'leak-test@vitest.local',
        name: 'Leak Test',
      },
    });

    const res = await fetch(`${baseUrl}/api/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: RESET_TOKEN, password: 'NewSecurePw!2026XX' }),
    });
    expect(res.status).toBe(400);
    assertNoSecretLeak();
  });

  it('rejects a missing token without leaking anything', async () => {
    const res = await fetch(`${baseUrl}/api/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'NewSecurePw!2026XX' }),
    });
    expect(res.status).toBe(400);
    assertNoSecretLeak();
  });

  it('does not leak the token even when the storage lookup throws', async () => {
    // Catch-branch: `log.error('Set password error:', error)`. The
    // synthesized error here intentionally does NOT include the
    // token, so the test pins a future contract violation (e.g.
    // adding `{ token }` to the error context) rather than the
    // current shape.
    mockGetAccountActionByToken.mockRejectedValueOnce(
      new Error('synthetic storage failure (no token inside)'),
    );

    const res = await fetch(`${baseUrl}/api/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: RESET_TOKEN, password: 'NewSecurePw!2026XX' }),
    });
    expect(res.status).toBe(500);
    assertNoSecretLeak();
  });
});

// ------------------------------------------------------------------
//                        forgot-password
// ------------------------------------------------------------------

describe('POST /api/auth/forgot-password does not leak the issued reset token to logs', () => {
  // The handler responds with the generic "if an account exists ..."
  // message immediately and runs the rest in the background. We
  // intercept the moment the token is generated by stubbing
  // `issueAccountAction` so we can reuse THAT exact value as the
  // "must not appear in logs" assertion target.
  let capturedToken: string | null = null;

  beforeEach(() => {
    capturedToken = null;
    mockIssueAccountAction.mockImplementation(async () => {
      capturedToken = RESET_TOKEN;
      return { request: { id: 1 }, token: RESET_TOKEN };
    });
  });

  it('does not include the issued token in any log line on the success path', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: 11,
      email: 'forgot-leak@vitest.local',
      name: 'Forgot Leak',
      password: 'hashed:something',
      organizationId: null,
    });

    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'forgot-leak@vitest.local' }),
    });
    expect(res.status).toBe(200);

    // Background work is fire-and-forget; flush a few microtasks so
    // any log line emitted from it lands in `captured` before we
    // assert.
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));

    // The token is the secret to pin against. There SHOULD be a
    // "Password reset email sent" info line — we just need it not to
    // include the token (today it includes only `userId` + `email`).
    expect(capturedToken).toBeTruthy();
    assertNoSecretLeak(capturedToken ? [capturedToken] : []);
  });

  it('does not include the issued token when the background email send throws', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: 12,
      email: 'forgot-bg-fail@vitest.local',
      name: 'Forgot BgFail',
      password: 'hashed:something',
      organizationId: null,
    });
    mockSendTemplatedEmail.mockResolvedValueOnce(false);
    // Force the fallback path to throw so the catch (which logs
    // `log.error('Failed to process forgot-password request:', bgError)`)
    // fires.
    mockFallbackSend.mockRejectedValueOnce(
      new Error('synthetic SMTP failure (no token inside)'),
    );

    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'forgot-bg-fail@vitest.local' }),
    });
    expect(res.status).toBe(200);

    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));

    expect(capturedToken).toBeTruthy();
    assertNoSecretLeak(capturedToken ? [capturedToken] : []);
  });

  it('records failed delivery after both the templated and fallback sends fail', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: 13,
      email: 'forgot-delivery-fail@vitest.local',
      name: 'Forgot Delivery Fail',
      password: 'hashed:something',
      organizationId: null,
    });
    mockIssueAccountAction.mockResolvedValueOnce({
      request: { id: 1301 },
      token: RESET_TOKEN,
    });
    mockSendTemplatedEmail.mockResolvedValueOnce(false);
    mockFallbackSend.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'forgot-delivery-fail@vitest.local' }),
    });
    expect(res.status).toBe(200);
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));

    expect(mockUpdateAccountActionDeliveryStatus).toHaveBeenCalledWith(1301, 'failed');
    assertNoSecretLeak([RESET_TOKEN]);
  });

  it('issues a fresh action on resend and records each successful delivery', async () => {
    mockGetUserByEmail.mockResolvedValue({
      id: 14,
      email: 'forgot-resend@vitest.local',
      name: 'Forgot Resend',
      password: 'hashed:something',
      organizationId: null,
    });
    mockIssueAccountAction
      .mockResolvedValueOnce({ request: { id: 1401 }, token: RESET_TOKEN })
      .mockResolvedValueOnce({ request: { id: 1402 }, token: STORED_TOKEN });

    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'forgot-resend@vitest.local' }),
      });
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));

    expect(mockIssueAccountAction).toHaveBeenCalledTimes(2);
    expect(mockUpdateAccountActionDeliveryStatus).toHaveBeenCalledWith(1401, 'sent');
    expect(mockUpdateAccountActionDeliveryStatus).toHaveBeenCalledWith(1402, 'sent');
    assertNoSecretLeak([RESET_TOKEN, STORED_TOKEN]);
  });

  it('rejects a missing email without leaking anything', async () => {
    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    assertNoSecretLeak();
  });
});
