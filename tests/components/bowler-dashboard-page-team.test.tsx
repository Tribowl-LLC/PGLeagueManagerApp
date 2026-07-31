import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/components/bowler-layout', () => ({
  BowlerLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/payment-status-section', () => ({
  PaymentStatusSection: () => <div data-testid="payment-status-section" />,
}));

vi.mock('@/components/league-bottom-sheet', () => ({
  LeagueBottomSheet: () => null,
}));

vi.mock('@/components/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import BowlerDashboardPage from '@/pages/bowler-dashboard-page';

const BOWLER_ID = 42;
const LEAGUE_ID = 7;
const TEAM_ID = 9;

const responses = new Map<string, unknown>([
  ['/api/user', {
    success: true,
    data: { id: 1, bowlerId: BOWLER_ID, role: 'user', organizationId: 1 },
  }],
  ['/api/bowlers', {
    success: true,
    data: [{ id: BOWLER_ID, name: 'Michael Shearer', active: true }],
  }],
  ['/api/bowler-leagues', {
    success: true,
    data: [{
      id: 100,
      bowlerId: BOWLER_ID,
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
      active: true,
      order: 0,
      joinedAt: '2026-01-01T00:00:00.000Z',
    }],
  }],
  ['/api/leagues', {
    success: true,
    data: [{
      id: LEAGUE_ID,
      name: 'Tuesday Night League',
      active: true,
      seasonStart: '2026-01-01T00:00:00.000Z',
      seasonEnd: '2026-07-31T00:00:00.000Z',
      weekDay: 'Tuesday',
      totalBowlingWeeks: 30,
      cancelledDates: [],
      skipDates: [],
      doublePayDates: [],
      weeklyFee: 2000,
    }],
  }],
  [`/api/bowlers/${BOWLER_ID}/details`, {
    success: true,
    data: {
      bowler: { id: BOWLER_ID, name: 'Michael Shearer', active: true },
      bowlerLeagues: [],
      leagues: [],
      teams: [{
        id: TEAM_ID,
        name: 'Last Call',
        number: 1,
        leagueId: LEAGUE_ID,
        displayOrder: 0,
        active: true,
      }],
    },
  }],
  ['/api/payments', { success: true, data: [] }],
]);

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        queryFn: async ({ queryKey, signal }) => {
          const response = await fetch(String(queryKey[0]), { signal });
          if (!response.ok) throw new Error(`Request failed: ${response.status}`);
          return response.json();
        },
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <BowlerDashboardPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('BowlerDashboardPage team assignment', () => {
  it('uses the bowler details team data for the dashboard assignment', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      const body = responses.get(url.pathname);
      if (!body) {
        return new Response(JSON.stringify({ success: false }), { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard();

    expect(await screen.findByText('Last Call')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/bowlers/${BOWLER_ID}/details`)).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/teams')).toBe(false);
  });
});
