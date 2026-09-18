/**
 * Route-level throttle test for the payment-sync retry endpoints.
 *
 * Two budgets are exercised here:
 *   - the SELF-SERVE limiter (#365) on `POST /api/account/profile/
 *     retry-payment-sync` — keyed on the authenticated user id with
 *     IP fallback; 5/min cap; runs BEFORE `requireAuth` so unauth
 *     bursts are throttled too.
 *   - the ADMIN limiter (#440) on `POST /api/account/bowlers/:id/
 *     retry-payment-sync` — keyed on the **target bowler id** from
 *     the URL; 10/min cap; runs AFTER `requireAuth` +
 *     `requireSystemAdmin` so an unauth attacker can't pile hits
 *     onto an arbitrary bowler-id bucket.
 *
 * The companion suite tests/unit/retry-payment-sync-routes.test.ts
 * mocks `express-rate-limit` out of the way so it can exercise the
 * authz / contract cases without burning rate-limit budget. THIS
 * file deliberately does NOT mock the limiter — it loads the real
 * express-rate-limit middleware so we can prove that:
 *
 *   - the first 5 self-serve retry calls in a one-minute window
 *     succeed; the 6th call from the same authenticated user is
 *     rejected with 429 RATE_LIMITED via the standard sendError
 *     envelope
 *   - the first 10 admin retries against ONE target succeed; the
 *     11th is rejected with 429 RATE_LIMITED
 *   - bursting the admin endpoint across DIFFERENT targets from one
 *     admin does NOT trigger the limit (proves the keying is on
 *     bowler id, not admin user id)
 *   - the rate-limited request never reaches the sync worker (so the
 *     limiter is wired BEFORE the handler, not after)
 *
 * The shared-Postgres store is replaced with `undefined` so the
 * limiter falls back to express-rate-limit's in-memory store; this
 * gives us a fresh per-process budget that the test can fully
 * consume without contaminating other tests. Each test uses a
 * disjoint set of bucket keys (distinct user ids, IPs, or bowler
 * ids) so no test ever inherits a partially-spent bucket from a
 * sibling.
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
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const PLAIN_USER_LINKED = {
  id: 6101,
  email: 'throttle@vitest.local',
  name: 'Throttled User',
  role: 'user' as const,
  organizationId: 12,
  locationId: 7,
  bowlerId: 8801,
  phone: null,
  preferredLanguage: null,
  avatar: null,
  password: 'hashed:irrelevant',
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

// system_admin used by the #440 admin-route tests. The id is
// deliberately distinct from any bowler id we burst against so a
// future regression that swaps the limiter's keying back to
// `req.user.id` would NOT accidentally still pass — the test would
// now share a bucket per admin id rather than per bowler id and the
// cross-target burst would fail on call #11.
const ADMIN_USER = {
  id: 7001,
  email: 'admin@vitest.local',
  name: 'Admin User',
  role: 'system_admin' as const,
  organizationId: 12,
  locationId: 7,
  bowlerId: null,
  phone: null,
  preferredLanguage: null,
  avatar: null,
  password: 'hashed:irrelevant',
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

// --- Module mocks. Hoisted by vitest. ----------------------------
//
// IMPORTANT: we do NOT mock 'express-rate-limit' here — that is the
// whole point of this file.

const mockGetBowler = vi.fn();
const mockGetUserByBowlerId = vi.fn();
const mockSyncBowlerForUser = vi.fn();

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: (...a: unknown[]) => mockGetBowler.apply(null, a as never),
    getUserByBowlerId: (...a: unknown[]) =>
      mockGetUserByBowlerId.apply(null, a as never),
    getEmailChangeRequestByTokenHash: vi.fn(),
    consumeEmailChangeRequest: vi.fn(),
  },
}));

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
  db: { transaction: vi.fn(), select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../server/storage/admin-email-change-audits', () => ({
  recordAdminEmailChangeAudit: vi.fn(async () => undefined),
}));

// Force the limiter to fall back to express-rate-limit's in-memory
// store so the test gets a fresh, per-process budget. The real
// production wiring uses a shared Postgres store (task #356); that's
// covered by tests/unit/rate-limit-store.test.ts.
vi.mock('../../server/utils/rate-limit-store', () => ({
  createSharedRateLimitStore: () => undefined,
}));

vi.mock('../../server/config', () => ({
  isDev: false,
  isProdLike: false,
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
// Per-test auth + IP overrides. Each test owns a fresh process-wide
// limiter bucket because tests use distinct user ids / IPs (or the
// limiter's in-memory store is reset between cases via a fresh
// keyGenerator key) so cross-case pollution is avoided.
let nextAuthState: {
  isAuthenticated: boolean;
  user: typeof PLAIN_USER_LINKED | typeof ADMIN_USER | null;
} = {
  isAuthenticated: true,
  user: PLAIN_USER_LINKED,
};
let nextIp = '198.51.100.42';

beforeAll(async () => {
  const accountRouter = (await import('../../server/routes/account')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: nextIp, configurable: true });
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
  mockGetBowler.mockResolvedValue({
    id: PLAIN_USER_LINKED.bowlerId,
    name: PLAIN_USER_LINKED.name,
    email: PLAIN_USER_LINKED.email,
    phone: null,
  });
  mockSyncBowlerForUser.mockResolvedValue('synced');
  // Reset to authenticated default; individual tests override.
  nextAuthState = { isAuthenticated: true, user: PLAIN_USER_LINKED };
  nextIp = '198.51.100.42';
});

afterEach(() => vi.clearAllMocks());

async function postRetry() {
  const res = await fetch(`${baseUrl}/api/account/profile/retry-payment-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: await res.json() };
}

// --- Tests --------------------------------------------------------

describe('POST /api/account/profile/retry-payment-sync rate limit (#365)', () => {
  it('allows the first 5 retries in the window and rejects the 6th with 429 RATE_LIMITED', async () => {
    // Burn the budget exactly. The 5/min cap is intentionally tight
    // because every successful call hits the payment provider; if a
    // future change loosens or removes this guard, this test will
    // start failing on the 6th iteration with a 200 instead of 429.
    for (let i = 0; i < 5; i++) {
      const { status, body } = await postRetry();
      expect(status, `call #${i + 1} should still be within budget`).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.paymentSyncStatus).toBe('synced');
    }

    const { status, body } = await postRetry();
    expect(status).toBe(429);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('RATE_LIMITED');

    // Limiter must short-circuit BEFORE the handler runs — otherwise
    // the throttle wouldn't actually relieve pressure on the payment
    // provider, which is the whole point of #365.
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(5);
    expect(mockGetBowler).toHaveBeenCalledTimes(5);
  });

  it('throttles unauthenticated bursts on the IP fallback bucket — pinning the limiter-before-requireAuth ordering', async () => {
    // Use a fresh IP so this test gets its own bucket independent of
    // the authenticated-user test above. If the limiter were
    // accidentally moved AFTER requireAuth in a future refactor,
    // call #6 below would also return 401 (because requireAuth would
    // run first and short-circuit) instead of 429 — that's exactly
    // the regression this test is designed to catch.
    nextAuthState = { isAuthenticated: false, user: null };
    nextIp = '198.51.100.77';

    for (let i = 0; i < 5; i++) {
      const { status, body } = await postRetry();
      expect(status, `unauth call #${i + 1} should hit auth gate, not limiter`).toBe(401);
      expect(body.success).toBe(false);
      // The shape of the auth-required envelope isn't asserted in
      // detail here — the companion route-test file already pins it.
    }

    const { status, body } = await postRetry();
    expect(status).toBe(429);
    expect(body.error?.code).toBe('RATE_LIMITED');

    // Worker is never reached on any of the unauth calls (limiter
    // either lets requireAuth handle the rejection or rejects
    // outright on the 6th).
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
    expect(mockGetBowler).not.toHaveBeenCalled();
  });
});

async function postAdminRetry(targetBowlerId: number | string) {
  // Accept string here so the canonicalization regression test can
  // pass equivalent-but-non-canonical id forms (e.g. '09001').
  const res = await fetch(
    `${baseUrl}/api/account/bowlers/${targetBowlerId}/retry-payment-sync`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  return { status: res.status, body: await res.json() };
}

describe('POST /api/account/bowlers/:id/retry-payment-sync rate limit (#440)', () => {
  beforeEach(() => {
    // Promote the default authenticated user to system_admin so the
    // requireSystemAdmin gate (which sits in front of the limiter on
    // this route — see the comment block above the limiter in
    // server/routes/account.ts) lets requests through.
    nextAuthState = { isAuthenticated: true, user: ADMIN_USER };
    // The admin handler resolves the linked user from the bowler id
    // before calling the sync worker; return a plausible row so the
    // handler always reaches the worker on legit (non-throttled)
    // calls. The exact contents don't matter — only the presence of
    // a row matters for the throttling assertions.
    mockGetUserByBowlerId.mockResolvedValue(PLAIN_USER_LINKED);
  });

  it('allows the first 10 admin retries against one target and rejects the 11th with 429 RATE_LIMITED', async () => {
    // Distinct bowler id from any used in the cross-target test
    // below so the two tests cannot share a bucket regardless of
    // execution order.
    const TARGET = 9001;

    for (let i = 0; i < 10; i++) {
      const { status, body } = await postAdminRetry(TARGET);
      expect(
        status,
        `admin call #${i + 1} against bowler ${TARGET} should still be within budget`,
      ).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.paymentSyncStatus).toBe('synced');
    }

    const { status, body } = await postAdminRetry(TARGET);
    expect(status).toBe(429);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('RATE_LIMITED');

    // Limiter must short-circuit BEFORE the handler runs — otherwise
    // the throttle wouldn't actually relieve provider pressure on
    // the targeted user, which is the whole point of #440. Worker
    // count is exactly the number of allowed calls (10); the 11th
    // never reached the handler.
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(10);
    expect(mockGetBowler).toHaveBeenCalledTimes(10);
  });

  it('keys per target bowler id — bursting across different bowlers from one admin does NOT trigger the limit', async () => {
    // 11 calls from the SAME admin against 11 DISTINCT bowlers. If
    // the limiter were accidentally keyed on the admin's own user
    // id (a tempting bug — the self-serve limiter IS keyed on user
    // id, and the admin user id is the easiest thing to reach for
    // in keyGenerator) then call #11 would 429 because the admin
    // would have spent their per-key budget. With per-target
    // keying each bowler bucket only sees ONE hit, so every call
    // must succeed.
    //
    // The bowler-id range (9101-9111) is disjoint from the 9001
    // used in the single-target test above so this test can be run
    // in any order or in isolation without inheriting a partially-
    // spent bucket.
    for (let i = 0; i < 11; i++) {
      const targetBowlerId = 9101 + i;
      const { status, body } = await postAdminRetry(targetBowlerId);
      expect(
        status,
        `cross-target call #${i + 1} (bowler ${targetBowlerId}) must not be rate-limited`,
      ).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.paymentSyncStatus).toBe('synced');
    }

    // Every call reached the handler — no 429 short-circuits.
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(11);
    expect(mockGetBowler).toHaveBeenCalledTimes(11);
  });

  it('canonicalizes the limiter key — equivalent id forms (9201, 09201) share one bucket and the 11th combined call 429s', async () => {
    // Regression guard for the architect-flagged bypass: if the
    // limiter keyed off the raw `req.params.id` string instead of
    // the parsed numeric id the handler actually uses, an admin
    // could trivially defeat the per-target budget by alternating
    // the URL form. The handler treats '9201' and '09201' as the
    // same bowler (parseInt -> 9201) so the limiter MUST too.
    //
    // Uses bowler 9201 (disjoint from 9001 above and 9101..9111
    // below/above) so the bucket is fresh when this test runs.
    const variants: Array<string> = [
      '9201',
      '09201',
      '9201',
      '09201',
      '9201',
      '09201',
      '9201',
      '09201',
      '9201',
      '09201',
    ];

    for (let i = 0; i < variants.length; i++) {
      const { status, body } = await postAdminRetry(variants[i]!);
      expect(
        status,
        `combined call #${i + 1} (variant ${variants[i]}) should still be within shared budget`,
      ).toBe(200);
      expect(body.success).toBe(true);
    }

    // 11th combined call across the two equivalent forms must 429.
    // The variant chosen here ('9201abc') also parses to 9201 via
    // JavaScript's lenient parseInt, locking down a third bypass
    // path on the same regression.
    const { status, body } = await postAdminRetry('9201abc');
    expect(status).toBe(429);
    expect(body.error?.code).toBe('RATE_LIMITED');

    // Worker reached exactly 10 times across the equivalent forms;
    // the throttled 11th never reached the handler.
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(10);
  });
});

describe('POST /api/account/bowlers/:id/retry-payment-sync strict id parsing (#472)', () => {
  // The handler now requires a digit-only :id. Before #472, JavaScript's
  // lenient parseInt mapped '9301abc' -> 9301 and the handler silently
  // acted on bowler 9301 instead of returning a clean 400. These tests
  // pin the new contract.
  //
  // We use bowler ids in the 9301..9302 range here, deliberately disjoint
  // from the limiter tests above (9001 / 9101..9111 / 9201) so the
  // 10/min admin budget cannot 429 us before the strict guard fires.

  beforeEach(() => {
    nextAuthState = { isAuthenticated: true, user: ADMIN_USER };
    mockGetUserByBowlerId.mockResolvedValue(PLAIN_USER_LINKED);
  });

  it('rejects a typo\'d non-digit id with 400 INVALID_ID without invoking the bowler lookup or sync worker', async () => {
    const { status, body } = await postAdminRetry('9301abc');

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('INVALID_ID');

    // Critical: the strict guard ran BEFORE any storage / sync call.
    // If the guard were ever skipped or moved below `getBowler`, then
    // `getBowler(9301)` would have been invoked as if '9301abc' were
    // bowler 9301 — that is the exact silent-misroute regression #472
    // exists to prevent.
    expect(mockGetBowler).not.toHaveBeenCalled();
    expect(mockGetUserByBowlerId).not.toHaveBeenCalled();
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });

  it('still accepts canonical and leading-zero digit-only ids (regression guard against over-rejecting)', async () => {
    // Both forms parse to bowler 9302 and both pass /^\d+$/, so both
    // must reach the sync worker. If a future tightening of the
    // regex (say, banning leading zeros) lands without an intentional
    // contract change, this test will catch it.
    const { status: statusPlain } = await postAdminRetry('9302');
    expect(statusPlain).toBe(200);

    const { status: statusZero } = await postAdminRetry('09302');
    expect(statusZero).toBe(200);

    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(2);
  });
});
