/**
 * pay-for-partner authorization unit tests.
 *
 * Covers `canUserPayForBowler` — the gate every saved-card / wallet
 * partner-pay route runs through. Mocks `storage.getBowler` and the
 * accepted-partner storage helper so the matrix below stays a pure
 * unit (no DB).
 *
 * Matrix:
 *   - unauthenticated                       -> denied
 *   - target not found                      -> denied
 *   - org-less target                       -> denied (even system_admin)
 *   - system_admin without bowlerId         -> denied (no vault)
 *   - user without bowlerId                 -> denied
 *   - cross-org user vs target              -> denied
 *   - self pay                              -> allowed (payerBowlerId=self)
 *   - accepted partner pay                  -> allowed (payerBowlerId=self)
 *   - non-partner same-org bowler           -> denied (not_linked)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { Bowler } from '@shared/schema';

vi.mock('../../server/storage', () => ({
  storage: { getBowler: vi.fn() },
}));
vi.mock('../../server/storage/bowler-payment-links', () => ({
  getAcceptedPartnerBowlerIds: vi.fn(),
}));

import { canUserPayForBowler } from '../../server/utils/bowler-payment-authz';
import { storage } from '../../server/storage';
import * as links from '../../server/storage/bowler-payment-links';

const getBowlerMock = vi.mocked(storage.getBowler);
const getPartnersMock = vi.mocked(links.getAcceptedPartnerBowlerIds);

interface FakeUser {
  id: number;
  bowlerId: number | null;
  organizationId: number | null;
  role: string;
}
function makeReq(user: FakeUser | null): Request {
  // Express's Request['user'] is the project's full session-user shape;
  // canUserPayForBowler only ever reads { bowlerId, organizationId, role }.
  // Cast through Request['user'] (a single, narrow assertion that matches
  // what the helper actually consumes) instead of double-casting through
  // unknown — keeps the eslint no-restricted-syntax rule happy.
  const partial: Partial<Request> = { user: user as Request['user'] };
  return partial as Request;
}

// Build a full Bowler row for getBowler mocks. Defaults match a fresh,
// active bowler in an org; tests only override id + organizationId. We
// hand-write the full shape (instead of `as Bowler`) so a future column
// added to the bowlers schema fails this builder loudly rather than
// silently letting tests pass on a missing field.
function makeBowler(
  overrides: Partial<Omit<Bowler, 'organizationId'>> & {
    id: number;
    // Real Bowler.organizationId is NOT NULL, but the orgless-target
    // denial test specifically needs to feed the helper a null org to
    // exercise that branch. Allow null at the builder boundary and
    // bridge through `as Bowler` below.
    organizationId: number | null;
  },
): Bowler {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Test Bowler',
    email: overrides.email ?? null,
    phone: overrides.phone ?? null,
    active: overrides.active ?? true,
    order: overrides.order ?? 0,
    organizationId: overrides.organizationId as number,
    paymentCustomerId: overrides.paymentCustomerId ?? null,
    cloverCustomerId: overrides.cloverCustomerId ?? null,
    paymentProviderLocationId: overrides.paymentProviderLocationId ?? null,
    paymentSyncPendingAt: overrides.paymentSyncPendingAt ?? null,
    paymentSyncAttempts: overrides.paymentSyncAttempts ?? 0,
    paymentSyncLastAttemptAt: overrides.paymentSyncLastAttemptAt ?? null,
  } satisfies Bowler;
}

beforeEach(() => {
  getBowlerMock.mockReset();
  getPartnersMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('canUserPayForBowler', () => {
  it('denies unauthenticated requests', async () => {
    const res = await canUserPayForBowler(makeReq(null), 7);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unauthenticated');
    expect(getBowlerMock).not.toHaveBeenCalled();
  });

  it('denies when target bowler does not exist', async () => {
    getBowlerMock.mockResolvedValueOnce(undefined);
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: 10, organizationId: 1, role: 'user' }),
      99,
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('target_not_found');
  });

  it('denies org-less target even for system_admin', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 7, organizationId: null }));
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: 10, organizationId: null, role: 'system_admin' }),
      7,
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('orgless_target');
  });

  it('denies system_admin without a bowlerId (no vault)', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 7, organizationId: 1 }));
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: null, organizationId: null, role: 'system_admin' }),
      7,
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('system_admin_no_bowler');
  });

  it('denies a logged-in user with no linked bowler', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 7, organizationId: 1 }));
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: null, organizationId: 1, role: 'user' }),
      7,
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('no_payer_bowler');
  });

  it('denies cross-org pay attempts', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 7, organizationId: 2 }));
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: 10, organizationId: 1, role: 'user' }),
      7,
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('cross_org');
    // Cross-org must short-circuit before consulting partner storage.
    expect(getPartnersMock).not.toHaveBeenCalled();
  });

  it('allows self pay without consulting partner storage', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 10, organizationId: 1 }));
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: 10, organizationId: 1, role: 'user' }),
      10,
    );
    expect(res).toEqual({ allowed: true, payerBowlerId: 10 });
    expect(getPartnersMock).not.toHaveBeenCalled();
  });

  it('allows partner pay when an accepted link exists', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 7, organizationId: 1 }));
    getPartnersMock.mockResolvedValueOnce([7, 8]);
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: 10, organizationId: 1, role: 'user' }),
      7,
    );
    expect(res).toEqual({ allowed: true, payerBowlerId: 10 });
    expect(getPartnersMock).toHaveBeenCalledWith(10, 1);
  });

  it('denies when target is same-org but not an accepted partner', async () => {
    getBowlerMock.mockResolvedValueOnce(makeBowler({ id: 7, organizationId: 1 }));
    getPartnersMock.mockResolvedValueOnce([8, 9]);
    const res = await canUserPayForBowler(
      makeReq({ id: 1, bowlerId: 10, organizationId: 1, role: 'user' }),
      7,
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('not_linked');
  });

});
