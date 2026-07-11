import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEEKLY_FEE_CENTS,
  insertBowlerSchema,
  insertLeagueSchema,
  insertPaymentSchema,
  insertTeamSchema,
  insertUserSchema,
} from '../../shared/schema';

describe('Zod 4 migration contracts', () => {
  it('preserves authentication validation issues', () => {
    const result = insertUserSchema.safeParse({
      email: 'operator@example.com',
      name: 'Operator',
      password: 'weak',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['password'] }),
        expect.objectContaining({
          path: ['organizationId'],
          message: 'organizationId is required for non-admin users',
        }),
      ]));
    }
  });

  it('applies form-facing defaults while keeping parsed output complete', () => {
    const bowler = insertBowlerSchema.parse({ name: 'Ada Bowler' });
    const team = insertTeamSchema.parse({
      name: 'Lucky Strikes',
      number: 1,
      leagueId: 10,
    });

    expect(bowler).toMatchObject({ active: true, order: 0 });
    expect(team).toMatchObject({ active: true });
  });

  it('preserves league defaults and date coercion', () => {
    const league = insertLeagueSchema.parse({
      name: 'Monday Mixed',
      seasonStart: '2026-09-07',
      seasonEnd: '2026-12-14',
      weekDay: 'Monday',
    });

    expect(league).toMatchObject({
      active: true,
      paymentMode: 'weekly',
      weeklyFee: DEFAULT_WEEKLY_FEE_CENTS,
    });
    expect(league.seasonStart).toBe('2026-09-07T00:00:00.000Z');
    expect(league.seasonEnd).toBe('2026-12-14T00:00:00.000Z');
  });

  it('preserves payment defaults and parsed submission output', () => {
    const payment = insertPaymentSchema.parse({
      bowlerId: 1,
      leagueId: 2,
      amount: 2500,
      weekOf: '2026-09-07',
      type: 'cash',
    });

    expect(payment).toMatchObject({
      status: 'paid',
      receiptEmailMissing: false,
      weekOf: '2026-09-07T00:00:00.000Z',
    });
  });
});
