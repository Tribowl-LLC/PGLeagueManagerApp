import type { SquareClient } from 'square';
import { createLogger } from '../logger';
import { ProviderNotConfiguredError } from './payment-errors';
import type { SquareProviderContext } from './square-client';
import {
  ensureDefinitions,
  repairDefinition,
  repairAllDefinitions,
  upsertCustomerStringAttribute,
  LEAGUE_NAME_KEY,
  LEAGUE_SEASON_KEY,
} from './square-custom-attributes';

const log = createLogger("SquareService");

// Per-Square-seller bootstrap cache for the league_name/league_season
// custom attribute definitions (task #429). Keyed by locationId
// because that's the unit our credentials are addressed by, even
// though definitions are seller-scoped on Square's side. The
// definition list preflight avoids the normal duplicate creates; the
// 409 handling in `ensureDefinitions` remains as a race-safe fallback.
//
// We deliberately only cache a TRUE result. A false (failure) flips
// the cache to absent so the next call retries — otherwise a brief
// Square outage during cold-start would poison the cache for the
// life of the process.
//
// Module-level (rather than class-static) so it stays a single
// per-process singleton shared across every SquarePaymentProvider
// instance, identical to the previous class-static map.
const definitionsBootstrapped = new Map<number, true>();
const definitionsBootstrapInFlight = new Map<number, Promise<boolean>>();

/**
 * Test-only: clear the per-process bootstrap cache so unit tests
 * can verify the lazy-bootstrap path runs again.
 */
export function clearDefinitionsBootstrapCacheForTests(): void {
  definitionsBootstrapped.clear();
  definitionsBootstrapInFlight.clear();
}

async function ensureDefinitionsOnce(
  ctx: SquareProviderContext,
  client: SquareClient,
): Promise<boolean> {
  if (definitionsBootstrapped.get(ctx.locationId)) {
    return true;
  }

  const inFlight = definitionsBootstrapInFlight.get(ctx.locationId);
  if (inFlight) {
    return inFlight;
  }

  let bootstrap: Promise<boolean>;
  bootstrap = ensureDefinitions(client)
    .then((ok) => {
      if (ok) definitionsBootstrapped.set(ctx.locationId, true);
      return ok;
    })
    .finally(() => {
      if (definitionsBootstrapInFlight.get(ctx.locationId) === bootstrap) {
        definitionsBootstrapInFlight.delete(ctx.locationId);
      }
    });
  definitionsBootstrapInFlight.set(ctx.locationId, bootstrap);
  return bootstrap;
}

/**
 * Public bootstrap entry point used by the startup pass in
 * `server/index.ts`. Pre-creates the league_name + league_season
 * custom-attribute definitions on this seller account so the very
 * first customer-attr write of the process is fast (and so the
 * definitions exist even before any bowler has been synced this
 * boot). NON-FATAL: any failure leaves the cache empty so the lazy
 * path retries on next use.
 */
export async function ensureCustomAttributeDefinitions(
  ctx: SquareProviderContext,
): Promise<boolean> {
  let client: SquareClient | null;
  try {
    client = await ctx.getClient();
  } catch {
    return false;
  }
  if (!client) return false;
  return ensureDefinitionsOnce(ctx, client);
}

/**
 * Pushes the bowler's current league_name + league_season strings to
 * the customer's Square profile (task #429). NON-FATAL by contract —
 * see `Failure semantics` below — the customer record itself is
 * always considered the primary write and must never be rolled back
 * because of an attribute upsert failure.
 *
 * Failure semantics:
 *   - "Definition does not exist yet" → bootstrap once, retry once.
 *     If bootstrap *itself* failed, leave the cache empty so the
 *     next call retries.
 *   - Hard upsert failure → log + return ok:false so the caller can
 *     flip `bowlers.payment_sync_pending_at`. The retry sweep picks
 *     it up on the next tick.
 *   - Provider not configured → return ok:true and skip silently.
 *     There is no Square customer to update on this location, so
 *     there is nothing to retry.
 *
 * Empty strings ARE written: that's how we tell Square "this bowler
 * is no longer in any leagues" rather than leaving a stale value
 * from a previous sync.
 */
export async function syncCustomerLeagueAttributes(
  ctx: SquareProviderContext,
  customerId: string,
  bowlerId: number,
  attributes: { leagueName: string; leagueSeason: string },
): Promise<{ ok: boolean }> {
  let client: SquareClient | null;
  try {
    client = await ctx.getClient();
  } catch (err) {
    log.warn('Custom-attr sync: failed to get Square client', {
      locationId: ctx.locationId,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return { ok: false };
  }
  if (!client) {
    // Same convention as the rest of the provider: missing creds
    // means "skip silently", not "fail loudly". The caller already
    // gated on Square being configured for this location.
    return { ok: true };
  }

  // Lazy bootstrap. The first call per cold-start per Square seller
  // lists the definitions and creates only any missing keys; everything
  // after that is in-memory cached.
  let bootstrapped = await ensureDefinitionsOnce(ctx, client);

  const writeBoth = async (): Promise<{
    ok: boolean;
    definitionMissing: boolean;
    missingKeys: string[];
  }> => {
    const nameRes = await upsertCustomerStringAttribute(
      client!,
      customerId,
      LEAGUE_NAME_KEY,
      attributes.leagueName,
      bowlerId,
    );
    const seasonRes = await upsertCustomerStringAttribute(
      client!,
      customerId,
      LEAGUE_SEASON_KEY,
      attributes.leagueSeason,
      bowlerId,
    );
    const ok = nameRes.ok && seasonRes.ok;
    const missingKeys: string[] = [];
    if (!nameRes.ok && nameRes.reason === 'definition_missing') missingKeys.push(LEAGUE_NAME_KEY);
    if (!seasonRes.ok && seasonRes.reason === 'definition_missing') missingKeys.push(LEAGUE_SEASON_KEY);
    return { ok, definitionMissing: missingKeys.length > 0, missingKeys };
  };

  let result = await writeBoth();
  // Force one bootstrap + single retry when EITHER:
  //   (a) we never successfully bootstrapped this process (cold-
  //       start failure), OR
  //   (b) the cache says we DID bootstrap but Square still rejected
  //       the upsert with definition-missing — meaning the
  //       definition was deleted out-of-band (e.g. a seller manually
  //       removed it from their Square dashboard, or another app on
  //       the same seller account did so via the API). Bust the
  //       cache so the next call also re-bootstraps.
  if (!result.ok && (!bootstrapped || result.definitionMissing)) {
    if (result.definitionMissing && bootstrapped) {
      log.warn('Custom-attr sync: definition missing despite cached bootstrap; busting cache', {
        bowlerId,
        customerId,
        locationId: ctx.locationId,
      });
      definitionsBootstrapped.delete(ctx.locationId);
    }
    log.info('Custom-attr sync: retrying after forced bootstrap', { bowlerId, customerId });
    bootstrapped = await ensureDefinitionsOnce(ctx, client);
    if (bootstrapped) {
      result = await writeBoth();
    }
  }

  // Last-ditch self-heal: if the upsert STILL reports definition_missing
  // after we successfully re-bootstrapped, the only consistent
  // explanation is a stale/broken definition on the seller account
  // (e.g. a definition created by a previous deploy with the now-
  // rejected `developer.squareup.com/...` schema URI). Square keeps
  // the orphan record by name, so `create` returns "already exists"
  // and bootstrap reports success — but `upsert` against the broken
  // record fails with "No matching definition found for value".
  //
  // We delete and recreate the offending key(s) by spec, then retry
  // once. This is bounded (at most one repair pass per call) and
  // gated on `definitionMissing` so a vanilla transient upsert
  // failure doesn't trigger destructive seller-side writes.
  if (!result.ok && result.definitionMissing) {
    log.warn('Custom-attr sync: definition still missing after re-bootstrap; running repair', {
      bowlerId,
      customerId,
      locationId: ctx.locationId,
      keys: result.missingKeys,
    });
    let anyRepaired = false;
    for (const key of result.missingKeys) {
      const repaired = await repairDefinition(client, key);
      anyRepaired = anyRepaired || repaired;
    }
    // Bust the per-process cache regardless — even on partial repair
    // we want the next call to take the full ensureDefinitions path.
    definitionsBootstrapped.delete(ctx.locationId);
    if (anyRepaired) {
      definitionsBootstrapped.set(ctx.locationId, true);
      result = await writeBoth();
    }
  }

  if (!result.ok) {
    log.warn('Custom-attr sync: leaving bowler flagged for retry', {
      bowlerId,
      customerId,
      locationId: ctx.locationId,
    });
  }
  return { ok: result.ok };
}

/**
 * Operator-initiated repair: delete and recreate the seller-scoped
 * customer custom-attribute definitions for this location's Square
 * account. Used by `scripts/repair-square-customer-attr-definitions.ts`
 * to unstick the "stale broken definition" state described in
 * `syncCustomerLeagueAttributes`.
 *
 * Returns a per-key success map. Caller is responsible for any
 * downstream bowler unsticking (resetting `payment_sync_attempts`
 * so the retry sweep picks them up).
 */
export async function repairCustomerAttributeDefinitions(
  ctx: SquareProviderContext,
): Promise<Record<string, boolean>> {
  const client = await ctx.getClient();
  if (!client) {
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }
  const result = await repairAllDefinitions(client);
  // Bust the per-process bootstrap cache so the next sync call
  // re-runs ensureDefinitions against the freshly recreated state.
  definitionsBootstrapped.delete(ctx.locationId);
  return result;
}
