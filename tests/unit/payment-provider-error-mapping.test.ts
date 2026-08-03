import {
  afterAll, afterEach, beforeAll, beforeEach,
  describe, expect, it, vi,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PaymentSchedule } from '@shared/schema';

// --- Shared Mocks ---

const mockStorage = {
  getLeague: vi.fn(),
  getBowler: vi.fn(),
  isBowlerActiveInLeague: vi.fn(),
  getPayments: vi.fn(),
  getPaymentById: vi.fn(),
  getPaymentByIdempotencyKey: vi.fn(),
  createPayment: vi.fn(),
  refundPayment: vi.fn(),
  updatePaymentScheduleCard: vi.fn(),
  updateBowler: vi.fn(),
  getLocationSquareConfig: vi.fn(),
  updatePaymentScheduleFields: vi.fn(),
  deactivatePaymentSchedule: vi.fn(),
};

vi.mock('../../server/storage', () => ({ storage: mockStorage }));

vi.mock('../../server/storage/payment-operations', () => ({
  getLegacyScheduledPaymentCycleBlock: vi.fn().mockResolvedValue(undefined),
}));

// The general interactive charge route is now durable and is covered by its
// own operation/executor tests. Keep this provider-contract suite focused on
// the legacy-client fail-closed boundary and provider adapter mappings.
vi.mock('../../server/services/interactive-payment-operation-executor', () => ({
  interactivePaymentOperationExecutor: { execute: vi.fn() },
}));

const mockHasAccessToLeague = vi.fn();
const mockHasAccessToBowler = vi.fn();
const mockHasAccessToPayment = vi.fn();
vi.mock('../../server/utils/access-control', () => ({
  hasAccessToLeague: (...a: unknown[]) => mockHasAccessToLeague(...a),
  hasAccessToBowler: (...a: unknown[]) => mockHasAccessToBowler(...a),
  hasAccessToPayment: (...a: unknown[]) => mockHasAccessToPayment(...a),
  isOrgOrHigher: (u: { role?: string } | undefined) =>
    u?.role === 'org_admin' || u?.role === 'system_admin',
}));

vi.mock('../../server/middleware/rate-limit', () => ({
  paymentLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockGetPaymentProvider = vi.fn();
vi.mock('../../server/services/payment-provider-factory', async () => {
  const actual = await vi.importActual<
    typeof import('../../server/services/payment-provider-factory')
  >('../../server/services/payment-provider-factory');
  return {
    ...actual,
    getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  };
});

vi.mock('../../server/services/payment-execution', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/payment-execution')>(
    '../../server/services/payment-execution'
  );
  return {
    ...actual,
    computePaymentSplit: () => ({ lineageAmount: 0, prizeFundAmount: 0 }),
    buildLineItems: vi.fn().mockReturnValue([]),
  };
});

vi.mock('../../server/services/payment-utils', () => ({
  getProviderCustomerId: (bowler: { paymentCustomerId?: string }) => bowler.paymentCustomerId,
  ensureProviderCustomer: vi.fn(),
}));

vi.mock('../../server/routes/payments-provider/shared', () => ({
  getProviderForLeague: vi.fn(),
}));

// --- Square SDK Mock ---
const mockPaymentsCreate = vi.fn();
const mockOrdersCreate = vi.fn();
const mockRefundsCreate = vi.fn();
vi.mock('square', async () => {
  const actual = await vi.importActual<typeof import('square')>('square');
  class FakeSquareClient {
    payments = { create: (...a: unknown[]) => mockPaymentsCreate(...a) };
    orders = { create: (...a: unknown[]) => mockOrdersCreate(...a) };
    refunds = { refundPayment: (...a: unknown[]) => mockRefundsCreate(...a) };
  }
  return {
    ...actual,
    SquareClient: FakeSquareClient,
  };
});

// --- Database Mock for Autopay ---
interface DbState {
  league: Record<string, unknown>;
  bowler: Record<string, unknown>;
  insertedRows: Record<string, unknown>[];
}

const dbState: DbState = {
  league: {},
  bowler: {},
  insertedRows: [],
};

vi.mock('../../server/db', async () => {
  const { leagues, bowlers } = await import('@shared/schema');
  return {
    pool: {
      connect: async () => ({
        query: async (text: string) => ({
          rows: [text.includes('pg_try_advisory_lock') ? { acquired: true } : { unlocked: true }],
        }),
        release: vi.fn(),
      }),
    },
    db: {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 333 }]),
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{
                schedule: {
                  id: 333, bowlerId: 42, leagueId: 11, amount: 2000,
                  frequency: 'weekly', paymentCardId: 'card_token_123',
                  nextPaymentDate: '2026-04-22T19:00:00.000Z', active: true,
                  additionalBowlerIds: null, lastPaymentDate: null,
                  createdAt: '2026-04-01T00:00:00.000Z', cancelledAt: null, cancelReason: null,
                },
                league: dbState.league,
              }]),
            }),
          }),
          where: () => {
            const rows =
              table === leagues
                ? [dbState.league]
                : table === bowlers
                  ? [dbState.bowler]
                  : [];
            const p = Promise.resolve(rows);
            return Object.assign(p, { limit: () => Promise.resolve(rows) });
          },
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          dbState.insertedRows.push(v);
          return Promise.resolve();
        },
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    },
  };
});

vi.mock('../../server/services/payment-checks', () => ({
  checkPaidInFull: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../server/utils/league-datetime.js', () => ({
  getNextLeagueDateTime: () => new Date('2026-05-01T19:00:00.000Z'),
}));

// eslint-disable-next-line local/factory-must-use-schema -- mocked logger, not a schema row
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../../server/logger', () => ({ 
  logger: fakeLogger, 
  createLogger: () => fakeLogger 
}));

// --- Imports ---

const chargesRouter = (await import('../../server/routes/payments-provider/charges')).default;
const refundsRouter = (await import('../../server/routes/payments/payment-refunds')).default;
const { processScheduledPaymentJob } = await import('../../server/services/payment-lifecycle');
const {
  PaymentProviderError,
  ProviderNotConfiguredError,
  GENERIC_PAYMENT_USER_MESSAGE,
} = await import('../../server/services/payment-provider-factory');
const { PROVIDER_NOT_CONFIGURED_USER_MESSAGE } = await import(
  '../../server/utils/payment-error-response'
);
const { SquarePaymentProvider } = await import('../../server/services/square-provider');
const { SquareError } = await import('square');
const { buildLineItems } = await import('../../server/services/payment-execution');

// --- Test Setup ---

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) Object.assign(req, { user: JSON.parse(raw) });
    next();
  });
  app.use('/api/payments-provider', chargesRouter);
  app.use('/api/payments', refundsRouter);
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

const mockSquareProvider = {
  providerName: 'square' as const,
  locationId: 99,
  processPayment: vi.fn(),
  createOrderWithPayment: vi.fn(),
  refundPayment: vi.fn(),
  getPayment: vi.fn(),
  saveCardOnFile: vi.fn(),
  validateCardId: vi.fn().mockReturnValue(false),
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(mockStorage)) (fn as ReturnType<typeof vi.fn>).mockReset();
  mockHasAccessToLeague.mockReset().mockResolvedValue(true);
  mockHasAccessToBowler.mockReset().mockResolvedValue(true);
  mockHasAccessToPayment.mockReset().mockResolvedValue(true);
  mockGetPaymentProvider.mockReset();
  mockPaymentsCreate.mockReset();
  mockOrdersCreate.mockReset();
  mockRefundsCreate.mockReset();
  for (const p of [mockSquareProvider]) {
    p.processPayment.mockReset();
    p.createOrderWithPayment.mockReset();
    p.refundPayment.mockReset();
    p.getPayment.mockReset();
    p.saveCardOnFile.mockReset();
    p.validateCardId.mockReset().mockReturnValue(false);
  }

  dbState.insertedRows.length = 0;
  dbState.league = {
    id: 11, organizationId: 1, weeklyFee: 2000, lineageFee: 0, prizeFundFee: 0,
    seasonStart: '2026-01-01', seasonEnd: '2026-04-01', totalBowlingWeeks: 12,
    cancelledDates: [], skipDates: [], doublePayDates: [], locationId: 99,
    paymentMode: 'recurring', timezone: 'America/Chicago', weekDay: 3,
    competitionStartTime: '19:00',
    lineageItemVariationId: null, prizeFundItemVariationId: null,
  };
  dbState.bowler = {
    id: 42, organizationId: 1, name: 'Pat', email: 'pat@example.com',
    paymentCustomerId: 'sq_cust_1',
  };

  mockStorage.getLeague.mockResolvedValue(dbState.league);
  mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
  mockStorage.getBowler.mockResolvedValue(dbState.bowler);
  mockStorage.getPayments.mockResolvedValue([]);
  mockStorage.getPaymentByIdempotencyKey.mockResolvedValue(null);
  mockStorage.createPayment.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 4242, ...input,
  }));
  mockStorage.getLocationSquareConfig.mockResolvedValue({
    accessToken: 'EAAAEsandboxtoken', appId: 'sandbox-sq0idp-abc', locationId: 'L_TEST_123', environment: 'sandbox',
  });

  vi.mocked(buildLineItems).mockReturnValue([]);
});

const ADMIN = { id: 1, role: 'org_admin', organizationId: 1, bowlerId: null };

async function postCharge(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/payments-provider/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(ADMIN) },
    body: JSON.stringify(body),
  });
}

async function postRefund(id: number, body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/payments/${id}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(ADMIN) },
    body: JSON.stringify(body),
  });
}

function squareErr(statusCode: number, detail?: string, code = 'GENERIC_DECLINE') {
  return new SquareError({
    message: 'square error',
    statusCode,
    body: detail
      ? { errors: [{ category: 'PAYMENT_METHOD_ERROR', code, detail }] }
      : { errors: [] },
  });
}

const baseSchedule: PaymentSchedule = {
  id: 333, bowlerId: 42, leagueId: 11, amount: 2000, frequency: 'weekly',
  paymentCardId: 'card_token_123', nextPaymentDate: '2026-04-22T19:00:00.000Z',
  lastPaymentDate: null, active: true, createdAt: '2026-04-01T00:00:00.000Z',
  additionalBowlerIds: null, cancelledAt: null, cancelReason: null,
};

const autopayCallbacks = {
  schedulePayment: vi.fn(),
  cancelJob: vi.fn(),
};

// --- Tests ---

type ProviderInstance = InstanceType<typeof SquarePaymentProvider>;
type ProviderFactory = (locationId: number) => ProviderInstance;

const makeSquare: ProviderFactory = (loc) => new SquarePaymentProvider(loc);
describe.each<[string, typeof mockSquareProvider, ProviderFactory]>([
  ['square', mockSquareProvider, makeSquare],
])('Payment Provider failure harness: %s', (providerName, mockProvider, ProviderClass) => {

  beforeEach(() => {
    mockGetPaymentProvider.mockResolvedValue(mockProvider);
  });

  describe('Provider Layer: Error Mapping', () => {
    it('maps 402 decline to PAYMENT_DECLINED', async () => {
      mockPaymentsCreate.mockRejectedValue(squareErr(402, 'CARD_DECLINED', 'CARD_DECLINED'));

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'PAYMENT_DECLINED',
          disposition: 'action_required',
          providerCode: 'CARD_DECLINED',
          userMessage: 'Your payment was declined. Please try a different card.',
        });
    });

    it('maps 401/403 auth to SYSTEM_ERROR', async () => {
      mockPaymentsCreate.mockRejectedValue(squareErr(401, 'unauthorized', 'UNAUTHORIZED'));

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'SYSTEM_ERROR',
          disposition: 'configuration',
          userMessage: 'Payment system is temporarily unavailable. Please try again later.',
        });
    });

    it('maps 400 validation to INVALID_REQUEST', async () => {
      mockPaymentsCreate.mockRejectedValue(squareErr(400, 'bad amount', 'BAD_REQUEST'));

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'INVALID_REQUEST',
          disposition: 'invalid_request',
          userMessage: expect.stringContaining('Invalid payment information'),
        });
    });

    it('maps ambiguous network/timeout to provider_unknown without changing refunds', async () => {
      const netErr = new TypeError('fetch failed');
      mockPaymentsCreate.mockRejectedValue(netErr);
      mockRefundsCreate.mockRejectedValue(netErr);

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'PAYMENT_FAILED',
          disposition: 'provider_unknown',
        });

      await expect(provider.refundPayment('pay_id', 2000))
        .rejects.toMatchObject({
          code: 'REFUND_FAILED',
        });
    });

    it('classifies Square rate limiting as a definite transient result', async () => {
      mockPaymentsCreate.mockRejectedValue(squareErr(429, 'slow down', 'RATE_LIMITED'));

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'PAYMENT_FAILED',
          disposition: 'transient',
          providerCode: 'RATE_LIMITED',
        });
    });

    it('classifies documented 400 card failures without changing the interactive code', async () => {
      mockPaymentsCreate.mockRejectedValue(squareErr(400, 'expired card', 'CARD_EXPIRED'));

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'INVALID_REQUEST',
          disposition: 'action_required',
          providerCode: 'CARD_EXPIRED',
        });
    });

    it('classifies Square TEMPORARY_ERROR as a definite transient result', async () => {
      mockPaymentsCreate.mockRejectedValue(squareErr(503, 'retry safely', 'TEMPORARY_ERROR'));

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'PAYMENT_FAILED',
          disposition: 'transient',
          providerCode: 'TEMPORARY_ERROR',
        });
    });

    it('classifies documented provider setup failures without changing the interactive code', async () => {
      mockPaymentsCreate.mockRejectedValue(
        squareErr(403, 'card processing disabled', 'CARD_PROCESSING_NOT_ENABLED'),
      );

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toMatchObject({
          code: 'PAYMENT_FAILED',
          disposition: 'configuration',
          providerCode: 'CARD_PROCESSING_NOT_ENABLED',
        });
    });

    it('uses exact pre-derived order/payment keys and immutable provider location', async () => {
      mockOrdersCreate.mockResolvedValue({ order: { id: 'order-original' } });
      mockPaymentsCreate.mockResolvedValue({
        payment: { id: 'payment-original', status: 'COMPLETED' },
      });

      const provider = ProviderClass(99);
      await provider.createOrderWithPayment(
        'source-token',
        2_000,
        [{ catalogObjectId: 'variation-1', quantity: '2' }],
        false,
        'customer-1',
        'buyer@example.test',
        {
          orderKey: 'lv-sq1-o-exact',
          paymentKey: 'lv-sq1-p-exact',
          providerLocationId: 'L_IMMUTABLE',
        },
      );

      expect(mockOrdersCreate).toHaveBeenCalledWith({
        order: {
          locationId: 'L_IMMUTABLE',
          lineItems: [{ catalogObjectId: 'variation-1', quantity: '2' }],
        },
        idempotencyKey: 'lv-sq1-o-exact',
      });
      expect(mockPaymentsCreate).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKey: 'lv-sq1-p-exact',
        locationId: 'L_IMMUTABLE',
        orderId: 'order-original',
      }));
    });

    it('passes through existing PaymentProviderError unchanged', async () => {
      const existing = new PaymentProviderError('already typed', 'INVALID_REQUEST');
      mockPaymentsCreate.mockRejectedValue(existing);

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toSatisfy((e: unknown) => {
          const err = e as { name?: string; code?: string };
          return err.name === 'PaymentProviderError' && err.code === 'INVALID_REQUEST';
        });
    });

    it('never exposes an unsanitized provider code to ledger callers', () => {
      const error = new PaymentProviderError(
        'safe message',
        'bad fallback code',
        undefined,
        { providerCode: '{"raw":"provider-payload"}', disposition: 'internal' },
      );
      expect(error.providerCode).toBe('PROVIDER_ERROR');
    });

    it('passes through ProviderNotConfiguredError unchanged', async () => {
      mockStorage.getLocationSquareConfig.mockResolvedValue({ accessToken: '' });

      const provider = ProviderClass(99);
      await expect(provider.processPayment('tok', 2000, false, 'cust', 'pat@example.com', 'idem'))
        .rejects.toSatisfy((e: unknown) => (e as { name?: string; code?: string }).name === 'ProviderNotConfiguredError');
    });
  });

  describe('Route Layer: Failure Handling', () => {
    it('POST /payments-provider/payments: rejects legacy clients before provider dispatch', async () => {
      mockProvider.processPayment.mockRejectedValue(new PaymentProviderError('declined', 'PAYMENT_DECLINED'));
      
      const res = await postCharge({ sourceId: 'src', amount: 2000, bowlerId: 42, leagueId: 11 });
      expect(res.status).toBe(428);
      const body = await res.json();
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(mockStorage.createPayment).not.toHaveBeenCalled();
    });

    it('POST /api/payments/:id/refund: surfaces failure and does NOT mark row refunded', async () => {
      mockStorage.getPaymentById.mockResolvedValue({
        id: 777,
        amount: 2000,
        status: 'paid',
        type: providerName,
        leagueId: 11,
        providerPaymentId: providerName === 'square' ? 'sq_pay_777' : undefined,
      });
      mockStorage.refundPayment.mockClear();
      mockProvider.refundPayment.mockRejectedValue(new PaymentProviderError('failed', 'INVALID_REQUEST'));

      const res = await postRefund(777);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBeDefined();
      expect(mockStorage.refundPayment).not.toHaveBeenCalled();
    });

    it('does not dispatch an unkeyed legacy charge even when the provider would fail', async () => {
      mockProvider.processPayment.mockRejectedValue(new Error('untyped boom'));
      const res = await postCharge({ sourceId: 'src', amount: 2000, bowlerId: 42, leagueId: 11 });
      expect(res.status).toBe(428);
      const body = await res.json();
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('Autopay Layer: failure persistence', () => {
    it('persists human-readable decline reason in notes', async () => {
      mockProvider.processPayment.mockRejectedValue(new PaymentProviderError('Declined.', 'PAYMENT_DECLINED'));
      
      await processScheduledPaymentJob(baseSchedule, 'job-1', autopayCallbacks);
      const row = dbState.insertedRows[0];
      expect(row.status).toBe('failed');
      expect(row.notes).toBe('Failed payment: Declined.');
    });

    it('persists PNCE message when provider not configured', async () => {
      mockGetPaymentProvider.mockRejectedValue(new ProviderNotConfiguredError('not configured', 99));
      
      await processScheduledPaymentJob(baseSchedule, 'job-2', autopayCallbacks);
      const row = dbState.insertedRows[0];
      expect(row.notes).toBe(`Failed payment: ${PROVIDER_NOT_CONFIGURED_USER_MESSAGE}`);
    });

    it('exercises createOrderWithPayment branch failure', async () => {
      dbState.league.lineageItemVariationId = 'var_1';
      vi.mocked(buildLineItems).mockReturnValue([{ catalogObjectId: 'var_1', quantity: '1' }]);
      mockProvider.createOrderWithPayment.mockRejectedValue(new PaymentProviderError('Order failed.', 'PAYMENT_DECLINED'));

      await processScheduledPaymentJob(baseSchedule, 'job-3', autopayCallbacks);
      const row = dbState.insertedRows[0];
      expect(row.notes).toBe('Failed payment: Order failed.');
      expect(mockProvider.createOrderWithPayment).toHaveBeenCalled();
    });
  });
});

describe('Security: user-facing message scrubbing', () => {
  it('fails closed before a legacy client can send an unsanitized provider outcome', async () => {
    mockSquareProvider.processPayment.mockRejectedValue(
      new PaymentProviderError('{"bad":"json"}\nstacktrace', 'PAYMENT_DECLINED')
    );
    mockGetPaymentProvider.mockResolvedValue(mockSquareProvider);

    const res = await postCharge({ sourceId: 'src', amount: 2000, bowlerId: 42, leagueId: 11 });
    const body = await res.json();
    expect(body.error.message).toContain('out of date');
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
