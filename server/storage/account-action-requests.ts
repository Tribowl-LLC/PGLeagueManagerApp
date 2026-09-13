import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { db, pool } from "../db.js";
import { env } from "../config.js";
import * as schema from "@shared/schema";
import {
  accountActionRequests,
  accountActionDeliveryJobs,
  bowlers,
  emailChangeRequests,
  users,
  type AccountActionDeliveryStatus,
  type AccountActionRequest,
  type AccountActionStatus,
  type AccountActionType,
  type User,
} from "@shared/schema";
import { cacheInvalidate } from "../utils/cache";
import {
  linkUserToBowler,
  isIdentityLinkError,
} from "../services/identity-link.js";

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

/** Maximum number of still-usable recovery links held for one account. */
export const PASSWORD_RESET_PENDING_CAP = 3;
/** Suppress rapid repeat sends while the previous link is likely in flight. */
export const PASSWORD_RESET_DELIVERY_SUPPRESSION_MS = 5 * 60 * 1000;
/** Registration setup links use the same bounded, append-preserving policy. */
export const ACCOUNT_REGISTRATION_PENDING_CAP = 3;
export const ACCOUNT_REGISTRATION_DELIVERY_SUPPRESSION_MS = 5 * 60 * 1000;

export type PasswordResetIssuanceSuppressionReason =
  | "user_missing"
  | "recipient_changed"
  | "stale_credential"
  | "at_capacity"
  | "recently_delivered";

export type PasswordResetIssuanceResult =
  | (IssuedAccountAction & { kind: "issued" })
  | { kind: "suppressed"; reason: PasswordResetIssuanceSuppressionReason };

export type AccountRegistrationIssuanceSuppressionReason =
  | "user_missing"
  | "recipient_changed"
  | "stale_credential"
  | "account_not_pending"
  | "at_capacity"
  | "recently_delivered";

export type AccountRegistrationIssuanceResult =
  | (IssuedAccountAction & { kind: "issued" })
  | { kind: "suppressed"; reason: AccountRegistrationIssuanceSuppressionReason };

export interface PasswordResetPendingState {
  pendingCount: number;
  recentlyDelivered: boolean;
}

export interface AccountActionPendingState {
  pendingCount: number;
  recentlyDelivered: boolean;
}

export class PasswordResetCapacityError extends Error {
  readonly code = "PASSWORD_RESET_CAPACITY" as const;

  constructor() {
    super("Password-reset pending capacity reached");
    this.name = "PasswordResetCapacityError";
  }
}

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
  /** Expected generation for a queued recovery dispatch, when available. */
  expectedCredentialGeneration?: number;
  /** Durable delivery job owning this particular recovery attempt. */
  deliveryJobId?: number | null;
  /** Recovery dispatch retries preserve every still-usable recovery link. */
  preservePending?: boolean;
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
    let credentialGeneration = 0;
    if (input.action === "password_reset" || input.action === "account_registration") {
      await lockAccountCredential(tx, input.userId);
      const [currentUser] = await tx
        .select({
          email: users.email,
          role: users.role,
          organizationId: users.organizationId,
          bowlerId: users.bowlerId,
          credentialGeneration: users.credentialGeneration,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      const recipientEmail = input.recipientEmail;
      if (!currentUser) {
        throw new Error(input.action === "password_reset"
          ? "Password-reset user no longer exists"
          : "account_registration user no longer exists");
      }
      if (!recipientEmail || normalizeRecipientEmail(currentUser.email) !== normalizeRecipientEmail(recipientEmail)) {
        throw new Error(input.action === "password_reset"
          ? "Password-reset recipient changed before issuance"
          : "account_registration recipient changed before issuance");
      }
      credentialGeneration = currentUser.credentialGeneration;
      if (
        input.expectedCredentialGeneration !== undefined
        && credentialGeneration !== input.expectedCredentialGeneration
      ) {
        throw new Error(input.action === "password_reset"
          ? "Password-reset credential generation changed before issuance"
          : "account_registration credential generation changed before issuance");
      }
      if (input.action === "account_registration") {
        if (
          currentUser.role !== "user"
          || currentUser.organizationId !== (input.organizationId ?? null)
        ) {
          throw new Error("Registration account is no longer pending");
        }
        const pendingState = await getAccountActionPendingState({
          userId: input.userId,
          action: "account_registration",
        }, tx);
        if (pendingState.pendingCount >= ACCOUNT_REGISTRATION_PENDING_CAP) {
          throw new Error("Registration setup-link capacity reached");
        }
      } else {
        // The cap is an invariant of every password-reset issuance path. The
        // preservePending flag only controls supersession behavior for legacy
        // callers; it must never allow a fourth usable recovery link.
        const pendingState = await getPasswordResetPendingState({ userId: input.userId }, tx);
        if (pendingState.pendingCount >= PASSWORD_RESET_PENDING_CAP) {
          throw new PasswordResetCapacityError();
        }
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

    // Password recovery is append-preserving by default. The old
    // supersession behavior remains for invitations only, and callers may
    // still pass preservePending explicitly for clarity.
    if (input.action !== "password_reset" && !input.preservePending) {
      await tx
        .update(accountActionRequests)
        .set({ status: "superseded", supersededAt: sql`now()` })
        .where(and(
          eq(accountActionRequests.userId, input.userId),
          eq(accountActionRequests.action, input.action),
          eq(accountActionRequests.status, "pending"),
        ));
    }

    const [created] = await tx
      .insert(accountActionRequests)
      .values({
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        deliveryJobId: input.deliveryJobId ?? null,
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
 * Read and lazily expire the recovery rows used by the three-link policy.
 * Callers that make a decision from this result must hold
 * `lockAccountCredential` on the same transaction executor.
 */
export async function getPasswordResetPendingState(input: {
  userId: number;
  deliveredAfter?: Date;
}, executor: AccountActionExecutor = db): Promise<PasswordResetPendingState> {
  return getAccountActionPendingState({
    userId: input.userId,
    action: "password_reset",
    deliveredAfter: input.deliveredAfter,
  }, executor);
}

/** Read and lazily expire append-preserving action rows for one action kind. */
export async function getAccountActionPendingState(input: {
  userId: number;
  action: AccountActionType;
  deliveredAfter?: Date;
}, executor: AccountActionExecutor = db): Promise<AccountActionPendingState> {
  await executor
    .update(accountActionRequests)
    .set({ status: "expired", expiredAt: sql`now()` })
    .where(and(
      eq(accountActionRequests.userId, input.userId),
      eq(accountActionRequests.action, input.action),
      eq(accountActionRequests.status, "pending"),
      lte(accountActionRequests.expiresAt, sql`now()`),
    ));

  const pending = await executor.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM account_action_requests
    WHERE user_id = ${input.userId}
      AND action = ${input.action}
      AND status = 'pending'
      AND expires_at > now()
  `);
  const pendingCount = Number(pending.rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
    throw new Error(`Invalid pending ${input.action} count`);
  }

  const deliveredAfter = input.deliveredAfter
    ?? new Date(Date.now() - (
      input.action === "account_registration"
        ? ACCOUNT_REGISTRATION_DELIVERY_SUPPRESSION_MS
        : PASSWORD_RESET_DELIVERY_SUPPRESSION_MS
    ));
  const [recentDelivery] = await executor
    .select({ id: accountActionRequests.id })
    .from(accountActionRequests)
    .where(and(
      eq(accountActionRequests.userId, input.userId),
      eq(accountActionRequests.action, input.action),
      eq(accountActionRequests.status, "pending"),
      eq(accountActionRequests.deliveryStatus, "sent"),
      gt(accountActionRequests.expiresAt, sql`now()`),
      gte(accountActionRequests.deliveredAt, deliveredAfter.toISOString()),
    ))
    .limit(1);

  return { pendingCount, recentlyDelivered: recentDelivery !== undefined };
}

/**
 * Issue a recovery link only after the per-account capacity and delivery
 * suppression checks have run inside the same transaction-scoped credential
 * lock. This is the only issuer the durable delivery worker should call.
 *
 * A raw token is created only after these checks pass. It is returned to the
 * caller for immediate provider dispatch and is never part of the durable job
 * or action row.
 */
export async function tryIssuePasswordReset(input: {
  userId: number;
  expiresAt: Date;
  organizationId?: number | null;
  createdByUserId?: number | null;
  recipientEmail: string;
  deliveryJobId?: number | null;
  expectedCredentialGeneration?: number;
  deliveredAfter?: Date;
}, executor?: AccountActionExecutor): Promise<PasswordResetIssuanceResult> {
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new Error("Password-reset expiry must be in the future");
  }

  const run = async (tx: AccountActionExecutor): Promise<PasswordResetIssuanceResult> => {
    await lockAccountCredential(tx, input.userId);

    const [currentUser] = await tx
      .select({ email: users.email, credentialGeneration: users.credentialGeneration })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!currentUser) return { kind: "suppressed", reason: "user_missing" };
    if (normalizeRecipientEmail(currentUser.email) !== normalizeRecipientEmail(input.recipientEmail)) {
      return { kind: "suppressed", reason: "recipient_changed" };
    }
    if (
      input.expectedCredentialGeneration !== undefined
      && currentUser.credentialGeneration !== input.expectedCredentialGeneration
    ) {
      return { kind: "suppressed", reason: "stale_credential" };
    }

    const pendingState = await getPasswordResetPendingState({ userId: input.userId }, tx);
    if (pendingState.pendingCount >= PASSWORD_RESET_PENDING_CAP) {
      return { kind: "suppressed", reason: "at_capacity" };
    }
    if (pendingState.recentlyDelivered) {
      return { kind: "suppressed", reason: "recently_delivered" };
    }

    const issued = await issueAccountAction({
      userId: input.userId,
      action: "password_reset",
      expiresAt: input.expiresAt,
      organizationId: input.organizationId,
      createdByUserId: input.createdByUserId,
      recipientEmail: input.recipientEmail,
      deliveryJobId: input.deliveryJobId,
      expectedCredentialGeneration: input.expectedCredentialGeneration,
      preservePending: true,
    }, tx);
    return { kind: "issued", ...issued };
  };

  if (executor) {
    const result = "transaction" in executor
      ? await executor.transaction(run)
      : await run(executor);
    return result;
  }
  return db.transaction(run);
}

/** Issue a registration setup action without evicting an older usable link. */
export async function tryIssueAccountRegistration(input: {
  userId: number;
  expiresAt: Date;
  organizationId: number;
  recipientEmail: string;
  deliveryJobId?: number | null;
  expectedCredentialGeneration?: number;
  deliveredAfter?: Date;
}, executor?: AccountActionExecutor): Promise<AccountRegistrationIssuanceResult> {
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new Error("Account-registration expiry must be in the future");
  }

  const run = async (tx: AccountActionExecutor): Promise<AccountRegistrationIssuanceResult> => {
    await lockAccountCredential(tx, input.userId);
    const [currentUser] = await tx
      .select({
        email: users.email,
        role: users.role,
        organizationId: users.organizationId,
        bowlerId: users.bowlerId,
        credentialGeneration: users.credentialGeneration,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!currentUser) return { kind: "suppressed", reason: "user_missing" };
    if (
      currentUser.role !== "user"
      || currentUser.organizationId !== input.organizationId
    ) return { kind: "suppressed", reason: "account_not_pending" };
    if (normalizeRecipientEmail(currentUser.email) !== normalizeRecipientEmail(input.recipientEmail)) {
      return { kind: "suppressed", reason: "recipient_changed" };
    }
    if (
      input.expectedCredentialGeneration !== undefined
      && currentUser.credentialGeneration !== input.expectedCredentialGeneration
    ) return { kind: "suppressed", reason: "stale_credential" };

    const pendingState = await getAccountActionPendingState({
      userId: input.userId,
      action: "account_registration",
      deliveredAfter: input.deliveredAfter,
    }, tx);
    if (pendingState.pendingCount >= ACCOUNT_REGISTRATION_PENDING_CAP) {
      return { kind: "suppressed", reason: "at_capacity" };
    }
    if (pendingState.recentlyDelivered) {
      return { kind: "suppressed", reason: "recently_delivered" };
    }

    const issued = await issueAccountAction({
      userId: input.userId,
      action: "account_registration",
      expiresAt: input.expiresAt,
      organizationId: input.organizationId,
      recipientEmail: input.recipientEmail,
      deliveryJobId: input.deliveryJobId,
      expectedCredentialGeneration: input.expectedCredentialGeneration,
      preservePending: true,
    }, tx);
    return { kind: "issued", ...issued };
  };

  if (executor) {
    return "transaction" in executor
      ? executor.transaction(run)
      : run(executor);
  }
  return db.transaction(run);
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
      .select({
        userId: accountActionRequests.userId,
        action: accountActionRequests.action,
        deliveryJobId: accountActionRequests.deliveryJobId,
        organizationId: accountActionRequests.organizationId,
      })
      .from(accountActionRequests)
      .where(eq(accountActionRequests.tokenHash, tokenHash))
      .limit(1);
    if (!candidate) return undefined;

    await lockAccountCredential(tx, candidate.userId);

    // Lock the authoritative user row before touching the action row. This
    // keeps the lock order user -> action consistent with credential update
    // triggers and prevents a concurrent password/email change from racing
    // the claim below.
    const [currentUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, candidate.userId))
      .limit(1)
      .for("update");
    if (!currentUser) {
      throw new Error(`Account action user ${candidate.userId} no longer exists`);
    }

    let registrationOrganizationId: number | null = null;
    if (candidate.action === "account_registration") {
      // A registration action is valid only when it still has its original
      // durable registration intent and the user has not been moved,
      // elevated, or otherwise changed since the email was issued. An admin
      // may already have linked the account; that link is preserved below.
      const [origin] = await tx
        .select({
          userId: accountActionDeliveryJobs.userId,
          organizationId: accountActionDeliveryJobs.organizationId,
          credentialGeneration: accountActionDeliveryJobs.credentialGeneration,
          action: accountActionDeliveryJobs.action,
        })
        .from(accountActionDeliveryJobs)
        .where(and(
          eq(accountActionDeliveryJobs.id, candidate.deliveryJobId ?? 0),
          eq(accountActionDeliveryJobs.userId, currentUser.id),
          eq(accountActionDeliveryJobs.action, "account_registration"),
        ))
        .limit(1);
      if (
        !origin
        || origin.organizationId === null
        || origin.action !== "account_registration"
        || currentUser.role !== "user"
        || currentUser.organizationId !== origin.organizationId
        || currentUser.credentialGeneration !== origin.credentialGeneration
        || (candidate.organizationId ?? null) !== origin.organizationId
      ) {
        return undefined;
      }
      registrationOrganizationId = currentUser.organizationId;
      if (registrationOrganizationId === null) {
        throw new Error("Registration account lost its organization context");
      }
    }

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

    let completedUser = updatedUser;
    if (claimed.action === "account_registration" && currentUser.bowlerId === null) {
      // Email ownership is already proven by the bearer token. Link only an
      // exactly-one roster profile in this same organization and transaction.
      // Include claimed rows in the bounded candidate set: the identity
      // service decides the race/claim outcome, while this flow never scans
      // or locks an unbounded set of duplicate profiles.
      if (registrationOrganizationId === null) {
        throw new Error("Registration account lost its organization context");
      }
      const candidates = await tx
        .select({ id: bowlers.id })
        .from(bowlers)
        .where(and(
          eq(bowlers.organizationId, registrationOrganizationId),
          sql`lower(btrim(${bowlers.email})) = lower(btrim(${currentUser.email}))`,
        ))
        .limit(2);
      if (candidates.length === 1) {
        try {
          const linked = await linkUserToBowler({
            organizationId: registrationOrganizationId,
            userId: currentUser.id,
            bowlerId: candidates[0].id,
            actorUserId: currentUser.id,
            source: "auth.set-password.registration",
            reason: "email_match_auto_link",
            eventType: "link",
            requireEmailMatch: true,
          }, tx);
          completedUser = linked.user;
        } catch (linkError) {
          // A concurrent administrator assignment or another account claim
          // is an expected unlinked outcome. Any other failure rolls back the
          // password and action claim so the user can retry safely.
          if (!isIdentityLinkError(linkError)
            || !["BOWLER_TAKEN", "ALREADY_LINKED", "EMAIL_MISMATCH"].includes(linkError.code)) {
            throw linkError;
          }
        }
      }
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

    return { request: claimed, user: completedUser };
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
