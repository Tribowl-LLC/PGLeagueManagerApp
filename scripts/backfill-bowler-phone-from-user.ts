/**
 * Task #677: one-time backfill that copies `users.phone` onto the
 * linked `bowlers.phone` for every currently-linked user/bowler
 * pair where the user has a non-empty phone and the bowler row
 * doesn't already match.
 *
 * Why: self-registered users had their phone saved on `users` but
 * never propagated to `bowlers`. The admin "Edit Bowler" modal
 * therefore showed an empty phone field.
 * This script heals the existing rows; the live registration /
 * `runBowlerPostCreateSync` paths handle new pairs going forward.
 *
 * Idempotent: only writes when the bowler's current phone differs
 * from the user's phone. Safe to re-run.
 *
 * Side effects beyond the DB write: for each bowler whose phone
 * was actually changed, the AWAITABLE `runBowlerExternalResync`
 * helper is invoked so Square attributes stay current. Awaited per
 * row so script completion guarantees every dispatch finished.
 *
 * Usage:
 *   npx tsx scripts/backfill-bowler-phone-from-user.ts            # dry-run by default
 *   APPLY=1 npx tsx scripts/backfill-bowler-phone-from-user.ts    # actually write
 *
 * The script prints a final summary:
 *   { scanned, updated, skipped_no_user_phone, skipped_already_matching,
 *     skipped_missing_row, errors }
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, pool } from '../server/db';
import { users, bowlers } from '@shared/schema';
import { syncUserPhoneToBowler } from '../server/services/bowler-phone-sync';
import { runBowlerExternalResync } from '../server/services/bowler-resync';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_CONCURRENCY = 4;

export interface BackfillSummary {
  scanned: number;
  updated: number;
  skipped_no_user_phone: number;
  skipped_already_matching: number;
  skipped_missing_row: number;
  errors: number;
}

export interface BackfillPair {
  userId: number;
  bowlerId: number;
}

export interface BackfillDeps {
  fetchPairs: () => Promise<BackfillPair[]>;
  applyOne: (
    userId: number,
    bowlerId: number,
  ) => Promise<{ outcome: string; organizationId: number | null }>;
  resyncOne: (bowlerId: number, organizationId: number | null) => Promise<void>;
  log?: (message: string, ...rest: unknown[]) => void;
  apply?: boolean;
  batchSize?: number;
  concurrency?: number;
}

/**
 * Pure orchestration over injectable deps. Exported so the unit
 * test can drive it without booting the DB / storage graph.
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const log = deps.log ?? (() => {});
  const apply = deps.apply ?? false;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const summary: BackfillSummary = {
    scanned: 0,
    updated: 0,
    skipped_no_user_phone: 0,
    skipped_already_matching: 0,
    skipped_missing_row: 0,
    errors: 0,
  };

  const pairs = await deps.fetchPairs();
  log(`[backfill] found ${pairs.length} linked user/bowler pairs with a user phone`);

  const updatedTargets: Array<{ bowlerId: number; organizationId: number | null }> = [];

  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);
    for (let j = 0; j < batch.length; j += concurrency) {
      const chunk = batch.slice(j, j + concurrency);
      const results = await Promise.all(
        chunk.map(async (pair) => {
          summary.scanned += 1;
          if (!apply) {
            // Dry-run: classify only — call the storage helper with
            // a no-op apply path is overkill; instead, classification
            // here is the responsibility of the caller's `applyOne`
            // (which in dry-run mode must NOT mutate). We delegate
            // to applyOne so the same code path runs in both modes.
          }
          try {
            const result = await deps.applyOne(pair.userId, pair.bowlerId);
            switch (result.outcome) {
              case 'updated':
                summary.updated += 1;
                return { bowlerId: pair.bowlerId, organizationId: result.organizationId };
              case 'skipped_no_user_phone':
                summary.skipped_no_user_phone += 1;
                return null;
              case 'skipped_already_matching':
                summary.skipped_already_matching += 1;
                return null;
              case 'skipped_missing_row':
                summary.skipped_missing_row += 1;
                return null;
              default:
                summary.errors += 1;
                return null;
            }
          } catch (err) {
            summary.errors += 1;
            log(`[backfill] update failed for bowler ${pair.bowlerId}:`, err);
            return null;
          }
        }),
      );
      for (const r of results) {
        if (r) updatedTargets.push(r);
      }
    }
  }

  if (apply && updatedTargets.length > 0) {
    log(`[backfill] dispatching external resync for ${updatedTargets.length} bowlers`);
    // AWAIT each resync via the injected dep (production wires this
    // to runBowlerExternalResync). The script's contract is that on
    // successful exit every updated bowler has had its external sync
    // attempted; success/failure is handled inside the resync helper,
    // which flips retry flags on the bowler row for any transient
    // errors — the production retry sweep then heals the rest.
    for (const target of updatedTargets) {
      try {
        await deps.resyncOne(target.bowlerId, target.organizationId);
      } catch (err) {
        log(`[backfill] external resync failed for bowler ${target.bowlerId}:`, err);
      }
    }
  }

  return summary;
}

async function fetchPairsFromDb(): Promise<BackfillPair[]> {
  const rows = await db
    .select({
      userId: users.id,
      bowlerId: users.bowlerId,
    })
    .from(users)
    .innerJoin(bowlers, eq(users.bowlerId, bowlers.id))
    .where(and(isNotNull(users.bowlerId), isNotNull(users.phone)));
  return rows
    .filter((r): r is { userId: number; bowlerId: number } => r.bowlerId != null)
    .map((r) => ({ userId: r.userId, bowlerId: r.bowlerId }));
}

async function applyOneViaStorage(
  userId: number,
  bowlerId: number,
): Promise<{ outcome: string; organizationId: number | null }> {
  // Storage layer write — keeps existing write semantics, cache
  // invalidation, and any future hooks consistent with the live
  // registration / runBowlerPostCreateSync paths.
  const result = await syncUserPhoneToBowler(userId, bowlerId);
  return {
    outcome: result.outcome,
    organizationId: result.bowler?.organizationId ?? null,
  };
}

async function classifyOneDryRun(
  userId: number,
  bowlerId: number,
): Promise<{ outcome: string; organizationId: number | null }> {
  // Classification only — re-uses the same decision logic as
  // syncUserPhoneToBowler (via storage reads) but never writes.
  const { decideBowlerPhoneSync } = await import('../server/services/bowler-phone-sync');
  const { storage } = await import('../server/storage');
  const [user, bowler] = await Promise.all([
    storage.getUser(userId),
    storage.getBowler(bowlerId),
  ]);
  const decision = decideBowlerPhoneSync(user ?? null, bowler ?? null);
  if (decision.write) {
    return { outcome: 'updated', organizationId: bowler?.organizationId ?? null };
  }
  return { outcome: decision.reason, organizationId: bowler?.organizationId ?? null };
}

async function main(): Promise<void> {
  const APPLY = process.env.APPLY === '1';
  console.log(`[backfill] starting (${APPLY ? 'APPLY' : 'dry-run'})`);

  const summary = await runBackfill({
    fetchPairs: fetchPairsFromDb,
    applyOne: APPLY ? applyOneViaStorage : classifyOneDryRun,
    resyncOne: runBowlerExternalResync,
    apply: APPLY,
    log: (msg, ...rest) => console.log(msg, ...rest),
  });

  console.log('[backfill] summary:', summary);
  if (!APPLY) {
    console.log('[backfill] dry-run only — re-run with APPLY=1 to write changes.');
  }
}

const isMain = process.argv[1]?.endsWith('backfill-bowler-phone-from-user.ts');
if (isMain) {
  main()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[backfill] fatal error:', err);
      try {
        await pool.end();
      } catch {
        // already closed
      }
      process.exit(1);
    });
}
