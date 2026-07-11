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

const MONDAY_COUNT = 10;
const TUESDAY_COUNT = 10;
const TOTAL_ITEMS = MONDAY_COUNT + TUESDAY_COUNT;

const ITEMS = Array.from({ length: TOTAL_ITEMS }, (_, i) => {
  const isMonday = i < MONDAY_COUNT;
  const dayName = isMonday ? 'Monday' : 'Tuesday';
  const dayIndex = (isMonday ? i : i - MONDAY_COUNT) + 1;
  return {
    id: `item-${i + 1}`,
    name: `${dayName} League Item ${dayIndex}`,
    description: '',
    variations: [
      { id: `var-${i + 1}`, name: 'Regular', price: 1500, currency: 'USD' },
    ],
  };
});

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

interface HarnessProps {
  savedLineageVariationId?: string | null;
  savedLineageItemName?: string | null;
  savedLineageItemId?: string | null;
  savedLineageFee?: number | null;
  savedPrizeFundVariationId?: string | null;
  savedPrizeFundItemName?: string | null;
  savedPrizeFundItemId?: string | null;
  savedPrizeFundFee?: number | null;
  savedWeeklyFee?: number;
}

function Harness({
  savedLineageVariationId = null,
  savedLineageItemName = null,
  savedLineageItemId = null,
  savedLineageFee = null,
  savedPrizeFundVariationId = null,
  savedPrizeFundItemName = null,
  savedPrizeFundItemId = null,
  savedPrizeFundFee = null,
  savedWeeklyFee = 0,
}: HarnessProps) {
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
      weeklyFee: savedWeeklyFee,
      lineageFee: savedLineageFee,
      prizeFundFee: savedPrizeFundFee,
      paymentMode: 'weekly',
      squareLineageItemId: savedLineageItemId,
      lineageItemVariationId: savedLineageVariationId,
      squareLineageItemName: savedLineageItemName,
      squarePrizeFundItemId: savedPrizeFundItemId,
      prizeFundItemVariationId: savedPrizeFundVariationId,
      squarePrizeFundItemName: savedPrizeFundItemName,
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
      <div data-testid="state-lineage">
        {JSON.stringify({
          variationId: form.watch('lineageItemVariationId') ?? null,
          itemId: form.watch('squareLineageItemId') ?? null,
          name: form.watch('squareLineageItemName') ?? null,
          fee: form.watch('lineageFee') ?? null,
        })}
      </div>
      <div data-testid="state-prize-fund">
        {JSON.stringify({
          variationId: form.watch('prizeFundItemVariationId') ?? null,
          itemId: form.watch('squarePrizeFundItemId') ?? null,
          name: form.watch('squarePrizeFundItemName') ?? null,
          fee: form.watch('prizeFundFee') ?? null,
        })}
      </div>
    </Form>
  );
}

function renderHarness(props: HarnessProps = {}) {
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
  // Wait for the listbox / its options to appear in the portal.
  await waitFor(() => {
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
}

async function closeOpenSelect(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
}

describe('LeagueSquareCatalog search filter', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
  });

  it('typing in the search narrows both Lineage and Prize Fund dropdowns and clearing restores them', async () => {
    const user = userEvent.setup();
    renderHarness();

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // Baseline: Lineage dropdown shows all 20 items + the "None" sentinel = 21 options.
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    expect(screen.getAllByRole('option')).toHaveLength(TOTAL_ITEMS + 1);
    await closeOpenSelect(user);

    // Baseline: Prize Fund dropdown shows the same 21 options.
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    expect(screen.getAllByRole('option')).toHaveLength(TOTAL_ITEMS + 1);
    await closeOpenSelect(user);

    // Type a query that should match only the 10 "Tuesday" items, then wait
    // for the debounce (~200ms) to flush via the visible match-count line.
    await user.type(input, 'tuesday');
    await waitFor(() => {
      const counter = screen.getByTestId('text-catalog-search-count');
      expect(counter.textContent).toContain(
        `${TUESDAY_COUNT} of ${TOTAL_ITEMS}`,
      );
    });

    // Lineage dropdown is now narrowed to the 10 tuesday items + "None" = 11.
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    let options = screen.getAllByRole('option');
    expect(options).toHaveLength(TUESDAY_COUNT + 1);
    for (const opt of options) {
      const label = opt.textContent ?? '';
      expect(label === 'None' || label.startsWith('Tuesday League Item')).toBe(
        true,
      );
    }
    await closeOpenSelect(user);

    // Prize Fund dropdown is narrowed identically.
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    options = screen.getAllByRole('option');
    expect(options).toHaveLength(TUESDAY_COUNT + 1);
    for (const opt of options) {
      const label = opt.textContent ?? '';
      expect(label === 'None' || label.startsWith('Tuesday League Item')).toBe(
        true,
      );
    }
    await closeOpenSelect(user);

    // Clear the search via the inline X button. The match-count line disappears
    // and both dropdowns return to the full 21-option list.
    await user.click(screen.getByTestId('button-clear-catalog-search'));
    expect(input.value).toBe('');
    await waitFor(() => {
      expect(
        screen.queryByTestId('text-catalog-search-count'),
      ).not.toBeInTheDocument();
    });

    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    expect(screen.getAllByRole('option')).toHaveLength(TOTAL_ITEMS + 1);
    await closeOpenSelect(user);

    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    expect(screen.getAllByRole('option')).toHaveLength(TOTAL_ITEMS + 1);
    await closeOpenSelect(user);
  });

  it('a previously-saved selection still appears via the fallback row when the search would hide it', async () => {
    const user = userEvent.setup();
    // Pre-seed both dropdowns with saved Monday selections that the
    // upcoming "tuesday" search will filter out of the visible list.
    renderHarness({
      savedLineageVariationId: 'var-1',
      savedLineageItemName: 'Monday League Item 1',
      savedPrizeFundVariationId: 'var-2',
      savedPrizeFundItemName: 'Monday League Item 2',
    });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    await user.type(input, 'tuesday');
    await waitFor(() => {
      const counter = screen.getByTestId('text-catalog-search-count');
      expect(counter.textContent).toContain(
        `${TUESDAY_COUNT} of ${TOTAL_ITEMS}`,
      );
    });

    // Lineage: "None" + fallback (Monday League Item 1) + 10 visible Tuesdays = 12.
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    let options = screen.getAllByRole('option');
    expect(options).toHaveLength(TUESDAY_COUNT + 2);
    expect(
      options.some((opt) => opt.textContent === 'Monday League Item 1'),
    ).toBe(true);
    await closeOpenSelect(user);

    // Prize Fund: same shape but with its own saved fallback row.
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    options = screen.getAllByRole('option');
    expect(options).toHaveLength(TUESDAY_COUNT + 2);
    expect(
      options.some((opt) => opt.textContent === 'Monday League Item 2'),
    ).toBe(true);
    await closeOpenSelect(user);
  });

  it('re-selecting the saved fallback row after picking a different visible item restores the originally-saved item id, name, and fee atomically', async () => {
    const user = userEvent.setup();
    // Pre-seed both Lineage and Prize Fund with full saved selections that
    // point at variations the catalog does NOT contain ("var-deleted-l" and
    // "var-deleted-p"), simulating items that were removed from Square (or
    // are currently being filtered out by category). The fallback row is the
    // only way to re-select them, and we need to prove that doing so restores
    // every related field — not just the variation id.
    renderHarness({
      savedLineageVariationId: 'var-deleted-l',
      savedLineageItemId: 'item-deleted-l',
      savedLineageItemName: 'Deleted Lineage Item',
      savedLineageFee: 2500,
      savedPrizeFundVariationId: 'var-deleted-p',
      savedPrizeFundItemId: 'item-deleted-p',
      savedPrizeFundItemName: 'Deleted Prize Fund Item',
      savedPrizeFundFee: 1500,
      savedWeeklyFee: 4000,
    });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    const readLineage = () =>
      JSON.parse(screen.getByTestId('state-lineage').textContent ?? '{}');
    const readPrizeFund = () =>
      JSON.parse(screen.getByTestId('state-prize-fund').textContent ?? '{}');

    // Sanity: form starts with the originally-saved values intact.
    expect(readLineage()).toEqual({
      variationId: 'var-deleted-l',
      itemId: 'item-deleted-l',
      name: 'Deleted Lineage Item',
      fee: 2500,
    });
    expect(readPrizeFund()).toEqual({
      variationId: 'var-deleted-p',
      itemId: 'item-deleted-p',
      name: 'Deleted Prize Fund Item',
      fee: 1500,
    });

    // Pick a visible Lineage item. The form's Lineage fields update to point
    // at the visible item (var-1 / item-1 / Monday League Item 1 / 1500).
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    await user.click(
      screen.getByRole('option', { name: /^Monday League Item 1\b/ }),
    );
    await waitFor(() => {
      expect(readLineage()).toEqual({
        variationId: 'var-1',
        itemId: 'item-1',
        name: 'Monday League Item 1',
        fee: 1500,
      });
    });

    // Pick a different visible Prize Fund item too.
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    await user.click(
      screen.getByRole('option', { name: /^Monday League Item 2\b/ }),
    );
    await waitFor(() => {
      expect(readPrizeFund()).toEqual({
        variationId: 'var-2',
        itemId: 'item-2',
        name: 'Monday League Item 2',
        fee: 1500,
      });
    });

    // Re-open Lineage and click the fallback row for the originally-saved
    // (catalog-missing) selection. Before the fix this silently exited and
    // left the form with var-1 / item-1 / "Monday League Item 1" / 1500.
    // After the fix, every field snaps back to the saved snapshot.
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    await user.click(screen.getByTestId('select-lineage-fallback'));
    await waitFor(() => {
      expect(readLineage()).toEqual({
        variationId: 'var-deleted-l',
        itemId: 'item-deleted-l',
        name: 'Deleted Lineage Item',
        fee: 2500,
      });
    });

    // Same for Prize Fund.
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    await user.click(screen.getByTestId('select-prize-fund-fallback'));
    await waitFor(() => {
      expect(readPrizeFund()).toEqual({
        variationId: 'var-deleted-p',
        itemId: 'item-deleted-p',
        name: 'Deleted Prize Fund Item',
        fee: 1500,
      });
    });
  });

  // Task #641: with the fallback row in place a saved Lineage / Prize Fund
  // selection that no longer exists in the live Square catalog still renders
  // its name in the dropdown — silently. The warning indicator surfaces that
  // mismatch so the admin knows to re-pick before bowlers hit checkout.
  it('shows a "not in catalog" warning when the saved variation id is missing from the live catalog and hides it once the admin re-picks a live item', async () => {
    const user = userEvent.setup();
    renderHarness({
      // These variation ids are NOT in the mocked catalog (var-1..var-20).
      savedLineageVariationId: 'var-deleted-l',
      savedLineageItemId: 'item-deleted-l',
      savedLineageItemName: 'Deleted Lineage Item',
      savedLineageFee: 2500,
      savedPrizeFundVariationId: 'var-deleted-p',
      savedPrizeFundItemId: 'item-deleted-p',
      savedPrizeFundItemName: 'Deleted Prize Fund Item',
      savedPrizeFundFee: 1500,
    });

    // Wait for the catalog fetch to land — before that, hasCatalogItems is
    // false and the warning intentionally stays hidden so we don't flash a
    // false positive while loading.
    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // Both warnings should now be visible because the saved variations are
    // not present in the live catalog.
    await waitFor(() => {
      expect(
        screen.getByTestId('warn-lineage-missing-from-catalog'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('warn-prize-fund-missing-from-catalog'),
    ).toBeInTheDocument();

    // Re-pick a live Lineage item — its warning disappears, but the Prize
    // Fund warning is unaffected because we still have a stale selection.
    await openSelect(user, LINEAGE_TRIGGER_INDEX);
    await user.click(
      screen.getByRole('option', { name: /^Monday League Item 1\b/ }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId('warn-lineage-missing-from-catalog'),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByTestId('warn-prize-fund-missing-from-catalog'),
    ).toBeInTheDocument();

    // Re-pick a live Prize Fund item — its warning disappears too.
    await openSelect(user, PRIZE_FUND_TRIGGER_INDEX);
    await user.click(
      screen.getByRole('option', { name: /^Monday League Item 2\b/ }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId('warn-prize-fund-missing-from-catalog'),
      ).not.toBeInTheDocument();
    });
  });

  it('does not show the "not in catalog" warning when the saved variation id is present in the live catalog (even if a category filter currently hides it)', async () => {
    const user = userEvent.setup();
    // Saved selection points at a real catalog variation (var-1).
    renderHarness({
      savedLineageVariationId: 'var-1',
      savedLineageItemId: 'item-1',
      savedLineageItemName: 'Monday League Item 1',
      savedLineageFee: 1500,
    });

    const input = await screen.findByTestId<HTMLInputElement>(
      'input-catalog-search',
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    // Baseline: no warning because the saved variation exists in the live
    // catalog.
    expect(
      screen.queryByTestId('warn-lineage-missing-from-catalog'),
    ).not.toBeInTheDocument();

    // Even when a search narrows the visible list to "tuesday" items
    // (hiding var-1 from the dropdown), the warning must NOT appear —
    // the comparison is against the unfiltered live catalog, not the
    // currently-visible list.
    await user.type(input, 'tuesday');
    await waitFor(() => {
      const counter = screen.getByTestId('text-catalog-search-count');
      expect(counter.textContent).toContain(
        `${TUESDAY_COUNT} of ${TOTAL_ITEMS}`,
      );
    });
    expect(
      screen.queryByTestId('warn-lineage-missing-from-catalog'),
    ).not.toBeInTheDocument();
  });
});
