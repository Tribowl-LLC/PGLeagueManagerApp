/**
 * Startup bootstrap pass for Square customer-custom-attribute
 * definitions (task #429).
 *
 * Runs once per process boot, after the HTTP server is listening,
 * AFTER the payment scheduler is initialized. Iterates every Square-
 * configured location across all organizations and calls the per-
 * provider `ensureCustomAttributeDefinitions()` method to pre-create
 * the `league_name` + `league_season` definitions on each seller
 * account.
 *
 * NON-FATAL by contract: any failure (Square outage, revoked token,
 * malformed credentials) is logged and skipped. The lazy bootstrap
 * path inside `syncCustomerLeagueAttributes` will pick up the slack
 * on the next bowler sync, and the per-process cache stays empty for
 * failed locations so they retry on first use.
 *
 * Multiple locations can share a single Square seller account; we
 * issue one ensure-definitions call per location anyway because the
 * "already exists" branch makes the second call a fast no-op.
 */
import { storage } from '../storage';
import { getPaymentProvider } from './payment-provider-factory';
import { SquarePaymentProvider } from './square-provider';
import { createLogger } from '../logger';
import { resolveBackgroundOrganizationId } from './single-tenant-context';

const log = createLogger('SquareCustomAttrBootstrap');

export async function bootstrapAllSquareCustomAttributeDefinitions(organizationId?: number): Promise<void> {
  let locations;
  try {
    const scope = organizationId ?? await resolveBackgroundOrganizationId();
    locations = await storage.getAllSquareConfiguredLocations(scope);
  } catch (err) {
    log.warn('Skipping custom-attribute bootstrap: failed to list locations', {
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return;
  }

  if (locations.length === 0) {
    log.info('No Square-configured locations; skipping custom-attribute bootstrap');
    return;
  }

  log.info('Bootstrapping Square custom-attribute definitions', {
    locationCount: locations.length,
  });

  let succeeded = 0;
  let failed = 0;
  for (const loc of locations) {
    try {
      const provider = await getPaymentProvider(loc.id);
      if (!(provider instanceof SquarePaymentProvider)) {
        // Location's effective provider is something else (e.g. card-
        // pointe) despite having Square credentials configured; skip.
        continue;
      }
      const ok = await provider.ensureCustomAttributeDefinitions();
      if (ok) succeeded++;
      else failed++;
    } catch (err) {
      failed++;
      log.warn('Custom-attribute bootstrap failed for location', {
        locationId: loc.id,
        organizationId: loc.organizationId,
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
    }
  }

  log.info('Square custom-attribute bootstrap complete', {
    succeeded,
    failed,
    total: locations.length,
  });
}
