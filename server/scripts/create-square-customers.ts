/**
 * One-off migration script: backfills Square customer records for bowlers
 * that don't have a paymentCustomerId yet.
 *
 * IMPORTANT: This script reads credentials from environment variables and
 * must be run once per location with that location's own Square credentials.
 * Set SQUARE_ACCESS_TOKEN to the target location's access token before running.
 * Do NOT run with a global or shared token — records will land in the wrong account.
 *
 * The --locationId flag is required (task #402): every bowler this script
 * touches gets `paymentProviderLocationId` stamped alongside its new
 * `paymentCustomerId` so the account-deletion service can target exactly
 * one processor for saved-card cleanup later, instead of falling back to
 * the slower league-fan-out scan. The location id passed here MUST be the
 * same location whose Square access token is in SQUARE_ACCESS_TOKEN —
 * mismatching them will permanently mis-route future cleanup calls.
 *
 * The --organizationId flag is also required (task #437). Bowlers carry
 * a NOT NULL `organizationId` since task #407, and Square access tokens
 * are issued per location which always belongs to exactly one org. If
 * this script ran globally (its previous behaviour) and an operator
 * supplied one org's token + locationId, the script would happily create
 * Square customers for bowlers owned by *other* organizations and stamp
 * them with this location id — those rows would then be permanently
 * mis-routed for account-deletion cleanup. Requiring --organizationId
 * makes the operator declare which org's bowlers they intend to touch,
 * and the script refuses to start unless the supplied --locationId
 * actually belongs to that org.
 *
 * Usage:
 *   SQUARE_ACCESS_TOKEN=<location_token> npx tsx server/scripts/create-square-customers.ts \
 *     --organizationId=<id> --locationId=<id>
 */
import { createRequire } from "node:module";
import { pathToFileURL } from 'node:url';

// Lazy-load `square` (task #692). The script's module body builds
// arg parsers and validators before any Square call; deferring the
// multi-MB SDK import until the actual client construction keeps
// `--help`-style invocations and the early validation failures
// (missing flags, bad org/location) from paying the SDK import cost.
const _squareRequire = createRequire(import.meta.url);
let _squareSdk: typeof import("square") | null = null;
function getSquareSdk(): typeof import("square") {
  if (_squareSdk === null) {
    _squareSdk = _squareRequire("square") as typeof import("square");
  }
  return _squareSdk;
}
import { db, cleanup as closeDbPool } from "../db";
import { bowlers, locations, organizations } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createLogger } from "../logger";

const log = createLogger("SquareCustomerScript");

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

const accessToken = (process.env.SQUARE_ACCESS_TOKEN || '').replace(/[^\x20-\x7E]/g, '').trim();

if (!accessToken) {
  log.error('SQUARE_ACCESS_TOKEN is required. Set it to the target location\'s Square access token.');
  process.exit(1);
}

const parsedOrgIdFlag = parseIntFlag(process.argv.slice(2), 'organizationId');
if (!parsedOrgIdFlag) {
  log.error('--organizationId=<id> is required so the script only touches bowlers in the org that owns the supplied location/access token. See task #437.');
  process.exit(1);
}
const organizationIdFlag: number = parsedOrgIdFlag;

const parsedLocationIdFlag = parseIntFlag(process.argv.slice(2), 'locationId');
if (!parsedLocationIdFlag) {
  log.error('--locationId=<id> is required so paymentProviderLocationId can be stamped on every imported bowler. See task #402.');
  process.exit(1);
}
const locationIdFlag: number = parsedLocationIdFlag;

const isProductionToken = accessToken.startsWith('EAAAEv') || accessToken.startsWith('EAAAl7');

// Minimal structural type the script actually consumes from the Square
// SDK. Pulled out so the cross-org guard test (task #465) can swap in a
// stub via SQUARE_CLIENT_IMPL_PATH and exercise the DB-touching path
// end-to-end without burning a real Square sandbox round-trip.
interface SquareCustomerCreateInput {
  idempotencyKey: string;
  givenName: string;
  familyName: string;
  emailAddress: string;
  referenceId: string;
}
// v40+ flat-client SDK: customers.create returns the response body
// directly (no `.result` wrapper) and the resource lives under
// `customers` rather than `customersApi`.
interface SquareCustomerCreateResponse {
  customer?: { id?: string };
}
interface SquareClientLike {
  customers: {
    create(input: SquareCustomerCreateInput): Promise<SquareCustomerCreateResponse>;
  };
}

async function buildSquareClient(): Promise<SquareClientLike> {
  // Test seam (task #465): when SQUARE_CLIENT_IMPL_PATH points at a
  // module exporting `createSquareClient()`, the script uses that
  // factory instead of constructing a real Square SDK client. This
  // exists so a DB-seeded integration test can drive the script
  // through the cross-org guard and the bowler UPDATE branch without
  // touching Square. Two independent gates keep the seam from being
  // tripped outside the test suite:
  //   1. NODE_ENV !== 'production' — a Replit/CI deploy can't bypass
  //      the real Square API by setting the var.
  //   2. VITEST === 'true' — even in dev/staging, the seam is only
  //      honoured when the process was spawned by vitest. Vitest sets
  //      VITEST=true automatically and `spawnSync` test runners
  //      inherit the parent env, so the new
  //      `tests/api/create-square-customers-cross-org.test.ts` keeps
  //      working unchanged. Operators running the script by hand never
  //      have VITEST set, so an accidentally-leaked
  //      SQUARE_CLIENT_IMPL_PATH on a dev shell is a no-op.
  const fakeImplPath = process.env.SQUARE_CLIENT_IMPL_PATH;
  const testSeamAllowed = process.env.NODE_ENV !== 'production' && process.env.VITEST === 'true';
  if (fakeImplPath && testSeamAllowed) {
    const moduleSpecifier = fakeImplPath.startsWith('file:')
      ? fakeImplPath
      : pathToFileURL(fakeImplPath).href;
    const mod = await import(moduleSpecifier);
    const factory = (mod as { createSquareClient?: unknown; default?: unknown }).createSquareClient
      ?? (mod as { default?: unknown }).default;
    if (typeof factory !== 'function') {
      throw new Error(
        `SQUARE_CLIENT_IMPL_PATH module ${fakeImplPath} must export createSquareClient()`,
      );
    }
    return (factory as () => SquareClientLike)();
  }
  // v40+ flat-client SDK shape (task #603 / Phase 2 of #600). Note the
  // option key is `token` now, not `accessToken`, and the environment
  // values are URLs from the SquareEnvironment record (Production /
  // Sandbox), not the legacy `Environment` enum.
  const sdk = getSquareSdk();
  return new sdk.SquareClient({
    token: accessToken,
    environment: isProductionToken ? sdk.SquareEnvironment.Production : sdk.SquareEnvironment.Sandbox,
  });
}

log.info(`Running in ${isProductionToken ? 'PRODUCTION' : 'SANDBOX'} mode against organization ${organizationIdFlag} / location ${locationIdFlag}.`);

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function assertLocationBelongsToOrg(locationId: number, orgId: number): Promise<void> {
  const [row] = await db
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);
  if (!row) {
    log.error(`Location ${locationId} does not exist. Refusing to stamp paymentProviderLocationId for a non-existent location.`);
    process.exit(1);
  }
  if (row.organizationId !== orgId) {
    log.error(
      `Location ${locationId} belongs to organization ${row.organizationId}, not the requested organization ${orgId}. ` +
      `Refusing to cross-stamp bowlers in a different org. See task #437.`,
    );
    process.exit(1);
  }
}

async function createSquareCustomers() {
  await assertOrganizationExists(organizationIdFlag);
  await assertLocationBelongsToOrg(locationIdFlag, organizationIdFlag);

  const squareClient = await buildSquareClient();

  try {
    // Count globally-eligible bowlers first so we can show the operator
    // exactly how many were excluded by the org filter. This is the
    // "safety log line" called out in task #437 — it lets the operator
    // sanity-check that the org/location flags they passed match what
    // they expected before any Square API call is made.
    const globalEligible = await db
      .select({ id: bowlers.id })
      .from(bowlers)
      .where(isNull(bowlers.paymentCustomerId));

    const bowlersWithoutSquareId = await db
      .select()
      .from(bowlers)
      .where(and(
        eq(bowlers.organizationId, organizationIdFlag),
        isNull(bowlers.paymentCustomerId),
      ));

    const excluded = globalEligible.length - bowlersWithoutSquareId.length;
    log.info(
      `Found ${bowlersWithoutSquareId.length} bowlers without Square Customer IDs in organization ${organizationIdFlag} ` +
      `(excluded ${excluded} bowlers in other organizations from a global pool of ${globalEligible.length}).`,
    );

    let successCount = 0;
    let errorCount = 0;

    for (const bowler of bowlersWithoutSquareId) {
      try {
        if (!bowler.email) {
          log.info(`Skipping bowler ${bowler.name} - no email address`);
          errorCount++;
          continue;
        }

        const response = await squareClient.customers.create({
          idempotencyKey: `bowler_${bowler.id}_${Date.now()}`,
          givenName: bowler.name.split(' ')[0],
          familyName: bowler.name.split(' ').slice(1).join(' ') || '.',
          emailAddress: bowler.email,
          referenceId: bowler.id.toString(),
        });

        // v40+ flat-client SDK returns the response body directly
        // (no `.result` wrapper).
        if (response.customer?.id) {
          await db
            .update(bowlers)
            .set({
              paymentCustomerId: response.customer.id,
              // Stamp the originating location alongside the saved-card
              // id so account-deletion can target exactly this processor
              // for cleanup later. See task #346 (interactive paths) and
              // task #402 (this bulk path).
              paymentProviderLocationId: locationIdFlag,
            })
            // Defense in depth: even though we already filtered the
            // SELECT by organizationId, re-assert it on the UPDATE so a
            // future change to the loop body (e.g. retry-from-list)
            // can't accidentally write across orgs. See task #437.
            .where(and(
              eq(bowlers.id, bowler.id),
              eq(bowlers.organizationId, organizationIdFlag),
            ));

          log.info(`Created Square Customer for ${bowler.name} (ID: ${response.customer.id}, locationId: ${locationIdFlag})`);
          successCount++;
        }

        await sleep(100);
      } catch (error) {
        log.error(`Error creating Square Customer for ${bowler.name}:`, error);
        errorCount++;

        if ((error as { statusCode?: number } | null)?.statusCode === 429) {
          log.info('Rate limit hit, waiting 5 seconds...');
          await sleep(5000);
        }
      }
    }

    log.info(`Import complete: Total bowlers processed: ${bowlersWithoutSquareId.length}, Successfully created: ${successCount}, Errors: ${errorCount}`);

  } catch (error) {
    log.error('Fatal error during Square Customer creation:', error);
    process.exit(1);
  }
}

createSquareCustomers()
  .then(async () => {
    await closeDbPool();
    process.exit(0);
  })
  .catch(async (error) => {
    log.error('Unhandled error:', error);
    await closeDbPool();
    process.exit(1);
  });
