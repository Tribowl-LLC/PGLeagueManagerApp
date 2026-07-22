/**
 * Unit tests for the background payment-sync retry sweep (task #284).
 *
 * Mocks the storage layer and `syncBowlerForUser` so the sweep can be
 * exercised purely in memory.
 *
 * Cases:
 *   - sweep skips bowlers whose last attempt is still inside the
 *     exponential backoff window
 *   - sweep skips bowlers without a linked user (manual cleanup needed)
 *   - sweep retries an eligible bowler by calling syncBowlerForUser
 *     with the linked user's profile and reports success
 *   - sweep tolerates an unexpected throw without crashing the tick
 *   - paymentSyncBackoffMs grows exponentially and caps the exponent
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectErrorLog } from '../helpers/expected-error-logs';

const mockSelect = vi.fn();
const mockGetUserByBowlerId = vi.fn();
const mockUpdateClaim = vi.fn();

// The sweep now wraps candidate selection in `db.transaction(...)`
// and uses `.for('update', { skipLocked: true })` to claim rows so
// concurrent workers can't double-process the same bowler (task #321).
// The mock below has to satisfy both the count query and the locked
// SELECT, plus stay backwards-compatible with the original
// `mockSelect.mockResolvedValue(rows)` API the rest of the suite uses.
function buildSelectChain(isCount: boolean) {
  return {
    from: () => ({
      where: (..._args: unknown[]) => {
        if (isCount) {
          return Promise.resolve(mockSelect()).then((rows) => [
            { total: Array.isArray(rows) ? rows.length : 0 },
          ]);
        }
        const chain = {
          for: (..._a: unknown[]) => mockSelect(),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(mockSelect()).then(resolve, reject),
        };
        return chain;
      },
    }),
  };
}

const tx = {
  select: (projection?: Record<string, unknown>) =>
    buildSelectChain(projection !== undefined),
  // The sweep stamps payment_sync_last_attempt_at = NOW() inside the
  // tx as a lease so a peer worker's next tick won't re-pick the row.
  update: (_table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: unknown) => {
        mockUpdateClaim({ values, predicate });
        return Promise.resolve();
      },
    }),
  }),
};

vi.mock('../../server/db', () => ({
  db: {
    select: (projection?: Record<string, unknown>) =>
      buildSelectChain(projection !== undefined),
    transaction: async <T,>(fn: (txArg: typeof tx) => Promise<T>) => fn(tx),
  },
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getUserByBowlerId: (...args: unknown[]) => mockGetUserByBowlerId(...args),
  },
}));

const mockSyncBowlerForUser = vi.fn();
const mockSyncUnclaimedBowler = vi.fn();

vi.mock('../../server/services/payment-customer-sync', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/payment-customer-sync')>(
    '../../server/services/payment-customer-sync',
  );
  return {
    ...actual,
    syncBowlerForUser: (...args: unknown[]) => mockSyncBowlerForUser(...args),
    syncUnclaimedBowler: (...args: unknown[]) => mockSyncUnclaimedBowler(...args),
  };
});

import {
  paymentSyncBackoffMs,
  runPaymentSyncRetrySweep,
} from '../../server/services/payment-sync-retry';
import { PAYMENT_SYNC_MAX_ATTEMPTS } from '../../server/services/payment-customer-sync';

const NOW = new Date('2026-04-22T12:00:00.000Z');

function bowler(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    name: 'Pending Bowler',
    email: 'pending@example.com',
    phone: null,
    active: true,
    order: 0,
    paymentCustomerId: null,
    cloverCustomerId: null,
    paymentSyncPendingAt: '2026-04-22T11:00:00.000Z',
    paymentSyncAttempts: 0,
    paymentSyncLastAttemptAt: null as string | null,
    ...overrides,
  };
}

beforeEach(() => {
  mockSelect.mockReset();
  mockGetUserByBowlerId.mockReset();
  mockSyncBowlerForUser.mockReset();
  mockSyncUnclaimedBowler.mockReset();
  mockUpdateClaim.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('paymentSyncBackoffMs', () => {
  it('grows exponentially from one minute', () => {
    expect(paymentSyncBackoffMs(0)).toBe(60_000);
    expect(paymentSyncBackoffMs(1)).toBe(120_000);
    expect(paymentSyncBackoffMs(2)).toBe(240_000);
    expect(paymentSyncBackoffMs(4)).toBe(16 * 60_000);
  });

  it('clamps absurd attempt counts so we never overflow', () => {
    expect(paymentSyncBackoffMs(99)).toBe(60_000 * Math.pow(2, 16));
    expect(paymentSyncBackoffMs(-5)).toBe(60_000);
  });
});

describe('runPaymentSyncRetrySweep', () => {
  it('skips bowlers whose backoff window has not elapsed', async () => {
    mockSelect.mockResolvedValue([
      bowler({
        paymentSyncAttempts: 2,
        paymentSyncLastAttemptAt: new Date(NOW.getTime() - 60_000).toISOString(),
      }),
    ]);

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.scanned).toBe(1);
    expect(result.skippedBackoff).toBe(1);
    expect(result.retried).toBe(0);
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
  });

  it('retries an eligible bowler and reports success', async () => {
    mockSelect.mockResolvedValue([
      bowler({
        paymentSyncAttempts: 1,
        paymentSyncLastAttemptAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      }),
    ]);
    mockGetUserByBowlerId.mockResolvedValue({
      id: 9,
      name: 'Linked User',
      email: 'linked@example.com',
      phone: '5555550000',
      locationId: 7,
      organizationId: 3,
    });
    mockSyncBowlerForUser.mockResolvedValue('synced');

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.scanned).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.pendingAgain).toBe(0);
    expect(mockSyncBowlerForUser).toHaveBeenCalledTimes(1);
    const [user, changed] = mockSyncBowlerForUser.mock.calls[0];
    expect(user).toMatchObject({ id: 9, bowlerId: 100, email: 'linked@example.com' });
    expect(changed).toEqual({ nameChanged: true, emailChanged: true, phoneChanged: true });
  });

  it('counts pending_retry results separately so ops can see persistent failures', async () => {
    mockSelect.mockResolvedValue([bowler({ paymentSyncAttempts: 0 })]);
    mockGetUserByBowlerId.mockResolvedValue({
      id: 9,
      name: 'Linked User',
      email: 'linked@example.com',
      phone: null,
      locationId: 7,
      organizationId: 3,
    });
    mockSyncBowlerForUser.mockResolvedValue('pending_retry');

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.retried).toBe(1);
    expect(result.pendingAgain).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it('routes unclaimed bowlers through syncUnclaimedBowler and counts skipped (no email/no Square location) without bumping retried (task #705)', async () => {
    mockSelect.mockResolvedValue([
      bowler({ id: 100, email: null }),
      bowler({ id: 101 }),
    ]);
    mockGetUserByBowlerId.mockResolvedValue(undefined);
    // First bowler has no email so the unclaimed helper returns 'skipped';
    // second bowler is fine, unclaimed sync succeeds.
    mockSyncUnclaimedBowler.mockImplementation(async (id: number) =>
      id === 100 ? 'skipped' : 'synced',
    );

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.scanned).toBe(2);
    expect(mockSyncUnclaimedBowler).toHaveBeenCalledTimes(2);
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
    expect(result.skippedNoUser).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('syncs an unclaimed bowler with email + Square configured and reports success (task #705)', async () => {
    mockSelect.mockResolvedValue([bowler({ id: 100 })]);
    mockGetUserByBowlerId.mockResolvedValue(undefined);
    mockSyncUnclaimedBowler.mockResolvedValue('synced');

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(mockSyncUnclaimedBowler).toHaveBeenCalledWith(100);
    expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.skippedNoUser).toBe(0);
  });

  it('counts pending_retry from unclaimed bowler sync separately (task #705)', async () => {
    mockSelect.mockResolvedValue([bowler({ id: 100 })]);
    mockGetUserByBowlerId.mockResolvedValue(undefined);
    mockSyncUnclaimedBowler.mockResolvedValue('pending_retry');

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.retried).toBe(1);
    expect(result.pendingAgain).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.skippedNoUser).toBe(0);
  });

  it('still respects the max-attempts ceiling for unclaimed rows (task #705)', async () => {
    mockSelect.mockResolvedValue([
      bowler({ id: 100, paymentSyncAttempts: PAYMENT_SYNC_MAX_ATTEMPTS }),
    ]);
    mockGetUserByBowlerId.mockResolvedValue(undefined);

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.skippedMaxAttempts).toBe(1);
    expect(result.retried).toBe(0);
    expect(mockSyncUnclaimedBowler).not.toHaveBeenCalled();
  });

  it('treats an unexpected throw as an error and continues with the next bowler', async () => {
    // The sweep logs the unexpected throw at [ERROR] on purpose.
    expectErrorLog(/Payment-sync retry threw unexpectedly/);
    mockSelect.mockResolvedValue([
      bowler({ id: 100 }),
      bowler({ id: 101 }),
    ]);
    mockGetUserByBowlerId.mockResolvedValue({
      id: 9, name: 'L', email: 'l@x.io', phone: null, locationId: null, organizationId: 3,
    });
    mockSyncBowlerForUser
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('synced');

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.errors).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.retried).toBe(2);
  });

  it('claims locked rows by stamping payment_sync_last_attempt_at = NOW so a peer worker is fenced out', async () => {
    // Multi-process safety (task #321): even though FOR UPDATE
    // SKIP LOCKED prevents two workers from selecting the same row
    // in the SAME tick, locks are released at tx commit. The
    // implementation guards against the next-tick race by writing
    // a fresh last_attempt_at inside the same tx — the JS backoff
    // guard then excludes the row from a peer worker's tick until
    // the backoff window for the current attempt count elapses.
    mockSelect.mockResolvedValue([
      bowler({ id: 100, paymentSyncAttempts: 1 }),
      bowler({ id: 101, paymentSyncAttempts: 1 }),
    ]);
    mockGetUserByBowlerId.mockResolvedValue({
      id: 9, name: 'L', email: 'l@x.io', phone: null, locationId: null, organizationId: 3,
    });
    mockSyncBowlerForUser.mockResolvedValue('synced');

    await runPaymentSyncRetrySweep(NOW);

    expect(mockUpdateClaim).toHaveBeenCalledTimes(1);
    const { values } = mockUpdateClaim.mock.calls[0][0];
    // Drizzle's `sql` template renders to an SQL chunk object;
    // verify only that we asked to set last_attempt_at to something
    // (NOW() in production), not the exact internal shape.
    expect(values).toHaveProperty('paymentSyncLastAttemptAt');
    expect(values.paymentSyncLastAttemptAt).not.toBeNull();
    expect(values.paymentSyncLastAttemptAt).not.toBeUndefined();
  });

  it('does not write a claim update when no rows were locked', async () => {
    mockSelect.mockResolvedValue([]);
    const result = await runPaymentSyncRetrySweep(NOW);
    expect(result.scanned).toBe(0);
    expect(mockUpdateClaim).not.toHaveBeenCalled();
  });

  it('refuses to retry a bowler that already hit the attempts cap', async () => {
    // The SQL filter would normally exclude these, but the in-memory
    // guard keeps us safe if the row was raced past the cap between
    // the SELECT and the per-row dispatch.
    mockSelect.mockResolvedValue([
      bowler({ paymentSyncAttempts: PAYMENT_SYNC_MAX_ATTEMPTS }),
    ]);

    const result = await runPaymentSyncRetrySweep(NOW);

    expect(result.skippedMaxAttempts).toBe(1);
    expect(result.retried).toBe(0);
    expect(mockGetUserByBowlerId).not.toHaveBeenCalled();
  });
});
