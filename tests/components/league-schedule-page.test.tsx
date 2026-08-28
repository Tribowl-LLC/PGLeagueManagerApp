import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout', () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@/components/error-boundary', () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@/pages/league-view-page/league-occurrence-schedule-card', () => ({
  LeagueOccurrenceScheduleCard: ({ leagueId, organizationId, viewerRole }: {
    leagueId: number;
    organizationId: number;
    viewerRole?: string;
  }) => (
    <div
      data-testid="league-schedule"
      data-league-id={leagueId}
      data-organization-id={organizationId}
      data-viewer-role={viewerRole}
    />
  ),
}));

import LeagueSchedulePage from '@/pages/league-schedule-page';

const league = {
  id: 42,
  name: 'Monday Mixed',
  seasonStart: '2031-09-01T00:00:00.000Z',
  seasonEnd: '2032-04-01T00:00:00.000Z',
  organizationId: 37,
};

const administrator = {
  id: 7,
  role: 'org_admin',
};

describe('LeagueSchedulePage', () => {
  it('loads the user-facing schedule for the selected league', async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { queryFn: async () => ({ success: true, data: null }), retry: false, staleTime: Infinity },
      },
    });
    client.setQueryData(['/api/leagues/42'], { success: true, data: league });
    client.setQueryData(['/api/user'], { success: true, data: administrator });
    const { hook } = memoryLocation({ path: '/leagues/42/schedule' });

    render(
      <QueryClientProvider client={client}>
        <Router hook={hook}>
          <Route path="/leagues/:leagueId/schedule" component={LeagueSchedulePage} />
        </Router>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'League Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Monday Mixed' })).toHaveAttribute('href', '/leagues/42');
    expect(screen.getByTestId('league-schedule')).toHaveAttribute('data-league-id', '42');
    expect(screen.getByTestId('league-schedule')).toHaveAttribute('data-organization-id', '37');
    expect(screen.getByTestId('league-schedule')).toHaveAttribute('data-viewer-role', 'org_admin');
  });
});
