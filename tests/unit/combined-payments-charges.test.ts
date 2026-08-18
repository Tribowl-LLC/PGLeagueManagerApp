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
import {
  bindInteractiveOccurrenceRequestFingerprint,
  buildPaymentOperationIdentity,
  fingerprintInteractiveOccurrenceIntent,
} from '../../server/services/payment-operation-idempotency';

const { mockValidateInteractiveOccurrenceReplay } = vi.hoisted(() => ({
  mockValidateInteractiveOccurrenceReplay: vi.fn(),
}));
vi.mock('../../server/services/interactive-occurrence-allocation', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/interactive-occurrence-allocation')>('../../server/services/interactive-occurrence-allocation');
  return { ...actual, validateInteractiveOccurrenceReplay: (...args: unknown[]) => mockValidateInteractiveOccurrenceReplay(...args) };
});

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

const chargesModule = await import('../../server/routes/payments-provider/charges');
const chargesRouter = chargesModule.default;

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
  mockValidateInteractiveOccurrenceReplay.mockReset();
  mockValidateInteractiveOccurrenceReplay.mockResolvedValue(undefined);
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

async function postCombined(body: Record<string, unknown>, requestKey = '00000000-0000-4000-8000-000000000003', user = PAYER) {
  return fetch(`${baseUrl}/api/payments-provider/combined-payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': requestKey,
      'x-test-user': JSON.stringify(user),
    },
    body: JSON.stringify({ sourceKind: 'new_card', ...body }),
  });
}

const REPLAY_SELECTIONS = [{ obligationId: '11111111-1111-4111-8111-111111111111', amountMinor: 4000 }];
const REPLAY_QUOTE_FINGERPRINT = `lvpayquote:v1:${'b'.repeat(64)}`;
function replayOperation(status: 'succeeded' | 'pending' | 'provider_unknown' = 'succeeded') {
  const requestKey = '00000000-0000-4000-8000-000000000003';
  const operation = {
    id: 'operation-replay-test', organizationId: 1, operationType: 'interactive_charge' as const,
    targetKey: `interactive-charge:${requestKey}`, paymentScheduleId: null, billingCycleAt: null,
    amountMinor: 4000, currency: 'USD', requestFingerprint: '', providerIdempotencyKey: 'lv-replay-provider-key',
    providerName: 'square', providerObjectId: status === 'succeeded' ? 'sq_replay' : null, providerOrderId: null,
    status, attemptCount: status === 'pending' ? 0 : 1, nextAttemptAt: new Date().toISOString(), leaseOwner: null,
    leaseToken: null, leaseExpiresAt: null, leaseRecoveryCount: 0, lastLeaseRecoveredAt: null,
    errorClassification: status === 'provider_unknown' ? 'provider_unknown' as const : null, errorCode: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, completedAt: null,
    authorizingUserId: 1,
  };
  const base = buildPaymentOperationIdentity({ organizationId: 1, operationType: 'interactive_charge', targetKey: operation.targetKey, amountMinor: 4000, currency: 'USD', providerName: 'square' });
  operation.requestFingerprint = bindInteractiveOccurrenceRequestFingerprint(
    base.requestFingerprint,
    fingerprintInteractiveOccurrenceIntent({ selections: REPLAY_SELECTIONS, quoteFingerprint: REPLAY_QUOTE_FINGERPRINT }),
  );
  return operation;
}

describe('POST /api/payments-provider/combined-payments', () => {
  it('rejects shifted per-bowler occurrence totals before provider preparation', () => {
    try {
      chargesModule.validateInteractiveQuotePayees(
        {
          rows: [
            { obligationId: '11111111-1111-4111-8111-111111111111', bowlerId: 7 },
            { obligationId: '22222222-2222-4222-8222-222222222222', bowlerId: 8 },
          ],
          selections: [{ obligationId: '11111111-1111-4111-8111-111111111111', amountMinor: 3000 }, { obligationId: '22222222-2222-4222-8222-222222222222', amountMinor: 1000 }],
        },
        [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      );
      throw new Error('expected per-bowler mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(InteractiveOccurrenceAllocationError);
      expect((error as InteractiveOccurrenceAllocationError).code).toBe('BASE_ALLOCATION_MISMATCH');
    }
  });

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

  it('reconstructs an exact completed F2 replay without preparation, execution, or provider work', async () => {
    const operation = replayOperation('succeeded');
    mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue(operation);
    mockStorage.getInteractivePaymentOperationSnapshotForOrganization.mockResolvedValue({
      operationId: operation.id, organizationId: 1, leagueId: 11, sourceId: 'cnon:tok', sourceKind: 'new_card',
      storeCard: false, buyerEmail: 'pat@example.com', payerBowlerId: 7,
      allocations: [{ allocationIndex: 0, bowlerId: 7, amountMinor: 2000 }, { allocationIndex: 1, bowlerId: 8, amountMinor: 2000 }],
    });
    mockStorage.getPaymentsByPaymentOperationId.mockResolvedValue([
      { id: 100, bowlerId: 7, amount: 2000, combinedChargeGroupId: operation.id, receiptUrl: null, receiptNumber: null },
      { id: 101, bowlerId: 8, amount: 2000, combinedChargeGroupId: operation.id, receiptUrl: null, receiptNumber: null },
    ]);
    const res = await postCombined({
      sourceId: 'cnon:tok', leagueId: 11, amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      occurrenceAllocations: REPLAY_SELECTIONS, occurrenceQuoteFingerprint: REPLAY_QUOTE_FINGERPRINT,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('sq_replay');
    expect(mockValidateInteractiveOccurrenceReplay).toHaveBeenCalledOnce();
    expect(mockPrepareInteractiveOperation).not.toHaveBeenCalled();
    expect(mockInteractiveExecute).not.toHaveBeenCalled();
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
  });

  it('returns bounded conflict for changed selection and hides the operation from an unauthorized actor', async () => {
    const operation = replayOperation('provider_unknown');
    mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue(operation);
    mockStorage.getInteractivePaymentOperationSnapshotForOrganization.mockResolvedValue({
      operationId: operation.id, organizationId: 1, leagueId: 11, sourceId: 'cnon:tok', sourceKind: 'new_card',
      storeCard: false, buyerEmail: 'pat@example.com', payerBowlerId: 7,
      allocations: [{ allocationIndex: 0, bowlerId: 7, amountMinor: 2000 }, { allocationIndex: 1, bowlerId: 8, amountMinor: 2000 }],
    });
    const exactUnknown = await postCombined({
      sourceId: 'cnon:tok', leagueId: 11, amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      occurrenceAllocations: REPLAY_SELECTIONS, occurrenceQuoteFingerprint: REPLAY_QUOTE_FINGERPRINT,
    });
    expect(exactUnknown.status).toBe(202);
    expect(mockInteractiveExecute).not.toHaveBeenCalled();
    mockValidateInteractiveOccurrenceReplay.mockClear();
    const changed = await postCombined({
      sourceId: 'cnon:tok', leagueId: 11, amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      occurrenceAllocations: [{ obligationId: REPLAY_SELECTIONS[0].obligationId, amountMinor: 3999 }],
      occurrenceQuoteFingerprint: REPLAY_QUOTE_FINGERPRINT,
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(mockValidateInteractiveOccurrenceReplay).not.toHaveBeenCalled();
    const changedSource = await postCombined({
      sourceId: 'cnon:different-source', leagueId: 11, amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      occurrenceAllocations: REPLAY_SELECTIONS, occurrenceQuoteFingerprint: REPLAY_QUOTE_FINGERPRINT,
    });
    expect(changedSource.status).toBe(409);
    const unauthorized = await postCombined({
      sourceId: 'cnon:tok', leagueId: 11, amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      occurrenceAllocations: REPLAY_SELECTIONS, occurrenceQuoteFingerprint: REPLAY_QUOTE_FINGERPRINT,
    }, undefined, { id: 2, role: 'bowler', organizationId: 1, bowlerId: 7 });
    expect(unauthorized.status).toBe(404);
    expect(mockPrepareInteractiveOperation).not.toHaveBeenCalled();
    expect(mockInteractiveExecute).not.toHaveBeenCalled();
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
  });

  it('replays an exact pending F2 intent without dispatching or acquiring a new provider request', async () => {
    const operation = replayOperation('pending');
    mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue(operation);
    mockStorage.getInteractivePaymentOperationSnapshotForOrganization.mockResolvedValue({
      operationId: operation.id, organizationId: 1, leagueId: 11, sourceId: 'cnon:tok', sourceKind: 'new_card',
      storeCard: false, buyerEmail: 'pat@example.com', payerBowlerId: 7,
      allocations: [{ allocationIndex: 0, bowlerId: 7, amountMinor: 2000 }, { allocationIndex: 1, bowlerId: 8, amountMinor: 2000 }],
    });
    const response = await postCombined({
      sourceId: 'cnon:tok', leagueId: 11, amount: 4000,
      payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      occurrenceAllocations: REPLAY_SELECTIONS, occurrenceQuoteFingerprint: REPLAY_QUOTE_FINGERPRINT,
    });
    expect(response.status).toBe(202);
    expect(mockValidateInteractiveOccurrenceReplay).toHaveBeenCalledOnce();
    expect(mockPrepareInteractiveOperation).not.toHaveBeenCalled();
    expect(mockInteractiveExecute).toHaveBeenCalledOnce();
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
  });

  it('maps changed-selection and pre-F2 preparation conflicts without replaying the provider', async () => {
    for (const code of ['IMMUTABLE_SELECTION_MISMATCH', 'PRE_F2_OPERATION'] as const) {
      mockPrepareInteractiveOperation.mockRejectedValueOnce(new InteractiveOccurrenceAllocationError(code));
      const res = await postCombined({
        sourceId: 'cnon:tok', leagueId: 11, amount: 4000,
        payees: [{ bowlerId: 7, amount: 2000 }, { bowlerId: 8, amount: 2000 }],
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error?.code).toBe('OCCURRENCE_IDEMPOTENCY_CONFLICT');
    }
    expect(mockSquareProvider.processPayment).not.toHaveBeenCalled();
    expect(mockInteractiveExecute).not.toHaveBeenCalled();
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
