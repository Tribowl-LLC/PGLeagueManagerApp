import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { db } from "../db.js";
import type { AccountActionExecutor } from "./account-action-requests.js";
import { enqueuePasswordResetDelivery } from "./account-action-delivery-jobs.js";
import {
  PROFILE_CLAIM_NOTIFICATION_LEASE_MS,
  PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS,
  PROFILE_CLAIM_NOTIFICATION_MAX_RETRY_DELAY_MS,
  PROFILE_CLAIM_NOTIFICATION_RETENTION_MS,
  identitySecurityHolds,
  profileClaimNotifications,
  profileClaimReportTokens,
  type IdentitySecurityHold,
  type ProfileClaimNotification,
} from "@shared/schema/profile-claim-notifications";
import { emailChangeRequests } from "@shared/schema/email-change-requests";
import { identityLinkEvents } from "@shared/schema/identity-link-events";
import { users } from "@shared/schema/users";
import { normalizeAccountEmail } from "./users.js";
import { lockAccountCredential } from "./account-action-requests.js";
import { env } from "../config.js";
import { unlinkUserFromBowler } from "../services/identity-link.js";

export type ProfileClaimNotificationExecutor = AccountActionExecutor;
export type ProfileClaimNotificationEnqueueResult =
  | { kind: "enqueued"; notification: ProfileClaimNotification }
  | { kind: "existing"; notification: ProfileClaimNotification };

const ACTIVE_STATUSES = ["pending", "processing", "retry_scheduled"] as const;

/**
 * Derive the report capability from the immutable identity-link event ID and
 * the server secret. The database stores only its SHA-256 hash; the delivery
 * worker can reconstruct the one-time capability without persisting a bearer
 * token or an encrypted copy of it.
 */
export function profileClaimReportTokenForEvent(identityLinkEventId: number): string {
  assertPositive(identityLinkEventId, "identity link event ID");
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`profile-claim-report:${identityLinkEventId}`, "utf8")
    .digest("hex");
}

export function profileClaimReportTokenHashForEvent(identityLinkEventId: number): string {
  return createHash("sha256")
    .update(profileClaimReportTokenForEvent(identityLinkEventId), "utf8")
    .digest("hex");
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
}

/**
 * Queue the claim notice and its one-time report capability in the same
 * transaction as the identity link. The raw token is returned only to the
 * caller-owned transaction; durable storage keeps only the hash. The delivery
 * worker derives the capability from the immutable event ID and server secret.
 */
export async function queueProfileClaimNotification(input: {
  identityLinkEventId: number;
  userId: number;
  bowlerId: number;
  organizationId: number;
  recipientEmail: string;
  recipientSource: "roster" | "account_fallback";
  recipientName: string;
  bowlerName: string;
  reportTokenHash: string;
  reportTokenExpiresAt: Date;
}, executor?: ProfileClaimNotificationExecutor): Promise<ProfileClaimNotificationEnqueueResult> {
  assertPositive(input.identityLinkEventId, "identity link event ID");
  assertPositive(input.userId, "user ID");
  assertPositive(input.bowlerId, "bowler ID");
  assertPositive(input.organizationId, "organization ID");
  if (!input.recipientEmail.trim() || !input.reportTokenHash) {
    throw new Error("Profile claim notification requires a recipient and report token");
  }
  if (input.reportTokenHash !== profileClaimReportTokenHashForEvent(input.identityLinkEventId)) {
    throw new Error("Profile claim report token is not bound to the identity-link event");
  }
  if (input.reportTokenExpiresAt.getTime() <= Date.now()) {
    throw new Error("Profile claim report token must not be expired");
  }

  const run = async (tx: ProfileClaimNotificationExecutor): Promise<ProfileClaimNotificationEnqueueResult> => {
    const [existing] = await tx
      .select()
      .from(profileClaimNotifications)
      .where(eq(profileClaimNotifications.identityLinkEventId, input.identityLinkEventId))
      .limit(1);
    if (existing) return { kind: "existing", notification: existing };

    const [notification] = await tx
      .insert(profileClaimNotifications)
      .values({
        identityLinkEventId: input.identityLinkEventId,
        userId: input.userId,
        bowlerId: input.bowlerId,
        organizationId: input.organizationId,
        recipientEmail: input.recipientEmail.trim().toLowerCase(),
        recipientSource: input.recipientSource,
        recipientName: input.recipientName,
        bowlerName: input.bowlerName,
        reportTokenHash: input.reportTokenHash,
        reportTokenExpiresAt: input.reportTokenExpiresAt.toISOString(),
      } as never)
      .onConflictDoNothing({ target: profileClaimNotifications.identityLinkEventId })
      .returning();
    if (!notification) {
      const [raced] = await tx
        .select()
        .from(profileClaimNotifications)
        .where(eq(profileClaimNotifications.identityLinkEventId, input.identityLinkEventId))
        .limit(1);
      if (!raced) throw new Error("Profile claim notification was not created");
      return { kind: "existing", notification: raced };
    }

    await tx.insert(profileClaimReportTokens).values({
      notificationId: notification.id,
      tokenHash: input.reportTokenHash,
      expiresAt: input.reportTokenExpiresAt.toISOString(),
    });
    return { kind: "enqueued", notification };
  };

  if (executor) return run(executor);
  return db.transaction(run);
}

export interface ClaimedProfileClaimNotification {
  notification: ProfileClaimNotification;
  leaseToken: string;
}

export async function claimNextProfileClaimNotification(options: { workerId?: string } = {}): Promise<ClaimedProfileClaimNotification | undefined> {
  const workerId = options.workerId ?? `profile-claim-worker:${randomUUID()}`;
  if (workerId.length < 1 || workerId.length > 255) throw new Error("Invalid profile-claim worker ID");
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: number }>(sql`
      SELECT id
      FROM profile_claim_notifications
      WHERE (
        (status IN ('pending', 'retry_scheduled') AND next_attempt_at <= now())
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
        AND attempt_count < ${PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS}
        AND report_token_expires_at > now()
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = candidates.rows[0]?.id;
    if (!id) return undefined;
    const leaseToken = randomUUID();
    const [notification] = await tx
      .update(profileClaimNotifications)
      .set({
        status: "processing",
        attemptCount: sql`${profileClaimNotifications.attemptCount} + 1`,
        lastAttemptAt: sql`now()`,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: sql`now() + (${Math.ceil(PROFILE_CLAIM_NOTIFICATION_LEASE_MS / 1000)} || ' seconds')::interval`,
        updatedAt: sql`now()`,
      })
      .where(eq(profileClaimNotifications.id, id))
      .returning();
    return notification ? { notification, leaseToken } : undefined;
  });
}

export type ProfileClaimNotificationFinalization =
  | { status: "succeeded"; providerMessageId?: string | null }
  | { status: "retry_scheduled"; errorCode: string; retryAfterMs: number }
  | { status: "failed"; errorCode: string }
  | { status: "suppressed"; reason: string };

export async function finalizeProfileClaimNotification(input: {
  notificationId: number;
  leaseToken: string;
  outcome: ProfileClaimNotificationFinalization;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({
        id: profileClaimNotifications.id,
        attemptCount: profileClaimNotifications.attemptCount,
        expiresAt: profileClaimNotifications.reportTokenExpiresAt,
      })
      .from(profileClaimNotifications)
      .where(and(
        eq(profileClaimNotifications.id, input.notificationId),
        eq(profileClaimNotifications.status, "processing"),
        eq(profileClaimNotifications.leaseToken, input.leaseToken),
      ))
      .limit(1)
      .for("update");
    if (!claimed) return false;
    const common = {
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    } as const;
    if (input.outcome.status === "succeeded") {
      const [row] = await tx.update(profileClaimNotifications).set({
        ...common,
        status: "succeeded",
        providerMessageId: input.outcome.providerMessageId ?? null,
        completedAt: sql`now()`,
      }).where(and(
        eq(profileClaimNotifications.id, input.notificationId),
        eq(profileClaimNotifications.status, "processing"),
        eq(profileClaimNotifications.leaseToken, input.leaseToken),
      )).returning({ id: profileClaimNotifications.id });
      return Boolean(row);
    }
    if (input.outcome.status === "retry_scheduled") {
      const retryAllowed = claimed.attemptCount < PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS
        && Date.parse(claimed.expiresAt) > Date.now();
      if (retryAllowed) {
        const retryAfterMs = Math.min(
          Math.max(0, input.outcome.retryAfterMs),
          PROFILE_CLAIM_NOTIFICATION_MAX_RETRY_DELAY_MS,
        );
        const [row] = await tx.update(profileClaimNotifications).set({
          ...common,
          status: "retry_scheduled",
          lastErrorCode: input.outcome.errorCode,
          nextAttemptAt: sql`now() + (${Math.ceil(retryAfterMs / 1000)} || ' seconds')::interval`,
        }).where(and(
          eq(profileClaimNotifications.id, input.notificationId),
          eq(profileClaimNotifications.status, "processing"),
          eq(profileClaimNotifications.leaseToken, input.leaseToken),
        )).returning({ id: profileClaimNotifications.id });
        return Boolean(row);
      }
    }
    const status = input.outcome.status === "suppressed" ? "suppressed" : "failed";
    const [row] = await tx.update(profileClaimNotifications).set({
      ...common,
      status,
      lastErrorCode: input.outcome.status === "suppressed"
        ? input.outcome.reason
        : input.outcome.errorCode,
      completedAt: sql`now()`,
    }).where(and(
      eq(profileClaimNotifications.id, input.notificationId),
      eq(profileClaimNotifications.status, "processing"),
      eq(profileClaimNotifications.leaseToken, input.leaseToken),
    )).returning({ id: profileClaimNotifications.id });
    return Boolean(row);
  });
}

export async function recoverProfileClaimNotifications(): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx.update(profileClaimNotifications).set({
      status: "failed",
      lastErrorCode: "intent_expired",
      completedAt: sql`now()`,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    }).where(and(
      inArray(profileClaimNotifications.status, [...ACTIVE_STATUSES]),
      lte(profileClaimNotifications.reportTokenExpiresAt, sql`now()`),
      sql`(${profileClaimNotifications.status} <> 'processing' OR ${profileClaimNotifications.leaseExpiresAt} <= now())`,
    )).returning({ id: profileClaimNotifications.id });
    const exhausted = await tx.update(profileClaimNotifications).set({
      status: "failed",
      lastErrorCode: "max_attempts_exhausted",
      completedAt: sql`now()`,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    }).where(and(
      inArray(profileClaimNotifications.status, [...ACTIVE_STATUSES]),
      sql`${profileClaimNotifications.attemptCount} >= ${PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS}`,
      sql`(${profileClaimNotifications.status} <> 'processing' OR ${profileClaimNotifications.leaseExpiresAt} <= now())`,
    )).returning({ id: profileClaimNotifications.id });
    await tx.execute(sql`
      DELETE FROM profile_claim_notifications
      WHERE id IN (
        SELECT id FROM profile_claim_notifications
        WHERE status IN ('succeeded', 'failed', 'suppressed')
          AND completed_at <= now() - (${Math.ceil(PROFILE_CLAIM_NOTIFICATION_RETENTION_MS / 1000)} || ' seconds')::interval
          -- A report creates an immutable audit hold whose foreign keys are
          -- deliberately RESTRICT. Leave the whole notification/token pair
          -- in place indefinitely so retention cannot abort on held evidence.
          AND NOT EXISTS (
            SELECT 1
            FROM identity_security_holds
            WHERE identity_security_holds.notification_id = profile_claim_notifications.id
          )
        ORDER BY completed_at ASC, id ASC LIMIT 500
      )
    `);
    return expired.length + exhausted.length;
  });
}

async function isCurrentProfileClaimNotificationWithExecutor(
  executor: ProfileClaimNotificationExecutor,
  notification: Pick<ProfileClaimNotification, "identityLinkEventId" | "userId" | "bowlerId" | "organizationId">,
): Promise<boolean> {
  if (!notification.userId || !notification.bowlerId) return false;
  const [latestLinkEvent] = await executor
    .select({
      id: identityLinkEvents.id,
      eventType: identityLinkEvents.eventType,
      newBowlerId: identityLinkEvents.newBowlerId,
      organizationId: identityLinkEvents.organizationId,
    })
    .from(identityLinkEvents)
    .where(eq(identityLinkEvents.subjectUserId, notification.userId))
    .orderBy(desc(identityLinkEvents.createdAt), desc(identityLinkEvents.id))
    .limit(1);
  return Boolean(
    latestLinkEvent
      && latestLinkEvent.id === notification.identityLinkEventId
      && ["link", "admin_assignment"].includes(latestLinkEvent.eventType)
      && latestLinkEvent.newBowlerId === notification.bowlerId
      && latestLinkEvent.organizationId === notification.organizationId,
  );
}

/** Return true only while this notification still describes the latest link. */
export async function isCurrentProfileClaimNotification(
  notification: Pick<ProfileClaimNotification, "identityLinkEventId" | "userId" | "bowlerId" | "organizationId">,
): Promise<boolean> {
  return isCurrentProfileClaimNotificationWithExecutor(db, notification);
}

export async function getProfileClaimNotification(id: number): Promise<ProfileClaimNotification | undefined> {
  const [row] = await db.select().from(profileClaimNotifications)
    .where(eq(profileClaimNotifications.id, id)).limit(1);
  return row;
}

/**
 * Account-ready and profile-claim delivery are separate durable intents, but
 * they should collapse into one message when both would target the same
 * mailbox.  The profile-claim worker owns the combined message because it
 * carries the immutable report capability; the account-ready worker suppresses
 * its duplicate after observing this predicate.
 */
export async function shouldCombineProfileClaimWithAccountReady(
  input: { identityLinkEventId: number; accountReadyRecipientEmail: string | null | undefined },
): Promise<boolean> {
  // Compare the immutable roster snapshot with the account-ready recipient.
  // The old implementation compared the current account email with itself
  // when called by the account-ready worker, suppressing delivery even when
  // the two notices belonged in different mailboxes.
  const [claimNotification] = await db.select({
    recipientEmail: profileClaimNotifications.recipientEmail,
    userId: profileClaimNotifications.userId,
    status: profileClaimNotifications.status,
    reportTokenExpiresAt: profileClaimNotifications.reportTokenExpiresAt,
  })
    .from(profileClaimNotifications)
    .where(eq(profileClaimNotifications.identityLinkEventId, input.identityLinkEventId))
    .limit(1);
  if (!claimNotification || !claimNotification.userId || !input.accountReadyRecipientEmail) {
    return false;
  }
  const claimExpiresAt = Date.parse(claimNotification.reportTokenExpiresAt);
  if (!Number.isFinite(claimExpiresAt) || claimExpiresAt <= Date.now()) return false;
  if (!(ACTIVE_STATUSES.includes(claimNotification.status as (typeof ACTIVE_STATUSES)[number])
    || claimNotification.status === "succeeded")) {
    return false;
  }

  const [user] = await db.select({ email: users.email })
    .from(users)
    .where(eq(users.id, claimNotification.userId))
    .limit(1);
  if (!user
    || normalizeAccountEmail(claimNotification.recipientEmail)
      !== normalizeAccountEmail(input.accountReadyRecipientEmail)) {
    return false;
  }

  const { accountReadyDeliveryJobs } = await import("@shared/schema/account-ready-delivery-jobs");
  const [job] = await db.select({
    id: accountReadyDeliveryJobs.id,
    standaloneDeliveryRequested: accountReadyDeliveryJobs.standaloneDeliveryRequested,
  })
    .from(accountReadyDeliveryJobs)
    .where(eq(accountReadyDeliveryJobs.identityLinkEventId, input.identityLinkEventId))
    .limit(1);
  return Boolean(job && !job.standaloneDeliveryRequested);
}

export async function getNextProfileClaimNotificationAt(): Promise<Date | null> {
  const [row] = await db.select({
    nextAttemptAt: sql<string>`CASE
      WHEN ${profileClaimNotifications.status} = 'processing'
        THEN ${profileClaimNotifications.leaseExpiresAt}
      ELSE ${profileClaimNotifications.nextAttemptAt}
    END`,
  }).from(profileClaimNotifications).where(and(
    inArray(profileClaimNotifications.status, [...ACTIVE_STATUSES]),
    sql`(${profileClaimNotifications.status} = 'processing' OR ${profileClaimNotifications.attemptCount} < ${PROFILE_CLAIM_NOTIFICATION_MAX_ATTEMPTS})`,
    sql`${profileClaimNotifications.reportTokenExpiresAt} > now()`,
  )).orderBy(sql`CASE
    WHEN ${profileClaimNotifications.status} = 'processing'
      THEN ${profileClaimNotifications.leaseExpiresAt}
    ELSE ${profileClaimNotifications.nextAttemptAt}
  END`, asc(profileClaimNotifications.id)).limit(1);
  if (!row?.nextAttemptAt) return null;
  const value = new Date(row.nextAttemptAt);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid profile-claim notification due timestamp");
  return value;
}

export async function getProfileClaimReportByHash(tokenHash: string): Promise<{
  notification: ProfileClaimNotification;
  token: typeof profileClaimReportTokens.$inferSelect;
} | undefined> {
  const [row] = await db.select({
    notification: profileClaimNotifications,
    token: profileClaimReportTokens,
  }).from(profileClaimReportTokens)
    .innerJoin(profileClaimNotifications, eq(profileClaimReportTokens.notificationId, profileClaimNotifications.id))
    .where(eq(profileClaimReportTokens.tokenHash, tokenHash)).limit(1);
  if (
    !row
    || row.notification.reportTokenHash !== row.token.tokenHash
    || row.token.tokenHash !== profileClaimReportTokenHashForEvent(row.notification.identityLinkEventId)
    || !(await isCurrentProfileClaimNotificationWithExecutor(db, row.notification))
  ) return undefined;
  return row;
}

export async function consumeProfileClaimReportAndCreateHold(input: {
  tokenHash: string;
  reason: string | null;
}): Promise<
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "obsolete" }
  | { kind: "used" }
  | { kind: "created"; hold: IdentitySecurityHold; userId: number }
  | { kind: "existing"; hold: IdentitySecurityHold; userId: number }
> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({
      notification: profileClaimNotifications,
      token: profileClaimReportTokens,
    }).from(profileClaimReportTokens)
      .innerJoin(profileClaimNotifications, eq(profileClaimReportTokens.notificationId, profileClaimNotifications.id))
      .where(eq(profileClaimReportTokens.tokenHash, input.tokenHash))
      .limit(1)
      .for("update");
    if (!row) return { kind: "invalid" as const };
    if (row.token.usedAt) return { kind: "used" as const };
    if (Date.parse(row.token.expiresAt) <= Date.now()) return { kind: "expired" as const };
    if (
      row.notification.reportTokenHash !== row.token.tokenHash
      || row.token.tokenHash !== profileClaimReportTokenHashForEvent(row.notification.identityLinkEventId)
    ) {
      return { kind: "invalid" as const };
    }
    if (!row.notification.userId) return { kind: "invalid" as const };

    // The report capability is bound to the exact identity-link event.  Do
    // not place a hold if that assignment has since been unlinked or replaced;
    // the original account is no longer the active claimant for this profile.
    const [currentUser] = await tx.select({
      id: users.id,
      bowlerId: users.bowlerId,
      organizationId: users.organizationId,
    }).from(users)
      .where(eq(users.id, row.notification.userId))
      .limit(1)
      .for("update");
    if (
      !currentUser
      || currentUser.organizationId !== row.notification.organizationId
      || currentUser.bowlerId !== row.notification.bowlerId
      || !(await isCurrentProfileClaimNotificationWithExecutor(tx, row.notification))
    ) {
      await tx.update(profileClaimReportTokens)
        .set({ usedAt: sql`now()` })
        .where(and(
          eq(profileClaimReportTokens.id, row.token.id),
          sql`${profileClaimReportTokens.usedAt} IS NULL`,
        ));
      return { kind: "obsolete" as const };
    }

    const [consumed] = await tx.update(profileClaimReportTokens)
      .set({ usedAt: sql`now()` })
      .where(and(
        eq(profileClaimReportTokens.id, row.token.id),
        sql`${profileClaimReportTokens.usedAt} IS NULL`,
      )).returning({ id: profileClaimReportTokens.id });
    if (!consumed) return { kind: "used" as const };

    const [existing] = await tx.select().from(identitySecurityHolds).where(and(
      eq(identitySecurityHolds.userId, row.notification.userId),
      eq(identitySecurityHolds.status, "active"),
    )).limit(1);
    if (existing) return { kind: "existing" as const, hold: existing, userId: row.notification.userId };

    const [hold] = await tx.insert(identitySecurityHolds).values({
      notificationId: row.notification.id,
      reportTokenId: row.token.id,
      userId: row.notification.userId,
      bowlerId: row.notification.bowlerId,
      organizationId: row.notification.organizationId,
      reason: input.reason,
      status: "active",
    }).returning();
    if (!hold) throw new Error("Identity security hold was not created");
    await tx.update(emailChangeRequests).set({ consumedAt: sql`now()` }).where(and(
      eq(emailChangeRequests.userId, row.notification.userId),
      sql`${emailChangeRequests.consumedAt} IS NULL`,
    ));
    return { kind: "created" as const, hold, userId: row.notification.userId };
  });
}

export async function hasActiveIdentitySecurityHold(userId: number): Promise<boolean> {
  const [row] = await db.select({ id: identitySecurityHolds.id }).from(identitySecurityHolds)
    .where(and(eq(identitySecurityHolds.userId, userId), eq(identitySecurityHolds.status, "active")))
    .limit(1);
  return Boolean(row);
}

export async function listIdentitySecurityHolds(options: { organizationId?: number; activeOnly?: boolean } = {}): Promise<IdentitySecurityHold[]> {
  const conditions = [];
  if (options.organizationId !== undefined) conditions.push(eq(identitySecurityHolds.organizationId, options.organizationId));
  if (options.activeOnly) conditions.push(eq(identitySecurityHolds.status, "active"));
  return db.select().from(identitySecurityHolds)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(identitySecurityHolds.createdAt), asc(identitySecurityHolds.id));
}

export async function resolveIdentitySecurityHold(input: {
  holdId: number;
  actorUserId: number;
  organizationId?: number;
  status: "resolved" | "rejected";
  /** Optional explicit review decision. Older callers may only resolve the
   * hold; new admin surfaces can revoke the disputed assignment atomically. */
  assignmentAction?: "uphold" | "revoke";
  resolution: string;
}): Promise<IdentitySecurityHold | undefined> {
  return db.transaction(async (tx) => {
    const [hold] = await tx.select().from(identitySecurityHolds)
      .where(and(
        eq(identitySecurityHolds.id, input.holdId),
        eq(identitySecurityHolds.status, "active"),
        input.organizationId === undefined ? undefined : eq(identitySecurityHolds.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("update");
    if (!hold) return undefined;

    // A profile-claim report invalidates the old credential/session trust
    // boundary.  Restoring access always requires a fresh password-reset
    // proof, even when the administrator rejects the report as mistaken.
    await lockAccountCredential(tx, hold.userId);
    const [targetUser] = await tx.select({
      id: users.id,
      organizationId: users.organizationId,
      credentialGeneration: users.credentialGeneration,
    }).from(users)
      .where(eq(users.id, hold.userId))
      .limit(1)
      .for("update");
    if (!targetUser) return undefined;
    if (input.assignmentAction === "revoke") {
      // Mark the hold resolved before invoking the shared unlink service so
      // its invariant check does not reject the administrator's explicit,
      // audited decision. The surrounding transaction rolls both writes back
      // together if the unlink cannot be completed.
      await tx.update(identitySecurityHolds).set({
        status: "resolved",
        resolvedByUserId: input.actorUserId,
        resolution: input.resolution,
        resolvedAt: sql`now()`,
        updatedAt: sql`now()`,
      }).where(and(
        eq(identitySecurityHolds.id, input.holdId),
        eq(identitySecurityHolds.status, "active"),
      ));
      await unlinkUserFromBowler({
        organizationId: hold.organizationId,
        userId: hold.userId,
        actorUserId: input.actorUserId,
        source: "profile-claim-report-revoke",
        reason: input.resolution,
        eventType: "access_cleanup",
      }, tx);
    }

    await tx.update(users).set({ mustChangePassword: true }).where(eq(users.id, targetUser.id));
    await enqueuePasswordResetDelivery({
      userId: targetUser.id,
      organizationId: targetUser.organizationId,
      credentialGeneration: targetUser.credentialGeneration,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }, tx);

    const [row] = input.assignmentAction === "revoke"
      ? await tx.select().from(identitySecurityHolds)
        .where(eq(identitySecurityHolds.id, input.holdId)).limit(1)
      : await tx.update(identitySecurityHolds).set({
        status: input.status,
        resolvedByUserId: input.actorUserId,
        resolution: input.resolution,
        resolvedAt: sql`now()`,
        updatedAt: sql`now()`,
      }).where(and(
        eq(identitySecurityHolds.id, input.holdId),
        eq(identitySecurityHolds.status, "active"),
      )).returning();
    return row;
  });
}
