/**
 * One-off migration script: backfills the two seller-scoped Square
 * customer custom attributes (`league_name`, `league_season`) for
 * every bowler in an organization that already has a Square customer
 * record (task #429).
 *
 * Why this exists: the runtime sync paths (bowler create, bowler-
 * league mutations, league rename/archive) all push these attributes
 * going forward, but the historical population — bowlers that were
 * synced to Square BEFORE the attribute push existed — has empty
 * `league_name` / `league_season` strings on the Square side. Until
 * those values are filled in, those bowlers won't show up in any
 * Smart List built off the new attributes.
 *
 * Safety / scope:
 *   - Per-org, per-location. The operator must declare both up-front
 *     (mirrors `create-square-customers.ts` after task #437): the
 *     supplied --locationId must belong to --organizationId or the
 *     script refuses to start. This prevents cross-org writes when an
 *     operator has multiple Square accounts wired up.
 *   - Never creates Square customers. We only write attributes onto
 *     bowlers that ALREADY have a `paymentCustomerId` for the target
 *     location. Bowlers with no Square record are reported and skipped
 *     so the operator can run `create-square-customers.ts` first if
 *     they want to grow the Smart List coverage.
 *   - Idempotent. Re-running the script writes the same attribute
 *     values (`upsertCustomerStringAttribute` is an upsert) and is
 *     safe at any time. The bootstrap step that registers the two
 *     attribute definitions is also idempotent (treats "ALREADY
 *     EXISTS" as success — see `square-custom-attributes.ts`).
 *   - Resumable. Failures per bowler are logged and counted; the loop
 *     continues. A subsequent run picks up where the previous left
 *     off because the success state is "attribute values match" which
 *     idempotent re-writes preserve.
 *
 * Failure handling: an attribute write failure flips the bowler's
 * `payment_sync_pending_at` flag (same path the runtime sync uses),
 * so the existing retry sweep will pick the bowler up automatically
 * on its next tick. The script also logs the per-bowler failure for
 * the operator's run summary.
 *
 * Usage:
 *   npx tsx server/scripts/backfill-square-league-attributes.ts \
 *     --organizationId=<id> --locationId=<id>
 *
 * No SQUARE_ACCESS_TOKEN env var is required: the script uses the
 * standard payment-provider factory, which loads the location's
 * stored Square credentials the same way every production code path
 * does. This keeps the script and the runtime path on a single
 * source of truth for credentials.
 */
import { db, cleanup as closeDbPool } from '../db';
import {
  bowlers,
  locations,
  organizations,
  PAYMENT_SYNC_MAX_ATTEMPTS,
} from '@shared/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createLogger } from '../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../services/payment-provider-factory';
import { syncBowlerLeagueAttributesToProvider } from '../services/bowler-attributes';
import { storage } from '../storage';

const log = createLogger('SquareAttrBackfill');

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
    '--organizationId=<id> is required. The script only touches bowlers in this org so an operator with multiple Square accounts cannot accidentally cross-write attributes.',
  );
  process.exit(1);
}
const organizationIdFlag: number = parsedOrgIdFlag;

const parsedLocationIdFlag = parseIntFlag(process.argv.slice(2), 'locationId');
if (!parsedLocationIdFlag) {
  log.error(
    '--locationId=<id> is required. Square credentials and custom-attribute definitions are scoped per location, so the backfill must declare which Square seller to write to.',
  );
  process.exit(1);
}
const locationIdFlag: number = parsedLocationIdFlag;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    log.error(`Location ${locationId} does not exist.`);
    process.exit(1);
  }
  if (row.organizationId !== orgId) {
    log.error(
      `Location ${locationId} belongs to organization ${row.organizationId}, not the requested organization ${orgId}. ` +
        `Refusing to push attributes for a different org. Mirrors the cross-org guard from task #437.`,
    );
    process.exit(1);
  }
}

async function flagBowlerForRetry(bowlerId: number): Promise<void> {
  try {
    const fresh = await storage.getBowler(bowlerId);
    if (
      !fresh
      || fresh.paymentSyncNextRetryAt != null
      || fresh.paymentSyncAttempts >= PAYMENT_SYNC_MAX_ATTEMPTS
    ) return;
    const nowIso = new Date().toISOString();
    await storage.updateBowler(bowlerId, {
      ...fresh,
      paymentSyncPendingAt: fresh.paymentSyncPendingAt ?? nowIso,
      paymentSyncNextRetryAt: nowIso,
    });
  } catch (markErr) {
    log.error(`Failed to flag bowler ${bowlerId} for retry`, markErr);
  }
}

async function backfill() {
  await assertOrganizationExists(organizationIdFlag);
  await assertLocationBelongsToOrg(locationIdFlag, organizationIdFlag);

  // Resolve the provider once. If the location's Square credentials
  // are missing the script bails immediately rather than thrashing
  // through every bowler.
  let provider;
  try {
    provider = await getPaymentProvider(locationIdFlag);
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) {
      log.error(
        `Location ${locationIdFlag} has no payment provider configured. ` +
          `Connect Square for this location in the Integrations page first.`,
      );
      process.exit(1);
    }
    throw e;
  }

  // Eligibility set: org-scoped, has a Square customer id, AND was
  // synced via THIS location. Bowlers stamped to a different
  // `paymentProviderLocationId` (e.g. one org with two Square
  // sellers) are excluded so we don't push attribute writes against
  // the wrong seller's customer record.
  const candidates = await db
    .select()
    .from(bowlers)
    .where(
      and(
        eq(bowlers.organizationId, organizationIdFlag),
        isNotNull(bowlers.paymentCustomerId),
        eq(bowlers.paymentProviderLocationId, locationIdFlag),
      ),
    );

  log.info(
    `Found ${candidates.length} bowlers eligible for attribute backfill ` +
      `(organization ${organizationIdFlag}, location ${locationIdFlag}).`,
  );

  let succeeded = 0;
  let failed = 0;
  let skippedNoCustomerId = 0;

  for (const bowler of candidates) {
    if (!bowler.paymentCustomerId) {
      // Defense-in-depth — the SELECT already filtered isNotNull.
      skippedNoCustomerId++;
      continue;
    }

    try {
      const result = await syncBowlerLeagueAttributesToProvider(
        provider,
        bowler.paymentCustomerId,
        bowler.id,
      );
      if (result.ok) {
        succeeded++;
      } else {
        failed++;
        log.warn(
          `Bowler ${bowler.id} (${bowler.name}): attribute push failed, flagging for retry sweep`,
        );
        await flagBowlerForRetry(bowler.id);
      }
    } catch (e) {
      failed++;
      log.error(
        `Bowler ${bowler.id} (${bowler.name}): unexpected error during attribute push`,
        e,
      );
      await flagBowlerForRetry(bowler.id);

      // Square 429 backoff. The provider already retries internally
      // on transient 5xx, but a sustained 429 means we should back
      // off the WHOLE script for a bit so we don't burn the rate
      // limit on retry attempts that are just going to 429 again.
      if (
        e &&
        typeof e === 'object' &&
        'statusCode' in e &&
        (e as { statusCode?: number }).statusCode === 429
      ) {
        log.info('Rate limit hit, sleeping 5s before continuing...');
        await sleep(5000);
      }
    }

    // Small jitter so a 1000-bowler org doesn't burst Square's
    // per-second rate limit. The factor matches create-square-
    // customers.ts.
    await sleep(100);
  }

  log.info(
    `Backfill complete for organization ${organizationIdFlag} / location ${locationIdFlag}: ` +
      `total=${candidates.length}, succeeded=${succeeded}, failed=${failed}, ` +
      `skippedNoCustomerId=${skippedNoCustomerId}. ` +
      `Failed bowlers were flagged for the retry sweep — they will be re-attempted automatically.`,
  );
}

backfill()
  .then(async () => {
    await closeDbPool();
    process.exit(0);
  })
  .catch(async (error) => {
    log.error('Unhandled error during Square attribute backfill:', error);
    await closeDbPool();
    process.exit(1);
  });
