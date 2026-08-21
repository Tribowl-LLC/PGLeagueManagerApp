/**
 * Route-level unit test for the password-reset security email
 * (task #409). The forgot-password flow finishes at the
 * `/api/auth/set-password` token-consumer endpoint, so this is the
 * companion to `tests/unit/change-password-notification.test.ts` —
 * same `sendPasswordChangedNotification` helper, fired AFTER the
 * password row is persisted, with the request's IP / UA reflecting
 * THIS reset call (not the original change-password endpoint).
 *
 * Mounts the real `auth` router on an isolated express app with all
 * external deps mocked so we can deterministically assert the helper
 * is invoked on success and is NOT invoked on validation / token
 * failures.
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
import { expectErrorLog } from '../helpers/expected-error-logs';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const FUTURE_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST_EXPIRY = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const TEST_USER = {
  id: 7777,
  email: 'reset-notify@vitest.local',
  name: 'Reset Notify Tester',
  role: 'user' as const,
  organizationId: 11,
  bowlerId: null,
  password: 'hashed:original',
  preferredLanguage: null as string | null,
};

// --- Module mocks. Hoisted by vitest. ----------------------------

const mockSendPasswordChangedNotification = vi.fn(async () => true);
const mockSendTemplatedEmail = vi.fn(async () => true);

vi.mock('../../server/services/email.js', () => ({
  sendPasswordChangedNotification: (...a: unknown[]) =>
    mockSendPasswordChangedNotification.apply(null, a as never),
  sendTemplatedEmail: (...a: unknown[]) =>
    mockSendTemplatedEmail.apply(null, a as never),
  getBaseUrl: () => 'https://test.example',
  // Pulled in transitively via bowler-resync → square-provider →
  // square-catalog-cap-alerts. Defensive stub.
  sendSquareCatalogCapAlert: vi.fn(async () => undefined),
}));

const mockGetAccountActionByToken = vi.fn();
const mockConsumeAccountAction = vi.fn();
let currentActionUser = TEST_USER;
const mockGetBowlerByEmailSystemAdmin = vi.fn(async () => undefined);
const mockGetBowlerByEmail = vi.fn(async () => undefined);

vi.mock('../../server/storage', () => ({
  storage: {
    getAccountActionByToken: (...a: unknown[]) =>
      mockGetAccountActionByToken.apply(null, a as never),
    consumeAccountActionAndSetPassword: (...a: unknown[]) =>
      mockConsumeAccountAction.apply(null, a as never),
    getBowlerByEmail: (...a: unknown[]) => mockGetBowlerByEmail.apply(null, a as never),
    getBowlerByEmailSystemAdmin: (...a: unknown[]) =>
      mockGetBowlerByEmailSystemAdmin.apply(null, a as never),
  },
}));

vi.mock('../../server/services/identity-link.js', () => ({
  linkUserToBowler: vi.fn(async () => ({ user: null, bowler: null, oldBowler: null, event: null })),
  isIdentityLinkError: () => false,
}));

const mockHashPassword = vi.fn(async (pw: string) => `hashed:${pw}`);
const mockSafeTokenCompare = vi.fn(
  (a: string, b: string) => a === b,
);

vi.mock('../../server/lib/password', () => ({
  hashPassword: (...a: unknown[]) => mockHashPassword.apply(null, a as never),
  safeTokenCompare: (...a: unknown[]) =>
    mockSafeTokenCompare.apply(null, a as never),
}));

// Auth-route module also pulls in passport setup, subdomain middleware,
// CSRF, and config. Stub the parts that would need a real environment.
vi.mock('../../server/auth', () => ({
  setupAuth: () => undefined,
  destroyOtherSessionsForUser: vi.fn(async () => 0),
}));

vi.mock('../../server/middleware/subdomain', () => ({
  checkUserBelongsToOrg: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock('../../server/middleware/csrf', () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// `vi.mock` factories fully replace the real module — every symbol the
// transitively-imported real code reads has to be present here or
// vitest throws "No 'X' export is defined on the mock". Importing
// `server/routes/auth` pulls in the shared rate-limit store (#356)
// which reads `pool` from `server/db.ts` which reads `env.DATABASE_URL`
// from this module. The express-rate-limit mock further down means the
// pool is never actually queried during tests, so an empty `env`
// object is enough to satisfy the import-time access without a real
// connection string. Mirror this list with `confirm-email-change-no-
// token-leak.test.ts` and `auth-no-token-leak.test.ts` if you add more
// config symbols.
vi.mock('../../server/config', () => ({
  isDev: false,
  env: {},
}));

// Bypass the per-route rate limiter so we can hammer the same IP
// without tripping the 5/15min cap. Rate-limit behavior is covered
// elsewhere; this test only cares about the email-dispatch wiring.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

// --- Build the test harness. -------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { registerAuthRoutes } = await import('../../server/routes/auth');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '198.51.100.7', configurable: true });
    // Stand in for passport's `req.login(user, cb)` — the route calls
    // it after a successful set-password to auto-login the caller.
    (req as unknown as { login: (u: unknown, cb: (e: unknown) => void) => void }).login =
      (_u, cb) => cb(null);
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
  currentActionUser = TEST_USER;
  mockSendPasswordChangedNotification.mockClear();
  mockSendPasswordChangedNotification.mockResolvedValue(true);
  mockGetAccountActionByToken.mockReset();
  mockGetAccountActionByToken.mockResolvedValue({
    request: { id: 1, action: 'password_reset', status: 'pending', expiresAt: FUTURE_EXPIRY },
    user: { ...TEST_USER },
  });
  mockConsumeAccountAction.mockReset();
  mockConsumeAccountAction.mockImplementation(async (input: { preferredLanguage?: string | null }) => ({
    request: { id: 1, action: 'password_reset', status: 'consumed', expiresAt: FUTURE_EXPIRY },
    user: {
      ...currentActionUser,
      password: 'hashed:new',
      preferredLanguage: input.preferredLanguage === undefined
        ? currentActionUser.preferredLanguage
        : input.preferredLanguage,
    },
  }));
  mockGetBowlerByEmailSystemAdmin.mockClear();
  mockGetBowlerByEmailSystemAdmin.mockResolvedValue(undefined);
  mockGetBowlerByEmail.mockClear();
  mockGetBowlerByEmail.mockResolvedValue(undefined);
  mockHashPassword.mockClear();
  mockSafeTokenCompare.mockClear();
});

afterEach(() => vi.clearAllMocks());

async function flushFireAndForget() {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setImmediate(r));
  }
}

async function postSetPassword(body: unknown) {
  return fetch(`${baseUrl}/api/auth/set-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/set-password — password-changed email dispatch (task #409)', () => {
  it('invokes sendPasswordChangedNotification with the user email/name and request context after a successful reset', async () => {
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(200);

    await flushFireAndForget();

    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    const call = mockSendPasswordChangedNotification.mock.calls[0] as unknown as [
      string,
      string,
      {
        changedAt: Date;
        ipAddress: string | null;
        userAgent: string | null;
        locale?: string | null;
      },
    ];
    const [toEmail, name, ctx] = call;
    expect(toEmail).toBe(TEST_USER.email);
    expect(name).toBe(TEST_USER.name);
    expect(ctx.changedAt).toBeInstanceOf(Date);
    expect(ctx.ipAddress).toBe('198.51.100.7');
    expect(typeof ctx.userAgent === 'string' || ctx.userAgent === null).toBe(true);
    // task #410 — TEST_USER has no preferredLanguage column set, so
    // the route should forward `null` and the helper will fall back
    // to English. Pinning this guards against the route silently
    // dropping the field or sending undefined (which would also
    // English-fallback today, but masks future regressions).
    expect(ctx.locale).toBeNull();

    // Strict ordering: the password row must be persisted BEFORE we
    // dispatch the notice. Otherwise a crash between the two could
    // send a misleading "your password was just changed" email.
    const updateOrder = mockConsumeAccountAction.mock.invocationCallOrder[0];
    const notifyOrder =
      mockSendPasswordChangedNotification.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(notifyOrder);
  });

  it('does NOT invoke the helper when the token is missing', async () => {
    const res = await postSetPassword({ password: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(400);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockConsumeAccountAction).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the new password fails the strength check', async () => {
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'short',
    });
    expect(res.status).toBe(400);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockConsumeAccountAction).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the token is unknown', async () => {
    mockGetAccountActionByToken.mockResolvedValueOnce(undefined);
    const res = await postSetPassword({
      token: 'wrong-token',
      password: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(400);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockConsumeAccountAction).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the token is expired', async () => {
    mockGetAccountActionByToken.mockResolvedValueOnce({
      request: { id: 1, action: 'password_reset', status: 'expired', expiresAt: PAST_EXPIRY },
      user: { ...TEST_USER },
    });
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(400);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockConsumeAccountAction).not.toHaveBeenCalled();
  });

  it.each(['consumed', 'superseded', 'revoked'] as const)(
    'rejects a %s token as non-replayable without rotating the password',
    async (status) => {
      mockGetAccountActionByToken.mockResolvedValueOnce({
        request: { id: 1, action: 'password_reset', status, expiresAt: FUTURE_EXPIRY },
        user: { ...TEST_USER },
      });
      const res = await postSetPassword({
        token: 'valid-token-1234',
        password: 'BrandNewPw!2026XX',
      });
      expect(res.status).toBe(400);
      await flushFireAndForget();
      expect(mockConsumeAccountAction).not.toHaveBeenCalled();
      expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    },
  );

  it('still returns 200 when the email helper rejects (best-effort contract)', async () => {
    // The route logs the swallowed email failure at [ERROR] on purpose.
    expectErrorLog(/Password-changed notification threw \(set-password\)/);
    mockSendPasswordChangedNotification.mockRejectedValueOnce(
      new Error('SendGrid 503'),
    );
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(200);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    expect(mockConsumeAccountAction).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/set-password — preferred-language capture (task #420)', () => {
  it('persists the picker selection and uses it as the email locale on the same request', async () => {
    // Brand-new invited user: stored preferredLanguage is null
    // (TEST_USER fixture doesn't set it). The picker on the
    // set-password page sends "es" in the SAME request that sets
    // the password, and the route must:
    //   (a) write preferredLanguage='es' to the user row in the
    //       same updateUser call as the password (no extra round
    //       trip — pinned by the single-call assertion below)
    //   (b) forward 'es' as the locale on the password-changed
    //       email so the very first onboarding mail renders in
    //       the chosen language, not the default English
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
      preferredLanguage: 'es',
    });
    expect(res.status).toBe(200);
    await flushFireAndForget();

    // (a) — both fields land in one updateUser call. Two calls
    // would let a crash between them leave the password rotated
    // but the language column stale.
    expect(mockConsumeAccountAction).toHaveBeenCalledTimes(1);
    const [resetInput] = mockConsumeAccountAction.mock.calls[0] as unknown as [{
      passwordHash: string;
      preferredLanguage?: string | null;
    }];
    expect(resetInput.passwordHash).toMatch(/^hashed:/);
    expect(resetInput.preferredLanguage).toBe('es');

    // (b) — the email helper sees the JUST-submitted locale, not
    // the (null) value the user row was loaded with before the
    // update.
    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    const [, , ctx] = mockSendPasswordChangedNotification.mock.calls[0] as unknown as [
      string,
      string,
      { locale?: string | null },
    ];
    expect(ctx.locale).toBe('es');
  });

  it('treats null preferredLanguage as "auto" — clears the column and sends a null locale', async () => {
    // The default picker selection on the set-password page is
    // AUTO, which the client maps to null on the wire. The route
    // must persist that null (so a previously-set language can be
    // un-set on reset) and forward null to the email helper so it
    // English-falls-back instead of using the now-cleared value.
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
      preferredLanguage: null,
    });
    expect(res.status).toBe(200);
    await flushFireAndForget();

    const [resetInput] = mockConsumeAccountAction.mock.calls[0] as unknown as [{
      preferredLanguage?: string | null;
    }];
    expect(resetInput.preferredLanguage).toBeNull();

    const [, , ctx] = mockSendPasswordChangedNotification.mock.calls[0] as unknown as [
      string,
      string,
      { locale?: string | null },
    ];
    expect(ctx.locale).toBeNull();
  });

  it('rejects an unsupported locale code with a 400 — no DB write, no email', async () => {
    // Defense-in-depth: a hand-crafted POST with preferredLanguage='fr'
    // (or any value outside the bundled translations) must NOT be
    // silently persisted. Otherwise the email helper would
    // English-fallback every send for that user with no signal
    // anything went wrong, and the column would slowly accumulate
    // garbage codes that #417 was specifically designed to prevent.
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
      preferredLanguage: 'fr',
    });
    expect(res.status).toBe(400);
    await flushFireAndForget();

    expect(mockConsumeAccountAction).not.toHaveBeenCalled();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
  });

  it('leaves the language column untouched when the body omits preferredLanguage (legacy clients)', async () => {
    // Older clients that haven't been redeployed will keep posting
    // just { token, password }. The route must NOT clobber a
    // previously-set preferredLanguage with null on those calls
    // — only an explicit null in the body means "clear it". Pin
    // by asserting updateUser is called WITHOUT a preferredLanguage
    // key at all (vs. preferredLanguage: undefined, which Drizzle
    // would also skip but is easy to regress into preferredLanguage:
    // null on a future refactor).
    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(200);
    await flushFireAndForget();

    expect(mockConsumeAccountAction).toHaveBeenCalledTimes(1);
    const [resetInput] = mockConsumeAccountAction.mock.calls[0] as unknown as [{
      preferredLanguage?: unknown;
    }];
    expect('preferredLanguage' in resetInput).toBe(false);
  });

  it('falls back to the user row\'s stored language when the body omits preferredLanguage', async () => {
    // Forgot-password reset path: an existing user with a stored
    // language ('es') clicks the reset link in their email. The
    // page may not surface the picker at all on a re-reset, so
    // the body omits preferredLanguage. The notice email must
    // still render in their stored language — NOT silently
    // English-fallback because the body didn't carry the field.
    mockGetAccountActionByToken.mockResolvedValueOnce({
      request: { id: 1, action: 'password_reset', status: 'pending', expiresAt: FUTURE_EXPIRY },
      user: { ...TEST_USER, preferredLanguage: 'es' },
    });
    currentActionUser = { ...TEST_USER, preferredLanguage: 'es' };

    const res = await postSetPassword({
      token: 'valid-token-1234',
      password: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(200);
    await flushFireAndForget();

    const [, , ctx] = mockSendPasswordChangedNotification.mock.calls[0] as unknown as [
      string,
      string,
      { locale?: string | null },
    ];
    expect(ctx.locale).toBe('es');
  });
});
