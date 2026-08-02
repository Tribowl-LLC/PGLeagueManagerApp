import { PAYMENT_SYNC_MAX_ATTEMPTS } from '@shared/schema';

export { PAYMENT_SYNC_MAX_ATTEMPTS };

const BASE_BACKOFF_MS = 60_000;

/**
 * Exponential backoff anchored at the most recent failed attempt:
 * attempts=0 -> 1m, 1 -> 2m, 2 -> 4m, 3 -> 8m, 4 -> 16m.
 */
export function paymentSyncBackoffMs(attempts: number): number {
  const safe = Math.max(0, Math.min(attempts, 16));
  return BASE_BACKOFF_MS * Math.pow(2, safe);
}

/**
 * Return the durable due time after a failed attempt, or NULL once the
 * automatic retry ceiling has been reached.
 */
export function paymentSyncNextRetryAt(
  attempts: number,
  attemptedAt: Date,
): string | null {
  if (attempts >= PAYMENT_SYNC_MAX_ATTEMPTS) return null;
  return new Date(attemptedAt.getTime() + paymentSyncBackoffMs(attempts)).toISOString();
}
