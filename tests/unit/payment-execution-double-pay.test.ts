/**
 * Task #646 — `executeScheduledPayment` must charge 2× the league's
 * weekly fee on dates listed in `league.doublePayDates` (compared in
 * the league's local timezone) and the resulting `ChargeResult` must
 * carry a `chargedAmount` so the lifecycle persists the doubled amount
 * — not the schedule's stored `amount` — into the payment row.
 *
 * Also verifies that the no-line-items branch of `executeCharge`
 * returns `chargedAmount` on success: a missing field there used to
 * cause the lifecycle's `paymentResult.chargedAmount ?? scheduleRecord.amount`
 * fallback to silently store the un-doubled amount on autopay leagues
 * with no catalog item ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaymentProvider } from '../../server/services/payment-provider';
import type { PaymentSchedule } from '@shared/schema';
import { leagues, insertLeagueSchema, insertPaymentScheduleSchema } from '@shared/schema';

vi.mock('../../server/logger', () => {
  const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: fakeLogger, createLogger: () => fakeLogger };
});

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

vi.mock('../../server/db', () => {
  // payment-execution selects bowler rows with `.where(...)`
  // (await directly), while `getUserByBowlerId` adds a `.limit(1)` step.
  // Make the mock thenable AND expose `.limit(...)` so both shapes work.
  const rows = [{ email: 'bowler@example.com', paymentCustomerId: 'cust_abc' }];
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            const p = Promise.resolve(rows);
            return Object.assign(p, { limit: () => Promise.resolve(rows) });
          },
        }),
      }),
    },
  };
});

const { executeScheduledPayment, executeCharge } = await import(
  '../../server/services/payment-execution'
);

type League = typeof leagues.$inferSelect;

function makeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  const unused = (name: string) => async () => {
    throw new Error(`stub method ${name} should not be called`);
  };
  const base: PaymentProvider = {
    providerName: 'square',
    locationId: 99,
    processPayment: vi.fn(),
    createOrderWithPayment: vi.fn(),
    refundPayment: unused('refundPayment'),
    saveCardOnFile: unused('saveCardOnFile'),
    listCardsOnFile: unused('listCardsOnFile'),
    disableCard: unused('disableCard'),
    createOrUpdateCustomer: unused('createOrUpdateCustomer'),
    getPayment: unused('getPayment'),
    validateCardId: () => true,
  };
  return Object.assign(base, overrides);
}

// Routed through `insertLeagueSchema.parse(...)` (task #693) so a future
// required column added to `shared/schema/leagues.ts` fails LOUDLY here
// instead of rotting silently behind TypeScript's structural type check.
// The insert schema chains `.refine(...)` / `.superRefine(...)`, so the
// defaults below also have to satisfy: seasonEnd > seasonStart, lineage
// + prize fees sum to weekly, and any double-pay dates fall on a real
// non-skipped weekDay between season bounds.
function makeLeague(overrides: Partial<League> = {}): League {
  // IMPORTANT: overrides are applied AFTER the parse step (not spread
  // into the parse input) so callers can intentionally feed
  // out-of-season `doublePayDates` (or other refine-violating shapes)
  // for the timezone-edge tests below. The schema-walk benefit — a
  // missing required column blowing up the parse — still applies to
  // the defaults block.
  //
  // Defaults must satisfy `insertLeagueSchema`'s refines:
  //   • `seasonEnd > seasonStart`
  //   • `lineageFee + prizeFundFee === weeklyFee`
  //   • `doublePayDates` default to `[]` to avoid the
  //     "must fall within the season" superRefine
  const parsed = insertLeagueSchema.parse({
    name: 'Test League',
    description: null,
    active: true,
    allowPublicSignup: false,
    seasonStart: '2026-01-01',
    seasonEnd: '2026-04-01',
    weekDay: 'Wednesday',
    weeklyFee: 2000,
    lineageFee: 1000,
    prizeFundFee: 1000,
    practiceStartTime: undefined,
    competitionStartTime: '19:00',
    squareLineageItemId: null,
    lineageItemVariationId: null,
    squareLineageItemName: null,
    squarePrizeFundItemId: null,
    prizeFundItemVariationId: null,
    squarePrizeFundItemName: null,
    squareCategoryId: null,
    timezone: 'America/Chicago',
    paymentMode: 'weekly',
    seasonNumber: 1,
    previousSeasonId: null,
    organizationId: 1,
    locationId: 99,
    totalBowlingWeeks: 12,
    skipDates: [],
    cancelledDates: [],
    doublePayDates: [],
  });
  // `id` is omitted from the insert schema; re-add it to satisfy the
  // SELECT type. Overrides win.
  return Object.assign(
    { id: 11 },
    parsed,
    overrides,
  ) as League;
}

// Same pattern for PaymentSchedule. The insert schema omits `id`,
// `createdAt`, `lastPaymentDate`, `cancelledAt`, and `cancelReason`, so
// those are re-added below.
function makeSchedule(overrides: Partial<PaymentSchedule> = {}): PaymentSchedule {
  // Overrides applied after parse — same rationale as `makeLeague`.
  const parsed = insertPaymentScheduleSchema.parse({
    bowlerId: 42,
    leagueId: 11,
    amount: 2000,
    frequency: 'weekly',
    paymentCardId: 'card_token_xyz',
    nextPaymentDate: '2026-04-22T19:00:00.000-05:00',
    active: true,
    additionalBowlerIds: null,
  });
  return Object.assign(
    {
      id: 333,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastPaymentDate: null,
      cancelledAt: null,
      cancelReason: null,
    },
    parsed,
    overrides,
  ) as PaymentSchedule;
}

beforeEach(() => {
  mockGetPaymentProvider.mockReset();
});

describe('executeScheduledPayment — double-pay charging (Task #646)', () => {
  it('charges weeklyFee*2 and returns chargedAmount on a double-pay date (no line items)', async () => {
    const processPayment = vi.fn().mockResolvedValue({
      id: 'sq_pay_dp_1',
      providerRef: {},
    });
    mockGetPaymentProvider.mockResolvedValue(makeProvider({ processPayment }));

    const league = makeLeague({ doublePayDates: ['2026-04-22'] });
    const result = await executeScheduledPayment(makeSchedule(), league, 'job-dp-1');

    expect(result.status).toBe('success');
    expect(result.chargedAmount).toBe(4000);
    expect(processPayment).toHaveBeenCalledTimes(1);
    expect(processPayment.mock.calls[0][1]).toBe(4000);
  });

  it('charges schedule.amount on a non-double-pay date', async () => {
    const processPayment = vi.fn().mockResolvedValue({
      id: 'sq_pay_normal_1',
      providerRef: {},
    });
    mockGetPaymentProvider.mockResolvedValue(makeProvider({ processPayment }));

    const league = makeLeague({ doublePayDates: ['2026-03-25'] });
    const result = await executeScheduledPayment(makeSchedule(), league, 'job-norm-1');

    expect(result.status).toBe('success');
    expect(result.chargedAmount).toBe(2000);
    expect(processPayment).toHaveBeenCalledTimes(1);
    expect(processPayment.mock.calls[0][1]).toBe(2000);
  });

  it('matches double-pay dates in the league timezone (not UTC)', async () => {
    // The schedule fires at 2026-04-23T01:00:00Z, which in
    // America/Chicago is still 2026-04-22 (8pm). The marked
    // double-pay date is 2026-04-22 — the timezone-aware match
    // must still trigger the doubled charge.
    const processPayment = vi.fn().mockResolvedValue({
      id: 'sq_pay_tz_1',
      providerRef: {},
    });
    mockGetPaymentProvider.mockResolvedValue(makeProvider({ processPayment }));

    const tzSchedule = makeSchedule({ nextPaymentDate: '2026-04-23T01:00:00.000Z' });
    const league = makeLeague({ doublePayDates: ['2026-04-22'] });
    const result = await executeScheduledPayment(tzSchedule, league, 'job-tz-1');

    expect(result.chargedAmount).toBe(4000);
    expect(processPayment.mock.calls[0][1]).toBe(4000);
  });
});

describe('executeCharge — chargedAmount contract (Task #646)', () => {
  it('returns chargedAmount on the no-line-items processPayment success branch', async () => {
    const processPayment = vi.fn().mockResolvedValue({
      id: 'sq_pay_nli_1',
      providerRef: {},
    });
    const provider = makeProvider({ processPayment });

    const result = await executeCharge(
      provider,
      'card_token',
      1234,
      [],
      'cust_abc',
      'buyer@example.com',
    );

    expect(result.status).toBe('success');
    expect(result.chargedAmount).toBe(1234);
  });

  it('returns chargedAmount on the createOrderWithPayment success branch', async () => {
    const createOrderWithPayment = vi.fn().mockResolvedValue({
      id: 'sq_pay_li_1',
      providerRef: {},
      receiptUrl: undefined,
      receiptNumber: undefined,
    });
    const provider = makeProvider({ createOrderWithPayment });

    const result = await executeCharge(
      provider,
      'card_token',
      5678,
      [{ catalogObjectId: 'cat_1', quantity: '1' }],
      'cust_abc',
      'buyer@example.com',
    );

    expect(result.status).toBe('success');
    expect(result.chargedAmount).toBe(5678);
  });
});
