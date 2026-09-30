import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BowlerLeague, League, Team } from '@shared/schema';
import { LeagueBottomSheet } from '@/components/league-bottom-sheet';
import { LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION } from '@shared/league-occurrence-schedule';

const scheduleRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/queryClient', () => ({ apiRequest: scheduleRequest }));

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

const testTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 11,
  name: 'Tuesday Team',
  number: 1,
  leagueId: 7,
  active: true,
  displayOrder: 0,
  ...overrides,
});

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function renderSheet(currentLeague: League) {
  return renderSheetForLeagues([currentLeague]);
}

function renderSheetForLeagues(currentLeagues: League[]) {
  return renderWithQueryClient(
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

const sameNamedSeasonLeagues = [
  league({ id: 7 }),
  league({
    id: 8,
    seasonStart: '2027-08-01T00:00:00.000Z',
    seasonEnd: '2028-03-31T00:00:00.000Z',
  }),
];

describe('LeagueBottomSheet season titles', () => {
  beforeEach(() => {
    scheduleRequest.mockReset();
  });

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

  it('shows the shared mobile team and canonical progress and keeps selection actions', async () => {
    scheduleRequest.mockResolvedValue({ data: {
      contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
      authoritativeSource: 'canonical',
      occurrences: [],
    } });
    const onClose = vi.fn();
    const onSelectLeague = vi.fn();
    const optionTeamMap = new Map([[11, testTeam()]]);

    renderWithQueryClient(
      <LeagueBottomSheet
        open
        onClose={onClose}
        activeBowlerLeagues={sameNamedSeasonLeagues.map((entry) => bowlerLeague(entry.id))}
        leagueMap={new Map(sameNamedSeasonLeagues.map((entry) => [entry.id, entry]))}
        teamMap={optionTeamMap}
        selectedLeagueId={8}
        onSelectLeague={onSelectLeague}
        viewerRole="user"
      />,
    );

    const option = screen.getByRole('button', { name: /Wednesday Night Men's League 27\/28/ });
    expect(await within(option).findByText('0 of 0 weeks completed')).toBeInTheDocument();
    expect(option).toHaveClass('is-selected');
    expect(option.querySelector('.familiar-league-switcher-meta-mobile')).toHaveTextContent('Tuesday Team');
    expect(option.querySelector('.familiar-league-switcher-meta-mobile')).toHaveTextContent('0 of 0 weeks completed');

    fireEvent.click(option);
    expect(onSelectLeague).toHaveBeenCalledWith(8);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the shared sheet backdrop and Escape close behavior', () => {
    const onClose = vi.fn();
    renderWithQueryClient(
      <LeagueBottomSheet
        open
        onClose={onClose}
        activeBowlerLeagues={[bowlerLeague(7)]}
        leagueMap={new Map([[7, league({})]])}
        teamMap={teamMap}
        selectedLeagueId={7}
        onSelectLeague={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Close league switcher' })[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
