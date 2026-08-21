import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { League, User } from '@shared/schema';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/queryClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/queryClient')>(),
  apiRequest: apiRequestMock,
}));
vi.mock('@/components/layout', () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@/components/error-boundary', () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@/pages/league-view-page/invite-result-card', () => ({ InviteResultCard: () => null }));
vi.mock('@/pages/league-view-page/league-action-cards', () => ({ LeagueActionCards: () => null }));
vi.mock('@/pages/league-view-page/season-history-card', () => ({ SeasonHistoryCard: () => null }));
vi.mock('@/pages/league-view-page/league-occurrence-schedule-card', () => ({ LeagueOccurrenceScheduleCard: () => null }));
vi.mock('@/pages/league-view-page/new-season-dialog', () => ({
  NewSeasonDialog: ({ showNewSeason, onCreate }: {
    showNewSeason: boolean;
    onCreate: (values: {
      seasonStart: string;
      totalBowlingWeeks: number;
      weekDay: 'Sunday';
      skipDates: string[];
      cancelledDates: string[];
      doublePayDates: string[];
      allowPublicSignup: boolean;
      paymentMode: 'weekly';
      sourceConfirmation: {
        contractVersion: 'league-rollover-source/1';
        fingerprint: string;
        confirmed: true;
      };
    }) => void;
  }) => showNewSeason ? (
    <button type="button" onClick={() => onCreate({
      seasonStart: '2032-09-05',
      totalBowlingWeeks: 12,
      weekDay: 'Sunday',
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
      allowPublicSignup: false,
      paymentMode: 'weekly',
      sourceConfirmation: {
        contractVersion: 'league-rollover-source/1',
        fingerprint: 'b'.repeat(64),
        confirmed: true,
      },
    })}>
      Submit mocked new season
    </button>
  ) : null,
}));

import LeagueViewPage from '@/pages/league-view-page';

const organizationId = 37;
const league = {
  id: 42,
  name: 'System Admin Source',
  description: null,
  active: true,
  allowPublicSignup: false,
  seasonStart: '2031-01-05T00:00:00.000Z',
  seasonEnd: '2031-03-23T00:00:00.000Z',
  weekDay: 'Sunday',
  weeklyFee: 2_000,
  lineageFee: null,
  prizeFundFee: null,
  practiceStartTime: null,
  competitionStartTime: '19:00',
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
  previousSeasonId: null,
  organizationId,
  locationId: 9,
  totalBowlingWeeks: 12,
  finalTwoWeeksDueWeek: null,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
} satisfies League;

const systemAdmin = {
  id: 7,
  email: 'system-admin@example.test',
  password: 'not-returned-by-real-api',
  bowlerId: null,
  name: 'System Admin',
  phone: null,
  avatar: null,
  role: 'system_admin',
  organizationId: null,
  locationId: null,
  preferredLanguage: null,
  failedPasswordChangeAttempts: 0,
  passwordChangeLockedUntil: null,
  mustChangePassword: false,
  createdAt: '2030-01-01T00:00:00.000Z',
} satisfies User;

describe('LeagueViewPage system-admin new-season scope', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it('uses the loaded source league organization in the rollover query and retained setup semantics', async () => {
    apiRequestMock.mockResolvedValue({
      success: true,
      data: {
        ...league,
        id: 43,
        active: true,
        previousSeasonId: league.id,
        canonicalDraftGeneration: null,
        setupIntegration: { mode: 'created', writesPerformed: true },
      },
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { queryFn: async () => ({ success: true, data: null }), retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(['/api/leagues/42'], { success: true, data: league });
    client.setQueryData(['/api/user'], { success: true, data: systemAdmin });
    client.setQueryData(['/api/leagues', 42, 'season-history'], { success: true, data: [league] });
    const { hook } = memoryLocation({ path: '/leagues/42' });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={client}>
        <Router hook={hook}>
          <Route path="/leagues/:leagueId" component={LeagueViewPage} />
        </Router>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /start new season/i }));
    await user.click(screen.getByRole('button', { name: /submit mocked new season/i }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/api/leagues/42/new-season?organizationId=${organizationId}`,
      'POST',
      expect.objectContaining({
        setupIntegration: expect.objectContaining({ contractVersion: 'league-setup-integration-request/3' }),
        sourceConfirmation: expect.objectContaining({ contractVersion: 'league-rollover-source/1' }),
      }),
    );
  });
});
