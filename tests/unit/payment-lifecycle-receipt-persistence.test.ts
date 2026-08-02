/**
 * Task #503 — autopay/scheduled charges must persist Square's
 * `receiptUrl` / `receiptNumber` and the `receiptEmailMissing` flag
 * the same way the one-off charge route does. The autopay path lives
 * in `server/services/payment-lifecycle.ts::handleSuccessfulPayment`,
 * which writes through `tx.insert(payments).values(...)` directly.
 *
 * This test drives the public entrypoint `processScheduledPaymentJob`
 * with a mocked DB transaction, captures the values passed to
 * `tx.insert(payments).values(...)`, and asserts the receipt fields
 * are propagated for Square with and without a buyer email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertedRows: Record<string, unknown>[] = [];

// eslint-disable-next-line local/factory-must-use-schema -- mocked db transaction, not a schema row
const fakeTx = {
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
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve([{
              schedule: {
                id: 333, bowlerId: 42, leagueId: 11, amount: 2000,
                frequency: 'weekly', paymentCardId: 'card_token_abcdef',
                nextPaymentDate: '2026-04-22T19:00:00.000Z', active: true,
                additionalBowlerIds: null, lastPaymentDate: null,
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
        where: () => Promise.resolve([{
          id: 11, organizationId: 1, weeklyFee: 2000,
          lineageFee: 0, prizeFundFee: 0,
          seasonStart: '2026-01-01', seasonEnd: '2026-04-01',
          totalBowlingWeeks: 12, cancelledDates: [], skipDates: [],
          paymentMode: 'recurring', timezone: 'America/Chicago',
          weekDay: 3, competitionStartTime: '19:00',
        }]),
      }),
    }),
    transaction: async (fn: (tx: typeof fakeTx) => Promise<void>) => fn(fakeTx),
  },
}));

const mockExecuteScheduled = vi.fn();
vi.mock('../../server/services/payment-execution', () => ({
  executeScheduledPayment: (...a: unknown[]) => mockExecuteScheduled(...a),
  computePaymentSplit: () => ({ lineageAmount: 0, prizeFundAmount: 0 }),
  buildScheduledChargePlan: (schedule: { amount: number }) => ({
    amountMinor: schedule.amount,
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

vi.mock('../../server/storage/payment-operations', () => ({
  getLegacyScheduledPaymentCycleBlock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/utils/league-datetime.js', () => ({
  getNextLeagueDateTime: () => new Date('2026-05-01T19:00:00.000Z'),
}));

vi.mock('../../server/logger', () => {
  const fake = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: fake, createLogger: () => fake };
});

const { processScheduledPaymentJob } = await import('../../server/services/payment-lifecycle');

const baseSchedule = {
  id: 333,
  bowlerId: 42,
  leagueId: 11,
  amount: 2000,
  frequency: 'weekly' as const,
  paymentCardId: 'card_token_abcdef',
  nextPaymentDate: '2026-04-22T19:00:00.000Z',
  lastPaymentDate: null,
  active: true,
  organizationId: 1,
} as unknown as Parameters<typeof processScheduledPaymentJob>[0];

const callbacks = {
  schedulePayment: vi.fn(),
  cancelJob: vi.fn(),
};

beforeEach(() => {
  insertedRows.length = 0;
  mockExecuteScheduled.mockReset();
  callbacks.schedulePayment.mockReset();
  callbacks.cancelJob.mockReset();
});

describe('processScheduledPaymentJob — autopay receipt persistence (Task #503)', () => {
  it('persists receiptUrl/receiptNumber and receiptEmailMissing=false for Square autopay with buyer email', async () => {
    mockExecuteScheduled.mockResolvedValue({
      status: 'success',
      paymentId: 'sq_pay_auto_1',
      providerName: 'square',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_auto_1',
      receiptNumber: 'AUTO-001',
      buyerEmailMissing: false,
      providerRef: {},
    });

    await processScheduledPaymentJob(baseSchedule, 'job-1', callbacks);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      providerPaymentId: 'sq_pay_auto_1',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_auto_1',
      receiptNumber: 'AUTO-001',
      receiptEmailMissing: false,
    });
  });

  it('flags receiptEmailMissing=true for Square autopay with no buyer email', async () => {
    mockExecuteScheduled.mockResolvedValue({
      status: 'success',
      paymentId: 'sq_pay_auto_2',
      providerName: 'square',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_auto_2',
      receiptNumber: 'AUTO-002',
      buyerEmailMissing: true,
      providerRef: {},
    });

    await processScheduledPaymentJob(baseSchedule, 'job-2', callbacks);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].receiptEmailMissing).toBe(true);
    expect(insertedRows[0].receiptUrl).toBe('https://squareup.com/receipt/preview/sq_pay_auto_2');
  });

});
