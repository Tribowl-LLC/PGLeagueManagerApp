import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  getLeague: vi.fn(),
  getLeagues: vi.fn(),
  getBowler: vi.fn(),
  getBowlerLeagues: vi.fn(),
  getBowlersByIds: vi.fn(),
  getTeam: vi.fn(),
  getPaymentById: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getLeague: (...args: unknown[]) => mocks.getLeague(...args),
    getLeagues: (...args: unknown[]) => mocks.getLeagues(...args),
    getBowler: (...args: unknown[]) => mocks.getBowler(...args),
    getBowlerLeagues: (...args: unknown[]) => mocks.getBowlerLeagues(...args),
    getBowlersByIds: (...args: unknown[]) => mocks.getBowlersByIds(...args),
    getTeam: (...args: unknown[]) => mocks.getTeam(...args),
    getPaymentById: (...args: unknown[]) => mocks.getPaymentById(...args),
  },
}));

import {
  getPaymentManagerAccessibleBowlerIds,
  hasAccessToLeague,
  hasPaymentManagerAccessToLeague,
  hasPaymentManagerAccessToPayment,
  isPaymentManager,
} from '../../server/utils/access-control';

const makeReq = (overrides: Partial<NonNullable<Request['user']>> = {}): Request => {
  const user: NonNullable<Request['user']> = {
    id: 1,
    email: 'payments@example.test',
    password: 'not-used',
    name: 'Payment Manager',
    phone: null,
    avatar: null,
    role: 'payment_manager',
    organizationId: 10,
    locationId: 100,
    bowlerId: null,
    inviteToken: null,
    inviteTokenExpiry: null,
    preferredLanguage: null,
    failedPasswordChangeAttempts: 0,
    passwordChangeLockedUntil: null,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  const partial: Partial<Request> = {
    user,
  };
  return partial as Request;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLeagues.mockResolvedValue([
    { id: 1, organizationId: 10, locationId: 100 },
    { id: 2, organizationId: 10, locationId: 200 },
    { id: 3, organizationId: 20, locationId: 100 },
    { id: 4, organizationId: 10, locationId: null },
  ]);
});

describe('payment-manager location authorization', () => {
  it('requires the payment_manager role and a non-null org/location scope', () => {
    expect(isPaymentManager(makeReq().user)).toBe(true);
    expect(isPaymentManager({ ...makeReq().user, role: 'org_admin' } as never)).toBe(false);
    expect(isPaymentManager({ ...makeReq().user, locationId: null } as never)).toBe(true);
  });

  it('allows only same-org, same-location leagues and denies null locations', async () => {
    const req = makeReq();
    mocks.getLeague.mockImplementation(async (id: number) => ({
      id,
      organizationId: id === 3 ? 20 : 10,
      locationId: id === 2 ? 200 : id === 4 ? null : 100,
    }));

    await expect(hasPaymentManagerAccessToLeague(req, 1)).resolves.toBe(true);
    await expect(hasPaymentManagerAccessToLeague(req, 2)).resolves.toBe(false);
    await expect(hasPaymentManagerAccessToLeague(req, 3)).resolves.toBe(false);
    await expect(hasPaymentManagerAccessToLeague(req, 4)).resolves.toBe(false);
    await expect(hasAccessToLeague(req, 2)).resolves.toBe(false);
  });

  it('scopes roster IDs to the assigned location and excludes cross-org rows', async () => {
    mocks.getBowlerLeagues.mockImplementation(async ({ leagueId }: { leagueId: number }) =>
      leagueId === 1
        ? [{ bowlerId: 11, leagueId: 1, teamId: 1, active: true }, { bowlerId: 12, leagueId: 1, teamId: 2, active: false }]
        : [],
    );
    mocks.getBowlersByIds.mockResolvedValue([
      { id: 11, organizationId: 10 },
      { id: 12, organizationId: 20 },
    ]);

    await expect(getPaymentManagerAccessibleBowlerIds(makeReq())).resolves.toEqual([11]);
    expect(mocks.getLeagues).toHaveBeenCalledWith(10);
    expect(mocks.getBowlersByIds).toHaveBeenCalledWith([11]);
  });

  it('denies payment access through a foreign or org-less league', async () => {
    mocks.getPaymentById.mockResolvedValue({ id: 8, leagueId: 2 });
    mocks.getLeague.mockResolvedValue({ id: 2, organizationId: 10, locationId: 200 });
    await expect(hasPaymentManagerAccessToPayment(makeReq(), 8)).resolves.toBe(false);

    mocks.getLeague.mockResolvedValue({ id: 9, organizationId: null, locationId: 100 });
    mocks.getPaymentById.mockResolvedValue({ id: 9, leagueId: 9 });
    await expect(hasPaymentManagerAccessToPayment(makeReq(), 9)).resolves.toBe(false);
  });
});
