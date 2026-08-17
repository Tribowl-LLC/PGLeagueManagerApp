/**
 * Component test for the context-aware "back" link on the bowler view
 * page (`/bowlers/:bowlerId`).
 *
 * Background: the bowler detail page used to always render a single
 * "← Back to Team" link as long as the selected league association had
 * a teamId. That link was wrong when the user reached the bowler from
 * the Bowlers tab — clicking it took them to a team page they had not
 * been on. The Bowlers list now appends `?from=bowlers` to the link;
 * the bowler view reads the param and renders "← Back to Bowlers"
 * instead, pointing at `/bowlers`.
 *
 * This test pins both cases:
 *   1. With `?from=bowlers` the page renders the back-to-bowlers link
 *      (and not the back-to-team link), and the href points at the
 *      bowlers list.
 *   2. Without the query param the existing back-to-team behavior is
 *      preserved when the bowler is on a team for the selected league.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiResponse, BowlerDetailsResponse } from '@shared/schema';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = NoopResizeObserver;
}

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/bowler-financial-summary', () => ({
  BowlerFinancialSummary: () => <div data-testid="stub-financial-summary" />,
}));

vi.mock('@/components/bowler-payment-history-table', () => ({
  BowlerPaymentHistoryTable: () => <div data-testid="stub-payment-history" />,
}));

vi.mock('@/components/payment-sync-retry-status', () => ({
  PaymentSyncRetryStatus: () => <div data-testid="stub-retry-status" />,
}));

let currentSearch = '';
let currentPath = '/bowlers/55';
vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return {
    ...actual,
    useSearch: () => currentSearch,
    useParams: () => ({ bowlerId: '55' }),
    useLocation: () => [currentPath, () => {}],
  };
});

import BowlerViewPage from '@/pages/bowler-view-page';

const BOWLER_ID = 55;
const LEAGUE_ID = 700;
const TEAM_ID = 8001;

const DETAILS: BowlerDetailsResponse = {
  bowler: {
    id: BOWLER_ID,
    name: 'Jane Doe',
    email: 'jane@example.com',
    active: true,
    organizationId: 1,
    hasAccount: false,
    paymentSyncStatus: null,
    paymentSyncRetryAt: null,
    paymentSyncLastError: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
  bowlerLeagues: [
    {
      id: 9001,
      bowlerId: BOWLER_ID,
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
      active: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ],
  leagues: [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: LEAGUE_ID, name: 'Tuesday Night Mixed', active: true } as any,
  ],
  teams: [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: TEAM_ID, name: 'Pin Crushers', leagueId: LEAGUE_ID } as any,
  ],
};

function renderPage(search: string) {
  currentSearch = search;
  currentPath = `/bowlers/${BOWLER_ID}${search ? `?${search}` : ''}`;

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData<ApiResponse<BowlerDetailsResponse>>(
    [`/api/bowlers/${BOWLER_ID}/details`],
    { success: true, data: DETAILS },
  );
  qc.setQueryData(['/api/user'], { success: true, data: { role: 'user', organizationId: 1 } });
  qc.setQueryData(["/api/financials/leagues", LEAGUE_ID, "due-past-due", BOWLER_ID, ""], {
    success: true,
    data: {
      mode: "legacy_fallback",
      rows: [],
      legacyFallback: {
        totalPaidMinor: 0,
        amountPastDueMinor: 0,
        totalDueToDateMinor: 0,
        fullSeasonAmountMinor: 0,
        remainingBalanceMinor: 0,
        totalWeeksInSeason: 0,
      },
      totals: { collectiblePastDueMinor: 0, reviewCount: 0 },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <BowlerViewPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  currentSearch = '';
  currentPath = `/bowlers/${BOWLER_ID}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BowlerViewPage back link', () => {
  it('renders "Back to Bowlers" pointing at /bowlers when ?from=bowlers is set', async () => {
    renderPage('from=bowlers');

    const backLink = await screen.findByTestId('link-back-to-bowlers');
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', '/bowlers');
    expect(backLink).toHaveTextContent(/back to bowlers/i);

    expect(screen.queryByTestId('link-back-to-team')).not.toBeInTheDocument();
  });

  it('renders "Back to Team" pointing at the team page when no from query is present', async () => {
    renderPage('');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', `/teams/${TEAM_ID}`);
    expect(backLink).toHaveTextContent(/back to team/i);

    expect(screen.queryByTestId('link-back-to-bowlers')).not.toBeInTheDocument();
  });

  it('ignores unrelated query params and falls back to the team link', async () => {
    renderPage('foo=bar&from=somewhere-else');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toHaveAttribute('href', `/teams/${TEAM_ID}`);

    expect(screen.queryByTestId('link-back-to-bowlers')).not.toBeInTheDocument();
  });

  it('renders "Back to Past Due" pointing at /reports/past-due when ?from=past-due is set', async () => {
    renderPage('from=past-due');

    const backLink = await screen.findByTestId('link-back-to-past-due');
    expect(backLink).toHaveAttribute('href', '/reports/past-due');
    expect(backLink).toHaveTextContent(/back to past due/i);
    expect(screen.queryByTestId('link-back-to-team')).not.toBeInTheDocument();
  });

  it('renders "Back to Past Due" pointing at the league past-due page when ?from=league-past-due&fromLeagueId=N', async () => {
    renderPage('from=league-past-due&fromLeagueId=42');

    const backLink = await screen.findByTestId('link-back-to-league-past-due');
    expect(backLink).toHaveAttribute('href', '/reports/leagues/42/past-due');
    expect(backLink).toHaveTextContent(/back to past due/i);
    expect(screen.queryByTestId('link-back-to-team')).not.toBeInTheDocument();
  });

  it('falls back to the team link when ?from=league-past-due is missing fromLeagueId', async () => {
    renderPage('from=league-past-due');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toHaveAttribute('href', `/teams/${TEAM_ID}`);
    expect(screen.queryByTestId('link-back-to-league-past-due')).not.toBeInTheDocument();
  });

  it('falls back to the team link when fromLeagueId is non-numeric', async () => {
    renderPage('from=league-past-due&fromLeagueId=abc');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toHaveAttribute('href', `/teams/${TEAM_ID}`);
    expect(screen.queryByTestId('link-back-to-league-past-due')).not.toBeInTheDocument();
  });

  it('renders "Back to Weekly Payments" with a valid fromLeagueId', async () => {
    renderPage('from=weekly-payments&fromLeagueId=99');

    const backLink = await screen.findByTestId('link-back-to-weekly-payments');
    expect(backLink).toHaveAttribute('href', '/leagues/99/weekly-payments');
    expect(backLink).toHaveTextContent(/back to weekly payments/i);
    expect(screen.queryByTestId('link-back-to-team')).not.toBeInTheDocument();
  });

  it('falls back to the team link when ?from=weekly-payments is missing fromLeagueId', async () => {
    renderPage('from=weekly-payments');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toHaveAttribute('href', `/teams/${TEAM_ID}`);
    expect(screen.queryByTestId('link-back-to-weekly-payments')).not.toBeInTheDocument();
  });

  it('renders "Back to Team" pointing at fromTeamId when ?from=team&fromTeamId=N', async () => {
    renderPage('from=team&fromTeamId=4242');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toHaveAttribute('href', '/teams/4242');
    expect(backLink).toHaveTextContent(/back to team/i);
  });

  it('falls back to the default team link when ?from=team is missing fromTeamId', async () => {
    renderPage('from=team');

    const backLink = await screen.findByTestId('link-back-to-team');
    expect(backLink).toHaveAttribute('href', `/teams/${TEAM_ID}`);
  });

  it('renders "Back to Dashboard" when ?from=home is set', async () => {
    renderPage('from=home');

    const backLink = await screen.findByTestId('link-back-to-home');
    expect(backLink).toHaveAttribute('href', '/home');
    expect(backLink).toHaveTextContent(/back to dashboard/i);
    expect(screen.queryByTestId('link-back-to-team')).not.toBeInTheDocument();
  });
});
