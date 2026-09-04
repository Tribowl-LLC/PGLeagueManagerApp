import type { CatalogObject } from 'square';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { isDev } from '../config';
import { ProviderNotConfiguredError } from './payment-errors';
import { getSquareErrorCtor, type SquareProviderContext } from './square-client';
import { squareCatalogCapAlerter } from './square-catalog-cap-alerts';
import type {
  CatalogCategory,
  CatalogItem,
} from './payment-provider';

const log = createLogger("SquareService");

// Catalog pagination safety caps (Task #613). Square's cursor-based
// pagination has no server-enforced upper bound; a buggy cursor (or a
// hostile/odd Square response that returns a non-empty cursor but never
// unsets it) would loop forever and pin a request. The cap is
// deliberately well above any plausible real-world catalog size — a
// legitimate organization that hits this limit is itself a signal
// worth investigating, hence the `warn` log.
const CATALOG_PAGINATION_MAX_ITEMS = 5_000;
const CATALOG_PAGINATION_MAX_PAGES = 20;

/**
 * Walk a Square catalog cursor until it is empty (or a safety cap is
 * hit), accumulating every CatalogObject across all pages. Used by
 * `listCatalogCategories` and both branches of `listCatalogItems` so
 * the cursor-handling and the safety cap live in exactly one place.
 *
 * `fetchPage` is the per-call differentiator:
 *   - `catalog.list` returns a `Page<CatalogObject>` whose cursor lives
 *     at `page.response?.cursor`.
 *   - `catalog.searchItems` returns the response body directly with
 *     `cursor` at the top level.
 * The caller adapts whichever shape they use into a uniform
 * `{ objects, nextCursor }` for this helper.
 */
async function paginateCatalogObjects(
  fetchPage: (cursor: string | undefined) => Promise<{
    objects: CatalogObject[];
    nextCursor: string | undefined;
  }>,
  context: string,
): Promise<{
  objects: CatalogObject[];
  truncated: boolean;
  truncationReason: 'max_items' | 'max_pages' | null;
}> {
  const all: CatalogObject[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  let truncationReason: 'max_items' | 'max_pages' | null = null;
  do {
    const { objects, nextCursor } = await fetchPage(cursor);
    all.push(...objects);
    pages += 1;
    cursor = nextCursor;
    if (all.length >= CATALOG_PAGINATION_MAX_ITEMS) {
      log.warn(
        `${context}: hit MAX_ITEMS=${CATALOG_PAGINATION_MAX_ITEMS} cap after ${pages} page(s); ` +
          'stopping pagination. Some catalog items may be missing from the response.',
      );
      truncated = true;
      truncationReason = 'max_items';
      break;
    }
    if (pages >= CATALOG_PAGINATION_MAX_PAGES && cursor) {
      log.warn(
        `${context}: hit MAX_PAGES=${CATALOG_PAGINATION_MAX_PAGES} cap with cursor still set; ` +
          `${all.length} object(s) returned. Some catalog items may be missing from the response.`,
      );
      truncated = true;
      truncationReason = 'max_pages';
      break;
    }
  } while (cursor);
  return { objects: all, truncated, truncationReason };
}

/**
 * Fire-and-forget: page support that this tenant just hit the
 * Square catalog pagination safety cap (Task #644). Never thrown:
 * a failure to alert must not turn a degraded-but-working catalog
 * read into a 500. The alerter itself dedupes per-location across
 * a multi-hour window so a chatty admin page can't spam support.
 */
function fireCatalogCapAlert(
  ctx: SquareProviderContext,
  reason: 'max_items' | 'max_pages',
  context: string,
): void {
  void (async () => {
    try {
      const loc = await storage.getLocation(ctx.locationId);
      const organizationId = loc?.organizationId ?? null;
      const result = await squareCatalogCapAlerter.notifyCapHit({
        organizationId,
        locationId: ctx.locationId,
        reason,
        context,
      });
      if (result === 'failed') {
        log.warn('Square catalog cap alert send returned failed', {
          locationId: ctx.locationId,
          organizationId,
          reason,
          context,
        });
      }
    } catch (err) {
      log.error('Square catalog cap alert dispatch threw', {
        locationId: ctx.locationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

export async function listCatalogCategories(
  ctx: SquareProviderContext,
): Promise<{ categories: CatalogCategory[]; truncated: boolean }> {
  const client = await ctx.getClient();
  if (!client) {
    // Intentionally degraded: GET /catalog/categories already
    // converts a factory-level PNCE into an empty list (the
    // admin UI shows a "no catalog yet" empty state in that
    // case). Throwing here would turn that into a 500 inside
    // the route's outer catch. Task #332.
    return { categories: [], truncated: false };
  }

  try {
    // v40+ flat-client `catalog.list` returns a Page<CatalogObject>;
    // we walk the cursor through the shared `paginateCatalogObjects`
    // helper so the safety cap (Task #613) applies here too even
    // though categories rarely approach it.
    const { objects: allObjects, truncated, truncationReason } = await paginateCatalogObjects(
      async (cursor) => {
        const page = await client.catalog.list({ cursor, types: 'CATEGORY' });
        return {
          objects: page.data ?? [],
          nextCursor: page.response?.cursor || undefined,
        };
      },
      'listCatalogCategories',
    );
    if (truncated && truncationReason) {
      fireCatalogCapAlert(ctx, truncationReason, 'listCatalogCategories');
    }

    // v40+ CatalogObject is a discriminated union via `type`. Narrow
    // to the CATEGORY variant so `categoryData` is reachable, and
    // drop any object missing an id (now `string | undefined` on the
    // SDK side — in practice always present for persisted objects).
    const seen = new Set<string>();
    const deduped = allObjects
      .filter((cat): cat is CatalogObject & { type: 'CATEGORY' } => cat.type === 'CATEGORY')
      .filter((cat) => !cat.isDeleted && cat.id)
      .map((cat) => ({
        id: cat.id ?? '',
        name: cat.categoryData?.name || 'Unnamed Category',
      }))
      .filter((cat) => {
        const key = cat.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (isDev) log.info(`Categories: ${allObjects.length} raw -> ${deduped.length} deduped`);
    return { categories: deduped, truncated };
  } catch (error) {
    log.error('Catalog categories error:', error);
    throw new Error(
      'Failed to fetch catalog categories: ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

export async function listCatalogItems(
  ctx: SquareProviderContext,
  categoryId?: string,
): Promise<{ items: CatalogItem[]; truncated: boolean }> {
  const client = await ctx.getClient();
  if (!client) {
    // Intentionally degraded: same contract as
    // listCatalogCategories above. Task #332.
    return { items: [], truncated: false };
  }

  try {
    // The mapper is identical for both branches (search-by-category
    // and the unscoped list). Pulled out so the discriminated-union
    // narrowing on `type === 'ITEM'` lives in one place, and so a
    // future tweak to the consumer-facing CatalogItem shape only has
    // to be made once.
    type ItemObject = CatalogObject & { type: 'ITEM' };
    type VariationObject = CatalogObject & { type: 'ITEM_VARIATION' };
    const isItemObject = (obj: CatalogObject): obj is ItemObject => obj.type === 'ITEM';
    const isVariationObject = (obj: CatalogObject): obj is VariationObject =>
      obj.type === 'ITEM_VARIATION';
    const toCatalogItem = (item: ItemObject): CatalogItem => {
      // CatalogItem.variations is itself a CatalogObject[] (the
      // discriminated wrapper, not CatalogItemVariation directly), so
      // narrow each entry to the ITEM_VARIATION variant before reading
      // `itemVariationData`.
      const variations = (item.itemData?.variations ?? [])
        .filter(isVariationObject)
        .map((v) => ({
          id: v.id ?? '',
          name: v.itemVariationData?.name || 'Default',
          price: v.itemVariationData?.priceMoney?.amount
            ? Number(v.itemVariationData.priceMoney.amount)
            : null,
          currency: v.itemVariationData?.priceMoney?.currency || 'USD',
        }));

      return {
        id: item.id ?? '',
        name: item.itemData?.name || 'Unnamed Item',
        description: item.itemData?.description || '',
        variations,
      };
    };

    // Both branches paginate via Square's `cursor` until the response
    // stops returning one (Task #613). Pre-#613, both branches read
    // only the first page, so any organization whose Square catalog
    // grew past Square's default page size silently lost items in
    // the admin UI with no signal. The shared `paginateCatalogObjects`
    // helper enforces a safety cap (5,000 items / 20 pages) and
    // logs a `warn` if hit so a runaway loop can't masquerade as a
    // huge catalog.
    if (categoryId) {
      // SearchCatalogItemsResponse exposes `cursor` directly on the
      // response body (no Page<> wrapper here, unlike `catalog.list`).
      const { objects: allItems, truncated, truncationReason } = await paginateCatalogObjects(
        async (cursor) => {
          const response = await client.catalog.searchItems({
            categoryIds: [categoryId],
            cursor,
          });
          return {
            objects: response.items ?? [],
            nextCursor: response.cursor || undefined,
          };
        },
        `listCatalogItems(categoryId=${categoryId})`,
      );
      if (truncated && truncationReason) {
        fireCatalogCapAlert(
          ctx,
          truncationReason,
          `listCatalogItems(categoryId=${categoryId})`,
        );
      }
      // `searchItems` returns CatalogObject[] in v40+; narrow to the
      // ITEM variant so `itemData` is reachable on the union.
      return {
        items: allItems.filter(isItemObject).map(toCatalogItem),
        truncated,
      };
    }

    const { objects: allObjects, truncated, truncationReason } = await paginateCatalogObjects(
      async (cursor) => {
        const page = await client.catalog.list({ cursor, types: 'ITEM' });
        return {
          objects: page.data ?? [],
          nextCursor: page.response?.cursor || undefined,
        };
      },
      'listCatalogItems',
    );
    if (truncated && truncationReason) {
      fireCatalogCapAlert(ctx, truncationReason, 'listCatalogItems');
    }
    return {
      items: allObjects.filter(isItemObject).map(toCatalogItem),
      truncated,
    };
  } catch (error) {
    log.error('Catalog list error:', error);
    throw new Error(
      'Failed to fetch catalog items: ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

export async function registerApplePayDomain(
  ctx: SquareProviderContext,
  domain: string,
): Promise<{ success: boolean; message: string }> {
  const client = await ctx.getClient();
  if (!client) {
    // Throw the structured "not configured" error so callers (the
    // sync register-domain route, the async Apple Pay worker, and
    // the org auto-registration helper) can distinguish "the
    // provider isn't set up at all" from "Square accepted the
    // request and rejected the domain". The route maps this to 422
    // PROVIDER_NOT_CONFIGURED; the worker/helper already log it.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  try {
    await client.applePay.registerDomain({ domainName: domain });
    log.info(`Apple Pay domain registered: ${domain}`);
    return { success: true, message: `Domain ${domain} registered for Apple Pay` };
  } catch (error) {
    // v40+ flat-client SDK exposes structured errors directly on the
    // SquareError instance — no `.result` wrapper. We read the first
    // `detail` for the operator-facing message.
    const detail =
      error instanceof getSquareErrorCtor() ? error.errors?.[0]?.detail : undefined;
    log.error('Apple Pay domain registration error:', detail || error);
    return { success: false, message: detail || 'Failed to register domain for Apple Pay' };
  }
}
