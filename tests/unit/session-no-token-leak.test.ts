/**
 * Regression test for task #396 — sibling of
 * `tests/unit/csrf-no-token-leak.test.ts` covering the session-bound
 * surfaces wired up by `setupAuth` in `server/auth.ts`:
 *
 *   - The express-session middleware (must not log SESSION_SECRET or
 *     the session cookie value)
 *   - passport.LocalStrategy verify   (handles the raw login password)
 *   - passport.serializeUser           (handles the session-bound user object)
 *   - passport.deserializeUser         (handles the session-bound user id)
 *
 * Same threat model as the CSRF test: an operator who flips
 * `LOG_LEVEL=debug` for an incident must not end up shipping live,
 * replayable session material — the SESSION_SECRET (every cookie
 * forever), the session ID (account access until expiry), or the
 * raw login password — to the production log sink.
 *
 * Strategy: mock `passport`, `passport-local`, `express-session`,
 * and `connect-pg-simple` so that calling `setupAuth(app)` registers
 * the strategy / serialize / deserialize callbacks against our
 * recorders. Then drive every reject branch with known secret bytes
 * and assert via the shared `assertNoTokenLeak` helper that no
 * captured log line contains those bytes (or an 8-byte prefix of
 * them).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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

// --- Hoisted fixtures so the vi.mock factories below can use them.

const { SESSION_SECRET, SESSION_COOKIE_VALUE } = vi.hoisted(() => ({
  // Same shape as the production secret: 64 hex chars (256 bits).
  SESSION_SECRET:
    'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
  // Same shape as `connect.sid` cookie: signed session ID.
  SESSION_COOKIE_VALUE:
    's%3AC0FFEEdeadbeefCAFEBABE-12345678.signedSignaturePartXYZ',
}));

// --- External dep mocks ------------------------------------------

// Capture-only mocks for passport so we can grab the LocalStrategy
// verify callback, serializeUser, deserializeUser callbacks that
// `setupAuth` registers.
const captured_strategy: { verify?: (email: string, pw: string, done: (...a: unknown[]) => void) => unknown } = {};
const captured_serialize: { fn?: (user: unknown, done: (...a: unknown[]) => void) => void } = {};
const captured_deserialize: { fn?: (id: number, done: (...a: unknown[]) => void) => void } = {};

vi.mock('passport-local', () => ({
  Strategy: class FakeStrategy {
    constructor(_opts: unknown, verify: typeof captured_strategy.verify) {
      captured_strategy.verify = verify;
    }
  },
}));

vi.mock('passport', () => ({
  default: {
    use: vi.fn(),
    initialize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    session: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    serializeUser: (fn: typeof captured_serialize.fn) => {
      captured_serialize.fn = fn;
    },
    deserializeUser: (fn: typeof captured_deserialize.fn) => {
      captured_deserialize.fn = fn;
    },
  },
}));

const sessionFactory = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
const captured_store_options: { value?: Record<string, unknown> } = {};
vi.mock('express-session', () => ({
  default: Object.assign(sessionFactory, { Store: class {} }),
}));

vi.mock('connect-pg-simple', () => ({
  default: () => class FakeStore {
    constructor(options: Record<string, unknown>) {
      captured_store_options.value = options;
    }
  },
}));

vi.mock('../../server/db', () => ({
  pool: {
    query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
  },
}));

const mockGetUserByEmail = vi.fn();
const mockGetUser = vi.fn();
vi.mock('../../server/storage', () => ({
  storage: {
    getUserByEmail: (...a: unknown[]) => mockGetUserByEmail.apply(null, a as never),
    getUser: (...a: unknown[]) => mockGetUser.apply(null, a as never),
  },
}));

// Bypass cacheFetch so we drive `storage.getUser` directly and can
// reason about exactly what the deserialize path sees.
vi.mock('../../server/utils/cache', () => ({
  cacheFetch: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../server/lib/password', () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  comparePasswords: vi.fn(async () => false),
  safeTokenCompare: (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' && a === b,
}));

vi.mock('../../server/config', () => ({
  isDev: true,
  // `setupAuth` reads `isDeployment` to decide whether to mark the
  // session cookie `secure` even when NODE_ENV !== 'production'
  // (Replit deployments terminate TLS at the proxy). This mock has
  // to mirror EVERY symbol the imported file consumes — vi.mock with
  // a factory is a full replacement, so an omitted export becomes a
  // hard "No 'isDeployment' export" runtime error rather than a
  // silent undefined. Pinned `false` here so the cookie path under
  // test stays the dev (non-secure) branch.
  isDeployment: false,
  env: {
    SESSION_SECRET,
    APP_DOMAIN: 'test.example',
    REPLIT_DEPLOYMENT: undefined,
    REPLIT_DOMAINS: undefined,
  },
}));

const { setupAuth } = await import('../../server/auth');

// --- Test harness ------------------------------------------------

beforeEach(async () => {
  captured.length = 0;
  captured_strategy.verify = undefined;
  captured_serialize.fn = undefined;
  captured_deserialize.fn = undefined;
  captured_store_options.value = undefined;
  sessionFactory.mockClear();
  // setupAuth is async (initDummyHash). Re-run before every test so
  // each test gets fresh callbacks against fresh recorders.
  await setupAuth({ set: () => undefined, use: () => undefined } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Known secret bytes ------------------------------------------

const LOGIN_PASSWORD = 'CorrectHorseBatteryStaple-2026!';
const LOGIN_PASSWORD_2 = 'AnotherUniqueSecretPwForFlush-XYZ-2026';

function assertNoSessionLeak(extra: string[] = []) {
  sharedAssertNoTokenLeak(captured, {
    full: [
      SESSION_SECRET,
      SESSION_COOKIE_VALUE,
      LOGIN_PASSWORD,
      LOGIN_PASSWORD_2,
      ...extra,
    ],
  });
}

function done<T = unknown>() {
  let resolve!: (v: T[]) => void;
  const promise = new Promise<T[]>(r => {
    resolve = r;
  });
  const cb = (...args: T[]) => resolve(args);
  return { cb, promise };
}

// ------------------------------------------------------------------
//                   express-session configuration
// ------------------------------------------------------------------

describe('setupAuth wires express-session without leaking SESSION_SECRET to logs', () => {
  it('does not log the SESSION_SECRET while setting up the session middleware', () => {
    // setupAuth ran in beforeEach. Just verify the recorder did not
    // see the secret anywhere — and that express-session was actually
    // configured with the secret value (i.e. the wire-up happened).
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    const opts = (sessionFactory.mock.calls[0] as unknown as [{ secret: string }])[0];
    expect(opts.secret).toBe(SESSION_SECRET);
    assertNoSessionLeak();
  });

  it('does not start a recurring database session-pruning timer', () => {
    expect(captured_store_options.value?.pruneSessionInterval).toBe(false);
  });
});

// ------------------------------------------------------------------
//                  LocalStrategy verify (login)
// ------------------------------------------------------------------

describe('LocalStrategy verify does not leak the login password to logs', () => {
  it('does not leak the password on the unknown-email branch', async () => {
    mockGetUserByEmail.mockResolvedValueOnce(null);
    expect(captured_strategy.verify).toBeDefined();

    const { cb, promise } = done();
    captured_strategy.verify!('who@vitest.local', LOGIN_PASSWORD, cb);
    const args = await promise;
    // (err, user, info)
    expect(args[0]).toBeNull();
    expect(args[1]).toBe(false);
    assertNoSessionLeak();
  });

  it('does not leak the password on the password-mismatch branch', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: 9,
      email: 'who@vitest.local',
      password: 'hashed:something-else',
      name: 'Who',
      role: 'user',
      createdAt: new Date(),
    });
    // comparePasswords already mocked to return false.

    const { cb, promise } = done();
    captured_strategy.verify!('who@vitest.local', LOGIN_PASSWORD_2, cb);
    const args = await promise;
    expect(args[0]).toBeNull();
    expect(args[1]).toBe(false);
    assertNoSessionLeak();
  });

  it('does not leak the password on the malformed-user-row branch', async () => {
    // Triggers `log.error('Invalid user object structure for ID:', { userId })`.
    mockGetUserByEmail.mockResolvedValueOnce({
      id: 13,
      // missing required fields → isValidUser=false
    });

    const { cb, promise } = done();
    captured_strategy.verify!('who@vitest.local', LOGIN_PASSWORD, cb);
    const args = await promise;
    expect(args[0]).toBeNull();
    expect(args[1]).toBe(false);
    // The error line MUST exist (proves we're hitting the branch),
    // and it MUST NOT contain the password.
    const errorLine = captured.find(l => l.level === 'error' && l.line.startsWith('Invalid user object structure'));
    expect(errorLine).toBeDefined();
    assertNoSessionLeak();
  });

  it('does not leak the password on the storage-throw catch path', async () => {
    // Triggers `log.error('Login error:', error)`. The synthesized
    // error intentionally does not embed the password — the test
    // pins a forward-looking contract against future changes that
    // try to attach `req.body` to error context.
    mockGetUserByEmail.mockRejectedValueOnce(
      new Error('synthetic storage failure (no password inside)'),
    );

    const { cb, promise } = done();
    captured_strategy.verify!('who@vitest.local', LOGIN_PASSWORD, cb);
    const args = await promise;
    expect(args[0]).toBeInstanceOf(Error);
    const errorLine = captured.find(l => l.level === 'error' && l.line.startsWith('Login error:'));
    expect(errorLine).toBeDefined();
    assertNoSessionLeak();
  });
});

// ------------------------------------------------------------------
//                       serializeUser
// ------------------------------------------------------------------

describe('passport.serializeUser does not leak session-bound material', () => {
  it('does not leak the password field of a malformed user object', async () => {
    expect(captured_serialize.fn).toBeDefined();

    // serializeUser is invoked by express-session every time a user
    // is logged in. A malformed object reaches the error branch and
    // returns `done(new Error(...))` — the error message must not
    // include the password.
    const { cb, promise } = done();
    captured_serialize.fn!(
      {
        id: 'not-a-number',
        password: LOGIN_PASSWORD,
      },
      cb,
    );
    const args = await promise;
    expect(args[0]).toBeInstanceOf(Error);
    expect((args[0] as Error).message).not.toContain(LOGIN_PASSWORD);
    assertNoSessionLeak();
  });
});

// ------------------------------------------------------------------
//                       deserializeUser
// ------------------------------------------------------------------

describe('passport.deserializeUser does not leak session-bound material', () => {
  it('does not leak anything on the user-not-found branch', async () => {
    mockGetUser.mockResolvedValueOnce(null);
    expect(captured_deserialize.fn).toBeDefined();

    const { cb, promise } = done();
    captured_deserialize.fn!(42, cb);
    const args = await promise;
    expect(args[0]).toBeNull();
    expect(args[1]).toBeNull();
    assertNoSessionLeak();
  });

  it('does not leak the deserialized user password on the storage-throw catch path', async () => {
    // Triggers `log.error('Deserialization error:', error)`. The
    // synthesized error intentionally does not embed any password,
    // session ID, or session cookie — the test pins a forward-looking
    // contract against future changes that attach the in-flight
    // session object to the error context.
    mockGetUser.mockRejectedValueOnce(
      new Error(
        'synthetic deserialize failure (no password / cookie / session id inside)',
      ),
    );

    const { cb, promise } = done();
    captured_deserialize.fn!(99, cb);
    const args = await promise;
    expect(args[0]).toBeInstanceOf(Error);
    const errorLine = captured.find(l => l.level === 'error' && l.line.startsWith('Deserialization error:'));
    expect(errorLine).toBeDefined();
    assertNoSessionLeak();
  });
});
