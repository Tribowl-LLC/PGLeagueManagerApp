/**
 * Integration tests for payment-customer sync status surfacing (task #281).
 *
 * Verifies:
 *   - PATCH /api/account/profile/:id includes paymentSyncStatus in the response
 *   - Status is 'not_applicable' when the user has no linked bowler
 *   - POST /api/account/bowlers/:id/retry-payment-sync requires system_admin
 *   - Retry endpoint returns 404 for a missing bowler
 *   - Retry endpoint returns 422 when the bowler has no linked user
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../server/db';
import { users, bowlers, locations } from '@shared/schema';
import { adminProfileEditAudits } from '@shared/schema/admin-profile-edit-audits';
import { hashPassword } from '../../server/lib/password';
import {
  apiPatch,
  apiPost,
  login,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  getBaselineOrgAId,
} from '../helpers';

// Task #607: attach test users / bowlers / locations to the seeded
// `vitest-org-a` baseline instead of inserting a fresh org per test.
// The baseline has no payment-provider config, so the helper still
// hits the deterministic 'skipped' branch when no Square credentials
// are attached to the test's location.
const createdUserIds: number[] = [];
const createdBowlerIds: number[] = [];
const createdLocationIds: number[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Task #496 added admin_profile_edit_audits with FK references to
    // users.id (both targetUserId and actorUserId). Without ON DELETE
    // CASCADE we have to clear those rows ourselves before deleting
    // the users they point at, otherwise the FK violation aborts the
    // whole test file's afterAll mid-cleanup.
    await db
      .delete(adminProfileEditAudits)
      .where(
        or(
          inArray(adminProfileEditAudits.targetUserId, createdUserIds),
          inArray(adminProfileEditAudits.actorUserId, createdUserIds),
        ),
      );
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
  if (createdBowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, createdBowlerIds));
    createdBowlerIds.length = 0;
  }
  if (createdLocationIds.length > 0) {
    await db.delete(locations).where(inArray(locations.id, createdLocationIds));
    createdLocationIds.length = 0;
  }
});

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('PATCH /api/account/profile/:id payment sync status', () => {
  it('returns paymentSyncStatus: not_applicable for a user without a linked bowler', async () => {
    // Org admin in test data does not have a linked bowler row
    const session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    expect(session.user.id).toBeGreaterThan(0);

    const res = await apiPatch<{ paymentSyncStatus: string; name: string }>(
      `/api/account/profile/${session.user.id}`,
      { name: session.user.name }, // no-op change
      session,
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data?.paymentSyncStatus).toBe('not_applicable');
  });

  it("returns paymentSyncStatus: 'skipped' when a linked bowler exists but no payment provider is configured", async () => {
    // Build a fresh user+bowler pair with no Square config so the helper
    // hits the "no provider-configured location" skip branch and we can
    // see the response shape end-to-end.
    const admin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    expect(admin.user.organizationId === null).toBe(true);

    // Use the seeded baseline org (vitest-org-a). It has no
    // payment-provider config attached, so the sync helper takes the
    // deterministic 'skipped' branch — same as a freshly inserted
    // org would. Task #607.
    const org = { id: await getBaselineOrgAId() };

    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('sync-test-bowler'),
        email: `${uniq('sb')}@vitest.local`,
        phone: null,
        active: true,
        order: 0,
        organizationId: org.id,
        paymentCustomerId: null,
        cloverCustomerId: null,
        paymentSyncPendingAt: null,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const password = await hashPassword('vitest-sync-test-pw');
    const [user] = await db
      .insert(users)
      .values({
        email: `${uniq('su')}@vitest.local`,
        password,
        name: uniq('sync-test-user'),
        role: 'user',
        organizationId: org.id,
        locationId: null,
        bowlerId: bowler.id,
      })
      .returning();
    createdUserIds.push(user.id);

    // System admin can patch any user's profile
    const res = await apiPatch<{ paymentSyncStatus: string; name: string }>(
      `/api/account/profile/${user.id}`,
      { name: `${user.name}-changed` },
      admin,
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    // No Square config exists for this org → status should be 'skipped',
    // not 'pending_retry' (which would indicate a real provider failure)
    // and not 'not_applicable' (which would indicate the link was missed).
    expect(res.data.data?.paymentSyncStatus).toBe('skipped');
  });

  it("returns paymentSyncStatus: 'pending_retry' when the payment provider call fails with a real error", async () => {
    // Setup: fresh org + a location with a bogus Square access token so
    // getPaymentProvider resolves but the actual createOrUpdateCustomer
    // call fails with a non-ProviderNotConfiguredError. The helper should
    // log the failure, set payment_sync_pending_at, and respond
    // 'pending_retry'.
    const admin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    // Baseline org (vitest-org-a) — see Task #607 cleanup notes above.
    const org = { id: await getBaselineOrgAId() };

    const [location] = await db
      .insert(locations)
      .values({
        name: uniq('retry-test-location'),
        organizationId: org.id,
        // Bogus credentials — the Square SDK call will fail at the
        // network/auth layer, surfacing a real error (not ProviderNotConfigured).
        squareCredentials: {
          appId: 'sq0idp-bogus-test-app-id',
          accessToken: 'bogus-test-token-not-a-real-square-credential',
          locationId: 'L00000000000',
        },
      })
      .returning();
    createdLocationIds.push(location.id);

    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('retry-test-bowler'),
        email: `${uniq('rb')}@vitest.local`,
        phone: null,
        active: true,
        order: 0,
        organizationId: org.id,
        paymentCustomerId: null,
        cloverCustomerId: null,
        paymentSyncPendingAt: null,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const password = await hashPassword('vitest-retry-test-pw');
    const [user] = await db
      .insert(users)
      .values({
        email: `${uniq('ru')}@vitest.local`,
        password,
        name: uniq('retry-test-user'),
        role: 'user',
        organizationId: org.id,
        locationId: location.id,
        bowlerId: bowler.id,
      })
      .returning();
    createdUserIds.push(user.id);

    const res = await apiPatch<{ paymentSyncStatus: string; name: string }>(
      `/api/account/profile/${user.id}`,
      { name: `${user.name}-changed` },
      admin,
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data?.paymentSyncStatus).toBe('pending_retry');

    // The bowler row should now have a non-null payment_sync_pending_at
    // so the admin retry endpoint / future profile edits can pick it up.
    const [reread] = await db.select().from(bowlers).where(eq(bowlers.id, bowler.id));
    expect(reread.paymentSyncPendingAt).not.toBeNull();
  });
});

describe('POST /api/account/bowlers/:id/retry-payment-sync', () => {
  it('rejects unauthenticated callers (401 auth or 403 CSRF)', async () => {
    const res = await apiPost(`/api/account/bowlers/1/retry-payment-sync`, {});
    // CSRF runs before auth, so anonymous calls fail at the CSRF layer
    expect([401, 403]).toContain(res.status);
  });

  it('rejects org_admin callers with 403', async () => {
    const session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const res = await apiPost(
      `/api/account/bowlers/1/retry-payment-sync`,
      {},
      session,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when bowler does not exist', async () => {
    const admin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const res = await apiPost(
      `/api/account/bowlers/99999999/retry-payment-sync`,
      {},
      admin,
    );
    expect(res.status).toBe(404);
    expect(res.data.error?.code).toBe('NOT_FOUND');
  });

  it('returns 422 when the bowler has no linked user', async () => {
    const admin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    // Baseline org (vitest-org-a) — see Task #607 cleanup notes above.
    const org = { id: await getBaselineOrgAId() };

    // Create an isolated bowler with no linked user
    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('test-bowler'),
        email: `${uniq('b')}@vitest.local`,
        phone: null,
        active: true,
        order: 0,
        organizationId: org.id,
        paymentCustomerId: null,
        cloverCustomerId: null,
        paymentSyncPendingAt: null,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const res = await apiPost(
      `/api/account/bowlers/${bowler.id}/retry-payment-sync`,
      {},
      admin,
    );
    expect(res.status).toBe(422);
    expect(res.data.error?.code).toBe('NO_LINKED_USER');
  });
});
