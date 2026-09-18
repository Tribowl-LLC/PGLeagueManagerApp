/**
 * Catalog reads for providers that support them (e.g. Square).
 *
 * Routes:
 *  - GET /catalog/categories
 *  - GET /catalog/items
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { sendSuccess, sendError, parseOptionalIntParam } from '../../utils/api.js';
import { createLogger } from '../../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../../services/payment-provider-factory';
import { hasCatalogSupport } from '../../services/payment-provider';
import { SQUARE_CATALOG_CAP_ALERT_KIND_PREFIX } from '../../services/square-catalog-cap-alerts';
import type { SquareCatalogCapAlerterSummary } from '@shared/schema';
import { requireOrganizationAccess } from '../../utils/access-control.js';

const log = createLogger('Payments');

// How far back the system-admin banner considers a Square catalog
// pagination-cap alert "recent" (#644). 7 days: long enough that a
// Friday-evening cap event still pages the next admin who logs in
// Monday morning, short enough that an already-fixed tenant stops
// nagging support a week later.
const RECENT_CATALOG_CAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const router = Router();

router.get('/catalog/categories', async (req, res) => {
  try {
    // task #421: tighten the `?locationId` filter. The previous
    // `parseInt` + `!isNaN` ternary had a real security smell: when
    // the caller sent something unparseable like `?locationId=foo`,
    // `lvLocationId` was NaN, the `!isNaN` guard skipped the org
    // ownership check ENTIRELY, and the request fell through to
    // `getPaymentProvider(NaN)` (which then 404'd on the provider
    // lookup). Rejecting up front closes that bypass and gives the
    // caller a clear error message.
    const parsedLocationId = parseOptionalIntParam(req.query.locationId);
    if (parsedLocationId === null) {
      return sendError(res, 'Invalid location ID format', 400);
    }
    // Preserve the prior truthy semantics for `?locationId=0` (treated
    // as "no filter" — 0 is not a valid serial id) so this change is
    // strictly a malformed-input tightening.
    const lvLocationId: number | null = parsedLocationId ?? null;

    if (lvLocationId) {
      const loc = await storage.getLocation(lvLocationId);
      if (!loc) return sendError(res, 'Location not found', 404, 'NOT_FOUND');
      const isAuthorized = requireOrganizationAccess(req, loc.organizationId, 'location', lvLocationId);
      if (!isAuthorized) return sendError(res, 'Forbidden', 403, 'FORBIDDEN');
    }

    let provider;
    try {
      provider = await getPaymentProvider(lvLocationId);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        log.warn('Catalog categories: provider not configured, returning empty', { locationId: lvLocationId });
        return sendSuccess(res, { categories: [], truncated: false });
      }
      throw e;
    }
    if (!hasCatalogSupport(provider)) {
      return sendSuccess(res, { categories: [], truncated: false });
    }

    // Task #623: forward the provider's `truncated` flag so the admin
    // UI can show a banner explaining that the safety cap fired and
    // the visible list is incomplete (rather than pretending the
    // capped list is the whole catalog, as pre-#623 did).
    const result = await provider.listCatalogCategories();
    sendSuccess(res, result);
  } catch (error) {
    log.error('Catalog categories error:', error);
    sendError(res, 'Failed to fetch catalog categories');
  }
});

router.get('/catalog/items', async (req, res) => {
  try {
    const categoryId = req.query.categoryId as string | undefined;
    const parsedLocationId = parseOptionalIntParam(req.query.locationId);
    if (parsedLocationId === null) {
      return sendError(res, 'Invalid location ID format', 400);
    }
    const lvLocationId: number | null = parsedLocationId ?? null;

    if (lvLocationId) {
      const loc = await storage.getLocation(lvLocationId);
      if (!loc) return sendError(res, 'Location not found', 404, 'NOT_FOUND');
      const isAuthorized = requireOrganizationAccess(req, loc.organizationId, 'location', lvLocationId);
      if (!isAuthorized) return sendError(res, 'Forbidden', 403, 'FORBIDDEN');
    }

    let provider;
    try {
      provider = await getPaymentProvider(lvLocationId);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        log.warn('Catalog items: provider not configured, returning empty', { locationId: lvLocationId });
        return sendSuccess(res, { items: [], truncated: false });
      }
      throw e;
    }
    if (!hasCatalogSupport(provider)) {
      return sendSuccess(res, { items: [], truncated: false });
    }

    // Task #623: see the categories handler above for why we forward
    // `truncated` to the UI.
    const result = await provider.listCatalogItems(categoryId);
    sendSuccess(res, result);
  } catch (error) {
    log.error('Catalog list error:', error);
    sendError(res, 'Failed to fetch catalog items');
  }
});

/**
 * System-admin feed of recent Square-catalog pagination-cap alerts
 * (#644). Returns one entry per affected location whose alert was
 * persisted within the last `RECENT_CATALOG_CAP_WINDOW_MS`. Drives
 * the in-app banner so support staff can spot affected tenants
 * without grepping server logs.
 *
 * Restricted to `system_admin` because it leaks per-tenant identifiers
 * (organizationId, locationId) across the org boundary on purpose —
 * that's what lets support contact the right organization.
 */
router.get('/catalog/cap-alerts/recent', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const events = await storage.listRecentAlerterEventsByPrefix(
      SQUARE_CATALOG_CAP_ALERT_KIND_PREFIX,
      RECENT_CATALOG_CAP_WINDOW_MS,
    );
    const alerts = events
      .map((e) => {
        // Older rows might predate this alerter; only surface rows
        // whose summary matches the expected per-location shape so
        // the UI never has to defend against a stale apple-pay
        // shaped payload that happened to share the prefix.
        const s = e.summary as Partial<SquareCatalogCapAlerterSummary> | null;
        if (!s || typeof s.locationId !== 'number') return null;
        if (
          req.organizationContextId !== undefined
          && s.organizationId !== req.organizationContextId
        ) return null;
        return {
          sentAt: e.lastSentAt.toISOString(),
          organizationId: s.organizationId ?? null,
          locationId: s.locationId,
          reason: s.reason ?? 'max_items',
          context: s.context ?? '',
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    sendSuccess(res, { alerts });
  } catch (error) {
    log.error('Square catalog cap recent alerts error:', error);
    sendError(res, 'Failed to load recent Square catalog cap alerts', 500);
  }
});

export default router;
