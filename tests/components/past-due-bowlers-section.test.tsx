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
const RESPONSIBILITY_TEAM_ID = 302;

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
  paymentSyncNextRetryAt: null,
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
  {
    id: RESPONSIBILITY_TEAM_ID,
    name: 'Explicit Responsibility Team',
    number: 2,
    leagueId: ACTIVE_LEAGUE_ID,
    active: true,
    displayOrder: 1,
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

function makeCanonicalRow(input: {
  index: number;
  teamId: number;
  classification: 'future' | 'due' | 'past_due' | 'settled' | 'voided' | 'review_required';
  outstandingMinor: number;
  reviewRequired: boolean;
}) {
  const amountMinor = input.outstandingMinor + (input.classification === 'settled' ? 700 : 0);
  return {
    id: `00000000-0000-4000-8000-0000000000${String(input.index).padStart(2, '0')}`,
    organizationId: 1,
    leagueId: ACTIVE_LEAGUE_ID,
    occurrenceId: `00000000-0000-4000-8000-0000000001${String(input.index).padStart(2, '0')}`,
    responsibilityId: `00000000-0000-4000-8000-0000000002${String(input.index).padStart(2, '0')}`,
    teamId: input.teamId,
    component: 'full' as const,
    payerBowlerId: BOWLER_ID,
    amountMinor,
    currency: 'USD' as const,
    dueAt: '2038-01-01T00:00:00.000Z',
    pastDueAt: '2038-01-01T03:00:00.000Z',
    state: input.classification === 'voided' ? 'voided' as const : input.classification === 'settled' ? 'settled' as const : 'open' as const,
    allocatedMinor: amountMinor - input.outstandingMinor,
    outstandingMinor: input.outstandingMinor,
    classification: input.classification,
    reviewRequired: input.reviewRequired,
  };
}

function makeCanonicalReport(rows: ReturnType<typeof makeCanonicalRow>[]) {
  return {
    contractVersion: 'canonical-due-past-due/2' as const,
    orderVersion: 'due-at,payer,occurrence,obligation/2' as const,
    organizationId: 1,
    leagueId: ACTIVE_LEAGUE_ID,
    authoritativeSource: 'payment_obligations' as const,
    asOf: '2038-01-01T00:00:00.000Z',
    rows,
    totals: {
      amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
      allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
      outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
      collectiblePastDueMinor: rows.filter((row) => row.classification === 'past_due' && !row.reviewRequired).reduce((sum, row) => sum + row.outstandingMinor, 0),
      reviewCount: rows.filter((row) => row.reviewRequired).length,
      settledCount: rows.filter((row) => row.classification === 'settled').length,
      voidedCount: rows.filter((row) => row.classification === 'voided').length,
    },
  };
}

function renderSection(report?: unknown, enabled = true) {
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
  queryClient.setQueryData(['/api/financials/due-past-due'], report ?? { data: { leagues: [] } });

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <PastDueBowlersSection enabled={enabled} />
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

describe('PastDueBowlersSection', () => {
  it('excludes archived seasons when calculating dashboard past due balances', () => {
    renderSection();

    expect(screen.getByText('No past due balances found')).toBeInTheDocument();
    expect(screen.queryByText('Farmington Mixed League 25/26')).not.toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
  });

  it('keeps zero-outstanding review evidence visible and aggregates obligation rows', () => {
    renderSection({ data: { leagues: [{ leagueId: ACTIVE_LEAGUE_ID, report: makeCanonicalReport([
      makeCanonicalRow({ index: 1, teamId: ACTIVE_TEAM_ID, classification: 'future', outstandingMinor: 500, reviewRequired: false }),
      makeCanonicalRow({ index: 2, teamId: ACTIVE_TEAM_ID, classification: 'due', outstandingMinor: 400, reviewRequired: false }),
      makeCanonicalRow({ index: 3, teamId: ACTIVE_TEAM_ID, classification: 'settled', outstandingMinor: 0, reviewRequired: true }),
      makeCanonicalRow({ index: 4, teamId: ACTIVE_TEAM_ID, classification: 'past_due', outstandingMinor: 250, reviewRequired: false }),
    ]) }] } });
    expect(screen.getAllByText('Review required').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('$2.50')).toBeInTheDocument();
  });

  it('uses canonical responsibility team identity for an explicit substitute', () => {
    renderSection({ data: { leagues: [{ leagueId: ACTIVE_LEAGUE_ID, report: makeCanonicalReport([
      makeCanonicalRow({ index: 5, teamId: RESPONSIBILITY_TEAM_ID, classification: 'past_due', outstandingMinor: 250, reviewRequired: false }),
    ]) }] } });
    expect(screen.getByText('Explicit Responsibility Team')).toBeInTheDocument();
  });

  it('does not issue the org-wide financial request when disabled for an ordinary member', () => {
    const { queryClient } = renderSection(undefined, false);
    expect(queryClient.getQueryState(['/api/financials/due-past-due'])?.fetchStatus).toBe("idle");
    expect(screen.queryByText('Past Due Balances')).not.toBeInTheDocument();
  });

  it('keeps canonical responsibility visible after the current roster moves or deactivates', () => {
    bowler.active = false;
    bowlerLeagues[1].active = false;
    bowlerLeagues[1].teamId = ACTIVE_TEAM_ID;
    renderSection({ data: { leagues: [{ leagueId: ACTIVE_LEAGUE_ID, report: makeCanonicalReport([
      makeCanonicalRow({ index: 6, teamId: RESPONSIBILITY_TEAM_ID, classification: 'past_due', outstandingMinor: 250, reviewRequired: false }),
    ]) }] } });
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Explicit Responsibility Team')).toBeInTheDocument();
    bowler.active = true;
    bowlerLeagues[1].active = true;
  });
});
