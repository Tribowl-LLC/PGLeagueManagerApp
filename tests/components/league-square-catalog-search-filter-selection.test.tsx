import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

// 3 Monday + 3 Tuesday items, every variation has a unique price (cents) so
// any assertion against a specific picked variation is unambiguous.
const ITEMS = [
  {
    id: 'm-1',
    name: 'Monday League Item 1',
    description: '',
    variations: [{ id: 'm-var-1', name: 'Regular', price: 1000, currency: 'USD' }],
  },
  {
    id: 'm-2',
    name: 'Monday League Item 2',
    description: '',
    variations: [{ id: 'm-var-2', name: 'Regular', price: 1100, currency: 'USD' }],
  },
  {
    id: 'm-3',
    name: 'Monday League Item 3',
    description: '',
    variations: [{ id: 'm-var-3', name: 'Regular', price: 1200, currency: 'USD' }],
  },
  {
    id: 't-1',
    name: 'Tuesday League Item 1',
    description: '',
    variations: [{ id: 't-var-1', name: 'Regular', price: 2000, currency: 'USD' }],
  },
  {
    id: 't-2',
    name: 'Tuesday League Item 2',
    description: '',
    variations: [{ id: 't-var-2', name: 'Regular', price: 2100, currency: 'USD' }],
  },
  {
    id: 't-3',
    name: 'Tuesday League Item 3',
    description: '',
    variations: [{ id: 't-var-3', name: 'Regular', price: 2200, currency: 'USD' }],
  },
];
const TOTAL_ITEMS = ITEMS.length;
const TUESDAY_COUNT = ITEMS.filter((i) => i.name.startsWith('Tuesday')).length;

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/payments-provider/catalog/categories')) {
    return new Response(
      JSON.stringify({ success: true, data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/api/payments-provider/catalog/items')) {
    return new Response(
      JSON.stringify({ success: true, data: ITEMS }),
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
  const v = form.watch();
  // Hidden mirrors of the form fields the test cares about, so we can read
  // them via testIds without reaching into react-hook-form internals.
  return (
    <Form {...form}>
      <LeagueSquareCatalog
        form={form}
        locationId={1}
        selectedCategoryId={selectedCategoryId}
        onCategoryChange={setSelectedCategoryId}
      />
      <div hidden data-testid="form-state">
        <span data-testid="form-square-lineage-item-id">
          {v.squareLineageItemId ?? ''}
        </span>
        <span data-testid="form-lineage-item-variation-id">
          {v.lineageItemVariationId ?? ''}
        </span>
        <span data-testid="form-square-lineage-item-name">
          {v.squareLineageItemName ?? ''}
        </span>
        <span data-testid="form-lineage-fee">
          {v.lineageFee == null ? '' : String(v.lineageFee)}
        </span>
        <span data-testid="form-square-prize-fund-item-id">
          {v.squarePrizeFundItemId ?? ''}
        </span>
        <span data-testid="form-prize-fund-item-variation-id">
          {v.prizeFundItemVariationId ?? ''}
        </span>
        <span data-testid="form-square-prize-fund-item-name">
          {v.squarePrizeFundItemName ?? ''}
        </span>
        <span data-testid="form-prize-fund-fee">
          {v.prizeFundFee == null ? '' : String(v.prizeFundFee)}
        </span>
        <span data-testid="form-weekly-fee">
          {v.weeklyFee == null ? '' : String(v.weeklyFee)}
        </span>
      </div>
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

// The 3 Radix combobox triggers, in render order, are:
//   0 = "Filter by Category", 1 = "Lineage Item", 2 = "Prize Fund Item"
const LINEAGE_TRIGGER_INDEX = 1;
const PRIZE_FUND_TRIGGER_INDEX = 2;

async function openSelect(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
) {
  const triggers = screen.getAllByRole('combobox');
  await user.click(triggers[index]);
  await waitFor(() => {
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
}

describe('LeagueSquareCatalog — picking a search-filtered item wires every form field', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
  });

  it('Lineage: typing a search query then picking a filtered item sets squareLineageItemId, lineageItemVariationId, squareLineageItemName, lineageFee, and weeklyFee from the picked variation', async () => {
    const user = userEvent.setup();
    renderHarness();

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // Narrow the catalog to the 3 Tuesday items via the search input
    // (debounced ~200ms; wait for the visible match-count line to flush).
    await user.type(input, 'tuesday');
    await waitFor(() => {
      const counter = screen.getByTestId('text-catalog-search-count');
      expect(counter.textContent).toContain(
        `${TUESDAY_COUNT} of ${TOTAL_ITEMS}`,
      );
    });

    // Open the Lineage dropdown — it should now show only the 3 filtered
    // Tuesday items plus "None" — and pick "Tuesday League Item 2"
    // (variation id t-var-2, price 2100 cents).
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    const filteredOptions = screen.getAllByRole('option');
    expect(filteredOptions).toHaveLength(TUESDAY_COUNT + 1);
    await user.click(
      screen.getByRole('option', { name: /Tuesday League Item 2/ }),
    );

    // Every lineage form field is set from the picked variation, and
    // weeklyFee is the lineage price (no prize fund picked yet).
    await waitFor(() => {
      expect(
        screen.getByTestId('form-square-lineage-item-id').textContent,
      ).toBe('t-2');
      expect(
        screen.getByTestId('form-lineage-item-variation-id').textContent,
      ).toBe('t-var-2');
      expect(
        screen.getByTestId('form-square-lineage-item-name').textContent,
      ).toBe('Tuesday League Item 2');
      expect(screen.getByTestId('form-lineage-fee').textContent).toBe('2100');
      expect(screen.getByTestId('form-weekly-fee').textContent).toBe('2100');
    });
  });

  it('Prize Fund: typing a search query then picking a filtered item sets squarePrizeFundItemId, prizeFundItemVariationId, squarePrizeFundItemName, prizeFundFee, and recomputes weeklyFee = lineagePrice + prizeFundPrice', async () => {
    const user = userEvent.setup();
    renderHarness();

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // First pick a Lineage item without a search filter so we have a
    // known lineage baseline (Monday League Item 1, price 1000 cents).
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    await user.click(
      screen.getByRole('option', { name: /Monday League Item 1/ }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('form-lineage-fee').textContent).toBe('1000');
      expect(screen.getByTestId('form-weekly-fee').textContent).toBe('1000');
    });

    // Now narrow the catalog to the 3 Tuesday items.
    await user.type(input, 'tuesday');
    await waitFor(() => {
      const counter = screen.getByTestId('text-catalog-search-count');
      expect(counter.textContent).toContain(
        `${TUESDAY_COUNT} of ${TOTAL_ITEMS}`,
      );
    });

    // Pick a Prize Fund item from the filtered list (Tuesday League
    // Item 3, variation id t-var-3, price 2200 cents).
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    const filteredPfOptions = screen.getAllByRole('option');
    // None + 3 visible Tuesday items = 4 options. (Lineage is Monday so it
    // would show as a fallback only on the Lineage dropdown, not here.)
    expect(filteredPfOptions).toHaveLength(TUESDAY_COUNT + 1);
    await user.click(
      screen.getByRole('option', { name: /Tuesday League Item 3/ }),
    );

    // Every prize-fund form field reflects the picked variation, and
    // weeklyFee is now lineagePrice (1000) + prizeFundPrice (2200) = 3200.
    await waitFor(() => {
      expect(
        screen.getByTestId('form-square-prize-fund-item-id').textContent,
      ).toBe('t-3');
      expect(
        screen.getByTestId('form-prize-fund-item-variation-id').textContent,
      ).toBe('t-var-3');
      expect(
        screen.getByTestId('form-square-prize-fund-item-name').textContent,
      ).toBe('Tuesday League Item 3');
      expect(screen.getByTestId('form-prize-fund-fee').textContent).toBe(
        '2200',
      );
      expect(screen.getByTestId('form-weekly-fee').textContent).toBe('3200');
    });
  });
});
