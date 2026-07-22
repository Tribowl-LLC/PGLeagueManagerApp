/**
 * Task #682: tests for `runBowlerPostCreateSync`'s flag-on-failure
 * behaviour. Every code path that fails to link a Square customer
 * must now stamp `paymentSyncPendingAt` so the background retry
 * sweep picks the bowler up; the only exception is bowlers with
 * no email (genuinely "nothing to sync").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetUserByEmail = vi.fn<(email: string) => Promise<unknown>>(async () => null);
const mockLinkUserToBowler = vi.fn<(u: number, b: number) => Promise<unknown>>(async () => undefined);
const mockUpdateBowler = vi.fn<(id: number, patch: unknown) => Promise<unknown>>();
const mockGetFirstSquareConfiguredLocation = vi.fn<(orgId: number) => Promise<unknown>>(async () => null);
const mockGetBowlerLeagues = vi.fn<() => Promise<unknown[]>>(async () => []);
const mockGetLeague = vi.fn<() => Promise<unknown>>(async () => null);

vi.mock('../../server/storage', () => ({
  storage: {
    getUserByEmail: (e: string) => mockGetUserByEmail(e),
    linkUserToBowler: (u: number, b: number) => mockLinkUserToBowler(u, b),
    updateBowler: (id: number, patch: unknown) => mockUpdateBowler(id, patch),
    getFirstSquareConfiguredLocation: (o: number) => mockGetFirstSquareConfiguredLocation(o),
    getBowlerLeagues: () => mockGetBowlerLeagues(),
    getLeague: () => mockGetLeague(),
  },
}));

const mockGetPaymentProvider = vi.fn();

vi.mock('../../server/services/payment-provider-factory', () => {
  class ProviderNotConfiguredError extends Error {}
  return {
    getPaymentProvider: (...args: unknown[]) => mockGetPaymentProvider(...args),
    ProviderNotConfiguredError,
  };
});

async function getProviderNotConfiguredError() {
  const mod = await import('../../server/services/payment-provider-factory');
  return mod.ProviderNotConfiguredError;
}

vi.mock('../../server/services/bowler-attributes', () => ({
  syncBowlerLeagueAttributesToProvider: vi.fn(async () => ({ ok: true })),
}));

import { runBowlerPostCreateSync } from '../../server/services/bowler-sync';
import { insertBowlerSchema } from '@shared/schema';

type BowlerArg = Parameters<typeof runBowlerPostCreateSync>[0];

// Routed through `insertBowlerSchema.parse(...)` (task #693). The whole
// reason this test exists — task #682 — is the same kind of silent
// didn't include it, and TypeScript shrugged because the column was
// `.notNull().default(false)`. Running the defaults+overrides through
// the Zod schema makes a future required column blow up here loudly
// instead of letting the gap calcify across sprints.
function fakeBowler(overrides: Partial<BowlerArg> = {}): BowlerArg {
  const parsed = insertBowlerSchema.parse({
    name: 'Test Bowler',
    email: 'test@example.com',
    phone: null,
    active: true,
    order: 0,
    organizationId: 5,
    paymentCustomerId: null,
    cloverCustomerId: null,
    paymentProviderLocationId: null,
    paymentSyncPendingAt: null,
    paymentSyncAttempts: 0,
    paymentSyncLastAttemptAt: null,
    ...overrides,
  });
  // `id` is omitted from the insert schema; re-add it for the SELECT
  // type, then layer overrides on top so caller-supplied `id` (rare but
  // legal) wins.
  return Object.assign({ id: 42 }, parsed, overrides) as BowlerArg;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(null);
  mockGetFirstSquareConfiguredLocation.mockResolvedValue(null);
  // Default: updateBowler echoes the merged state back so chained
  // calls see the latest row.
  mockUpdateBowler.mockImplementation(async (_id, patch) => ({
    ...(patch as Record<string, unknown>),
  }));
});

function findFlagPatch(): Record<string, unknown> | null {
  // Walk every updateBowler invocation and return the patch that
  // set `paymentSyncPendingAt` to a stamped value (string), if any.
  for (const call of mockUpdateBowler.mock.calls) {
    const patch = call[1] as Record<string, unknown>;
    if (typeof patch.paymentSyncPendingAt === 'string') {
      return patch;
    }
  }
  return null;
}

describe('runBowlerPostCreateSync — flag-on-failure (task #682)', () => {
  it('flags the bowler when the org has no Square location configured', async () => {
    mockGetFirstSquareConfiguredLocation.mockResolvedValue(null);

    await runBowlerPostCreateSync(fakeBowler(), 5);

    const patch = findFlagPatch();
    expect(patch).not.toBeNull();
    // The flag-write path must not also stamp a customer id —
    // there is no provider call to derive one from.
    expect(patch?.paymentCustomerId).toBeFalsy();
  });

  it('flags the bowler when the provider throws ProviderNotConfiguredError', async () => {
    const PNCE = await getProviderNotConfiguredError();
    mockGetFirstSquareConfiguredLocation.mockResolvedValue({ id: 99 });
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn(async () => {
        throw new PNCE('not configured', 99);
      }),
    });

    await runBowlerPostCreateSync(fakeBowler(), 5);

    expect(findFlagPatch()).not.toBeNull();
  });

  it('flags the bowler when the provider throws a generic error', async () => {
    mockGetFirstSquareConfiguredLocation.mockResolvedValue({ id: 99 });
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn(async () => {
        throw new Error('square 500');
      }),
    });

    await runBowlerPostCreateSync(fakeBowler(), 5);

    expect(findFlagPatch()).not.toBeNull();
  });

  it('flags the bowler when the provider returns no customer', async () => {
    mockGetFirstSquareConfiguredLocation.mockResolvedValue({ id: 99 });
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn(async () => null),
    });

    await runBowlerPostCreateSync(fakeBowler(), 5);

    expect(findFlagPatch()).not.toBeNull();
  });

  it('does NOT flag a bowler with no email (nothing to sync)', async () => {
    await runBowlerPostCreateSync(fakeBowler({ email: null }), 5);

    expect(findFlagPatch()).toBeNull();
  });

  it('does NOT flag on the happy path (customer linked successfully)', async () => {
    mockGetFirstSquareConfiguredLocation.mockResolvedValue({ id: 99 });
    mockGetPaymentProvider.mockResolvedValue({
      createOrUpdateCustomer: vi.fn(async () => ({ id: 'cus_abc' })),
    });

    await runBowlerPostCreateSync(fakeBowler(), 5);

    expect(findFlagPatch()).toBeNull();
    // The customer-id write must still have happened.
    const linkedPatch = mockUpdateBowler.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((p) => p.paymentCustomerId === 'cus_abc');
    expect(linkedPatch).toBeDefined();
  });

  it('does NOT re-stamp a bowler that already has paymentSyncPendingAt', async () => {
    mockGetFirstSquareConfiguredLocation.mockResolvedValue(null);

    const existing = '2024-01-01T00:00:00.000Z';
    await runBowlerPostCreateSync(
      fakeBowler({ paymentSyncPendingAt: existing }),
      5,
    );

    expect(findFlagPatch()).toBeNull();
  });
});
