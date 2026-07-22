/**
 * Public-facing client config for the payment SDKs.
 *
 * Routes:
 *  - GET /config
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { createLogger } from '../../logger';
import { isDev } from '../../config';
import { getMissingSquareFields } from '@shared/schema';

const log = createLogger('Payments');

const router = Router();

router.get('/config', async (req, res) => {
  const locationIdParam = req.query.locationId as string | undefined;
  if (locationIdParam) {
    const lvLocationId = parseInt(locationIdParam);
    if (!isNaN(lvLocationId)) {
      try {
        const loc = await storage.getLocation(lvLocationId);
        if (loc) {
          const isAuthorized =
            req.user?.role === 'system_admin' ||
            (req.user?.organizationId != null && req.user.organizationId === loc.organizationId);
          if (isAuthorized) {
            const creds = await storage.getLocationSquareConfig(lvLocationId);
            // Always advertise per-location Square config (even when
            // partial / missing) so the client can branch its UI on
            // `providerConfigured` + `missingFields`. Falling through to
            // env-var config would mask a
            // half-configured location with stale process-level
            // credentials and silently break the partial-config UX
            // settings/payment surfaces depend on. (Task #579 —
            // Square parity for the #575 partial-config UX.)
            const sqMissingFields = getMissingSquareFields(creds ?? null);
            return res.json({
              appId: creds?.appId?.trim() || '',
              locationId: creds?.locationId?.trim() || '',
              providerConfigured: sqMissingFields.length === 0,
              missingFields: sqMissingFields,
            });
          }
        }
      } catch {
        // fall through to env-var config
      }
    }
  }

  const prodAppId = process.env.SQUARE_PRODUCTION_APP_ID || '';
  const viteAppId = process.env.VITE_SQUARE_APP_ID || '';
  const squareAppId = process.env.SQUARE_APP_ID || '';

  const appId = prodAppId
    || ((viteAppId && !viteAppId.includes('sandbox-')) ? viteAppId : '')
    || ((squareAppId && !squareAppId.includes('sandbox-')) ? squareAppId : '')
    || viteAppId || squareAppId;

  if (isDev) log.info('Serving config:', {
    prodAppIdSet: !!prodAppId,
    viteAppIdSet: !!viteAppId,
    squareAppIdSet: !!squareAppId,
    selectedAppId: appId.substring(0, 10) + '...',
    isProduction: appId.length > 0 && !appId.includes('sandbox-'),
  });

  const squareLocationId = process.env.SQUARE_LOCATION_ID || process.env.VITE_SQUARE_LOCATION_ID || '';
  res.json({ appId, locationId: squareLocationId });
});

export default router;
