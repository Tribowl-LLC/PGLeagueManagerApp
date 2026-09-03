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

vi.mock('@/components/admin-bowler-link-panel', () => ({
  AdminBowlerLinkPanel: () => <div data-testid="stub-admin-bowler-link-panel" />,
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

function renderPage(search: string, role: 'user' | 'org_admin' | 'system_admin' = 'user') {
  currentSearch = search;
  currentPath = `/bowlers/${BOWLER_ID}${search ? `?${search}` : ''}`;
  const systemScope = role === 'system_admin' ? '&organizationId=1' : '';

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData<ApiResponse<BowlerDetailsResponse>>(
    [`/api/bowlers/${BOWLER_ID}/details`],
    { success: true, data: DETAILS },
  );
  qc.setQueryData(['/api/user'], { success: true, data: { role, organizationId: 1 } });
  qc.setQueryData(["/api/financials/leagues", LEAGUE_ID, "canonical-due-past-due/2", BOWLER_ID, systemScope], {
    success: true,
    data: {
      contractVersion: "canonical-due-past-due/2",
      orderVersion: "due-at,payer,occurrence,obligation/2",
      organizationId: 1,
      leagueId: LEAGUE_ID,
      authoritativeSource: "payment_obligations",
      asOf: "2038-01-01T00:00:00.000Z",
      rows: [],
      totals: { amountMinor: 0, allocatedMinor: 0, outstandingMinor: 0, collectiblePastDueMinor: 0, reviewCount: 0, settledCount: 0, voidedCount: 0 },
    },
  });
  qc.setQueryData(["/api/financials/f5/payments", LEAGUE_ID, BOWLER_ID, 1, role, 1], {
    success: true,
    data: { rows: [], totalTransactions: 0, mode: "canonical", paymentTiming: "weekly" },
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

  it.each(['org_admin', 'system_admin'] as const)('shows payment-partner management to %s', async (role) => {
    renderPage('', role);

    expect(await screen.findByTestId('stub-admin-bowler-link-panel')).toBeInTheDocument();
  });

  it('does not show payment-partner management to a regular user', () => {
    renderPage('', 'user');

    expect(screen.queryByTestId('stub-admin-bowler-link-panel')).not.toBeInTheDocument();
  });
});
