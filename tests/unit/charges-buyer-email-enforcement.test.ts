/**
 * Task #503 — verifies that POST /api/payments-provider/payments
 * HARD-ENFORCES a buyer email for interactive Square charges.
 *
 * The route handles user-driven checkouts (sourceId from a card form
 * / Apple Pay / Google Pay), so a human is always present to supply
 * an email when the bowler has none on file. Autopay (the only
 * unattended Square path) lives in payment-execution.ts and is
 * allowed to warn+flag without an email.
 *
 * Coverage:
 *  - Square + bowler.email + no override          -> 200 (uses on-file email)
 *  - Square + no bowler.email + override          -> 200 (uses override)
 *  - Square + no bowler.email + no override       -> 400 BUYER_EMAIL_REQUIRED
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
  createPayment: vi.fn(),
  updatePaymentScheduleCard: vi.fn(),
  updateBowler: vi.fn(),
};
vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockHasAccessToLeague = vi.fn();
const mockHasAccessToBowler = vi.fn();
vi.mock('../../server/utils/access-control', () => ({
  hasAccessToLeague: (...a: unknown[]) => mockHasAccessToLeague(...a),
  hasAccessToBowler: (...a: unknown[]) => mockHasAccessToBowler(...a),
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

vi.mock('../../server/utils/bowler-payment-authz', () => ({
  canUserPayForBowler: vi.fn(async (req: { user?: { bowlerId?: number | null } }) => ({
    allowed: true,
    payerBowlerId: req.user?.bowlerId ?? undefined,
  })),
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
    if (raw) (req as unknown as { user: unknown }).user = JSON.parse(raw);
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
  mockGetPaymentProvider.mockReset();
  for (const provider of [mockSquareProvider]) {
    for (const fn of [provider.processPayment, provider.createOrderWithPayment, provider.getPayment, provider.saveCardOnFile]) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }

  mockHasAccessToLeague.mockResolvedValue(true);
  mockHasAccessToBowler.mockResolvedValue(true);
  mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
  mockStorage.getLeague.mockResolvedValue({
    id: 11, organizationId: 1, weeklyFee: 2000, lineageFee: 0, prizeFundFee: 0,
    seasonStart: '2026-01-01', seasonEnd: '2026-04-01', totalBowlingWeeks: 12,
    cancelledDates: [], locationId: 99,
  });
  mockStorage.getPayments.mockResolvedValue([]);
  mockStorage.getPaymentByIdempotencyKey.mockResolvedValue(null);
  mockStorage.createPayment.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 999, ...input,
  }));
});

afterEach(() => vi.clearAllMocks());

const ADMIN = { id: 1, role: 'org_admin', organizationId: 1, bowlerId: null };

async function postCharge(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/payments-provider/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-user': JSON.stringify(ADMIN),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/payments-provider/payments — buyer email enforcement (Task #503)', () => {
  it('Square + bowler email on file -> 200, no enforcement triggered', async () => {
    mockGetPaymentProvider.mockResolvedValue(mockSquareProvider);
    mockStorage.getBowler.mockResolvedValue({
      id: 7, organizationId: 1, name: 'Pat', email: 'on-file@example.com', squareCustomerId: 'cust_xyz',
    });
    mockSquareProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_a', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_a',
      receiptNumber: 'RCT-A', providerRef: {},
    });

    const res = await postCharge({
      sourceId: 'cnon:tok', amount: 2000, bowlerId: 7, leagueId: 11, storeCard: false,
    });

    expect(res.status).toBe(200);
    expect(mockSquareProvider.processPayment).toHaveBeenCalled();
  });

  it('Square + override email supplied -> 200, processes normally', async () => {
    mockGetPaymentProvider.mockResolvedValue(mockSquareProvider);
    mockStorage.getBowler.mockResolvedValue({
      id: 7, organizationId: 1, name: 'Pat', email: null, squareCustomerId: 'cust_xyz',
    });
    mockSquareProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_b', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_b',
      receiptNumber: 'RCT-B', providerRef: {},
    });

    const res = await postCharge({
      sourceId: 'cnon:tok', amount: 2000, bowlerId: 7, leagueId: 11, storeCard: false,
      buyerEmail: 'override@example.com',
    });

    expect(res.status).toBe(200);
    const callArgs = mockSquareProvider.processPayment.mock.calls[0];
    expect(callArgs[4]).toBe('override@example.com');
  });

  it('Square + NO email anywhere -> 400 BUYER_EMAIL_REQUIRED, charge never sent', async () => {
    mockGetPaymentProvider.mockResolvedValue(mockSquareProvider);
    mockStorage.getBowler.mockResolvedValue({
      id: 7, organizationId: 1, name: 'Pat', email: null, squareCustomerId: 'cust_xyz',
    });

    const res = await postCharge({
      sourceId: 'cnon:tok', amount: 2000, bowlerId: 7, leagueId: 11, storeCard: false,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('BUYER_EMAIL_REQUIRED');
    expect(body.error?.message).toMatch(/buyer email is required/i);
    // Provider must NOT have been invoked.
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
    expect(mockSquareProvider.createOrderWithPayment).not.toHaveBeenCalled();
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
  });

});
