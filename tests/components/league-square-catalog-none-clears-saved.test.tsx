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

// One Monday + one Tuesday item, each with a single uniquely-priced
// variation. The harness will pre-seed Monday as the saved Lineage and
// Tuesday as the saved Prize Fund so we can prove that picking "None"
// in the dropdown actually clears all 4 saved fields on each side.
const ITEMS = [
  {
    id: 'm-1',
    name: 'Monday League Item 1',
    description: '',
    variations: [{ id: 'm-var-1', name: 'Regular', price: 1000, currency: 'USD' }],
  },
  {
    id: 't-1',
    name: 'Tuesday League Item 1',
    description: '',
    variations: [{ id: 't-var-1', name: 'Regular', price: 2000, currency: 'USD' }],
  },
];

const SAVED_LINEAGE_ITEM_ID = 'm-1';
const SAVED_LINEAGE_VARIATION_ID = 'm-var-1';
const SAVED_LINEAGE_NAME = 'Monday League Item 1';
const SAVED_LINEAGE_FEE = 1000;

const SAVED_PRIZE_FUND_ITEM_ID = 't-1';
const SAVED_PRIZE_FUND_VARIATION_ID = 't-var-1';
const SAVED_PRIZE_FUND_NAME = 'Tuesday League Item 1';
const SAVED_PRIZE_FUND_FEE = 2000;

// Pre-seeded weekly fee = saved lineage + saved prize fund. The "None"
// branches must NOT clobber this value (the handler only touches the
// per-side fee, not weeklyFee).
const SAVED_WEEKLY_FEE = SAVED_LINEAGE_FEE + SAVED_PRIZE_FUND_FEE;

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
      weeklyFee: SAVED_WEEKLY_FEE,
      lineageFee: SAVED_LINEAGE_FEE,
      prizeFundFee: SAVED_PRIZE_FUND_FEE,
      paymentMode: 'weekly',
      squareLineageItemId: SAVED_LINEAGE_ITEM_ID,
      lineageItemVariationId: SAVED_LINEAGE_VARIATION_ID,
      squareLineageItemName: SAVED_LINEAGE_NAME,
      squarePrizeFundItemId: SAVED_PRIZE_FUND_ITEM_ID,
      prizeFundItemVariationId: SAVED_PRIZE_FUND_VARIATION_ID,
      squarePrizeFundItemName: SAVED_PRIZE_FUND_NAME,
      squareCategoryId: null,
      locationId: null,
      totalBowlingWeeks: 30,
      skipDates: [],
      cancelledDates: [],
    },
  });
  const v = form.watch();
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

describe('LeagueSquareCatalog — picking "None" actually clears the saved Square selection', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
  });

  it('Lineage: picking None resets all 4 lineage fields to null and leaves weeklyFee untouched', async () => {
    const user = userEvent.setup();
    renderHarness();

    // Wait for the catalog fetch to settle so the dropdown is populated.
    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // Sanity-check: the form really was pre-seeded with the saved snapshot.
    expect(
      screen.getByTestId('form-square-lineage-item-id').textContent,
    ).toBe(SAVED_LINEAGE_ITEM_ID);
    expect(
      screen.getByTestId('form-lineage-item-variation-id').textContent,
    ).toBe(SAVED_LINEAGE_VARIATION_ID);
    expect(
      screen.getByTestId('form-square-lineage-item-name').textContent,
    ).toBe(SAVED_LINEAGE_NAME);
    expect(screen.getByTestId('form-lineage-fee').textContent).toBe(
      String(SAVED_LINEAGE_FEE),
    );
    expect(screen.getByTestId('form-weekly-fee').textContent).toBe(
      String(SAVED_WEEKLY_FEE),
    );

    // Open the Lineage dropdown and click "None".
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    await user.click(screen.getByRole('option', { name: /^None$/ }));

    // All 4 lineage fields go back to null...
    await waitFor(() => {
      expect(
        screen.getByTestId('form-square-lineage-item-id').textContent,
      ).toBe('');
      expect(
        screen.getByTestId('form-lineage-item-variation-id').textContent,
      ).toBe('');
      expect(
        screen.getByTestId('form-square-lineage-item-name').textContent,
      ).toBe('');
      expect(screen.getByTestId('form-lineage-fee').textContent).toBe('');
    });

    // ...and weeklyFee is NOT clobbered by the None reset.
    expect(screen.getByTestId('form-weekly-fee').textContent).toBe(
      String(SAVED_WEEKLY_FEE),
    );
    // The Prize Fund side is untouched too.
    expect(
      screen.getByTestId('form-square-prize-fund-item-id').textContent,
    ).toBe(SAVED_PRIZE_FUND_ITEM_ID);
    expect(
      screen.getByTestId('form-prize-fund-item-variation-id').textContent,
    ).toBe(SAVED_PRIZE_FUND_VARIATION_ID);
    expect(
      screen.getByTestId('form-square-prize-fund-item-name').textContent,
    ).toBe(SAVED_PRIZE_FUND_NAME);
    expect(screen.getByTestId('form-prize-fund-fee').textContent).toBe(
      String(SAVED_PRIZE_FUND_FEE),
    );
  });

  it('Prize Fund: picking None resets all 4 prize-fund fields to null and leaves weeklyFee untouched', async () => {
    const user = userEvent.setup();
    renderHarness();

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // Sanity-check: the form really was pre-seeded with the saved snapshot.
    expect(
      screen.getByTestId('form-square-prize-fund-item-id').textContent,
    ).toBe(SAVED_PRIZE_FUND_ITEM_ID);
    expect(
      screen.getByTestId('form-prize-fund-item-variation-id').textContent,
    ).toBe(SAVED_PRIZE_FUND_VARIATION_ID);
    expect(
      screen.getByTestId('form-square-prize-fund-item-name').textContent,
    ).toBe(SAVED_PRIZE_FUND_NAME);
    expect(screen.getByTestId('form-prize-fund-fee').textContent).toBe(
      String(SAVED_PRIZE_FUND_FEE),
    );
    expect(screen.getByTestId('form-weekly-fee').textContent).toBe(
      String(SAVED_WEEKLY_FEE),
    );

    // Open the Prize Fund dropdown and click "None".
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    await user.click(screen.getByRole('option', { name: /^None$/ }));

    // All 4 prize-fund fields go back to null...
    await waitFor(() => {
      expect(
        screen.getByTestId('form-square-prize-fund-item-id').textContent,
      ).toBe('');
      expect(
        screen.getByTestId('form-prize-fund-item-variation-id').textContent,
      ).toBe('');
      expect(
        screen.getByTestId('form-square-prize-fund-item-name').textContent,
      ).toBe('');
      expect(screen.getByTestId('form-prize-fund-fee').textContent).toBe('');
    });

    // ...and weeklyFee is NOT clobbered by the None reset.
    expect(screen.getByTestId('form-weekly-fee').textContent).toBe(
      String(SAVED_WEEKLY_FEE),
    );
    // The Lineage side is untouched too.
    expect(
      screen.getByTestId('form-square-lineage-item-id').textContent,
    ).toBe(SAVED_LINEAGE_ITEM_ID);
    expect(
      screen.getByTestId('form-lineage-item-variation-id').textContent,
    ).toBe(SAVED_LINEAGE_VARIATION_ID);
    expect(
      screen.getByTestId('form-square-lineage-item-name').textContent,
    ).toBe(SAVED_LINEAGE_NAME);
    expect(screen.getByTestId('form-lineage-fee').textContent).toBe(
      String(SAVED_LINEAGE_FEE),
    );
  });
});
