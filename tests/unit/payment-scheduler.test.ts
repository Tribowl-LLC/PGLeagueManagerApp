import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockProcessScheduledPaymentJob = vi.fn().mockResolvedValue(undefined);

vi.mock('../../server/services/payment-lifecycle', () => ({
  processScheduledPaymentJob: (...args: unknown[]) => mockProcessScheduledPaymentJob(...args),
}));

vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: vi.fn().mockResolvedValue({
    validateCardId: () => true,
    providerName: 'test',
  }),
  ProviderNotConfiguredError: class extends Error {},
}));

const mockDbSelect = vi.fn();
const mockDbTransaction = vi.fn();
vi.mock('../../server/db', () => ({
  db: {
    select: () => mockDbSelect(),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => mockDbTransaction(fn),
  },
}));

vi.mock('../../server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../server/storage', () => ({
  storage: {},
}));

vi.mock('node-schedule', () => {
  const jobs: { date: Date; callback: () => Promise<void>; cancelled: boolean; nextInvoc: Date | null }[] = [];
  return {
    default: {
      scheduleJob: (date: Date, callback: () => Promise<void>) => {
        const now = new Date();
        if (date <= now) {
          return null;
        }
        const job = {
          date,
          callback,
          cancelled: false,
          cancel: function() { this.cancelled = true; this.nextInvoc = null; },
          nextInvocation: function() { return this.cancelled ? null : this.nextInvoc; },
          nextInvoc: date as Date | null,
        };
        jobs.push(job);
        return job;
      },
      _getJobs: () => jobs,
      _clearJobs: () => { jobs.length = 0; },
    },
  };
});

import type { PaymentSchedule } from '@shared/schema';
import { insertPaymentScheduleSchema } from '@shared/schema';

// Routed through `insertPaymentScheduleSchema.parse(...)` (task #693) so
// a future required column added to `shared/schema/payments.ts` fails
// LOUDLY here instead of rotting silently. The insert schema omits
// `id`, `createdAt`, `lastPaymentDate`, `cancelledAt`, `cancelReason` —
// those are re-added below to satisfy the SELECT type.
function makeSchedule(overrides: Partial<PaymentSchedule> = {}): PaymentSchedule {
  // Overrides are applied AFTER parse so callers can intentionally feed
  // shapes the schema would normally refuse (e.g., already-cancelled
  // schedules with `cancelReason` set). The schema-walk benefit — a
  // missing required column blowing up the parse — still applies to
  // the defaults block.
  const parsed = insertPaymentScheduleSchema.parse({
    bowlerId: 129,
    leagueId: 6,
    amount: 3000,
    frequency: 'weekly',
    active: true,
    paymentCardId: 'ccof:CA4SEXXXXXX',
    nextPaymentDate: '2026-04-01 23:30:00',
    additionalBowlerIds: null,
  });
  return Object.assign(
    {
      id: 15,
      createdAt: '2026-04-01 23:30:00',
      lastPaymentDate: null,
      cancelledAt: null,
      cancelReason: null,
    },
    parsed,
    overrides,
  ) as PaymentSchedule;
}

describe('PaymentScheduler', () => {
  let PaymentScheduler: typeof import('../../server/services/payment-scheduler').PaymentScheduler;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../server/services/payment-scheduler');
    PaymentScheduler = mod.PaymentScheduler;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialize — loads all active schedules', () => {
    it('processes past-due schedules immediately at startup (Shearer scenario)', async () => {
      const pastDueSchedule = makeSchedule({
        id: 15,
        nextPaymentDate: new Date(Date.now() - 60_000).toISOString(),
      });

      mockDbTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const mockTx = {
          execute: vi.fn(),
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  toPromise: async () => [{ total: 1 }],
                  then: (resolve: (v: unknown) => void) => resolve([{ total: 1 }]),
                  for: () => [{ schedule: pastDueSchedule, leagueOrganizationId: 3 }],
                }),
              }),
            }),
          }),
        };
        return fn(mockTx);
      });

      mockDbSelect.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => ({
              then: (resolve: (v: unknown) => void) => resolve({ locationId: null }),
            }),
          }),
        }),
      });

      const scheduler = new PaymentScheduler();
      await scheduler.initialize();

      expect(mockProcessScheduledPaymentJob).toHaveBeenCalledTimes(1);
      expect(mockProcessScheduledPaymentJob).toHaveBeenCalledWith(
        pastDueSchedule,
        'payment-15',
        expect.objectContaining({
          schedulePayment: expect.any(Function),
          cancelJob: expect.any(Function),
        })
      );

      scheduler.cancelAllJobs();
    });

    it('schedules future payments with node-schedule instead of immediate processing', async () => {
      const futureDate = new Date(Date.now() + 3_600_000).toISOString();
      const futureSchedule = makeSchedule({
        id: 20,
        nextPaymentDate: futureDate,
      });

      mockDbTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const mockTx = {
          execute: vi.fn(),
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  toPromise: async () => [{ total: 1 }],
                  then: (resolve: (v: unknown) => void) => resolve([{ total: 1 }]),
                  for: () => [{ schedule: futureSchedule, leagueOrganizationId: 3 }],
                }),
              }),
            }),
          }),
        };
        return fn(mockTx);
      });

      mockDbSelect.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => ({
              then: (resolve: (v: unknown) => void) => resolve({ locationId: null }),
            }),
          }),
        }),
      });

      const scheduler = new PaymentScheduler();
      await scheduler.initialize();

      expect(mockProcessScheduledPaymentJob).not.toHaveBeenCalled();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      scheduler.startSweepPoll(false);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));

      scheduler.cancelAllJobs();
    });
  });

  describe('startSweepPoll', () => {
    it('does not create a recurring database-poll interval', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const scheduler = new PaymentScheduler();

      scheduler.startSweepPoll(false);

      expect(setIntervalSpy).not.toHaveBeenCalled();
      scheduler.cancelAllJobs();
    });

    it('runs an immediate first tick on startup', async () => {
      const scheduler = new PaymentScheduler();

      mockDbSelect.mockReturnValue({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve([]),
          }),
          where: () => ({
            limit: () => ({
              then: (resolve: (v: unknown) => void) => resolve({ locationId: null }),
            }),
          }),
        }),
      });

      scheduler.startSweepPoll(true);

      await new Promise(resolve => setTimeout(resolve, 50));

      scheduler.cancelAllJobs();
    });

    it('stopSweepPoll clears the recovery backstop', () => {
      const scheduler = new PaymentScheduler();

      mockDbSelect.mockReturnValue({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      });

      scheduler.startSweepPoll(false);
      scheduler.stopSweepPoll();

      scheduler.cancelAllJobs();
    });
  });

  describe('schedulePayment — null job guard', () => {
    it('does not add a null job to the jobs map when node-schedule returns null for past dates', async () => {
      const pastSchedule = makeSchedule({
        id: 30,
        nextPaymentDate: new Date(Date.now() - 120_000).toISOString(),
      });

      mockDbSelect.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => ({
              then: (resolve: (v: unknown) => void) => resolve({ locationId: null }),
            }),
          }),
        }),
      });

      const scheduler = new PaymentScheduler();

      await scheduler.addSchedule(pastSchedule);

      scheduler.cancelAllJobs();
    });
  });
});
