import { describe, expect, it } from 'vitest';
import type { League } from '@shared/schema';
import { filterBowlerLeaguesForActiveLeagues } from '@/lib/bowler-league-utils';

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
