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
import { InteractiveOccurrenceAllocationError } from '../../server/services/interactive-occurrence-allocation';

const mockStorage = {
  getLeague: vi.fn(),
  getBowler: vi.fn(),
  isBowlerActiveInLeague: vi.fn(),
  getPayments: vi.fn(),
  getPaymentByIdempotencyKey: vi.fn(),
  getPaymentsByCombinedGroupId: vi.fn(),
  getGeneralInteractivePaymentOperationForOrganization: vi.fn(),
  createOrGetGeneralInteractivePaymentOperation: vi.fn(),
  persistInteractivePaymentOperationSnapshot: vi.fn(),
  getInteractivePaymentOperationSnapshotForOrganization: vi.fn(),
  getPaymentsByPaymentOperationId: vi.fn(),
  getLocationSquareConfig: vi.fn(),
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

const mockPrepareInteractiveOperation = vi.fn();
const mockInteractiveExecute = vi.fn();
vi.mock('../../server/services/interactive-payment-operation-preparation', () => ({
  prepareInteractivePaymentOperation: (...args: unknown[]) => mockPrepareInteractiveOperation(...args),
}));
vi.mock('../../server/services/interactive-payment-operation-executor', () => ({
  interactivePaymentOperationExecutor: { execute: (...args: unknown[]) => mockInteractiveExecute(...args) },
}));
const { mockNotifyWake } = vi.hoisted(() => ({ mockNotifyWake: vi.fn() }));
vi.mock('../../server/services/scheduled-payment-runtime', () => ({
  notifyScheduledPaymentMutation: (...args: unknown[]) => mockNotifyWake(...args),
}));

const { fakeLogger } = vi.hoisted(() => ({
  fakeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
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
  mockPrepareInteractiveOperation.mockReset();
  mockInteractiveExecute.mockReset();
  mockNotifyWake.mockReset();
  mockNotifyWake.mockResolvedValue(undefined);

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
  mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue(undefined);
  mockStorage.getInteractivePaymentOperationSnapshotForOrganization.mockResolvedValue(undefined);
  mockStorage.getLocationSquareConfig.mockResolvedValue({ locationId: 'SQUARE_TEST' });
  mockPrepareInteractiveOperation.mockImplementation(async (input: { requestKey: string; amountMinor: number; combined: boolean }) => {
    const operation = {
      id: 'operation-combined-test', organizationId: 1, operationType: 'interactive_charge' as const,
      targetKey: `interactive-charge:${input.requestKey}`, paymentScheduleId: null, billingCycleAt: null,
      amountMinor: input.amountMinor, currency: 'USD', requestFingerprint: 'lvpayreq:v1:' + 'a'.repeat(64),
      providerIdempotencyKey: 'lv-op1-ic-test', providerName: 'square', providerObjectId: null,
      providerOrderId: null, status: 'pending' as const, attemptCount: 0, nextAttemptAt: new Date().toISOString(),
      leaseOwner: null, leaseToken: null, leaseExpiresAt: null, leaseRecoveryCount: 0,
      lastLeaseRecoveredAt: null, errorClassification: null, errorCode: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, completedAt: null,
    };
    mockStorage.getPaymentsByPaymentOperationId.mockResolvedValue(input.combined
      ? [
        { id: 100, bowlerId: 7, amount: input.amountMinor / 2, combinedChargeGroupId: operation.id, receiptUrl: null, receiptNumber: null },
        { id: 101, bowlerId: 8, amount: input.amountMinor / 2, combinedChargeGroupId: operation.id, receiptUrl: null, receiptNumber: null },
      ]
      : [{ id: 100, bowlerId: 7, amount: input.amountMinor, combinedChargeGroupId: null, receiptUrl: null, receiptNumber: null }]);
    mockInteractiveExecute.mockResolvedValue({ ...operation, status: 'succeeded', providerObjectId: 'sq_pay_combo' });
    return operation;
  });
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
      'Idempotency-Key': '00000000-0000-4000-8000-000000000003',
      'x-test-user': JSON.stringify(PAYER),
    },
    body: JSON.stringify({ sourceKind: 'new_card', ...body }),
  });
}

describe('POST /api/payments-provider/combined-payments', () => {
  it('maps a stale occurrence preparation to a bounded 409 without provider dispatch', async () => {
    mockPrepareInteractiveOperation.mockRejectedValueOnce(new InteractiveOccurrenceAllocationError('STALE_QUOTE'));
    const res = await postCombined({
      sourceId: 'cnon:tok',
      leagueId: 11,
      amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error?.code).toBe('OCCURRENCE_QUOTE_STALE');
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
  });

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
    expect(mockPrepareInteractiveOperation).toHaveBeenCalledTimes(1);
    expect(mockInteractiveExecute).toHaveBeenCalledTimes(1);
    expect(mockNotifyWake.mock.invocationCallOrder[0]).toBeLessThan(mockInteractiveExecute.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
    expect(mockStorage.createCombinedPayments).not.toHaveBeenCalled();
    expect(body.combinedChargeGroupId).toBe('operation-combined-test');
    expect(body.rows).toHaveLength(2);
  });

  it('does not issue a compensation refund after local finalization is owned by the ledger', async () => {
    mockInteractiveExecute.mockRejectedValueOnce(new Error('db boom'));
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
    expect(mockSquareProvider.refundPayment).not.toHaveBeenCalled();
  });

  it('idempotency-key short-circuit returns the original group rows', async () => {
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
    expect(body.combinedChargeGroupId).toBe('operation-combined-test');
    expect(body.rows).toHaveLength(2);
    expect(mockInteractiveExecute).toHaveBeenCalledTimes(1);
    expect(mockStorage.createCombinedPayments).not.toHaveBeenCalled();
  });
});
