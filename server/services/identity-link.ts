import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlers,
  identitySecurityHolds,
  identityLinkEvents,
  users,
  type IdentityLinkBowlerSnapshot,
  type IdentityLinkEvent,
  type IdentityLinkEventType,
  type User,
  type Bowler,
} from "@shared/schema";
import { cacheInvalidate } from "../utils/cache.js";
import { notifyPaymentSyncRetryChanged } from "./payment-sync-retry-scheduler";

/** A transaction client accepted by the identity-link service. */
export type IdentityLinkExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type IdentityLinkSource = string;

export interface IdentityLinkInput {
  organizationId: number;
  userId: number;
  bowlerId: number;
  actorUserId?: number | null;
  source?: IdentityLinkSource | null;
  reason?: string | null;
  /** Require the locked user and bowler rows to prove the same email. */
  requireEmailMatch?: boolean;
  /** `link` is the ordinary self-service event. */
  eventType?: "link" | "admin_assignment";
  /** Queue the automatic account-ready email atomically with this link. */
  queueAccountReadyEmail?: boolean;
  /**
   * Immutable roster-email snapshot captured before a caller performs a
   * linkage-related bowler contact update. `null` deliberately means that no
   * independent roster address existed, so the notification must use the
   * account fallback rather than a newly supplied address.
   */
  claimNotificationRecipientEmail?: string | null;
}

const ACCOUNT_READY_AUTO_LINK_SOURCES = new Set([
  "bowler-post-create-email-auto-link",
  "bowler-profile-email-auto-link",
  "admin-unclaimed-create",
  "admin-unclaimed-link",
]);

export interface IdentityUnlinkInput {
  organizationId: number;
  userId: number;
  actorUserId?: number | null;
  source?: IdentityLinkSource | null;
  reason?: string | null;
  eventType?: "unlink" | "access_cleanup";
}

export interface IdentityReplacementInput {
  organizationId: number;
  userId: number;
  bowlerId: number;
  actorUserId?: number | null;
  source?: IdentityLinkSource | null;
  reason?: string | null;
}

export interface IdentityLinkMutation {
  user: User;
  bowler: Bowler | null;
  oldBowler: Bowler | null;
  event: IdentityLinkEvent | null;
}

export interface IdentityLinkEventInput {
  organizationId: number;
  actorUserId?: number | null;
  userId: number;
  bowlerId?: number | null;
  oldBowlerId?: number | null;
  newBowlerId?: number | null;
  eventType: IdentityLinkEventType;
  oldBowlerSnapshot?: IdentityLinkBowlerSnapshot | null;
  newBowlerSnapshot?: IdentityLinkBowlerSnapshot | null;
  source?: string | null;
  reason?: string | null;
}

export class IdentityLinkError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "USER_NOT_FOUND"
      | "BOWLER_NOT_FOUND"
      | "ELEVATED_ROLE_DENIED"
      | "CROSS_ORG_DENIED"
      | "ALREADY_LINKED"
      | "BOWLER_TAKEN"
      | "EMAIL_MISMATCH"
      | "ORG_REQUIRED"
      | "SECURITY_HOLD"
      | "INVALID_INPUT",
    public readonly status: 400 | 403 | 404 | 409 | 423,
  ) {
    super(message);
    this.name = "IdentityLinkError";
  }
}

function assertOrganizationId(organizationId: number): void {
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new IdentityLinkError(
      "Organization context is required",
      "ORG_REQUIRED",
      403,
    );
  }
}

function assertAuditText(value: string | null | undefined, field: string, maxLength: number): void {
  if (value !== null && value !== undefined && value.length > maxLength) {
    throw new IdentityLinkError(
      `${field} is too long`,
      "INVALID_INPUT",
      400,
    );
  }
}

function validateInputText(input: {
  source?: string | null;
  reason?: string | null;
}): void {
  assertAuditText(input.source, "source", 128);
  assertAuditText(input.reason, "reason", 500);
}

function snapshotBowler(bowler: Bowler): IdentityLinkBowlerSnapshot {
  // Keep this allowlist deliberately small. In particular, do not spread the
  // row: Bowler contains email/phone and payment-provider identifiers.
  return {
    id: bowler.id,
    name: bowler.name,
    organizationId: bowler.organizationId,
    active: bowler.active,
  };
}

async function withExecutor<T>(
  executor: IdentityLinkExecutor | undefined,
  callback: (tx: IdentityLinkExecutor) => Promise<T>,
): Promise<T> {
  if (executor) return callback(executor);
  return db.transaction((tx) => callback(tx));
}

async function lockUser(
  executor: IdentityLinkExecutor,
  userId: number,
): Promise<User> {
  await executor.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);
  const [user] = await executor
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new IdentityLinkError("User not found", "USER_NOT_FOUND", 404);
  }
  return user;
}

async function assertNoActiveIdentitySecurityHold(
  executor: IdentityLinkExecutor,
  userId: number,
): Promise<void> {
  const [hold] = await executor
    .select({ id: identitySecurityHolds.id })
    .from(identitySecurityHolds)
    .where(and(
      eq(identitySecurityHolds.userId, userId),
      eq(identitySecurityHolds.status, "active"),
    ))
    .limit(1);
  if (hold) {
    throw new IdentityLinkError(
      "Account is temporarily restricted while a profile-security report is reviewed",
      "SECURITY_HOLD",
      423,
    );
  }
}

async function lockBowler(
  executor: IdentityLinkExecutor,
  bowlerId: number,
): Promise<Bowler> {
  await executor.execute(sql`SELECT id FROM ${bowlers} WHERE id = ${bowlerId} FOR UPDATE`);
  const [bowler] = await executor
    .select()
    .from(bowlers)
    .where(eq(bowlers.id, bowlerId))
    .limit(1);
  if (!bowler) {
    throw new IdentityLinkError("Bowler not found", "BOWLER_NOT_FOUND", 404);
  }
  return bowler;
}

function assertOrdinaryUser(user: User, organizationId: number): void {
  if (user.role !== "user") {
    throw new IdentityLinkError(
      "Only ordinary user accounts may be linked to a bowler",
      "ELEVATED_ROLE_DENIED",
      403,
    );
  }
  if (user.organizationId !== organizationId) {
    throw new IdentityLinkError(
      "User belongs to a different organization",
      "CROSS_ORG_DENIED",
      403,
    );
  }
}

function assertBowlerOrganization(bowler: Bowler, organizationId: number): void {
  if (bowler.organizationId !== organizationId) {
    throw new IdentityLinkError(
      "Bowler belongs to a different organization",
      "CROSS_ORG_DENIED",
      403,
    );
  }
}

async function assertBowlerUnclaimed(
  executor: IdentityLinkExecutor,
  bowlerId: number,
): Promise<void> {
  const [claim] = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.bowlerId, bowlerId))
    .limit(1);
  if (claim) {
    throw new IdentityLinkError(
      "Bowler is already linked to another user",
      "BOWLER_TAKEN",
      409,
    );
  }
}

export async function recordIdentityLinkEvent(
  executor: IdentityLinkExecutor,
  input: IdentityLinkEventInput,
): Promise<IdentityLinkEvent> {
  const [event] = await executor
    .insert(identityLinkEvents)
    .values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      subjectUserId: input.userId,
      userId: input.userId,
      bowlerId: input.bowlerId ?? null,
      oldBowlerId: input.oldBowlerId ?? null,
      newBowlerId: input.newBowlerId ?? null,
      eventType: input.eventType,
      oldBowlerSnapshot: input.oldBowlerSnapshot ?? null,
      newBowlerSnapshot: input.newBowlerSnapshot ?? null,
      source: input.source ?? null,
      reason: input.reason ?? null,
    })
    .returning();
  if (!event) {
    throw new Error("Failed to record identity-link event");
  }
  return event;
}

async function linkInTransaction(
  executor: IdentityLinkExecutor,
  input: IdentityLinkInput,
): Promise<IdentityLinkMutation> {
  assertOrganizationId(input.organizationId);
  validateInputText(input);

  // Always lock the user first, then the target bowler. Every claimant of a
  // given target serializes on the same bowler row; the user lock prevents a
  // single account from winning two competing claims.
  const user = await lockUser(executor, input.userId);
  await assertNoActiveIdentitySecurityHold(executor, user.id);
  assertOrdinaryUser(user, input.organizationId);
  if (user.bowlerId !== null) {
    throw new IdentityLinkError(
      "User is already linked to a bowler",
      "ALREADY_LINKED",
      409,
    );
  }

  const bowler = await lockBowler(executor, input.bowlerId);
  assertBowlerOrganization(bowler, input.organizationId);
  if (input.requireEmailMatch) {
    const userEmail = user.email.trim().toLowerCase();
    const bowlerEmail = bowler.email?.trim().toLowerCase() ?? "";
    if (bowlerEmail.length === 0 || bowlerEmail !== userEmail) {
      throw new IdentityLinkError(
        "Bowler email does not match the user account",
        "EMAIL_MISMATCH",
        403,
      );
    }
    // Email ownership is only conclusive when this is the sole profile in
    // the same organization with that normalized address. This check lives
    // in the transactional service, not only in route preflight reads, so
    // direct API callers and races cannot choose among shared/family or
    // legacy duplicate roster records. Admin assignments deliberately pass
    // requireEmailMatch=false and remain the explicit resolution path.
    const matchingProfiles = await executor
      .select({ id: bowlers.id })
      .from(bowlers)
      .where(and(
        eq(bowlers.organizationId, input.organizationId),
        sql`lower(btrim(${bowlers.email})) = ${userEmail}`,
      ))
      .limit(2);
    if (matchingProfiles.length !== 1 || matchingProfiles[0]?.id !== bowler.id) {
      throw new IdentityLinkError(
        "Bowler email matches multiple profiles; administrator review is required",
        "EMAIL_MISMATCH",
        403,
      );
    }
  }
  await assertBowlerUnclaimed(executor, bowler.id);

  // Backfill contact details the linked account already carries so the
  // merged roster profile is complete; only fill fields the bowler left empty.
  const contactPatch: Partial<Pick<Bowler, "email" | "phone">> = {};
  if (!bowler.email?.trim() && user.email?.trim()) {
    contactPatch.email = user.email.trim();
  }
  if (!bowler.phone?.trim() && user.phone?.trim()) {
    contactPatch.phone = user.phone.trim();
  }

  let linkedBowler = bowler;
  if (Object.keys(contactPatch).length > 0) {
    const nowIso = new Date().toISOString();
    const [updatedBowler] = await executor
      .update(bowlers)
      .set({
        ...contactPatch,
        paymentSyncPendingAt: nowIso,
        paymentSyncAttempts: 0,
        paymentSyncLastAttemptAt: null,
        paymentSyncNextRetryAt: nowIso,
      })
      .where(and(
        eq(bowlers.id, bowler.id),
        eq(bowlers.organizationId, input.organizationId),
      ))
      .returning();
    if (!updatedBowler) throw new Error("Failed to update linked bowler");
    linkedBowler = updatedBowler;
  }

  const [updatedUser] = await executor
    .update(users)
    .set({ bowlerId: bowler.id })
    .where(eq(users.id, user.id))
    .returning();
  if (!updatedUser) throw new Error("Failed to link user to bowler");

  const event = await recordIdentityLinkEvent(executor, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    userId: updatedUser.id,
    bowlerId: bowler.id,
    newBowlerId: bowler.id,
    eventType: input.eventType ?? "link",
    newBowlerSnapshot: snapshotBowler(linkedBowler),
    source: input.source,
    reason: input.reason,
  });

  // Capture the original roster address before contact backfill. A claim
  // notification must go to the address that was on the roster at the time
  // of the assignment; re-reading bowler/user after this transaction would
  // otherwise silently redirect the warning to the newly linked account.
  // When a legacy roster row has no address, the account address is an
  // explicit, recorded fallback rather than an implicit re-read.
  const hasRecipientSnapshot = Object.prototype.hasOwnProperty.call(
    input,
    "claimNotificationRecipientEmail",
  );
  const rosterRecipientEmail = hasRecipientSnapshot
    ? input.claimNotificationRecipientEmail?.trim() || ""
    : bowler.email?.trim() || "";
  const originalRecipientEmail = rosterRecipientEmail || user.email?.trim() || "";
  if (originalRecipientEmail) {
    const { profileClaimReportTokenHashForEvent, queueProfileClaimNotification } = await import(
      "../storage/profile-claim-notifications.js"
    );
    const reportTokenHash = profileClaimReportTokenHashForEvent(event.id);
    const reportTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await queueProfileClaimNotification({
      identityLinkEventId: event.id,
      userId: updatedUser.id,
      bowlerId: linkedBowler.id,
      organizationId: input.organizationId,
      recipientEmail: originalRecipientEmail,
      recipientSource: rosterRecipientEmail ? "roster" : "account_fallback",
      recipientName: bowler.name,
      bowlerName: bowler.name,
      reportTokenHash,
      reportTokenExpiresAt,
    }, executor);
  }
  if (input.queueAccountReadyEmail) {
    if (!ACCOUNT_READY_AUTO_LINK_SOURCES.has(input.source ?? "")) {
      throw new Error("Account-ready delivery is restricted to automatic email-link sources");
    }
    // Keep the queue's database/runtime dependencies out of ordinary identity
    // linking and no-DB callers. The automatic paths opt in explicitly after
    // the identity event has been written inside this transaction.
    const { queueAccountReadyDeliveryJob } = await import(
      "../storage/account-ready-delivery-jobs.js"
    );
    await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: updatedUser.id,
      bowlerId: linkedBowler.id,
      organizationId: input.organizationId,
    }, executor);
  }
  return { user: updatedUser, bowler: linkedBowler, oldBowler: null, event };
}

/**
 * Atomically claim an unclaimed bowler for an ordinary user account.
 * Pass an existing transaction when the caller also mutates teams or leagues.
 */
export async function linkUserToBowler(
  input: IdentityLinkInput,
  executor?: IdentityLinkExecutor,
): Promise<IdentityLinkMutation> {
  const result = await withExecutor(executor, (tx) => linkInTransaction(tx, input));
  // An injected executor belongs to a caller-owned compound transaction; its
  // caller invalidates after that outer transaction commits. For a standalone
  // call, this runs only after db.transaction resolves successfully.
  if (!executor) {
    cacheInvalidate(`user:${result.user.id}`);
    cacheInvalidate("bowlers:");
    notifyPaymentSyncRetryChanged();
  }
  return result;
}

async function unlinkInTransaction(
  executor: IdentityLinkExecutor,
  input: IdentityUnlinkInput,
): Promise<IdentityLinkMutation> {
  assertOrganizationId(input.organizationId);
  validateInputText(input);

  const user = await lockUser(executor, input.userId);
  await assertNoActiveIdentitySecurityHold(executor, user.id);
  assertOrdinaryUser(user, input.organizationId);
  if (user.bowlerId === null) {
    return { user, bowler: null, oldBowler: null, event: null };
  }

  const oldBowler = await lockBowler(executor, user.bowlerId);
  assertBowlerOrganization(oldBowler, input.organizationId);
  const [updatedUser] = await executor
    .update(users)
    .set({ bowlerId: null })
    .where(eq(users.id, user.id))
    .returning();
  if (!updatedUser) throw new Error("Failed to unlink user from bowler");

  const event = await recordIdentityLinkEvent(executor, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    userId: updatedUser.id,
    bowlerId: oldBowler.id,
    oldBowlerId: oldBowler.id,
    eventType: input.eventType ?? "unlink",
    oldBowlerSnapshot: snapshotBowler(oldBowler),
    source: input.source,
    reason: input.reason,
  });
  return { user: updatedUser, bowler: null, oldBowler, event };
}

/** Atomically unlink an ordinary user and append the corresponding event. */
export async function unlinkUserFromBowler(
  input: IdentityUnlinkInput,
  executor?: IdentityLinkExecutor,
): Promise<IdentityLinkMutation> {
  const result = await withExecutor(executor, (tx) => unlinkInTransaction(tx, input));
  if (!executor) cacheInvalidate(`user:${result.user.id}`);
  return result;
}

/**
 * Replace an existing ordinary user's bowler identity. This is kept separate
 * from claim/unlink so replacement events always carry both snapshots and the
 * service can lock both bowler rows before changing the user.
 */
export async function replaceUserBowler(
  input: IdentityReplacementInput,
  executor?: IdentityLinkExecutor,
): Promise<IdentityLinkMutation> {
  const result = await withExecutor(executor, async (tx) => {
    assertOrganizationId(input.organizationId);
    validateInputText(input);
    const user = await lockUser(tx, input.userId);
    await assertNoActiveIdentitySecurityHold(tx, user.id);
    assertOrdinaryUser(user, input.organizationId);
    if (user.bowlerId === null) {
      throw new IdentityLinkError(
        "User is not linked to a bowler",
        "ALREADY_LINKED",
        409,
      );
    }
    if (user.bowlerId === input.bowlerId) {
      throw new IdentityLinkError(
        "Replacement bowler must be different from the current bowler",
        "ALREADY_LINKED",
        409,
      );
    }

    // Lock in ID order after the user lock to avoid cross-user replacement
    // deadlocks when two requests involve the same pair of bowlers.
    const ids = [user.bowlerId, input.bowlerId].sort((a, b) => a - b);
    const locked = new Map<number, Bowler>();
    for (const id of ids) locked.set(id, await lockBowler(tx, id));
    const oldBowler = locked.get(user.bowlerId);
    const newBowler = locked.get(input.bowlerId);
    if (!oldBowler || !newBowler) throw new Error("Replacement bowler rows disappeared");
    assertBowlerOrganization(oldBowler, input.organizationId);
    assertBowlerOrganization(newBowler, input.organizationId);
    await assertBowlerUnclaimed(tx, newBowler.id);

    const [updatedUser] = await tx
      .update(users)
      .set({ bowlerId: newBowler.id })
      .where(eq(users.id, user.id))
      .returning();
    if (!updatedUser) throw new Error("Failed to replace user bowler");

    const event = await recordIdentityLinkEvent(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      userId: updatedUser.id,
      bowlerId: newBowler.id,
      oldBowlerId: oldBowler.id,
      newBowlerId: newBowler.id,
      eventType: "replacement",
      oldBowlerSnapshot: snapshotBowler(oldBowler),
      newBowlerSnapshot: snapshotBowler(newBowler),
      source: input.source,
      reason: input.reason,
    });
    return { user: updatedUser, bowler: newBowler, oldBowler, event };
  });
  if (!executor) cacheInvalidate(`user:${result.user.id}`);
  return result;
}

/** Convert service failures into route-friendly status/code pairs. */
export function isIdentityLinkError(error: unknown): error is IdentityLinkError {
  return error instanceof IdentityLinkError;
}
