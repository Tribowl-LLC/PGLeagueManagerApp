import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BowlerLeague, League, Team } from '@shared/schema';
import { LeagueBottomSheet } from '@/components/league-bottom-sheet';

const bowlerLeague = (leagueId: number): BowlerLeague => ({
  id: leagueId,
  bowlerId: 42,
  leagueId,
  teamId: 11,
  active: true,
  order: 0,
  joinedAt: '2026-08-01T00:00:00.000Z',
});

const league = (overrides: Partial<League>): League => ({
  id: 7,
  name: 'Wednesday Night Men\'s League',
  description: null,
  active: true,
  allowPublicSignup: false,
  seasonStart: '2026-08-01T00:00:00.000Z',
  seasonEnd: '2027-03-31T00:00:00.000Z',
  weekDay: 'Wednesday',
  weeklyFee: 2000,
  lineageFee: null,
  prizeFundFee: null,
  practiceStartTime: null,
  competitionStartTime: null,
  squareLineageItemId: null,
  lineageItemVariationId: null,
  squareLineageItemName: null,
  squarePrizeFundItemId: null,
  prizeFundItemVariationId: null,
  squarePrizeFundItemName: null,
  squareCategoryId: null,
  timezone: 'America/New_York',
  paymentMode: 'weekly',
  seasonNumber: 1,
  totalBowlingWeeks: 30,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
  organizationId: 1,
  locationId: null,
  previousSeasonId: null,
  ...overrides,
});

const teamMap = new Map<number, Team>();

function renderSheet(currentLeague: League) {
  return render(
    <LeagueBottomSheet
      open
      onClose={() => undefined}
      activeBowlerLeagues={[bowlerLeague(currentLeague.id)]}
      leagueMap={new Map([[currentLeague.id, currentLeague]])}
      teamMap={teamMap}
      selectedLeagueId={currentLeague.id}
      onSelectLeague={() => undefined}
    />,
  );
}

describe('LeagueBottomSheet season titles', () => {
  it('appends the two-digit season range to the league title', () => {
    renderSheet(league({}));

    expect(screen.getByText("Wednesday Night Men's League 26/27")).toBeInTheDocument();
  });

  it('uses the single year for a season within one calendar year', () => {
    renderSheet(league({
      seasonStart: '2026-03-01T00:00:00.000Z',
      seasonEnd: '2026-06-30T00:00:00.000Z',
    }));

    expect(screen.getByText("Wednesday Night Men's League 26")).toBeInTheDocument();
  });
});
