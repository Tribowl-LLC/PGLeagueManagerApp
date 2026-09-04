/**
 * End-to-end pin for task #332 — `POST /api/payments-provider/customers`
 * must surface `ProviderNotConfiguredError` from the underlying provider
 * as `422 PROVIDER_NOT_CONFIGURED` (instead of a 500 / leaked stack /
 * silent null).
 *
 * Why this is mocked rather than DB-fixtured:
 *  The earlier version of this test seeded a real org / location /
 *  league / team to drive `getProviderForLeague` through the live
 *  `getPaymentProvider` factory (relying on the location having
 *  `paymentProvider='square'` but no credentials → real PNCE throw).
 *  The fixtures wrote to `locations`, `leagues`, `teams` — all tables
 *  the orphan-data FK-bypass suites also touch — so the file had to
 *  live in the single-fork `serial-fk-bypass` project.
 *
 *  The contract we actually care about is route-layer:
 *      provider throws PNCE  →  422 PROVIDER_NOT_CONFIGURED.
 *  The provider implementation itself is pinned by other tests
 *  (e.g. `tests/unit/square-charge-failures.test.ts`). So here we
 *  stub `getProviderForLeague` to throw PNCE and assert the route
 *  maps it correctly. Zero DB writes → safe to run in the parallel
 *  project alongside everything else.
 */
import {
  afterAll, afterEach, beforeAll, beforeEach,
  describe, expect, it, vi,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ProviderNotConfiguredError } from '../../server/services/payment-provider-factory';

// Vitest hoists `vi.mock(...)` to the very top of the module, so any
// identifier the factory closes over must also be hoisted — otherwise
// the factory runs before the `const` initializer and throws "Cannot
// access X before initialization". `vi.hoisted` is the supported way
// to declare those bindings so they share the hoist phase.
const {
  mockStorage,
  mockGetProviderForLeague,
  mockGetPaymentProvider,
  fakeLogger,
} = vi.hoisted(() => ({
  mockStorage: {
    getTeam: vi.fn(),
    getLeague: vi.fn(),
  },
  mockGetProviderForLeague: vi.fn(),
  mockGetPaymentProvider: vi.fn(),
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/storage', () => ({ storage: mockStorage }));

vi.mock('../../server/middleware/rate-limit', () => ({
  paymentLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../server/routes/payments-provider/shared', () => ({
  getProviderForLeague: (...a: unknown[]) => mockGetProviderForLeague(...a),
}));
vi.mock('../../server/services/payment-provider-factory', async (importActual) => {
  const actual = await importActual<
    typeof import('../../server/services/payment-provider-factory')
  >();
  return {
    ...actual,
    getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  };
});

vi.mock('../../server/logger', () => ({ logger: fakeLogger, createLogger: () => fakeLogger }));

const customersRouter = (await import('../../server/routes/payments-provider/customers')).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    // `Object.assign` attaches `user` without an `as unknown as` double
    // cast, which keeps this file out of the lint suppression baseline.
    if (raw) Object.assign(req, { user: JSON.parse(raw) });
    next();
  });
  app.use('/api/payments-provider', customersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const fn of Object.values(mockStorage)) (fn as ReturnType<typeof vi.fn>).mockReset();
  mockGetProviderForLeague.mockReset();
  mockGetPaymentProvider.mockReset();
});

afterEach(() => vi.clearAllMocks());

const ADMIN = { id: 1, role: 'org_admin', organizationId: 7, bowlerId: null };

async function postCustomer(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/payments-provider/customers`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-user': JSON.stringify(ADMIN),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/payments-provider/customers — 422 PROVIDER_NOT_CONFIGURED contract (Task #332)', () => {
  it('returns 422 PROVIDER_NOT_CONFIGURED when getProviderForLeague throws PNCE (team-scoped)', async () => {
    mockStorage.getTeam.mockResolvedValue({ id: 42, leagueId: 11 });
    mockStorage.getLeague.mockResolvedValue({
      id: 11, organizationId: 7, locationId: 99,
    });
    mockGetProviderForLeague.mockRejectedValue(
      new ProviderNotConfiguredError('Square not configured for location 99', 99),
    );

    const res = await postCustomer({
      teamId: 42,
      name: 'Test Customer',
      email: 'pnce-customer@example.com',
    });
    const body = await res.json() as { success: boolean; error?: { code: string } };

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('returns 422 PROVIDER_NOT_CONFIGURED when getPaymentProvider throws PNCE (no team / org-default path)', async () => {
    // No teamId on the request → route falls through to the
    // org-default `getPaymentProvider(null)` branch.
    mockGetPaymentProvider.mockRejectedValue(
      new ProviderNotConfiguredError('Square not configured (default)', null),
    );

    const res = await postCustomer({
      name: 'Test Customer',
      email: 'pnce-no-team@example.com',
    });
    const body = await res.json() as { success: boolean; error?: { code: string } };

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('non-PNCE provider failure still falls through to 500 (does not get falsely labeled PROVIDER_NOT_CONFIGURED)', async () => {
    mockStorage.getTeam.mockResolvedValue({ id: 42, leagueId: 11 });
    mockStorage.getLeague.mockResolvedValue({
      id: 11, organizationId: 7, locationId: 99,
    });
    mockGetProviderForLeague.mockResolvedValue({
      createOrUpdateCustomer: vi.fn().mockRejectedValue(new Error('square 5xx outage')),
    });

    const res = await postCustomer({
      teamId: 42,
      name: 'Test Customer',
      email: 'generic-fail@example.com',
    });
    const body = await res.json() as { success: boolean; error?: { code: string } };

    expect(res.status).toBe(500);
    expect(body.error?.code).not.toBe('PROVIDER_NOT_CONFIGURED');
    expect(fakeLogger.captureException).toHaveBeenCalledOnce();
    expect(fakeLogger.captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});
