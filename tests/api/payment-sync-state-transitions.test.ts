/**
 * State-transition tests for the payment-sync pending flag (task #286).
 *
 * Task #281's API tests cover response shape and authz but cannot exercise
 * the full failure→retry→success transition without talking to a real
 * payment provider. These tests close that gap by mocking
 * `getPaymentProvider` so we can deterministically:
 *
 *   1. Force a non-config provider error during a profile sync and assert
 *      the bowler row gets `payment_sync_pending_at` set and the helper
 *      returns `pending_retry`.
 *   2. Then make the provider succeed and assert the same code path the
 *      admin retry endpoint runs (`syncBowlerForUser` against the linked
 *      user) clears `payment_sync_pending_at` and returns `synced`.
 *
 * The tests run against the real test database but never hit Square: the
 * payment-provider factory is mocked at the module level. Storage,
 * routing, and the helper itself are exercised end-to-end.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const mockCreateOrUpdateCustomer = vi.fn();
const mockGetPaymentProvider = vi.fn();

vi.mock('../../server/services/payment-provider-factory', async () => {
  const actual = await vi.importActual<
    typeof import('../../server/services/payment-provider-factory')
  >('../../server/services/payment-provider-factory');
  return {
    ...actual,
    getPaymentProvider: (...args: unknown[]) => mockGetPaymentProvider(...args),
  };
});

import { db } from '../../server/db';
import { storage } from '../../server/storage';
import {
  users,
  bowlers,
  locations,
} from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  syncBowlerForUser,
  syncUnclaimedBowler,
} from '../../server/services/payment-customer-sync';
import { getBaselineOrgAId } from '../helpers';

// Task #607: attach test rows to the seeded `vitest-org-a` baseline.
// Each test still creates its own location with its own mocked Square
// credentials and looks the bowler/user up via that locationId, so
// sharing the org row across tests doesn't change the resolved
// provider config — the helper indexes by location, not by org.
const createdUserIds: number[] = [];
const createdBowlerIds: number[] = [];
const createdLocationIds: number[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdBowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, createdBowlerIds));
  }
  if (createdLocationIds.length > 0) {
    await db.delete(locations).where(inArray(locations.id, createdLocationIds));
  }
});

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  mockCreateOrUpdateCustomer.mockReset();
  mockGetPaymentProvider.mockReset();
  mockGetPaymentProvider.mockResolvedValue({
    createOrUpdateCustomer: (...args: unknown[]) =>
      mockCreateOrUpdateCustomer(...args),
  });
});

describe('payment_sync_pending_at lifecycle (mocked provider)', () => {
  it('flags the bowler on a generic provider failure and clears the flag on a successful retry', async () => {
    // --- Arrange: real org + location with placeholder Square config so the
    // sync helper resolves a provider locationId and reaches the mocked
    // createOrUpdateCustomer call. The credentials never leave the test
    // because the factory is mocked.
    const org = { id: await getBaselineOrgAId() };

    const [location] = await db
      .insert(locations)
      .values({
        name: uniq('lifecycle-location'),
        organizationId: org.id,
        squareCredentials: {
          appId: 'sq0idp-mocked-app-id',
          accessToken: 'mocked-access-token-for-lifecycle-test',
          locationId: 'L_MOCK_LIFECYCLE',
        },
      })
      .returning();
    createdLocationIds.push(location.id);

    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('lifecycle-bowler'),
        email: `${uniq('lb')}@vitest.local`,
        phone: null,
        active: true,
        order: 0,
        organizationId: org.id,
        paymentCustomerId: null,
        paymentSyncPendingAt: null,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const password = await hashPassword('vitest-lifecycle-pw');
    const [user] = await db
      .insert(users)
      .values({
        email: `${uniq('lu')}@vitest.local`,
        password,
        name: uniq('lifecycle-user'),
        role: 'user',
        organizationId: org.id,
        locationId: location.id,
        bowlerId: bowler.id,
      })
      .returning();
    createdUserIds.push(user.id);

    // --- Act 1: the profile-update path. Force a non-config provider error
    // (something Square would surface like a 5xx or auth failure).
    mockCreateOrUpdateCustomer.mockRejectedValueOnce(
      new Error('Square 503: gateway timeout (mocked)'),
    );

    const failureStatus = await syncBowlerForUser(
      {
        id: user.id,
        bowlerId: bowler.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        locationId: user.locationId,
        organizationId: user.organizationId,
      },
      { nameChanged: false, emailChanged: true, phoneChanged: false },
    );

    expect(failureStatus).toBe('pending_retry');
    expect(mockCreateOrUpdateCustomer).toHaveBeenCalledTimes(1);

    // --- Assert 1: the bowler row was flagged for retry.
    const [afterFailure] = await db
      .select()
      .from(bowlers)
      .where(eq(bowlers.id, bowler.id));
    expect(afterFailure.paymentSyncPendingAt).not.toBeNull();
    expect(afterFailure.paymentSyncAttempts).toBe(1);
    expect(afterFailure.paymentSyncLastAttemptAt).not.toBeNull();
    const flaggedAt = afterFailure.paymentSyncPendingAt;

    // --- Act 2: the admin retry endpoint. The route resolves the linked
    // user and runs `syncBowlerForUser` with all fields treated as
    // changed; do the same here so we exercise the identical code path.
    mockCreateOrUpdateCustomer.mockResolvedValueOnce({ id: 'cust_mock_ok' });

    const linkedUser = await storage.getUserByBowlerId(bowler.id);
    expect(linkedUser).toBeDefined();

    const retryStatus = await syncBowlerForUser(
      {
        id: linkedUser!.id,
        bowlerId: bowler.id,
        name: linkedUser!.name ?? afterFailure.name,
        email: linkedUser!.email ?? afterFailure.email,
        phone: linkedUser!.phone ?? afterFailure.phone,
        locationId: linkedUser!.locationId,
        organizationId: linkedUser!.organizationId,
      },
      { nameChanged: true, emailChanged: true, phoneChanged: true },
    );

    expect(retryStatus).toBe('synced');
    expect(mockCreateOrUpdateCustomer).toHaveBeenCalledTimes(2);

    // --- Assert 2: the flag was cleared, attempt counter reset, and the
    // provider customer id was persisted on the bowler row.
    const [afterRetry] = await db
      .select()
      .from(bowlers)
      .where(eq(bowlers.id, bowler.id));
    expect(afterRetry.paymentSyncPendingAt).toBeNull();
    expect(afterRetry.paymentSyncAttempts).toBe(0);
    expect(afterRetry.paymentSyncLastAttemptAt).toBeNull();
    expect(afterRetry.paymentCustomerId).toBe('cust_mock_ok');

    // Sanity: the original failure timestamp existed before being cleared.
    expect(flaggedAt).not.toBeNull();
  });

  // Task #705: the same lifecycle for an unclaimed bowler — no linked
  // user, source-of-truth is the bowler row itself.
  it('unclaimed bowler: flags on provider failure, then a sweep-style retry via syncUnclaimedBowler clears the flag and stamps paymentCustomerId', async () => {
    const org = { id: await getBaselineOrgAId() };

    const [location] = await db
      .insert(locations)
      .values({
        name: uniq('unclaimed-location'),
        organizationId: org.id,
        squareCredentials: {
          appId: 'sq0idp-mocked-app-id',
          accessToken: 'mocked-access-token-for-unclaimed-test',
          locationId: 'L_MOCK_UNCLAIMED',
        },
      })
      .returning();
    createdLocationIds.push(location.id);

    // No user is created — this bowler is genuinely unclaimed.
    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('unclaimed-bowler'),
        email: `${uniq('ub')}@vitest.local`,
        phone: null,
        active: true,
        order: 0,
        organizationId: org.id,
        paymentCustomerId: null,
        // Pre-flag the row as if the foreground PATCH had stamped it.
        paymentSyncPendingAt: new Date().toISOString(),
        paymentSyncAttempts: 1,
        paymentSyncLastAttemptAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    // --- Act 1: provider call fails → bowler stays flagged with bumped attempts.
    mockCreateOrUpdateCustomer.mockRejectedValueOnce(
      new Error('Square 502: bad gateway (mocked)'),
    );

    const failureStatus = await syncUnclaimedBowler(bowler.id);
    expect(failureStatus).toBe('pending_retry');

    const [afterFailure] = await db
      .select()
      .from(bowlers)
      .where(eq(bowlers.id, bowler.id));
    expect(afterFailure.paymentSyncPendingAt).not.toBeNull();
    expect(afterFailure.paymentSyncAttempts).toBe(2);
    expect(afterFailure.paymentCustomerId).toBeNull();

    // --- Act 2: provider call succeeds → flag cleared, attempts reset,
    // paymentCustomerId stamped from the bowler's own row data.
    mockCreateOrUpdateCustomer.mockResolvedValueOnce({ id: 'cust_unclaimed_ok' });
    const retryStatus = await syncUnclaimedBowler(bowler.id);
    expect(retryStatus).toBe('synced');

    const [afterRetry] = await db
      .select()
      .from(bowlers)
      .where(eq(bowlers.id, bowler.id));
    expect(afterRetry.paymentSyncPendingAt).toBeNull();
    expect(afterRetry.paymentSyncAttempts).toBe(0);
    expect(afterRetry.paymentSyncLastAttemptAt).toBeNull();
    expect(afterRetry.paymentCustomerId).toBe('cust_unclaimed_ok');
    // The org may already have a baseline Square-configured location,
    // and `getFirstSquareConfiguredLocation` returns whichever one ranks
    // first. Just assert SOMETHING was stamped — exact id depends on org
    // baseline ordering and is not what this test exercises.
    expect(afterRetry.paymentProviderLocationId).not.toBeNull();

    // The mocked provider was called with the bowler's own name/email/phone
    // (not a linked user's profile).
    const [, calledEmail] = mockCreateOrUpdateCustomer.mock.calls[1];
    expect(calledEmail).toBe(bowler.email);
  });

  it('unclaimed bowler with no email returns skipped without bumping attempts (task #705)', async () => {
    const org = { id: await getBaselineOrgAId() };
    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('unclaimed-noemail'),
        email: null,
        phone: null,
        active: true,
        order: 0,
        organizationId: org.id,
        paymentSyncPendingAt: new Date().toISOString(),
        paymentSyncAttempts: 1,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const status = await syncUnclaimedBowler(bowler.id);
    expect(status).toBe('skipped');
    expect(mockCreateOrUpdateCustomer).not.toHaveBeenCalled();

    const [after] = await db.select().from(bowlers).where(eq(bowlers.id, bowler.id));
    expect(after.paymentSyncPendingAt).not.toBeNull();
    expect(after.paymentSyncAttempts).toBe(1); // not bumped
  });
});
