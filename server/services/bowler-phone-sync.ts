/**
 * Task #677: keep `bowlers.phone` in sync with the linked
 * `users.phone`. The user value wins because that is what the
 * bowler themselves entered at sign-up; the bowler row may have
 * a stale value the admin typed in earlier or no value at all
 * (the regression that motivated this task: self-registered
 * users had a phone on `users` that was never copied onto
 * `bowlers`, so the admin "Edit Bowler" modal showed an empty
 * field).
 *
 * The helper is intentionally idempotent: it only writes when
 * the user has a non-empty phone AND the bowler's current
 * phone differs. That keeps the backfill safe to re-run and
 * keeps the link-time call sites cheap (no spurious updates,
 * no spurious cache busts, and no spurious external updates).
 *
 * Direction is user → bowler only — see task brief "Out of
 * scope".
 */
import type { Bowler, User } from '@shared/schema';
import { storage } from '../storage';

export type BowlerPhoneSyncOutcome =
  | 'updated'
  | 'skipped_no_user_phone'
  | 'skipped_already_matching'
  | 'skipped_missing_row';

export interface SyncBowlerPhoneFromUserResult {
  outcome: BowlerPhoneSyncOutcome;
  bowler: Bowler | null;
}

function normalizePhone(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * Pure decision helper — exposed for the backfill script and
 * the unit tests so the "should we write?" branch can be
 * exercised without touching the DB. Returns the new phone
 * value to write, or null if no write is needed.
 */
export function decideBowlerPhoneSync(
  user: Pick<User, 'phone'> | null | undefined,
  bowler: Pick<Bowler, 'phone'> | null | undefined,
): { write: false; reason: Exclude<BowlerPhoneSyncOutcome, 'updated'> } | { write: true; phone: string } {
  if (!user || !bowler) {
    return { write: false, reason: 'skipped_missing_row' };
  }
  const userPhone = normalizePhone(user.phone);
  if (!userPhone) {
    return { write: false, reason: 'skipped_no_user_phone' };
  }
  if (normalizePhone(bowler.phone) === userPhone) {
    return { write: false, reason: 'skipped_already_matching' };
  }
  return { write: true, phone: userPhone };
}

/**
 * Look up the user + bowler and apply the sync. Returns the
 * outcome and the (possibly updated) bowler row. Used by the
 * registration route and the backfill script. Callers that
 * already have the user object loaded (e.g. `runBowlerPostCreateSync`)
 * should use `decideBowlerPhoneSync` directly to avoid the
 * extra `getUser` round-trip.
 */
export async function syncUserPhoneToBowler(
  userId: number,
  bowlerId: number,
): Promise<SyncBowlerPhoneFromUserResult> {
  const [user, bowler] = await Promise.all([
    storage.getUser(userId),
    storage.getBowler(bowlerId),
  ]);
  const decision = decideBowlerPhoneSync(user ?? null, bowler ?? null);
  if (!decision.write) {
    return { outcome: decision.reason, bowler: bowler ?? null };
  }
  const updated = await storage.updateBowler(bowlerId, { phone: decision.phone });
  return { outcome: 'updated', bowler: updated };
}
