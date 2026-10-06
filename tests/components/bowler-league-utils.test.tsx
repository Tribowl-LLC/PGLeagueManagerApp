import { describe, expect, it } from 'vitest';
import type { Bowler, BowlerLeague, League } from '@shared/schema';
import { filterBowlerLeaguesForActiveLeagues, getTeamBowlers } from '@/lib/bowler-league-utils';

describe('filterBowlerLeaguesForActiveLeagues', () => {
  it('keeps only roster associations whose league is active', () => {
    const bowlerLeagues = [
      { leagueId: 10 },
      { leagueId: 20 },
      { leagueId: 30 },
    ];
    const leagueMap = new Map<number, Pick<League, 'active'>>([
      [10, { active: true }],
      [20, { active: false }],
    ]);

    expect(filterBowlerLeaguesForActiveLeagues(bowlerLeagues, leagueMap)).toEqual([
      bowlerLeagues[0],
    ]);
  });
});

describe('getTeamBowlers', () => {
  it('uses saved roster order, newest duplicate membership, and association ID for exact ties', () => {
    const association = (
      id: number,
      bowlerId: number,
      order: number,
      joinedAt: string,
      extras: Partial<BowlerLeague> = {},
    ): BowlerLeague => ({
      id,
      bowlerId,
      leagueId: 7,
      teamId: 5,
      active: true,
      order,
      joinedAt,
      ...extras,
    });
    const bowler = (id: number, name: string): Bowler => ({
      id,
      name,
      email: null,
      phone: null,
      active: true,
      order: 0,
      organizationId: 1,
      paymentCustomerId: null,
      paymentProviderLocationId: null,
      paymentSyncPendingAt: null,
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
      paymentSyncNextRetryAt: null,
    });
    const associations = [
      association(7, 999, 3, '2026-09-02T00:00:00.000Z'),
      association(20, 100, 1, '2026-09-02T00:00:00.000Z'),
      association(98, 400, 0, '2026-09-01T00:00:00.000Z'),
      association(6, 900, 2, '2026-09-03T00:00:00.000Z'),
      association(10, 700, 1, '2026-09-02T00:00:00.000Z'),
      association(40, 200, 2, '2026-09-02T00:00:00.000Z'),
      association(5, 999, 0, '2026-08-01T00:00:00.000Z'),
      association(1, 55, 0, '2026-09-01T00:00:00.000Z', { active: false }),
      association(2, 77, 0, '2026-09-01T00:00:00.000Z', { teamId: 6 }),
    ];
    const bowlers = [
      bowler(100, 'Amy'),
      bowler(200, 'Beta'),
      bowler(400, 'Zara'),
      bowler(700, 'Zoe'),
      bowler(900, 'Alpha'),
      bowler(999, 'Mina'),
    ];

    const entries = getTeamBowlers(associations, bowlers, 5);

    expect(entries.map(({ bowler: currentBowler }) => currentBowler.id)).toEqual([400, 700, 100, 900, 200, 999]);
    expect(entries.map(({ bowlerLeague }) => bowlerLeague.id)).toEqual([98, 10, 20, 6, 40, 7]);
  });
});
