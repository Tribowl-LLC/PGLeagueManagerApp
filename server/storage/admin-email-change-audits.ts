import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";
import {
  adminEmailChangeAudits,
  users,
  type AdminEmailChangeAudit,
  type InsertAdminEmailChangeAudit,
  type PaymentSyncStatus,
} from "@shared/schema";

// Drizzle's transaction client and the top-level `db` share the same
// callable insert/select API, so a thin DbExecutor union lets the route
// pass `tx` to record this audit inside the same transaction as the
// `email_change_requests` insert (the contract for task #325 — they
// must succeed or fail together).
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function recordAdminEmailChangeAudit(
  values: InsertAdminEmailChangeAudit,
  executor: DbExecutor = db,
): Promise<AdminEmailChangeAudit> {
  const [row] = await executor
    .insert(adminEmailChangeAudits)
    .values(values)
    .returning();
  return row;
}

// Row shape returned to the admin history UI: the raw audit row plus
// the actor + target users' display names so the page doesn't have to
// fan out N+1 lookups. Live `users.email` is intentionally NOT
// projected here — the masked versions on the audit row are the
// source of truth for what the admin should see; the live email may
// have been re-changed since and would mislead triage. Excluding it
// from the wire also keeps unnecessary PII out of the response.
//
// `postConfirmPaymentSyncStatus` and `postConfirmedAt` (task #487) are
// inherited from `AdminEmailChangeAudit` — both nullable, populated
// only after the target user clicks the confirmation link.
export interface AdminEmailChangeAuditRow extends AdminEmailChangeAudit {
  actorName: string | null;
  targetName: string | null;
}

// Hard cap protects the table renderer and DB from a runaway `?limit=`.
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

// Exposed so the route can echo the *effective* (post-clamp) limit
// back to the client — keeps pagination metadata honest when the
// caller asked for more than the cap allows.
export function clampListLimit(raw: number | undefined): number {
  return Math.max(1, Math.min(raw ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
}

export interface ListAdminEmailChangeAuditsOptions {
  targetUserId?: number;
  organizationId?: number;
  limit?: number;
  offset?: number;
}

export async function listAdminEmailChangeAudits(
  options: ListAdminEmailChangeAuditsOptions = {},
): Promise<AdminEmailChangeAuditRow[]> {
  const limit = clampListLimit(options.limit);
  const offset = Math.max(0, options.offset ?? 0);

  // Self-join `users` twice — once for the actor, once for the target —
  // via an alias so each row carries both display names.
  const targetUsers = alias(users, "target_users");

  const conditions = options.targetUserId !== undefined
    ? [eq(adminEmailChangeAudits.targetUserId, options.targetUserId)]
    : [];
  if (options.organizationId !== undefined) {
    conditions.push(eq(targetUsers.organizationId, options.organizationId));
  }

  const rows = await db
    .select({
      id: adminEmailChangeAudits.id,
      actorUserId: adminEmailChangeAudits.actorUserId,
      targetUserId: adminEmailChangeAudits.targetUserId,
      oldEmailMasked: adminEmailChangeAudits.oldEmailMasked,
      newEmailMasked: adminEmailChangeAudits.newEmailMasked,
      reason: adminEmailChangeAudits.reason,
      oldMailboxWaived: adminEmailChangeAudits.oldMailboxWaived,
      emailChangeRequestId: adminEmailChangeAudits.emailChangeRequestId,
      postConfirmPaymentSyncStatus: adminEmailChangeAudits.postConfirmPaymentSyncStatus,
      postConfirmedAt: adminEmailChangeAudits.postConfirmedAt,
      createdAt: adminEmailChangeAudits.createdAt,
      actorName: users.name,
      targetName: targetUsers.name,
    })
    .from(adminEmailChangeAudits)
    .leftJoin(users, eq(adminEmailChangeAudits.actorUserId, users.id))
    .leftJoin(targetUsers, eq(adminEmailChangeAudits.targetUserId, targetUsers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(adminEmailChangeAudits.createdAt), desc(adminEmailChangeAudits.id))
    .limit(limit)
    .offset(offset);

  return rows;
}

// Update the audit row that was written when an admin initiated the
// email change, recording the result of the deferred payment-provider
// sync that ran when the target user clicked the confirmation link
// (task #487). Keyed on `emailChangeRequestId` rather than
// `targetUserId` so a superseded audit row (admin re-initiated before
// the first link was clicked) is NOT collateral-updated by the
// confirm of the second request.
//
// Returns the number of rows updated:
//   0 — self-serve change (no audit row exists), legacy row written
//       before `emailChangeRequestId` existed, or the audit row was
//       deleted between request and confirm. All three cases are a
//       no-op for the caller; this is best-effort triage metadata,
//       not a contract the email-change flow depends on.
//   1 — the audit row was found and updated.
//
// The caller catches and logs any throw — failure to update this
// triage column must NEVER fail the user-visible email-change flow.
export async function markAdminEmailChangeAuditConfirmed(opts: {
  emailChangeRequestId: number;
  status: PaymentSyncStatus;
}): Promise<number> {
  const updated = await db
    .update(adminEmailChangeAudits)
    .set({
      postConfirmPaymentSyncStatus: opts.status,
      postConfirmedAt: sql`now()`,
    })
    .where(eq(adminEmailChangeAudits.emailChangeRequestId, opts.emailChangeRequestId))
    .returning({ id: adminEmailChangeAudits.id });
  return updated.length;
}

export async function countAdminEmailChangeAudits(
  options: { targetUserId?: number; organizationId?: number } = {},
): Promise<number> {
  const targetUsers = alias(users, "target_users_count");
  const conditions = options.targetUserId !== undefined
    ? [eq(adminEmailChangeAudits.targetUserId, options.targetUserId)]
    : [];
  if (options.organizationId !== undefined) {
    conditions.push(eq(targetUsers.organizationId, options.organizationId));
  }
  const q = db
    .select({ value: sql<number>`count(*)::int` })
    .from(adminEmailChangeAudits)
    .leftJoin(targetUsers, eq(adminEmailChangeAudits.targetUserId, targetUsers.id));
  const [row] = await (conditions.length > 0 ? q.where(and(...conditions)) : q);
  return row?.value ?? 0;
}
