/**
 * Task #503 — verifies that POST /api/payments-provider/payments
 * persists Square's hosted-receipt fields and flags charges that ran
 * without a buyer email (no auto-receipt was sent in that case).
 *
 * Coverage:
 *  - bowler with email on file → receiptUrl/receiptNumber persisted,
 *    receiptEmailMissing=false, no warn log.
 *  - bowler with no email + no override → receiptEmailMissing=true,
 *    log.warn fires.
 *  - bowler with no email + request body buyerEmail override →
 *    receiptEmailMissing=false (Square got the email).
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
  getGeneralInteractivePaymentOperationForOrganization: vi.fn(),
  createOrGetGeneralInteractivePaymentOperation: vi.fn(),
  persistInteractivePaymentOperationSnapshot: vi.fn(),
  getInteractivePaymentOperationSnapshotForOrganization: vi.fn(),
  getPaymentsByPaymentOperationId: vi.fn(),
  getLocationSquareConfig: vi.fn(),
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

const mockProvider = {
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
  getProviderCustomerId: () => 'cust_123',
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

const mockPrepareInteractiveOperation = vi.fn();
const mockInteractiveExecute = vi.fn();
vi.mock('../../server/services/interactive-payment-operation-preparation', () => ({
  prepareInteractivePaymentOperation: (...args: unknown[]) => mockPrepareInteractiveOperation(...args),
}));
vi.mock('../../server/services/interactive-payment-operation-executor', () => ({
  interactivePaymentOperationExecutor: { execute: (...args: unknown[]) => mockInteractiveExecute(...args) },
}));

const warnSpy = vi.fn();
// eslint-disable-next-line local/factory-must-use-schema -- mocked logger, not a schema row
const fakeLogger = {
  info: vi.fn(),
  warn: (...a: unknown[]) => warnSpy(...a),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../server/logger', () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));

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
  mockPrepareInteractiveOperation.mockReset();
  mockInteractiveExecute.mockReset();
  warnSpy.mockReset();
  for (const fn of [mockProvider.processPayment, mockProvider.createOrderWithPayment, mockProvider.getPayment, mockProvider.saveCardOnFile]) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }

  mockHasAccessToLeague.mockResolvedValue(true);
  mockHasAccessToBowler.mockResolvedValue(true);
  mockGetPaymentProvider.mockResolvedValue(mockProvider);
  mockStorage.isBowlerActiveInLeague.mockResolvedValue(true);
  mockStorage.getLeague.mockResolvedValue({
    id: 11, organizationId: 1, weeklyFee: 2000, lineageFee: 0, prizeFundFee: 0,
    seasonStart: '2026-01-01', seasonEnd: '2026-04-01', totalBowlingWeeks: 12,
    cancelledDates: [], locationId: 99,
  });
  mockStorage.getPayments.mockResolvedValue([]);
  mockStorage.getPaymentByIdempotencyKey.mockResolvedValue(null);
  mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue(undefined);
  mockStorage.getInteractivePaymentOperationSnapshotForOrganization.mockResolvedValue(undefined);
  mockStorage.getLocationSquareConfig.mockResolvedValue({ locationId: 'SQUARE_TEST' });
  mockStorage.getPaymentsByPaymentOperationId.mockResolvedValue([
    { id: 1234, bowlerId: 42, amount: 2000, combinedChargeGroupId: null, receiptUrl: 'https://square.test/receipt', receiptNumber: 'RCT' },
  ]);
  mockPrepareInteractiveOperation.mockImplementation(async (input: { requestKey: string; amountMinor: number }) => {
    const operation = {
      id: 'operation-receipt-test', organizationId: 1, operationType: 'interactive_charge' as const,
      targetKey: `interactive-charge:${input.requestKey}`, paymentScheduleId: null, billingCycleAt: null,
      amountMinor: input.amountMinor, currency: 'USD', requestFingerprint: 'lvpayreq:v1:' + 'a'.repeat(64),
      providerIdempotencyKey: 'lv-op1-ic-test', providerName: 'square', providerObjectId: null,
      providerOrderId: null, status: 'pending' as const, attemptCount: 0, nextAttemptAt: new Date().toISOString(),
      leaseOwner: null, leaseToken: null, leaseExpiresAt: null, leaseRecoveryCount: 0,
      lastLeaseRecoveredAt: null, errorClassification: null, errorCode: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, completedAt: null,
    };
    mockInteractiveExecute.mockResolvedValue({ ...operation, status: 'succeeded', providerObjectId: 'sq_pay_test' });
    return operation;
  });
  mockStorage.createPayment.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 1234, ...input,
  }));
});

afterEach(() => vi.clearAllMocks());

const ADMIN = { id: 1, role: 'org_admin', organizationId: 1, bowlerId: null };
const SELF_BOWLER_USER = { id: 7, role: 'bowler', organizationId: 1, bowlerId: 42 };

async function postCharge(
  body: Record<string, unknown>,
  user: typeof ADMIN | typeof SELF_BOWLER_USER = ADMIN,
) {
  return fetch(`${baseUrl}/api/payments-provider/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': '00000000-0000-4000-8000-000000000002',
      'x-test-user': JSON.stringify(user),
    },
    body: JSON.stringify({ sourceKind: 'new_card', ...body }),
  });
}

describe('POST /api/payments-provider/payments — receipt persistence (Task #503)', () => {
  it('persists receiptUrl/receiptNumber and clears receiptEmailMissing when bowler has email', async () => {
    mockStorage.getBowler.mockResolvedValue({
      id: 42, organizationId: 1, name: 'Pat', email: 'pat@example.com', squareCustomerId: 'cust_123',
    });
    mockProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_1',
      status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_1',
      receiptNumber: 'XYZ-001',
      providerRef: {},
    });

    const res = await postCharge({
      sourceId: 'cnon:tok_abc', amount: 2000, bowlerId: 42, leagueId: 11, storeCard: false,
    });

    expect(res.status).toBe(200);
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'sq_pay_test',
      receiptUrl: 'https://square.test/receipt',
      receiptNumber: 'RCT',
      status: 'COMPLETED',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Task #503 (2nd-pass review): the interactive route now HARD-ENFORCES
  // a buyer email for Square via BUYER_EMAIL_REQUIRED, so the
  // "no email + no override" path never reaches the persistence layer
  // here. The unattended autopay variant (warn+flag) is covered in
  // tests/unit/payment-execution-receipt-warn.test.ts, and the
  // enforcement itself is covered in
  // tests/unit/charges-buyer-email-enforcement.test.ts.

  it('clears receiptEmailMissing when request body provides a buyerEmail override', async () => {
    mockStorage.getBowler.mockResolvedValue({
      id: 42, organizationId: 1, name: 'Pat', email: null, squareCustomerId: 'cust_123',
    });
    mockProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_3', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_3',
      receiptNumber: 'XYZ-003',
      providerRef: {},
    });

    const res = await postCharge({
      sourceId: 'cnon:tok_ghi', amount: 2000, bowlerId: 42, leagueId: 11, storeCard: false,
      buyerEmail: '  override@example.com  ',
    });

    expect(res.status).toBe(200);
    expect(mockStorage.createPayment).not.toHaveBeenCalled();
    expect((await res.json()).status).toBe('COMPLETED');
    expect(warnSpy).not.toHaveBeenCalled();

    // The trimmed override email must be threaded into the provider call.
    expect(mockPrepareInteractiveOperation.mock.calls[0][0]).toMatchObject({ buyerEmail: 'override@example.com' });
  });

  it('backfills bowler.email on self-checkout when no email was on file', async () => {
    mockStorage.getBowler.mockResolvedValue({
      id: 42, organizationId: 1, name: 'Pat', email: null, squareCustomerId: 'cust_123',
    });
    mockProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_4', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_4',
      receiptNumber: 'XYZ-004',
      providerRef: {},
    });

    const res = await postCharge(
      {
        sourceId: 'cnon:tok_jkl', amount: 2000, bowlerId: 42, leagueId: 11, storeCard: false,
        buyerEmail: 'me@example.com',
      },
      SELF_BOWLER_USER,
    );

    expect(res.status).toBe(200);
    expect(mockStorage.updateBowler).toHaveBeenCalledWith(42, { email: 'me@example.com' });
  });

  it('does NOT backfill bowler.email when an admin supplies a buyerEmail (not self-checkout)', async () => {
    mockStorage.getBowler.mockResolvedValue({
      id: 42, organizationId: 1, name: 'Pat', email: null, squareCustomerId: 'cust_123',
    });
    mockProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_5', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_5',
      receiptNumber: 'XYZ-005',
      providerRef: {},
    });

    const res = await postCharge({
      sourceId: 'cnon:tok_mno', amount: 2000, bowlerId: 42, leagueId: 11, storeCard: false,
      buyerEmail: 'admin-typed@example.com',
    });

    expect(res.status).toBe(200);
    expect(mockStorage.updateBowler).not.toHaveBeenCalled();
  });

  it('does NOT backfill bowler.email when bowler already has an email on file', async () => {
    mockStorage.getBowler.mockResolvedValue({
      id: 42, organizationId: 1, name: 'Pat', email: 'existing@example.com', squareCustomerId: 'cust_123',
    });
    mockProvider.processPayment.mockResolvedValue({
      id: 'sq_pay_6', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_6',
      receiptNumber: 'XYZ-006',
      providerRef: {},
    });

    const res = await postCharge(
      {
        sourceId: 'cnon:tok_pqr', amount: 2000, bowlerId: 42, leagueId: 11, storeCard: false,
        buyerEmail: 'different@example.com',
      },
      SELF_BOWLER_USER,
    );

    expect(res.status).toBe(200);
    expect(mockStorage.updateBowler).not.toHaveBeenCalled();
  });
});
