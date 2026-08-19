import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { emailChangeRequests, users, type User } from '@shared/schema';
import { storage } from '../storage';
import { recordAdminEmailChangeAudit } from '../storage/admin-email-change-audits';
import { recordAdminProfileEditAudit } from '../storage/admin-profile-edit-audits';
import { normalizeAccountEmail } from '../storage/users';

/**
 * Atomic write of a new email-change request, optionally accompanied
 * by the admin audit row when a system_admin is acting on behalf of
 * *another* user (task #325). Both writes share one `db.transaction`
 * so the request and its audit can never disagree — if either insert
 * throws, the other is rolled back.
 *
 * Steps:
 *   1. Supersede any open request for this user (consumedAt = NOW).
 *   2. Insert the new request row.
 *   3. If `audit` is non-null, insert the admin audit row through
 *      `recordAdminEmailChangeAudit(..., tx)` so it joins the same
 *      transaction.
 *
 * Exported so the atomicity contract can be pinned by the unit test
 * in `tests/unit/admin-email-change-audit-atomicity.test.ts` against
 * the SAME function the PATCH /api/account/profile/:id route calls,
 * not a handcrafted replica.
 */
export async function applyEmailChangeRequestTxn(opts: {
  userId: number;
  newEmail: string;
  tokenHash: string;
  expiresAt: string;
  audit: {
    actorUserId: number;
    oldEmailMasked: string;
    newEmailMasked: string;
  } | null;
}): Promise<void> {
  const normalizedEmail = normalizeAccountEmail(opts.newEmail);
  await db.transaction(async (tx) => {
    await tx
      .update(emailChangeRequests)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(emailChangeRequests.userId, opts.userId),
          isNull(emailChangeRequests.consumedAt),
        ),
      );
    // Capture the inserted request id so the admin audit row can be
    // bound to the *exact* request it was written for (task #487).
    // The `/confirm-email-change` handler later updates that audit row
    // with the post-confirm payment-sync result; keying by request id
    // (rather than `targetUserId`) keeps superseded audit rows from
    // being collateral-updated when an admin re-initiates a change
    // before the previous link is confirmed.
    const [insertedRequest] = await tx.insert(emailChangeRequests).values({
      userId: opts.userId,
      newEmail: normalizedEmail,
      tokenHash: opts.tokenHash,
      expiresAt: opts.expiresAt,
    }).returning({ id: emailChangeRequests.id });
    if (opts.audit) {
      await recordAdminEmailChangeAudit(
        {
          actorUserId: opts.audit.actorUserId,
          targetUserId: opts.userId,
          oldEmailMasked: opts.audit.oldEmailMasked,
          newEmailMasked: opts.audit.newEmailMasked,
          emailChangeRequestId: insertedRequest.id,
        },
        tx,
      );
    }
  });
}

/**
 * One audit row's worth of "who changed what" for a single column on
 * the `users` table. The PATCH /api/account/profile/:id handler builds
 * one entry per modified field BEFORE entering the transaction so the
 * transaction body itself is data-driven.
 */
export type AdminProfileEditFieldChange = {
  field: 'name' | 'phone' | 'preferred_language';
  oldValue: string | null;
  newValue: string | null;
};

/**
 * Atomic admin-initiated profile edit (task #376): the `users` row
 * UPDATE and the per-field `admin_profile_edit_audits` INSERTs share
 * a single `db.transaction(...)` so the audit and the change can
 * never disagree.
 *
 * Steps inside the transaction:
 *   1. UPDATE users SET <storagePatch> WHERE id = userId, RETURNING.
 *      A missing row (deleted between read and write) throws so the
 *      audit step never runs for a no-op.
 *   2. For every entry in `fieldChanges`, INSERT one row into
 *      `admin_profile_edit_audits` via `recordAdminProfileEditAudit`
 *      bound to the SAME `tx`.
 *
 * Both writes commit together or roll back together. A future refactor
 * that hoisted either side outside the transaction would leave the
 * audit and the user row out of sync; the atomicity tests in
 * `tests/unit/admin-profile-edit-audit-atomicity.test.ts` pin both
 * directions of that contract against this exported helper, not a
 * handcrafted replica of the route's body.
 */
export async function applyAdminProfileEditTxn(opts: {
  userId: number;
  storagePatch: Parameters<typeof storage.updateUser>[1];
  actorUserId: number;
  fieldChanges: AdminProfileEditFieldChange[];
}): Promise<User> {
  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set(opts.storagePatch)
      .where(eq(users.id, opts.userId))
      .returning();
    if (!updated) {
      throw new Error(`Failed to update user with ID ${opts.userId}`);
    }
    for (const change of opts.fieldChanges) {
      await recordAdminProfileEditAudit(
        {
          actorUserId: opts.actorUserId,
          targetUserId: opts.userId,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
        },
        tx,
      );
    }
    return updated;
  });
}

/**
 * Outcome of the confirm-email-change transaction. The route layer
 * maps these to HTTP responses; tests assert against them directly.
 */
export type ConfirmEmailChangeOutcome =
  | { kind: 'ok'; user: User; requestId: number }
  | { kind: 'invalid' }
  | { kind: 'consumed' }
  | { kind: 'expired' }
  | { kind: 'user_gone' };
// (EMAIL_IN_USE is signalled by a thrown PG error 23505 escaping the
// transaction so the caller can roll back and consume the losing token
// out-of-band — see the route's catch.)

/**
 * Atomic confirm-email-change transaction (task #494, sibling of
 * #377): claim the pending token AND swap the user's login email in
 * a single `db.transaction(...)` so a confirmed token can never
 * leave `users.email` unchanged (and vice versa, the email can
 * never be swapped without the token being consumed — which would
 * allow a replay).
 *
 * Steps inside the transaction:
 *   1. Conditional UPDATE on `email_change_requests` that sets
 *      `consumed_at = now()` only if the row is still pending and
 *      not expired. RETURNING is used so concurrent confirms cannot
 *      both win — at most one transaction sees a non-empty result.
 *   2. UPDATE `users.email = claimed.newEmail` for the user that
 *      owns the request. A unique-constraint violation here (PG
 *      23505) bubbles out, the transaction rolls back, and the
 *      caller (the route) consumes the losing token explicitly.
 *
 * Exported so the atomicity contract can be pinned by the unit test
 * in `tests/unit/confirm-email-change-atomicity.test.ts` against the
 * SAME function the POST /api/account/confirm-email-change route
 * calls, not a handcrafted replica.
 */
export async function applyConfirmEmailChangeTxn(
  tokenHash: string,
): Promise<ConfirmEmailChangeOutcome> {
  return await db.transaction(async (tx) => {
    // Single conditional UPDATE: claims the token only if it is still
    // pending AND not expired. Concurrent confirms cannot both win.
    const [claimed] = await tx
      .update(emailChangeRequests)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(emailChangeRequests.tokenHash, tokenHash),
          isNull(emailChangeRequests.consumedAt),
          gt(emailChangeRequests.expiresAt, sql`now()`),
        ),
      )
      .returning();

    if (!claimed) {
      // Look up the row out-of-band to give a friendly error code
      // (consumed / expired / unknown).
      const [existing] = await tx
        .select()
        .from(emailChangeRequests)
        .where(eq(emailChangeRequests.tokenHash, tokenHash))
        .limit(1);
      if (!existing) return { kind: 'invalid' as const };
      if (existing.consumedAt) return { kind: 'consumed' as const };
      return { kind: 'expired' as const };
    }

    // Apply the email swap inside the same transaction. A unique-
    // constraint violation here rolls back the claim, so the user can
    // retry once the conflict is resolved.
    const [updated] = await tx
      .update(users)
      .set({ email: normalizeAccountEmail(claimed.newEmail) })
      .where(eq(users.id, claimed.userId))
      .returning();

    if (!updated) return { kind: 'user_gone' as const };
    // `requestId` is carried out of the transaction so the post-confirm
    // payment-sync result can be written back to the *exact* admin
    // audit row that this confirmation belongs to (task #487). Doing
    // the audit UPDATE outside the transaction keeps the payment-
    // provider call (which can take seconds and throw retryable
    // errors) off the DB transaction critical path.
    return { kind: 'ok' as const, user: updated, requestId: claimed.id };
  });
}
