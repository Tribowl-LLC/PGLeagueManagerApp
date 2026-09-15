/**
 * Task #731 — focused security boundary tests for the three high-severity
 * auth/claim vulnerabilities:
 *
 *  1. POST /api/auth/register: trusted organization context and fail-closed gates
 *  2. POST /api/auth/claim-bowler: org membership + email ownership (incl. blank-email)
 *  3. POST /api/user-bowlers/link-bowler: org membership + email ownership (incl. blank-email)
 *
 * Negative cases — each test drives an attack scenario and asserts the
 * server refuses with the correct HTTP status and error code.
 */
import {
  afterAll,
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
import { storage } from '../../server/storage';
import { linkUserToBowler } from '../../server/services/identity-link.js';
import type { User } from '@shared/schema';

vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetBowler = vi.fn<(id: number) => Promise<unknown>>();
const mockIsBowlerLinked = vi.fn<(id: number) => Promise<boolean>>(async () => false);
const mockGetActiveOrganizations = vi.fn(async () => [{ id: 5, active: true }]);
const mockGetOrganization = vi.fn(async () => ({ id: 5, name: 'Test Org', active: true }));
const mockGetUserByEmail = vi.fn<(email: string) => Promise<null>>(async () => null);
const mockCreateUser = vi.fn(async () => ({
  id: 99,
  email: 'new@example.com',
  name: 'New User',
  phone: '5555555555',
  role: 'user' as const,
  organizationId: 5,
  bowlerId: null,
  credentialGeneration: 0,
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: (id: number) => mockGetBowler(id),
    isBowlerLinked: (id: number) => mockIsBowlerLinked(id),
    getUserByEmail: (email: string) => mockGetUserByEmail(email),
    createUser: (...args: unknown[]) => mockCreateUser(...args as []),
    getBowlerByEmail: vi.fn(async () => null),
    getBowlerByEmailSystemAdmin: vi.fn(async () => null),
    linkUserToBowler: vi.fn(async () => undefined),
    getBowlerLeagues: vi.fn(async () => []),
    getLeague: vi.fn(async () => null),
    setUserOrganization: vi.fn(async () => undefined),
    updateUser: vi.fn(async () => undefined),
    updateBowler: vi.fn(async () => undefined),
    getUser: vi.fn(async () => null),
    getOrganization: (...args: unknown[]) => mockGetOrganization(...args as []),
    getActiveOrganizations: () => mockGetActiveOrganizations(),
    clearUserInviteToken: vi.fn(async () => undefined),
    invalidatePendingEmailChangeRequestsForUser: vi.fn(async () => 0),
    setUserInviteToken: vi.fn(async () => undefined),
    getUserByInviteToken: vi.fn(async () => null),
    getLinkedBowlerIds: vi.fn(async () => []),
  },
}));

vi.mock('../../server/storage/account-action-delivery-jobs.js', () => ({
  enqueuePasswordResetDelivery: vi.fn(async () => ({ kind: 'enqueued', job: {} })),
  enqueueAccountRegistrationDelivery: vi.fn(async () => ({ kind: 'enqueued', job: {} })),
  resumePendingAccountRegistration: vi.fn(async () => undefined),
  getNextPasswordResetDeliveryAt: vi.fn(async () => null),
}));

vi.mock('../../server/db.js', () => ({
  db: {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
  },
}));

vi.mock('../../server/services/identity-link.js', () => ({
  linkUserToBowler: vi.fn(async () => ({ user: null, bowler: null, oldBowler: null, event: null })),
  isIdentityLinkError: () => false,
}));
vi.mock('../../server/services/identity-link', () => ({
  linkUserToBowler: vi.fn(async () => ({ user: null, bowler: null, oldBowler: null, event: null })),
  isIdentityLinkError: () => false,
}));

vi.mock('../../server/services/email', () => ({
  sendTemplatedEmail: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: () => 'https://test.example',
  getOrgLogoUrl: () => '',
  sendPasswordResetFallbackEmail: vi.fn(async () => true),
  sendSquareCatalogCapAlert: vi.fn(async () => undefined),
}));
vi.mock('../../server/services/email.js', () => ({
  sendTemplatedEmail: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: () => 'https://test.example',
  getOrgLogoUrl: () => '',
  sendPasswordResetFallbackEmail: vi.fn(async () => true),
}));
vi.mock('../../server/services/bowler-resync', () => ({
  fireBowlerExternalResync: vi.fn(),
  runBowlerExternalResync: vi.fn(async () => undefined),
}));
vi.mock('../../server/services/bowler-resync.js', () => ({
  fireBowlerExternalResync: vi.fn(),
  runBowlerExternalResync: vi.fn(async () => undefined),
}));
vi.mock('../../server/services/bowler-phone-sync.js', () => ({
  syncUserPhoneToBowler: vi.fn(async () => ({ outcome: 'skipped_no_user_phone' })),
}));
vi.mock('../../server/auth', () => ({
  destroyOtherSessionsForUser: vi.fn(async () => 0),
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  safeTokenCompare: () => true,
}));
vi.mock('../../server/lib/password', () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  safeTokenCompare: () => true,
}));
vi.mock('../../server/middleware/subdomain', () => ({
  checkUserBelongsToOrg: vi.fn(async () => true),
}));
vi.mock('../../server/middleware/csrf', () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));
vi.mock('passport', () => ({
  default: {
    authenticate: (..._args: unknown[]) =>
      (_req: Request, _res: Response, _next: NextFunction) => {},
    initialize: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    session: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  },
}));
vi.mock('../../server/utils/rate-limit-store', () => ({
  createSharedRateLimitStore: () => undefined,
}));
vi.mock('../../server/config', () => ({
  isDev: true,
  env: {},
}));

const { registerAuthRoutes } = await import('../../server/routes/auth');
const userBowlersRouter = (await import('../../server/routes/user-bowlers')).default;

let authServer: Server;
let userBowlersServer: Server;
let authBase: string;
let userBowlersBase: string;

const ORG_5 = { id: 5, name: 'Org Five' };

function makeAuthApp(subdomainOrg: unknown, sessionUser: unknown, orgSlug?: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      session: {},
      login: (_u: unknown, cb: (e: unknown) => void) => cb(null),
      isAuthenticated: () => Boolean(sessionUser),
      user: sessionUser,
      subdomainOrg,
      orgSlug,
    });
    Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true });
    next();
  });
  registerAuthRoutes(app);
  return app;
}

function makeUserBowlersApp(sessionUser: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      isAuthenticated: () => Boolean(sessionUser),
      user: sessionUser,
    });
    next();
  });
  app.use('/api/user-bowlers', userBowlersRouter);
  return app;
}

beforeAll(async () => {
  const [authApp, ubApp] = [
    makeAuthApp(ORG_5, { id: 1, email: 'attacker@example.com', role: 'user', organizationId: 5, bowlerId: null }),
    makeUserBowlersApp({ id: 1, email: 'attacker@example.com', role: 'user', organizationId: 5, bowlerId: null }),
  ];
  await Promise.all([
    new Promise<void>(resolve => {
      authServer = authApp.listen(0, '127.0.0.1', () => resolve());
    }),
    new Promise<void>(resolve => {
      userBowlersServer = ubApp.listen(0, '127.0.0.1', () => resolve());
    }),
  ]);
  authBase = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
  userBowlersBase = `http://127.0.0.1:${(userBowlersServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => authServer.close(e => e ? reject(e) : resolve())),
    new Promise<void>((resolve, reject) => userBowlersServer.close(e => e ? reject(e) : resolve())),
  ]);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBowlerLinked.mockResolvedValue(false);
  mockGetUserByEmail.mockResolvedValue(null);
  mockGetOrganization.mockResolvedValue({ id: 5, name: 'Test Org', active: true });
});

const REG_BASE = {
  email: 'attacker@example.com',
  password: 'CorrectHorseBatteryStaple-2026!',
  name: 'Attacker',
  phone: '555-101-0101',
  organizationId: 5,
};

// ---------------------------------------------------------------------------
// 1. Registration — trusted host tenant resolution
// ---------------------------------------------------------------------------

describe('POST /api/auth/register — tenant-resolution gate', () => {
  it('rejects registration on an unknown tenant host', async () => {
    const noSubdomainApp = makeAuthApp(null, null, 'unknown-org');
    const s = await new Promise<Server>(resolve => {
      const srv = noSubdomainApp.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(REG_BASE),
      });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error?.code).toBe('SIGNUP_UNAVAILABLE');
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });

  it('rejects when organizationId does not match the subdomain org', async () => {
    const mismatchApp = makeAuthApp({ id: 99, name: 'Other Org' }, null);
    const s = await new Promise<Server>(resolve => {
      const srv = mismatchApp.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(REG_BASE),
      });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error?.code).toBe('SIGNUP_UNAVAILABLE');
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });

  it('allows registration for an organization without requiring an active league', async () => {
    const res = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REG_BASE),
    });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('ignores spoofed organization and league IDs when resolving a tenant-hosted registration', async () => {
    const res = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...REG_BASE, organizationId: 99, leagueId: 11 }),
    });
    expect(res.status).toBe(202);
    expect(mockCreateUser).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 5 }), expect.anything());
  });

  it('fails closed on a canonical root with zero active organizations', async () => {
    mockGetActiveOrganizations.mockResolvedValueOnce([]);
    const rootApp = makeAuthApp(null, null);
    const s = await new Promise<Server>(resolve => {
      const srv = rootApp.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(REG_BASE),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error?.code).toBe('SIGNUP_UNAVAILABLE');
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });

  it('fails closed on a canonical root with multiple active organizations', async () => {
    mockGetActiveOrganizations.mockResolvedValueOnce([
      { id: 5, active: true },
      { id: 6, active: true },
    ]);
    const rootApp = makeAuthApp(null, null);
    const s = await new Promise<Server>(resolve => {
      const srv = rootApp.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(REG_BASE),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error?.code).toBe('SIGNUP_UNAVAILABLE');
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });
});

describe('GET /api/auth/registration/availability — tenant-resolution gate', () => {
  it('returns only an availability boolean for a known tenant host', async () => {
    const res = await fetch(`${authBase}/api/auth/registration/availability`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: { available: true } });
    expect(mockGetOrganization).toHaveBeenCalledWith(5);
  });

  it('returns unavailable without exposing organization details when the root is ambiguous', async () => {
    mockGetActiveOrganizations.mockResolvedValueOnce([
      { id: 5, active: true },
      { id: 6, active: true },
    ]);
    const rootApp = makeAuthApp(null, null);
    const s = await new Promise<Server>(resolve => {
      const srv = rootApp.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/auth/registration/availability`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ success: true, data: { available: false } });
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. claim-bowler — org gate and email ownership including blank-email
// ---------------------------------------------------------------------------

describe('POST /api/auth/claim-bowler — authorization boundaries', () => {
  const CLAIM_URL = () => `${authBase}/api/auth/claim-bowler`;

  it('rejects claim of bowler from a different org', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 20, name: 'Victim', email: 'victim@example.com',
      organizationId: 999,
    });
    const res = await fetch(CLAIM_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 20 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('rejects claim of blank-email bowler in the same org', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 21, name: 'NoEmail Bowler', email: '',
      organizationId: 5,
    });
    const res = await fetch(CLAIM_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 21 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('rejects claim of null-email bowler in the same org', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 22, name: 'NullEmail Bowler', email: null,
      organizationId: 5,
    });
    const res = await fetch(CLAIM_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 22 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('rejects claim of same-org bowler whose email mismatches', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 23, name: 'Other Person', email: 'otherperson@example.com',
      organizationId: 5,
    });
    const res = await fetch(CLAIM_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 23 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('allows an authorized same-org matching-email claim without rewriting the bowler after the link', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 24,
      name: 'Claimed Bowler',
      email: 'attacker@example.com',
      phone: '555-202-0202',
      organizationId: 5,
    });
    // The identity-link transaction commits the contact transfer and sets
    // the user's bowlerId, so the route's final getUser read must return
    // the linked ordinary user for sanitizeUser to succeed.
    const linkedUser: User = {
      id: 1,
      email: 'attacker@example.com',
      password: 'hashed:fixture-password',
      credentialGeneration: 0,
      bowlerId: 24,
      name: 'Attacker',
      phone: '555-101-0101',
      avatar: null,
      role: 'user',
      organizationId: 5,
      locationId: null,
      preferredLanguage: null,
      failedPasswordChangeAttempts: 0,
      passwordChangeLockedUntil: null,
      mustChangePassword: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(storage.getUser).mockResolvedValueOnce(linkedUser);

    const res = await fetch(CLAIM_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 24 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.bowlerId).toBe(24);
    expect(linkUserToBowler).toHaveBeenCalledWith({
      organizationId: 5,
      userId: 1,
      bowlerId: 24,
      actorUserId: 1,
      source: 'auth.claim-bowler',
      reason: 'email_ownership_claim',
      eventType: 'link',
      requireEmailMatch: true,
    });
    // The contact transfer is committed by the identity-link transaction;
    // a stale whole-record updateBowler after the link would clobber the
    // freshly transferred phone, so the route must not write the bowler.
    expect(storage.updateBowler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. link-bowler — org gate and email ownership including blank-email
// ---------------------------------------------------------------------------

describe('POST /api/user-bowlers/link-bowler — authorization boundaries', () => {
  const LINK_URL = () => `${userBowlersBase}/api/user-bowlers/link-bowler`;

  it('rejects link to bowler from a different org', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 30, name: 'Victim', email: 'victim@example.com',
      organizationId: 999,
    });
    const res = await fetch(LINK_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 30 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('rejects link to blank-email bowler in the same org', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 31, name: 'NoEmail Bowler', email: '',
      organizationId: 5,
    });
    const res = await fetch(LINK_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 31 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('rejects link to same-org bowler whose email mismatches', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 32, name: 'Other Person', email: 'otherperson@example.com',
      organizationId: 5,
    });
    const res = await fetch(LINK_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 32 }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.code).toBe('FORBIDDEN');
  });

  it('rejects link to already-linked same-email bowler', async () => {
    mockGetBowler.mockResolvedValueOnce({
      id: 33, name: 'Linked Bowler', email: 'attacker@example.com',
      organizationId: 5,
    });
    mockIsBowlerLinked.mockResolvedValueOnce(true);
    const res = await fetch(LINK_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bowlerId: 33 }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error?.code).toBe('ALREADY_LINKED');
  });

  it('rejects a payment-manager account before reading the target bowler', async () => {
    const staffApp = makeUserBowlersApp({
      id: 2,
      email: 'staff@example.com',
      role: 'payment_manager',
      organizationId: 5,
      locationId: 7,
      bowlerId: null,
    });
    const server = await new Promise<Server>((resolve) => {
      const started = staffApp.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/api/user-bowlers/link-bowler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bowlerId: 33 }),
      });
      expect(response.status).toBe(403);
      expect(mockGetBowler).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
