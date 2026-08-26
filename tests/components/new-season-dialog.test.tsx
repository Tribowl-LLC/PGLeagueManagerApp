import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { League } from '@shared/schema';
import { NewSeasonDialog } from '@/pages/league-view-page/new-season-dialog';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/queryClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/queryClient')>(),
  apiRequest: apiRequestMock,
}));

const league = {
  id: 42,
  name: 'Farmington Mixed League',
  description: null,
  active: true,
  allowPublicSignup: false,
  seasonStart: '2025-01-06T00:00:00.000Z',
  seasonEnd: '2025-03-24T00:00:00.000Z',
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
  timezone: 'America/Chicago',
  paymentMode: 'weekly',
  seasonNumber: 1,
  previousSeasonId: null,
  organizationId: 3,
  locationId: null,
  totalBowlingWeeks: 12,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
} satisfies League;

describe('NewSeasonDialog', () => {
  it('calculates the end date and submits the edited bowling schedule', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    apiRequestMock.mockResolvedValue({
      success: true,
      data: {
        contractVersion: 'league-rollover-source/1',
        fingerprintVersion: 'league-rollover-source-fingerprint/1',
        fingerprint: 'a'.repeat(64),
        organizationId: 3,
        sourceLeagueId: 42,
        carriedConfiguration: {
          name: league.name,
          description: null,
          payingLineupSize: 4,
          locationId: 9,
          timezone: 'America/Chicago',
          practiceStartTime: '18:30',
          competitionStartTime: '19:00',
          weeklyFee: 2000,
          lineageFee: null,
          prizeFundFee: null,
        },
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <NewSeasonDialog
          league={league}
          showNewSeason
          setShowNewSeason={() => {}}
          onCreate={onCreate}
          isPending={false}
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText('New Season Start Date'), {
      target: { value: '2026-09-07' },
    });
    fireEvent.change(screen.getByLabelText('Bowling Weeks'), {
      target: { value: '12' },
    });

    const endDate = screen.getByLabelText('New Season End Date');
    expect(endDate).toHaveValue('2026-11-23');
    expect(screen.getByRole('button', { name: /create new season/i })).toBeDisabled();
    expect(await screen.findByText('League lineup size')).toBeInTheDocument();
    expect(screen.getByText('Four Bowlers')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /bowling schedule/i }));
    await user.click(screen.getByTestId('schedule-week-2026-09-07'));
    await user.click(screen.getByRole('switch', { name: /allow public sign-up/i }));
    await user.click(screen.getByLabelText('League Payment Timing'));
    await user.click(screen.getByRole('option', { name: /full season upfront/i }));
    await user.click(await screen.findByLabelText(/reviewed and confirm this carried configuration/i));
    expect(screen.getByRole('button', { name: /create new season/i })).toBeEnabled();

    expect(endDate).toHaveValue('2026-11-30');

    await user.click(screen.getByRole('button', { name: /create new season/i }));
    expect(onCreate).toHaveBeenCalledWith({
      seasonStart: '2026-09-07',
      totalBowlingWeeks: 12,
      weekDay: 'Monday',
      skipDates: ['2026-09-07'],
      cancelledDates: [],
      doublePayDates: [],
      allowPublicSignup: true,
      paymentMode: 'upfront',
      sourceConfirmation: {
        contractVersion: 'league-rollover-source/1',
        fingerprint: 'a'.repeat(64),
        confirmed: true,
      },
    });
  });
});
