/**
 * One-shot backfill: stamp `bowlers.paymentProviderLocationId` for
 * legacy rows that were created before task #346 added the column.
 *
 * Why
 * ---
 * `bowlers.paymentProviderLocationId` records the location whose
 * payment processor created the bowler's saved-customer record
 * (`paymentCustomerId`). When an account is
 * deleted the deletion service (`server/services/account-deletion.ts`,
 * `collectProviderTargets`) uses that column to talk to exactly one
 * processor. Rows with the column NULL fall back to the legacy
 * fan-out: the deletion service contacts every payment-configured
 * location reachable through the bowler's league memberships, which
 * is noisier in audit logs and can hit irrelevant processors.
 *
 * For each legacy bowler that has a saved-card record, this script
 * looks at the locations reachable through `bowler_leagues -> leagues
 * -> leagues.location_id`, keeps the ones whose location row has its
 * payment processor configured (matching the writer's logic), and:
 *   - exactly 1 candidate -> writes that location id;
 *   - 0 or >1 candidates  -> leaves the column NULL and logs the row
 *                            so the legacy fan-out keeps handling it.
 *
 * The script is idempotent and safe to re-run: it only ever updates
 * rows where `paymentProviderLocationId IS NULL`.
 *
 * --organizationId is required (task #464). Even though this script
 * doesn't take an external API token (so it doesn't have the exact
 * same "operator supplies org A's token, script stamps org B's
 * bowlers" leak shape as `create-square-customers.ts` / task #437),
 * it has the same shape of bug at the SELECT level: a global
 * candidate set with no per-org scoping. Bowlers carry a NOT NULL
 * `organizationId` since task #407, but `bowler_leagues` and
 * `leagues.location_id` are not constrained to stay within an org —
 * a stale or corrupt link from an org-A bowler into an org-B league
 * would let this script silently stamp an org-B `locationId` onto
 * an org-A bowler, permanently mis-routing that bowler's saved-card
 * cleanup at account-deletion time. Requiring --organizationId makes
 * the operator declare which org's bowlers they intend to touch, the
 * SELECT is filtered to that org, every candidate location is
 * dropped if it isn't in that same org, and the UPDATE re-asserts
 * the org as defense-in-depth.
 *
 * Usage
 * -----
 *   npx tsx server/scripts/backfill-bowler-payment-provider-location.ts \
 *     --organizationId=<id>          # dry-run
 *   npx tsx server/scripts/backfill-bowler-payment-provider-location.ts \
 *     --organizationId=<id> --apply  # commit changes
 */
import { db, cleanup as closeDbPool } from '../db';
import {
  bowlers,
  bowlerLeagues,
  leagues,
  locations,
  organizations,
  type Location,
} from '@shared/schema';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { createLogger } from '../logger';

const log = createLogger('BackfillBowlerProviderLocation');

const APPLY = process.argv.includes('--apply');

function parseIntFlag(argv: string[], name: string): number | null {
  const long = `--${name}`;
  const longEq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === long && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    if (arg.startsWith(longEq)) {
      const n = Number(arg.slice(longEq.length));
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

const parsedOrgIdFlag = parseIntFlag(process.argv.slice(2), 'organizationId');
if (!parsedOrgIdFlag) {
  log.error(
    '--organizationId=<id> is required so the script only stamps bowlers in the org it was pointed at and refuses to cross-stamp a different org\'s location id. See task #464.',
  );
  process.exit(1);
}
const organizationIdFlag: number = parsedOrgIdFlag;

/**
 * Mirrors the minimum credential set each provider class needs to run
 * a customer-cleanup call:
 *   - Square: `SquarePaymentProvider.getClient()` only requires
 *     `accessToken` (see `server/services/square-provider.ts`); the
 *     Square `locationId` is only needed for payment / order routes,
 *     not customer deletion.
 * Keeping this predicate aligned with the providers means we never
 * stamp a bowler with a location that the deletion service would
 * later reject as not configured.
 */
function isLocationPaymentConfigured(loc: Location): boolean {
  const credentials = loc.squareCredentials ?? {};
  return Boolean(credentials.accessToken && credentials.accessToken.trim().length > 0);
}

async function assertOrganizationExists(orgId: number): Promise<void> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) {
    log.error(`Organization ${orgId} does not exist. Refusing to backfill against a non-existent org.`);
    process.exit(1);
  }
}

async function main() {
  log.info(
    `Starting backfill (mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}) against organization ${organizationIdFlag}`,
  );

  await assertOrganizationExists(organizationIdFlag);

  // Count globally-eligible bowlers first so we can show the operator
  // exactly how many were excluded by the org filter. Mirrors the
  // safety log line in `create-square-customers.ts` (task #437) — it
  // lets the operator sanity-check that the org flag they passed
  // matches what they expected before any UPDATE happens.
  const globalEligible = await db
    .select({ id: bowlers.id })
    .from(bowlers)
    .where(
      and(
        isNull(bowlers.paymentProviderLocationId),
        isNotNull(bowlers.paymentCustomerId),
      ),
    );

  const candidates = await db
    .select({
      id: bowlers.id,
      paymentCustomerId: bowlers.paymentCustomerId,
    })
    .from(bowlers)
    .where(
      and(
        eq(bowlers.organizationId, organizationIdFlag),
        isNull(bowlers.paymentProviderLocationId),
        isNotNull(bowlers.paymentCustomerId),
      ),
    );

  const excluded = globalEligible.length - candidates.length;
  log.info(
    `Found ${candidates.length} legacy bowler(s) needing backfill in organization ${organizationIdFlag} ` +
      `(excluded ${excluded} bowlers in other organizations from a global pool of ${globalEligible.length}).`,
  );

  if (candidates.length === 0) {
    return { updated: 0, ambiguous: 0, unreachable: 0, crossOrgSkipped: 0 };
  }

  const candidateIds = candidates.map((b) => b.id);

  // Distinct (bowlerId, locationId) reachable through league memberships.
  const reach = await db
    .selectDistinct({
      bowlerId: bowlerLeagues.bowlerId,
      locationId: leagues.locationId,
    })
    .from(bowlerLeagues)
    .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
    .where(inArray(bowlerLeagues.bowlerId, candidateIds));

  const reachableLocationIds = new Set<number>();
  const byBowler = new Map<number, Set<number>>();
  for (const r of reach) {
    if (r.locationId == null) continue;
    reachableLocationIds.add(r.locationId);
    let set = byBowler.get(r.bowlerId);
    if (!set) {
      set = new Set();
      byBowler.set(r.bowlerId, set);
    }
    set.add(r.locationId);
  }

  // Pre-load location rows so we can decide "payment-configured" once.
  const locationRows =
    reachableLocationIds.size === 0
      ? []
      : await db
          .select()
          .from(locations)
          .where(inArray(locations.id, [...reachableLocationIds]));

  const configured = new Map<number, boolean>();
  // Track the org of every reachable location so we can refuse to
  // stamp a bowler with a location that belongs to a different org.
  // `bowler_leagues` and `leagues.location_id` aren't constrained to
  // stay inside an org, so a stale link from this org's bowler into
  // another org's league would otherwise let us cross-stamp. See
  // task #464.
  const locationOrg = new Map<number, number>();
  for (const loc of locationRows) {
    configured.set(loc.id, isLocationPaymentConfigured(loc));
    locationOrg.set(loc.id, loc.organizationId);
  }

  let updated = 0;
  let ambiguous = 0;
  let unreachable = 0;
  let crossOrgSkipped = 0;

  for (const bowler of candidates) {
    const reachable = byBowler.get(bowler.id) ?? new Set<number>();
    const inOrg = [...reachable].filter(
      (id) => locationOrg.get(id) === organizationIdFlag,
    );
    const droppedCrossOrg = reachable.size - inOrg.length;
    if (droppedCrossOrg > 0) {
      crossOrgSkipped += droppedCrossOrg;
      log.info(
        `Bowler ${bowler.id}: ignored ${droppedCrossOrg} reachable location(s) outside organization ${organizationIdFlag} (cross-org link in bowler_leagues/leagues — see task #464)`,
      );
    }
    const eligible = inOrg.filter((id) => configured.get(id));

    if (eligible.length === 0) {
      unreachable += 1;
      log.info(
        `Bowler ${bowler.id}: no payment-configured in-org location reachable — left NULL`,
      );
      continue;
    }
    if (eligible.length > 1) {
      ambiguous += 1;
      log.info(
        `Bowler ${bowler.id}: ambiguous — ${eligible.length} payment-configured locations reachable (${eligible.join(', ')}) — left NULL`,
      );
      continue;
    }

    const locationId = eligible[0];
    if (APPLY) {
      await db
        .update(bowlers)
        .set({ paymentProviderLocationId: locationId })
        // Defense in depth: even though we already filtered the SELECT
        // by organizationId and dropped cross-org candidate locations,
        // re-assert org on the UPDATE so a future change to the loop
        // (e.g. retry-from-list, parallel batches) can't accidentally
        // write across orgs. See task #464.
        .where(
          and(
            eq(bowlers.id, bowler.id),
            eq(bowlers.organizationId, organizationIdFlag),
            isNull(bowlers.paymentProviderLocationId),
          ),
        );
    }
    updated += 1;
    log.info(
      `Bowler ${bowler.id}: stamped paymentProviderLocationId=${locationId}${APPLY ? '' : ' (dry-run)'}`,
    );
  }

  return { updated, ambiguous, unreachable, crossOrgSkipped };
}

main()
  .then((stats) => {
    log.info(
      `Backfill complete. updated=${stats.updated}, ambiguous=${stats.ambiguous}, unreachable=${stats.unreachable}, crossOrgSkipped=${stats.crossOrgSkipped}` +
        (APPLY ? '' : ' (DRY-RUN — re-run with --apply to commit)'),
    );
  })
  .catch((err) => {
    log.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
