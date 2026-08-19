/**
 * Tests for the permanent user-delete flow added in task #268.
 *
 * Covers `deleteUser` in server/storage/users.ts:
 *   - Refuses system_admin targets (CannotDeleteAdminError)
 *   - Refuses users with orphan_cleanup_audits rows (UserHasAuditTrailError)
 *   - Nullifies apple_pay_jobs.created_by and deletion_requests.reviewed_by
 *     for the deleted user, preserving the historical row
 *   - Deletes the row and is idempotent (second call throws)
 *
 * Hits the real test database; cleans up after itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { getTestDb } from '../setup/test-db';
const db = getTestDb();
import {
  users,
  applePayJobs,
  applePayJobItems,
  deletionRequests,
  orphanCleanupAudits,
  paymentOperations,
  bowlers,
  identityLinkEvents,
} from '@shared/schema';
import {
  deleteUser,
  CannotDeleteAdminError,
  UserHasAuditTrailError,
} from '../../server/storage/users';
import {
  createApplePayJob,
  insertApplePayJobItems,
  APPLE_PAY_TEST_FIXTURE_DOMAIN_SUFFIX,
} from '../../server/storage/apple-pay-jobs';
import { hashPassword } from '../../server/lib/password';
import { getBaselineOrgAId } from '../helpers';

/**
 * Sentinel sub-TLD used by THIS test file only (#606). Every
 * `createApplePayJob` call below is paired with an
 * `insertApplePayJobItems` row carrying this domain so a mid-test crash
 * leaves a row that the production sentinel filter
 * (`excludeAllSentinelJobsPredicate`) already hides from the admin
 * page. Distinct sub-TLD per test file (`%.users-delete.<suffix>`) so
 * the suite-level sweep below cannot race-delete in-flight rows from
 * `tests/unit/apple-pay-jobs.test.ts` running in another vitest worker.
 */
const USERS_DELETE_SENTINEL_SUFFIX = `.users-delete${APPLE_PAY_TEST_FIXTURE_DOMAIN_SUFFIX}`;
const USERS_DELETE_SENTINEL_PATTERN = `%${USERS_DELETE_SENTINEL_SUFFIX}`;

async function createApplePayJobWithSentinel(userId: number | null) {
  const job = await createApplePayJob(userId);
  await insertApplePayJobItems(job.id, [
    {
      organizationId: null,
      locationId: null,
      domain: `job-${job.id}${USERS_DELETE_SENTINEL_SUFFIX}`,
    },
  ]);
  return job;
}

/**
 * Suite-level sweep (#606). Cleans two leak shapes:
 *   1. Jobs with at least one item carrying our suite-specific sentinel
 *      sub-TLD (`%.users-delete.vitest-fixture.invalid`). Scoped by
 *      sub-TLD so we never touch `apple-pay-jobs.test.ts` rows.
 *   2. The historical leak shape this file is known to produce: jobs
 *      with ZERO items AND `created_by IS NULL`. Bounded by the same
 *      60-second age threshold the production listing filter uses, so
 *      this can never delete a fresh in-flight job from another worker.
 */
async function purgeUsersDeleteApplePayLeaks(): Promise<void> {
  await db.delete(applePayJobs).where(
    sql`EXISTS (
      SELECT 1 FROM ${applePayJobItems} i
      WHERE i.job_id = ${applePayJobs.id}
        AND i.domain LIKE ${USERS_DELETE_SENTINEL_PATTERN}
    )`,
  );
  await db.delete(applePayJobs).where(
    sql`${isNull(applePayJobs.createdBy)}
      AND NOT EXISTS (
        SELECT 1 FROM ${applePayJobItems} i
        WHERE i.job_id = ${applePayJobs.id}
      )
      AND ${applePayJobs.createdAt} < NOW() - INTERVAL '60 seconds'`,
  );
}

const createdUserIds: number[] = [];
const createdJobIds: number[] = [];
const createdDeletionRequestIds: number[] = [];
const createdAuditIds: number[] = [];
const createdOperationIds: string[] = [];
const createdBowlerIds: number[] = [];

beforeAll(purgeUsersDeleteApplePayLeaks);
afterAll(purgeUsersDeleteApplePayLeaks);

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(identityLinkEvents)
      .where(inArray(identityLinkEvents.subjectUserId, createdUserIds));
  }
  if (createdOperationIds.length > 0) {
    await db.delete(paymentOperations).where(inArray(paymentOperations.id, createdOperationIds));
    createdOperationIds.length = 0;
  }
  if (createdAuditIds.length > 0) {
    await db
      .delete(orphanCleanupAudits)
      .where(inArray(orphanCleanupAudits.id, createdAuditIds));
    createdAuditIds.length = 0;
  }
  if (createdDeletionRequestIds.length > 0) {
    await db
      .delete(deletionRequests)
      .where(inArray(deletionRequests.id, createdDeletionRequestIds));
    createdDeletionRequestIds.length = 0;
  }
  if (createdJobIds.length > 0) {
    await db.delete(applePayJobs).where(inArray(applePayJobs.id, createdJobIds));
    createdJobIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
  if (createdBowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, createdBowlerIds));
    createdBowlerIds.length = 0;
  }
  // Baseline org is preserved across runs (Task #607).
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@vitest.local`;
}

// Task #607: every test that needs an org just attaches its scratch
// users to the seeded vitest-org-a baseline. The deleteUser storage
// helper has no last-admin guard at this layer (that's enforced at
// the route layer in tests/api/users-delete.test.ts), so multiple
// tests sharing the same org never trip each other up.
async function makeOrg(): Promise<number> {
  return getBaselineOrgAId();
}

async function makeUser(opts: {
  role: 'system_admin' | 'org_admin' | 'user';
  organizationId: number | null;
}): Promise<number> {
  const password = await hashPassword('vitest-delete-pw');
  const [row] = await db
    .insert(users)
    .values({
      email: uniqueEmail(`delete-${opts.role}`),
      password,
      name: `Vitest ${opts.role}`,
      role: opts.role,
      organizationId: opts.organizationId,
    })
    .returning({ id: users.id });
  createdUserIds.push(row.id);
  return row.id;
}

describe('deleteUser — storage', () => {
  it('refuses to delete a system_admin', async () => {
    const sysId = await makeUser({ role: 'system_admin', organizationId: null });
    await expect(deleteUser(sysId)).rejects.toBeInstanceOf(CannotDeleteAdminError);

    const [stillThere] = await db.select().from(users).where(eq(users.id, sysId));
    expect(stillThere).toBeDefined();
    expect(stillThere.role).toBe('system_admin');
  });

  it('refuses to delete a user with orphan_cleanup_audits rows', async () => {
    // Audit rows are written by system_admins, but the FK is RESTRICT,
    // so the storage helper must defend against the conflict explicitly
    // for any role.
    const orgId = await makeOrg();
    const sysId = await makeUser({ role: 'system_admin', organizationId: null });

    const [audit] = await db
      .insert(orphanCleanupAudits)
      .values({
        adminUserId: sysId,
        resourceType: 'leagues',
        resourceId: 999_999,
        action: 'delete',
        organizationId: orgId,
      })
      .returning({ id: orphanCleanupAudits.id });
    createdAuditIds.push(audit.id);

    // Promote-bypass: the system_admin guard would fire first. To
    // exercise the audit-trail branch we have to drop the role to
    // org_admin (still attached to an org so the CHECK constraint is
    // satisfied) before calling deleteUser.
    await db
      .update(users)
      .set({ role: 'org_admin', organizationId: orgId })
      .where(eq(users.id, sysId));

    await expect(deleteUser(sysId)).rejects.toBeInstanceOf(UserHasAuditTrailError);

    const [stillThere] = await db.select().from(users).where(eq(users.id, sysId));
    expect(stillThere).toBeDefined();
  });

  it('refuses to delete a user retained as an immutable payment actor', async () => {
    const orgId = await makeOrg();
    const userId = await makeUser({ role: 'user', organizationId: orgId });
    const [operation] = await db.insert(paymentOperations).values({
      organizationId: orgId,
      authorizingUserId: userId,
      operationType: 'interactive_charge',
      targetKey: `interactive-charge:delete-actor-${userId}`,
      amountMinor: 1,
      currency: 'USD',
      requestFingerprint: `lvpayreq:v1:${'a'.repeat(64)}`,
      providerIdempotencyKey: `delete-actor-${userId}`,
      providerName: 'square',
    }).returning({ id: paymentOperations.id });
    createdOperationIds.push(operation.id);
    await expect(deleteUser(userId)).rejects.toBeInstanceOf(UserHasAuditTrailError);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it('nullifies apple_pay_jobs.created_by for the deleted user', async () => {
    const orgId = await makeOrg();
    const userId = await makeUser({ role: 'user', organizationId: orgId });

    // Sentinel-attached so that even if this worker crashes mid-test
    // before `afterEach` fires, the leaked job is hidden by the
    // production sentinel filter (#606).
    const job = await createApplePayJobWithSentinel(userId);
    createdJobIds.push(job.id);
    expect(job.createdBy).toBe(userId);

    const deleted = await deleteUser(userId);
    expect(deleted.id).toBe(userId);

    const [jobAfter] = await db
      .select()
      .from(applePayJobs)
      .where(eq(applePayJobs.id, job.id));
    expect(jobAfter).toBeDefined();
    expect(jobAfter.createdBy).toBeNull();
  });

  it('nullifies deletion_requests.reviewed_by for the deleted user', async () => {
    const orgId = await makeOrg();
    const reviewerId = await makeUser({ role: 'org_admin', organizationId: orgId });
    // We need at least one other org_admin so the reviewer isn't the
    // last admin in the org (not enforced at storage layer, but keeps
    // the test independent of route-level guards).
    await makeUser({ role: 'org_admin', organizationId: orgId });

    const reqEmail = uniqueEmail('deletion-req');
    const [req] = await db
      .insert(deletionRequests)
      .values({
        email: reqEmail,
        reason: 'vitest fixture',
        status: 'completed',
        reviewedBy: reviewerId,
        reviewedAt: new Date().toISOString(),
      })
      .returning({ id: deletionRequests.id });
    createdDeletionRequestIds.push(req.id);

    await deleteUser(reviewerId);

    const [reqAfter] = await db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.id, req.id));
    expect(reqAfter).toBeDefined();
    expect(reqAfter.reviewedBy).toBeNull();
    // Audit data preserved.
    expect(reqAfter.email).toBe(reqEmail);
  });

  it('removes the user row on success and a second delete throws', async () => {
    const orgId = await makeOrg();
    const userId = await makeUser({ role: 'user', organizationId: orgId });

    const deleted = await deleteUser(userId);
    expect(deleted.id).toBe(userId);

    const [after] = await db.select().from(users).where(eq(users.id, userId));
    expect(after).toBeUndefined();

    await expect(deleteUser(userId)).rejects.toThrow(/not found/i);
  });

  it('retains a stable audit subject and unlink snapshot after deleting a linked user', async () => {
    const orgId = await makeOrg();
    const userId = await makeUser({ role: 'user', organizationId: orgId });
    const [bowler] = await db.insert(bowlers).values({
      name: `Delete Linked Bowler ${userId}`,
      organizationId: orgId,
      active: true,
    }).returning();
    createdBowlerIds.push(bowler.id);
    await db.update(users).set({ bowlerId: bowler.id }).where(eq(users.id, userId));

    await deleteUser(userId);

    const [event] = await db.select().from(identityLinkEvents)
      .where(eq(identityLinkEvents.subjectUserId, userId));
    expect(event).toMatchObject({
      subjectUserId: userId,
      userId: null,
      eventType: 'access_cleanup',
      oldBowlerId: bowler.id,
      source: 'storage.delete-user',
      reason: 'account_deleted',
    });
    expect(event?.oldBowlerSnapshot).toMatchObject({
      id: bowler.id,
      name: bowler.name,
      organizationId: orgId,
      active: true,
    });
  });

  it('nullifies BOTH apple_pay_jobs.created_by and deletion_requests.reviewed_by atomically', async () => {
    const orgId = await makeOrg();
    const userId = await makeUser({ role: 'org_admin', organizationId: orgId });
    await makeUser({ role: 'org_admin', organizationId: orgId });

    const job = await createApplePayJobWithSentinel(userId);
    createdJobIds.push(job.id);

    const [req] = await db
      .insert(deletionRequests)
      .values({
        email: uniqueEmail('deletion-req-combo'),
        status: 'completed',
        reviewedBy: userId,
        reviewedAt: new Date().toISOString(),
      })
      .returning({ id: deletionRequests.id });
    createdDeletionRequestIds.push(req.id);

    await deleteUser(userId);

    const [jobAfter] = await db
      .select()
      .from(applePayJobs)
      .where(eq(applePayJobs.id, job.id));
    const [reqAfter] = await db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.id, req.id));

    expect(jobAfter.createdBy).toBeNull();
    expect(reqAfter.reviewedBy).toBeNull();
  });
});
