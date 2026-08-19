import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlers,
  identityLinkEvents,
  users,
  type IdentityLinkBowlerSnapshot,
  type IdentityLinkEvent,
  type IdentityLinkEventType,
  type User,
  type Bowler,
} from "@shared/schema";
import { cacheInvalidate } from "../utils/cache.js";

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
  /** `link` is the ordinary self-service event. */
  eventType?: "link" | "admin_assignment";
}

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
  userId?: number | null;
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
      | "ORG_REQUIRED"
      | "INVALID_INPUT",
    public readonly status: 400 | 403 | 404 | 409,
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
      userId: input.userId ?? null,
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
  await assertBowlerUnclaimed(executor, bowler.id);

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
    newBowlerSnapshot: snapshotBowler(bowler),
    source: input.source,
    reason: input.reason,
  });
  return { user: updatedUser, bowler, oldBowler: null, event };
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
  if (!executor) cacheInvalidate(`user:${result.user.id}`);
  return result;
}

async function unlinkInTransaction(
  executor: IdentityLinkExecutor,
  input: IdentityUnlinkInput,
): Promise<IdentityLinkMutation> {
  assertOrganizationId(input.organizationId);
  validateInputText(input);

  const user = await lockUser(executor, input.userId);
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
