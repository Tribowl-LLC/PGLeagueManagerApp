/**
 * Background sweep that retries failed payment-customer syncs (task #284).
 *
 * Task #281 introduced `bowlers.payment_sync_pending_at`: a flag set by
 * `syncBowlerForUser` when a profile-update tried to push the bowler to
 * the payment provider and the call failed for a transient reason.
 * Until this sweep existed an admin had to call the manual retry
 * endpoint per bowler. The sweep walks the flagged bowlers, looks up
 * the linked user, and re-runs the same helper that the profile-update
 * path uses. Successful retries clear the flag; consecutive failures
 * are tracked via `payment_sync_attempts` and `payment_sync_last_attempt_at`
 * so we can apply exponential backoff and stop once we hit
 * `PAYMENT_SYNC_MAX_ATTEMPTS` (the helper logs a structured "given up"
 * error at that point). The admin retry endpoint stays available as a
 * manual override regardless of attempt count.
 */
import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { bowlers } from '@shared/schema';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { lockedSweep } from './_internal/locked-sweep';
import {
  PAYMENT_SYNC_MAX_ATTEMPTS,
  syncBowlerForUser,
  syncUnclaimedBowler,
} from './payment-customer-sync';
import type { PaymentSyncStatus } from '@shared/schema';

const log = createLogger('PaymentSyncRetry');

// Low-frequency recovery backstop for rows flagged by a failed customer
// sync. This is deliberately longer than Neon’s default scale-to-zero idle
// window: foreground syncs and manual retry endpoints remain immediate, while
// an idle Render process no longer performs a database keepalive every five
// minutes.
export const PAYMENT_SYNC_RETRY_BACKSTOP_INTERVAL_MS = 15 * 60_000;

// Exponential backoff anchored at the most recent retry attempt:
//   attempts=0 → 1m, 1 → 2m, 2 → 4m, 3 → 8m, 4 → 16m
// `attempts` here is the count *before* the next retry; once it hits
// `PAYMENT_SYNC_MAX_ATTEMPTS` we stop trying altogether.
const BASE_BACKOFF_MS = 60_000;

export function paymentSyncBackoffMs(attempts: number): number {
  const safe = Math.max(0, Math.min(attempts, 16));
  return BASE_BACKOFF_MS * Math.pow(2, safe);
}

export interface SweepResult {
  scanned: number;
  retried: number;
  succeeded: number;
  pendingAgain: number;
  skippedBackoff: number;
  skippedNoUser: number;
  skippedMaxAttempts: number;
  errors: number;
  /**
   * Rows that matched the eligibility predicate but were locked by a
   * peer process's concurrent sweep (FOR UPDATE OF bowlers SKIP
   * LOCKED — see lockedSweep). Surfaced on the result so multi-process
   * race tests (and any future telemetry) can see contention without
   * having to scrape log lines. Always 0 when the app runs single-
   * process. Mirrors the structured `log.info` on contention below.
   */
  skippedByLock: number;
}

export async function runPaymentSyncRetrySweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    retried: 0,
    succeeded: 0,
    pendingAgain: 0,
    skippedBackoff: 0,
    skippedNoUser: 0,
    skippedMaxAttempts: 0,
    errors: 0,
    skippedByLock: 0,
  };

  // SQL filter responsibilities:
  //   1. Exclude bowlers that already hit the attempts cap so the
  //      working set keeps shrinking once we've given up.
  //   2. Exclude bowlers still inside their per-attempt backoff
  //      window. This used to live only in JS below, but we now need
  //      it in SQL too so the lease-stamp step (see comment lower
  //      down) only marks rows we're actually about to retry —
  //      otherwise a row in backoff would be re-stamped every tick
  //      and starve forever (review feedback on task #321).
  //
  //      Backoff math mirrors paymentSyncBackoffMs:
  //        dueAt = last_attempt_at + 60s * 2 ^ LEAST(attempts, 16)
  //      LEAST clamps the exponent so an absurd attempt count can't
  //      overflow the interval arithmetic.
  //
  // Concurrency: we mirror the row-locking pattern used by the
  // payment scheduler (see `server/services/payment-scheduler.ts`,
  // `sweepTick`). When the app runs on more than one process, two
  // sweep ticks could otherwise pick the same flagged bowler in the
  // same window and double-call the payment provider. Wrapping the
  // candidate selection in a transaction with FOR UPDATE SKIP LOCKED
  // means each row is claimed by exactly one worker per tick — the
  // other worker sees the row as locked and silently skips it.
  // We also count the matching rows separately so we can log how
  // many were skipped because of contention with another instance
  // (matching the scheduler's lock-contention telemetry).
  const backoffEligible = sql`(
    ${bowlers.paymentSyncLastAttemptAt} IS NULL
    OR ${bowlers.paymentSyncLastAttemptAt} + (interval '60 seconds' * power(2, LEAST(${bowlers.paymentSyncAttempts}, 16))) <= NOW()
  )`;

  const conditions = and(
    isNotNull(bowlers.paymentSyncPendingAt),
    lt(bowlers.paymentSyncAttempts, PAYMENT_SYNC_MAX_ATTEMPTS),
    backoffEligible,
  );

  const { candidates, skippedByLock } = await db.transaction(async (tx) => {
    // The shared lockedSweep helper drives both the count query and
    // the FOR UPDATE SKIP LOCKED select off the same `conditions`
    // predicate (see ./_internal/locked-sweep.ts) so the contention
    // math can never drift from the lock query. We still own the
    // surrounding transaction because the lease-stamp UPDATE below
    // has to commit atomically with the lock claim.
    const { rows: locked, skippedByLock: skipped } = await lockedSweep(
      tx,
      bowlers,
      conditions!,
    );

    // Critical for cross-process safety: row locks are released as
    // soon as this transaction commits, but `syncBowlerForUser` runs
    // OUTSIDE the tx (it makes external HTTP calls that would hold a
    // DB transaction open for far too long). Without further action,
    // a second worker's next tick a moment later could re-select the
    // same row and double-call the payment provider.
    //
    // We close that window by stamping `payment_sync_last_attempt_at`
    // to NOW for every locked row before releasing the lock. The JS
    // backoff guard further down (`now < dueAt`) then naturally
    // excludes these rows from any other worker's tick until the
    // backoff window for the current attempt count elapses — so even
    // a slow external retry can't be raced by a peer.
    //
    // We deliberately do NOT bump `payment_sync_attempts` here:
    // `syncBowlerForUser` already increments it on failure (and
    // clears it on success), and pre-incrementing would double-count.
    if (locked.length > 0) {
      const lockedIds = locked.map((b) => b.id);
      await tx
        .update(bowlers)
        .set({ paymentSyncLastAttemptAt: sql`NOW()` })
        .where(inArray(bowlers.id, lockedIds));
    }

    return {
      candidates: locked,
      skippedByLock: skipped,
    };
  });

  if (skippedByLock > 0) {
    log.info('Payment-sync retry: rows claimed by another instance', {
      skippedByLock,
      acquired: candidates.length,
    });
  }

  result.skippedByLock = skippedByLock;
  result.scanned = candidates.length;

  for (const bowler of candidates) {
    if ((bowler.paymentSyncAttempts ?? 0) >= PAYMENT_SYNC_MAX_ATTEMPTS) {
      result.skippedMaxAttempts++;
      continue;
    }

    const lastAttempt = bowler.paymentSyncLastAttemptAt
      ? new Date(bowler.paymentSyncLastAttemptAt).getTime()
      : null;
    if (lastAttempt !== null) {
      const dueAt = lastAttempt + paymentSyncBackoffMs(bowler.paymentSyncAttempts ?? 0);
      if (now.getTime() < dueAt) {
        result.skippedBackoff++;
        continue;
      }
    }

    const linkedUser = await storage.getUserByBowlerId(bowler.id);

    // Task #705: unclaimed-bowler path. Previously the sweep skipped
    // any flagged row that had no linked user, which left bowlers
    // stuck in `payment_sync_pending_at` forever any time the
    // foreground PATCH path stamped the flag (e.g. attribute upsert
    // failed, no Square location resolvable at the moment, transient
    // Square error) on a bowler that hadn't been claimed by a user
    // account yet. The bowler row itself has a perfectly good name +
    // email + phone to push, so we sync directly from it via
    // `syncUnclaimedBowler`. Same `createOrUpdateCustomer` +
    // attribute-sync helpers, same attempt counter / pending flag
    // bookkeeping as the linked-user path. The `skippedNoUser`
    // counter is now reserved for the genuinely-unsyncable case
    // (no email / no org / no Square location), where the helper
    // returns `'skipped'` without bumping attempts.
    result.retried++;
    let status: PaymentSyncStatus;
    try {
      if (linkedUser) {
        // Source-of-truth for the retry is the linked user's
        // profile, matching what the manual admin endpoint does.
        // We mark every field as "changed" so the helper writes the
        // local bowler row and re-issues the provider call without
        // inspecting deltas.
        status = await syncBowlerForUser(
          {
            id: linkedUser.id,
            bowlerId: bowler.id,
            name: linkedUser.name ?? bowler.name,
            email: linkedUser.email ?? bowler.email,
            phone: linkedUser.phone ?? bowler.phone,
            locationId: linkedUser.locationId,
            organizationId: linkedUser.organizationId,
          },
          { nameChanged: true, emailChanged: true, phoneChanged: true },
        );
      } else {
        status = await syncUnclaimedBowler(bowler.id);
      }
    } catch (err) {
      result.errors++;
      log.error('Payment-sync retry threw unexpectedly', {
        bowlerId: bowler.id,
        userId: linkedUser?.id ?? null,
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      continue;
    }

    if (status === 'synced') {
      result.succeeded++;
    } else if (status === 'pending_retry') {
      result.pendingAgain++;
    } else if (status === 'skipped') {
      // Genuinely unsyncable on this tick (no email, no org Square
      // location, or provider-not-configured). Surface once per tick
      // so ops can clean it up — same intent as the original
      // "no linked user" warn line, but covering both the unclaimed
      // and the not-claimable-via-org cases.
      if (!linkedUser) {
        log.warn('Skipping payment-sync retry: unclaimed bowler not syncable', {
          bowlerId: bowler.id,
          pendingSince: bowler.paymentSyncPendingAt,
          attempts: bowler.paymentSyncAttempts,
          hasEmail: bowler.email != null,
          organizationId: bowler.organizationId,
        });
      }
      result.skippedNoUser++;
      // Don't double-count: a skipped row didn't actually retry.
      result.retried--;
    }
  }

  return result;
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

export function startPaymentSyncRetrySweep(
  intervalMs: number = PAYMENT_SYNC_RETRY_BACKSTOP_INTERVAL_MS,
): void {
  stopPaymentSyncRetrySweep();
  log.info('Starting payment-sync retry sweep', {
    intervalMs,
    maxAttempts: PAYMENT_SYNC_MAX_ATTEMPTS,
  });

  const tick = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      const summary = await runPaymentSyncRetrySweep();
      if (summary.scanned > 0 || summary.retried > 0) {
        log.info('Payment-sync retry sweep tick', summary);
      }
    } catch (err) {
      log.error('Payment-sync retry sweep tick failed', {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
      });
    } finally {
      sweepInFlight = false;
    }
  };

  sweepInterval = setInterval(() => { void tick(); }, intervalMs);
  if (sweepInterval && typeof sweepInterval === 'object' && 'unref' in sweepInterval) {
    sweepInterval.unref();
  }

  // Fire one tick immediately so a server that came up after a long
  // outage starts retrying without waiting a full interval.
  void tick();
}

export function stopPaymentSyncRetrySweep(): void {
  if (sweepInterval !== null) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    log.info('Payment-sync retry sweep stopped');
  }
}
