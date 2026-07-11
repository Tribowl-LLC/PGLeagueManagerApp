import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { InsertLeagueInput, InsertLeague } from "@shared/schema";
import {
  searchStorageKey,
  categoryStorageKey,
} from "@/components/league-square-catalog-storage";
import { LeagueSquareCatalogEmptyLocation } from "@/components/league-square-catalog-empty-location";
import { LeagueSquareCatalogStatus } from "@/components/league-square-catalog-status";
import { LeagueSquareCatalogFilterFields } from "@/components/league-square-catalog-filter-fields";
import { LeagueSquareCatalogItemSelect } from "@/components/league-square-catalog-item-select";

function readStoredFilter(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStoredFilter(key: string, value: string | null) {
  try {
    if (value && value.length > 0) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

interface CatalogItemVariation {
  id: string;
  name: string;
  price: number | null;
  currency: string;
}

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  variations: CatalogItemVariation[];
}

interface CatalogCategory {
  id: string;
  name: string;
}

interface LeagueSquareCatalogProps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  locationId: number | null;
  selectedCategoryId: string | null;
  onCategoryChange: (categoryId: string | null) => void;
}

interface OriginalSelection {
  variationId: string | null;
  itemId: string | null;
  name: string | null;
  fee: number | null;
}

function readOriginal(
  defaults: Partial<InsertLeagueInput> | undefined,
  variationKey: 'lineageItemVariationId' | 'prizeFundItemVariationId',
  itemKey: 'squareLineageItemId' | 'squarePrizeFundItemId',
  nameKey: 'squareLineageItemName' | 'squarePrizeFundItemName',
  feeKey: 'lineageFee' | 'prizeFundFee',
): OriginalSelection {
  return {
    variationId: defaults?.[variationKey] ?? null,
    itemId: defaults?.[itemKey] ?? null,
    name: defaults?.[nameKey] ?? null,
    fee: defaults?.[feeKey] ?? null,
  };
}

// Task #623: the catalog API now returns
// `{ items|categories, truncated }` instead of a bare array, so the
// admin UI can show a banner when the pagination safety cap fired
// and the visible list is incomplete. We accept the bare-array
// shape too as a defensive fallback in case a stale server is
// still on the pre-#623 contract.
type CategoriesPayload = CatalogCategory[] | { categories: CatalogCategory[]; truncated?: boolean };
type ItemsPayload = CatalogItem[] | { items: CatalogItem[]; truncated?: boolean };

const readCategories = (payload: CategoriesPayload | undefined) =>
  Array.isArray(payload) ? payload : payload?.categories ?? [];
const readItems = (payload: ItemsPayload | undefined) =>
  Array.isArray(payload) ? payload : payload?.items ?? [];
const readTruncated = (payload: CategoriesPayload | ItemsPayload | undefined) =>
  !!(payload && !Array.isArray(payload) && payload.truncated);

function restoreLineageOriginal(
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>,
  originalLineage: OriginalSelection,
  getPriceForVariation: (variationId: string | null | undefined) => number | null,
) {
  form.setValue('squareLineageItemId', originalLineage.itemId);
  form.setValue('lineageItemVariationId', originalLineage.variationId);
  form.setValue('squareLineageItemName', originalLineage.name);
  form.setValue('lineageFee', originalLineage.fee);
  const lineagePrice = originalLineage.fee ?? 0;
  const prizeFundPrice =
    getPriceForVariation(form.getValues('prizeFundItemVariationId')) ??
    form.getValues('prizeFundFee') ??
    0;
  const total = lineagePrice + prizeFundPrice;
  if (total > 0) form.setValue('weeklyFee', total);
}

function restorePrizeFundOriginal(
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>,
  originalPrizeFund: OriginalSelection,
  getPriceForVariation: (variationId: string | null | undefined) => number | null,
) {
  form.setValue('squarePrizeFundItemId', originalPrizeFund.itemId);
  form.setValue('prizeFundItemVariationId', originalPrizeFund.variationId);
  form.setValue('squarePrizeFundItemName', originalPrizeFund.name);
  form.setValue('prizeFundFee', originalPrizeFund.fee);
  const prizeFundPrice = originalPrizeFund.fee ?? 0;
  const lineagePrice =
    getPriceForVariation(form.getValues('lineageItemVariationId')) ??
    form.getValues('lineageFee') ??
    0;
  const total = lineagePrice + prizeFundPrice;
  if (total > 0) form.setValue('weeklyFee', total);
}

interface LineageHandlerDeps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  catalogVariationIndex: Map<string, { item: CatalogItem; variation: CatalogItemVariation }>;
  getPriceForVariation: (variationId: string | null | undefined) => number | null;
  originalLineage: OriginalSelection;
}

function makeLineageOnValueChange({
  form,
  catalogVariationIndex,
  getPriceForVariation,
  originalLineage,
}: LineageHandlerDeps) {
  return (value: string) => {
    if (value === 'none') {
      form.setValue('squareLineageItemId', null);
      form.setValue('lineageItemVariationId', null);
      form.setValue('squareLineageItemName', null);
      form.setValue('lineageFee', null);
      return;
    }
    const lineageMatch = catalogVariationIndex.get(value);
    if (lineageMatch) {
      const { item, variation } = lineageMatch;
      form.setValue('squareLineageItemId', item.id);
      form.setValue('lineageItemVariationId', variation.id);
      form.setValue('squareLineageItemName', `${item.name}${variation.name !== 'Regular' && variation.name !== 'Default' ? ` - ${variation.name}` : ''}`);
      const lineagePrice = variation.price || 0;
      const prizeFundPrice = getPriceForVariation(form.getValues('prizeFundItemVariationId'));
      const total = lineagePrice + (prizeFundPrice || 0);
      if (total > 0) form.setValue('weeklyFee', total);
      if (lineagePrice > 0) form.setValue('lineageFee', lineagePrice);
      return;
    }
    // The clicked value isn't in `catalogItems` — the only legitimate
    // value here is the originally-saved Lineage row (rendered as the
    // fallback below for items that have been hidden by the search /
    // category filter, or removed from Square entirely). Restore the
    // full saved snapshot so the form doesn't end up with the new
    // variation id but the previous item id / name / fee.
    if (
      originalLineage.variationId &&
      originalLineage.name &&
      value === originalLineage.variationId
    ) {
      restoreLineageOriginal(form, originalLineage, getPriceForVariation);
    }
  };
}

interface PrizeFundHandlerDeps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  catalogVariationIndex: Map<string, { item: CatalogItem; variation: CatalogItemVariation }>;
  getPriceForVariation: (variationId: string | null | undefined) => number | null;
  originalPrizeFund: OriginalSelection;
}

function makePrizeFundOnValueChange({
  form,
  catalogVariationIndex,
  getPriceForVariation,
  originalPrizeFund,
}: PrizeFundHandlerDeps) {
  return (value: string) => {
    if (value === 'none') {
      form.setValue('squarePrizeFundItemId', null);
      form.setValue('prizeFundItemVariationId', null);
      form.setValue('squarePrizeFundItemName', null);
      form.setValue('prizeFundFee', null);
      return;
    }
    const prizeFundMatch = catalogVariationIndex.get(value);
    if (prizeFundMatch) {
      const { item, variation } = prizeFundMatch;
      form.setValue('squarePrizeFundItemId', item.id);
      form.setValue('prizeFundItemVariationId', variation.id);
      form.setValue('squarePrizeFundItemName', `${item.name}${variation.name !== 'Regular' && variation.name !== 'Default' ? ` - ${variation.name}` : ''}`);
      const lineagePrice = getPriceForVariation(form.getValues('lineageItemVariationId'));
      const prizeFundPrice = variation.price || 0;
      const total = (lineagePrice || 0) + prizeFundPrice;
      if (total > 0) form.setValue('weeklyFee', total);
      if (prizeFundPrice > 0) form.setValue('prizeFundFee', prizeFundPrice);
      return;
    }
    // See the Lineage handler above for why we restore the snapshot
    // here instead of silently exiting.
    if (
      originalPrizeFund.variationId &&
      originalPrizeFund.name &&
      value === originalPrizeFund.variationId
    ) {
      restorePrizeFundOriginal(form, originalPrizeFund, getPriceForVariation);
    }
  };
}

export function LeagueSquareCatalog({
  form,
  locationId,
  selectedCategoryId,
  onCategoryChange,
}: LeagueSquareCatalogProps) {
  const { data: categoriesData } = useQuery<{ success: boolean; data: CategoriesPayload }>({
    queryKey: ['/api/payments-provider/catalog/categories', locationId],
    queryFn: async () => {
      const catalogLocationParam = locationId ? `?locationId=${locationId}` : '';
      const res = await fetch(`/api/payments-provider/catalog/categories${catalogLocationParam}`);
      if (!res.ok) throw new Error('Failed to fetch catalog categories');
      return res.json();
    },
    staleTime: 1000 * 60 * 10,
    enabled: !!locationId,
  });
  const categories = readCategories(categoriesData?.data);

  const { data: allCatalogData, isLoading: isLoadingCatalog } = useQuery<{ success: boolean; data: ItemsPayload }>({
    queryKey: ['/api/payments-provider/catalog/items', locationId],
    queryFn: async () => {
      const catalogLocationParam = locationId ? `?locationId=${locationId}` : '';
      const res = await fetch(`/api/payments-provider/catalog/items${catalogLocationParam}`);
      if (!res.ok) throw new Error('Failed to fetch catalog items');
      return res.json();
    },
    staleTime: 1000 * 60 * 10,
    enabled: !!locationId,
  });
  const allCatalogItems = readItems(allCatalogData?.data);

  const { data: filteredCatalogData } = useQuery<{ success: boolean; data: ItemsPayload }>({
    queryKey: ['/api/payments-provider/catalog/items', locationId, selectedCategoryId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedCategoryId) params.set('categoryId', selectedCategoryId);
      if (locationId) params.set('locationId', String(locationId));
      const res = await fetch(`/api/payments-provider/catalog/items?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch catalog items');
      return res.json();
    },
    staleTime: 1000 * 60 * 10,
    enabled: !!selectedCategoryId && !!locationId,
  });

  const catalogItems = selectedCategoryId
    ? readItems(filteredCatalogData?.data)
    : allCatalogItems;
  const hasCatalogItems = allCatalogItems.length > 0;

  // Task #641: a saved Lineage / Prize Fund variation id can quietly point at
  // an item that was deleted from the Square dashboard (or otherwise removed
  // from the live catalog). The fallback row keeps the dropdown rendering the
  // saved name, but with no signal that the item is no longer purchasable —
  // bowlers then hit checkout failures. We compare the *currently-selected*
  // variation id against the unfiltered `allCatalogItems` so an active
  // category filter doesn't produce a false positive, and so the warning
  // disappears the moment the admin re-picks a live item.
  const isVariationInLiveCatalog = (variationId: string | null | undefined) => {
    if (!variationId) return true;
    return allCatalogItems.some(item =>
      item.variations.some(v => v.id === variationId),
    );
  };
  const currentLineageVariationId = form.watch('lineageItemVariationId');
  const currentPrizeFundVariationId = form.watch('prizeFundItemVariationId');
  const lineageMissingFromCatalog =
    hasCatalogItems &&
    !!currentLineageVariationId &&
    !isVariationInLiveCatalog(currentLineageVariationId);
  const prizeFundMissingFromCatalog =
    hasCatalogItems &&
    !!currentPrizeFundVariationId &&
    !isVariationInLiveCatalog(currentPrizeFundVariationId);

  // Show the truncated banner if either the all-items or the
  // currently-filtered branch came back capped — either way the
  // visible list is incomplete.
  const isCatalogTruncated =
    readTruncated(allCatalogData?.data) ||
    (!!selectedCategoryId && readTruncated(filteredCatalogData?.data));

  const [searchInput, setSearchInput] = useState(() =>
    locationId ? readStoredFilter(searchStorageKey(locationId)) : ''
  );
  useEffect(() => {
    if (!locationId) {
      setSearchInput('');
      return;
    }
    setSearchInput(readStoredFilter(searchStorageKey(locationId)));
  }, [locationId]);

  useEffect(() => {
    if (!locationId) return;
    if (selectedCategoryId) return;
    const saved = readStoredFilter(categoryStorageKey(locationId));
    if (!saved) return;
    onCategoryChange(saved);
    form.setValue('squareCategoryId', saved);
  }, [locationId, selectedCategoryId, onCategoryChange, form]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (locationId) writeStoredFilter(searchStorageKey(locationId), value);
  };

  const handleClearFilters = () => {
    if (searchInput) {
      setSearchInput('');
      if (locationId) writeStoredFilter(searchStorageKey(locationId), null);
    }
    if (selectedCategoryId) {
      onCategoryChange(null);
      form.setValue('squareCategoryId', null);
      if (locationId) writeStoredFilter(categoryStorageKey(locationId), null);
    }
  };

  const hasActiveFilters = searchInput.length > 0 || !!selectedCategoryId;

  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput.trim().toLowerCase()), 200);
    return () => clearTimeout(id);
  }, [searchInput]);

  const visibleCatalogItems = useMemo(() => {
    if (!debouncedSearch) return catalogItems;
    return catalogItems.filter(item => item.name.toLowerCase().includes(debouncedSearch));
  }, [catalogItems, debouncedSearch]);
  const isSearching = debouncedSearch.length > 0;

  // Variation id -> { item, variation } over the currently-selectable
  // `catalogItems`, built once per catalog change so the select handlers
  // can resolve a clicked variation in O(1) instead of scanning every
  // item's variations on each change. First match wins (variation ids are
  // unique in Square), matching the prior first-match-then-return loops.
  const catalogVariationIndex = useMemo(() => {
    const map = new Map<string, { item: (typeof catalogItems)[number]; variation: (typeof catalogItems)[number]["variations"][number] }>();
    for (const item of catalogItems) {
      for (const variation of item.variations) {
        if (!map.has(variation.id)) map.set(variation.id, { item, variation });
      }
    }
    return map;
  }, [catalogItems]);

  // Variation id -> price across both lists. `allCatalogItems` is written
  // last so it takes precedence, preserving the original lookup order
  // (allCatalogItems scanned before catalogItems).
  const priceByVariation = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const item of catalogItems) {
      for (const v of item.variations) map.set(v.id, v.price);
    }
    for (const item of allCatalogItems) {
      for (const v of item.variations) map.set(v.id, v.price);
    }
    return map;
  }, [catalogItems, allCatalogItems]);

  const getPriceForVariation = (variationId: string | null | undefined): number | null => {
    if (!variationId) return null;
    return priceByVariation.get(variationId) ?? null;
  };

  // Snapshot of the originally-saved Lineage / Prize Fund selections, taken
  // from the form's default values. RHF updates `formState.defaultValues`
  // whenever `form.reset(values)` is called (e.g. when the Edit-League dialog
  // loads a league), so this stays in sync with what was last persisted —
  // unlike `form.watch(...)`, which reflects in-progress user edits. The
  // fallback rows in the Lineage/Prize Fund dropdowns use these snapshots so
  // re-selecting the fallback after picking a different visible item atomically
  // restores the originally-saved item id, name, and fee instead of silently
  // leaving the form in a half-updated state.
  const defaults = form.formState.defaultValues as Partial<InsertLeagueInput> | undefined;
  const originalLineage = readOriginal(
    defaults,
    'lineageItemVariationId',
    'squareLineageItemId',
    'squareLineageItemName',
    'lineageFee',
  );
  const originalPrizeFund = readOriginal(
    defaults,
    'prizeFundItemVariationId',
    'squarePrizeFundItemId',
    'squarePrizeFundItemName',
    'prizeFundFee',
  );

  const lineageOnValueChange = makeLineageOnValueChange({
    form,
    catalogVariationIndex,
    getPriceForVariation,
    originalLineage,
  });

  const prizeFundOnValueChange = makePrizeFundOnValueChange({
    form,
    catalogVariationIndex,
    getPriceForVariation,
    originalPrizeFund,
  });

  if (!locationId) {
    return <LeagueSquareCatalogEmptyLocation />;
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <LeagueSquareCatalogStatus
        hasActiveFilters={hasActiveFilters}
        onClearFilters={handleClearFilters}
        loadState={isLoadingCatalog ? 'loading' : (hasCatalogItems ? 'hasItems' : 'empty')}
        isCatalogTruncated={isCatalogTruncated}
      />

      <LeagueSquareCatalogFilterFields
        searchInput={searchInput}
        onSearchChange={handleSearchChange}
        hasCatalogItems={hasCatalogItems}
        isSearching={isSearching}
        visibleItemCount={visibleCatalogItems.length}
        totalItemCount={catalogItems.length}
        categories={categories}
        selectedCategoryId={selectedCategoryId}
        onCategorySelect={(value) => {
          const catId = value === 'all' ? null : value;
          onCategoryChange(catId);
          form.setValue('squareCategoryId', catId);
          if (locationId) writeStoredFilter(categoryStorageKey(locationId), catId);
        }}
      />

      <LeagueSquareCatalogItemSelect
        label="Lineage Item"
        missingFromCatalog={lineageMissingFromCatalog}
        missingTestId="warn-lineage-missing-from-catalog"
        fallbackTestId="select-lineage-fallback"
        currentVariationId={form.watch('lineageItemVariationId')}
        hasCatalogItems={hasCatalogItems}
        visibleCatalogItems={visibleCatalogItems}
        originalVariationId={originalLineage.variationId}
        originalName={originalLineage.name}
        onValueChange={lineageOnValueChange}
      />

      <LeagueSquareCatalogItemSelect
        label="Prize Fund Item"
        missingFromCatalog={prizeFundMissingFromCatalog}
        missingTestId="warn-prize-fund-missing-from-catalog"
        fallbackTestId="select-prize-fund-fallback"
        currentVariationId={form.watch('prizeFundItemVariationId')}
        hasCatalogItems={hasCatalogItems}
        visibleCatalogItems={visibleCatalogItems}
        originalVariationId={originalPrizeFund.variationId}
        originalName={originalPrizeFund.name}
        onValueChange={prizeFundOnValueChange}
      />
    </div>
  );
}
