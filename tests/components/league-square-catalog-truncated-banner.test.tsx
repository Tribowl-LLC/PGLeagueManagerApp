import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
}

const ITEMS = [
  {
    id: 'item-1',
    name: 'Monday League Item 1',
    description: '',
    variations: [
      { id: 'var-1', name: 'Regular', price: 1500, currency: 'USD' },
    ],
  },
];

const CATEGORIES = [{ id: 'cat-1', name: 'Leagues' }];

interface MockState {
  itemsTruncated: boolean;
  categoriesTruncated: boolean;
}

const mockState: MockState = {
  itemsTruncated: false,
  categoriesTruncated: false,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/payments-provider/catalog/categories')) {
    return new Response(
      JSON.stringify({
        success: true,
        data: { categories: CATEGORIES, truncated: mockState.categoriesTruncated },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/api/payments-provider/catalog/items')) {
    return new Response(
      JSON.stringify({
        success: true,
        data: { items: ITEMS, truncated: mockState.itemsTruncated },
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

function Harness() {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
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
      squareCategoryId: null,
      locationId: null,
      totalBowlingWeeks: 30,
      skipDates: [],
      cancelledDates: [],
    },
  });
  return (
    <Form {...form}>
      <LeagueSquareCatalog
        form={form}
        locationId={1}
        selectedCategoryId={selectedCategoryId}
        onCategoryChange={setSelectedCategoryId}
      />
    </Form>
  );
}

function renderHarness() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe('LeagueSquareCatalog truncated banner', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
    mockState.itemsTruncated = false;
    mockState.categoriesTruncated = false;
  });

  it('renders the destructive banner when the items response comes back truncated', async () => {
    mockState.itemsTruncated = true;
    renderHarness();

    const banner = await screen.findByTestId('alert-catalog-truncated');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('too large to fully load');
  });

  it('does not render the banner when both responses report truncated:false', async () => {
    renderHarness();

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    expect(
      screen.queryByTestId('alert-catalog-truncated'),
    ).not.toBeInTheDocument();
  });
});
