/**
 * Task #677: tests for the user→bowler phone sync helper.
 *
 * Covers:
 *  - `decideBowlerPhoneSync` pure decision: updated, skipped (no
 *    user phone), skipped (already matching), skipped (missing row),
 *    and idempotency (a second call after a successful write
 *    decides "skipped_already_matching").
 *  - `syncUserPhoneToBowler` integration with the storage facade
 *    via mocks: writes the bowler row when the decision says so,
 *    skips the write otherwise, and returns the right outcome.
 *  - Reverse path through `runBowlerPostCreateSync`: the matching
 *    user's phone is copied onto the bowler row BEFORE the Square
 *    customer create call runs, so the downstream sync sees the
 *    correct value.
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

const mockGetUser = vi.fn<(id: number) => Promise<unknown>>();
const mockGetBowler = vi.fn<(id: number) => Promise<unknown>>();
const mockUpdateBowler = vi.fn<(id: number, patch: unknown) => Promise<unknown>>();
const mockGetUserByEmail = vi.fn<(email: string) => Promise<unknown>>();
const mockLinkUserToBowler = vi.fn<(userId: number, bowlerId: number) => Promise<unknown>>();
const mockGetBowlerLeagues = vi.fn<(filter: unknown) => Promise<unknown[]>>(async () => []);
const mockGetLeague = vi.fn<(id: number) => Promise<unknown>>(async () => null);
const mockSetUserOrganization = vi.fn<(userId: number, orgId: number) => Promise<unknown>>();
const mockGetFirstSquareConfiguredLocation = vi.fn<(orgId: number) => Promise<unknown>>(async () => null);

vi.mock('../../server/storage', () => ({
  storage: {
    getUser: (id: number) => mockGetUser(id),
    getBowler: (id: number) => mockGetBowler(id),
    updateBowler: (id: number, patch: unknown) => mockUpdateBowler(id, patch),
    getUserByEmail: (email: string) => mockGetUserByEmail(email),
    linkUserToBowler: (userId: number, bowlerId: number) => mockLinkUserToBowler(userId, bowlerId),
    getBowlerLeagues: (filter: unknown) => mockGetBowlerLeagues(filter),
    getLeague: (id: number) => mockGetLeague(id),
    setUserOrganization: (userId: number, orgId: number) => mockSetUserOrganization(userId, orgId),
    getFirstSquareConfiguredLocation: (orgId: number) => mockGetFirstSquareConfiguredLocation(orgId),
  },
}));

vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: vi.fn(),
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
}));

vi.mock('../../server/services/bowler-attributes', () => ({
  syncBowlerLeagueAttributesToProvider: vi.fn(async () => ({ ok: true })),
}));

import {
  decideBowlerPhoneSync,
  syncUserPhoneToBowler,
} from '../../server/services/bowler-phone-sync';
import { runBowlerPostCreateSync } from '../../server/services/bowler-sync';
import { insertBowlerSchema } from '@shared/schema';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBowlerLeagues.mockResolvedValue([]);
  mockGetLeague.mockResolvedValue(null);
  mockGetFirstSquareConfiguredLocation.mockResolvedValue(null);
});

describe('decideBowlerPhoneSync', () => {
  it('writes when bowler.phone is null and user has a phone', () => {
    expect(
      decideBowlerPhoneSync({ phone: '5551234' }, { phone: null }),
    ).toEqual({ write: true, phone: '5551234' });
  });

  it('overwrites when bowler.phone differs (user wins)', () => {
    expect(
      decideBowlerPhoneSync({ phone: '5551234' }, { phone: '9998888' }),
    ).toEqual({ write: true, phone: '5551234' });
  });

  it('skips when user has no phone', () => {
    expect(decideBowlerPhoneSync({ phone: null }, { phone: '9998888' })).toEqual({
      write: false,
      reason: 'skipped_no_user_phone',
    });
    expect(decideBowlerPhoneSync({ phone: '   ' }, { phone: null })).toEqual({
      write: false,
      reason: 'skipped_no_user_phone',
    });
  });

  it('skips when bowler already matches', () => {
    expect(decideBowlerPhoneSync({ phone: '5551234' }, { phone: '5551234' })).toEqual({
      write: false,
      reason: 'skipped_already_matching',
    });
  });

  it('skips when either row is missing', () => {
    expect(decideBowlerPhoneSync(null, { phone: '5551234' })).toEqual({
      write: false,
      reason: 'skipped_missing_row',
    });
    expect(decideBowlerPhoneSync({ phone: '5551234' }, null)).toEqual({
      write: false,
      reason: 'skipped_missing_row',
    });
  });

  it('is idempotent on a second invocation against the post-write state', () => {
    const first = decideBowlerPhoneSync({ phone: '5551234' }, { phone: null });
    expect(first).toEqual({ write: true, phone: '5551234' });
    // Simulate the row after the write — the second call must skip.
    const second = decideBowlerPhoneSync({ phone: '5551234' }, { phone: '5551234' });
    expect(second).toEqual({ write: false, reason: 'skipped_already_matching' });
  });
});

describe('syncUserPhoneToBowler', () => {
  it('writes the bowler row when decision says to', async () => {
    mockGetUser.mockResolvedValue({ id: 1, phone: '5551234' });
    mockGetBowler.mockResolvedValue({ id: 7, phone: null });
    mockUpdateBowler.mockResolvedValue({ id: 7, phone: '5551234' });

    const result = await syncUserPhoneToBowler(1, 7);
    expect(result.outcome).toBe('updated');
    expect(mockUpdateBowler).toHaveBeenCalledWith(7, { phone: '5551234' });
  });

  it('skips the write when bowler already matches', async () => {
    mockGetUser.mockResolvedValue({ id: 1, phone: '5551234' });
    mockGetBowler.mockResolvedValue({ id: 7, phone: '5551234' });

    const result = await syncUserPhoneToBowler(1, 7);
    expect(result.outcome).toBe('skipped_already_matching');
    expect(mockUpdateBowler).not.toHaveBeenCalled();
  });

  it('skips the write when user has no phone', async () => {
    mockGetUser.mockResolvedValue({ id: 1, phone: null });
    mockGetBowler.mockResolvedValue({ id: 7, phone: '9998888' });

    const result = await syncUserPhoneToBowler(1, 7);
    expect(result.outcome).toBe('skipped_no_user_phone');
    expect(mockUpdateBowler).not.toHaveBeenCalled();
  });
});

type BowlerArg = Parameters<typeof runBowlerPostCreateSync>[0];

// Routed through `insertBowlerSchema.parse(...)` (task #693) so a future
// required column added to `shared/schema/bowlers.ts` fails LOUDLY here
// instead of letting the factory's shape rot silently.
function fakeBowler(overrides: Partial<BowlerArg>): BowlerArg {
  const parsed = insertBowlerSchema.parse({
    name: 'Jon Changes',
    email: 'jon@example.com',
    phone: null,
    active: true,
    order: 0,
    organizationId: 5,
    paymentCustomerId: null,
    paymentProviderLocationId: null,
    paymentSyncPendingAt: null,
    paymentSyncAttempts: 0,
    paymentSyncLastAttemptAt: null,
    ...overrides,
  });
  return Object.assign({ id: 42 }, parsed, overrides) as BowlerArg;
}

describe('runBowlerPostCreateSync — phone sync from linked user', () => {
  it('overwrites bowler.phone with the matching user phone before downstream sync', async () => {
    const bowler = fakeBowler({ phone: null });

    mockGetUserByEmail.mockResolvedValue({ id: 9, email: 'jon@example.com', phone: '5551234', bowlerId: null });
    mockLinkUserToBowler.mockResolvedValue(undefined);
    mockUpdateBowler.mockImplementation(async (_id, patch) => ({
      ...(bowler as object),
      ...(patch as Record<string, unknown>),
    }));
    // Square + BN both off — we're only asserting the phone write here.

    const result = await runBowlerPostCreateSync(bowler, 5);
    expect(mockUpdateBowler).toHaveBeenCalledWith(42, { phone: '5551234' });
    expect(result.phone).toBe('5551234');
  });

  it('does not write a phone change when matching user has no phone', async () => {
    // The bowler row already carries a phone, the matching user
    // doesn't, so the phone-sync helper must NOT write. (Task #682
    // adds a separate post-create flag-on-failure write — no
    // Square location is configured here so that path stamps
    // `paymentSyncPendingAt`. We assert the phone-sync helper
    // didn't fire by checking the patches; we don't assert
    // updateBowler was never called overall.)
    const bowler = fakeBowler({ phone: '9998888' });

    mockGetUserByEmail.mockResolvedValue({ id: 9, email: 'jon@example.com', phone: null, bowlerId: null });
    mockLinkUserToBowler.mockResolvedValue(undefined);
    mockUpdateBowler.mockImplementation(async (_id, patch) => ({
      ...(bowler as object),
      ...(patch as Record<string, unknown>),
    }));

    const result = await runBowlerPostCreateSync(bowler, 5);
    const phoneWrite = mockUpdateBowler.mock.calls.find(
      (c) => Object.keys(c[1] as object).length === 1
        && (c[1] as Record<string, unknown>).phone !== undefined,
    );
    expect(phoneWrite).toBeUndefined();
    expect(result.phone).toBe('9998888');
  });
});
