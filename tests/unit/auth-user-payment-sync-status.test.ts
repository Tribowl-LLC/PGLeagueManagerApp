/**
 * Route-level unit test for the persistent payment-sync flag on
 * `/api/auth/user` (task #363). The route now augments its response
 * with a derived `paymentSyncStatus` so ProfileInfoCard's "Retry
 * payment sync" button can hydrate on first paint instead of
 * disappearing the moment a user closes the tab.
 *
 * Mounts the real `auth` router on an isolated express app with the
 * same external-deps-mocked harness used by
 * `set-password-notification.test.ts`. Stubs the storage layer so we
 * can pin three behaviors without touching a real DB:
 *
 *   1. Linked bowler with `paymentSyncPendingAt` set       -> 'pending_retry'
 *   2. Linked bowler with `paymentSyncPendingAt` cleared   -> null
 *   3. User with no linked bowler (`bowlerId === null`)    -> null
 *      (and the storage helper is NEVER called, so unlinked
 *      profile loads don't pay a bowler-row lookup cost)
 *   4. Storage throws on the bowler lookup                 -> null
 *      (graceful degradation — the rest of /api/user must
 *      still succeed; failing the whole request because we
 *      couldn't compute a UI hint would be worse than
 *      hiding the hint)
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

const TEST_USER_LINKED = {
  id: 8841,
  email: 'pending-sync@vitest.local',
  name: 'Pending Sync Tester',
  role: 'user' as const,
  organizationId: 12,
  locationId: null,
  bowlerId: 9911,
  preferredLanguage: null,
  avatar: null,
  phone: null,
  password: 'hashed:irrelevant',
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const TEST_USER_UNLINKED = {
  ...TEST_USER_LINKED,
  id: 8842,
  email: 'unlinked@vitest.local',
  bowlerId: null,
};

// --- Module mocks. Hoisted by vitest. ----------------------------

const mockGetBowler = vi.fn();
const mockGetUser = vi.fn();

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: (...a: unknown[]) => mockGetBowler.apply(null, a as never),
    getUser: (...a: unknown[]) => mockGetUser.apply(null, a as never),
  },
}));

vi.mock('../../server/auth', () => ({
  setupAuth: () => undefined,
  destroyOtherSessionsForUser: vi.fn(async () => 0),
}));

vi.mock('../../server/middleware/subdomain', () => ({
  checkUserBelongsToOrg: async () => true,
}));

vi.mock('../../server/middleware/csrf', () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// auth.ts only directly imports `isDev`, but transitive imports
// (security middleware, etc.) pull in `env` — mock both so the
// import graph resolves without trying to validate real env vars.
vi.mock('../../server/config', () => ({
  isDev: false,
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(64),
    DATABASE_URL: 'postgres://test/test',
    APP_BASE_URL: 'https://test.example',
  },
}));

// Bypass per-route rate limiters so ordering between cases doesn't
// trip a 5/15min cap on the shared 127.0.0.1 IP.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock('../../server/services/email.js', () => ({
  sendPasswordChangedNotification: vi.fn(async () => true),
  sendTemplatedEmail: vi.fn(async () => true),
  getBaseUrl: () => 'https://test.example',
  // Pulled in transitively via bowler-resync → square-provider →
  // square-catalog-cap-alerts. Defensive stub.
  sendSquareCatalogCapAlert: vi.fn(async () => undefined),
}));

// --- Build the test harness. -------------------------------------

let server: Server;
let baseUrl: string;
// The route reads `req.user` via passport; the auth middleware below
// flips a switch on each request so individual cases can pick which
// fixture to authenticate as (or stay unauthenticated).
let nextAuthState: { isAuthenticated: boolean; user: typeof TEST_USER_LINKED | typeof TEST_USER_UNLINKED | null } = {
  isAuthenticated: false,
  user: null,
};

beforeAll(async () => {
  const { registerAuthRoutes } = await import('../../server/routes/auth');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '198.51.100.42', configurable: true });
    // Stand in for passport's session helpers. We control authn state
    // per-request via the module-scoped `nextAuthState` switch.
    Object.defineProperty(req, 'isAuthenticated', {
      value: () => nextAuthState.isAuthenticated,
      configurable: true,
    });
    Object.defineProperty(req, 'user', {
      value: nextAuthState.user,
      configurable: true,
    });
    Object.defineProperty(req, 'logout', {
      value: (cb: (err?: unknown) => void) => {
        nextAuthState = { isAuthenticated: false, user: null };
        cb();
      },
      configurable: true,
    });
    Object.defineProperty(req, 'sessionID', {
      value: 'test-session',
      configurable: true,
    });
    Object.defineProperty(req, 'session', {
      value: {},
      configurable: true,
    });
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
  mockGetBowler.mockReset();
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(async () => nextAuthState.user ?? undefined);
  nextAuthState = { isAuthenticated: true, user: TEST_USER_LINKED };
});

afterEach(() => vi.clearAllMocks());

async function getUser(): Promise<{
  status: number;
  body: { success: boolean; data?: { paymentSyncStatus?: 'pending_retry' | null; bowlerId?: number | null } };
}> {
  const res = await fetch(`${baseUrl}/api/auth/user`);
  const body = await res.json();
  return { status: res.status, body };
}

// --- Tests --------------------------------------------------------

describe('/api/auth/user paymentSyncStatus hydration (#363)', () => {
  it("surfaces 'pending_retry' when the linked bowler has payment_sync_pending_at set", async () => {
    nextAuthState = { isAuthenticated: true, user: TEST_USER_LINKED };
    mockGetBowler.mockResolvedValue({
      id: TEST_USER_LINKED.bowlerId,
      paymentSyncPendingAt: '2026-04-25T00:00:00.000Z',
    });

    const { status, body } = await getUser();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.paymentSyncStatus).toBe('pending_retry');
    expect(mockGetBowler).toHaveBeenCalledTimes(1);
    expect(mockGetBowler).toHaveBeenCalledWith(TEST_USER_LINKED.bowlerId);
  });

  it('returns null when the linked bowler has no pending flag', async () => {
    nextAuthState = { isAuthenticated: true, user: TEST_USER_LINKED };
    mockGetBowler.mockResolvedValue({
      id: TEST_USER_LINKED.bowlerId,
      paymentSyncPendingAt: null,
    });

    const { status, body } = await getUser();

    expect(status).toBe(200);
    expect(body.data?.paymentSyncStatus).toBeNull();
    expect(mockGetBowler).toHaveBeenCalledTimes(1);
  });

  it('returns null AND skips the bowler lookup entirely for users without a linked bowler', async () => {
    nextAuthState = { isAuthenticated: true, user: TEST_USER_UNLINKED };

    const { status, body } = await getUser();

    expect(status).toBe(200);
    expect(body.data?.paymentSyncStatus).toBeNull();
    // Avoiding the lookup keeps unlinked profile loads cheap and
    // makes it impossible for an unrelated bowler-storage outage to
    // brown out /api/user for users who have no payment surface.
    expect(mockGetBowler).not.toHaveBeenCalled();
  });

  it('degrades gracefully to null when the bowler lookup throws', async () => {
    // The graceful-degradation branch logs the lookup failure at [ERROR] on purpose.
    expectErrorLog(/Failed to look up bowler for \/api\/user paymentSyncStatus/);
    nextAuthState = { isAuthenticated: true, user: TEST_USER_LINKED };
    mockGetBowler.mockRejectedValue(new Error('simulated DB outage'));

    const { status, body } = await getUser();

    // The whole request must STILL succeed — losing the retry hint
    // is acceptable, losing the user's identity payload is not.
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.paymentSyncStatus).toBeNull();
  });

  it('serializes the authoritative row when the session snapshot is stale', async () => {
    nextAuthState = { isAuthenticated: true, user: TEST_USER_UNLINKED };
    mockGetUser.mockResolvedValue(TEST_USER_LINKED);
    mockGetBowler.mockResolvedValue({ id: TEST_USER_LINKED.bowlerId, paymentSyncPendingAt: null });

    const { status, body } = await getUser();

    expect(status).toBe(200);
    expect(body.data?.bowlerId).toBe(TEST_USER_LINKED.bowlerId);
    expect(mockGetUser).toHaveBeenCalledWith(TEST_USER_UNLINKED.id);
  });

  it('rejects and logs out a session whose user row was deleted', async () => {
    nextAuthState = { isAuthenticated: true, user: TEST_USER_LINKED };
    mockGetUser.mockResolvedValue(undefined);

    const { status, body } = await getUser();

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(mockGetBowler).not.toHaveBeenCalled();
    expect(nextAuthState.isAuthenticated).toBe(false);
  });

  it('still returns 401 for unauthenticated callers (regression: paymentSyncStatus must not bypass auth)', async () => {
    nextAuthState = { isAuthenticated: false, user: null };

    const { status } = await getUser();

    expect(status).toBe(401);
    expect(mockGetBowler).not.toHaveBeenCalled();
  });
});
