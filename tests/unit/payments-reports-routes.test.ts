/**
 * Route-level tests for /api/payments LIST (task #339).
 *
 * Scope note: at the time of writing, `payment-reports.ts` exposes
 * exactly one endpoint — `GET /`. The task description also mentions
 * `GET /:id` and `GET /by-bowler/:id`, but `grep -n "router.get"`
 * confirms neither exists in `server/routes/payments/`; the only
 * `getPaymentById` callers are PATCH/DELETE/refund, already covered
 * by `payments-routes.test.ts`. If those routes are added later,
 * extend this file with the corresponding 200/404/403 cases.
 *
 * Companion to `payments-by-org.test.ts` (pins the in-memory filter
 * helper) and `payments-routes.test.ts` (pins create/update/delete/
 * refund). This file mounts the real reports router on an isolated
 * express app and drives it over real HTTP via `fetch`.
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
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mockStorage = {
  getLeague: vi.fn(),
  getPayments: vi.fn(),
  getPaymentsPaginated: vi.fn(),
  getAllPaymentsSystemAdmin: vi.fn(),
  getAllPaymentsPaginatedSystemAdmin: vi.fn(),
};

vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockRequireOrgAccess = vi.fn();
const mockHasAdminAccessToLeague = vi.fn();
// Keep the real pure role-check helpers (isSystemAdmin, isOrgOrHigher) and
// any other exports via importOriginal; hasAdminAccessToLeague
// usage to payment-reports so a bare partial mock drifts and throws.
vi.mock('../../server/utils/access-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/access-control')>();
  return {
    ...actual,
    requireOrganizationAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
    hasAdminAccessToLeague: (...a: unknown[]) => mockHasAdminAccessToLeague(...a),
  };
});

const paymentReportsRouter = (
  await import('../../server/routes/payments/payment-reports')
).default;

type TestRole = 'system_admin' | 'org_admin' | 'admin' | 'user';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as unknown as { user: unknown }).user = JSON.parse(raw);
    next();
  });
  app.use('/api/payments', paymentReportsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const fn of Object.values(mockStorage))
    (fn as ReturnType<typeof vi.fn>).mockReset();
  mockRequireOrgAccess.mockReset();
  mockRequireOrgAccess.mockReturnValue(true);
  mockHasAdminAccessToLeague.mockReset();
  mockHasAdminAccessToLeague.mockResolvedValue(true);
});

afterEach(() => vi.clearAllMocks());

function userHeader(user: {
  id: number;
  role: TestRole;
  organizationId: number | null;
  bowlerId?: number | null;
}) {
  return { 'x-test-user': JSON.stringify(user) };
}

const ORG_A_USER = { id: 7, role: 'org_admin' as TestRole, organizationId: 1, bowlerId: null };
const SYSADMIN = { id: 1, role: 'system_admin' as TestRole, organizationId: null, bowlerId: null };
const SYSADMIN_WITH_ORG = { id: 2, role: 'system_admin' as TestRole, organizationId: 5, bowlerId: null };

const ORG_A_LEAGUE = { id: 11, organizationId: 1, weeklyFee: 2000 };
const ORG_B_LEAGUE = { id: 22, organizationId: 2, weeklyFee: 1500 };

async function get(path: string, user?: object) {
  return fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: user ? userHeader(user as Parameters<typeof userHeader>[0]) : {},
  });
}

describe('GET /api/payments — caller scope', () => {
  it('returns an empty list for unauthenticated callers (200)', async () => {
    const res = await get('/api/payments');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
    expect(mockStorage.getAllPaymentsSystemAdmin).not.toHaveBeenCalled();
  });

  it('returns an empty list for a non-sysadmin user with no organizationId (200)', async () => {
    const noOrgUser = { id: 9, role: 'user' as TestRole, organizationId: null, bowlerId: null };
    const res = await get('/api/payments', noOrgUser);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('scopes an org user to their own organizationId', async () => {
    const rows = [{ id: 1, leagueId: ORG_A_LEAGUE.id }];
    mockStorage.getPayments.mockResolvedValue(rows);

    const res = await get('/api/payments', ORG_A_USER);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(rows);
    expect(mockStorage.getPayments).toHaveBeenCalledTimes(1);
    expect(mockStorage.getPayments.mock.calls[0][0]).toMatchObject({
      organizationId: 1,
    });
    expect(mockStorage.getAllPaymentsSystemAdmin).not.toHaveBeenCalled();
  });

  it('routes a sysadmin with no org context to the all-orgs storage path', async () => {
    const rows = [
      { id: 1, leagueId: ORG_A_LEAGUE.id },
      { id: 2, leagueId: ORG_B_LEAGUE.id },
    ];
    mockStorage.getAllPaymentsSystemAdmin.mockResolvedValue(rows);

    const res = await get('/api/payments', SYSADMIN);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(rows);
    expect(mockStorage.getAllPaymentsSystemAdmin).toHaveBeenCalledTimes(1);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('honors an explicit ?organizationId for a sysadmin (overrides their own org)', async () => {
    const rows = [{ id: 7, leagueId: ORG_B_LEAGUE.id }];
    mockStorage.getPayments.mockResolvedValue(rows);

    const res = await get('/api/payments?organizationId=2', SYSADMIN_WITH_ORG);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(rows);
    expect(mockStorage.getPayments.mock.calls[0][0]).toMatchObject({
      organizationId: 2,
    });
    expect(mockStorage.getAllPaymentsSystemAdmin).not.toHaveBeenCalled();
  });

  it('falls back to the sysadmin\'s own organizationId when no ?organizationId is given', async () => {
    const rows = [{ id: 9 }];
    mockStorage.getPayments.mockResolvedValue(rows);

    const res = await get('/api/payments', SYSADMIN_WITH_ORG);
    expect(res.status).toBe(200);
    expect(mockStorage.getPayments.mock.calls[0][0]).toMatchObject({
      organizationId: 5,
    });
    expect(mockStorage.getAllPaymentsSystemAdmin).not.toHaveBeenCalled();
  });

  it('ignores ?organizationId from a non-sysadmin (uses caller.orgId, never the param)', async () => {
    // Defense-in-depth: an org user must not be able to peek into
    // another org's payments by passing ?organizationId.
    mockStorage.getPayments.mockResolvedValue([]);

    const res = await get('/api/payments?organizationId=2', ORG_A_USER);
    expect(res.status).toBe(200);
    expect(mockStorage.getPayments.mock.calls[0][0]).toMatchObject({
      organizationId: 1,
    });
  });

  it('returns 400 for a non-numeric ?organizationId', async () => {
    const res = await get('/api/payments?organizationId=foo', SYSADMIN);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/organization/i);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
    expect(mockStorage.getAllPaymentsSystemAdmin).not.toHaveBeenCalled();
  });
});

describe('GET /api/payments — leagueId filter', () => {
  it('returns 404 when the requested league does not exist', async () => {
    mockStorage.getLeague.mockResolvedValue(undefined);

    const res = await get('/api/payments?leagueId=999', ORG_A_USER);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller has no access to the league\'s org', async () => {
    mockStorage.getLeague.mockResolvedValue(ORG_B_LEAGUE);
    // The leagueId filter gates on administrator access to the league.
    mockHasAdminAccessToLeague.mockResolvedValue(false);

    const res = await get('/api/payments?leagueId=22', ORG_A_USER);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('passes leagueId through to storage when access is granted', async () => {
    mockStorage.getLeague.mockResolvedValue(ORG_A_LEAGUE);
    mockStorage.getPayments.mockResolvedValue([{ id: 1, leagueId: 11 }]);

    const res = await get('/api/payments?leagueId=11', ORG_A_USER);
    expect(res.status).toBe(200);
    expect(mockStorage.getPayments.mock.calls[0][0]).toMatchObject({
      organizationId: 1,
      leagueId: 11,
    });
  });
});

describe('GET /api/payments — pagination', () => {
  it('routes org users to storage.getPaymentsPaginated when ?page is present', async () => {
    mockStorage.getPaymentsPaginated.mockResolvedValue({
      items: [{ id: 1 }],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    });

    const res = await get('/api/payments?page=2&limit=10', ORG_A_USER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: 1 }]);
    expect(body.pagination).toMatchObject({ page: 2, limit: 10, total: 21 });
    expect(mockStorage.getPaymentsPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 1 }),
      2,
      10,
    );
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('routes sysadmins (no org context) to getAllPaymentsPaginatedSystemAdmin when ?page is present', async () => {
    mockStorage.getAllPaymentsPaginatedSystemAdmin.mockResolvedValue({
      items: [{ id: 5 }],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
    });

    const res = await get('/api/payments?page=1&limit=25', SYSADMIN);
    expect(res.status).toBe(200);
    expect(mockStorage.getAllPaymentsPaginatedSystemAdmin).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      25,
    );
    expect(mockStorage.getAllPaymentsSystemAdmin).not.toHaveBeenCalled();
  });

  it('routes a sysadmin WITH an own organizationId to the scoped paginated path, not the all-orgs one', async () => {
    // Sysadmins bound to an org must page through the scoped
    // helper; otherwise pagination would leak other orgs' rows.
    mockStorage.getPaymentsPaginated.mockResolvedValue({
      items: [{ id: 1 }],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const res = await get('/api/payments?page=1&limit=10', SYSADMIN_WITH_ORG);
    expect(res.status).toBe(200);
    expect(mockStorage.getPaymentsPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 5 }),
      1,
      10,
    );
    expect(mockStorage.getAllPaymentsPaginatedSystemAdmin).not.toHaveBeenCalled();
  });

  it('returns empty for a no-org non-sysadmin even when pagination params are present', async () => {
    // ?page must not bypass the early empty-list short circuit.
    const noOrgUser = { id: 9, role: 'user' as TestRole, organizationId: null, bowlerId: null };
    const res = await get('/api/payments?page=1&limit=10', noOrgUser);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
    expect(mockStorage.getPaymentsPaginated).not.toHaveBeenCalled();
    expect(mockStorage.getAllPaymentsPaginatedSystemAdmin).not.toHaveBeenCalled();
  });

  it('caps ?limit at 100 (parsePaginationParams contract)', async () => {
    mockStorage.getPaymentsPaginated.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const res = await get('/api/payments?page=1&limit=9999', ORG_A_USER);
    expect(res.status).toBe(200);
    expect(mockStorage.getPaymentsPaginated).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      100,
    );
  });
});

describe('GET /api/payments — base filter passthrough', () => {
  it('forwards bowlerId, teamId, and weekOf to storage.getPayments', async () => {
    mockStorage.getPayments.mockResolvedValue([]);

    const res = await get(
      '/api/payments?bowlerId=42&teamId=7&weekOf=2026-01-05',
      ORG_A_USER,
    );
    expect(res.status).toBe(200);
    const filters = mockStorage.getPayments.mock.calls[0][0];
    expect(filters).toMatchObject({
      organizationId: 1,
      bowlerId: 42,
      teamId: 7,
    });
    expect(filters.weekOf).toBeInstanceOf(Date);
    expect((filters.weekOf as Date).toISOString().slice(0, 10)).toBe(
      '2026-01-05',
    );
  });
});

describe('GET /api/payments — malformed filter inputs', () => {
  // task #406: previously the route forwarded NaN / Invalid Date
  // straight to the storage layer for everything except
  // ?organizationId, producing confusing 500s and noisy DB error
  // logs. These tests now pin the tightened 400 contract.

  it('rejects a non-numeric ?leagueId with a 400 and never touches storage', async () => {
    const res = await get('/api/payments?leagueId=foo', ORG_A_USER);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    // The error message should call out which filter was bad so the
    // caller can fix their request without grepping logs.
    expect(body.error.message).toMatch(/league/i);
    // The route must short-circuit before any DB lookups — the
    // league access check should not fire (a NaN ID would otherwise
    // generate a low-value 404 in the logs) and no payments query
    // should run.
    expect(mockStorage.getLeague).not.toHaveBeenCalled();
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric ?bowlerId with a 400 (call-out which filter)', async () => {
    const res = await get('/api/payments?bowlerId=foo', ORG_A_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/bowler/i);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric ?teamId with a 400 (call-out which filter)', async () => {
    const res = await get('/api/payments?teamId=bar', ORG_A_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/team/i);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('rejects a partially-numeric ?leagueId (e.g. "42abc") with a 400', async () => {
    // Strict-digit check: previously the route used parseInt which
    // silently coerces "42abc" → 42, hiding a malformed request as
    // a "successful" filter for league 42. The tightened parser
    // requires digits-only (with optional leading minus).
    const res = await get('/api/payments?leagueId=42abc', ORG_A_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/league/i);
    expect(mockStorage.getLeague).not.toHaveBeenCalled();
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('rejects an unparseable ?weekOf date with a 400', async () => {
    // `new Date('not-a-date')` returns Invalid Date silently — the
    // old behaviour forwarded that into storage, which usually blew
    // up further down the stack. The route now rejects up front.
    const res = await get('/api/payments?weekOf=not-a-date', ORG_A_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/week/i);
    expect(mockStorage.getPayments).not.toHaveBeenCalled();
  });

  it('still accepts an empty filter value as "no filter" (no regression on `?leagueId=`)', async () => {
    // `req.query.leagueId === ''` used to be treated as "missing"
    // by the `if (req.query.leagueId)` ternary; preserve that so
    // existing clients that emit empty params (e.g. a cleared form
    // input) don't suddenly get 400s.
    mockStorage.getPayments.mockResolvedValue([]);

    const res = await get('/api/payments?leagueId=&bowlerId=', ORG_A_USER);
    expect(res.status).toBe(200);
    const filters = mockStorage.getPayments.mock.calls[0][0];
    expect(filters.leagueId).toBeUndefined();
    expect(filters.bowlerId).toBeUndefined();
  });
});

describe('GET /api/payments — error path', () => {
  it('returns 500 with a generic error message when storage throws', async () => {
    // The 500 branch logs the underlying storage error at [ERROR] on purpose.
    expectErrorLog(/\[Payments\] Get error:/);
    mockStorage.getPayments.mockRejectedValue(new Error('db down'));

    const res = await get('/api/payments', ORG_A_USER);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    // The message must NOT leak the underlying error.
    expect(body.error.message).not.toMatch(/db down/);
    expect(body.error.message).toMatch(/payments/i);
  });
});
