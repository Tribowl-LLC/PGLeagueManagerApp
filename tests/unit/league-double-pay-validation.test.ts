import { describe, it, expect } from 'vitest';
import { insertLeagueSchema, updateLeagueSchema } from '@shared/schema/leagues';

const BASE_VALID = {
  name: 'Test League',
  description: null,
  payingLineupSize: 4,
  active: true,
  allowPublicSignup: false,
  // Wednesday 2026-04-01
  seasonStart: new Date('2026-04-01T00:00:00.000Z'),
  seasonEnd: new Date('2026-06-24T00:00:00.000Z'),
  weekDay: 'Wednesday' as const,
  weeklyFee: 2000,
  lineageFee: null,
  prizeFundFee: null,
  practiceStartTime: undefined,
  competitionStartTime: undefined,
  timezone: 'America/Chicago',
  squareLineageItemId: null,
  lineageItemVariationId: null,
  squareLineageItemName: null,
  squarePrizeFundItemId: null,
  prizeFundItemVariationId: null,
  squarePrizeFundItemName: null,
  squareCategoryId: null,
  locationId: null,
  seasonNumber: 1,
  previousSeasonId: null,
  paymentMode: 'weekly' as const,
  totalBowlingWeeks: null,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
};

describe('insertLeagueSchema doublePayDates validation (Task #646)', () => {
  it('accepts an empty list', () => {
    expect(insertLeagueSchema.safeParse(BASE_VALID).success).toBe(true);
  });

  it('accepts up to 2 valid Wednesday dates inside the season', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      doublePayDates: ['2026-06-10', '2026-06-17'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects double-pay dates for upfront leagues', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      paymentMode: 'upfront',
      doublePayDates: ['2026-06-10'],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('weekly payment timing');
  });

  it('rejects more than 2 dates', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      doublePayDates: ['2026-06-03', '2026-06-10', '2026-06-17'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-ISO date strings', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      doublePayDates: ['06/17/2026'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a date that is not on the league weekday', () => {
    // 2026-06-15 is a Monday; league is Wednesday.
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      doublePayDates: ['2026-06-15'],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('Wednesday');
    }
  });

  it('rejects a date outside the season window', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      doublePayDates: ['2027-01-06'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a date that overlaps a skipDate', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      skipDates: ['2026-06-17'],
      doublePayDates: ['2026-06-17'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a date that overlaps a cancelledDate', () => {
    const r = insertLeagueSchema.safeParse({
      ...BASE_VALID,
      cancelledDates: ['2026-06-17'],
      doublePayDates: ['2026-06-17'],
    });
    expect(r.success).toBe(false);
  });
});

describe('updateLeagueSchema doublePayDates validation (Task #646)', () => {
  it('accepts a partial update with no doublePayDates field', () => {
    const r = updateLeagueSchema.safeParse({ name: 'Renamed' });
    expect(r.success).toBe(true);
  });

  it('accepts a valid doublePayDates partial update including weekDay/season context', () => {
    const r = updateLeagueSchema.safeParse({
      weekDay: 'Wednesday',
      seasonStart: new Date('2026-04-01T00:00:00.000Z'),
      seasonEnd: new Date('2026-06-24T00:00:00.000Z'),
      doublePayDates: ['2026-06-17'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid doublePayDates partial update', () => {
    const r = updateLeagueSchema.safeParse({
      weekDay: 'Wednesday',
      seasonStart: new Date('2026-04-01T00:00:00.000Z'),
      seasonEnd: new Date('2026-06-24T00:00:00.000Z'),
      doublePayDates: ['2026-06-15'], // Monday
    });
    expect(r.success).toBe(false);
  });

  it('rejects an upfront partial update carrying double-pay dates', () => {
    const r = updateLeagueSchema.safeParse({ paymentMode: 'upfront', doublePayDates: ['2026-06-17'] });
    expect(r.success).toBe(false);
  });
});
