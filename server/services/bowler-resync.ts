/**
 * Fire-and-forget re-sync of a bowler's payment-provider attributes
 * (task #429).
 *
 * Two trigger surfaces:
 *   1. `bowler_leagues` mutations  — bowler joined / left / moved.
 *   2. `leagues` mutations         — league renamed / archived /
 *                                    restored / season dates changed.
 *
 * What we push:
 *   - Square: the two seller-scoped custom attributes (`league_name`,
 *     `league_season`) using `syncBowlerLeagueAttributesToProvider`.
 *     We DO NOT create a Square customer here — customer creation is
 *     bound to bowler create / profile edit. If a bowler has no
 *     `paymentCustomerId` yet we silently skip; their attributes will
 *     be set on the next profile edit.
 * Failure handling: every error is absorbed and logged. A Square
 * attribute write failure flips `payment_sync_pending_at` so the
 * existing retry sweep (`payment-sync-retry.ts`) re-runs the full
 * customer sync (which loops back through the attribute write) on
 * the next tick. We never throw and never block the calling route.
 *
 * Why fire-and-forget: routes that mutate `bowler_leagues` are user-
 * facing (drag-to-team, click-to-archive). Adding two synchronous
 * external API calls to every one of those would push response
 * latency to the seconds-range and put Square availability
 * on the critical path of in-app actions. Fire-and-forget keeps the
 * UI snappy and lets the retry sweep heal any transient failures.
 */
import { storage } from '../storage';
import { getPaymentProvider, ProviderNotConfiguredError } from './payment-provider-factory';
import { syncBowlerLeagueAttributesToProvider } from './bowler-attributes';
import { createLogger } from '../logger';

const log = createLogger('BowlerResync');

async function flagBowlerForRetry(bowlerId: number): Promise<void> {
  try {
    const fresh = await storage.getBowler(bowlerId);
    if (!fresh || fresh.paymentSyncPendingAt != null) return;
    await storage.updateBowler(bowlerId, {
      ...fresh,
      paymentSyncPendingAt: new Date().toISOString(),
    });
  } catch (markErr) {
    log.error('External resync: failed to flag bowler for retry', {
      bowlerId,
      error: markErr instanceof Error ? { name: markErr.name, message: markErr.message } : markErr,
    });
  }
}

async function runBowlerResync(
  bowlerId: number,
  organizationId: number | null | undefined,
): Promise<void> {
  try {
    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) return;

    // Square branch: attribute-only push, no customer creation.
    if (bowler.paymentCustomerId && bowler.paymentProviderLocationId) {
      try {
        const provider = await getPaymentProvider(bowler.paymentProviderLocationId);
        const attrResult = await syncBowlerLeagueAttributesToProvider(
          provider,
          bowler.paymentCustomerId,
          bowler.id,
        );
        if (!attrResult.ok) {
          await flagBowlerForRetry(bowler.id);
        }
      } catch (e) {
        if (e instanceof ProviderNotConfiguredError) {
          // Credentials were removed since the customer was first
          // synced. Skip silently — there's no Square account to
          // push to. The bowler's existing customerId is stale but
          // out of scope for this helper to clean up.
        } else {
          log.warn('External resync: Square attribute sync threw', {
            bowlerId,
            error: e instanceof Error ? { name: e.name, message: e.message } : e,
          });
          await flagBowlerForRetry(bowler.id);
        }
      }
    }

  } catch (e) {
    log.warn('External resync failed', {
      bowlerId,
      organizationId,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    });
  }
}

/**
 * Fire-and-forget single-bowler resync. Returns void synchronously;
 * the caller MUST NOT await this. Use after a `bowler_leagues`
 * insert / update / delete.
 */
export function fireBowlerExternalResync(
  bowlerId: number,
  organizationId: number | null | undefined,
): void {
  void runBowlerResync(bowlerId, organizationId);
}

/**
 * Awaitable variant of `fireBowlerExternalResync`. Use ONLY in
 * non-user-facing contexts where script completion must guarantee
 * the resync was actually dispatched (e.g. the task #677 phone
 * backfill). Production routes should keep calling the
 * fire-and-forget version above to avoid blocking on Square availability.
 */
export async function runBowlerExternalResync(
  bowlerId: number,
  organizationId: number | null | undefined,
): Promise<void> {
  await runBowlerResync(bowlerId, organizationId);
}

/**
 * Fire-and-forget league-wide resync. Iterates every bowler in the
 * league sequentially to avoid a thundering herd against Square when
 * a 200-bowler league gets renamed. Use after a league
 * rename, archive, restore, or season-date change.
 */
export function fireLeagueBowlersExternalResync(
  leagueId: number,
  organizationId: number | null | undefined,
): void {
  void (async () => {
    try {
      const rows = await storage.getBowlerLeagues({ leagueId });
      const uniqueBowlerIds = Array.from(new Set(rows.map((r) => r.bowlerId)));
      for (const bowlerId of uniqueBowlerIds) {
        // Sequential intentionally — see file header.
        await runBowlerResync(bowlerId, organizationId);
      }
    } catch (e) {
      log.warn('League bowlers external resync failed', {
        leagueId,
        organizationId,
        error: e instanceof Error ? { name: e.name, message: e.message } : e,
      });
    }
  })();
}

/**
 * Fire-and-forget batch resync for an explicit set of bowler ids.
 * Use when the league is about to be deleted (or its `bowler_leagues`
 * rows are about to be cascade-removed) and the league-wide helper
 * above would observe an empty roster after the fact. Capture the
 * id list synchronously BEFORE the destructive write, then call this.
 */
export function fireBowlersExternalResync(
  bowlerIds: number[],
  organizationId: number | null | undefined,
): void {
  if (bowlerIds.length === 0) return;
  void (async () => {
    for (const bowlerId of bowlerIds) {
      await runBowlerResync(bowlerId, organizationId);
    }
  })();
}
