import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { BowlerLeague, League } from '@shared/schema';
import { LeagueBottomSheet } from '@/components/league-bottom-sheet';

const bowlerLeague = (leagueId: number): BowlerLeague => ({
  id: leagueId,
  bowlerId: 42,
  leagueId,
  teamId: 11,
  active: true,
  order: 0,
  joinedAt: '2026-08-01T00:00:00.000Z',
});

const league = (overrides: Partial<League>): League => ({
  id: 7,
  name: "Wednesday Night Men's League",
  description: null,
  active: true,
  seasonStart: '2026-08-01T00:00:00.000Z',
  seasonEnd: '2027-03-31T00:00:00.000Z',
  weekDay: 'Wednesday',
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
  seasonNumber: 1,
  totalBowlingWeeks: 30,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
  organizationId: 1,
  locationId: null,
  previousSeasonId: null,
  ...overrides,
});

const sameNamedSeasonLeagues = [
  league({ id: 7 }),
  league({
    id: 8,
    seasonStart: '2027-08-01T00:00:00.000Z',
    seasonEnd: '2028-03-31T00:00:00.000Z',
  }),
];

function renderPicker(options: {
  leagues?: League[];
  selectedLeagueId?: number | null;
  onClose?: () => void;
  onSelectLeague?: (leagueId: number) => void;
} = {}) {
  const leagues = options.leagues ?? [league({})];
  return render(
    <LeagueBottomSheet
      open
      onClose={options.onClose ?? vi.fn()}
      activeBowlerLeagues={leagues.map((entry) => bowlerLeague(entry.id))}
      leagueMap={new Map(leagues.map((entry) => [entry.id, entry]))}
      selectedLeagueId={options.selectedLeagueId ?? leagues[0]?.id ?? null}
      onSelectLeague={options.onSelectLeague ?? vi.fn()}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LeagueBottomSheet season labels', () => {
  it('shows a single title, helper, and season-suffixed option names', () => {
    renderPicker();

    expect(screen.getByRole('dialog', { name: 'Choose your league' })).toBeInTheDocument();
    expect(screen.getByText('Balances and history follow the selected league.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Wednesday Night Men's League 26/27" })).toBeInTheDocument();
  });

  it('uses a single year for a season within one calendar year', () => {
    renderPicker({
      leagues: [league({
        seasonStart: '2026-03-01T00:00:00.000Z',
        seasonEnd: '2026-06-30T00:00:00.000Z',
      })],
    });

    expect(screen.getByRole('button', { name: "Wednesday Night Men's League 26" })).toBeInTheDocument();
  });

  it('keeps same-named rollover seasons distinct and renders only league name and season', () => {
    renderPicker({ leagues: sameNamedSeasonLeagues, selectedLeagueId: 8 });

    const options = screen.getAllByRole('button', { name: /Wednesday Night Men's League/ });
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "Wednesday Night Men's League 26/27",
      "Wednesday Night Men's League 27/28",
    ]);
    expect(options[0]).toHaveAttribute('aria-pressed', 'false');
    expect(options[1]).toHaveAttribute('aria-pressed', 'true');
    expect(options[0].querySelector('.lucide-chevron-down')).toBeInTheDocument();
    expect(options[1].querySelector('.lucide-check')).toBeInTheDocument();

    for (const option of options) {
      expect(option.querySelector('.familiar-league-switcher-meta')).not.toBeInTheDocument();
      expect(option.textContent).not.toMatch(/Tuesday Team|6:30 PM|weeks completed/i);
    }
  });

  it('closes first, then applies the selected league after the close transition', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onSelectLeague = vi.fn();
    renderPicker({ leagues: sameNamedSeasonLeagues, selectedLeagueId: 7, onClose, onSelectLeague });

    fireEvent.click(screen.getByRole('button', { name: "Wednesday Night Men's League 27/28" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelectLeague).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(149); });
    expect(onSelectLeague).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onSelectLeague).toHaveBeenCalledWith(8);
  });

  it('restores focus to the external picker trigger after Escape closes', async () => {
    const leagues = [league({})];
    const leagueMap = new Map(leagues.map((entry) => [entry.id, entry]));
    const memberships = leagues.map((entry) => bowlerLeague(entry.id));

    function ControlledPicker() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open picker</button>
          <LeagueBottomSheet
            open={open}
            onClose={() => setOpen(false)}
            activeBowlerLeagues={memberships}
            leagueMap={leagueMap}
            selectedLeagueId={7}
            onSelectLeague={() => undefined}
          />
        </>
      );
    }

    render(<ControlledPicker />);
    const trigger = screen.getByRole('button', { name: 'Open picker' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Close league switcher' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(document.body).queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
