/**
 * Route-level tests for /api/payments CRUD + refund (task #309).
 *
 * The /api/payments routes (now split across
 * `server/routes/payments/payment-record.ts` and
 * `server/routes/payments/payment-refunds.ts`) handle money movement,
 * idempotency-key dedup, paid-in-full schedule cancellation, refund
 * provider delegation, and access control. After the recent refactor
 * these had no dedicated route-level tests.
 *
 * These tests mount the real routers onto an isolated Express app with
 * the storage / access-control / payment-provider / db / rate-limiter
 * modules mocked, then drive each endpoint over real HTTP via `fetch`.
 *
 * Coverage matrix:
 *   POST   /api/payments
 *     - happy path → 201
 *     - league not found → 404
 *     - cross-org access denied → 403
 *     - check payment missing checkNumber → 400
 *     - idempotency dedup (same league) returns existing 200
 *     - idempotency conflict (different league) → 409
 *     - paid-in-full triggers schedule deactivation + scheduler removal
 *   PATCH  /api/payments/:id
 *     - happy path → 200
 *     - non-admin lacking access → 403
 *     - not found → 404
 *     - check type without checkNumber → 400
 *   DELETE /api/payments/:id
 *     - happy path → 200
 *     - invalid id → 400
 *     - not found → 404
 *     - card payment by non-admin → 403
 *     - non-admin lacking access → 403
 *   POST   /api/payments/:id/refund
 *     - happy path: provider delegation + storage.refundPayment → 200
 *     - non-admin → 403
 *     - already refunded → 400
 *     - status not paid → 400
 *     - non-card payment type → 400
 *     - provider not configured → 422
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
import { expectErrorLog } from '../helpers/expected-error-logs';

const mockStorage = {
  getLeague: vi.fn(),
  getBowler: vi.fn(),
  isBowlerActiveInLeague: vi.fn(),
  getPaymentByIdempotencyKey: vi.fn(),
  createPayment: vi.fn(),
  getPaymentSchedule: vi.fn(),
  deactivatePaymentSchedule: vi.fn(),
  getPaymentById: vi.fn(),
  updatePayment: vi.fn(),
  deletePayment: vi.fn(),
  refundPayment: vi.fn(),
};

vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockHasAccessToPayment = vi.fn();
const mockRequireOrgAccess = vi.fn();
const mockHasAdminAccessToLeague = vi.fn();
// Keep the real pure role-check helpers (isSystemAdmin, isOrgOrHigher) via
// importOriginal — only the DB-touching helpers are overridden. Payment routes
// use hasAdminAccessToLeague/isSystemAdmin/isOrgOrHigher, so a hand-rolled partial mock drifts and throws
// "No <export> defined on mock".
vi.mock('../../server/utils/access-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/access-control')>();
  return {
    ...actual,
    hasAccessToPayment: (...a: unknown[]) => mockHasAccessToPayment(...a),
    requireOrganizationAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
    hasAdminAccessToLeague: (...a: unknown[]) => mockHasAdminAccessToLeague(...a),
  };
});

const mockRemoveSchedule = vi.fn();
vi.mock('../../server/services/payment-scheduler', () => ({
  paymentScheduler: { removeSchedule: (...a: unknown[]) => mockRemoveSchedule(...a) },
}));

const mockGetPaymentProvider = vi.fn();
// Mirror the real factory, which re-exports the error classes from
// payment-errors. buildPaymentErrorResponse now imports the canonical
// classes from payment-errors, so the thrown error must be a real
// instance for the `instanceof` branch (→ 422) to match.
vi.mock('../../server/services/payment-provider-factory', async () => {
  const errs = await import('../../server/services/payment-errors');
  return {
    getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
    ProviderNotConfiguredError: errs.ProviderNotConfiguredError,
    PaymentProviderError: errs.PaymentProviderError,
  };
});

const mockPrepareRefund = vi.fn();
const mockExecuteRefund = vi.fn();
const mockRearmOperations = vi.fn();
const mockRetryRefundAfterConfiguration = vi.fn();
vi.mock('../../server/storage/payment-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/storage/payment-operations')>();
  return {
    ...actual,
    retryRefundPaymentOperationAfterConfigurationFailure: (...a: unknown[]) => mockRetryRefundAfterConfiguration(...a),
  };
});
vi.mock('../../server/services/refund-payment-operation-preparation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/services/refund-payment-operation-preparation')>();
  return { ...actual, prepareRefundPaymentOperation: (...a: unknown[]) => mockPrepareRefund(...a) };
});
vi.mock('../../server/services/refund-payment-operation-executor', () => ({
  refundPaymentOperationExecutor: { execute: (...a: unknown[]) => mockExecuteRefund(...a) },
}));
vi.mock('../../server/services/scheduled-payment-operation-executor', () => ({
  scheduledPaymentOperationExecutor: { rearm: (...a: unknown[]) => mockRearmOperations(...a) },
}));

const mockSumQuery = vi.fn();
vi.mock('../../server/db', () => ({
  db: {
    execute: () => Promise.resolve({ rows: [{ present: false }] }),
    select: () => ({
      from: () => ({
        where: (..._a: unknown[]) => mockSumQuery(),
      }),
    }),
  },
}));

// No-op the per-IP rate limiter so a single test run doesn't get
// throttled (default is 30/15min and we make ~20 calls).
vi.mock('../../server/middleware/rate-limit', () => ({
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  paymentLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  adminWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Imports must come after vi.mock declarations.
const paymentRecordRouter = (await import('../../server/routes/payments/payment-record')).default;
const paymentRefundsRouter = (await import('../../server/routes/payments/payment-refunds')).default;

type TestRole = 'system_admin' | 'org_admin' | 'admin' | 'user';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Inject req.user from a test header to simulate auth.
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as unknown as { user: unknown }).user = JSON.parse(raw);
    next();
  });
  app.use('/api/payments', paymentRecordRouter);
  app.use('/api/payments', paymentRefundsRouter);

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
  for (const fn of Object.values(mockStorage)) (fn as ReturnType<typeof vi.fn>).mockReset();
  mockHasAccessToPayment.mockReset();
  mockRequireOrgAccess.mockReset();
  mockHasAdminAccessToLeague.mockReset();
  mockRemoveSchedule.mockReset();
  mockGetPaymentProvider.mockReset();
  mockPrepareRefund.mockReset();
  mockExecuteRefund.mockReset();
  mockRearmOperations.mockReset();
  mockRetryRefundAfterConfiguration.mockReset();
  mockSumQuery.mockReset();
  // Sensible defaults; individual tests override.
  mockRequireOrgAccess.mockReturnValue(true);
  mockHasAccessToPayment.mockResolvedValue(true);
  mockHasAdminAccessToLeague.mockResolvedValue(true);
  mockSumQuery.mockResolvedValue([{ total: 0 }]);
  // Task #454 added an existence pre-check on `payment.bowlerId` in
  // `payment-record.ts`. Default to a valid bowler so tests focused on
  // other concerns (idempotency, schedule deactivation, etc.) still
  // reach the create path. Tests asserting the 404 NOT_FOUND branch can
  // override this with `mockResolvedValue(undefined)`.
  // Org id matches LEAGUE_OK so the P1 org-match guard (#737) passes by
  // default; cross-org tests override with a different organizationId.
  mockStorage.getBowler.mockResolvedValue({ id: 1, organizationId: 1 });
  // P1 (#737): payment creation requires an active roster row. Default to
  // rostered; the "not rostered" test overrides with false.
  mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
  const operation = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'pending',
    providerObjectId: null,
    nextAttemptAt: '2026-01-01T00:00:00.000Z',
    leaseExpiresAt: null,
    attemptCount: 0,
    errorClassification: null,
    errorCode: null,
  };
  mockPrepareRefund.mockResolvedValue({ operation, snapshot: { organizationId: 1 } });
  mockExecuteRefund.mockResolvedValue({ ...operation, status: 'succeeded', providerObjectId: 'RF_1' });
  mockRearmOperations.mockResolvedValue(undefined);
  mockRetryRefundAfterConfiguration.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

function userHeader(user: {
  id: number;
  role: TestRole;
  organizationId: number | null;
  bowlerId?: number | null;
}) {
  return { 'x-test-user': JSON.stringify(user), 'content-type': 'application/json' };
}

const ORG_A_USER = { id: 7, role: 'org_admin' as TestRole, organizationId: 1, bowlerId: null };
const SYSADMIN = { id: 1, role: 'system_admin' as TestRole, organizationId: null, bowlerId: null };
const REGULAR_USER = { id: 9, role: 'user' as TestRole, organizationId: 1, bowlerId: 5 };

const LEAGUE_OK = {
  id: 11,
  organizationId: 1,
  weeklyFee: 2000,
  lineageFee: 1000,
  prizeFundFee: 500,
  seasonStart: null,
  seasonEnd: null,
  locationId: 99,
};

function basePayment(overrides: Record<string, unknown> = {}) {
  return {
    bowlerId: 42,
    leagueId: LEAGUE_OK.id,
    amount: 2000,
    weekOf: '2026-01-05',
    status: 'paid',
    type: 'cash',
    ...overrides,
  };
}

async function post(path: string, body: unknown, user: object = ORG_A_USER) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: userHeader(user as Parameters<typeof userHeader>[0]),
    body: JSON.stringify(body),
  });
}
async function patch(path: string, body: unknown, user: object = ORG_A_USER) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: userHeader(user as Parameters<typeof userHeader>[0]),
    body: JSON.stringify(body),
  });
}
async function del(path: string, user: object = ORG_A_USER) {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: userHeader(user as Parameters<typeof userHeader>[0]),
  });
}

describe('POST /api/payments', () => {
  it('rejects generic cash/check writes once canonical activation is complete', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    mockSumQuery.mockResolvedValue([{ completenessMarker: true }]);
    const res = await post('/api/payments', basePayment());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('rejects raw card/square bookkeeping once canonical activation is complete', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    mockSumQuery.mockResolvedValue([{ completenessMarker: true }]);
    const res = await post('/api/payments', basePayment({ type: 'square' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('rejects inferred bookkeeping even when the league has legacy-shaped fields', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    mockStorage.createPayment.mockResolvedValue({ id: 555, ...basePayment() });

    const res = await post('/api/payments', basePayment());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  // P1 (#737): admin access to the league is not enough — the bowler must
  // be actively rostered in it and belong to its organization.
  it('does not disclose bowler roster state through the retired inferred route', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    mockStorage.getBowler.mockResolvedValue({ id: 42, organizationId: LEAGUE_OK.organizationId });
    mockStorage.isBowlerActiveInLeague.mockResolvedValue(false);

    const res = await post('/api/payments', basePayment());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('does not disclose cross-organization bowler state through the retired route', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    mockStorage.getBowler.mockResolvedValue({ id: 42, organizationId: LEAGUE_OK.organizationId + 1 });

    const res = await post('/api/payments', basePayment());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.isBowlerActiveInLeague).not.toHaveBeenCalled();
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('returns 404 when the league does not exist', async () => {
    mockStorage.getLeague.mockResolvedValue(undefined);

    const res = await post('/api/payments', basePayment());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('returns 403 when caller has no access to the league org', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    // Creation gates on administrator access to the league.
    mockHasAdminAccessToLeague.mockResolvedValue(false);

    const res = await post('/api/payments', basePayment());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('rejects check payments without a check number → 400', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    const res = await post('/api/payments', basePayment({ type: 'check' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('requires exact obligations before evaluating legacy idempotency keys', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    const existing = { id: 999, leagueId: LEAGUE_OK.id, idempotencyKey: 'k1' };
    mockStorage.getPaymentByIdempotencyKey.mockResolvedValue(existing);

    const res = await post('/api/payments', basePayment({ idempotencyKey: 'k1' }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('does not reveal legacy idempotency conflicts before exact selection', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    mockStorage.getPaymentByIdempotencyKey.mockResolvedValue({
      id: 998,
      leagueId: 9999,
      idempotencyKey: 'k1',
    });

    const res = await post('/api/payments', basePayment({ idempotencyKey: 'k1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

  it('does not race legacy inserts after the clean-slate cutover', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_OK);
    // First lookup misses (no existing row yet), insert races and loses,
    // second lookup finds the row written by the winner.
    const winner = { id: 1234, leagueId: LEAGUE_OK.id, idempotencyKey: 'race-1' };
    mockStorage.getPaymentByIdempotencyKey
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(winner);
    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockStorage.createPayment.mockRejectedValue(dupErr);

    const res = await post('/api/payments', basePayment({ idempotencyKey: 'race-1' }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.getPaymentByIdempotencyKey).not.toHaveBeenCalled();
  });

  it('does not deactivate a legacy schedule from an inferred payment', async () => {
    const PIF_LEAGUE = {
      ...LEAGUE_OK,
      seasonStart: '2026-01-01',
      seasonEnd: '2026-02-01', // ~4 full weeks → 4 * 2000 = 8000
      weeklyFee: 2000,
    };
    mockStorage.getLeague.mockResolvedValue(PIF_LEAGUE);
    mockStorage.createPayment.mockResolvedValue({ id: 777, ...basePayment() });
    mockSumQuery.mockResolvedValue([{ total: 8000 }]); // already at full season
    mockStorage.getPaymentSchedule.mockResolvedValue({ id: 333, active: true });
    mockStorage.deactivatePaymentSchedule.mockResolvedValue(undefined);
    mockRemoveSchedule.mockResolvedValue(undefined);

    const res = await post('/api/payments', basePayment());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    expect(mockStorage.deactivatePaymentSchedule).not.toHaveBeenCalled();
    expect(mockRemoveSchedule).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/payments/:id', () => {
  it('updates a payment on the happy path → 200', async () => {
    mockStorage.updatePayment.mockResolvedValue({ id: 1, amount: 5000, type: 'cash' });
    const res = await patch('/api/payments/1', { amount: 5000 });
    expect(res.status).toBe(200);
    expect((await res.json()).data.amount).toBe(5000);
    expect(mockHasAccessToPayment).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns 403 for non-admin lacking access', async () => {
    mockHasAccessToPayment.mockResolvedValue(false);
    const res = await patch('/api/payments/1', { amount: 5000 });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(mockStorage.updatePayment).not.toHaveBeenCalled();
  });

  it('skips access check entirely for system_admin', async () => {
    mockStorage.updatePayment.mockResolvedValue({ id: 1, amount: 5000 });
    const res = await patch('/api/payments/1', { amount: 5000 }, SYSADMIN);
    expect(res.status).toBe(200);
    expect(mockHasAccessToPayment).not.toHaveBeenCalled();
  });

  it('returns 404 when the payment does not exist', async () => {
    mockStorage.updatePayment.mockResolvedValue(undefined);
    const res = await patch('/api/payments/1', { amount: 5000 });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('rejects check type without a check number → 400', async () => {
    const res = await patch('/api/payments/1', { type: 'check' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(mockStorage.updatePayment).not.toHaveBeenCalled();
  });

  it('retains operation/allocation-linked evidence on public PATCH', async () => {
    const { PaymentEvidenceImmutableError } = await import('../../server/storage/payments');
    expectErrorLog(/Payment evidence is immutable/);
    mockStorage.updatePayment.mockRejectedValue(new PaymentEvidenceImmutableError());
    const res = await patch('/api/payments/1', { amount: 5000 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('PAYMENT_EVIDENCE_RETAINED');
  });
});

describe('DELETE /api/payments/:id', () => {
  it('deletes a payment on the happy path → 200', async () => {
    mockStorage.getPaymentById.mockResolvedValue({ id: 1, type: 'cash' });
    mockStorage.deletePayment.mockResolvedValue(undefined);
    const res = await del('/api/payments/1');
    expect(res.status).toBe(200);
    expect(mockStorage.deletePayment).toHaveBeenCalledWith(1);
  });

  it('returns 400 for an invalid (non-numeric) id', async () => {
    const res = await del('/api/payments/not-a-number');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
    expect(mockStorage.getPaymentById).not.toHaveBeenCalled();
  });

  it('returns 404 when the payment does not exist', async () => {
    mockStorage.getPaymentById.mockResolvedValue(undefined);
    const res = await del('/api/payments/1');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('blocks non-admin users from deleting card payments → 403', async () => {
    mockStorage.getPaymentById.mockResolvedValue({ id: 1, type: 'credit_card' });
    const res = await del('/api/payments/1', REGULAR_USER);
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/admins/i);
    expect(mockStorage.deletePayment).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin lacking access', async () => {
    mockStorage.getPaymentById.mockResolvedValue({ id: 1, type: 'cash' });
    mockHasAccessToPayment.mockResolvedValue(false);
    const res = await del('/api/payments/1');
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(mockStorage.deletePayment).not.toHaveBeenCalled();
  });

  it('returns a clear 409 when retained dispute evidence blocks deletion', async () => {
    const { PaymentDisputeEvidenceExistsError } = await import('../../server/storage/payments');
    mockStorage.getPaymentById.mockResolvedValue({ id: 1, type: 'cash' });
    mockStorage.deletePayment.mockRejectedValue(new PaymentDisputeEvidenceExistsError());

    const res = await del('/api/payments/1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: 'PAYMENT_DISPUTE_EVIDENCE_EXISTS',
      message: 'Payment cannot be deleted while retained dispute evidence exists',
    });
  });
});

describe('POST /api/payments/:id/refund', () => {
  const cardPayment = {
    id: 50,
    type: 'credit_card',
    status: 'paid',
    amount: 2500,
    leagueId: LEAGUE_OK.id,
    providerPaymentId: 'CHARGE-XYZ',
  };

  it('happy path: prepares and executes one durable refund → 200', async () => {
    mockStorage.getPaymentById.mockResolvedValue({ ...cardPayment, status: 'refunded', squareRefundId: 'RF_1' });

    const res = await post('/api/payments/50/refund', { reason: 'cust' }, ORG_A_USER);
    expect(res.status).toBe(200);
    expect(mockPrepareRefund).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 50,
      reason: 'cust',
      requestedByOrganizationId: 1,
    }));
    expect(mockExecuteRefund).toHaveBeenCalledTimes(1);
    expect(mockRearmOperations).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.status).toBe('refunded');
  });

  it('rejects non-admins → 403', async () => {
    const res = await post('/api/payments/50/refund', {}, REGULAR_USER);
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/admins/i);
    expect(mockPrepareRefund).not.toHaveBeenCalled();
  });

  it('returns 400 when the payment is already refunded', async () => {
    const { RefundPreparationError } = await import('../../server/services/refund-payment-operation-preparation');
    mockPrepareRefund.mockRejectedValue(new RefundPreparationError('Payment has already been refunded', 400, 'ALREADY_REFUNDED'));
    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ALREADY_REFUNDED');
  });

  it('returns 400 when the payment status is not paid', async () => {
    const { RefundPreparationError } = await import('../../server/services/refund-payment-operation-preparation');
    mockPrepareRefund.mockRejectedValue(new RefundPreparationError('Only paid payments can be refunded', 400, 'INVALID_STATUS'));
    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_STATUS');
  });

  it('returns 400 for non-card payment types (e.g. cash)', async () => {
    const { RefundPreparationError } = await import('../../server/services/refund-payment-operation-preparation');
    mockPrepareRefund.mockRejectedValue(new RefundPreparationError('Only card payments can be refunded', 400, 'INVALID_TYPE'));
    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_TYPE');
  });

  it('returns an actionable 422 for a current configuration retry', async () => {
    mockExecuteRefund.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'retry_scheduled',
      providerObjectId: null,
      nextAttemptAt: '2026-01-01T00:15:00.000Z',
      leaseExpiresAt: null,
      attemptCount: 1,
      errorClassification: 'configuration',
      errorCode: 'UNAUTHORIZED',
    });

    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'PROVIDER_NOT_CONFIGURED',
        message: expect.stringMatching(/configuration.*Settings/i),
        details: {
          status: 'retry_scheduled',
          retryAt: '2026-01-01T00:15:00.000Z',
        },
      },
    });
    expect(mockRetryRefundAfterConfiguration).not.toHaveBeenCalled();
  });

  it('reopens a legacy terminal configuration failure and returns 422', async () => {
    mockPrepareRefund.mockResolvedValueOnce({
      operation: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'failed_terminal',
        providerObjectId: null,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        attemptCount: 1,
        errorClassification: 'configuration',
        errorCode: 'PROVIDER_NOT_CONFIGURED',
      },
      snapshot: { organizationId: 1 },
    });
    mockExecuteRefund.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'failed_terminal',
      providerObjectId: null,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      errorClassification: 'configuration',
      errorCode: 'PROVIDER_NOT_CONFIGURED',
    });

    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(mockRetryRefundAfterConfiguration).toHaveBeenCalledWith({
      organizationId: 1,
      operationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(mockStorage.refundPayment).not.toHaveBeenCalled();
  });

  it('returns an actionable 4xx for a hard refund decline', async () => {
    mockExecuteRefund.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'action_required',
      providerObjectId: null,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      errorClassification: 'hard_decline',
      errorCode: 'REFUND_DECLINED',
    });

    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'REFUND_DECLINED',
        message: expect.stringMatching(/declined.*Square/i),
        details: { status: 'action_required' },
      },
    });
  });

  it('returns 202 without claiming success while the retained refund is unresolved', async () => {
    mockExecuteRefund.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'provider_unknown',
      providerObjectId: null,
      nextAttemptAt: '2026-01-01T00:01:00.000Z',
      leaseExpiresAt: null,
      attemptCount: 1,
      errorClassification: 'provider_unknown',
      errorCode: 'TRANSPORT_UNKNOWN',
    });
    const res = await post('/api/payments/50/refund', {});
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { status: 'provider_unknown', attemptCount: 1 },
    });
    expect(mockStorage.getPaymentById).not.toHaveBeenCalled();
  });

  it('returns 400 with INVALID_ID for a non-numeric :id', async () => {
    const res = await post('/api/payments/not-a-number/refund', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});
