import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
}

// Two active locations so we can switch from one to the other and
// trigger handleLocationChange on the LeagueForm.
const LOCATIONS = [
  { id: 1, name: 'Lanes A', active: true },
  { id: 2, name: 'Lanes B', active: true },
];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/locations')) {
    return new Response(
      JSON.stringify({ success: true, data: LOCATIONS }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/api/payments-provider/catalog')) {
    return new Response(
      JSON.stringify({ success: true, data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/api/csrf-token')) {
    return new Response(
      JSON.stringify({ success: true, data: { token: 'test' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url === '/api/leagues' && init?.method === 'POST') {
    return new Promise<Response>(() => {});
  }
  return new Response(
    JSON.stringify({ success: true, data: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
vi.stubGlobal('fetch', fetchMock);

import type { League } from '@shared/schema';
import { LeagueForm } from '@/components/league-form';
import { queryClient } from '@/lib/queryClient';

const SAVED_WEEKLY_FEE = 3000;
const SAVED_LINEAGE_FEE = 1000;
const SAVED_PRIZE_FUND_FEE = 2000;

const seededLeague: League = {
  id: 42,
  name: 'Pre-existing League',
  description: '',
  payingLineupSize: 4,
  active: true,
  allowPublicSignup: false,
  seasonStart: new Date('2025-01-06T12:00:00.000Z').toISOString(),
  seasonEnd: new Date('2025-12-29T12:00:00.000Z').toISOString(),
  weekDay: 'Monday',
  weeklyFee: SAVED_WEEKLY_FEE,
  lineageFee: SAVED_LINEAGE_FEE,
  prizeFundFee: SAVED_PRIZE_FUND_FEE,
  practiceStartTime: '',
  competitionStartTime: '',
  squareLineageItemId: 'lin-item',
  lineageItemVariationId: 'lin-var',
  squareLineageItemName: 'Lin Item',
  squarePrizeFundItemId: 'pf-item',
  prizeFundItemVariationId: 'pf-var',
  squarePrizeFundItemName: 'PF Item',
  squareCategoryId: null,
  timezone: 'America/New_York',
  paymentMode: 'weekly',
  seasonNumber: 1,
  previousSeasonId: null,
  organizationId: null,
  locationId: 1,
  totalBowlingWeeks: 30,
  finalTwoWeeksDueWeek: null,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
};

function renderForm(league: League | null = seededLeague, systemAdminOrganizationId?: number) {
  // Use the real queryClient so its default queryFn (which calls the
  // mocked global fetch) hydrates the /api/locations query — without it
  // the LeagueBasicInfo Location <Select> never renders.
  queryClient.clear();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <LeagueForm
        open={open}
        onClose={() => setOpen(false)}
        league={league ?? undefined}
        systemAdminOrganizationId={systemAdminOrganizationId}
      />
    );
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe('LeagueForm — handleLocationChange clears stored lineage / prize-fund fees', () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it('uses league lineup size in basic setup and no longer presents description', async () => {
    renderForm();
    expect(await screen.findByRole('combobox', { name: 'League Lineup Size' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'League Lineup Size' }));
    expect(screen.getByRole('option', { name: 'Three Bowlers' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Four Bowlers' })).toBeInTheDocument();
    expect(screen.queryByText(/payer slots/i)).not.toBeInTheDocument();
  });

  it('changing the league location resets lineageFee and prizeFundFee alongside the Square identifier fields', async () => {
    const user = userEvent.setup();
    renderForm();

    // Wait for the Location <Select> to be populated and the form to be
    // pre-seeded with the saved fee snapshot.
    const lineageInput = await screen.findByLabelText<HTMLInputElement>(
      /^Lineage Fee$/,
    );
    const prizeFundInput = await screen.findByLabelText<HTMLInputElement>(
      /^Prize Fund Fee$/,
    );

    await waitFor(() => {
      expect(lineageInput.value).toBe(String(SAVED_LINEAGE_FEE / 100));
      expect(prizeFundInput.value).toBe(String(SAVED_PRIZE_FUND_FEE / 100));
    });

    // Open the Location dropdown by accessible name (more resilient than
    // positional selection) and pick the *other* active location to fire
    // handleLocationChange.
    const locationTrigger = await screen.findByRole('combobox', {
      name: /location/i,
    });
    await user.click(locationTrigger);
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('option', { name: 'Lanes B' }));

    // Both per-component fee inputs are cleared, so the bypassed
    // "lineage + prize fund must equal weekly fee" cross-field validation
    // can no longer reference fees from the previous location.
    await waitFor(() => {
      expect(lineageInput.value).toBe('');
      expect(prizeFundInput.value).toBe('');
    });
  });

  it('includes the selected organization in a system-admin Add League request', async () => {
    const user = userEvent.setup();
    renderForm(null, 37);

    await user.type(screen.getByLabelText(/^Name$/), 'Scoped League');
    await user.click(await screen.findByRole('combobox', { name: /location/i }));
    await user.click(screen.getByRole('option', { name: 'Lanes A' }));
    await user.click(screen.getByLabelText('League Payment Timing'));
    await user.click(screen.getByRole('option', { name: /weekly: bowlers pay each week/i }));
    await user.click(screen.getByRole('combobox', { name: 'League Lineup Size' }));
    await user.click(screen.getByRole('option', { name: 'Four Bowlers' }));
    await user.click(screen.getByRole('button', { name: 'Add League' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/leagues' && init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/leagues' && init?.method === 'POST');
    expect(postCall).toBeDefined();
    const requestBody = JSON.parse(String(postCall?.[1]?.body));
    expect(requestBody).toMatchObject({
      name: 'Scoped League',
      payingLineupSize: 4,
      organizationId: 37,
      setupIntegration: { contractVersion: 'league-setup-integration-request/3' },
    });
    expect(requestBody).not.toHaveProperty('seasonEnd');
  });
});
