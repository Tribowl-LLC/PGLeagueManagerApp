import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { League, Payment } from '@shared/schema';
import {
  calculateFinancials,
  calculateBowlerViewFinancials,
  calculateBowlerPastDue,
} from '@/lib/financial-utils';

function isoDate(year: number, month1: number, day: number): string {
  const m = String(month1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function makeLeague(overrides: Partial<League> = {}): League {
  return {
    id: 1,
    name: 'Test League',
    weeklyFee: 3000,
    seasonStart: isoDate(2025, 9, 3),
    seasonEnd: isoDate(2026, 4, 22),
    weekDay: 'Wednesday',
    totalBowlingWeeks: 32,
    skipDates: [],
    cancelledDates: [],
    paymentMode: 'weekly',
    doublePayDates: [],
    ...overrides,
  } as unknown as League;
}

function paid(amount: number, weekOf: string = isoDate(2025, 9, 3)): Payment {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    bowlerId: 1,
    leagueId: 1,
    amount,
    weekOf,
    status: 'paid',
    type: 'cash',
  } as unknown as Payment;
}

function setToday(year: number, month1: number, day: number): void {
  vi.setSystemTime(new Date(year, month1 - 1, day, 12, 0, 0, 0));
}

describe('calculateFinancials — totalDueToDate is capped at fullSeasonAmount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mid-season with no double-pay weeks: charges weekly only', () => {
    const league = makeLeague();
    setToday(2025, 10, 22);

    const result = calculateFinancials(league, []);

    expect(result.totalWeeksInSeason).toBe(32);
    expect(result.fullSeasonAmount).toBe(96000);
    expect(result.weeksPassed).toBe(8);
    expect(result.doublePay.dates).toEqual([]);
    expect(result.doublePay.totalExtra).toBe(0);
    // The current bowling day is due today, not past due, until three hours
    // after the league start time.
    expect(result.totalDueToDate).toBe(7 * 3000);
    expect(result.amountPastDue).toBe(7 * 3000);
  });

  it('changes the current bowling-day payment from due-today to past-due at three hours', () => {
    const league = makeLeague({
      seasonStart: isoDate(2025, 9, 3),
      seasonEnd: isoDate(2025, 9, 10),
      totalBowlingWeeks: 2,
      competitionStartTime: '12:00',
      timezone: 'UTC',
    });
    vi.setSystemTime(new Date('2025-09-03T14:59:59.999Z'));
    expect(calculateFinancials(league, []).amountPastDue).toBe(0);
    expect(calculateBowlerPastDue(league, 0)).toBe(0);

    vi.setSystemTime(new Date('2025-09-03T15:00:00.000Z'));
    expect(calculateFinancials(league, []).amountPastDue).toBe(3000);
    expect(calculateBowlerPastDue(league, 0)).toBe(3000);
  });

  it('two future double-pay dates do NOT inflate fullSeasonAmount (redistribution model)', () => {
    // Double-pay weeks shift dollars forward — they don't add to the
    // season total. A 32-week league with 2 double-pay weeks still
    // totals 32 × $30 = $960, just billed earlier with the last 2
    // regular bowling weeks free.
    const league = makeLeague({
      doublePayDates: [isoDate(2026, 4, 15), isoDate(2026, 4, 22)],
    });
    setToday(2025, 10, 22);

    const result = calculateFinancials(league, []);

    expect(result.fullSeasonAmount).toBe(32 * 3000);
    expect(result.doublePay.totalExtra).toBe(6000); // shifted, not added
    expect(result.doublePay.perWeekExtra).toBe(3000);
    expect(result.doublePay.pastExtra).toBe(0);
    expect(result.totalDueToDate).toBe(7 * 3000);
  });

  it('past double-pay dates roll into pastExtra and totalDueToDate (still capped at fullSeasonAmount)', () => {
    const league = makeLeague({
      doublePayDates: [isoDate(2025, 10, 1), isoDate(2026, 4, 22)],
    });
    setToday(2025, 10, 22);

    const result = calculateFinancials(league, []);

    expect(result.weeksPassed).toBe(8);
    expect(result.doublePay.pastExtra).toBe(3000);
    // Seven completed weeks plus the shifted $30 from the past double-pay
    // date; the current bowling day remains due-today during its grace window.
    // Well below the season cap (32 × $30 = $960), so dueToDate matches raw.
    expect(result.totalDueToDate).toBe(7 * 3000 + 3000);
    expect(result.amountPastDue).toBe(7 * 3000 + 3000);
    expect(result.totalDueToDate).toBeLessThanOrEqual(result.fullSeasonAmount);
  });

  it('season fully completed with full payment: zero past due', () => {
    const league = makeLeague();
    setToday(2026, 4, 23);

    const payments = [paid(96000)];
    const result = calculateFinancials(league, payments);

    expect(result.weeksPassed).toBe(32);
    expect(result.fullSeasonAmount).toBe(96000);
    expect(result.totalDueToDate).toBe(96000);
    expect(result.totalPaid).toBe(96000);
    expect(result.amountPastDue).toBe(0);
    expect(result.remainingBalance).toBe(0);
    expect(result.doublePay.isPaid).toBe(true);
  });

  it('season fully completed with partial payment: past due equals unpaid portion of full season', () => {
    const league = makeLeague();
    setToday(2026, 4, 23);

    const payments = [paid(60000)];
    const result = calculateFinancials(league, payments);

    expect(result.totalDueToDate).toBe(96000);
    expect(result.amountPastDue).toBe(36000);
    expect(result.amountPastDue).toBeLessThanOrEqual(result.fullSeasonAmount);
  });

  it('past season end: totalDueToDate never exceeds fullSeasonAmount even weeks later', () => {
    const league = makeLeague();
    setToday(2026, 6, 1);

    const result = calculateFinancials(league, []);

    expect(result.totalDueToDate).toBe(96000);
    expect(result.totalDueToDate).toBeLessThanOrEqual(result.fullSeasonAmount);
  });
});

describe('upfront-mode parity across helpers (Task #726)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 12 weeks × $12.00 = $144.00 (in cents: 1200 × 12 = 14400) — matches the
  // 12x12 Summer League upfront fixture in production.
  function upfrontLeague(overrides: Partial<League> = {}): League {
    return makeLeague({
      weeklyFee: 1200,
      seasonStart: isoDate(2026, 5, 1),
      seasonEnd: isoDate(2026, 7, 24),
      weekDay: 'Friday',
      totalBowlingWeeks: 12,
      paymentMode: 'upfront',
      ...overrides,
    });
  }

  it('upfront league before week 1: full season is the amount-due-to-date and helpers agree', () => {
    const league = upfrontLeague();
    setToday(2026, 4, 25); // 6 days before season start

    const cf = calculateFinancials(league, []);
    const bv = calculateBowlerViewFinancials(league, []);
    const past = calculateBowlerPastDue(league, 0);

    expect(cf.fullSeasonAmount).toBe(14400);
    expect(bv.fullSeasonAmount).toBe(14400);
    // All three helpers treat the full season as immediately due/past-due
    // for upfront leagues. Pinning the parity here so they cannot drift —
    // a future "don't show past-due before season start" change would need
    // to land in all three call sites together.
    expect(cf.totalDueToDate).toBe(14400);
    expect(bv.totalSeasonDues).toBe(14400);
    expect(cf.amountPastDue).toBe(14400);
    expect(bv.amountPastDue).toBe(14400);
    expect(past).toBe(14400);
  });

  it('upfront league after week 1 unpaid: full season is past due across all helpers', () => {
    const league = upfrontLeague();
    setToday(2026, 5, 8); // 1 week into season

    const cf = calculateFinancials(league, []);
    const bv = calculateBowlerViewFinancials(league, []);
    const past = calculateBowlerPastDue(league, 0);

    expect(cf.totalDueToDate).toBe(14400);
    expect(bv.totalSeasonDues).toBe(14400);
    expect(cf.amountPastDue).toBe(14400);
    expect(bv.amountPastDue).toBe(14400);
    expect(past).toBe(14400);
  });

  it('upfront league after partial payment: remaining balance is past due', () => {
    const league = upfrontLeague();
    setToday(2026, 5, 8);

    const cf = calculateFinancials(league, [paid(5000)]);
    const bv = calculateBowlerViewFinancials(league, [paid(5000)]);
    const past = calculateBowlerPastDue(league, 5000);

    expect(cf.amountPastDue).toBe(14400 - 5000);
    expect(bv.amountPastDue).toBe(14400 - 5000);
    expect(past).toBe(14400 - 5000);
    expect(cf.remainingBalance).toBe(14400 - 5000);
    expect(bv.remainingBalance).toBe(14400 - 5000);
  });

  it('upfront league fully paid: zero past due', () => {
    const league = upfrontLeague();
    setToday(2026, 5, 8);

    const cf = calculateFinancials(league, [paid(14400)]);
    const bv = calculateBowlerViewFinancials(league, [paid(14400)]);
    const past = calculateBowlerPastDue(league, 14400);

    expect(cf.amountPastDue).toBe(0);
    expect(bv.amountPastDue).toBe(0);
    expect(past).toBe(0);
    expect(cf.remainingBalance).toBe(0);
    expect(bv.remainingBalance).toBe(0);
  });

  it('weekly league past season end with double-pay dates: redistribution model — paid full season has $0 past-due', () => {
    // Regression for the Michael Shearer bug, updated for the
    // redistribution model: 32-week season ($30/wk), 2 past double-pay
    // dates, paid $960. Under redistribution the season total stays at
    // $960 (double-pay weeks shift dollars forward — they don't add to
    // the season total), so a fully-paid bowler is paid in full with
    // $0 past-due. Both helpers must agree.
    const league = makeLeague({
      doublePayDates: [isoDate(2026, 4, 8), isoDate(2026, 4, 15)],
    });
    setToday(2026, 5, 8); // ~2 weeks after seasonEnd 2026-04-22

    const totalPaid = 96000;
    const cf = calculateFinancials(league, [paid(totalPaid)]);
    const past = calculateBowlerPastDue(league, totalPaid);

    expect(cf.fullSeasonAmount).toBe(96000);
    expect(cf.totalDueToDate).toBe(96000);
    expect(cf.amountPastDue).toBe(0);
    expect(past).toBe(0);
  });

  it('weekly league mid-season (no regression): bowler-view helper matches calculateFinancials', () => {
    const league = makeLeague(); // weekly mode, 32 weeks at $30
    setToday(2025, 10, 22);

    const cf = calculateFinancials(league, []);
    const bv = calculateBowlerViewFinancials(league, []);

    expect(bv.totalSeasonDues).toBe(cf.totalDueToDate);
    expect(bv.amountPastDue).toBe(cf.amountPastDue);
    expect(bv.fullSeasonAmount).toBe(cf.fullSeasonAmount);
    expect(bv.remainingBalance).toBe(cf.remainingBalance);
  });
});
