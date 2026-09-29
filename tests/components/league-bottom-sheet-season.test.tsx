import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BowlerLeague, League, Team } from '@shared/schema';
import { LeagueBottomSheet } from '@/components/league-bottom-sheet';
import { LeagueSwitcherSheet } from '@/components/league-switcher-sheet';

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
  return renderSheetForLeagues([currentLeague]);
}

function renderSheetForLeagues(currentLeagues: League[]) {
  return render(
    <LeagueBottomSheet
      open
      onClose={() => undefined}
      activeBowlerLeagues={currentLeagues.map((currentLeague) => bowlerLeague(currentLeague.id))}
      leagueMap={new Map(currentLeagues.map((currentLeague) => [currentLeague.id, currentLeague]))}
      teamMap={teamMap}
      selectedLeagueId={currentLeagues[0]?.id ?? null}
      onSelectLeague={() => undefined}
    />,
  );
}

function renderSwitcherForLeagues(currentLeagues: League[]) {
  return render(
    <LeagueSwitcherSheet
      open
      onClose={() => undefined}
      bowlerLeagues={currentLeagues.map((currentLeague) => bowlerLeague(currentLeague.id))}
      leagueMap={new Map(currentLeagues.map((currentLeague) => [currentLeague.id, currentLeague]))}
      teamMap={teamMap}
      selectedLeagueId={currentLeagues[0]?.id ?? null}
      onSelect={() => undefined}
    />,
  );
}

const sameNamedSeasonLeagues = [
  league({ id: 7 }),
  league({
    id: 8,
    seasonStart: '2027-08-01T00:00:00.000Z',
    seasonEnd: '2028-03-31T00:00:00.000Z',
  }),
];

describe('LeagueBottomSheet season titles', () => {
  it('appends the two-digit season range to the league title', () => {
    const { container } = renderSheet(league({}));
    const expectedTitle = "Wednesday Night Men's League 26/27";

    expect(container.querySelector('.familiar-league-switcher-name .familiar-league-switcher-title-mobile')).toHaveTextContent(expectedTitle);
    expect(container.querySelector('.familiar-league-switcher-name .familiar-league-switcher-title-desktop')).toHaveTextContent(expectedTitle);
  });

  it('uses the single year for a season within one calendar year', () => {
    const { container } = renderSheet(league({
      seasonStart: '2026-03-01T00:00:00.000Z',
      seasonEnd: '2026-06-30T00:00:00.000Z',
    }));
    const expectedTitle = "Wednesday Night Men's League 26";

    expect(container.querySelector('.familiar-league-switcher-name .familiar-league-switcher-title-mobile')).toHaveTextContent(expectedTitle);
    expect(container.querySelector('.familiar-league-switcher-name .familiar-league-switcher-title-desktop')).toHaveTextContent(expectedTitle);
  });

  it('keeps same-named rollover seasons distinct in accessible option titles', () => {
    renderSheetForLeagues(sameNamedSeasonLeagues);

    const options = screen.getAllByRole('button', { name: /Wednesday Night Men's League/ });
    expect(options).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Wednesday Night Men's League 26\/27/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Wednesday Night Men's League 27\/28/ })).toBeInTheDocument();
  });

  it('keeps same-named rollover seasons distinct in the payment switcher', () => {
    renderSwitcherForLeagues(sameNamedSeasonLeagues);

    const options = screen.getAllByRole('button', { name: /Wednesday Night Men's League/ });
    expect(options).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Wednesday Night Men's League 26\/27/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Wednesday Night Men's League 27\/28/ })).toBeInTheDocument();
  });
});
