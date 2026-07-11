import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { League } from '@shared/schema';
import { NewSeasonDialog } from '@/pages/league-view-page/new-season-dialog';

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
  finalTwoWeeksDueWeek: null,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
  rosterCap: null,
  embedRegistrationFee: null,
} satisfies League;

describe('NewSeasonDialog', () => {
  it('calculates the end date and submits the edited bowling schedule', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();

    render(
      <NewSeasonDialog
        league={league}
        showNewSeason
        setShowNewSeason={() => {}}
        onCreate={onCreate}
        isPending={false}
      />,
    );

    fireEvent.change(screen.getByLabelText('New Season Start Date'), {
      target: { value: '2026-09-07' },
    });
    fireEvent.change(screen.getByLabelText('Bowling Weeks'), {
      target: { value: '12' },
    });

    const endDate = screen.getByLabelText('New Season End Date');
    expect(endDate).toHaveValue('2026-11-23');

    await user.click(screen.getByRole('button', { name: /bowling schedule/i }));
    await user.click(screen.getByTestId('schedule-week-2026-09-07'));

    expect(endDate).toHaveValue('2026-11-30');

    await user.click(screen.getByRole('button', { name: /create new season/i }));
    expect(onCreate).toHaveBeenCalledWith({
      seasonStart: '2026-09-07',
      totalBowlingWeeks: 12,
      weekDay: 'Monday',
      skipDates: ['2026-09-07'],
      cancelledDates: [],
      doublePayDates: [],
    });
  });
});
