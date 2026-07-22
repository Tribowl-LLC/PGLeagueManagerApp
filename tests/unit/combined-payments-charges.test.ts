/**
 * Task #706 — POST /api/payments-provider/combined-payments
 *
 * Verifies the combined-pay endpoint (saved card / new card / Apple Pay /
 * Google Pay) does the following:
 *  - Sum-equals-amount validation (400)
 *  - Per-payee canUserPayForBowler authorization (403 on first denial)
 *  - One provider charge for the full sum + atomic N-row insert with a
 *    shared `combinedChargeGroupId`
 *  - Refund-on-insert-failure when createCombinedPayments throws
 *  - Idempotency-key short-circuit returns the original group's rows
 */
import {
  afterAll, afterEach, beforeAll, beforeEach,
  describe, expect, it, vi,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mockStorage = {
  getLeague: vi.fn(),
  getBowler: vi.fn(),
  isBowlerActiveInLeague: vi.fn(),
  getPayments: vi.fn(),
  getPaymentByIdempotencyKey: vi.fn(),
  getPaymentsByCombinedGroupId: vi.fn(),
  createPayment: vi.fn(),
  createCombinedPayments: vi.fn(),
  updatePaymentScheduleCard: vi.fn(),
  updateBowler: vi.fn(),
};
vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockHasAccessToLeague = vi.fn();
const mockHasAccessToBowler = vi.fn();
vi.mock('../../server/utils/access-control', () => ({
  hasAccessToLeague: (...a: unknown[]) => mockHasAccessToLeague(...a),
  hasAccessToBowler: (...a: unknown[]) => mockHasAccessToBowler(...a),
  isOrgOrHigher: () => true,
}));

vi.mock('../../server/middleware/rate-limit', () => ({
  paymentLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockSquareProvider = {
  providerName: 'square' as const,
  processPayment: vi.fn(),
  createOrderWithPayment: vi.fn(),
  getPayment: vi.fn(),
  saveCardOnFile: vi.fn(),
  refundPayment: vi.fn(),
  validateCardId: vi.fn().mockReturnValue(false),
};
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

vi.mock('../../server/services/payment-execution', () => ({
  computePaymentSplit: () => ({ lineageAmount: 0, prizeFundAmount: 0 }),
  buildLineItems: () => [],
}));

vi.mock('../../server/services/payment-utils', () => ({
  getProviderCustomerId: () => 'cust_xyz',
  ensureProviderCustomer: vi.fn().mockResolvedValue(undefined),
}));

const mockCanUserPayForBowler = vi.fn();
vi.mock('../../server/utils/bowler-payment-authz', () => ({
  canUserPayForBowler: (...a: unknown[]) => mockCanUserPayForBowler(...a),
}));

vi.mock('../../server/routes/payments-provider/shared', () => ({
  getProviderForLeague: vi.fn(),
}));

// eslint-disable-next-line local/factory-must-use-schema -- mocked logger, not a schema row
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../../server/logger', () => ({ logger: fakeLogger, createLogger: () => fakeLogger }));

const chargesRouter = (await import('../../server/routes/payments-provider/charges')).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).user = JSON.parse(raw);
    }
    next();
  });
  app.use('/api/payments-provider', chargesRouter);
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
  mockHasAccessToLeague.mockReset();
  mockHasAccessToBowler.mockReset();
  mockCanUserPayForBowler.mockReset();
  mockGetPaymentProvider.mockReset();
  mockSquareProvider.processPayment.mockReset();
  mockSquareProvider.createOrderWithPayment.mockReset();
  mockSquareProvider.refundPayment.mockReset();
  mockSquareProvider.saveCardOnFile.mockReset();

  mockHasAccessToLeague.mockResolvedValue(true);
  mockHasAccessToBowler.mockResolvedValue(true);
  mockCanUserPayForBowler.mockResolvedValue({ allowed: true, payerBowlerId: 7 });
  mockStorage.getLeague.mockResolvedValue({
    id: 11, organizationId: 1, weeklyFee: 2000, lineageFee: 0, prizeFundFee: 0,
    seasonStart: '2026-01-01', seasonEnd: '2026-04-01', totalBowlingWeeks: 12,
    cancelledDates: [], locationId: 99,
  });
  mockStorage.getPayments.mockResolvedValue([]);
  mockStorage.getPaymentByIdempotencyKey.mockResolvedValue(null);
  // P1 (#737): payees must be actively rostered in the league. Default to
  // rostered; the "not rostered" test overrides with false.
  mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
  mockStorage.getBowler.mockImplementation(async (id: number) => ({
    id, name: `B${id}`, email: id === 7 ? 'pat@example.com' : null,
    organizationId: 1, squareCustomerId: 'cust_xyz',
  }));
  mockStorage.createCombinedPayments.mockImplementation(async (rows: Array<{ bowlerId: number; amount: number }>) =>
    rows.map((r, idx) => ({ id: 100 + idx, bowlerId: r.bowlerId, amount: r.amount })),
  );
  mockGetPaymentProvider.mockResolvedValue(mockSquareProvider);
  mockSquareProvider.processPayment.mockResolvedValue({
    id: 'sq_pay_combo', status: 'COMPLETED',
    receiptUrl: 'https://r/x', receiptNumber: 'RCT', providerRef: {},
  });
});

afterEach(() => vi.clearAllMocks());

const PAYER = { id: 1, role: 'bowler', organizationId: 1, bowlerId: 7 };

async function postCombined(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/payments-provider/combined-payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-user': JSON.stringify(PAYER),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/payments-provider/combined-payments', () => {
  it('rejects when payee amounts do not sum to total amount', async () => {
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 5000,
      payees: [
        { bowlerId: 7, amount: 2000 },
        { bowlerId: 8, amount: 2000 },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toMatch(/sum/i);
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
  });

  it('rejects when any payee fails canUserPayForBowler', async () => {
    mockCanUserPayForBowler
      .mockResolvedValueOnce({ allowed: true, payerBowlerId: 7 })
      .mockResolvedValueOnce({ allowed: false });
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 4000,
      payees: [
        { bowlerId: 7, amount: 2000 },
        { bowlerId: 8, amount: 2000 },
      ],
    });
    expect(res.status).toBe(403);
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
    expect(mockStorage.createCombinedPayments).not.toHaveBeenCalled();
  });

  it('rejects (400 BOWLER_NOT_IN_LEAGUE) when a payee is not rostered in the league', async () => {
    // Payee 8 is accepted by canUserPayForBowler but isn't on this league's roster.
    mockStorage.isBowlerActiveInLeague.mockImplementation(async (bowlerId: number) => bowlerId !== 8);
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 4000,
      payees: [
        { bowlerId: 7, amount: 2000 },
        { bowlerId: 8, amount: 2000 },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error?.code).toBe('BOWLER_NOT_IN_LEAGUE');
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
    expect(mockStorage.createCombinedPayments).not.toHaveBeenCalled();
  });

  it('happy path: ONE charge + atomic N-row insert with shared combinedChargeGroupId', async () => {
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 4000,
      payees: [
        { bowlerId: 7, amount: 2000 },
        { bowlerId: 8, amount: 2000 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockSquareProvider.processPayment).toHaveBeenCalledTimes(1);
    expect(mockSquareProvider.processPayment.mock.calls[0][1]).toBe(4000);
    expect(mockStorage.createCombinedPayments).toHaveBeenCalledTimes(1);
    type InsertedRow = { combinedChargeGroupId: string; bowlerId: number; amount: number; idempotencyKey?: string };
    const insertedRows: InsertedRow[] = mockStorage.createCombinedPayments.mock.calls[0][0];
    expect(insertedRows).toHaveLength(2);
    const groupIds = new Set(insertedRows.map((r) => r.combinedChargeGroupId));
    expect(groupIds.size).toBe(1);
    // Only the first row carries the idempotency key.
    expect(insertedRows[0].idempotencyKey).toBeDefined();
    expect(insertedRows[1].idempotencyKey).toBeUndefined();
    expect(body.combinedChargeGroupId).toBe([...groupIds][0]);
    expect(body.rows).toHaveLength(2);
  });

  it('refunds the provider charge if the per-row insert fails', async () => {
    mockStorage.createCombinedPayments.mockRejectedValueOnce(new Error('db boom'));
    mockSquareProvider.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 4000,
      payees: [
        { bowlerId: 7, amount: 2000 },
        { bowlerId: 8, amount: 2000 },
      ],
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error?.code).toBe('PAYMENT_RECORD_FAILED');
    expect(mockSquareProvider.refundPayment).toHaveBeenCalledWith('sq_pay_combo', 4000);
  });

  it('idempotency-key short-circuit returns the original group rows', async () => {
    mockStorage.getPaymentByIdempotencyKey.mockResolvedValue({
      id: 999,
      providerPaymentId: 'sq_pay_combo',
      combinedChargeGroupId: 'group-abc',
    });
    mockStorage.getPaymentsByCombinedGroupId.mockResolvedValue([
      { id: 100, bowlerId: 7, amount: 2000 },
      { id: 101, bowlerId: 8, amount: 2000 },
    ]);
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 4000,
      payees: [
        { bowlerId: 7, amount: 2000 },
        { bowlerId: 8, amount: 2000 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBe(true);
    expect(body.combinedChargeGroupId).toBe('group-abc');
    expect(body.rows).toHaveLength(2);
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
    expect(mockStorage.createCombinedPayments).not.toHaveBeenCalled();
  });
});
