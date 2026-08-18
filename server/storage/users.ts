import { eq, and, count, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  users,
  applePayJobs,
  deletionRequests,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptions,
  orphanCleanupAudits,
  paymentDisputeReplayAudits,
  paymentOperations,
  type User,
  type InsertUser,
  type UpdateUser,
  type UserRole,
} from "@shared/schema";
import { createLogger } from '../logger';
import { cacheInvalidate } from '../utils/cache';

// Drizzle's transaction client and the top-level `db` share the same
// callable update API, so a thin DbExecutor union lets callers pass
// `tx` to perform the user mutation inside an existing transaction
// (e.g. the admin password-reset route, task #458, which writes the
// password row and the audit row as one atomic unit).
export type UserDbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

const log = createLogger("StorageUsers");

/**
 * Sentinel error thrown by the atomic first-admin bootstrap path when a
 * system_admin already exists. Routes catch this and translate it into
 * the public ADMIN_EXISTS / 403 response.
 */
export class AdminAlreadyExistsError extends Error {
  constructor(message = 'Admin user already exists') {
    super(message);
    this.name = 'AdminAlreadyExistsError';
  }
}

export class FirstAdminEmailExistsError extends Error {
  constructor(message = 'A user with this email already exists') {
    super(message);
    this.name = 'FirstAdminEmailExistsError';
  }
}

export class FirstAdminUserNotFoundError extends Error {
  constructor(message = 'User not found') {
    super(message);
    this.name = 'FirstAdminUserNotFoundError';
  }
}

/**
 * Thrown by user create/update paths that would leave a non-system_admin
 * user without an organizationId. Mirrors the `users_role_org_required`
 * DB CHECK constraint so callers get a clean typed error before hitting
 * the database.
 */
export class NonAdminMissingOrgError extends Error {
  constructor(message = 'Non-admin users must belong to an organization') {
    super(message);
    this.name = 'NonAdminMissingOrgError';
  }
}

/**
 * Thrown by `deleteUser` when the target is a system_admin. System admins
 * are never deletable through the user-admin UI — that would let any
 * org_admin escalate themselves into the only admin role and delete
 * everyone else, and would also strand orphan_cleanup_audits rows
 * (FK ON DELETE RESTRICT). Demote them via the system-admin tooling
 * first if they really need to be removed.
 */
export class CannotDeleteAdminError extends Error {
  constructor(message = 'System admin accounts cannot be deleted through this endpoint') {
    super(message);
    this.name = 'CannotDeleteAdminError';
  }
}

/**
 * Thrown by `deleteUser` when the target user owns restrictive operational
 * audit rows. Ordinary deletion preserves those trails; full organization
 * teardown is the explicit retention exception.
 */
export class UserHasAuditTrailError extends Error {
  constructor(public readonly auditCount: number) {
    super(
      `User has ${auditCount} retained audit row(s) and cannot be deleted. Delete or reassign the audits first.`,
    );
    this.name = 'UserHasAuditTrailError';
  }
}

async function countCanonicalOccurrenceActorReferences(
  tx: UserDbExecutor,
  userId: number,
): Promise<number> {
  const [commandRows] = await tx
    .select({ count: count() })
    .from(leagueScheduleCommands)
    .where(eq(leagueScheduleCommands.actorUserId, userId));
  const [generationRows] = await tx
    .select({ count: count() })
    .from(leagueOccurrenceGenerationRuns)
    .where(or(
      eq(leagueOccurrenceGenerationRuns.approvedByUserId, userId),
      eq(leagueOccurrenceGenerationRuns.rejectedByUserId, userId),
    ));
  const [occurrenceRows] = await tx
    .select({ count: count() })
    .from(leagueOccurrences)
    .where(or(
      eq(leagueOccurrences.publishedByUserId, userId),
      eq(leagueOccurrences.lockedByUserId, userId),
      eq(leagueOccurrences.cancelledByUserId, userId),
      eq(leagueOccurrences.completedByUserId, userId),
      eq(leagueOccurrences.discardedByUserId, userId),
    ));
  const [exceptionRows] = await tx
    .select({ count: count() })
    .from(leagueScheduleExceptions)
    .where(or(
      eq(leagueScheduleExceptions.publishedByUserId, userId),
      eq(leagueScheduleExceptions.revokedByUserId, userId),
    ));
  const [relationshipRows] = await tx
    .select({ count: count() })
    .from(leagueOccurrenceRelationships)
    .where(or(
      eq(leagueOccurrenceRelationships.publishedByUserId, userId),
      eq(leagueOccurrenceRelationships.revokedByUserId, userId),
    ));
  const [billingTermRows] = await tx
    .select({ count: count() })
    .from(leagueOccurrenceBillingTerms)
    .where(eq(leagueOccurrenceBillingTerms.publishedByUserId, userId));
  const [paymentOperationRows] = await tx
    .select({ count: count() })
    .from(paymentOperations)
    .where(eq(paymentOperations.authorizingUserId, userId));

  return [
    commandRows,
    generationRows,
    occurrenceRows,
    exceptionRows,
    relationshipRows,
    billingTermRows,
    paymentOperationRows,
  ].reduce((total, row) => total + Number(row?.count ?? 0), 0);
}

// Stable advisory-lock key for the first-admin bootstrap critical section.
// pg_advisory_xact_lock takes a bigint; pick an arbitrary unique constant.
const BOOTSTRAP_ADVISORY_LOCK_KEY = 7244910283645127n;

// Task #357: change-password lockout policy. The per-user rate limiter
// (#317, #356) caps attempts at 10 / 15 min (~960/day across windows);
// the lockout escalates to a hard temporary disable once a higher
// threshold is crossed and force-logs-out every session for the user.
//
// Tuning: 25 hot-streak failures inside one rate-limit cycle is well
// past anyone fat-fingering their current password while signed in,
// but low enough to defeat a patient hijacker grinding ~10 guesses
// per 15-min window. The 1-hour duration keeps the user's recovery
// path painless (use forgot-password to bypass) without giving an
// attacker a small fixed cost-window to keep retrying.
export const PASSWORD_CHANGE_LOCKOUT_THRESHOLD = 25;
export const PASSWORD_CHANGE_LOCKOUT_DURATION_MS = 60 * 60 * 1000;

export interface RecordFailedPasswordChangeAttemptResult {
  /** New value of users.failed_password_change_attempts after the bump. */
  count: number;
  /** ISO string of the active lock, or null if no lock is engaged. */
  lockedUntil: string | null;
  /**
   * True iff THIS call was the one that engaged the lock. Used by the
   * route to gate the one-time side effects (destroy all sessions,
   * send the alert email) so a piled-up second attempt doesn't
   * re-fire them after the lock is already in effect.
   */
  justLocked: boolean;
}

export async function getUser(id: number): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

/**
 * Atomically increment `failedPasswordChangeAttempts` for the given
 * user and engage a temporary lock if the threshold is crossed by
 * THIS call. Race-safe across concurrent failed attempts via
 * `SELECT ... FOR UPDATE` inside a transaction — the second attempt
 * waits for the first to commit, sees the lock, and short-circuits
 * (no double-fire of side effects).
 *
 * Behaviour:
 *  - If a lock is currently active (lockedUntil > now), do nothing and
 *    return the existing state. (The route should have already
 *    rejected the call before reaching this helper, but the no-op
 *    keeps the helper safe under races and stops attackers from
 *    extending the lock indefinitely by piling on attempts.)
 *  - If a lock has expired (lockedUntil <= now), treat this attempt
 *    as the start of a fresh window: counter is reset to 0 before the
 *    bump, and the lock column is cleared.
 *  - Otherwise just bump the counter. If the new value crosses the
 *    threshold, set `passwordChangeLockedUntil = now + duration` and
 *    return `justLocked = true` so the route fires the side effects.
 */
export async function recordFailedPasswordChangeAttempt(
  userId: number,
): Promise<RecordFailedPasswordChangeAttemptResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        count: users.failedPasswordChangeAttempts,
        lockedUntil: users.passwordChangeLockedUntil,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');

    if (!row) {
      throw new Error(`User ${userId} not found`);
    }

    const nowMs = Date.now();
    const lockedUntilMs = row.lockedUntil ? Date.parse(row.lockedUntil) : null;
    const wasActiveLock = lockedUntilMs !== null && lockedUntilMs > nowMs;

    if (wasActiveLock) {
      return {
        count: row.count,
        lockedUntil: row.lockedUntil,
        justLocked: false,
      };
    }

    const lockExpired = lockedUntilMs !== null && lockedUntilMs <= nowMs;
    const baseCount = lockExpired ? 0 : row.count;
    const newCount = baseCount + 1;

    let newLockedUntil: string | null = null;
    let justLocked = false;
    if (newCount >= PASSWORD_CHANGE_LOCKOUT_THRESHOLD) {
      newLockedUntil = new Date(nowMs + PASSWORD_CHANGE_LOCKOUT_DURATION_MS).toISOString();
      justLocked = true;
    }

    await tx
      .update(users)
      .set({
        failedPasswordChangeAttempts: newCount,
        passwordChangeLockedUntil: newLockedUntil,
      })
      .where(eq(users.id, userId));

    cacheInvalidate(`user:${userId}`);
    return { count: newCount, lockedUntil: newLockedUntil, justLocked };
  });
}

/**
 * Reset the change-password failure counter and clear any active
 * lock. Called after a successful password change so a previously-
 * partially-failed user starts from a clean slate. Best-effort —
 * if this throws after the password update commits, the route
 * surfaces the error rather than rolling the rotation back.
 */
export async function resetFailedPasswordChangeAttempts(userId: number): Promise<void> {
  await db
    .update(users)
    .set({
      failedPasswordChangeAttempts: 0,
      passwordChangeLockedUntil: null,
    })
    .where(eq(users.id, userId));
  cacheInvalidate(`user:${userId}`);
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}

export async function createUser(user: InsertUser): Promise<User> {
  const role = user.role ?? 'user';
  if (role !== 'system_admin' && (user.organizationId === null || user.organizationId === undefined)) {
    throw new NonAdminMissingOrgError();
  }
  const [result] = await db.insert(users).values(user).returning();
  return result;
}

export async function updateUser(
  id: number,
  userData: UpdateUser,
  executor: UserDbExecutor = db,
): Promise<User> {
  log.info('Updating user:', { id, userData });

  const [updatedUser] = await executor
    .update(users)
    .set(userData)
    .where(eq(users.id, id))
    .returning();

  if (!updatedUser) {
    log.error('Failed to update user:', id);
    throw new Error(`Failed to update user with ID ${id}`);
  }

  log.info('Updated user successfully:', {
    id: updatedUser.id,
    email: updatedUser.email,
  });

  cacheInvalidate(`user:${id}`);
  return updatedUser;
}

export async function linkUserToBowler(userId: number, bowlerId: number | undefined): Promise<User> {
  const [updatedUser] = await db
    .update(users)
    .set({ bowlerId: bowlerId ?? null })
    .where(eq(users.id, userId))
    .returning();
  cacheInvalidate(`user:${userId}`);
  return updatedUser;
}

export async function getLinkedBowlerIds(): Promise<number[]> {
  const rows = await db
    .select({ bowlerId: users.bowlerId })
    .from(users)
    .where(isNotNull(users.bowlerId));
  return rows.map(r => r.bowlerId!);
}

export async function getUserByBowlerId(bowlerId: number): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.bowlerId, bowlerId)).limit(1);
  return user;
}

export async function isBowlerLinked(bowlerId: number): Promise<boolean> {
  const [row] = await db
    .select({ bowlerId: users.bowlerId })
    .from(users)
    .where(eq(users.bowlerId, bowlerId))
    .limit(1);
  return row !== undefined;
}

export async function hasAdminUsers(): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'system_admin'))
    .limit(1);
  return row !== undefined;
}

export async function countOrgAdmins(organizationId: number): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'org_admin')));
  return Number(row?.count ?? 0);
}

export async function getUsers(): Promise<User[]> {
  log.info('Getting all users');
  return db.select().from(users).orderBy(users.id);
}

/**
 * Return the org_admin users for an organization. Used by background
 * notifiers (e.g. the league Square-catalog audit, task #654) that
 * need to email the league's admins when a saved Square variation id
 * disappears from the live catalog.
 */
export async function getOrgAdmins(organizationId: number): Promise<User[]> {
  return db
    .select()
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'org_admin')))
    .orderBy(users.id);
}

export async function updateUserRole(
  userId: number,
  role: UserRole,
  executor: UserDbExecutor = db,
): Promise<User> {
  log.info('Updating role for user:', { userId, role });

  const [existingUser] = await executor.select().from(users).where(eq(users.id, userId));
  if (!existingUser) {
    log.error('User not found for role update:', userId);
    throw new Error(`User with ID ${userId} not found`);
  }

  if (role !== 'system_admin' && existingUser.organizationId === null) {
    throw new NonAdminMissingOrgError();
  }

  const [updatedUser] = await executor
    .update(users)
    .set({ role })
    .where(eq(users.id, userId))
    .returning();

  if (!updatedUser) {
    log.error('Failed to update role for user:', userId);
    throw new Error(`Failed to update role for user with ID ${userId}`);
  }

  log.info('Successfully updated role for user:', {
    userId,
    role: updatedUser.role
  });

  cacheInvalidate(`user:${userId}`);
  return updatedUser;
}

/**
 * Atomically create the first system_admin. Uses a transaction-scoped
 * Postgres advisory lock to serialize concurrent bootstrap requests so
 * that the "no admin exists" check and the insert happen as one
 * critical section. Throws AdminAlreadyExistsError if the invariant has
 * already been satisfied, or FirstAdminEmailExistsError if the email is
 * taken.
 */
export async function bootstrapFirstAdmin(input: {
  email: string;
  hashedPassword: string;
  name: string;
  phone?: string;
}): Promise<User> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`);

    const [existingAdmin] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'system_admin'))
      .limit(1);
    if (existingAdmin) {
      throw new AdminAlreadyExistsError();
    }

    const [existingEmail] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existingEmail) {
      throw new FirstAdminEmailExistsError();
    }

    const [created] = await tx
      .insert(users)
      .values({
        email: input.email,
        password: input.hashedPassword,
        name: input.name,
        phone: input.phone ?? undefined,
        role: 'system_admin',
        organizationId: null,
      })
      .returning();
    return created;
  });
}

/**
 * Atomically promote an existing user to system_admin, but only if no
 * system_admin currently exists. Uses the same advisory lock as
 * bootstrapFirstAdmin so the two endpoints share one critical section.
 */
export async function promoteFirstAdmin(userId: number): Promise<User> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`);

    const [existingAdmin] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'system_admin'))
      .limit(1);
    if (existingAdmin) {
      throw new AdminAlreadyExistsError();
    }

    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) {
      throw new FirstAdminUserNotFoundError();
    }

    const [promoted] = await tx
      .update(users)
      .set({ role: 'system_admin' })
      .where(eq(users.id, userId))
      .returning();
    cacheInvalidate(`user:${userId}`);
    return promoted;
  });
}

export async function setUserLocation(userId: number, locationId: number | null): Promise<User> {
  const [updatedUser] = await db
    .update(users)
    .set({ locationId })
    .where(eq(users.id, userId))
    .returning();
  if (!updatedUser) {
    throw new Error(`User with ID ${userId} not found`);
  }
  cacheInvalidate(`user:${userId}`);
  return updatedUser;
}

export async function getUserByInviteToken(token: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.inviteToken, token));
  return user;
}

export async function setUserInviteToken(userId: number, token: string, expiry: Date): Promise<User> {
  const [updatedUser] = await db
    .update(users)
    .set({ inviteToken: token, inviteTokenExpiry: expiry.toISOString() })
    .where(eq(users.id, userId))
    .returning();
  if (!updatedUser) {
    throw new Error(`User with ID ${userId} not found`);
  }
  return updatedUser;
}

/**
 * Permanently delete a user account, in a single transaction:
 *   1. Refuse if the target is a `system_admin`.
 *   2. Refuse if the target has restrictive cleanup or dispute-replay audit
 *      rows (admin audit trails are preserved until full tenant teardown).
 *   3. Null out audit-style FK references that we want to PRESERVE
 *      across the delete: `apple_pay_jobs.created_by` and
 *      `deletion_requests.reviewed_by`. Both columns are nullable.
 *   4. Delete the user row itself.
 *
 * Returns the deleted user (so callers can render a confirmation that
 * shows the email/name without an extra read). Throws
 * `CannotDeleteAdminError` or `UserHasAuditTrailError` for the typed
 * refusal cases above. (#268)
 */
export async function deleteUser(
  userId: number,
  executor?: UserDbExecutor,
): Promise<User> {
  // When the caller passes their own transaction executor we run the
  // deletion inside that transaction so any row locks they took remain
  // held end-to-end (avoids the TOCTOU window between a precondition
  // check and the actual delete). Otherwise we open our own txn.
  const run = async (tx: UserDbExecutor): Promise<User> => {
    const [target] = await tx.select().from(users).where(eq(users.id, userId));
    if (!target) {
      throw new Error(`User with ID ${userId} not found`);
    }
    if (target.role === 'system_admin') {
      throw new CannotDeleteAdminError();
    }

    const [cleanupAuditRow] = await tx
      .select({ count: count() })
      .from(orphanCleanupAudits)
      .where(eq(orphanCleanupAudits.adminUserId, userId));
    const [replayAuditRow] = await tx
      .select({ count: count() })
      .from(paymentDisputeReplayAudits)
      .where(eq(paymentDisputeReplayAudits.actorUserId, userId));
    const canonicalOccurrenceAuditCount = await countCanonicalOccurrenceActorReferences(tx, userId);
    const auditCount = Number(cleanupAuditRow?.count ?? 0)
      + Number(replayAuditRow?.count ?? 0)
      + canonicalOccurrenceAuditCount;
    if (auditCount > 0) {
      throw new UserHasAuditTrailError(auditCount);
    }

    await tx
      .update(applePayJobs)
      .set({ createdBy: null })
      .where(eq(applePayJobs.createdBy, userId));

    await tx
      .update(deletionRequests)
      .set({ reviewedBy: null })
      .where(eq(deletionRequests.reviewedBy, userId));

    const [deleted] = await tx
      .delete(users)
      .where(eq(users.id, userId))
      .returning();

    if (!deleted) {
      throw new Error(`Failed to delete user with ID ${userId}`);
    }

    cacheInvalidate(`user:${userId}`);
    log.info('Deleted user', { id: deleted.id, email: deleted.email });
    return deleted;
  };

  if (executor) {
    return run(executor);
  }
  return db.transaction(async (tx) => run(tx));
}

export async function clearUserInviteToken(userId: number): Promise<User> {
  const [updatedUser] = await db
    .update(users)
    .set({ inviteToken: null, inviteTokenExpiry: null })
    .where(eq(users.id, userId))
    .returning();
  if (!updatedUser) {
    throw new Error(`User with ID ${userId} not found`);
  }
  return updatedUser;
}
