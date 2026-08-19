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
import { and, eq, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import { db } from '../db';
import { bowlers } from '@shared/schema';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { lockedSweep } from './_internal/locked-sweep';
import {
  syncBowlerForUser,
  syncUnclaimedBowler,
} from './payment-customer-sync';
import type { PaymentSyncStatus } from '@shared/schema';
import { PAYMENT_SYNC_MAX_ATTEMPTS } from './payment-sync-retry-policy';
import {
  startPaymentSyncRetryScheduler,
  stopPaymentSyncRetryScheduler,
} from './payment-sync-retry-scheduler';

const log = createLogger('PaymentSyncRetry');

// The durable queue timestamp doubles as an expiring claim lease after the
// row-locking transaction commits. Normal success/failure persistence clears
// or replaces it; a crashed worker becomes recoverable after this deadline.
export const PAYMENT_SYNC_CLAIM_LEASE_MS = 5 * 60_000;

export { paymentSyncBackoffMs } from './payment-sync-retry-policy';

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
  //   2. Select only explicit queue rows whose indexed due time has
  //      arrived. Rows in backoff never enter the lock transaction.
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
  const conditions = and(
    isNotNull(bowlers.paymentSyncPendingAt),
    isNotNull(bowlers.paymentSyncNextRetryAt),
    lt(bowlers.paymentSyncAttempts, PAYMENT_SYNC_MAX_ATTEMPTS),
    lte(bowlers.paymentSyncNextRetryAt, now.toISOString()),
  );

  const claimAttemptedAt = now.toISOString();
  const claimLeaseUntil = new Date(
    now.getTime() + PAYMENT_SYNC_CLAIM_LEASE_MS,
  ).toISOString();

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
    // We close that window by stamping the attempt time plus an expiring
    // `payment_sync_next_retry_at` lease before releasing the lock.
    //
    // We deliberately do NOT bump `payment_sync_attempts` here:
    // `syncBowlerForUser` already increments it on failure (and
    // clears it on success), and pre-incrementing would double-count.
    if (locked.length > 0) {
      const lockedIds = locked.map((b) => b.id);
      await tx
        .update(bowlers)
        .set({
          paymentSyncLastAttemptAt: claimAttemptedAt,
          paymentSyncNextRetryAt: claimLeaseUntil,
        })
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

    const dueAt = bowler.paymentSyncNextRetryAt
      ? new Date(bowler.paymentSyncNextRetryAt).getTime()
      : null;
    if (dueAt === null || Number.isNaN(dueAt) || now.getTime() < dueAt) {
      result.skippedBackoff++;
      continue;
    }

    const linkedUser = await storage.getUserByBowlerId(bowler.id);

    // Staff identities must never be treated as bowler profile authority.
    // The schema prevents new staff links, but a legacy/manual row must fail
    // closed and be parked for explicit integrity repair rather than pushing
    // staff PII into a bowler/customer record.
    if (linkedUser && linkedUser.role !== 'user') {
      result.skippedNoUser++;
      log.warn('Skipping payment-sync retry: staff account linked to bowler', {
        bowlerId: bowler.id,
        userId: linkedUser.id,
        role: linkedUser.role,
      });
      await db
        .update(bowlers)
        .set({ paymentSyncNextRetryAt: null })
        .where(and(
          eq(bowlers.id, bowler.id),
          eq(bowlers.paymentSyncLastAttemptAt, claimAttemptedAt),
          eq(bowlers.paymentSyncNextRetryAt, claimLeaseUntil),
        ));
      continue;
    }

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
      // Missing identity/provider configuration is not transient provider
      // work. Park this row until a foreground/manual action changes it;
      // otherwise it would create an endless one-shot timer wake. Fence the
      // update by this worker's lease so a concurrent foreground failure wins.
      await db
        .update(bowlers)
        .set({ paymentSyncNextRetryAt: null })
        .where(and(
          eq(bowlers.id, bowler.id),
          eq(bowlers.paymentSyncLastAttemptAt, claimAttemptedAt),
          eq(bowlers.paymentSyncNextRetryAt, claimLeaseUntil),
        ));
    }
  }

  return result;
}

export async function startPaymentSyncRetrySweep(): Promise<void> {
  await startPaymentSyncRetryScheduler(async () => {
    const summary = await runPaymentSyncRetrySweep();
    if (summary.scanned > 0 || summary.retried > 0) {
      log.info('Payment-sync retry sweep tick', summary);
    }
  });
}

export function stopPaymentSyncRetrySweep(): void {
  stopPaymentSyncRetryScheduler();
}
