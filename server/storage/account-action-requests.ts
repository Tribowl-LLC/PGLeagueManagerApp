import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { db, pool } from "../db.js";
import { env } from "../config.js";
import * as schema from "@shared/schema";
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

export type AccountActionDatabase = NodePgDatabase<typeof schema>;
export type AccountActionExecutor =
  | AccountActionDatabase
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

const TOKEN_BINDING_SEPARATOR = ".";
const MAX_CONCURRENT_DELIVERY_LOCKS = 5;
const MAX_DELIVERY_LOCK_WAITERS = 100;
const DELIVERY_LOCK_WAIT_TIMEOUT_MS = 5_000;
let activeDeliveryLocks = 0;
const deliveryLockWaiters: Array<() => void> = [];

function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailBinding(randomToken: string, email: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(randomToken, "utf8")
    .update("\0", "utf8")
    .update(normalizeRecipientEmail(email), "utf8")
    .digest("hex");
}

function passwordResetTokenMatchesEmail(token: string, email: string): boolean {
  const separator = token.indexOf(TOKEN_BINDING_SEPARATOR);
  // Tokens issued before recipient binding was introduced remain usable until
  // their existing one-hour expiry; every newly issued reset token is bound.
  if (separator < 0) return true;
  const randomToken = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  const expected = emailBinding(randomToken, email);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied, "utf8"), Buffer.from(expected, "utf8"));
}

async function acquireDeliveryLockSlot(): Promise<() => void> {
  if (activeDeliveryLocks >= MAX_CONCURRENT_DELIVERY_LOCKS) {
    if (deliveryLockWaiters.length >= MAX_DELIVERY_LOCK_WAITERS) {
      throw new Error("Account-action delivery capacity is temporarily unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout;
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      timeout = setTimeout(() => {
        const index = deliveryLockWaiters.indexOf(waiter);
        if (index >= 0) deliveryLockWaiters.splice(index, 1);
        reject(new Error("Timed out waiting for account-action delivery capacity"));
      }, DELIVERY_LOCK_WAIT_TIMEOUT_MS);
      deliveryLockWaiters.push(waiter);
    });
  }
  activeDeliveryLocks += 1;
  return () => {
    activeDeliveryLocks -= 1;
    deliveryLockWaiters.shift()?.();
  };
}

/** Serialize all credential mutations for one account, including no-row cases. */
export async function lockAccountCredential(
  executor: AccountActionExecutor,
  userId: number,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`account-credential:${userId}`}))`);
}

/**
 * Serialize issuance and delivery for a user's action type. The transaction
 * lock in `issueAccountAction` protects database state; this session lock is
 * deliberately held until delivery status is recorded so an older email can
 * never be sent after a newer resend.
 */
export async function withAccountActionDeliveryLock<T>(
  userId: number,
  action: AccountActionType,
  operation: (executor: AccountActionDatabase) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("A positive user ID is required for account-action delivery");
  }
  const releaseSlot = await acquireDeliveryLockSlot();
  let client: PoolClient | undefined;
  const lockKey = `account-action-delivery:${userId}:${action}`;
  let destroyClient = false;
  try {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    // Account-action state work in the callback uses this executor. It is
    // bound to the same checked-out client that owns the session advisory
    // lock. A small bounded gate above leaves capacity for template lookups
    // and unrelated application traffic while a mail provider is slow.
    const executor = drizzle(client, { schema });
    return await operation(executor);
  } finally {
    try {
      await client?.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    } catch {
      // A session-level lock must never return to the pool if unlock fails.
      destroyClient = true;
    }
    client?.release(destroyClient);
    releaseSlot();
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
  recipientEmail?: string;
}, executor?: AccountActionExecutor): Promise<IssuedAccountAction> {
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new Error("Account action expiry must be in the future");
  }

  const randomToken = randomBytes(32).toString("hex");
  let token = randomToken;
  if (input.action === "password_reset") {
    const recipientEmail = input.recipientEmail;
    if (!recipientEmail) {
      throw new Error("A recipient email is required for password-reset actions");
    }
    token = `${randomToken}${TOKEN_BINDING_SEPARATOR}${emailBinding(randomToken, recipientEmail)}`;
  }
  const tokenHash = hashAccountActionToken(token);
  const run = async (tx: AccountActionExecutor): Promise<AccountActionRequest> => {
    if (input.action === "password_reset") {
      await lockAccountCredential(tx, input.userId);
      const [currentUser] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      const recipientEmail = input.recipientEmail;
      if (
        !currentUser
        || !recipientEmail
        || normalizeRecipientEmail(currentUser.email) !== normalizeRecipientEmail(recipientEmail)
      ) {
        throw new Error("Password-reset recipient changed before issuance");
      }
    } else {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`account-action:${input.userId}:${input.action}`}))`);
    }

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

  const request = executor
    ? "transaction" in executor
      ? await executor.transaction(run)
      : await run(executor)
    : await db.transaction(run);

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
    if (
      row?.request.action === "password_reset"
      && row.request.status === "pending"
      && !passwordResetTokenMatchesEmail(token, row.user.email)
    ) {
      const [revoked] = await tx
        .update(accountActionRequests)
        .set({ status: "revoked", revokedAt: sql`now()` })
        .where(and(
          eq(accountActionRequests.id, row.request.id),
          eq(accountActionRequests.status, "pending"),
        ))
        .returning();
      if (revoked) row.request = revoked;
    }
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
    const [candidate] = await tx
      .select({ userId: accountActionRequests.userId })
      .from(accountActionRequests)
      .where(eq(accountActionRequests.tokenHash, tokenHash))
      .limit(1);
    if (!candidate) return undefined;

    await lockAccountCredential(tx, candidate.userId);

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

    const [currentUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, claimed.userId))
      .limit(1)
      .for("update");

    if (!currentUser) {
      throw new Error(`Account action user ${claimed.userId} no longer exists`);
    }

    if (
      claimed.action === "password_reset"
      && !passwordResetTokenMatchesEmail(input.token, currentUser.email)
    ) {
      await tx
        .update(accountActionRequests)
        .set({
          status: "revoked",
          consumedAt: null,
          revokedAt: sql`now()`,
        })
        .where(eq(accountActionRequests.id, claimed.id));
      return undefined;
    }

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
  executor: AccountActionExecutor = db,
): Promise<AccountActionRequest | undefined> {
  const [updated] = await executor
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
}, executor: AccountActionExecutor = db): Promise<boolean> {
  const [row] = await executor
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

/** Revoke every pending action of the requested kinds for one user. */
export async function revokePendingAccountActionsForUser(
  userId: number,
  actions: AccountActionType[],
  executor: AccountActionExecutor = db,
): Promise<number> {
  if (actions.length === 0) return 0;
  const rows = await executor
    .update(accountActionRequests)
    .set({ status: "revoked", revokedAt: sql`now()` })
    .where(and(
      eq(accountActionRequests.userId, userId),
      inArray(accountActionRequests.action, actions),
      eq(accountActionRequests.status, "pending"),
    ))
    .returning({ id: accountActionRequests.id });
  return rows.length;
}

// Kept as a named type-level reference for storage consumers that need to
// constrain status updates without importing the table implementation.
export type { AccountActionStatus };
