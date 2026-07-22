/**
 * Route-level unit tests for the two payment-sync retry endpoints
 * exposed by `server/routes/account.ts` (task #364).
 *
 * Both routes drive the same `syncBowlerForUser` worker; the
 * difference is who is allowed to call them and whose bowler row
 * gets retried:
 *
 *   - POST /api/account/bowlers/:id/retry-payment-sync   (admin)
 *       requireAuth + requireSystemAdmin, retries the bowler named
 *       in the URL.
 *   - POST /api/account/profile/retry-payment-sync       (self-serve, #323)
 *       requireAuth only, retries `req.user.bowlerId` and IGNORES
 *       any client-supplied bowler id — this test pins that contract
 *       so a future refactor can't accidentally honor a body-param
 *       and let one user trigger a sync on someone else's bowler.
 *
 * Mounts the real `account` router on an isolated express app with
 * `storage` + `syncBowlerForUser` mocked, mirroring the harness used
 * by tests/unit/auth-user-payment-sync-status.test.ts. No real DB,
 * Square or the email service is contacted.
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

const SYSTEM_ADMIN_USER = {
  id: 5001,
  email: 'sysadmin@vitest.local',
  name: 'System Admin',
  role: 'system_admin' as const,
  organizationId: null,
  locationId: null,
  bowlerId: null,
  phone: null,
  preferredLanguage: null,
  avatar: null,
  password: 'hashed:irrelevant',
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const PLAIN_USER_LINKED = {
  ...SYSTEM_ADMIN_USER,
  id: 5002,
  email: 'user@vitest.local',
  name: 'Linked User',
  role: 'user' as const,
  organizationId: 12,
  locationId: 7,
  bowlerId: 777,
};

const PLAIN_USER_UNLINKED = {
  ...PLAIN_USER_LINKED,
  id: 5003,
  email: 'unlinked@vitest.local',
  bowlerId: null,
};

// --- Module mocks. Hoisted by vitest. ----------------------------

const mockGetBowler = vi.fn();
const mockGetUserByBowlerId = vi.fn();

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: (...a: unknown[]) => mockGetBowler.apply(null, a as never),
    getUserByBowlerId: (...a: unknown[]) =>
      mockGetUserByBowlerId.apply(null, a as never),
    // Other storage methods that account.ts touches at module load
    // / in unrelated handlers — stubbed so the import graph resolves
    // and any accidental call surfaces as a clear "not a function".
    getEmailChangeRequestByTokenHash: vi.fn(),
    consumeEmailChangeRequest: vi.fn(),
  },
}));

const mockSyncBowlerForUser = vi.fn();

vi.mock('../../server/services/payment-customer-sync', async () => {
  const actual = await vi.importActual<
    typeof import('../../server/services/payment-customer-sync')
  >('../../server/services/payment-customer-sync');
  return {
    ...actual,
    syncBowlerForUser: (...a: unknown[]) =>
      mockSyncBowlerForUser.apply(null, a as never),
  };
});

vi.mock('../../server/auth', () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  destroyOtherSessionsForUser: vi.fn(async () => 0),
}));

vi.mock('../../server/services/email', () => ({
  sendDeletionRequestNotification: vi.fn(async () => true),
  sendEmailChangeConfirmation: vi.fn(async () => true),
  sendEmailChangeNotification: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  sendSquareCatalogCapAlert: vi.fn(async () => true),
  getBaseUrl: () => 'https://test.example',
}));

vi.mock('../../server/db', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../server/storage/admin-email-change-audits', () => ({
  recordAdminEmailChangeAudit: vi.fn(async () => undefined),
}));

vi.mock('../../server/utils/rate-limit-store', () => ({
  // Returning undefined falls back to express-rate-limit's in-memory
  // store, which is fine for unit tests since we also bypass the
  // limiter entirely below.
  createSharedRateLimitStore: () => undefined,
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock('../../server/config', () => ({
  isDev: false,
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(64),
    DATABASE_URL: 'postgres://test/test',
    APP_BASE_URL: 'https://test.example',
  },
}));

// --- Build the test harness. -------------------------------------

let server: Server;
let baseUrl: string;
type TestUser = typeof SYSTEM_ADMIN_USER | typeof PLAIN_USER_LINKED | typeof PLAIN_USER_UNLINKED;
let nextAuthState: { isAuthenticated: boolean; user: TestUser | null } = {
  isAuthenticated: false,
  user: null,
};

beforeAll(async () => {
  const accountRouter = (await import('../../server/routes/account')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '198.51.100.7', configurable: true });
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () =>
      nextAuthState.isAuthenticated;
    (req as unknown as { user: unknown }).user = nextAuthState.user;
    (req as unknown as { sessionID: string }).sessionID = 'test-session';
    (req as unknown as { session: unknown }).session = {};
    next();
  });
  app.use('/api/account', accountRouter);
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
  mockGetUserByBowlerId.mockReset();
  mockSyncBowlerForUser.mockReset();
  nextAuthState = { isAuthenticated: false, user: null };
});

afterEach(() => vi.clearAllMocks());

async function post(
  path: string,
  body: unknown = {},
): Promise<{
  status: number;
  body: { success: boolean; data?: { paymentSyncStatus?: string }; error?: { code?: string; message?: string } };
}> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// --- Tests --------------------------------------------------------

describe('POST /api/account/profile/retry-payment-sync (self-serve)', () => {
  it('returns 401 AUTH_REQUIRED when called unauthenticated and never invokes the sync worker', async () => {
    nextAuthState = { isAuthenticated: false, user: null };

    const { status, body } = await post('/api/account/profile/retry-payment-sync');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('AUTH_REQUIRED');
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
    expect(mockGetBowler).not.toHaveBeenCalled();
  });

  it('returns 422 NO_LINKED_BOWLER when the authenticated user has no bowlerId', async () => {
    nextAuthState = { isAuthenticated: true, user: PLAIN_USER_UNLINKED };

    const { status, body } = await post('/api/account/profile/retry-payment-sync');

    expect(status).toBe(422);
    expect(body.error?.code).toBe('NO_LINKED_BOWLER');
    // Worker must short-circuit before any storage / sync call so an
    // unlinked account can't probe for bowler existence.
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
    expect(mockGetBowler).not.toHaveBeenCalled();
  });

  it("returns 200 with the sync worker's status on the happy path", async () => {
    nextAuthState = { isAuthenticated: true, user: PLAIN_USER_LINKED };
    mockGetBowler.mockResolvedValue({
      id: PLAIN_USER_LINKED.bowlerId,
      name: 'Stale Bowler Name',
      email: 'stale@example.com',
      phone: '5555550000',
    });
    mockSyncBowlerForUser.mockResolvedValue('synced');

    const { status, body } = await post('/api/account/profile/retry-payment-sync');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.paymentSyncStatus).toBe('synced');
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(1);
  });

  it('always uses the bowler id from the session and IGNORES any client-supplied id', async () => {
    // Security regression guard: this route deliberately has no path
    // / body parameter for the bowler. Even if a malicious client
    // sends one, the server must call syncBowlerForUser with the
    // SESSION's bowlerId — never the attacker's value.
    nextAuthState = { isAuthenticated: true, user: PLAIN_USER_LINKED };
    mockGetBowler.mockResolvedValue({
      id: PLAIN_USER_LINKED.bowlerId,
      name: PLAIN_USER_LINKED.name,
      email: PLAIN_USER_LINKED.email,
      phone: null,
    });
    mockSyncBowlerForUser.mockResolvedValue('synced');

    const ATTACKER_TARGET = 999_999;
    await post('/api/account/profile/retry-payment-sync', {
      bowlerId: ATTACKER_TARGET,
      id: ATTACKER_TARGET,
    });

    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(1);
    const [profile] = mockSyncBowlerForUser.mock.calls[0];
    expect(profile.bowlerId).toBe(PLAIN_USER_LINKED.bowlerId);
    expect(profile.bowlerId).not.toBe(ATTACKER_TARGET);
    expect(profile.id).toBe(PLAIN_USER_LINKED.id);
    expect(profile.id).not.toBe(ATTACKER_TARGET);
    // And the storage lookup must also be scoped to the session's
    // bowler — not the attacker's.
    expect(mockGetBowler).toHaveBeenCalledWith(PLAIN_USER_LINKED.bowlerId);
  });

  it('returns 404 NOT_FOUND when the linked bowler has been deleted out from under the session', async () => {
    nextAuthState = { isAuthenticated: true, user: PLAIN_USER_LINKED };
    mockGetBowler.mockResolvedValue(undefined);

    const { status, body } = await post('/api/account/profile/retry-payment-sync');

    expect(status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/account/bowlers/:id/retry-payment-sync (admin)', () => {
  it('returns 401 AUTH_REQUIRED when called unauthenticated', async () => {
    nextAuthState = { isAuthenticated: false, user: null };

    const { status, body } = await post('/api/account/bowlers/777/retry-payment-sync');

    expect(status).toBe(401);
    expect(body.error?.code).toBe('AUTH_REQUIRED');
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN for an authenticated user who is not a system admin', async () => {
    nextAuthState = { isAuthenticated: true, user: PLAIN_USER_LINKED };

    const { status, body } = await post('/api/account/bowlers/777/retry-payment-sync');

    expect(status).toBe(403);
    expect(body.error?.code).toBe('FORBIDDEN');
    // Authorization must fail-closed: no storage probe, no sync.
    expect(mockGetBowler).not.toHaveBeenCalled();
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });

  it('returns 422 NO_LINKED_USER when the targeted bowler has no linked user record', async () => {
    nextAuthState = { isAuthenticated: true, user: SYSTEM_ADMIN_USER };
    mockGetBowler.mockResolvedValue({
      id: 777,
      name: 'Orphan Bowler',
      email: 'orphan@example.com',
      phone: null,
    });
    mockGetUserByBowlerId.mockResolvedValue(undefined);

    const { status, body } = await post('/api/account/bowlers/777/retry-payment-sync');

    expect(status).toBe(422);
    expect(body.error?.code).toBe('NO_LINKED_USER');
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });

  it("returns 200 with the sync worker's status on the happy path for a system admin", async () => {
    nextAuthState = { isAuthenticated: true, user: SYSTEM_ADMIN_USER };
    mockGetBowler.mockResolvedValue({
      id: 777,
      name: 'Bowler Name',
      email: 'bowler@example.com',
      phone: '5555551111',
    });
    mockGetUserByBowlerId.mockResolvedValue(PLAIN_USER_LINKED);
    mockSyncBowlerForUser.mockResolvedValue('pending_retry');

    const { status, body } = await post('/api/account/bowlers/777/retry-payment-sync');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.paymentSyncStatus).toBe('pending_retry');
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(1);
    const [profile] = mockSyncBowlerForUser.mock.calls[0];
    // Source-of-truth is the linked user's profile, with the path-
    // param bowler id wired in.
    expect(profile.id).toBe(PLAIN_USER_LINKED.id);
    expect(profile.bowlerId).toBe(777);
    expect(profile.email).toBe(PLAIN_USER_LINKED.email);
  });

  it('returns 422 NO_EMAIL when the bowler and linked user both have no email (task #682)', async () => {
    nextAuthState = { isAuthenticated: true, user: SYSTEM_ADMIN_USER };
    mockGetBowler.mockResolvedValue({
      id: 777,
      name: 'Emailless Bowler',
      email: null,
      phone: null,
    });
    mockGetUserByBowlerId.mockResolvedValue({ ...PLAIN_USER_LINKED, email: null });

    const { status, body } = await post('/api/account/bowlers/777/retry-payment-sync');

    expect(status).toBe(422);
    expect(body.error?.code).toBe('NO_EMAIL');
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });

  it('runs the sync even when paymentSyncPendingAt is null (task #682)', async () => {
    nextAuthState = { isAuthenticated: true, user: SYSTEM_ADMIN_USER };
    mockGetBowler.mockResolvedValue({
      id: 777,
      name: 'Never-Flagged Bowler',
      email: 'never-flagged@example.com',
      phone: null,
      paymentCustomerId: null,
      paymentSyncPendingAt: null,
    });
    mockGetUserByBowlerId.mockResolvedValue(PLAIN_USER_LINKED);
    mockSyncBowlerForUser.mockResolvedValue('synced');

    const { status, body } = await post('/api/account/bowlers/777/retry-payment-sync');

    expect(status).toBe(200);
    expect(body.data?.paymentSyncStatus).toBe('synced');
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(1);
  });

  it('returns 400 INVALID_ID when the path param is not a number', async () => {
    nextAuthState = { isAuthenticated: true, user: SYSTEM_ADMIN_USER };

    const { status, body } = await post('/api/account/bowlers/not-a-number/retry-payment-sync');

    expect(status).toBe(400);
    expect(body.error?.code).toBe('INVALID_ID');
    expect(mockGetBowler).not.toHaveBeenCalled();
  });
});
