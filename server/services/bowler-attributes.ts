/**
 * Resolves the two payment-provider string attributes a bowler
 * exposes to Square (task #429):
 *
 *   league_name   — alphabetical comma-joined unique league names the
 *                   bowler is currently in (active rows only).
 *   league_season — distinct season labels (`getSeasonLabel`),
 *                   chronologically ordered by `seasonStart`.
 *
 * Both strings are computed from a single bowler-leagues fetch so the
 * Square sync shares
 * exactly the same source of truth as the in-app season chips users
 * see — there is no second derivation in the call chain.
 *
 * Inactive `bowler_leagues` rows AND inactive (archived) leagues are
 * EXCLUDED so an admin who archives a league sees that bowler drop
 * out of the "Fall '25 Season" Smart List on the next sync.
 *
 * Empty results are returned as empty strings rather than null so the
 * Square upsert is unambiguous: writing "" tells Square "this bowler
 * is in zero leagues right now" instead of leaving stale data behind
 * (which would happen if we skipped the upsert entirely).
 */
import { storage } from '../storage';
import { getSeasonLabel } from '@shared/season-utils';
import type { PaymentProvider } from './payment-provider';
import { SquarePaymentProvider } from './square-provider';
import { createLogger } from '../logger';

const log = createLogger('BowlerAttributes');

export interface ResolvedBowlerAttributes {
  /** Alphabetical comma-joined unique league names ("" when none). */
  leagueName: string;
  /**
   * Comma-joined distinct season labels ordered by seasonStart asc
   * ("" when none). The label set is deduped after computing the
   * label string so two leagues running the same season collapse.
   */
  leagueSeason: string;
}

export async function resolveBowlerLeagueAttributes(
  bowlerId: number,
): Promise<ResolvedBowlerAttributes> {
  const empty: ResolvedBowlerAttributes = {
    leagueName: '',
    leagueSeason: '',
  };

  const bowlerLeagues = await storage.getBowlerLeagues({ bowlerId });
  const activeAssociations = bowlerLeagues.filter((bl) => bl.active);
  if (activeAssociations.length === 0) {
    return empty;
  }

  // Hydrate league rows. We tolerate `null` (a join row whose league
  // was hard-deleted) by skipping that row — the caller only cares
  // about bowler-visible state.
  const leagues = await Promise.all(
    activeAssociations.map((bl) => storage.getLeague(bl.leagueId)),
  );
  const activeLeagues = leagues.filter(
    (l): l is NonNullable<typeof l> => l !== undefined && l !== null && l.active === true,
  );
  if (activeLeagues.length === 0) {
    return empty;
  }

  // league_name: alphabetical, unique. Sorting in the writer rather
  // than relying on insertion order means a Smart List value like
  // "A League, B League" stays stable across re-syncs even if the
  // user shuffled team membership.
  const uniqueNames = Array.from(new Set(activeLeagues.map((l) => l.name))).sort(
    (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  const leagueName = uniqueNames.join(', ');

  // league_season: chronological by seasonStart, then label-dedup.
  // We sort by the raw seasonStart timestamp before computing labels
  // so two leagues that produce the same label (e.g. both "Fall '25
  // Season") collapse correctly even when their start dates differ
  // by a few days.
  const sortedByStart = [...activeLeagues].sort(
    (a, b) => new Date(a.seasonStart).getTime() - new Date(b.seasonStart).getTime(),
  );
  const orderedLabels: string[] = [];
  const seen = new Set<string>();
  for (const l of sortedByStart) {
    const label = getSeasonLabel(l.seasonStart, l.seasonEnd);
    if (!seen.has(label)) {
      seen.add(label);
      orderedLabels.push(label);
    }
  }
  const leagueSeason = orderedLabels.join(', ');

  return {
    leagueName,
    leagueSeason,
  };
}

/**
 * Provider-aware orchestration helper. Given a freshly-created Square
 * customer for a bowler, resolves the bowler's current league_name +
 * league_season attribute values and writes them to Square.
 *
 * No-op when Square metadata synchronization is unavailable.
 *
 * Returns `{ ok: false }` when the Square API rejects the writes; the
 * caller should flip `bowlers.payment_sync_pending_at` so the existing
 * retry sweep (`payment-sync-retry.ts`) re-runs the customer sync,
 * which in turn re-runs THIS helper. Returns `{ ok: true }` for the
 * non-Square skip path so the caller doesn't accidentally mark the
 * bowler as pending forever.
 */
export async function syncBowlerLeagueAttributesToProvider(
  provider: PaymentProvider,
  customerId: string,
  bowlerId: number,
): Promise<{ ok: boolean }> {
  if (!(provider instanceof SquarePaymentProvider)) {
    return { ok: true };
  }
  try {
    const attrs = await resolveBowlerLeagueAttributes(bowlerId);
    return await provider.syncCustomerLeagueAttributes(customerId, bowlerId, attrs);
  } catch (err) {
    log.warn('Failed to resolve/sync bowler league attributes', {
      bowlerId,
      customerId,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return { ok: false };
  }
}
