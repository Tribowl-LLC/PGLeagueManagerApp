/**
 * Route-level filter-validation tests for task #421.
 *
 * Task #406 hardened GET /api/payments so non-numeric / unparseable
 * query filters return a clear 400 instead of being forwarded into
 * storage as NaN / Invalid Date (`payments-reports-routes.test.ts`
 * pins that behaviour). #421 lifts the same tri-state parser
 * contract into `server/utils/api.ts` and applies it across the
 * other list endpoints; this file pins the new per-filter 400s for
 * each one.
 *
 * Pattern per route: a per-filter 400 for non-numeric /
 * partially-numeric input, a regression pin for the
 * empty-string-as-no-filter case, and an assertion that the
 * downstream storage method is never invoked when validation
 * rejects.
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
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// ---------------------------------------------------------------------------
// Module mocks. Hoisted to file scope by vitest so every router import below
// receives the mocked versions. The route handlers under test all run their
// validation BEFORE touching any of these, so the no-op shapes below are
// enough to exercise the 400 path; the few "happy" assertions verify the
// validation gate doesn't accidentally short-circuit a clean request.
// ---------------------------------------------------------------------------
const mockStorage = {
  getLeagues: vi.fn(),
  getAllLeaguesSystemAdmin: vi.fn(),
  getLeague: vi.fn(),
  getTeams: vi.fn(),
  getBowlers: vi.fn(),
  getAllBowlersSystemAdmin: vi.fn(),
  getLinkedBowlerIds: vi.fn(),
  getBowlerLeaguesByBowlerIds: vi.fn(),
  getLeaguesByIds: vi.fn(),
  getTeamsByIds: vi.fn(),
  getBowlerLeagues: vi.fn(),
  getBowler: vi.fn(),
  getPayments: vi.fn(),
  isBowlerLinked: vi.fn(),
  isBowlerActiveInLeague: vi.fn(),
  getLocation: vi.fn(),
};
vi.mock('../../server/storage', () => ({ storage: mockStorage }));

vi.mock('../../server/routes/payments/payment-reports.js', () => ({
  buildPayerNameMap: vi.fn().mockResolvedValue(new Map()),
}));

// Keep the real pure role-check helpers (isSystemAdmin, isOrgOrHigher) via
// importOriginal — bowlers.ts uses isOrgOrHigher, so a
// bare partial mock drifts and throws "No <export> defined on mock".
vi.mock('../../server/utils/access-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/access-control')>();
  return {
    ...actual,
    requireOrganizationAccess: () => true,
    hasAccessToLeague: vi.fn().mockResolvedValue(true),
    hasAccessToTeam: vi.fn().mockResolvedValue(true),
    hasAccessToBowler: vi.fn().mockResolvedValue(true),
    hasAccessToBowlers: vi.fn().mockResolvedValue(new Map()),
    hasSelfOrAdminAccessToBowler: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../../server/utils/access-control.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/access-control')>();
  return {
    ...actual,
    requireOrganizationAccess: () => true,
    hasAccessToLeague: vi.fn().mockResolvedValue(true),
    hasAccessToTeam: vi.fn().mockResolvedValue(true),
    hasAccessToBowler: vi.fn().mockResolvedValue(true),
    hasAccessToBowlers: vi.fn().mockResolvedValue(new Map()),
    hasSelfOrAdminAccessToBowler: vi.fn().mockResolvedValue(true),
  };
});

// `filterByOrganization` is the only middleware leagues.ts mounts;
// the validation logic under test runs after it, so a passthrough
// is enough.
vi.mock('../../server/middleware/organization', () => ({
  filterByOrganization: (_req: unknown, _res: unknown, next: () => void) => next(),
  getOrganizationFilter: () => 1,
}));

// bowlers.ts pulls in the payment provider factory and a few utils
// for its POST/PATCH paths. The cards
// route also calls listCardsOnFile / disableCard on the returned
// provider, so the mock has to ship stubs for those — without them
// the `?leagueId=` empty-string regression tests would 500 and
// muddy the assertion.
// eslint-disable-next-line local/factory-must-use-schema -- test-double PaymentProvider, not a schema row
const fakeProvider = {
  providerName: 'square',
  listCardsOnFile: vi.fn().mockResolvedValue([]),
  saveCardOnFile: vi.fn().mockResolvedValue(null),
  disableCard: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: vi.fn().mockResolvedValue(fakeProvider),
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
}));
vi.mock('../../server/services/bowler-sync.js', () => ({
  runBowlerPostCreateSync: vi.fn(async (b: unknown) => b),
}));
// catalog.ts / cards.ts dependencies — same story.
vi.mock('../../server/services/payment-provider', () => ({
  hasCatalogSupport: () => false,
}));
vi.mock('../../server/services/payment-utils', () => ({
  getProviderCustomerId: () => 'cust_1',
  ensureProviderCustomer: vi.fn().mockResolvedValue('cust_1'),
}));
vi.mock('../../server/routes/payments-provider/shared.js', () => ({
  getProviderForLeague: vi.fn(async () => fakeProvider),
}));

// leagues.ts pulls in additional service modules for its mutating
// routes. They're never invoked here but must be importable.
vi.mock('../../server/services/email', () => ({
  sendInviteEmail: vi.fn(),
  sendSquareCatalogCapAlert: vi.fn(async () => true),
}));
// ---------------------------------------------------------------------------
// Lazy router imports — must come AFTER vi.mock so the mocked
// modules are wired in.
// ---------------------------------------------------------------------------
const leaguesRouter = (await import('../../server/routes/leagues')).default;
const teamsRouter = (await import('../../server/routes/teams')).default;
const bowlersRouter = (await import('../../server/routes/bowlers')).default;
const cardsRouter = (await import('../../server/routes/payments-provider/cards')).default;
const catalogRouter = (await import('../../server/routes/payments-provider/catalog')).default;

// ---------------------------------------------------------------------------
// Test app — every router mounted under its real-world prefix so the
// URLs in the tests below match what production clients send.
// ---------------------------------------------------------------------------
type TestRole = 'system_admin' | 'org_admin' | 'admin' | 'user';

interface TestUser {
  id: number;
  role: TestRole;
  organizationId: number | null;
  bowlerId?: number | null;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) {
      const parsed = JSON.parse(raw) as TestUser;
      (req as unknown as { user: TestUser }).user = parsed;
      // Several routes / middlewares branch on `req.isAuthenticated()`.
      // The fake user means the request is authenticated for this test.
      (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated =
        () => true;
    } else {
      (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated =
        () => false;
    }
    next();
  });
  app.use('/api/leagues', leaguesRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/bowlers', bowlersRouter);
  app.use('/api/payments-provider', cardsRouter);
  app.use('/api/payments-provider', catalogRouter);

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
  for (const fn of Object.values(mockStorage)) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  // Sensible defaults so happy-path assertions don't trip on `undefined`.
  mockStorage.getLeagues.mockResolvedValue([]);
  mockStorage.getAllLeaguesSystemAdmin.mockResolvedValue([]);
  mockStorage.getTeams.mockResolvedValue([]);
  mockStorage.getBowlers.mockResolvedValue([]);
  mockStorage.getAllBowlersSystemAdmin.mockResolvedValue([]);
  mockStorage.getLinkedBowlerIds.mockResolvedValue([]);
  mockStorage.getBowlerLeaguesByBowlerIds.mockResolvedValue([]);
  mockStorage.getLeaguesByIds.mockResolvedValue([]);
  mockStorage.getTeamsByIds.mockResolvedValue([]);
  mockStorage.getBowlerLeagues.mockResolvedValue([]);
  mockStorage.getBowler.mockResolvedValue({
    id: 99,
    name: 'b',
    organizationId: 1,
    paymentCustomerId: 'cust_1',
  });
  mockStorage.getPayments.mockResolvedValue([]);
  mockStorage.isBowlerLinked.mockResolvedValue(false);
  mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
  mockStorage.getLocation.mockResolvedValue({ id: 1, organizationId: 1 });
  mockStorage.getLeague.mockResolvedValue({ id: 11, organizationId: 1 });
});

afterEach(() => vi.clearAllMocks());

const ORG_USER: TestUser = { id: 7, role: 'org_admin', organizationId: 1, bowlerId: null };
const SYSADMIN: TestUser = { id: 1, role: 'system_admin', organizationId: null, bowlerId: null };

function userHeader(user: TestUser) {
  return { 'x-test-user': JSON.stringify(user) };
}

async function get(path: string, user?: TestUser) {
  return fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: user ? userHeader(user) : {},
  });
}

async function patchJson(path: string, body: unknown, user?: TestUser) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      ...(user ? userHeader(user) : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function postJson(path: string, body: unknown, user?: TestUser) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(user ? userHeader(user) : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function deleteReq(path: string, user?: TestUser) {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: user ? userHeader(user) : {},
  });
}

// ---------------------------------------------------------------------------
// GET /api/leagues — locationId filter
// ---------------------------------------------------------------------------
describe('GET /api/leagues — locationId filter', () => {
  it('rejects a non-numeric ?locationId with a 400 (call-out which filter)', async () => {
    const res = await get('/api/leagues?locationId=foo', ORG_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/location/i);
  });

  it('rejects a partially-numeric ?locationId (the parseInt-coercion bug)', async () => {
    const res = await get('/api/leagues?locationId=42abc', ORG_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/location/i);
  });

  it('does not hit storage when ?locationId is rejected', async () => {
    // Architect note: the validation gate must run BEFORE the
    // storage round trip so we don't burn a DB query on a request
    // we're going to 400 anyway.
    const res = await get('/api/leagues?locationId=foo', ORG_USER);
    expect(res.status).toBe(400);
    expect(mockStorage.getLeagues).not.toHaveBeenCalled();
    expect(mockStorage.getAllLeaguesSystemAdmin).not.toHaveBeenCalled();
  });

  it('still accepts an empty ?locationId= as "no filter"', async () => {
    // Regression pin: the old `req.query.locationId ? ... : null` ternary
    // treated `''` as falsy → no filter; the new strict parser must
    // preserve that so cleared-form-input clients keep working.
    const res = await get('/api/leagues?locationId=', ORG_USER);
    expect(res.status).toBe(200);
  });

  it('treats ?locationId=0 as "no filter" (preserves prior truthy semantics)', async () => {
    // Behaviour pin: the original code used `if (locationId)` which
    // treated 0 as falsy; we kept that semantic deliberately
    // because 0 is not a valid serial id and would otherwise filter
    // the result down to an empty list — a silent behaviour change
    // for any client that sends `?locationId=0` to mean "all".
    mockStorage.getLeagues.mockResolvedValue([
      { id: 1, locationId: 1, organizationId: 1 },
      { id: 2, locationId: 2, organizationId: 1 },
    ]);
    const res = await get('/api/leagues?locationId=0', ORG_USER);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/teams — leagueId filter
// ---------------------------------------------------------------------------
describe('GET /api/teams — leagueId filter', () => {
  it('rejects a non-numeric ?leagueId with a 400 and never touches storage', async () => {
    const res = await get('/api/teams?leagueId=foo', ORG_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/league/i);
    expect(mockStorage.getLeague).not.toHaveBeenCalled();
    expect(mockStorage.getTeams).not.toHaveBeenCalled();
  });

  it('rejects a partially-numeric ?leagueId (e.g. "11x")', async () => {
    const res = await get('/api/teams?leagueId=11x', ORG_USER);
    expect(res.status).toBe(400);
    expect(mockStorage.getLeague).not.toHaveBeenCalled();
  });

  it('still accepts an empty ?leagueId= as "no filter"', async () => {
    const res = await get('/api/teams?leagueId=', ORG_USER);
    expect(res.status).toBe(200);
    // No leagueId means we go through the "scope to user's org"
    // branch — that path doesn't call getLeague.
    expect(mockStorage.getLeague).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/bowlers — teamId / ids / organizationId filters
// ---------------------------------------------------------------------------
describe('GET /api/bowlers — list filter validation', () => {
  it('rejects a non-numeric ?teamId with a 400 (call-out which filter)', async () => {
    const res = await get('/api/bowlers?teamId=foo', ORG_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/team/i);
    expect(mockStorage.getBowlers).not.toHaveBeenCalled();
  });

  it('rejects a partially-numeric ?teamId (e.g. "7abc")', async () => {
    const res = await get('/api/bowlers?teamId=7abc', ORG_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/team/i);
  });

  it('rejects a malformed ?ids list (any bad element fails the whole list)', async () => {
    const res = await get('/api/bowlers?ids=1,foo,3', ORG_USER);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/bowler id/i);
    expect(mockStorage.getBowlers).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric ?organizationId with a 400', async () => {
    const res = await get('/api/bowlers?organizationId=foo', SYSADMIN);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/organization/i);
    expect(mockStorage.getBowlers).not.toHaveBeenCalled();
    expect(mockStorage.getAllBowlersSystemAdmin).not.toHaveBeenCalled();
  });

  it('still accepts empty ?teamId=&ids=&organizationId= as "no filter"', async () => {
    const res = await get(
      '/api/bowlers?teamId=&ids=&organizationId=',
      ORG_USER,
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bowlers/unlinked — organizationId filter
// ---------------------------------------------------------------------------
describe('GET /api/bowlers/unlinked — organizationId filter', () => {
  it('rejects a non-numeric ?organizationId with a 400', async () => {
    const res = await get('/api/bowlers/unlinked?organizationId=foo', SYSADMIN);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/organization/i);
    expect(mockStorage.getBowlers).not.toHaveBeenCalled();
    expect(mockStorage.getAllBowlersSystemAdmin).not.toHaveBeenCalled();
  });

  it('rejects partially-numeric ?organizationId (e.g. "1abc") — the strict-parser tightening', async () => {
    // The old isNaN check would let "1abc" through as 1.
    const res = await get('/api/bowlers/unlinked?organizationId=1abc', SYSADMIN);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /api/payments-provider/cards — leagueId filter on GET and DELETE
// ---------------------------------------------------------------------------
describe('GET /api/payments-provider/cards/:bowlerId — leagueId filter', () => {
  it('rejects a non-numeric ?leagueId with a 400 (call-out which filter)', async () => {
    const res = await get(
      '/api/payments-provider/cards/99?leagueId=foo',
      ORG_USER,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/league/i);
  });

  it('rejects partially-numeric ?leagueId (e.g. "11abc")', async () => {
    const res = await get(
      '/api/payments-provider/cards/99?leagueId=11abc',
      ORG_USER,
    );
    expect(res.status).toBe(400);
  });

  it('still accepts an empty ?leagueId= as "no filter" and returns the card list', async () => {
    // Regression pin: cleared form input shouldn't 400 — and the
    // request should actually flow through to the provider's
    // listCardsOnFile (mocked to return []) so we can pin the full
    // happy path, not just "didn't 400".
    const res = await get('/api/payments-provider/cards/99?leagueId=', ORG_USER);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });
});

describe('POST /api/payments-provider/cards/:bowlerId — payer ownership', () => {
  it('does not let an administrator vault a card onto another bowler', async () => {
    const res = await postJson('/api/payments-provider/cards/99', { sourceId: 'cnon_admin_other_bowler' }, ORG_USER);
    expect(res.status).toBe(403);
    expect(fakeProvider.saveCardOnFile).not.toHaveBeenCalled();
  });

  it('vaults an own card only after the submitted league is tenant-scoped and active', async () => {
    fakeProvider.saveCardOnFile.mockResolvedValue({ id: 'card_own', last4: '4242', brand: 'VISA' });
    const ownUser: TestUser = { id: 8, role: 'user', organizationId: 1, bowlerId: 99 };
    mockStorage.getLeague.mockResolvedValue({ id: 11, organizationId: 1 });
    mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
    const res = await postJson('/api/payments-provider/cards/99', { sourceId: 'cnon_own', leagueId: 11 }, ownUser);
    expect(res.status).toBe(200);
    expect(fakeProvider.saveCardOnFile).toHaveBeenCalledWith('cnon_own', 'cust_1');
  });

  it.each([
    ['cross-organization league', { id: 11, organizationId: 2 }, true],
    ['inactive membership', { id: 11, organizationId: 1 }, false],
  ])('denies %s before any provider mutation', async (_case, league, active) => {
    const ownUser: TestUser = { id: 8, role: 'user', organizationId: 1, bowlerId: 99 };
    mockStorage.getLeague.mockResolvedValue(league);
    mockStorage.isBowlerActiveInLeague.mockResolvedValue(active);
    fakeProvider.saveCardOnFile.mockClear();
    const res = await postJson('/api/payments-provider/cards/99', { sourceId: 'cnon_denied', leagueId: 11 }, ownUser);
    expect(res.status).toBe(403);
    expect(fakeProvider.saveCardOnFile).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/payments-provider/cards/:bowlerId/:cardId — leagueId filter', () => {
  it('rejects a non-numeric ?leagueId with a 400 and never touches the provider', async () => {
    const res = await deleteReq(
      '/api/payments-provider/cards/99/card_abc?leagueId=foo',
      ORG_USER,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/league/i);
    expect(fakeProvider.disableCard).not.toHaveBeenCalled();
  });

  it('still accepts an empty ?leagueId= as "no filter" and disables the card', async () => {
    const res = await deleteReq(
      '/api/payments-provider/cards/99/card_abc?leagueId=',
      ORG_USER,
    );
    expect(res.status).toBe(200);
    expect(fakeProvider.disableCard).toHaveBeenCalledWith('card_abc', 'cust_1');
  });
});

// ---------------------------------------------------------------------------
// /api/payments-provider/catalog — locationId filter on both endpoints
// ---------------------------------------------------------------------------
describe('GET /api/payments-provider/catalog/categories — locationId filter', () => {
  it('rejects a non-numeric ?locationId with a 400 (closes the auth-bypass smell)', async () => {
    // Pre-#421 a `parseInt` of "foo" produced NaN; the `!isNaN`
    // guard then SKIPPED the location-ownership check entirely and
    // the request fell through to `getPaymentProvider(NaN)`. That's
    // a real defence-in-depth concern for tenants who could have
    // peeked at a sibling org's provider config if the DB had ever
    // returned a NaN-keyed row. The 400 closes the bypass.
    const res = await get(
      '/api/payments-provider/catalog/categories?locationId=foo',
      ORG_USER,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/location/i);
    expect(mockStorage.getLocation).not.toHaveBeenCalled();
  });

  it('rejects partially-numeric ?locationId (e.g. "1abc")', async () => {
    const res = await get(
      '/api/payments-provider/catalog/categories?locationId=1abc',
      ORG_USER,
    );
    expect(res.status).toBe(400);
    expect(mockStorage.getLocation).not.toHaveBeenCalled();
  });

  it('still accepts an empty ?locationId= as "no filter" (skips ownership check) and returns an empty payload', async () => {
    // Provider mock has hasCatalogSupport→false, so the route
    // returns the empty `{ categories, truncated }` payload (Task
    // #623 — the data shape grew a `truncated` flag so the admin
    // UI can show a banner when the pagination cap fires).
    const res = await get(
      '/api/payments-provider/catalog/categories?locationId=',
      ORG_USER,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ categories: [], truncated: false });
    expect(mockStorage.getLocation).not.toHaveBeenCalled();
  });
});

describe('GET /api/payments-provider/catalog/items — locationId filter', () => {
  it('rejects a non-numeric ?locationId with a 400', async () => {
    const res = await get(
      '/api/payments-provider/catalog/items?locationId=foo',
      ORG_USER,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/location/i);
    expect(mockStorage.getLocation).not.toHaveBeenCalled();
  });

  it('still accepts an empty ?locationId= as "no filter" and returns an empty payload', async () => {
    // See the categories handler test above for why the data shape
    // is `{ items, truncated }` rather than a bare array (Task #623).
    const res = await get(
      '/api/payments-provider/catalog/items?locationId=',
      ORG_USER,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ items: [], truncated: false });
    expect(mockStorage.getLocation).not.toHaveBeenCalled();
  });
});

describe('GET /api/bowlers/:id/details — ordinary payment privacy', () => {
  it('removes raw provider and hosted-receipt evidence from ordinary payment details', async () => {
    mockStorage.getBowler.mockResolvedValue({
      id: 99,
      name: 'Target Bowler',
      organizationId: 1,
      paymentCustomerId: null,
    });
    mockStorage.getBowlerLeagues.mockResolvedValue([{ bowlerId: 99, leagueId: 11, teamId: null }]);
    mockStorage.getLeaguesByIds.mockResolvedValue([{ id: 11, organizationId: 1, name: 'League' }]);
    mockStorage.getTeamsByIds.mockResolvedValue([]);
    mockStorage.getPayments.mockResolvedValue([{
      id: 501,
      organizationId: 1,
      bowlerId: 99,
      leagueId: 11,
      amount: 2500,
      currency: 'USD',
      status: 'paid',
      type: 'square',
      checkNumber: null,
      providerPaymentId: 'provider-secret',
      idempotencyKey: 'key-secret',
      squareRefundId: 'refund-secret',
      refundReason: null,
      refundedAt: null,
      disputeId: 'dispute-secret',
      disputedAt: '2038-01-02T00:00:00.000Z',
      receiptUrl: 'https://receipt.secret',
      receiptNumber: 'receipt-secret',
      receiptEmailMissing: false,
      notes: null,
      paidByUserId: 700,
      createdAt: '2038-01-01T00:00:00.000Z',
    }]);

    const response = await get('/api/bowlers/99/details?includePayments=true', {
      id: 42,
      role: 'user',
      organizationId: 1,
      bowlerId: 99,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.payments).toHaveLength(1);
    expect(body.data.payments[0]).toMatchObject({
      id: 501,
      amount: 2500,
      providerPaymentId: null,
      idempotencyKey: null,
      squareRefundId: null,
      disputeId: null,
      receiptUrl: null,
      receiptNumber: null,
      paidByUserId: null,
      paidByName: null,
    });
  });
});
