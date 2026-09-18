/**
 * Atomicity tests for the confirm-email-change transaction (task #494).
 *
 * Sibling of `admin-email-change-audit-atomicity.test.ts` (which pinned
 * the FIRST half of the email-change flow — the admin PATCH that
 * writes the `email_change_requests` + `admin_email_change_audits`
 * rows together). This file pins the SECOND half: the public
 * POST /api/account/confirm-email-change handler in
 * `server/routes/account.ts` runs its own `db.transaction(...)` that:
 *
 *   1. Conditionally claims the email-change request token (sets
 *      `email_change_requests.consumed_at`).
 *   2. Updates `users.email` to the new address.
 *
 * The contract is the same as #377: either both happen or neither —
 * otherwise a confirmed token could leave the user's login email
 * unchanged (token consumed, email NOT swapped) or vice versa (email
 * swapped, token NOT consumed → the link could be replayed). The
 * inline transaction in the route handler has been extracted into
 * `applyConfirmEmailChangeTxn(...)` so this test exercises the same
 * code path the route runs in production, not a handcrafted replica.
 *
 * Two directions are pinned:
 *
 *   Test A (users update fails → token claim rolled back):
 *     A SECOND user is pre-seeded owning the new-email address. The
 *     route's pre-request EMAIL_IN_USE check happens at request time;
 *     if a different user grabs that address between request and
 *     confirm, step 2 inside this transaction throws
 *     unique_violation (PG 23505). We must observe that
 *     `email_change_requests.consumed_at` is STILL NULL after the
 *     thrown rollback — i.e. the token claim from step 1 did NOT
 *     commit. A future refactor that split steps 1 and 2 into two
 *     separate transactions would leave `consumed_at` set with the
 *     user's email unchanged (a permanently dead token) and fail
 *     this assertion.
 *
 *   Test B (happy-path baseline):
 *     A regression baseline — when the swap succeeds, BOTH
 *     side-effects (consumed_at set AND users.email updated) are
 *     committed. Already covered by the broader
 *     `tests/api/email-change.test.ts` suite, but kept local here so
 *     the rollback assertion can't silently regress to "both halves
 *     fail" (a transaction that always rolls back would also satisfy
 *     Test A).
 *
 * Both tests run against the real test DB so the rollback semantics
 * are exercised end-to-end through pg / drizzle, not just in a
 * mocked transaction wrapper.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../setup/test-db';
const db = getTestDb();
import { emailChangeRequests, userVerificationProvenance, users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import { applyConfirmEmailChangeTxn, applyApproveOldEmailChangeTxn } from '../../server/services/account-lifecycle';
import { getPgErrorCode } from '../../server/utils/db-errors';
import { getBaselineOrgAId } from '../helpers';

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let createdOrgId = 0;
let targetUserId = 0;
let conflictUserId = 0;
let targetCredentialGeneration = 0;
const targetOriginalEmail = `confirm-target-${SUFFIX}@example.com`;
const conflictEmail = `confirm-conflict-${SUFFIX}@example.com`;

beforeAll(async () => {
  // Task #607: attach to the seeded baseline org instead of creating
  // a new one each run. Only this file's target + conflict user rows
  // and email-change-request rows are torn down in afterAll.
  createdOrgId = await getBaselineOrgAId();

  const passwordHash = await hashPassword('not-used-here');

  // The user whose email is being confirmed.
  const [target] = await db
    .insert(users)
    .values({
      name: `Confirm Target ${SUFFIX}`,
      email: targetOriginalEmail,
      password: passwordHash,
      role: 'user',
      organizationId: createdOrgId,
    })
    .returning();
  targetUserId = target.id;
  targetCredentialGeneration = target.credentialGeneration;

  // A SECOND user that already owns the address `target` is trying to
  // move to. Test A relies on this row to force a unique_violation on
  // `users.email` inside step 2 of the transaction.
  const [conflict] = await db
    .insert(users)
    .values({
      name: `Confirm Conflict ${SUFFIX}`,
      email: conflictEmail,
      password: passwordHash,
      role: 'user',
      organizationId: createdOrgId,
    })
    .returning();
  conflictUserId = conflict.id;
});

afterAll(async () => {
  if (targetUserId) {
    await db
      .delete(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, targetUserId));
    await db.delete(users).where(eq(users.id, targetUserId));
  }
  if (conflictUserId) {
    await db.delete(users).where(eq(users.id, conflictUserId));
  }
  // Baseline org is preserved across runs (Task #607).
});

describe('applyConfirmEmailChangeTxn atomicity (task #494)', () => {
  it('rolls back the token claim when the users.email update throws', async () => {
    // Pre-seed a pending request that targets `conflictEmail` — an
    // address already owned by `conflictUserId`. Step 1 of the
    // transaction (claim token) will succeed; step 2 (UPDATE
    // users.email) will then violate the UNIQUE constraint on
    // `users.email` and throw, rolling the whole transaction back.
    const tokenHash = `vitest-confirm-rollback-${SUFFIX}`;
    await db.insert(emailChangeRequests).values({
      userId: targetUserId,
      newEmail: conflictEmail,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      oldEmail: targetOriginalEmail,
      oldEmailApprovedAt: new Date().toISOString(),
      reauthenticatedAt: new Date().toISOString(),
      credentialGeneration: targetCredentialGeneration,
      flowVersion: 2,
    });

    let caught: unknown = undefined;
    try {
      await applyConfirmEmailChangeTxn(tokenHash);
    } catch (err) {
      caught = err;
    }

    // The unique_violation MUST escape the helper so the route layer
    // can map it to EMAIL_IN_USE. If a future refactor swallowed the
    // error inside the transaction, the route would silently 500.
    expect(caught).toBeDefined();
    // Drizzle wraps the pg error; the SQLSTATE lives on the cause chain.
    expect(getPgErrorCode(caught)).toBe('23505');

    // The contract we care about: the token claim from step 1 must
    // have been rolled back. A `consumed_at` set here would mean the
    // login email is now permanently out of sync with a now-dead
    // token — exactly the split-brain state the transaction exists
    // to prevent.
    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by tokenHash (per-test sentinel literal), unique-by-construction across the suite.
    const [requestRow] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, tokenHash));
    expect(requestRow).toBeDefined();
    expect(requestRow.consumedAt).toBeNull();

    // And conversely, the target user's email must NOT have been
    // changed. (Belt-and-suspenders: if the UPDATE somehow committed
    // partially, we'd see `conflictEmail` here.)
    const [targetRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));
    expect(targetRow.email).toBe(targetOriginalEmail);

    // Cleanup: drop the pending request so Test B starts clean.
    await db
      .delete(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, tokenHash));
  });

  it('commits both side-effects on a successful confirm (regression baseline)', async () => {
    // Baseline so the rollback assertion above can't silently regress
    // to "both halves always fail" (a transaction body that always
    // threw would also satisfy Test A).
    const tokenHash = `vitest-confirm-happy-${SUFFIX}`;
    const newEmail = `confirm-happy-${SUFFIX}@example.com`;
    await db.insert(emailChangeRequests).values({
      userId: targetUserId,
      newEmail,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      oldEmail: targetOriginalEmail,
      oldEmailApprovedAt: new Date().toISOString(),
      reauthenticatedAt: new Date().toISOString(),
      credentialGeneration: targetCredentialGeneration,
      flowVersion: 2,
    });

    const outcome = await applyConfirmEmailChangeTxn(tokenHash);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.user.email).toBe(newEmail);
    }

    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by tokenHash (per-test sentinel literal), unique-by-construction across the suite.
    const [requestRow] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, tokenHash));
    expect(requestRow.consumedAt).not.toBeNull();

    const [targetRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));
    expect(targetRow.email).toBe(newEmail);

    // Restore the original email so afterAll can clean up
    // deterministically and so test order doesn't matter.
    await db
      .update(users)
      .set({ email: targetOriginalEmail })
      .where(eq(users.id, targetUserId));
    await db
      .delete(userVerificationProvenance)
      .where(eq(userVerificationProvenance.userId, targetUserId));
  });

  it('serializes simultaneous old- and new-mailbox confirmations into one completed change', async () => {
    const [currentTarget] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!currentTarget) throw new Error('confirmation race target was not found');
    await db
      .delete(userVerificationProvenance)
      .where(eq(userVerificationProvenance.userId, targetUserId));

    const newEmail = `confirm-dual-${SUFFIX}@example.com`;
    const newTokenHash = `vitest-confirm-dual-new-${SUFFIX}`;
    const oldTokenHash = `vitest-confirm-dual-old-${SUFFIX}`;
    await db.insert(emailChangeRequests).values({
      userId: targetUserId,
      newEmail,
      tokenHash: newTokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      oldEmail: currentTarget.email,
      oldEmailTokenHash: oldTokenHash,
      oldEmailTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      reauthenticatedAt: new Date().toISOString(),
      credentialGeneration: currentTarget.credentialGeneration,
      flowVersion: 2,
    });

    const [newMailbox, oldMailbox] = await Promise.all([
      applyConfirmEmailChangeTxn(newTokenHash),
      applyApproveOldEmailChangeTxn(oldTokenHash),
    ]);

    expect([newMailbox.kind, oldMailbox.kind].filter(kind => kind === 'ok')).toHaveLength(1);
    expect(['pending_old', 'pending_new']).toContain(
      newMailbox.kind === 'ok' ? oldMailbox.kind : newMailbox.kind,
    );

    const [targetRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));
    expect(targetRow.email).toBe(newEmail);

    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by the unique per-test token hash.
    const [requestRow] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, newTokenHash));
    expect(requestRow.consumedAt).not.toBeNull();
  });
});
