/**
 * Task #706 — combined autopay must:
 *  - Validate accepted partners up front; drop revoked links.
 *  - Charge the provider ONCE for base × (1 + valid partners).
 *  - Insert N+1 per-bowler payment rows atomically with a shared
 *    `combinedChargeGroupId` (no per-partner secondary charges).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertedRows: Record<string, unknown>[] = [];

// eslint-disable-next-line local/factory-must-use-schema -- mocked db transaction, not a schema row
const fakeTx = {
  execute: () => Promise.resolve({
    rows: [{ transaction_time: '2026-04-22T20:00:00.000Z' }],
  }),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([]),
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  insert: () => ({
    values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
      if (Array.isArray(v)) {
        for (const row of v) insertedRows.push(row);
      } else {
        insertedRows.push(v);
      }
      return Promise.resolve();
    },
  }),
};

const partnerBowlerLookup: Record<number, { id: number; organizationId: number | null }> = {
  77: { id: 77, organizationId: 1 },
  78: { id: 78, organizationId: 1 },
  // Bowler 79 lives in a different org — must be dropped.
  79: { id: 79, organizationId: 2 },
};

vi.mock('../../server/db', () => ({
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
          returning: () => Promise.resolve([{ id: 1 }]),
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
                frequency: 'weekly', paymentCardId: 'card_token_abcdef',
                nextPaymentDate: '2026-04-22T19:00:00.000Z', active: true,
                additionalBowlerIds: [77, 78], lastPaymentDate: null,
                createdAt: '2026-04-01T00:00:00.000Z', cancelledAt: null, cancelReason: null,
              },
              league: {
                id: 11, organizationId: 1, weeklyFee: 2000,
                lineageFee: 0, prizeFundFee: 0,
                seasonStart: '2026-01-01', seasonEnd: '2026-04-01',
                totalBowlingWeeks: 12, cancelledDates: [], skipDates: [],
                paymentMode: 'recurring', timezone: 'America/Chicago',
                weekDay: 3, competitionStartTime: '19:00',
              },
            }]),
          }),
        }),
        where: () => {
          // Tag-detect bowlers vs leagues table from the Drizzle symbol.
          const sym = Object.getOwnPropertySymbols(table as object)
            .find((s) => s.toString().includes('Name'));
          const tableName = sym ? (table as Record<symbol, unknown>)[sym] : undefined;
          if (tableName === 'bowlers') {
            // Org-1 stub bowler so org-match passes for every partner;
            // partner revocation is steered by `arePartners` instead.
            return Promise.resolve([{ id: 0, organizationId: 1, email: 'x@example.com' }]);
          }
          return Promise.resolve([{
            id: 11, organizationId: 1, weeklyFee: 2000,
            lineageFee: 0, prizeFundFee: 0,
            seasonStart: '2026-01-01', seasonEnd: '2026-04-01',
            totalBowlingWeeks: 12, cancelledDates: [], skipDates: [],
            paymentMode: 'recurring', timezone: 'America/Chicago',
            weekDay: 3, competitionStartTime: '19:00',
          }]);
        },
      }),
    }),
    transaction: async (fn: (tx: typeof fakeTx) => Promise<void>) => fn(fakeTx),
  },
}));

const mockExecuteScheduled = vi.fn();
vi.mock('../../server/services/payment-execution', () => ({
  executeScheduledPayment: (...a: unknown[]) => mockExecuteScheduled(...a),
  computePaymentSplit: () => ({ lineageAmount: 0, prizeFundAmount: 0 }),
  buildScheduledChargePlan: (schedule: { amount: number }, _league: unknown, extras: number) => ({
    amountMinor: schedule.amount * (1 + extras),
    allocationAmountMinor: schedule.amount,
    isDoublePay: false,
    lineItems: [],
  }),
}));

vi.mock('../../server/services/payment-checks', () => ({
  checkPaidInFull: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    updatePaymentScheduleFields: vi.fn(),
    deactivatePaymentSchedule: vi.fn(),
  },
}));

vi.mock('../../server/storage/users', () => ({
  getUserByBowlerId: vi.fn().mockResolvedValue({ id: 4242 }),
}));

const mockArePartners = vi.fn();
vi.mock('../../server/storage/bowler-payment-links', () => ({
  arePartners: (...a: unknown[]) => mockArePartners(...a),
}));

vi.mock('../../server/storage/payment-operations', () => ({
  getLegacyScheduledPaymentCycleBlock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/utils/league-datetime.js', () => ({
  getNextLeagueDateTime: () => new Date('2026-05-01T19:00:00.000Z'),
}));

const mockRefundPayment = vi.fn();
const mockGetPaymentProvider = vi.fn();
class FakeProviderNotConfiguredError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ProviderNotConfiguredError'; }
}
vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  ProviderNotConfiguredError: FakeProviderNotConfiguredError,
}));

vi.mock('../../server/logger', () => {
  const fake = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: fake, createLogger: () => fake };
});

const { processScheduledPaymentJob } = await import('../../server/services/payment-lifecycle');

const baseSchedule: Parameters<typeof processScheduledPaymentJob>[0] = {
  id: 333,
  bowlerId: 42,
  leagueId: 11,
  amount: 2000,
  frequency: 'weekly',
  paymentCardId: 'card_token_abcdef',
  nextPaymentDate: '2026-04-22T19:00:00.000Z',
  nextOccurrenceId: null,
  lastPaymentDate: null,
  active: true,
  additionalBowlerIds: [77, 78],
  createdAt: '2026-04-01T00:00:00.000Z',
  cancelledAt: null,
  cancelReason: null,
};

const callbacks = {
  schedulePayment: vi.fn(),
  cancelJob: vi.fn(),
};

beforeEach(() => {
  insertedRows.length = 0;
  mockExecuteScheduled.mockReset();
  mockArePartners.mockReset();
  mockRefundPayment.mockReset();
  mockGetPaymentProvider.mockReset();
  mockGetPaymentProvider.mockResolvedValue({
    refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
  });
  callbacks.schedulePayment.mockReset();
  callbacks.cancelJob.mockReset();
});

describe('processScheduledPaymentJob — combined autopay (Task #706)', () => {
  it('runs ONE charge for base × (1+N) and writes N+1 rows sharing a groupId', async () => {
    mockArePartners.mockResolvedValue(true);
    // executeScheduledPayment receives extraPayeeCount; the test
    // returns the multiplied chargedAmount the lifecycle would split
    // back per-bowler.
    mockExecuteScheduled.mockImplementation(async (
      _schedule: unknown,
      _league: unknown,
      _jobId: unknown,
      extraPayeeCount: number,
    ) => ({
      status: 'success',
      paymentId: 'sq_pay_combined_1',
      providerName: 'square',
      receiptUrl: 'https://r/x',
      receiptNumber: 'RCT',
      buyerEmailMissing: false,
      providerRef: {},
      chargedAmount: 2000 * (1 + extraPayeeCount),
    }));

    await processScheduledPaymentJob(baseSchedule, 'job-combo', callbacks);

    expect(mockExecuteScheduled).toHaveBeenCalledTimes(1);
    expect(mockExecuteScheduled.mock.calls[0][3]).toBe(2);

    expect(insertedRows).toHaveLength(3);
    const groupIds = new Set(insertedRows.map((r) => r.combinedChargeGroupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBeTruthy();

    const bowlerIds = insertedRows.map((r) => r.bowlerId).sort();
    expect(bowlerIds).toEqual([42, 77, 78]);

    for (const r of insertedRows) {
      expect(r.providerPaymentId).toBe('sq_pay_combined_1');
      expect(r.amount).toBe(2000);
      expect(r.status).toBe('paid');
    }
  });

  it('refunds the provider charge when the per-bowler row insert fails (atomicity)', async () => {
    mockArePartners.mockResolvedValue(true);
    mockExecuteScheduled.mockImplementation(async (
      _s: unknown, _l: unknown, _j: unknown, extraPayeeCount: number,
    ) => ({
      status: 'success',
      paymentId: 'sq_pay_combined_atomic',
      providerName: 'square',
      providerRef: {},
      chargedAmount: 2000 * (1 + extraPayeeCount),
    }));

    // Force the row insert to throw inside the transaction so the
    // compensation path runs.
    const originalValues = fakeTx.insert;
    let callCount = 0;
    fakeTx.insert = () => ({
      values: () => {
        callCount += 1;
        return Promise.reject(new Error('db down: insert failed'));
      },
    });

    await processScheduledPaymentJob(baseSchedule, 'job-atomic-fail', callbacks);

    fakeTx.insert = originalValues;

    expect(callCount).toBeGreaterThan(0);
    expect(mockGetPaymentProvider).toHaveBeenCalledTimes(1);
    expect(mockRefundPayment).toHaveBeenCalledTimes(1);
    // Refund must target the provider charge id and the FULL combined
    // chargedAmount (base × (1 + N) = 2000 × 3 = 6000).
    expect(mockRefundPayment.mock.calls[0][0]).toBe('sq_pay_combined_atomic');
    expect(mockRefundPayment.mock.calls[0][1]).toBe(6000);
  });

  it('drops a partner whose link is no longer accepted', async () => {
    mockArePartners.mockImplementation(async (_self: number, partnerId: number) => partnerId !== 78);
    mockExecuteScheduled.mockImplementation(async (
      _s: unknown, _l: unknown, _j: unknown, extraPayeeCount: number,
    ) => ({
      status: 'success',
      paymentId: 'sq_pay_combined_2',
      providerName: 'square',
      providerRef: {},
      chargedAmount: 2000 * (1 + extraPayeeCount),
    }));

    await processScheduledPaymentJob(baseSchedule, 'job-revoked', callbacks);

    expect(mockExecuteScheduled.mock.calls[0][3]).toBe(1);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows.map((r) => r.bowlerId).sort()).toEqual([42, 77]);
  });
});
