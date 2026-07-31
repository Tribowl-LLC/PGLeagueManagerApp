import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { BowlerLeague, BowlerWithAccount, League, Payment, Team } from '@shared/schema';
import { PastDueBowlersSection } from '@/components/past-due-bowlers-section';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

const BOWLER_ID = 100;
const ARCHIVED_LEAGUE_ID = 200;
const ACTIVE_LEAGUE_ID = 201;
const ARCHIVED_TEAM_ID = 300;
const ACTIVE_TEAM_ID = 301;

const bowler: BowlerWithAccount = {
  id: BOWLER_ID,
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  active: true,
  order: 0,
  organizationId: 1,
  paymentCustomerId: null,
  paymentProviderLocationId: null,
  paymentSyncPendingAt: null,
  paymentSyncAttempts: 0,
  paymentSyncLastAttemptAt: null,
  hasAccount: false,
};

function makeLeague(id: number, active: boolean, seasonStart: string): League {
  return {
    id,
    name: active ? 'Farmington Mixed League 26/27' : 'Farmington Mixed League 25/26',
    description: null,
    active,
    allowPublicSignup: false,
    seasonStart,
    seasonEnd: active ? '2026-11-23T00:00:00.000Z' : '2025-11-24T00:00:00.000Z',
    weekDay: 'Monday',
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
    seasonNumber: active ? 2 : 1,
    previousSeasonId: active ? ARCHIVED_LEAGUE_ID : null,
    organizationId: 1,
    locationId: null,
    totalBowlingWeeks: 12,
    finalTwoWeeksDueWeek: null,
    skipDates: [],
    cancelledDates: [],
    doublePayDates: [],
  };
}

const leagues: League[] = [
  makeLeague(ARCHIVED_LEAGUE_ID, false, '2025-09-01T00:00:00.000Z'),
  makeLeague(ACTIVE_LEAGUE_ID, true, '2026-09-07T00:00:00.000Z'),
];

const teams: Team[] = [
  {
    id: ARCHIVED_TEAM_ID,
    name: 'Archived Team',
    number: 1,
    leagueId: ARCHIVED_LEAGUE_ID,
    active: true,
    displayOrder: 0,
  },
  {
    id: ACTIVE_TEAM_ID,
    name: 'Active Team',
    number: 1,
    leagueId: ACTIVE_LEAGUE_ID,
    active: true,
    displayOrder: 0,
  },
];

const bowlerLeagues: BowlerLeague[] = [
  {
    id: 400,
    bowlerId: BOWLER_ID,
    leagueId: ARCHIVED_LEAGUE_ID,
    teamId: ARCHIVED_TEAM_ID,
    active: true,
    order: 0,
    joinedAt: '2025-08-01T00:00:00.000Z',
  },
  {
    id: 401,
    bowlerId: BOWLER_ID,
    leagueId: ACTIVE_LEAGUE_ID,
    teamId: ACTIVE_TEAM_ID,
    active: true,
    order: 0,
    joinedAt: '2026-08-01T00:00:00.000Z',
  },
];

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async () => ({ success: true, data: [] }),
      },
    },
  });

  queryClient.setQueryData(['/api/leagues'], { success: true, data: leagues });
  queryClient.setQueryData(['/api/teams'], { success: true, data: teams });
  queryClient.setQueryData(['/api/bowlers'], { success: true, data: [bowler] });
  queryClient.setQueryData(
    ['/api/bowler-leagues', { enriched: true }],
    { success: true, data: bowlerLeagues },
  );
  queryClient.setQueryData<{ data: Payment[] }>(['/api/payments'], { data: [] });

  return render(
    <QueryClientProvider client={queryClient}>
      <PastDueBowlersSection />
    </QueryClientProvider>,
  );
}

describe('PastDueBowlersSection', () => {
  it('excludes archived seasons when calculating dashboard past due balances', () => {
    renderSection();

    expect(screen.getByText('No past due balances found')).toBeInTheDocument();
    expect(screen.queryByText('Farmington Mixed League 25/26')).not.toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
  });
});
