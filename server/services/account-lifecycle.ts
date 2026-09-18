import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  lockAccountCredential,
  revokePendingAccountActionsForUser,
} from '../storage/account-action-requests';
import { emailChangeRequests, users, type User } from '@shared/schema';
import { storage } from '../storage';
import { recordAdminEmailChangeAudit } from '../storage/admin-email-change-audits';
import { recordAdminProfileEditAudit } from '../storage/admin-profile-edit-audits';
import { normalizeAccountEmail } from '../storage/users';
import { markEmailProvenanceVerified } from './verification-provenance.js';
import { identitySecurityHolds } from '@shared/schema/profile-claim-notifications';

export class EmailChangeSecurityHoldError extends Error {
  constructor() {
    super('Account is temporarily restricted while a profile-security report is reviewed');
    this.name = 'EmailChangeSecurityHoldError';
  }
}

/**
 * Atomic write of a new email-change request, optionally accompanied
 * by the admin audit row when a system_admin is acting on behalf of
 * *another* user (task #325). Both writes share one `db.transaction`
 * so the request and its audit can never disagree — if either insert
 * throws, the other is rolled back.
 *
 * Steps:
 *   1. Serialize against password/reset/email-confirm credential mutations.
 *   2. Supersede any open request for this user (consumedAt = NOW).
 *   3. Insert the new request row.
 *   4. If `audit` is non-null, insert the admin audit row through
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
  oldEmail?: string;
  oldEmailTokenHash?: string | null;
  oldEmailTokenExpiresAt?: string | null;
  oldEmailApprovedAt?: string | null;
  reauthenticatedAt?: string | null;
  credentialGeneration?: number | null;
  flowVersion?: number;
  audit: {
    actorUserId: number;
    oldEmailMasked: string;
    newEmailMasked: string;
    reason?: string | null;
    oldMailboxWaived?: boolean;
  } | null;
}): Promise<void> {
  const normalizedEmail = normalizeAccountEmail(opts.newEmail);
  await db.transaction(async (tx) => {
    await lockAccountCredential(tx, opts.userId);
    const [targetUser] = await tx.select({
      id: users.id,
      organizationId: users.organizationId,
    }).from(users).where(eq(users.id, opts.userId)).limit(1).for('update');
    if (!targetUser) throw new Error('Target user no longer exists');
    const [activeHold] = await tx.select({ id: identitySecurityHolds.id })
      .from(identitySecurityHolds)
      .where(and(
        eq(identitySecurityHolds.userId, opts.userId),
        eq(identitySecurityHolds.status, 'active'),
      )).limit(1);
    if (activeHold) throw new EmailChangeSecurityHoldError();
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
      oldEmail: opts.oldEmail ? normalizeAccountEmail(opts.oldEmail) : null,
      oldEmailTokenHash: opts.oldEmailTokenHash ?? null,
      oldEmailTokenExpiresAt: opts.oldEmailTokenExpiresAt ?? null,
      oldEmailApprovedAt: opts.oldEmailApprovedAt ?? null,
      reauthenticatedAt: opts.reauthenticatedAt ?? null,
      credentialGeneration: opts.credentialGeneration ?? null,
      flowVersion: opts.flowVersion ?? 1,
    }).returning({ id: emailChangeRequests.id });
    if (opts.audit) {
      await recordAdminEmailChangeAudit(
        {
          actorUserId: opts.audit.actorUserId,
          targetUserId: opts.userId,
          oldEmailMasked: opts.audit.oldEmailMasked,
          newEmailMasked: opts.audit.newEmailMasked,
          reason: opts.audit.reason ?? null,
          oldMailboxWaived: opts.audit.oldMailboxWaived ?? false,
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
  | { kind: 'pending_old'; user: User; requestId: number }
  | { kind: 'pending_new'; user: User; requestId: number }
  | { kind: 'legacy_restart' }
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
    // Read the immutable owner first without taking a row lock, then acquire
    // the per-account advisory lock and the user row lock before touching the
    // email-change row. Credential triggers take locks in user -> account
    // action -> email-change order; taking the user lock first here prevents
    // a direct credential UPDATE from holding the user row while waiting on
    // an email row that this transaction already claimed.
    const [candidate] = await tx
      .select()
      .from(emailChangeRequests)
      .where(and(
        eq(emailChangeRequests.tokenHash, tokenHash),
        isNull(emailChangeRequests.consumedAt),
        gt(emailChangeRequests.expiresAt, sql`now()`),
      ))
      .limit(1);

    if (!candidate) {
      const [existing] = await tx
        .select()
        .from(emailChangeRequests)
        .where(eq(emailChangeRequests.tokenHash, tokenHash))
        .limit(1);
      if (!existing) return { kind: 'invalid' as const };
      if (existing.consumedAt) return { kind: 'consumed' as const };
      return { kind: 'expired' as const };
    }

    await lockAccountCredential(tx, candidate.userId);

    const [targetUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, candidate.userId))
      .limit(1)
      .for('update');
    if (!targetUser) return { kind: 'user_gone' as const };
    const [activeHold] = await tx.select({ id: identitySecurityHolds.id })
      .from(identitySecurityHolds)
      .where(and(
        eq(identitySecurityHolds.userId, targetUser.id),
        eq(identitySecurityHolds.status, 'active'),
      )).limit(1);
    if (activeHold) throw new EmailChangeSecurityHoldError();

    // Legacy requests predate reauthentication, old-address provenance, and
    // the dual-proof state machine. They must not remain a bypass after the
    // strengthened workflow is deployed; consume the old capability and make
    // the caller start a fresh request under flow version 2.
    if (candidate.flowVersion !== 2) {
      await tx.update(emailChangeRequests).set({ consumedAt: sql`now()` })
        .where(and(
          eq(emailChangeRequests.id, candidate.id),
          isNull(emailChangeRequests.consumedAt),
        ));
      return { kind: 'legacy_restart' as const };
    }

    // New protected requests first record proof of the destination mailbox.
    // The old mailbox proof is a separate capability and is required when
    // the current address has no reliable ownership provenance.
    if (candidate.flowVersion === 2) {
      if (candidate.oldEmail && normalizeAccountEmail(targetUser.email) !== normalizeAccountEmail(candidate.oldEmail)) {
        return { kind: 'invalid' as const };
      }
      if (
        candidate.credentialGeneration === null
        || candidate.credentialGeneration !== targetUser.credentialGeneration
      ) {
        return { kind: 'invalid' as const };
      }
      const [confirmed] = await tx.update(emailChangeRequests).set({
        newEmailConfirmedAt: sql`now()`,
      }).where(and(
        eq(emailChangeRequests.id, candidate.id),
        isNull(emailChangeRequests.consumedAt),
        isNull(emailChangeRequests.newEmailConfirmedAt),
        gt(emailChangeRequests.expiresAt, sql`now()`),
      )).returning();
      if (!confirmed) {
        const [current] = await tx.select().from(emailChangeRequests)
          .where(eq(emailChangeRequests.id, candidate.id)).limit(1);
        if (current?.consumedAt) return { kind: 'consumed' as const };
        if (current?.newEmailConfirmedAt && !current.oldEmailApprovedAt) {
          return { kind: 'pending_old' as const, user: targetUser, requestId: current.id };
        }
        return { kind: 'invalid' as const };
      }
      if (!candidate.oldEmailApprovedAt) {
        return { kind: 'pending_old' as const, user: targetUser, requestId: candidate.id };
      }
    }

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

    if (claimed.flowVersion === 2 && updated.organizationId !== null) {
      await markEmailProvenanceVerified({
        userId: updated.id,
        organizationId: updated.organizationId,
        oldEmail: claimed.oldEmail ?? targetUser.email,
        newEmail: claimed.newEmail,
        source: "email_change_dual_proof",
      }, tx);
    }

    // Revoke reset links only after this email-change token successfully
    // claims the credential lock and changes the authoritative address.
    await revokePendingAccountActionsForUser(
      claimed.userId,
      ['password_reset'],
      tx,
    );

    // `requestId` is carried out of the transaction so the post-confirm
    // payment-sync result can be written back to the *exact* admin
    // audit row that this confirmation belongs to (task #487). Doing
    // the audit UPDATE outside the transaction keeps the payment-
    // provider call (which can take seconds and throw retryable
    // errors) off the DB transaction critical path.
    return { kind: 'ok' as const, user: updated, requestId: claimed.id };
  });
}

export type ApproveOldEmailChangeOutcome =
  | { kind: 'ok'; user: User; requestId: number }
  | { kind: 'pending_new'; user: User; requestId: number }
  | { kind: 'invalid' | 'consumed' | 'expired' | 'user_gone' };

/** Record the old-mailbox proof and finish the change when the new mailbox
 * has also confirmed. This endpoint never creates a login session. */
export async function applyApproveOldEmailChangeTxn(
  tokenHash: string,
): Promise<ApproveOldEmailChangeOutcome> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(emailChangeRequests)
      .where(and(
        eq(emailChangeRequests.oldEmailTokenHash, tokenHash),
        isNull(emailChangeRequests.consumedAt),
        gt(emailChangeRequests.oldEmailTokenExpiresAt, sql`now()`),
      )).limit(1);
    if (!candidate) {
      const [existing] = await tx.select().from(emailChangeRequests)
        .where(eq(emailChangeRequests.oldEmailTokenHash, tokenHash)).limit(1);
      if (!existing) return { kind: 'invalid' as const };
      if (existing.consumedAt) return { kind: 'consumed' as const };
      return { kind: 'expired' as const };
    }
    await lockAccountCredential(tx, candidate.userId);
    const [targetUser] = await tx.select().from(users)
      .where(eq(users.id, candidate.userId)).limit(1).for('update');
    if (!targetUser) return { kind: 'user_gone' as const };
    const [activeHold] = await tx.select({ id: identitySecurityHolds.id })
      .from(identitySecurityHolds)
      .where(and(
        eq(identitySecurityHolds.userId, targetUser.id),
        eq(identitySecurityHolds.status, 'active'),
      )).limit(1);
    if (activeHold) throw new EmailChangeSecurityHoldError();
    if (!candidate.oldEmail || normalizeAccountEmail(targetUser.email) !== normalizeAccountEmail(candidate.oldEmail)) {
      return { kind: 'invalid' as const };
    }
    if (
      candidate.credentialGeneration === null
      || candidate.credentialGeneration !== targetUser.credentialGeneration
    ) {
      return { kind: 'invalid' as const };
    }
    const [approved] = await tx.update(emailChangeRequests).set({
      oldEmailApprovedAt: sql`now()`,
    }).where(and(
      eq(emailChangeRequests.id, candidate.id),
      isNull(emailChangeRequests.consumedAt),
      isNull(emailChangeRequests.oldEmailApprovedAt),
    )).returning();
    if (!approved) return { kind: 'consumed' as const };
    if (!candidate.newEmailConfirmedAt) {
      return { kind: 'pending_new' as const, user: targetUser, requestId: candidate.id };
    }
    const [updated] = await tx.update(users).set({ email: normalizeAccountEmail(candidate.newEmail) })
      .where(eq(users.id, targetUser.id)).returning();
    if (!updated) return { kind: 'user_gone' as const };
    if (updated.organizationId !== null) {
      await markEmailProvenanceVerified({
        userId: updated.id,
        organizationId: updated.organizationId,
        oldEmail: candidate.oldEmail,
        newEmail: candidate.newEmail,
        source: "email_change_dual_proof",
      }, tx);
    }
    await tx.update(emailChangeRequests).set({ consumedAt: sql`now()` })
      .where(eq(emailChangeRequests.id, candidate.id));
    await revokePendingAccountActionsForUser(candidate.userId, ['password_reset'], tx);
    return { kind: 'ok' as const, user: updated, requestId: candidate.id };
  });
}
