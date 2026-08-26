import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeaguesTable } from '@/components/leagues-table';
import type { League } from '@shared/schema';

function league(overrides: Partial<League>): League {
  const result: League = {
    id: 1,
    name: 'Archived League',
    description: null,
    active: false,
    allowPublicSignup: false,
    seasonStart: '2026-01-01T00:00:00.000Z',
    seasonEnd: '2026-04-01T00:00:00.000Z',
    weekDay: 'Monday',
    weeklyFee: 2000,
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
    scheduleAuthority: 'retired_legacy',
    canonicalScheduleRevision: 0,
    payingLineupSize: 4,
    ...overrides,
  };
  return result;
}

describe('LeaguesTable archive controls', () => {
  it('keeps retired rows visible while hiding every mutation control', () => {
    render(
      <LeaguesTable
        leagues={[league({ id: 1, name: 'Retired Legacy' }), league({ id: 2, name: 'Current League', active: true, scheduleAuthority: 'canonical' })]}
        teamCounts={{}}
        locationMap={{}}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        isRestorePending={false}
      />,
    );

    expect(screen.getByText('Retired Legacy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Current League' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Retired Legacy' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});
