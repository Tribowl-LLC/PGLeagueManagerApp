import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import {
  accountActionRequests,
  emailChangeRequests,
  users,
  type AccountActionDeliveryStatus,
  type AccountActionRequest,
  type AccountActionStatus,
  type AccountActionType,
  type User,
} from "@shared/schema";
import { cacheInvalidate } from "../utils/cache";

/** The only token representation that may be persisted. */
export function hashAccountActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type AccountActionExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface IssuedAccountAction {
  request: AccountActionRequest;
  /** Raw 256-bit token. Callers must use it immediately and never persist it. */
  token: string;
}

export interface AccountActionWithUser {
  request: AccountActionRequest;
  user: User;
}

export interface CompletedPasswordAction extends AccountActionWithUser {}

/**
 * Serialize issuance and delivery for a user's action type. The transaction
 * lock in `issueAccountAction` protects database state; this session lock is
 * deliberately held until delivery status is recorded so an older email can
 * never be sent after a newer resend.
 */
export async function withAccountActionDeliveryLock<T>(
  userId: number,
  action: AccountActionType,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("A positive user ID is required for account-action delivery");
  }
  const client = await pool.connect();
  const lockKey = `account-action-delivery:${userId}:${action}`;
  let destroyClient = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    } catch {
      // A session-level lock must never return to the pool if unlock fails.
      destroyClient = true;
    }
    client.release(destroyClient);
  }
}

/**
 * Issue a one-time action and supersede the user's prior pending action of
 * the same kind in one transaction. An advisory lock closes the small race
 * between two concurrent issuers before the partial unique index is checked.
 */
export async function issueAccountAction(input: {
  userId: number;
  action: AccountActionType;
  expiresAt: Date;
  organizationId?: number | null;
  createdByUserId?: number | null;
}, executor?: AccountActionExecutor): Promise<IssuedAccountAction> {
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new Error("Account action expiry must be in the future");
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashAccountActionToken(token);
  const run = async (tx: AccountActionExecutor): Promise<AccountActionRequest> => {
    // `hashtext` provides a stable signed int advisory-lock key while the
    // token itself remains entirely outside SQL/logging paths.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`account-action:${input.userId}:${input.action}`}))`);

    await tx
      .update(accountActionRequests)
      .set({ status: "expired", expiredAt: sql`now()` })
      .where(and(
        eq(accountActionRequests.userId, input.userId),
        eq(accountActionRequests.action, input.action),
        lte(accountActionRequests.expiresAt, sql`now()`),
        eq(accountActionRequests.status, "pending"),
      ));

    await tx
      .update(accountActionRequests)
      .set({ status: "superseded", supersededAt: sql`now()` })
      .where(and(
        eq(accountActionRequests.userId, input.userId),
        eq(accountActionRequests.action, input.action),
        eq(accountActionRequests.status, "pending"),
      ));

    const [created] = await tx
      .insert(accountActionRequests)
      .values({
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        action: input.action,
        tokenHash,
        expiresAt: input.expiresAt.toISOString(),
        status: "pending",
        deliveryStatus: "not_attempted",
      })
      .returning();
    return created;
  };

  const request = executor ? await run(executor) : await db.transaction(run);

  return { request, token };
}

/**
 * Find a request by hashing the supplied bearer token. This intentionally
 * returns lifecycle state so callers can distinguish an expired token from a
 * malformed/replayed one without ever comparing or storing raw token text.
 */
export async function getAccountActionByToken(token: string): Promise<AccountActionWithUser | undefined> {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const tokenHash = hashAccountActionToken(token);
  return db.transaction(async (tx) => {
    await tx
      .update(accountActionRequests)
      .set({ status: "expired", expiredAt: sql`now()` })
      .where(and(
        eq(accountActionRequests.tokenHash, tokenHash),
        eq(accountActionRequests.status, "pending"),
        lte(accountActionRequests.expiresAt, sql`now()`),
      ));

    const [row] = await tx
      .select({ request: accountActionRequests, user: users })
      .from(accountActionRequests)
      .innerJoin(users, eq(users.id, accountActionRequests.userId))
      .where(eq(accountActionRequests.tokenHash, tokenHash))
      .limit(1);
    return row;
  });
}

/**
 * Atomically consume a valid pending action and rotate the user's password.
 * The password mutation, forced-rotation clear, invalidation of other
 * credential actions, and invalidation of pending email changes all share one
 * transaction. A second caller racing the same token receives undefined.
 */
export async function consumeAccountActionAndSetPassword(input: {
  token: string;
  passwordHash: string;
  preferredLanguage?: string | null;
}): Promise<CompletedPasswordAction | undefined> {
  const tokenHash = hashAccountActionToken(input.token);
  const completed = await db.transaction(async (tx) => {
    await tx
      .update(accountActionRequests)
      .set({ status: "expired", expiredAt: sql`now()` })
      .where(and(
        eq(accountActionRequests.tokenHash, tokenHash),
        eq(accountActionRequests.status, "pending"),
        lte(accountActionRequests.expiresAt, sql`now()`),
      ));

    const [claimed] = await tx
      .update(accountActionRequests)
      .set({ status: "consumed", consumedAt: sql`now()` })
      .where(and(
        eq(accountActionRequests.tokenHash, tokenHash),
        eq(accountActionRequests.status, "pending"),
        gt(accountActionRequests.expiresAt, sql`now()`),
      ))
      .returning();

    if (!claimed) return undefined;

    const [updatedUser] = await tx
      .update(users)
      .set({
        password: input.passwordHash,
        mustChangePassword: false,
        failedPasswordChangeAttempts: 0,
        passwordChangeLockedUntil: null,
        ...(input.preferredLanguage !== undefined
          ? { preferredLanguage: input.preferredLanguage }
          : {}),
      })
      .where(eq(users.id, claimed.userId))
      .returning();

    if (!updatedUser) {
      throw new Error(`Account action user ${claimed.userId} no longer exists`);
    }

    await tx
      .update(accountActionRequests)
      .set({ status: "superseded", supersededAt: sql`now()` })
      .where(and(
        eq(accountActionRequests.userId, claimed.userId),
        eq(accountActionRequests.status, "pending"),
        ne(accountActionRequests.id, claimed.id),
      ));

    await tx
      .update(emailChangeRequests)
      .set({ consumedAt: sql`now()` })
      .where(and(
        eq(emailChangeRequests.userId, claimed.userId),
        isNull(emailChangeRequests.consumedAt),
      ));

    return { request: claimed, user: updatedUser };
  });

  if (completed) cacheInvalidate(`user:${completed.user.id}`);
  return completed;
}

/** Update delivery state without exposing or persisting the raw token. */
export async function updateAccountActionDeliveryStatus(
  requestId: number,
  deliveryStatus: AccountActionDeliveryStatus,
): Promise<AccountActionRequest | undefined> {
  const [updated] = await db
    .update(accountActionRequests)
    .set({
      deliveryStatus,
      deliveryAttemptedAt: sql`now()`,
      deliveredAt: deliveryStatus === "sent" ? sql`now()` : null,
      })
    .where(eq(accountActionRequests.id, requestId))
    .returning();
  return updated;
}

/**
 * Return whether a still-usable action was successfully delivered recently.
 * Callers use this while holding the per-user delivery lock so a rapid resend
 * cannot supersede a link that may still be in transit through the mail system.
 */
export async function hasRecentlyDeliveredPendingAccountAction(input: {
  userId: number;
  action: AccountActionType;
  deliveredAfter: Date;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: accountActionRequests.id })
    .from(accountActionRequests)
    .where(and(
      eq(accountActionRequests.userId, input.userId),
      eq(accountActionRequests.action, input.action),
      eq(accountActionRequests.status, "pending"),
      eq(accountActionRequests.deliveryStatus, "sent"),
      gt(accountActionRequests.expiresAt, sql`now()`),
      gte(accountActionRequests.deliveredAt, input.deliveredAfter.toISOString()),
    ))
    .limit(1);
  return row !== undefined;
}

/** Return the newest invitation state for each requested user, without token material. */
export async function getLatestAccountInvitationsForUsers(
  userIds: number[],
  organizationId: number,
): Promise<Map<number, AccountActionRequest>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.transaction(async (tx) => {
    const scope = and(
      inArray(accountActionRequests.userId, userIds),
      eq(accountActionRequests.action, "account_invite"),
      eq(accountActionRequests.organizationId, organizationId),
    );
    await tx
      .update(accountActionRequests)
      .set({ status: "expired", expiredAt: sql`now()` })
      .where(and(
        scope,
        eq(accountActionRequests.status, "pending"),
        lte(accountActionRequests.expiresAt, sql`now()`),
      ));
    return tx
      .select()
      .from(accountActionRequests)
      .where(scope)
      .orderBy(desc(accountActionRequests.createdAt), desc(accountActionRequests.id));
  });
  const latest = new Map<number, AccountActionRequest>();
  for (const row of rows) {
    if (!latest.has(row.userId)) latest.set(row.userId, row);
  }
  return latest;
}

/** Revoke a still-pending action without making it look consumed. */
export async function revokeAccountAction(
  requestId: number,
): Promise<AccountActionRequest | undefined> {
  const [updated] = await db
    .update(accountActionRequests)
    .set({ status: "revoked", revokedAt: sql`now()` })
    .where(and(
      eq(accountActionRequests.id, requestId),
      eq(accountActionRequests.status, "pending"),
    ))
    .returning();
  return updated;
}

// Kept as a named type-level reference for storage consumers that need to
// constrain status updates without importing the table implementation.
export type { AccountActionStatus };
