import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Radix select reaches for ResizeObserver via react-use-size; jsdom has none.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/payments-provider/catalog/categories')) {
    return new Response(
      JSON.stringify({
        success: true,
        data: [
          { id: 'cat-leagues', name: 'Leagues' },
          { id: 'cat-events', name: 'Events' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/api/payments-provider/catalog/items')) {
    return new Response(
      JSON.stringify({
        success: true,
        data: [
          {
            id: 'item-1',
            name: 'Monday League Fee',
            description: '',
            variations: [
              { id: 'var-1', name: 'Regular', price: 1500, currency: 'USD' },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('not-found', { status: 404 });
});
vi.stubGlobal('fetch', fetchMock);

import type { InsertLeagueInput, InsertLeague } from '@shared/schema';
import { Form } from '@/components/ui/form';
import { LeagueSquareCatalog } from '@/components/league-square-catalog';
import { categoryStorageKey } from '@/components/league-square-catalog-storage';

const SEARCH_KEY = (loc: number) => `league-square-catalog:search:${loc}`;

interface HarnessProps {
  initialLocationId: number | null;
  initialCategoryId?: string | null;
}

function Harness({
  initialLocationId,
  initialCategoryId = null,
}: HarnessProps) {
  const [locationId, setLocationId] = useState<number | null>(initialLocationId);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    initialCategoryId,
  );
  const form = useForm<InsertLeagueInput, unknown, InsertLeague>({
    defaultValues: {
      name: '',
      description: '',
      active: true,
      allowPublicSignup: false,
      seasonStart: new Date().toISOString(),
      seasonEnd: new Date().toISOString(),
      weekDay: 'Monday',
      practiceStartTime: '',
      competitionStartTime: '',
      timezone: 'America/New_York',
      weeklyFee: 0,
      lineageFee: null,
      prizeFundFee: null,
      paymentMode: 'weekly',
      squareLineageItemId: null,
      lineageItemVariationId: null,
      squareLineageItemName: null,
      squarePrizeFundItemId: null,
      prizeFundItemVariationId: null,
      squarePrizeFundItemName: null,
      squareCategoryId: initialCategoryId,
      locationId: null,
      totalBowlingWeeks: 30,
      skipDates: [],
      cancelledDates: [],
    },
  });
  return (
    <div>
      <button
        type="button"
        data-testid="switch-to-location-99"
        onClick={() => setLocationId(99)}
      >
        switch
      </button>
      <span data-testid="probe-category-id">{selectedCategoryId ?? ''}</span>
      <span data-testid="probe-form-category-id">
        {form.watch('squareCategoryId') ?? ''}
      </span>
      <Form {...form}>
        <LeagueSquareCatalog
          form={form}
          locationId={locationId}
          selectedCategoryId={selectedCategoryId}
          onCategoryChange={setSelectedCategoryId}
        />
      </Form>
    </div>
  );
}

function renderHarness(props: HarnessProps) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

describe('LeagueSquareCatalog filter memory', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
  });

  it('restores a per-location search query from localStorage on mount', async () => {
    localStorage.setItem(SEARCH_KEY(7), 'monday');
    renderHarness({ initialLocationId: 7 });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    expect(input.value).toBe('monday');
  });

  it('does not restore another location\'s saved search', async () => {
    localStorage.setItem(SEARCH_KEY(7), 'monday');
    renderHarness({ initialLocationId: 8 });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    expect(input.value).toBe('');
  });

  it('persists search input per location and clears the entry when emptied', async () => {
    const user = userEvent.setup();
    renderHarness({ initialLocationId: 12 });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());
    await user.type(input, 'tues');
    expect(localStorage.getItem(SEARCH_KEY(12))).toBe('tues');

    const clearSearchBtn = screen.getByTestId('button-clear-catalog-search');
    await user.click(clearSearchBtn);
    expect(input.value).toBe('');
    expect(localStorage.getItem(SEARCH_KEY(12))).toBeNull();
  });

  it('swapping locations loads each location\'s own remembered search', async () => {
    localStorage.setItem(SEARCH_KEY(99), 'tournament');
    const user = userEvent.setup();
    renderHarness({ initialLocationId: 5 });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    expect(input.value).toBe('');
    await waitFor(() => expect(input).not.toBeDisabled());

    await user.type(input, 'thurs');
    expect(localStorage.getItem(SEARCH_KEY(5))).toBe('thurs');

    await user.click(screen.getByTestId('switch-to-location-99'));

    const swappedInput = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(swappedInput.value).toBe('tournament'));
    expect(localStorage.getItem(SEARCH_KEY(5))).toBe('thurs');
  });

  it('restores the saved category for a location on mount when none is selected', async () => {
    localStorage.setItem(categoryStorageKey(31), 'cat-events');
    renderHarness({ initialLocationId: 31, initialCategoryId: null });

    await waitFor(() => {
      expect(screen.getByTestId('probe-category-id').textContent).toBe(
        'cat-events',
      );
    });
    expect(screen.getByTestId('probe-form-category-id').textContent).toBe(
      'cat-events',
    );
  });

  it('does not override an already-selected category on mount (edit mode)', async () => {
    localStorage.setItem(categoryStorageKey(31), 'cat-events');
    renderHarness({
      initialLocationId: 31,
      initialCategoryId: 'cat-leagues',
    });

    await screen.findByTestId('input-catalog-search');
    expect(screen.getByTestId('probe-category-id').textContent).toBe(
      'cat-leagues',
    );
  });

  it('"Clear filters" button resets both search and category and wipes their storage', async () => {
    const user = userEvent.setup();
    localStorage.setItem(SEARCH_KEY(42), 'league');
    localStorage.setItem(categoryStorageKey(42), 'cat-leagues');
    renderHarness({ initialLocationId: 42, initialCategoryId: 'cat-leagues' });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    expect(input.value).toBe('league');

    const clearAllBtn = await screen.findByTestId(
      'button-clear-catalog-filters',
    );
    await user.click(clearAllBtn);

    expect(input.value).toBe('');
    expect(localStorage.getItem(SEARCH_KEY(42))).toBeNull();
    expect(localStorage.getItem(categoryStorageKey(42))).toBeNull();
    expect(
      screen.queryByTestId('button-clear-catalog-filters'),
    ).not.toBeInTheDocument();
  });
});
