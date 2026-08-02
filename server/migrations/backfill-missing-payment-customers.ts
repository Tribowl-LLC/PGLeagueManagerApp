/**
 * Task #682 — one-time backfill that flags every bowler with an
 * email but no `payment_customer_id` for the background retry sweep.
 *
 * Bowlers that were created during a transient Square outage, with
 * a mis-configured org, or before the post-create sync started
 * flagging failures (see `runBowlerPostCreateSync`) are stuck in
 * `payment_customer_id IS NULL` limbo forever — the sweep only
 * walks rows whose `payment_sync_pending_at` is set. This UPDATE
 * stamps the flag on every such legacy row so the sweep
 * (`server/services/payment-sync-retry.ts`) backfills them on the
 * next few ticks.
 *
 * Guarded by `BACKFILL_MISSING_PAYMENT_CUSTOMERS=true` so it can't
 * loop forever across restarts: once an operator has run it and
 * confirmed the sweep cleared the queue, they unset the flag.
 * Without the flag this is a no-op.
 *
 * Idempotent in spirit: re-running with the flag set will only
 * touch rows whose `payment_sync_pending_at` is still NULL, so
 * once a row has been picked up by the sweep (and either succeeded
 * or already been re-flagged with attempt bookkeeping) this
 * backfill won't restamp it.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { bowlers } from '@shared/schema';
import { createLogger } from '../logger';
import { notifyPaymentSyncRetryChanged } from '../services/payment-sync-retry-scheduler';

const log = createLogger('MissingPaymentCustomerBackfill');

export async function backfillMissingPaymentCustomers(): Promise<void> {
  if (process.env.BACKFILL_MISSING_PAYMENT_CUSTOMERS !== 'true') {
    return;
  }

  const result = await db
    .update(bowlers)
    .set({
      paymentSyncPendingAt: sql`NOW()`,
      // Reset the attempt counter so the sweep's exponential backoff
      // starts fresh for these rows. Without this, a row that hit the
      // attempt cap on a previous (real) failure would never be
      // re-attempted by the sweep.
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
      paymentSyncNextRetryAt: sql`NOW()`,
    })
    .where(sql`${bowlers.paymentCustomerId} IS NULL
      AND ${bowlers.email} IS NOT NULL
      AND ${bowlers.paymentSyncPendingAt} IS NULL`)
    .returning({ id: bowlers.id });

  log.info(
    `Flagged ${result.length} legacy bowler(s) (paymentCustomerId IS NULL, email IS NOT NULL) for the payment-sync retry sweep.`,
  );
  if (result.length > 0) notifyPaymentSyncRetryChanged();
}
