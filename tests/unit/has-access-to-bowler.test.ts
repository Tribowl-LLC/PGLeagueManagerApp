/**
 * Unit tests for `hasAccessToBowler` (single-bowler helper) — task #408.
 *
 * Pins the owning-organization fast path added in task #342 and tightened
 * in task #407 once `bowlers.organizationId` became NOT NULL. The helper
 * batches a single `storage.getBowler` lookup and decides directly off
 * the stamped `organizationId`:
 *
 *   - sysadmin → allowed without a league lookup,
 *   - same-org caller → allowed without a league lookup,
 *   - admin cross-org caller → DENIED without a league lookup
 *     (no fallback for admins; this is the hardening),
 *   - non-admin "user" cross-org caller → falls through to the league
 *     scan so the bowler-to-bowler same-league rule still works,
 *   - missing bowler row → falls through to the league scan, which then
 *     denies because no league entries exist.
 *
 * The existing `bowler-org-not-null.test.ts` covers the schema/constraint
 * angle; this file covers the access-check decision tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const {
  mockGetBowler,
  mockGetBowlerLeagues,
  mockGetLeaguesByIds,
} = vi.hoisted(() => ({
  mockGetBowler: vi.fn(),
  mockGetBowlerLeagues: vi.fn(),
  mockGetLeaguesByIds: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: (...args: unknown[]) => mockGetBowler(...args),
    getBowlerLeagues: (...args: unknown[]) => mockGetBowlerLeagues(...args),
    getLeaguesByIds: (...args: unknown[]) => mockGetLeaguesByIds(...args),
  },
}));

import { hasAccessToBowler } from '../../server/utils/access-control';

type TestUser = {
  id: number;
  role: 'system_admin' | 'org_admin' | 'admin' | 'user';
  organizationId: number | null;
  bowlerId: number | null;
};

function makeReq(user: TestUser | null): Request {
  return { user: user ?? undefined } as unknown as Request;
}

const ORG_A = 100;
const ORG_B = 200;

beforeEach(() => {
  mockGetBowler.mockReset();
  mockGetBowlerLeagues.mockReset();
  mockGetLeaguesByIds.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('hasAccessToBowler — owning-org fast path (#342/#407 short-circuit)', () => {
  it('same-org caller: allowed via short-circuit, no league lookups invoked', async () => {
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowler.mockResolvedValueOnce({ id: 500, organizationId: ORG_A });

    const allowed = await hasAccessToBowler(req, 500);

    expect(allowed).toBe(true);
    // Critical: no fallback round-trips.
    expect(mockGetBowlerLeagues).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('cross-org admin caller: denied authoritatively, no league fallback', async () => {
    // The hardening from #407: an org_admin with a different stamp must
    // be DENIED without falling through to the league scan, even if a
    // shared-league overlap existed. Prime the league mocks with data
    // that WOULD allow access if the helper incorrectly fell through,
    // to make this a real test of the no-fallback contract.
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowler.mockResolvedValueOnce({ id: 501, organizationId: ORG_B });
    mockGetBowlerLeagues.mockResolvedValue([{ bowlerId: 501, leagueId: 5000, teamId: 1 }]);
    mockGetLeaguesByIds.mockResolvedValue([{ id: 5000, organizationId: ORG_A }]);

    const allowed = await hasAccessToBowler(req, 501);

    expect(allowed).toBe(false);
    // The decision came from the stamp gate, not the league scan.
    expect(mockGetBowlerLeagues).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('cross-org NON-admin "user" caller: short-circuit does NOT allow; falls through to league scan', async () => {
    // Bowler 70 (caller, role=user) shares league 7000 with bowler 71
    // who is stamped to a different org. Stamp gate should not allow
    // (different org, non-admin role doesn't get same-org allow either),
    // and the league scan should then allow via the shared league.
    const req = makeReq({ id: 1, role: 'user', organizationId: ORG_B, bowlerId: 70 });

    mockGetBowler.mockResolvedValueOnce({ id: 71, organizationId: ORG_A });
    mockGetBowlerLeagues
      // First call: target bowler's league entries.
      .mockResolvedValueOnce([{ bowlerId: 71, leagueId: 7000, teamId: 2 }])
      // Second call: caller's own league entries (for the shared-league check).
      .mockResolvedValueOnce([{ bowlerId: 70, leagueId: 7000, teamId: 1 }]);
    mockGetLeaguesByIds.mockResolvedValue([{ id: 7000, organizationId: ORG_A }]);

    const allowed = await hasAccessToBowler(req, 71);

    // Allowed via the league scan, not the stamp gate.
    expect(allowed).toBe(true);
    // Both league lookups must have fired — proves we fell through. We
    // also pin the *order* and *arguments*: the helper must look up the
    // target bowler's leagues first, then the caller's own, so a future
    // refactor can't quietly swap the order in a way that would still
    // happen to pass via mock symmetry.
    expect(mockGetBowlerLeagues).toHaveBeenCalledTimes(2);
    expect(mockGetBowlerLeagues).toHaveBeenNthCalledWith(1, { bowlerId: 71 });
    expect(mockGetBowlerLeagues).toHaveBeenNthCalledWith(2, { bowlerId: 70 });
    expect(mockGetLeaguesByIds).toHaveBeenCalledTimes(1);
    expect(mockGetLeaguesByIds).toHaveBeenCalledWith([7000]);
  });

  it('system admin + stamped bowler: allowed via short-circuit, no league lookups invoked', async () => {
    const req = makeReq({ id: 1, role: 'system_admin', organizationId: null, bowlerId: null });

    mockGetBowler.mockResolvedValueOnce({ id: 502, organizationId: ORG_B });

    const allowed = await hasAccessToBowler(req, 502);

    expect(allowed).toBe(true);
    expect(mockGetBowlerLeagues).not.toHaveBeenCalled();
    expect(mockGetLeaguesByIds).not.toHaveBeenCalled();
  });

  it('null stamp (defense-in-depth): falls through to league scan, no short-circuit allow even for sysadmin', async () => {
    // The schema enforces NOT NULL on `bowlers.organizationId` today,
    // so a null stamp is unreachable through normal CRUD. This test
    // pins the defensive guard against drift / orphaned rows: per the
    // file-level org-less resource policy, NO role (including
    // system_admin) may short-circuit-allow on a null stamp. The
    // request must instead fall through to the league scan, which
    // then enforces the same policy via continue+debug-log.
    const req = makeReq({ id: 1, role: 'system_admin', organizationId: null, bowlerId: null });

    // Cast through `unknown` because the schema type is `number`; we
    // are deliberately constructing an "impossible per schema" row to
    // exercise the defensive runtime guard.
    mockGetBowler.mockResolvedValueOnce({ id: 510, organizationId: null } as unknown as { id: number; organizationId: number });
    mockGetBowlerLeagues.mockResolvedValue([]); // no league entries → deny

    const allowed = await hasAccessToBowler(req, 510);

    expect(allowed).toBe(false);
    // Crucially: the league scan WAS consulted — proves the helper
    // fell through past the stamp gate instead of short-circuiting.
    expect(mockGetBowlerLeagues).toHaveBeenCalledTimes(1);
    expect(mockGetBowlerLeagues).toHaveBeenCalledWith({ bowlerId: 510 });
  });

  it('missing bowler row (no stamp present): falls through to league scan and denies', async () => {
    // After #407, `bowlers.organizationId` is NOT NULL, so "no stamp"
    // means the row is missing entirely (e.g. deleted concurrently).
    // The helper must NOT short-circuit-allow such rows.
    const req = makeReq({ id: 1, role: 'org_admin', organizationId: ORG_A, bowlerId: null });

    mockGetBowler.mockResolvedValueOnce(undefined); // no row returned
    mockGetBowlerLeagues.mockResolvedValue([]); // no league entries

    const allowed = await hasAccessToBowler(req, 503);

    expect(allowed).toBe(false);
    // Fell through past the stamp gate AND scanned the *correct* bowler
    // (not some unrelated id) — pinning the argument prevents a future
    // refactor from passing this test by accidentally querying the
    // wrong bowler and still getting an empty list.
    expect(mockGetBowlerLeagues).toHaveBeenCalledTimes(1);
    expect(mockGetBowlerLeagues).toHaveBeenCalledWith({ bowlerId: 503 });
  });

  it('self-access shortcut: caller=target wins before any storage lookup', async () => {
    // Pre-existing self-access carve-out: `req.user.bowlerId === bowlerId`
    // returns true before even fetching the bowler row. Pinned here so
    // a future refactor of the fast path can't accidentally reorder it
    // and lose the self-access guarantee for an org-less profile.
    const req = makeReq({ id: 1, role: 'user', organizationId: null, bowlerId: 600 });

    const allowed = await hasAccessToBowler(req, 600);

    expect(allowed).toBe(true);
    expect(mockGetBowler).not.toHaveBeenCalled();
    expect(mockGetBowlerLeagues).not.toHaveBeenCalled();
  });

  it('unauthenticated caller: denied without any storage lookup', async () => {
    const allowed = await hasAccessToBowler(makeReq(null), 700);

    expect(allowed).toBe(false);
    expect(mockGetBowler).not.toHaveBeenCalled();
    expect(mockGetBowlerLeagues).not.toHaveBeenCalled();
  });
});
