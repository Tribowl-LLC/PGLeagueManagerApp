import { Router, Request } from 'express';
import { z } from 'zod';
import { sendSuccess, sendError, handleZodError, sanitizeLocation, sanitizeLocations } from '../utils/api.js';
import { singleRouteParam } from '../utils/route-params';
import { storage } from '../storage';
import { insertLocationSchema, updateLocationSchema, locationSquareCredentialsSchema, locationCloverCredentialsSchema, PAYMENT_PROVIDERS } from '@shared/schema';
import { filterByOrganization } from '../middleware/organization.js';
import { createLogger } from '../logger';
import { clearProviderCache } from '../services/payment-provider-factory';
import type { User } from '@shared/schema';

const log = createLogger("Locations");

const router = Router();

// Task #735: locations are an org-level admin surface. League
// secretaries (role='user' with grants) must not list/read/mutate
// them, even though they share an organizationId. Allow only
// system_admin and org_admin.
function isOrgOrSysAdmin(user: User | undefined): boolean {
  return user?.role === 'system_admin' || user?.role === 'org_admin';
}

router.get('/', filterByOrganization, async (req: Request, res) => {
  try {
    if (!isOrgOrSysAdmin(req.user)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }
    const organizationId = req.organizationFilter;
    const isSystemAdmin = req.user?.role === 'system_admin';
    let locations;
    if (organizationId !== null && organizationId !== undefined) {
      locations = await storage.getLocations(organizationId);
    } else if (isSystemAdmin) {
      locations = await storage.getAllLocationsSystemAdmin();
    } else {
      return sendSuccess(res, []);
    }
    // task #381: deny-by-default projection (sanitizeLocations) drops
    // `squareCredentials` / `cloverCredentials` blobs that used
    // to ride along on the base CRUD payload. The dedicated
    // `/square-config` / `/clover-config` endpoints already
    // publish the safe boolean-flag projection.
    sendSuccess(res, sanitizeLocations(locations));
  } catch (error) {
    log.error('Error fetching locations:', error);
    sendError(res, 'Failed to fetch locations', 500, 'ServerError');
  }
});

router.get('/:id', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');
    }

    const location = await storage.getLocation(id);
    if (!location) {
      return sendError(res, 'Location not found', 404, 'NOT_FOUND');
    }

    if (!isOrgOrSysAdmin(req.user) || (req.user?.role !== 'system_admin' && req.user?.organizationId !== location.organizationId)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    sendSuccess(res, sanitizeLocation(location));
  } catch (error) {
    log.error(`Error fetching location with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to fetch location', 500, 'ServerError');
  }
});

router.post('/', async (req: Request, res) => {
  try {
    if (!isOrgOrSysAdmin(req.user)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }
    const organizationId = req.user?.organizationId;
    if (!organizationId && req.user?.role !== 'system_admin') {
      return sendError(res, 'Organization required', 400, 'InvalidRequest');
    }

    const body = { ...req.body, organizationId: req.body.organizationId || organizationId };
    const validatedData = insertLocationSchema.parse(body);

    if (req.user?.role !== 'system_admin' && (req.user?.role !== 'org_admin' || validatedData.organizationId !== organizationId)) {
      return sendError(res, 'Cannot create location for another organization', 403, 'Forbidden');
    }

    // Task #454: existence pre-check for the admin-supplied
    // organizationId (system_admin can target any org via body;
    // org_admin is pinned to their own session org by the guard above).
    // Without this, a typoed/stale id falls through to the
    // `locations.organization_id -> organizations.id` foreign key and
    // surfaces as a generic 500. Mirrors the #422 reference fix in
    // server/routes/bowlers.ts.
    const orgRow = await storage.getOrganization(validatedData.organizationId);
    if (!orgRow) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    const location = await storage.createLocation(validatedData);
    sendSuccess(res, sanitizeLocation(location), 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    log.error('Error creating location:', error);
    sendError(res, 'Failed to create location', 500, 'ServerError');
  }
});

router.patch('/:id', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');
    }

    const location = await storage.getLocation(id);
    if (!location) {
      return sendError(res, 'Location not found', 404, 'NOT_FOUND');
    }

    if (!isOrgOrSysAdmin(req.user) || (req.user?.role !== 'system_admin' && req.user?.organizationId !== location.organizationId)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const validatedData = updateLocationSchema.parse(req.body);
    const cleanedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(validatedData)) {
      if (value !== undefined && value !== null) {
        cleanedData[key] = value;
      }
    }

    const isProviderChange = 'paymentProvider' in cleanedData && cleanedData.paymentProvider !== location.paymentProvider;

    if (isProviderChange) {
      const activeSchedules = await storage.getActiveSchedulesByLocationId(id);

      if (activeSchedules.length > 0) {
        if (req.body.confirmProviderSwitch !== true) {
          return sendSuccess(res, {
            warning: true,
            message: `Switching payment provider from "${location.paymentProvider}" to "${cleanedData.paymentProvider}" will break ${activeSchedules.length} active auto-pay schedule(s). Card tokens from the current provider will no longer work. To proceed, resend with confirmProviderSwitch: true.`,
            activeScheduleCount: activeSchedules.length,
            currentProvider: location.paymentProvider,
            newProvider: cleanedData.paymentProvider,
          }, 200);
        }

        const updatedLocation = await storage.updateLocationAndDeactivateSchedules(
          id,
          cleanedData,
          activeSchedules.map(s => s.id)
        );

        log.warn(`Payment provider switch: location ${id} changed from "${location.paymentProvider}" to "${cleanedData.paymentProvider}". Deactivated ${activeSchedules.length} active schedule(s).`, {
          locationId: id,
          previousProvider: location.paymentProvider,
          newProvider: cleanedData.paymentProvider,
          deactivatedScheduleCount: activeSchedules.length,
          deactivatedScheduleIds: activeSchedules.map(s => s.id),
          confirmedBy: req.user?.id ?? 'unknown',
        });

        clearProviderCache(id);
        return sendSuccess(res, sanitizeLocation(updatedLocation));
      } else {
        log.info(`Payment provider switch: location ${id} changed from "${location.paymentProvider}" to "${cleanedData.paymentProvider}". No active schedules affected.`, {
          locationId: id,
          previousProvider: location.paymentProvider,
          newProvider: cleanedData.paymentProvider,
          deactivatedScheduleCount: 0,
          changedBy: req.user?.id ?? 'unknown',
        });
      }
    }

    const updatedLocation = await storage.updateLocation(id, cleanedData);
    if ('paymentProvider' in cleanedData || 'squareCredentials' in cleanedData || 'cloverCredentials' in cleanedData) {
      clearProviderCache(id);
    }
    sendSuccess(res, sanitizeLocation(updatedLocation));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    log.error(`Error updating location with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to update location', 500, 'ServerError');
  }
});

router.patch('/:id/archive', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');
    }

    const location = await storage.getLocation(id);
    if (!location) {
      return sendError(res, 'Location not found', 404, 'NOT_FOUND');
    }

    if (!isOrgOrSysAdmin(req.user) || (req.user?.role !== 'system_admin' && req.user?.organizationId !== location.organizationId)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const archived = await storage.archiveLocation(id);
    sendSuccess(res, sanitizeLocation(archived));
  } catch (error) {
    log.error(`Error archiving location with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to archive location', 500, 'ServerError');
  }
});

router.patch('/:id/restore', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');
    }

    const location = await storage.getLocation(id);
    if (!location) {
      return sendError(res, 'Location not found', 404, 'NOT_FOUND');
    }

    if (!isOrgOrSysAdmin(req.user) || (req.user?.role !== 'system_admin' && req.user?.organizationId !== location.organizationId)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const restored = await storage.restoreLocation(id);
    sendSuccess(res, sanitizeLocation(restored));
  } catch (error) {
    log.error(`Error restoring location with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to restore location', 500, 'ServerError');
  }
});

router.delete('/:id', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');
    }

    const location = await storage.getLocation(id);
    if (!location) {
      return sendError(res, 'Location not found', 404, 'NOT_FOUND');
    }

    if (!isOrgOrSysAdmin(req.user) || (req.user?.role !== 'system_admin' && req.user?.organizationId !== location.organizationId)) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    await storage.deleteLocation(id);
    sendSuccess(res, { message: 'Location deleted successfully' });
  } catch (error) {
    log.error(`Error deleting location with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to delete location', 500, 'ServerError');
  }
});

router.get('/:id/square-config', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');

    const location = await storage.getLocation(id);
    if (!location) return sendError(res, 'Location not found', 404, 'NOT_FOUND');

    const isOrgAdmin = req.user?.role === 'org_admin' || req.user?.role === 'system_admin';
    const hasAccess = req.user?.role === 'system_admin' || (isOrgOrSysAdmin(req.user) && req.user?.organizationId === location.organizationId);
    if (!isOrgAdmin || !hasAccess) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const creds = await storage.getLocationSquareConfig(id);
    sendSuccess(res, {
      appId: creds?.appId || null,
      accessTokenConfigured: !!(creds?.accessToken && creds.accessToken.trim().length > 0),
      locationId: creds?.locationId || null,
    });
  } catch (error) {
    log.error(`Error fetching Square config for location ${req.params.id}:`, error);
    sendError(res, 'Failed to fetch Square configuration', 500, 'ServerError');
  }
});

router.patch('/:id/square-config', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');

    const location = await storage.getLocation(id);
    if (!location) return sendError(res, 'Location not found', 404, 'NOT_FOUND');

    const isOrgAdmin = req.user?.role === 'org_admin' || req.user?.role === 'system_admin';
    const hasAccess = req.user?.role === 'system_admin' || (isOrgOrSysAdmin(req.user) && req.user?.organizationId === location.organizationId);
    if (!isOrgAdmin || !hasAccess) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const parseResult = locationSquareCredentialsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }

    const incoming = parseResult.data ?? {};

    // Preserve existing accessToken if not provided in this request
    const existing = await storage.getLocationSquareConfig(id);
    const creds = {
      appId: incoming.appId !== undefined ? (incoming.appId || undefined) : (existing?.appId || undefined),
      accessToken: incoming.accessToken !== undefined ? (incoming.accessToken || undefined) : (existing?.accessToken || undefined),
      locationId: incoming.locationId !== undefined ? (incoming.locationId || undefined) : (existing?.locationId || undefined),
    };

    await storage.updateLocationSquareConfig(id, creds);
    clearProviderCache(id);
    sendSuccess(res, {
      appId: creds.appId || null,
      accessTokenConfigured: !!(creds.accessToken && creds.accessToken.trim().length > 0),
      locationId: creds.locationId || null,
    });
  } catch (error) {
    log.error(`Error updating Square config for location ${req.params.id}:`, error);
    sendError(res, 'Failed to update Square configuration', 500, 'ServerError');
  }
});

router.get('/:id/clover-config', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');

    const location = await storage.getLocation(id);
    if (!location) return sendError(res, 'Location not found', 404, 'NOT_FOUND');

    const isOrgAdmin = req.user?.role === 'org_admin' || req.user?.role === 'system_admin';
    const hasAccess = req.user?.role === 'system_admin' || (isOrgOrSysAdmin(req.user) && req.user?.organizationId === location.organizationId);
    if (!isOrgAdmin || !hasAccess) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const creds = await storage.getLocationCloverConfig(id);
    sendSuccess(res, {
      merchantId: creds?.merchantId || null,
      apiTokenConfigured: !!(creds?.apiToken && creds.apiToken.trim().length > 0),
      publicTokenizerKey: creds?.publicTokenizerKey || null,
      environment: creds?.environment || null,
    });
  } catch (error) {
    log.error(`Error fetching Clover config for location ${req.params.id}:`, error);
    sendError(res, 'Failed to fetch Clover configuration', 500, 'ServerError');
  }
});

router.patch('/:id/clover-config', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');

    const location = await storage.getLocation(id);
    if (!location) return sendError(res, 'Location not found', 404, 'NOT_FOUND');

    const isOrgAdmin = req.user?.role === 'org_admin' || req.user?.role === 'system_admin';
    const hasAccess = req.user?.role === 'system_admin' || (isOrgOrSysAdmin(req.user) && req.user?.organizationId === location.organizationId);
    if (!isOrgAdmin || !hasAccess) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const parseResult = locationCloverCredentialsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }

    const incoming = parseResult.data ?? {};
    const existing = await storage.getLocationCloverConfig(id);
    const creds = {
      merchantId: incoming.merchantId !== undefined ? (incoming.merchantId || undefined) : (existing?.merchantId || undefined),
      apiToken: incoming.apiToken !== undefined ? (incoming.apiToken || undefined) : (existing?.apiToken || undefined),
      publicTokenizerKey: incoming.publicTokenizerKey !== undefined ? (incoming.publicTokenizerKey || undefined) : (existing?.publicTokenizerKey || undefined),
      environment: incoming.environment !== undefined ? (incoming.environment || undefined) : (existing?.environment || undefined),
    };

    await storage.updateLocationCloverConfig(id, creds);
    clearProviderCache(id);
    sendSuccess(res, {
      merchantId: creds.merchantId || null,
      apiTokenConfigured: !!(creds.apiToken && creds.apiToken.trim().length > 0),
      publicTokenizerKey: creds.publicTokenizerKey || null,
      environment: creds.environment || null,
    });
  } catch (error) {
    log.error(`Error updating Clover config for location ${req.params.id}:`, error);
    sendError(res, 'Failed to update Clover configuration', 500, 'ServerError');
  }
});

router.patch('/:id/payment-provider', async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'Invalid location ID', 400, 'InvalidRequest');

    const location = await storage.getLocation(id);
    if (!location) return sendError(res, 'Location not found', 404, 'NOT_FOUND');

    const isOrgAdmin = req.user?.role === 'org_admin' || req.user?.role === 'system_admin';
    const hasAccess = req.user?.role === 'system_admin' || (isOrgOrSysAdmin(req.user) && req.user?.organizationId === location.organizationId);
    if (!isOrgAdmin || !hasAccess) {
      return sendError(res, 'You do not have access to this location', 403, 'Forbidden');
    }

    const schema = z.object({ paymentProvider: z.enum(PAYMENT_PROVIDERS) });
    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return handleZodError(res, parseResult.error);
    }

    await storage.updateLocation(id, { paymentProvider: parseResult.data.paymentProvider });
    clearProviderCache(id);
    sendSuccess(res, { paymentProvider: parseResult.data.paymentProvider });
  } catch (error) {
    log.error(`Error updating payment provider for location ${req.params.id}:`, error);
    sendError(res, 'Failed to update payment provider', 500, 'ServerError');
  }
});

export default router;
