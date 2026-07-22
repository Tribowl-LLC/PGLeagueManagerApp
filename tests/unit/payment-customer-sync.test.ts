/**
 * Unit tests for syncBowlerForUser (task #281).
 *
 * Mocks the storage layer and the payment provider factory so we can
 * assert state transitions without hitting the database or a real
 * payment provider.
 *
 * Cases:
 *   - provider not configured → 'skipped' (no flag flip)
 *   - generic provider failure → 'pending_retry' AND bowler row gets
 *     `paymentSyncPendingAt` set
 *   - successful sync → 'synced' AND a previously-set `paymentSyncPendingAt`
 *     is cleared
 *   - user has no linked bowler → 'not_applicable'
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectErrorLog } from '../helpers/expected-error-logs';

const mockGetBowler = vi.fn();
const mockUpdateBowler = vi.fn();
const mockGetLocationSquareConfig = vi.fn();
const mockGetFirstSquareConfiguredLocation = vi.fn();

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: (...args: unknown[]) => mockGetBowler(...args),
    updateBowler: (...args: unknown[]) => mockUpdateBowler(...args),
    getLocationSquareConfig: (...args: unknown[]) => mockGetLocationSquareConfig(...args),
    getFirstSquareConfiguredLocation: (...args: unknown[]) => mockGetFirstSquareConfiguredLocation(...args),
  },
}));

const mockGetPaymentProvider = vi.fn();
const mockSyncBowlerLeagueAttributesToProvider = vi.fn();

vi.mock('../../server/services/bowler-attributes', () => ({
  syncBowlerLeagueAttributesToProvider: (...args: unknown[]) =>
    mockSyncBowlerLeagueAttributesToProvider(...args),
}));

vi.mock('../../server/services/payment-provider-factory', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/payment-provider-factory')>(
    '../../server/services/payment-provider-factory',
  );
  return {
    ...actual,
    getPaymentProvider: (...args: unknown[]) => mockGetPaymentProvider(...args),
  };
});

import { syncBowlerForUser, type SyncableUser } from '../../server/services/payment-customer-sync';
import { ProviderNotConfiguredError } from '../../server/services/payment-provider-factory';

const baseUser: SyncableUser = {
  id: 1,
  bowlerId: 42,
  name: 'Jane Bowler',
  email: 'jane@example.com',
  phone: '5555550100',
  locationId: 7,
  organizationId: 3,
};

const baseBowler = {
  id: 42,
  name: 'Jane Bowler',
  email: 'jane@example.com',
  phone: '5555550100',
  active: true,
  order: 0,
  paymentCustomerId: null as string | null,
  paymentSyncPendingAt: null as string | null,
};

const allChanged = { nameChanged: true, emailChanged: true, phoneChanged: true };

beforeEach(() => {
  mockGetBowler.mockReset();
  mockUpdateBowler.mockReset();
  mockGetLocationSquareConfig.mockReset();
  mockGetFirstSquareConfiguredLocation.mockReset();
  mockGetPaymentProvider.mockReset();
  mockSyncBowlerLeagueAttributesToProvider.mockReset();
  // Default attribute sync to ok so existing tests are unaffected.
  mockSyncBowlerLeagueAttributesToProvider.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('syncBowlerForUser', () => {
  it('returns not_applicable when the user has no linked bowler', async () => {
    const status = await syncBowlerForUser({ ...baseUser, bowlerId: null }, allChanged);
    expect(status).toBe('not_applicable');
    expect(mockGetBowler).not.toHaveBeenCalled();
  });

  it('returns skipped when the provider is not configured for the location', async () => {
    mockGetBowler.mockResolvedValue(baseBowler);
    mockGetLocationSquareConfig.mockResolvedValue({ accessToken: 'live-token' });
    mockGetPaymentProvider.mockRejectedValue(
      new ProviderNotConfiguredError('no creds', 7),
    );

    const status = await syncBowlerForUser(baseUser, allChanged);

    expect(status).toBe('skipped');
    // No retry flag should be set on a config-skip — value stays null/undefined,
    // never a real timestamp string.
    const updateCalls = mockUpdateBowler.mock.calls;
    for (const call of updateCalls) {
      const flag = call[1].paymentSyncPendingAt;
      expect(flag === null || flag === undefined).toBe(true);
    }
  });

  it('flips paymentSyncPendingAt and returns pending_retry on a generic provider failure', async () => {
    mockGetBowler.mockResolvedValue(baseBowler);
    mockGetLocationSquareConfig.mockResolvedValue({ accessToken: 'live-token' });
    mockUpdateBowler.mockResolvedValue(baseBowler);
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn().mockRejectedValue(new Error('Square 503: gateway timeout')),
    });

    const status = await syncBowlerForUser(baseUser, allChanged);

    expect(status).toBe('pending_retry');
    // Final updateBowler call should set the retry flag
    const lastCall = mockUpdateBowler.mock.calls.at(-1);
    if (!lastCall) throw new Error('expected updateBowler to have been called');
    expect(lastCall[0]).toBe(42);
    expect(lastCall[1].paymentSyncPendingAt).toEqual(expect.any(String));
  });

  it('clears paymentSyncPendingAt and returns synced on a successful sync', async () => {
    const previouslyFailedBowler = {
      ...baseBowler,
      paymentSyncPendingAt: '2026-04-20T12:00:00.000Z',
    };
    mockGetBowler.mockResolvedValue(previouslyFailedBowler);
    mockGetLocationSquareConfig.mockResolvedValue({ accessToken: 'live-token' });
    mockUpdateBowler.mockResolvedValue(previouslyFailedBowler);
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn().mockResolvedValue({ id: 'cust_123' }),
    });

    const status = await syncBowlerForUser(baseUser, allChanged);

    expect(status).toBe('synced');
    // Final updateBowler call should null out the retry flag
    const lastCall = mockUpdateBowler.mock.calls.at(-1);
    if (!lastCall) throw new Error('expected updateBowler to have been called');
    expect(lastCall[1].paymentSyncPendingAt).toBeNull();
    expect(lastCall[1].paymentCustomerId).toBe('cust_123');
  });

  it('bumps paymentSyncAttempts and stamps last-attempt when the attribute-write step fails (task #680)', async () => {
    // Regression for the "stuck at attempts=0" loop. Previously, when
    // `createOrUpdateCustomer` succeeded but the follow-up custom-
    // attribute upserts failed, the helper only re-flagged
    // `paymentSyncPendingAt` and never bumped `paymentSyncAttempts`,
    // so the retry sweep looped forever and the row never crossed the
    // PAYMENT_SYNC_MAX_ATTEMPTS cap. The fix mirrors the customer-
    // creation failure branch: attempts++ and last-attempt timestamp.
    const previouslyFailedBowler = {
      ...baseBowler,
      paymentSyncAttempts: 2,
      paymentSyncPendingAt: '2026-04-20T12:00:00.000Z',
    };
    mockGetBowler.mockResolvedValue(previouslyFailedBowler);
    mockGetLocationSquareConfig.mockResolvedValue({ accessToken: 'live-token' });
    mockUpdateBowler.mockResolvedValue(previouslyFailedBowler);
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn().mockResolvedValue({ id: 'cust_777' }),
    });
    // Square customer write succeeds but the league_name / league_season
    // upsert fails — the exact production scenario from task #680.
    mockSyncBowlerLeagueAttributesToProvider.mockResolvedValue({ ok: false });

    const status = await syncBowlerForUser(baseUser, allChanged);

    expect(status).toBe('pending_retry');
    const lastCall = mockUpdateBowler.mock.calls.at(-1);
    if (!lastCall) throw new Error('expected updateBowler to have been called');
    expect(lastCall[0]).toBe(42);
    expect(lastCall[1].paymentSyncAttempts).toBe(3);
    expect(lastCall[1].paymentSyncLastAttemptAt).toEqual(expect.any(String));
    // Original pending-since timestamp is preserved for the admin
    // surface; we don't restamp it on every failed retry.
    expect(lastCall[1].paymentSyncPendingAt).toBe('2026-04-20T12:00:00.000Z');
  });

  it('logs the structured "given up" error when attribute writes cross PAYMENT_SYNC_MAX_ATTEMPTS (task #680)', async () => {
    // This test exercises the give-up branch, which logs at [ERROR] by
    // design; declare it so the guard treats it as expected, not noise.
    expectErrorLog(/Payment-customer sync gave up after max retry attempts/);
    const aboutToCapBowler = {
      ...baseBowler,
      // 4 → next attempt becomes 5 = PAYMENT_SYNC_MAX_ATTEMPTS.
      paymentSyncAttempts: 4,
      paymentSyncPendingAt: '2026-04-20T12:00:00.000Z',
    };
    mockGetBowler.mockResolvedValue(aboutToCapBowler);
    mockGetLocationSquareConfig.mockResolvedValue({ accessToken: 'live-token' });
    mockUpdateBowler.mockResolvedValue(aboutToCapBowler);
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn().mockResolvedValue({ id: 'cust_888' }),
    });
    mockSyncBowlerLeagueAttributesToProvider.mockResolvedValue({ ok: false });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await syncBowlerForUser(baseUser, allChanged);
    } finally {
      errorSpy.mockRestore();
    }

    const lastCall = mockUpdateBowler.mock.calls.at(-1);
    if (!lastCall) throw new Error('expected updateBowler to have been called');
    expect(lastCall[1].paymentSyncAttempts).toBe(5);
  });

  it('returns skipped when the user has no email even if a bowler is linked', async () => {
    mockGetBowler.mockResolvedValue(baseBowler);
    mockUpdateBowler.mockResolvedValue(baseBowler);

    const status = await syncBowlerForUser(
      { ...baseUser, email: null },
      allChanged,
    );

    expect(status).toBe('skipped');
    expect(mockGetPaymentProvider).not.toHaveBeenCalled();
  });
});
